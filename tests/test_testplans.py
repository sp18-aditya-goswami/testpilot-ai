import json

from tests.test_navigation import _wait_plan
from tests.test_workspace import SECRET, _wait_run, client  # noqa: F401  (client is a fixture)

BASE = "http://localhost:8008"


def test_guided_flow_end_to_end(client, demo_doc):  # noqa: F811
    started = client.post("/api/test-plans/start", json={"spec_text": json.dumps(demo_doc), "base_url": BASE + "/", "token": SECRET})
    assert started.status_code == 200, started.text
    s = started.json()
    assert s["api"]["endpoints"] and s["has_token"] is True
    assert s["environment_name"] == "Default"

    env = next(e for e in client.get(f"/api/projects/{s['project_id']}/tree").json()["environments"] if e["id"] == s["environment_id"])
    assert env["base_url"] == BASE
    token = next(v for v in env["variables"] if v["key"] == "token")
    assert token["secret"] and token["value"] == "" and token["has_value"]
    assert any(v["key"] == "user_id" for v in env["variables"])  # path variables added

    again = client.post("/api/test-plans/start", json={"spec_text": json.dumps(demo_doc), "base_url": BASE}).json()
    assert (again["project_id"], again["environment_id"]) == (s["project_id"], s["environment_id"])  # reused, token kept
    assert again["has_token"] is True

    created = client.post(
        "/api/test-plans",
        json={
            "project_id": s["project_id"],
            "environment_id": s["environment_id"],
            "spec_id": s["api"]["spec_id"],
            "config": {"use_ai": False, "focus_endpoints": ["GET /api/users"]},
        },
    )
    assert created.status_code == 202, created.text
    out = created.json()
    plan = _wait_plan(client, out["plan"]["id"])
    assert plan["status"] == "ready" and plan["suite_item_id"] == out["suite_item_id"]

    tree = client.get(f"/api/projects/{s['project_id']}/tree").json()
    col = next(c for c in tree["collections"] if c["name"] == "Test plans")
    assert [i["id"] for i in col["items"]] == [out["suite_item_id"]]
    item = client.get(f"/api/items/{out['suite_item_id']}").json()
    assert item["name"].endswith("test plan") and item["suite"]["last_plan_id"] == plan["id"]

    run = client.post(f"/api/plans/{plan['id']}/runs", json={}).json()
    _wait_run(client, run["id"])
    assert client.get(f"/api/items/{out['suite_item_id']}").json()["suite"]["last_run_id"] == run["id"]

    rows = client.get("/api/test-plans").json()
    row = next(r for r in rows if r["suite_item_id"] == out["suite_item_id"])
    assert row["last_plan_id"] == plan["id"] and row["case_count"] == len(plan["cases"]) and row["ai_case_count"] == 0
    assert row["last_run"]["id"] == run["id"] and row["spec_title"] == s["api"]["title"]


def test_guided_flow_rejects_bad_input(client, demo_doc):  # noqa: F811
    blocked = client.post("/api/test-plans/start", json={"spec_text": json.dumps(demo_doc), "base_url": "https://example.org"})
    assert blocked.status_code == 422 and "allowed hosts" in blocked.json()["detail"]
    assert client.post("/api/test-plans/start", json={"base_url": BASE}).status_code == 422
    bad = client.post("/api/test-plans/start", json={"spec_text": "not a spec", "base_url": BASE})
    assert bad.status_code == 422
    missing = client.post("/api/test-plans", json={"project_id": "prj_0000000000", "environment_id": "env_0", "spec_id": "x"})
    assert missing.status_code == 404
