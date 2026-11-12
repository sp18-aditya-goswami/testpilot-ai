import ast
import asyncio

import httpx
import pytest

from backend import ai
from backend.engines.ai_planner import PlanRejected, to_test_case
from backend.engines.base import PlanContext
from backend.engines.contract import ContractEngine
from backend.executor import CaseContext, Executor
from backend.findings import regression_test
from backend.runner import _run_case
from backend.schemas import RequestSpec, TestCase
from backend.spec_parser import SpecError, load_spec_text, parse_spec
from demo_api.main import app as demo_app


def test_parser_extracts_endpoints(demo_api):
    ids = {e.id for e in demo_api.endpoints}
    assert "POST /api/users/register" in ids
    register = next(e for e in demo_api.endpoints if e.id == "POST /api/users/register")
    assert set(register.request_body_schema["required"]) == {"email", "password"}
    assert "201" in register.responses


def test_parser_resolves_refs_and_reads_yaml():
    doc = load_spec_text(
        """
openapi: 3.0.3
info: {title: Shop, version: "1"}
paths:
  /items:
    post:
      requestBody:
        content:
          application/json:
            schema: {$ref: '#/components/schemas/Item'}
      responses:
        "201": {description: ok}
components:
  schemas:
    Item:
      type: object
      required: [sku]
      properties:
        sku: {type: string, maxLength: 8}
"""
    )
    api = parse_spec(doc)
    assert api.endpoints[0].request_body_schema["properties"]["sku"]["maxLength"] == 8


def test_parser_rejects_non_spec():
    with pytest.raises(SpecError):
        load_spec_text('{"hello": "world"}')


def test_contract_engine_builds_setup_for_path_params(demo_api):
    cases = ContractEngine().plan(PlanContext(api=demo_api)).cases
    get_by_id = next(c for c in cases if c.endpoint_id == "GET /api/users/{user_id}" and c.category == "positive")
    assert get_by_id.setup[0].path == "/api/users/register"
    assert get_by_id.request.path_params["user_id"] == "{{setup.0.body.id}}"
    assert all(c.destructive for c in cases if c.request.method == "DELETE")


def test_template_rendering_keeps_types():
    ctx = CaseContext()
    ctx.setup.append({"status": 201, "body": {"id": 7, "tags": ["a"]}})
    assert ctx.render("{{setup.0.body.id}}") == 7
    assert ctx.render("u{{setup.0.body.id}}") == "u7"
    assert ctx.render({"x": "{{setup.0.body.tags.0}}"}) == {"x": "a"}
    assert ctx.render("{{unique}}") == ctx.unique


def _ai_request(method="POST", path="/api/users/register", path_params="{}", body='{"email": "a.{{unique}}@x.io", "password": "Str0ngPass!"}'):
    return ai.AiRequest(method=method, path=path, path_params_json=path_params, query_json="{}", body_json=body, raw_body="")


def _ai_case(**overrides):
    fields = dict(
        endpoint_id="POST /api/users/register",
        name="Duplicate email is rejected",
        category="business",
        rationale="Emails must be unique.",
        setup=[_ai_request()],
        request=_ai_request(),
        expected_status=[409],
    )
    fields.update(overrides)
    return ai.AiCase(**fields)


def test_ai_case_validation_accepts_good_case(demo_api):
    endpoints = {e.id: e for e in demo_api.endpoints}
    case = to_test_case(_ai_case(), endpoints)
    assert case.source == "ai" and case.expected_status == [409]


@pytest.mark.parametrize(
    "overrides, reason",
    [
        ({"endpoint_id": "POST /api/admin/drop"}, "not in the specification"),
        ({"expected_status": [500]}, "5xx"),
        ({"request": _ai_request(body="{not json")}, "not valid JSON"),
        ({"request": _ai_request(method="GET", path="/api/users/{user_id}"), "endpoint_id": "GET /api/users/{user_id}"}, "missing path parameters"),
        ({"setup": [], "request": _ai_request(body='{"email": "{{setup.0.body.email}}", "password": "x"}')}, "has not run"),
        ({"setup": [_ai_request(method="DELETE", path="/api/users/{user_id}", path_params='{"user_id": 1}')]}, "may not delete"),
    ],
)
def test_ai_case_validation_rejects_bad_cases(demo_api, overrides, reason):
    endpoints = {e.id: e for e in demo_api.endpoints}
    with pytest.raises(PlanRejected, match=reason):
        to_test_case(_ai_case(**overrides), endpoints)


def _run_against_demo(case: TestCase, demo_api):
    async def go():
        transport = httpx.ASGITransport(app=demo_app)
        async with httpx.AsyncClient(transport=transport) as client:
            executor = Executor(client, "http://demo", max_requests=20)
            ep = next(e for e in demo_api.endpoints if e.id == case.endpoint_id)
            return await _run_case(case, ep, executor, allow_destructive=False)

    return asyncio.run(go())


def test_duplicate_registration_bug_is_detected(demo_api, demo_client):
    endpoints = {e.id: e for e in demo_api.endpoints}
    case = to_test_case(_ai_case(), endpoints)
    result = _run_against_demo(case, demo_api)
    assert result.outcome == "failed"
    assert result.exchange.status == 201


def test_regression_test_is_valid_python(demo_api):
    endpoints = {e.id: e for e in demo_api.endpoints}
    case = to_test_case(
        _ai_case(
            setup=[_ai_request()],
            request=_ai_request(method="GET", path="/api/users/{user_id}", path_params='{"user_id": "{{setup.0.body.id}}"}', body=""),
            endpoint_id="GET /api/users/{user_id}",
            expected_status=[200],
        ),
        endpoints,
    )
    source = regression_test(case, "http://localhost:8008")
    ast.parse(source)
    assert 'setup_0.json()["id"]' in source
    assert "f'a.{unique}@x.io'" in source


def test_destructive_cases_are_skipped_by_default(demo_api, demo_client):
    case = TestCase(
        endpoint_id="DELETE /api/users/{user_id}",
        name="Delete",
        category="positive",
        source="contract",
        request=RequestSpec(method="DELETE", path="/api/users/{user_id}", path_params={"user_id": 1}),
        expected_status=[204],
        destructive=True,
    )
    assert _run_against_demo(case, demo_api).outcome == "skipped"
