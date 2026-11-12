import json
import re
from typing import Any

from backend import ai
from backend.schemas import Endpoint, RequestSpec, TestCase

SETUP_REF = re.compile(r"\{\{\s*setup\.(\d+)\.")
PATH_PARAM = re.compile(r"\{([^}]+)\}")
TEMPLATE_NAME = re.compile(r"\{\{\s*([\w.\-]+)\s*\}\}")


class PlanRejected(ValueError):
    pass


def contract_summary(endpoints: list[Endpoint]) -> list[dict[str, Any]]:
    return [
        {
            "endpoint_id": ep.id,
            "summary": ep.summary,
            "description": ep.description,
            "parameters": [
                {"name": p.name, "in": p.location, "required": p.required, "schema": p.schema_} for p in ep.parameters
            ],
            "request_body": ep.request_body_schema,
            "responses": ep.responses,
        }
        for ep in endpoints
    ]


def _json_object(text: str, label: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PlanRejected(f"{label} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise PlanRejected(f"{label} must be a JSON object")
    return value


def _headers(text: str) -> dict[str, str]:
    headers = _json_object(text, "headers_json")
    out: dict[str, str] = {}
    for key, value in headers.items():
        if not isinstance(key, str) or not key.strip() or any(c in key for c in "\r\n:"):
            raise PlanRejected(f"invalid header name {key!r}")
        if isinstance(value, (dict, list)) or value is None:
            raise PlanRejected(f"header {key} must be a string")
        out[key.strip()] = str(value)
    return out


def _check_templates(serialized: str, variables: frozenset[str]) -> None:
    for name in TEMPLATE_NAME.findall(serialized):
        if name == "unique" or name.startswith("setup."):
            continue
        if name not in variables:
            raise PlanRejected(f"uses unknown variable {{{{{name}}}}}")


def _to_request(
    raw: ai.AiRequest, endpoints: dict[str, Endpoint], max_setup_ref: int, variables: frozenset[str] = frozenset()
) -> RequestSpec:
    endpoint_id = f"{raw.method.upper()} {raw.path}"
    if endpoint_id not in endpoints:
        raise PlanRejected(f"{endpoint_id} is not in the specification")

    path_params = _json_object(raw.path_params_json, "path_params_json")
    missing = set(PATH_PARAM.findall(raw.path)) - set(path_params)
    if missing:
        raise PlanRejected(f"missing path parameters: {', '.join(sorted(missing))}")

    body: Any = None
    if raw.body_json.strip():
        try:
            body = json.loads(raw.body_json)
        except json.JSONDecodeError as exc:
            raise PlanRejected("body_json is not valid JSON; malformed bodies belong in raw_body") from exc

    query = _json_object(raw.query_json, "query_json")
    headers = _headers(raw.headers_json)
    serialized = json.dumps([path_params, query, headers, body, raw.raw_body])
    for ref in SETUP_REF.findall(serialized):
        if int(ref) >= max_setup_ref:
            raise PlanRejected(f"refers to setup step {ref}, which has not run at that point")
    _check_templates(serialized, variables)

    return RequestSpec(
        method=raw.method.upper(),
        path=raw.path,
        path_params=path_params,
        query=query,
        headers=headers,
        body=body,
        raw_body=raw.raw_body or None,
    )


def to_test_case(raw: ai.AiCase, endpoints: dict[str, Endpoint], variables: frozenset[str] = frozenset()) -> TestCase:
    if raw.endpoint_id not in endpoints:
        raise PlanRejected(f"{raw.endpoint_id} is not in the specification")
    setup = [_to_request(step, endpoints, max_setup_ref=i, variables=variables) for i, step in enumerate(raw.setup)]
    if any(step.method == "DELETE" for step in setup):
        raise PlanRejected("setup steps may not delete data")
    request = _to_request(raw.request, endpoints, max_setup_ref=len(setup), variables=variables)
    if f"{request.method} {request.path}" != raw.endpoint_id:
        raise PlanRejected("request does not match its endpoint_id")

    expected = validate_expected(raw.expected_status)

    return TestCase(
        endpoint_id=raw.endpoint_id,
        name=raw.name.strip()[:120],
        category=raw.category,
        source="ai",
        rationale=raw.rationale.strip(),
        setup=setup,
        request=request,
        expected_status=expected,
        destructive=request.method == "DELETE",
    )


def validate_expected(codes: list[int]) -> list[int]:
    expected = sorted({s for s in codes if 100 <= s <= 599})
    if not expected:
        raise PlanRejected("no valid expected status")
    if any(s >= 500 for s in expected):
        raise PlanRejected("expects a 5xx, which is never a correct outcome")
    return expected
