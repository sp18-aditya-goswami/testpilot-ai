import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend import ai, planner
from backend.main import app
from backend.store import store

PROJECT = "proj_0123456789"
REGISTER = "POST /api/users/register"
ENV = SimpleNamespace(base_url="http://localhost:8008", variables={"token": "t-123"}, secret_values={"t-123"}, name="Local")


def req(method="POST", path="/api/users/register", body='{"email": "a.{{unique}}@x.io", "password": "Str0ngPass!"}', headers="{}", path_params="{}"):
    return ai.AiRequest(method=method, path=path, path_params_json=path_params, query_json="{}", headers_json=headers, body_json=body, raw_body="")


def canned_strategy(context, scope, target):
    return ai.AiStrategy(
        endpoints=[ai.AiEndpointStrategy(endpoint_id=e, risks=["accepts duplicates"], categories=["business"], planned_cases=2) for e in scope]
    )


def canned_endpoint(context, brief):
    if planner.extract_endpoint(brief) != REGISTER:
        return ai.AiPlan(cases=[])
    auth = '{"Authorization": "Bearer {{token}}"}'
    return ai.AiPlan(
        cases=[
            ai.AiCase(endpoint_id=REGISTER, name="Duplicate email is rejected", category="business", rationale="Rule 1.",
                      setup=[req()], request=req(headers=auth), expected_status=[400]),
            ai.AiCase(endpoint_id=REGISTER, name="Uses an unknown variable", category="business", rationale="x",
                      setup=[], request=req(headers='{"X-Api-Key": "{{nope}}"}'), expected_status=[201]),
            ai.AiCase(endpoint_id=REGISTER, name="Header left off", category="business", rationale="auth is injected",
                      setup=[], request=req(body='{"email": "b.{{unique}}@x.io", "password": "Str0ngPass!"}'), expected_status=[201]),
            ai.AiCase(endpoint_id=REGISTER, name="Missing token is rejected", category="security", rationale="no auth",
                      setup=[], request=req(body='{"email": "c.{{unique}}@x.io", "password": "Str0ngPass!"}'), expected_status=[401]),
        ]
    )


def canned_review(context, cases):
    items = []
    for c in cases:
        if c["name"] == "Duplicate email is rejected":
            items.append(ai.AiReviewItem(case_ref=c["case_ref"], action="fix_expected", expected_status=[409], reason="rule 1 names 409"))
        else:
            items.append(ai.AiReviewItem(case_ref=c["case_ref"], action="keep", expected_status=[], reason="sound"))
    return ai.AiReview(items=items, gaps=["No case covers pagination"])


@pytest.fixture
def spec_id(demo_api):
    store.save("specs", demo_api.spec_id, demo_api, project_id=PROJECT)
    return demo_api.spec_id


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(planner, "env_runtime", lambda env_id: ENV)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def ai_on(monkeypatch):
    monkeypatch.setattr(planner, "ai_enabled", lambda: True)
    monkeypatch.setattr(ai, "plan_strategy", canned_strategy)
    monkeypatch.setattr(ai, "plan_endpoint", canned_endpoint)
    monkeypatch.setattr(ai, "review_cases", canned_review)


