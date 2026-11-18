import json
import re
from typing import Any

from backend import ai
from backend.schemas import Endpoint, RequestSpec, TestCase

SETUP_REF = re.compile(r"\{\{\s*setup\.(\d+)\.")
PATH_PARAM = re.compile(r"\{([^}]+)\}")
TEMPLATE_NAME = re.compile(r"\{\{\s*([\w.\-]+)\s*\}\}")
BARE_TEMPLATE = re.compile(r'(?<!["\w])(\{\{\s*[\w.\-]+\s*\}\})(?!["\w])')


def _loads(text: str) -> Any:
    """JSON, also when a model left a {{template}} value unquoted: {"id": {{setup.0.body.id}}}."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        fixed = BARE_TEMPLATE.sub(r'"\1"', text)
        if fixed == text:
            raise
        return json.loads(fixed)


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
        value = _loads(text)
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


def resolve_endpoint(method: str, path: str, endpoints: dict[str, Endpoint]) -> tuple[Endpoint, dict[str, str]]:
    """The spec endpoint a request means, and any path values written into the path itself.

    Models sometimes write "/orders/{{order_id}}" or "/orders/42" where the spec says "/orders/{order_id}";
    those resolve to the spec path, with "{{order_id}}" or "42" moved into the path parameters."""
    method = method.upper().strip()
    path = path.strip()
    first, _, rest = path.partition(" ")
    if first.upper() == method and rest.strip().startswith("/"):  # "GET /orders" written into the path field
        path = rest.strip()
    exact = endpoints.get(f"{method} {path}")
    if exact is not None:
        return exact, {}
    given = [seg for seg in path.split("?")[0].strip("/").split("/")]
    matches: list[tuple[Endpoint, dict[str, str]]] = []
    for ep in endpoints.values():
        template = ep.path.strip("/").split("/")
        if ep.method != method or len(template) != len(given):
            continue
        values: dict[str, str] = {}
        for want, got in zip(template, given):
            name = PATH_PARAM.fullmatch(want)
            if name and not want.startswith("{{"):
                if got != want and got:
                    values[name.group(1)] = got
            elif want != got:
                break
        else:
            matches.append((ep, values))
    if len(matches) != 1:
        raise PlanRejected(f"{method} {path} is not in the specification")
    return matches[0]


def _to_request(
    raw: ai.AiRequest, endpoints: dict[str, Endpoint], max_setup_ref: int, variables: frozenset[str] = frozenset()
) -> RequestSpec:
    ep, written_in_path = resolve_endpoint(raw.method, raw.path, endpoints)

    path_params = {**written_in_path, **_json_object(raw.path_params_json, "path_params_json")}
    missing = set(PATH_PARAM.findall(ep.path)) - set(path_params)
    if missing:
        raise PlanRejected(f"missing path parameters: {', '.join(sorted(missing))}")

    body: Any = None
    if raw.body_json.strip():
        try:
            body = _loads(raw.body_json)
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
        method=ep.method,
        path=ep.path,
        path_params=path_params,
        query=query,
        headers=headers,
        body=body,
        raw_body=raw.raw_body or None,
    )


def to_test_case(raw: ai.AiCase, endpoints: dict[str, Endpoint], variables: frozenset[str] = frozenset()) -> TestCase:
    method, _, path = raw.endpoint_id.strip().partition(" ")
    endpoint_id = resolve_endpoint(method, path, endpoints)[0].id
    setup = [_to_request(step, endpoints, max_setup_ref=i, variables=variables) for i, step in enumerate(raw.setup)]
    if any(step.method == "DELETE" for step in setup):
        raise PlanRejected("setup steps may not delete data")
    request = _to_request(raw.request, endpoints, max_setup_ref=len(setup), variables=variables)
    if f"{request.method} {request.path}" != endpoint_id:
        raise PlanRejected("request does not match its endpoint_id")

    expected = validate_expected(raw.expected_status)

    return TestCase(
        endpoint_id=endpoint_id,
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
