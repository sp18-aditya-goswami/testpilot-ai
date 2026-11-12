from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from backend.schemas import Check, Endpoint, Exchange, TestCase


def _openapi_to_jsonschema(schema: Any) -> Any:
    """OpenAPI 3.0 marks nullability with `nullable: true`; JSON Schema needs it in `type`."""
    if isinstance(schema, dict):
        out = {k: _openapi_to_jsonschema(v) for k, v in schema.items() if k not in ("nullable", "example", "xml")}
        if schema.get("nullable") and "type" in out and isinstance(out["type"], str):
            out["type"] = [out["type"], "null"]
        return out
    if isinstance(schema, list):
        return [_openapi_to_jsonschema(v) for v in schema]
    return schema


def _documented_schema(ep: Endpoint, status: int) -> tuple[bool, dict[str, Any] | None]:
    for key in (str(status), f"{str(status)[0]}XX", f"{str(status)[0]}xx", "default"):
        if key in ep.responses:
            return True, ep.responses[key]
    return False, None


def validate(case: TestCase, ep: Endpoint | None, exchange: Exchange, slow_ms: int) -> list[Check]:
    if exchange.status is None:
        return [Check(name="request completed", passed=False, detail=exchange.error or "No response")]

    status = exchange.status
    checks = [
        Check(
            name="status code",
            passed=status in case.expected_status,
            detail=f"expected {' or '.join(map(str, case.expected_status))}, got {status}",
        ),
        Check(
            name="no server error",
            passed=status < 500,
            detail="server returned a 5xx" if status >= 500 else "no 5xx",
        ),
    ]

    if ep is not None:
        documented, schema = _documented_schema(ep, status)
        checks.append(
            Check(
                name="status documented",
                passed=documented,
                severity="warn",
                detail=f"{status} is {'listed' if documented else 'not listed'} in the contract's responses",
            )
        )
        if documented and schema and 200 <= status < 300 and status != 204:
            try:
                errors = sorted(
                    Draft202012Validator(_openapi_to_jsonschema(schema)).iter_errors(exchange.response_body),
                    key=lambda e: list(e.path),
                )
            except SchemaError as exc:
                checks.append(Check(name="response schema", passed=True, severity="warn", detail=f"schema unusable: {exc.message}"))
            else:
                if errors:
                    first = errors[0]
                    where = "/".join(map(str, first.path)) or "body"
                    detail = f"{where}: {first.message}" + (f" (+{len(errors) - 1} more)" if len(errors) > 1 else "")
                else:
                    detail = "body matches the documented schema"
                checks.append(Check(name="response schema", passed=not errors, detail=detail))

    if case.json_schema:
        try:
            Draft202012Validator.check_schema(case.json_schema)
            errors = sorted(Draft202012Validator(case.json_schema).iter_errors(exchange.response_body), key=lambda e: list(e.path))
        except SchemaError as exc:
            checks.append(Check(name="body schema", passed=False, detail=f"the assertion's schema is invalid: {exc.message}"))
        else:
            if errors:
                where = "/".join(map(str, errors[0].path)) or "body"
                detail = f"{where}: {errors[0].message}" + (f" (+{len(errors) - 1} more)" if len(errors) > 1 else "")
            else:
                detail = "body matches the asserted schema"
            checks.append(Check(name="body schema", passed=not errors, detail=detail))

    if case.max_ms is not None and exchange.duration_ms is not None:
        checks.append(
            Check(
                name="time limit",
                passed=exchange.duration_ms <= case.max_ms,
                detail=f"{exchange.duration_ms:.0f} ms (limit {case.max_ms} ms)",
            )
        )
    elif exchange.duration_ms is not None:
        checks.append(
            Check(
                name="latency",
                passed=exchange.duration_ms <= slow_ms,
                severity="warn",
                detail=f"{exchange.duration_ms:.0f} ms (threshold {slow_ms} ms)",
            )
        )
    return checks


def outcome_for(checks: list[Check]) -> str:
    return "failed" if any(not c.passed and c.severity == "fail" for c in checks) else "passed"