def wait_ready(client, plan_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        plan = client.get(f"/api/plans/{plan_id}").json()
        if plan["status"] != "planning":
            return plan
        time.sleep(0.05)
    raise AssertionError("plan never finished")


def create(client, spec_id, **config):
    body = {"project_id": PROJECT, "spec_id": spec_id, "environment_id": "env_0123456789",
            "config": {"focus_endpoints": [REGISTER, "GET /api/users"], **config}}
    res = client.post("/api/plans", json=body)
    assert res.status_code == 202, res.text
    assert res.json()["status"] in ("planning", "ready")
    return wait_ready(client, res.json()["id"])


def test_pipeline_builds_contract_and_ai_cases(client, spec_id, ai_on):
    plan = create(client, spec_id, auth={"token_variable": "token", "header_name": "Authorization"})
    assert plan["status"] == "ready" and plan["ai_status"] == "ok"
    sources = {c["source"] for c in plan["cases"]}
    assert sources == {"ai", "contract"}
    assert [s["endpoint_id"] for s in plan["strategy"]] == [REGISTER, "GET /api/users"]

    by_name = {c["name"]: c for c in plan["cases"] if c["source"] == "ai"}
    assert by_name["Duplicate email is rejected"]["expected_status"] == [409]
    assert any("rule 1 names 409" in n for n in plan["review_notes"])
    assert any(n.startswith("Gap:") for n in plan["review_notes"])

    assert "Uses an unknown variable" not in by_name
    assert any("unknown variable {{nope}}" in r["reason"] for r in plan["rejected"])

    assert by_name["Header left off"]["request"]["headers"]["Authorization"] == "Bearer {{token}}"
    assert "Authorization" not in by_name["Missing token is rejected"]["request"]["headers"]
    dup = by_name["Duplicate email is rejected"]
    assert dup["setup"][0]["headers"]["Authorization"] == "Bearer {{token}}"
    contract = next(c for c in plan["cases"] if c["source"] == "contract")
    assert contract["request"]["headers"]["Authorization"] == "Bearer {{token}}"
    assert any(line.startswith("Planned") for line in plan["progress"])


def test_ai_disabled_still_builds_contract_plan(client, spec_id):
    plan = create(client, spec_id)
    assert plan["status"] == "ready"
    assert plan["ai_status"] == "disabled"
    assert all(c["source"] == "contract" for c in plan["cases"])


def test_refine_appends_cases(client, spec_id, ai_on, monkeypatch):
    plan = create(client, spec_id, review_pass=False)
    before = len(plan["cases"])

    def more(context, brief):
        assert "<refine>add a unicode name case</refine>" in brief
        return ai.AiPlan(cases=[ai.AiCase(endpoint_id=REGISTER, name="Unicode name is stored", category="robustness", rationale="r",
                                          setup=[], request=req(body='{"name": "Zoë", "email": "u.{{unique}}@x.io", "password": "Str0ngPass!"}'),
                                          expected_status=[201])])

    monkeypatch.setattr(ai, "plan_endpoint", more)
    res = client.post(f"/api/plans/{plan['id']}/refine", json={"instruction": "add a unicode name case", "endpoint_ids": [REGISTER]})
    assert res.status_code == 202
    refined = wait_ready(client, plan["id"])
    assert len(refined["cases"]) == before + 1
    assert any(c["name"] == "Unicode name is stored" for c in refined["cases"])


def test_case_crud_and_validation(client, spec_id):
    plan = create(client, spec_id)
    pid = plan["id"]
    good = {"endpoint_id": REGISTER, "name": "Manual case", "category": "business",
            "request": {"method": "post", "path": "/api/users/register", "body": {"email": "m@x.io", "password": "p"}},
            "expected_status": [422, 400]}
    res = client.post(f"/api/plans/{pid}/cases", json=good)
    assert res.status_code == 200
    added = next(c for c in res.json()["cases"] if c["name"] == "Manual case")
    assert added["expected_status"] == [400, 422] and added["source"] == "contract"

    assert client.post(f"/api/plans/{pid}/cases", json={**good, "expected_status": [500]}).status_code == 422
    assert client.post(f"/api/plans/{pid}/cases", json={**good, "endpoint_id": "GET /nope"}).status_code == 422

    res = client.patch(f"/api/plans/{pid}/cases/{added['id']}", json={"expected_status": [409]})
    assert next(c for c in res.json()["cases"] if c["id"] == added["id"])["expected_status"] == [409]

    res = client.delete(f"/api/plans/{pid}/cases/{added['id']}")
    assert all(c["id"] != added["id"] for c in res.json()["cases"])


def test_edits_blocked_while_planning(client, spec_id):
    plan = create(client, spec_id)
    stored = store.load("plans", plan["id"], planner.TestPlan)
    stored.status = "planning"
    planner.save(stored)
    case_id = plan["cases"][0]["id"]
    assert client.delete(f"/api/plans/{plan['id']}/cases/{case_id}").status_code == 409
    assert client.post(f"/api/plans/{plan['id']}/runs", json={}).status_code == 409


def test_refine_requires_ai(client, spec_id):
    plan = create(client, spec_id)
    res = client.post(f"/api/plans/{plan['id']}/refine", json={"instruction": "more"})
    assert res.status_code == 422
