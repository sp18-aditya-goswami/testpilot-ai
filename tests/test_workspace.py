import json
import os
import stat
import time

import httpx
import pytest
from fastapi.testclient import TestClient

import backend.api.workspace as workspace_api
import backend.runner as runner
from backend.config import get_settings, overrides_path
from backend.main import app
from demo_api.main import app as demo_app

SECRET = "s3cr3t-value-9f2c"


@pytest.fixture
def client(demo_client, monkeypatch):
    """Backend client whose outbound HTTP is routed to the in-process demo API (its DB set up by demo_client)."""

    def factory(**kwargs):
        kwargs.pop("limits", None)
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=demo_app), **kwargs)

    monkeypatch.setattr(workspace_api, "make_client", factory)
    monkeypatch.setattr(runner, "make_client", factory)
    with TestClient(app) as c:
        yield c


def _project(c, name="Users"):
    r = c.post("/api/projects", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _env(c, project_id, variables=None):
    r = c.post(
        f"/api/projects/{project_id}/environments",
        json={"name": "Local", "base_url": "http://localhost/", "variables": variables or []},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _wait_run(c, run_id, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = c.get(f"/api/runs/{run_id}").json()
        if run["status"] in ("completed", "failed"):
            return run
        time.sleep(0.05)
    raise AssertionError("run did not finish")


def test_tree_nesting_ordering_and_cycles(client):
    pid = _project(client)
    col = client.post(f"/api/projects/{pid}/collections", json={"name": "Smoke"}).json()
    a = client.post(f"/api/collections/{col['id']}/folders", json={"name": "A"}).json()
    b = client.post(f"/api/collections/{col['id']}/folders", json={"name": "B", "parent_id": a["id"]}).json()
    r1 = client.post(f"/api/collections/{col['id']}/items", json={"kind": "request", "name": "first", "folder_id": b["id"]}).json()
    client.post(f"/api/collections/{col['id']}/items", json={"kind": "request", "name": "second", "folder_id": b["id"]})
    client.post(f"/api/collections/{col['id']}/items", json={"kind": "suite", "name": "plan", "folder_id": None})

    tree = client.get(f"/api/projects/{pid}/tree").json()
    node = tree["collections"][0]
    assert node["items"][0]["kind"] == "suite"
    inner = node["folders"][0]["folders"][0]
    assert [i["name"] for i in inner["items"]] == ["first", "second"]
    assert inner["items"][0]["method"] == "GET"

    moved = client.post(f"/api/items/{r1['id']}/move", json={"collection_id": col["id"], "folder_id": b["id"], "position": 1}).json()
    assert moved["position"] == 1
    dup = client.post(f"/api/items/{r1['id']}/duplicate").json()
    assert dup["name"] == "first copy"

    cycle = client.patch(f"/api/folders/{a['id']}", json={"parent_id": b["id"]})
    assert cycle.status_code == 422
    to_root = client.patch(f"/api/folders/{b['id']}", json={"parent_id": None})
    assert to_root.status_code == 200 and to_root.json()["parent_id"] is None

    assert client.get("/api/items/itm_0000000000").status_code == 404


def test_environment_secrets_are_masked_and_kept(client):
    pid = _project(client)
    env = _env(client, pid, [{"key": "token", "value": SECRET, "secret": True}, {"key": "user", "value": "ada", "secret": False}])
    assert env["is_default"] and env["base_url"] == "http://localhost" and env["base_url_allowed"]
    token = next(v for v in env["variables"] if v["key"] == "token")
    assert token == {"key": "token", "value": "", "secret": True, "has_value": True}

    patched = client.patch(
        f"/api/environments/{env['id']}",
        json={"variables": [{"key": "token", "value": None, "secret": True}, {"key": "user", "value": "grace", "secret": False}]},
    ).json()
    assert next(v for v in patched["variables"] if v["key"] == "token")["has_value"]
    from backend.workspace_repo import environment_runtime

    rt = environment_runtime(env["id"])
    assert rt.variables["token"] == SECRET and rt.variables["user"] == "grace" and SECRET in rt.secret_values
    assert SECRET not in json.dumps(client.get(f"/api/projects/{pid}/tree").json())

    bad = client.post(f"/api/projects/{pid}/environments", json={"name": "x", "base_url": "ftp://nope"})
    assert bad.status_code == 422


def test_send_substitutes_variables_and_redacts_secrets(client):
    pid = _project(client)
    env = _env(client, pid, [{"key": "token", "value": SECRET, "secret": True}])
    body = json.dumps({"name": "{{token}}", "email": "u.{{unique}}@example.com", "password": "Str0ngPass!42"})
    result = client.post(
        "/api/requests/send",
        json={
            "environment_id": env["id"],
            "request": {
                "method": "POST",
                "path": "/api/users/register",
                "headers": [{"key": "Authorization", "value": "Bearer {{token}}", "enabled": True}],
                "body_mode": "json",
                "body": body,
                "assertions": {"expected_status": [201], "json_schema": {"type": "object", "required": ["id"]}},
            },
        },
    )
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["outcome"] == "passed" and data["exchange"]["status"] == 201
    assert data["response_size_bytes"] > 0
    assert SECRET not in json.dumps(data)
    assert data["exchange"]["response_body"]["name"] == "••••"
    assert data["exchange"]["request_headers"]["Authorization"] == "Bearer ••••"

    invalid = client.post(
        "/api/requests/send",
        json={"environment_id": env["id"], "request": {"method": "POST", "path": "/x", "body_mode": "json", "body": "{nope"}},
    )
    assert invalid.status_code == 422 and invalid.json()["detail"] == "Body is not valid JSON"

    missing = client.post("/api/requests/send", json={"environment_id": env["id"], "request": {"path": "/api/users/{{nope}}"}}).json()
    assert missing["outcome"] == "error" and "nope" in missing["exchange"]["error"]


def test_import_and_collection_run(client, demo_doc):
    pid = _project(client)
    env = _env(client, pid)
    spec = client.post("/api/specs/inspect", json={"spec_text": json.dumps(demo_doc), "project_id": pid}).json()["api"]
    assert client.get(f"/api/projects/{pid}/specs").json()[0]["spec_id"] == spec["spec_id"]

    col = client.post(f"/api/projects/{pid}/import", json={"spec_id": spec["spec_id"]})
    assert col.status_code == 201, col.text
    col = col.json()
    folder_names = {f["name"] for f in col["folders"]}
    assert {"users", "meta"} <= folder_names
    users = next(f for f in col["folders"] if f["name"] == "users")
    by_name = {i["name"]: i for i in users["items"]}
    register = client.get(f"/api/items/{by_name['Register a new user']['id']}").json()["request"]
    assert register["body_mode"] == "json" and register["assertions"]["expected_status"] == [201]
    get_user = client.get(f"/api/items/{by_name['Retrieve a user by id']['id']}").json()["request"]
    assert get_user["path"] == "/api/users/{{user_id}}"
    env_vars = {v["key"]: v for v in client.get(f"/api/projects/{pid}/tree").json()["environments"][0]["variables"]}
    assert env_vars["user_id"]["value"] == "1" and not env_vars["user_id"]["secret"]

    smoke = client.post(f"/api/projects/{pid}/collections", json={"name": "Smoke"}).json()
    client.post(
        f"/api/collections/{smoke['id']}/items",
        json={"kind": "request", "name": "List users", "request": {"method": "GET", "path": "/api/users", "assertions": {"expected_status": [200], "max_ms": 5000}}},
    )
    client.post(
        f"/api/collections/{smoke['id']}/items",
        json={"kind": "request", "name": "Missing user", "request": {"method": "GET", "path": "/api/users/987654", "assertions": {"expected_status": [404]}}},
    )
    started = client.post(f"/api/collections/{smoke['id']}/run", json={"environment_id": env["id"]})
    assert started.status_code == 202, started.text
    run = _wait_run(client, started.json()["id"])
    assert run["status"] == "completed" and run["source_kind"] == "collection" and run["environment_name"] == "Local"
    outcomes = {r["case_id"]: r["outcome"] for r in run["results"]}
    names = {c["id"]: c["name"] for c in run["cases"]}
    assert {names[k]: v for k, v in outcomes.items()} == {"List users": "passed", "Missing user": "failed"}
    assert all(c["source"] == "saved" for c in run["cases"])
    listed = client.get(f"/api/projects/{pid}/runs").json()
    assert listed[0]["id"] == run["id"] and listed[0]["source_name"] == "Smoke"

    empty = client.post(f"/api/projects/{pid}/collections", json={"name": "Empty"}).json()
    assert client.post(f"/api/collections/{empty['id']}/run", json={"environment_id": env["id"]}).status_code == 422


def test_project_delete_cascades(client, demo_doc):
    pid = _project(client, "Doomed")
    _env(client, pid)
    col = client.post(f"/api/projects/{pid}/collections", json={"name": "C"}).json()
    client.post(f"/api/collections/{col['id']}/folders", json={"name": "F"})
    spec = client.post("/api/specs/inspect", json={"spec_text": json.dumps(demo_doc), "project_id": pid}).json()["api"]

    assert client.delete(f"/api/projects/{pid}").json() == {"ok": True}
    assert client.get(f"/api/projects/{pid}/tree").status_code == 404
    assert client.get(f"/api/specs/{spec['spec_id']}").status_code == 404
    assert client.get(f"/api/collections/{col['id']}").status_code in (404, 405)


def test_settings_store_key_privately(client):
    path = overrides_path(get_settings().data_dir)
    try:
        r = client.put("/api/settings", json={"anthropic_api_key": "sk-ant-api03-abcdefghijklmnop1234", "effort": "high"})
        assert r.status_code == 200, r.text
        ai = r.json()["ai"]
        assert ai["provider"] == "anthropic" and ai["configured"] and ai["anthropic"]["key_source"] == "app" and ai["effort"] == "high"
        assert ai["anthropic"]["key_hint"] == "sk-ant-…1234"
        assert "abcdefghijklmnop" not in r.text
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert client.get("/api/health").json()["ai_enabled"] is True

        assert client.put("/api/settings", json={"allowed_hosts": []}).status_code == 422
        assert client.put("/api/settings", json={"allowed_hosts": ["bad host!"]}).status_code == 422
    finally:
        cleared = client.put("/api/settings", json={"anthropic_api_key": "", "effort": "medium"}).json()
    assert cleared["ai"]["configured"] is False and cleared["ai"]["anthropic"]["key_hint"] is None
    assert client.post("/api/settings/check-ai").json()["ok"] is False
