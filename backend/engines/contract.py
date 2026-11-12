import copy
from typing import Any

from backend.engines.base import EngineOutput, PlanContext, PlanningEngine
from backend.engines.examples import UNIQUE, example_for, primary_schema, wrong_type_value
from backend.schemas import Endpoint, RequestSpec, TestCase

VALIDATION_ERROR = [400, 422]
MAX_FIELD_CASES = 6


def success_statuses(ep: Endpoint) -> list[int]:
    codes = sorted(int(c) for c in ep.responses if c.isdigit() and 200 <= int(c) < 300)
    return codes[:1] or [200, 201, 202, 204]


def _collection_path(path: str) -> str:
    return path.split("{", 1)[0].rstrip("/")


def find_creator(ep: Endpoint, endpoints: list[Endpoint]) -> Endpoint | None:
    collection = _collection_path(ep.path)
    candidates = [
        e for e in endpoints
        if e.method == "POST" and "{" not in e.path and e.path.rstrip("/").startswith(collection)
    ]
    return min(candidates, key=lambda e: len(e.path), default=None)


def _id_field(creator: Endpoint, param_name: str) -> str:
    for code in success_statuses(creator):
        props = (creator.responses.get(str(code)) or {}).get("properties", {})
        if param_name in props:
            return param_name
    return "id"


class ContractEngine(PlanningEngine):
    """Derives cases from the OpenAPI contract alone: types, required fields, bounds, documented statuses."""

    name = "contract"

    def plan(self, ctx: PlanContext) -> EngineOutput:
        cases: list[TestCase] = []
        for ep in self.endpoints_in_scope(ctx):
            cases.extend(self._cases_for(ep, ctx.api.endpoints))
        return EngineOutput(cases=cases, message=f"{len(cases)} cases derived from the contract")

    def _base_request(self, ep: Endpoint, endpoints: list[Endpoint]) -> tuple[RequestSpec, list[RequestSpec], bool]:
        path_params: dict[str, Any] = {}
        setup: list[RequestSpec] = []
        uses_existing = False
        creator = find_creator(ep, endpoints) if "{" in ep.path else None

        for p in ep.parameters:
            if p.location != "path":
                continue
            if creator is not None:
                if not setup:
                    setup.append(
                        RequestSpec(
                            method="POST",
                            path=creator.path,
                            body=example_for(creator.request_body_schema) if creator.request_body_schema else None,
                        )
                    )
                path_params[p.name] = f"{{{{setup.0.body.{_id_field(creator, p.name)}}}}}"
                uses_existing = True
            else:
                path_params[p.name] = example_for(p.schema_, p.name)

        query = {p.name: example_for(p.schema_, p.name) for p in ep.parameters if p.location == "query" and p.required}
        body = example_for(ep.request_body_schema) if ep.request_body_schema is not None else None
        req = RequestSpec(method=ep.method, path=ep.path, path_params=path_params, query=query, body=body)
        return req, setup, uses_existing

    def _cases_for(self, ep: Endpoint, endpoints: list[Endpoint]) -> list[TestCase]:
        base, setup, uses_existing = self._base_request(ep, endpoints)
        destructive = ep.method == "DELETE"
        out: list[TestCase] = []

        def add(name: str, category: str, request: RequestSpec, expected: list[int], rationale: str, with_setup: bool = True):
            out.append(
                TestCase(
                    endpoint_id=ep.id,
                    name=name,
                    category=category,
                    source="contract",
                    rationale=rationale,
                    setup=copy.deepcopy(setup) if with_setup else [],
                    request=request,
                    expected_status=expected,
                    destructive=destructive,
                )
            )

        add(
            "Valid request succeeds",
            "positive",
            base,
            success_statuses(ep),
            "A request built from the documented schema should return the documented success status.",
        )

        path_params = [p for p in ep.parameters if p.location == "path"]
        if path_params and uses_existing:
            missing = base.model_copy(deep=True)
            for p in path_params:
                is_int = primary_schema(p.schema_).get("type") in ("integer", "number")
                missing.path_params[p.name] = 987654321 if is_int else f"missing-{UNIQUE}"
            add(
                "Unknown resource returns 404",
                "negative",
                missing,
                [404],
                "REST convention: addressing a resource that does not exist must return 404, not an empty success.",
                with_setup=False,
            )
            for p in path_params:
                if primary_schema(p.schema_).get("type") in ("integer", "number"):
                    bad = base.model_copy(deep=True)
                    bad.path_params[p.name] = "not-a-number"
                    add(
                        f"Non-numeric '{p.name}' is rejected",
                        "negative",
                        bad,
                        [400, 404, 422],
                        f"'{p.name}' is declared as {primary_schema(p.schema_).get('type')}.",
                        with_setup=False,
                    )

        for p in ep.parameters:
            if p.location == "query" and p.required:
                req = base.model_copy(deep=True)
                req.query.pop(p.name, None)
                add(f"Missing query parameter '{p.name}'", "negative", req, VALIDATION_ERROR, "Parameter is required.")

        schema = ep.request_body_schema
        if not schema or not isinstance(base.body, dict):
            return out

        props: dict[str, Any] = schema.get("properties", {})
        required: list[str] = schema.get("required", [])

        if required:
            req = base.model_copy(deep=True)
            req.body = {}
            add("Empty JSON object is rejected", "negative", req, VALIDATION_ERROR, f"Required fields: {', '.join(required)}.")

        for name in required[:MAX_FIELD_CASES]:
            req = base.model_copy(deep=True)
            req.body.pop(name, None)
            add(f"Missing required field '{name}'", "negative", req, VALIDATION_ERROR, f"'{name}' is required by the schema.")

            req = base.model_copy(deep=True)
            req.body[name] = None
            add(f"Null for required field '{name}'", "negative", req, VALIDATION_ERROR, f"'{name}' is required and not nullable.")

        for name, sub in list(props.items())[:MAX_FIELD_CASES]:
            req = base.model_copy(deep=True)
            req.body[name] = wrong_type_value(sub)
            add(
                f"Wrong type for '{name}'",
                "negative",
                req,
                VALIDATION_ERROR,
                f"'{name}' is declared as {primary_schema(sub).get('type', 'string')}.",
            )

            inner = primary_schema(sub)
            if inner.get("maxLength") is not None:
                req = base.model_copy(deep=True)
                req.body[name] = "x" * (int(inner["maxLength"]) + 1)
                add(f"'{name}' above maxLength", "boundary", req, VALIDATION_ERROR, f"maxLength is {inner['maxLength']}.")
            if inner.get("minLength"):
                req = base.model_copy(deep=True)
                req.body[name] = "x" * (int(inner["minLength"]) - 1)
                add(f"'{name}' below minLength", "boundary", req, VALIDATION_ERROR, f"minLength is {inner['minLength']}.")
            if inner.get("enum"):
                req = base.model_copy(deep=True)
                req.body[name] = "__not_in_enum__"
                add(f"'{name}' outside enum", "negative", req, VALIDATION_ERROR, f"Allowed: {inner['enum']}.")
            if inner.get("maximum") is not None:
                req = base.model_copy(deep=True)
                req.body[name] = inner["maximum"] + 1
                add(f"'{name}' above maximum", "boundary", req, VALIDATION_ERROR, f"maximum is {inner['maximum']}.")

        req = base.model_copy(deep=True)
        req.body = None
        req.raw_body = '{"truncated": '
        add("Malformed JSON body is rejected", "robustness", req, VALIDATION_ERROR, "The server must reject unparseable JSON without a 5xx.")
        return out
