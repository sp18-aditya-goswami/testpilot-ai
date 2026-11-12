import json
import threading
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import hypothesis
import schemathesis
from hypothesis import HealthCheck, Phase, Verbosity, given
from schemathesis.checks import not_a_server_error
from schemathesis.core.failures import Failure, FailureGroup
from schemathesis.core.result import Err
from schemathesis.specs.openapi.checks import (
    content_type_conformance,
    negative_data_rejection,
    positive_data_acceptance,
    response_schema_conformance,
    status_code_conformance,
)

from backend.schemas import CaseResult, Category, Check, Exchange, RequestSpec, TestCase

CHECKS = [
    not_a_server_error,
    status_code_conformance,
    content_type_conformance,
    response_schema_conformance,
    negative_data_rejection,
    positive_data_acceptance,
]
CATEGORY: dict[str, Category] = {
    "not_a_server_error": "robustness",
    "negative_data_rejection": "negative",
    "positive_data_acceptance": "positive",
}
NOISE_HEADERS = {"user-agent", "accept", "accept-encoding", "connection", "content-length", "x-schemathesis-testcaseid"}
MAX_BODY_CHARS = 20_000


class BudgetSpent(Exception):
    pass


@dataclass
class FuzzOutcome:
    cases: list[TestCase] = field(default_factory=list)
    results: list[CaseResult] = field(default_factory=list)
    examples_run: int = 0
    requests_sent: int = 0
    errors: list[str] = field(default_factory=list)
    budget_hit: bool = False
    operations: int = 0


def _check_name(failure: Failure) -> str:
    return type(failure).checks[0] if type(failure).checks else failure.title


def _decode(raw: bytes | str | None) -> tuple[Any, str | None]:
    """Returns (json_body, raw_text): exactly one is set, or neither for an empty body."""
    if raw in (None, b"", ""):
        return None, None
    text = raw.decode("utf-8", "backslashreplace") if isinstance(raw, bytes) else raw
    try:
        return json.loads(text), None
    except ValueError:
        return None, text


def _clip(value: Any) -> Any:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return value if len(text) <= MAX_BODY_CHARS else text[:MAX_BODY_CHARS] + "... [truncated]"


def _documented(responses: list[str], low: int, high: int) -> list[int]:
    return sorted(int(c) for c in responses if c.isdigit() and low <= int(c) < high)


def _expected(check: str, negative: bool, actual: int, responses: list[str]) -> list[int]:
    client_errors = sorted({400, 422, *_documented(responses, 400, 500)})
    if check == "negative_data_rejection":
        return client_errors
    if check == "positive_data_acceptance":
        return _documented(responses, 200, 300) or [200, 201, 202, 204]
    if check == "status_code_conformance":
        return _documented(responses, 100, 600) or [actual]
    if check == "not_a_server_error":
        return client_errors if negative else (_documented(responses, 200, 500) or client_errors)
    return [actual]


