import json
import time

from tests.test_workspace import _env, _project, _wait_run, client  # noqa: F401  (client is a fixture)


def _wait_plan(c, plan_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        plan = c.get(f"/api/plans/{plan_id}").json()
        if plan["status"] != "planning":
            return plan
        time.sleep(0.05)
    raise AssertionError("plan did not finish")


def test_spec_usage_and_suite_history(client, demo_doc):  # noqa: F811
    pid = _project(client, "Navigation")
    env = _env(client, pid)
    spec = client.post("/api/specs/inspect", json={"spec_text": json.dumps(demo_doc), "project_id": pid}).json()["api"]
    col = client.post(f"/api/projects/{pid}/collections", json={"name": "Suites"}).json()
    suite = client.post(
        f"/api/collections/{col['id']}/items",
        json={"kind": "suite", "name": "Users suite", "suite": {"spec_id": spec["spec_id"]}},
    ).json()
    other = client.post(f"/api/collections/{col['id']}/items", json={"kind": "suite", "name": "No spec yet", "suite": {}}).json()

    empty = client.get(f"/api/specs/{spec['spec_id']}/usage").json()
    assert [s["item_id"] for s in empty["suites"]] == [suite["id"]]
    assert empty["suites"][0]["collection_name"] == "Suites"
    assert empty["plans"] == [] and empty["runs"] == []

    created = client.post(
        "/api/plans",
        json={
            "project_id": pid,
            "spec_id": spec["spec_id"],
            "environment_id": env["id"],
            "suite_item_id": suite["id"],
            "config": {"use_ai": False, "focus_endpoints": ["GET /api/users"]},
        },
    )
    assert created.status_code in (200, 202), created.text
    plan = _wait_plan(client, created.json()["id"])
    assert plan["status"] == "ready" and plan["cases"]

    started = client.post(f"/api/plans/{plan['id']}/runs", json={})
    assert started.status_code == 202, started.text
    run = _wait_run(client, started.json()["id"])

    usage = client.get(f"/api/specs/{spec['spec_id']}/usage").json()
    assert [p["id"] for p in usage["plans"]] == [plan["id"]]
    assert usage["plans"][0]["case_count"] == len(plan["cases"]) and usage["plans"][0]["ai_case_count"] == 0
    assert [r["id"] for r in usage["runs"]] == [run["id"]]

    history = client.get(f"/api/items/{suite['id']}/history").json()
    assert [p["id"] for p in history["plans"]] == [plan["id"]]
    assert [r["id"] for r in history["runs"]] == [run["id"]]
    assert client.get(f"/api/items/{other['id']}/history").json() == {"plans": [], "runs": []}


def test_navigation_unknown_ids(client):  # noqa: F811
    assert client.get("/api/specs/spec_0000000000/usage").status_code == 404
    assert client.get("/api/items/itm_0000000000/history").status_code == 404
