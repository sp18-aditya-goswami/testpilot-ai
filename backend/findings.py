import re
from typing import Any

from backend.executor import TEMPLATE
from backend.schemas import Analysis, CaseResult, RequestSpec, TestCase


def rules_analysis(case: TestCase, result: CaseResult) -> Analysis:
    ex = result.exchange
    status = ex.status if ex else None
    expected = " or ".join(map(str, case.expected_status))
    failed = [c for c in result.checks if not c.passed and c.severity == "fail"]
    writes = case.request.method in ("POST", "PUT", "PATCH")

    if status is None:
        return Analysis(
            title=f"No response from {case.endpoint_id}",
            severity="high",
            summary=f"The request did not complete: {ex.error if ex else 'unknown error'}.",
            likely_cause="The server crashed, hung past the timeout, or the base URL is wrong.",
            investigation_steps=["Check the server logs at the time of the request.", "Confirm the base URL and that the server is running."],
        )
    if status >= 500:
        return Analysis(
            title=f"Server error on {case.endpoint_id}",
            severity="critical",
            summary=f"{case.name}: the server returned {status} where {expected} was expected.",
            likely_cause="An unhandled exception, most likely input the handler does not validate before using.",
            investigation_steps=["Find the stack trace for this request in the server logs.", "Add validation for the input shown in the request."],
        )
    if all(s >= 400 for s in case.expected_status) and status < 400:
        return Analysis(
            title=f"{'Invalid input accepted' if writes else 'Error case answered with success'} on {case.endpoint_id}",
            severity="high" if writes else "medium",
            summary=f"{case.name}: expected {expected}, but the server answered {status}.",
            likely_cause=(
                "The handler accepts the input without enforcing this rule; the check is missing or never reached."
                if writes
                else "The handler returns a success response instead of raising a not-found or validation error."
            ),
            investigation_steps=[
                "Find where this rule should be enforced (schema validator, service layer or database constraint).",
                "Add the regression test below and make it pass.",
            ],
        )
    if all(s < 400 for s in case.expected_status) and status >= 400:
        return Analysis(
            title=f"Valid request rejected on {case.endpoint_id}",
            severity="high",
            summary=f"{case.name}: expected {expected}, got {status}.",
            likely_cause="Validation is stricter than the contract, or the test's setup state did not hold.",
            investigation_steps=["Compare the response error message with the documented schema.", "Check whether the setup steps succeeded."],
        )
    detail = "; ".join(c.detail.rstrip(".") for c in failed) or "A check failed"
    return Analysis(
        title=f"Contract mismatch on {case.endpoint_id}",
        severity="medium",
        summary=f"{detail[:1].upper()}{detail[1:]}.",
        likely_cause="The implementation and the OpenAPI document have drifted apart.",
        investigation_steps=["Decide whether the code or the specification is correct.", "Update the other one to match."],
    )


def failure_digest(case: TestCase, result: CaseResult) -> dict[str, Any]:
    ex = result.exchange
    return {
        "case_id": case.id,
        "endpoint": case.endpoint_id,
        "name": case.name,
        "intent": case.rationale,
        "setup": [{"method": s.method, "url": s.url, "status": s.status, "body": s.response_body} for s in result.setup_exchanges],
        "request": {"method": ex.method, "url": ex.url, "body": ex.request_body} if ex else None,
        "response": {"status": ex.status, "body": ex.response_body, "error": ex.error} if ex else None,
        "expected_status": case.expected_status,
        "failed_checks": [f"{c.name}: {c.detail}" for c in result.checks if not c.passed and c.severity == "fail"],
    }


# ---------- regression test generation ----------

def _setup_expr(expr: str) -> str:
    if expr == "unique":
        return "unique"
    parts = expr.split(".")
    if parts[0] != "setup" or len(parts) < 3 or not parts[1].isdigit():
        env_name = expr.upper().replace("-", "_").replace(".", "_")
        return f'os.environ.get("{env_name}", "")'
    access = "".join(f"[{int(p)}]" if p.isdigit() else f'["{p}"]' for p in parts[3:])
    return f"setup_{parts[1]}.json(){access}"


def _py(value: Any) -> str:
    if isinstance(value, str):
        whole = TEMPLATE.fullmatch(value.strip())
        if whole:
            return _setup_expr(whole.group(1))
        if TEMPLATE.search(value):
            escaped = value.replace("{", "{{").replace("}", "}}")
            escaped = re.sub(r"\{\{\{\{\s*([\w.\-]+)\s*\}\}\}\}", lambda m: "{" + _setup_expr(m.group(1)) + "}", escaped)
            return "f" + repr(escaped)
        return repr(value)
    if isinstance(value, dict):
        return "{" + ", ".join(f"{k!r}: {_py(v)}" for k, v in value.items()) + "}"
    if isinstance(value, list):
        return "[" + ", ".join(_py(v) for v in value) + "]"
    return repr(value)


def _call(spec: RequestSpec, var: str, indent: str) -> list[str]:
    path = _py(spec.path)
    if spec.path_params:
        args = ", ".join(f"{k}={_py(v)}" for k, v in spec.path_params.items())
        path = f"{path}.format({args})"
    kwargs: list[str] = []
    if spec.query:
        kwargs.append(f"params={_py(spec.query)}")
    if spec.raw_body is not None:
        kwargs.append(f"content={_py(spec.raw_body)}")
        if not spec.omit_content_type:
            kwargs.append('headers={"Content-Type": "application/json"}')
    elif spec.body is not None:
        if spec.omit_content_type:
            kwargs.append(f"content=json.dumps({_py(spec.body)})")
        else:
            kwargs.append(f"json={_py(spec.body)}")
    if spec.headers:
        kwargs.append(f"headers={_py(spec.headers)}")
    call = f"client.request({spec.method!r}, {path}" + "".join(f", {k}" for k in kwargs) + ")"
    return [f"{indent}{var} = {call}"]


def regression_test(case: TestCase, base_url: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", case.name.lower()).strip("_")[:60] or "case"
    lines = [
        "import json",
        "from uuid import uuid4",
        "",
        "import httpx",
        "",
        f"BASE_URL = {base_url.rstrip('/')!r}",
        "",
        "",
        f"def test_{slug}():",
        f'    """{case.rationale.replace(chr(34) * 3, chr(39) * 3) or case.name}"""',
        "    unique = uuid4().hex[:8]",
        "    with httpx.Client(base_url=BASE_URL, timeout=10) as client:",
    ]
    for i, step in enumerate(case.setup):
        lines += _call(step, f"setup_{i}", "        ")
        lines.append(f"        assert setup_{i}.status_code < 400, setup_{i}.text")
    lines += _call(case.request, "response", "        ")
    expected = ", ".join(map(str, case.expected_status))
    lines.append(f"    assert response.status_code in ({expected},), response.text")
    body = "\n".join(lines[12:])
    if "unique" not in body:
        lines.remove("    unique = uuid4().hex[:8]")
        lines.remove("from uuid import uuid4")
    if "json.dumps" not in body:
        lines.remove("import json")
    if "os.environ" in body:
        lines.insert(0, "import os")
    source = "\n".join(lines) + "\n"
    return source.lstrip("\n")