def _to_case_and_result(op, response, failures: list[Failure], negative: bool, base_url: str) -> tuple[TestCase, CaseResult]:
    prepared = response.request
    url = urlsplit(prepared.url)
    base_path = urlsplit(base_url).path.rstrip("/")
    path = url.path[len(base_path):] if base_path and url.path.startswith(base_path) else url.path
    headers = {k: v for k, v in prepared.headers.items() if k.lower() not in NOISE_HEADERS}
    body, raw_body = _decode(prepared.body)
    has_content_type = any(k.lower() == "content-type" for k in headers)
    if has_content_type and headers.get("Content-Type", headers.get("content-type", "")).startswith("application/json"):
        headers = {k: v for k, v in headers.items() if k.lower() != "content-type"}
    request = RequestSpec(
        method=prepared.method,
        path=path,
        query=dict(parse_qsl(url.query, keep_blank_values=True)),
        headers=headers,
        body=body,
        raw_body=raw_body,
        omit_content_type=(body is not None or raw_body is not None) and not has_content_type,
    )

    first = failures[0]
    check = _check_name(first)
    responses = list(op.responses.status_codes)
    case = TestCase(
        endpoint_id=f"{op.method.upper()} {op.path}",
        name=f"Fuzzing: {first.title[:1].lower() + first.title[1:]}",
        category=CATEGORY.get(check, "robustness"),
        source="fuzz",
        rationale=f"Schemathesis generated {'invalid' if negative else 'valid'} input and the '{check}' check failed.",
        request=request,
        expected_status=_expected(check, negative, response.status_code, responses),
    )
    resp_body, resp_raw = _decode(response.content)
    exchange = Exchange(
        method=prepared.method,
        url=prepared.url,
        request_headers=dict(prepared.headers),
        request_body=body if body is not None else raw_body,
        status=response.status_code,
        response_headers={k: v[0] for k, v in response.headers.items() if v and k in ("content-type", "location", "allow")},
        response_body=_clip(resp_body if resp_body is not None else resp_raw),
        duration_ms=round(response.elapsed * 1000, 1),
    )
    checks = [
        Check(name=_check_name(f), passed=False, detail=f"{f.title}: {f.message.strip().splitlines()[0] if f.message.strip() else ''}".rstrip(": "))
        for f in failures
    ]
    return case, CaseResult(case_id=case.id, outcome="failed", exchange=exchange, checks=checks)


def run_fuzz(
    doc: dict[str, Any],
    base_url: str,
    *,
    max_examples: int,
    request_budget: int,
    timeout_s: float,
    allow_destructive: bool,
    stop: threading.Event | None = None,
) -> FuzzOutcome:
    """Runs Schemathesis positive and negative generation per operation. Blocking: call from a worker thread."""
    out = FuzzOutcome()
    seen: set[tuple[str, str]] = set()
    schema = schemathesis.openapi.from_dict(doc)

    neg_examples = max(1, max_examples // 2)
    pos_examples = max(1, max_examples - neg_examples)
    hyp_settings = dict(
        database=None,
        deadline=None,
        derandomize=False,
        phases=[Phase.generate],
        verbosity=Verbosity.quiet,
        suppress_health_check=list(HealthCheck),
    )

    for result in schema.get_all_operations():
        if isinstance(result, Err):
            out.errors.append(f"Invalid operation in spec: {result.err()}")
            continue
        op = result.ok()
        if op.method.upper() == "DELETE" and not allow_destructive:
            continue
        out.operations += 1

        for mode, examples in ((schemathesis.GenerationMode.POSITIVE, pos_examples), (schemathesis.GenerationMode.NEGATIVE, neg_examples)):
            negative = mode == schemathesis.GenerationMode.NEGATIVE

            @hypothesis.settings(max_examples=examples, **hyp_settings)
            @given(case=op.as_strategy(generation_mode=mode))
            def probe(case) -> None:
                if (stop is not None and stop.is_set()) or out.requests_sent >= request_budget:
                    raise BudgetSpent
                out.requests_sent += 1
                response = case.call(base_url=base_url, timeout=timeout_s, allow_redirects=False)
                out.examples_run += 1
                try:
                    case.validate_response(response, checks=CHECKS)
                except FailureGroup as group:
                    fresh = [f for f in group.exceptions if (op.label, _check_name(f)) not in seen]
                    if not fresh:
                        return
                    seen.update((op.label, _check_name(f)) for f in fresh)
                    try:
                        tc, cr = _to_case_and_result(op, response, fresh, negative, base_url)
                    except Exception as exc:
                        out.errors.append(f"{op.label}: could not record failure ({type(exc).__name__}: {exc})")
                        return
                    out.cases.append(tc)
                    out.results.append(cr)

            try:
                probe()
            except BudgetSpent:
                out.budget_hit = True
                return out
            except hypothesis.errors.Unsatisfiable:
                continue
            except Exception as exc:
                out.errors.append(f"{op.label}: {type(exc).__name__}: {str(exc).strip().splitlines()[0] if str(exc).strip() else ''}")
    return out
