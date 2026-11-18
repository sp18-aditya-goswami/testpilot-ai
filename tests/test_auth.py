import json

from backend.auth_detect import detect, find_token
from backend.spec_parser import parse_spec
from tests.test_navigation import _wait_plan
from tests.test_workspace import _wait_run, client  # noqa: F401  (client is a fixture)

BASE = "http://localhost:8008"


def _spec(paths, schemes=None, security=None):
    doc = {"openapi": "3.1.0", "info": {"title": "Shop", "version": "1"}, "paths": paths}
    if schemes:
        doc["components"] = {"securitySchemes": schemes}
    if security:
        doc["security"] = security
    return parse_spec(doc)


def _body(props, required=None, media="application/json"):
    return {"required": True, "content": {media: {"schema": {"type": "object", "properties": props, "required": required or list(props)}}}}


CREDS = {"username": {"type": "string"}, "password": {"type": "string"}}
OPEN = {"security": []}
LIST = {"get": {"responses": {"200": {"description": "ok"}}}}


def test_detects_each_auth_story():
    none = _spec({"/items": LIST})
    assert detect(none).mode == "none"

    token_only = _spec({"/items": LIST}, {"key": {"type": "apiKey", "in": "header", "name": "X-API-Key"}}, [{"key": []}])
    d = detect(token_only)
    assert d.mode == "token" and d.header_name == "X-API-Key" and d.scheme == "" and "API key" in d.message

    login_only = _spec(
        {
            "/items": LIST,
            "/auth/login": {"post": {**OPEN, "requestBody": _body(CREDS), "responses": {"200": {"content": {"application/json": {"schema": {"type": "object", "properties": {"data": {"type": "object", "properties": {"jwt": {"type": "string"}}}}}}}}}}},
            "/auth/refresh": {"post": {**OPEN, "requestBody": _body(CREDS), "responses": {"200": {"description": "ok"}}}},
        },
        {"bearer": {"type": "http", "scheme": "bearer"}},
        [{"bearer": []}],
    )
    d = detect(login_only)
    assert d.mode == "credentials" and d.login_endpoint == "POST /auth/login" and d.flow.signup is None
    assert d.flow.login.body == {"username": "{{auth_username}}", "password": "{{auth_password}}"}
    assert d.flow.token_field == "data.jwt" and d.username_label == "Username"

    oauth = _spec(
        {
            "/items": LIST,
            "/oauth/token": {"post": {**OPEN, "requestBody": _body({"grant_type": {"type": "string", "default": "password"}, **CREDS}, ["username", "password"], "application/x-www-form-urlencoded"), "responses": {"200": {"description": "ok"}}}},
            "/users": {"post": {**OPEN, "requestBody": _body({"email": {"type": "string", "format": "email"}, "password": {"type": "string"}, "name": {"type": "string"}}, ["email", "password"]), "responses": {"201": {"description": "ok"}}}},
        },
        {"oauth": {"type": "oauth2", "flows": {"password": {"tokenUrl": "/oauth/token", "scopes": {}}}}},
        [{"oauth": []}],
    )
    d = detect(oauth)
    assert d.mode == "auto" and d.login_endpoint == "POST /oauth/token" and d.register_endpoint == "POST /users"
    assert d.flow.login.form and d.flow.login.body["grant_type"] == "password"
    assert d.flow.login.body["username"] == d.flow.signup.body["email"] == "testpilot.{{unique}}@example.com"
    assert d.flow.signup.body["name"] == "Test User"


def test_find_token_in_common_shapes():
    assert find_token({"access_token": "abc12345"}) == "abc12345"
    assert find_token({"data": {"session": {"token": "tok-98765"}}}) == "tok-98765"
    assert find_token({"result": {"jwt": "x" * 20}}, "result.jwt") == "x" * 20
    assert find_token('"plain-token-123"') == "plain-token-123"
    assert find_token({"ok": True}) is None and find_token("<html>no</html>") is None


def test_plan_signs_up_and_signs_in_by_itself(client, demo_doc):  # noqa: F811
    started = client.post("/api/test-plans/start", json={"spec_text": json.dumps(demo_doc), "base_url": BASE}).json()
    access = started["access"]
    assert access["auth"]["mode"] == "auto" and not access["needs_input"]
    assert "POST /api/auth/login" in access["auth"]["message"]

    auth = access["auth"]
    config = {
        "use_ai": False,
        "focus_endpoints": ["GET /api/auth/me"],
        "auth": {"token_variable": "token", "header_name": auth["header_name"], "scheme": auth["scheme"], "login": auth["flow"]},
    }
    out = client.post("/api/test-plans", json={"project_id": started["project_id"], "environment_id": started["environment_id"], "spec_id": started["api"]["spec_id"], "config": config}).json()
    plan = _wait_plan(client, out["plan"]["id"])
    me = next(c for c in plan["cases"] if c["category"] == "positive")
    assert me["request"]["headers"]["Authorization"] == "Bearer {{token}}"

    run = client.post(f"/api/plans/{plan['id']}/runs", json={"case_ids": [me["id"]]}).json()
    run = _wait_run(client, run["id"])
    assert run["status"] == "completed", run["message"]
    assert "Signed in with POST /api/auth/login as a new test user" in run["auth_note"]
    assert [e["status"] for e in run["auth_exchanges"]] == [201, 200]
    result = run["results"][0]
    assert result["outcome"] == "passed" and result["exchange"]["status"] == 200
    assert result["exchange"]["request_headers"]["Authorization"] == "Bearer ••••"  # the run's token never reaches the report
    assert run["auth_exchanges"][1]["response_body"]["access_token"] == "••••"


def test_test_login_is_asked_for_and_a_bad_one_stops_the_run(client, demo_doc):  # noqa: F811
    started = client.post("/api/test-plans/start", json={"spec_text": json.dumps(demo_doc), "base_url": BASE}).json()
    spec_id, env_id = started["api"]["spec_id"], started["environment_id"]
    flow = {"login": {"endpoint_id": "POST /api/auth/login", "method": "POST", "path": "/api/auth/login", "body": {"email": "{{auth_username}}", "password": "{{auth_password}}"}}}

    half = client.post("/api/test-plans/access", json={"spec_id": spec_id, "environment_id": env_id, "username": "a@example.com"})
    assert half.status_code == 422
    saved = client.post("/api/test-plans/access", json={"spec_id": spec_id, "environment_id": env_id, "username": "nobody@example.com", "password": "wrong-pass-1"}).json()
    assert saved["has_login"] is True
    env = next(e for e in client.get(f"/api/projects/{started['project_id']}/tree").json()["environments"] if e["id"] == env_id)
    password = next(v for v in env["variables"] if v["key"] == "auth_password")
    assert password["secret"] and password["value"] == ""

    config = {"use_ai": False, "focus_endpoints": ["GET /api/auth/me"], "auth": {"token_variable": "token", "login": flow}}
    out = client.post("/api/test-plans", json={"project_id": started["project_id"], "environment_id": env_id, "spec_id": spec_id, "config": config}).json()
    plan = _wait_plan(client, out["plan"]["id"])
    run = _wait_run(client, client.post(f"/api/plans/{plan['id']}/runs", json={}).json()["id"])
    assert run["status"] == "failed" and run["results"] == []
    assert run["auth_note"].startswith("Sign-in failed: POST /api/auth/login returned 401")
    assert "wrong-pass-1" not in json.dumps(run)

    token = client.post("/api/test-plans/access", json={"spec_id": spec_id, "environment_id": env_id, "token": "manual-token-1"}).json()
    assert token["has_token"] is True
    status = client.get("/api/test-plans/access", params={"spec_id": spec_id, "environment_id": env_id}).json()
    assert status["auth"]["mode"] == "auto" and status["has_login"] and status["has_token"]


def test_login_only_shop_asks_for_a_login_and_signs_in_with_it(client, demo_client):  # noqa: F811
    doc = demo_client.get("/shop/openapi.json").json()
    started = client.post("/api/test-plans/start", json={"spec_text": json.dumps(doc), "base_url": BASE}).json()
    access = started["access"]
    assert access["auth"]["mode"] == "credentials" and access["needs_input"] and access["auth"]["username_label"] == "Username"
    spec_id, env_id = started["api"]["spec_id"], started["environment_id"]
    saved = client.post("/api/test-plans/access", json={"spec_id": spec_id, "environment_id": env_id, "username": "alice", "password": "alice-pass-1"}).json()
    assert saved["has_login"] and not saved["needs_input"]

    auth = access["auth"]
    config = {"use_ai": False, "focus_endpoints": ["GET /shop/orders"], "auth": {"token_variable": "token", "header_name": auth["header_name"], "scheme": auth["scheme"], "login": auth["flow"]}}
    out = client.post("/api/test-plans", json={"project_id": started["project_id"], "environment_id": env_id, "spec_id": spec_id, "config": config}).json()
    plan = _wait_plan(client, out["plan"]["id"])
    run = _wait_run(client, client.post(f"/api/plans/{plan['id']}/runs", json={}).json()["id"])
    assert run["status"] == "completed" and "your test account" in run["auth_note"]
    ok = next(r for r in run["results"] if next(c for c in run["cases"] if c["id"] == r["case_id"])["category"] == "positive")
    assert ok["outcome"] == "passed" and ok["exchange"]["status"] == 200
    assert "alice-pass-1" not in json.dumps(run)


def _two_user_plan(client, started, auth_config, focus):
    config = {"use_ai": False, "focus_endpoints": focus, "auth": auth_config}
    out = client.post("/api/test-plans", json={"project_id": started["project_id"], "environment_id": started["environment_id"], "spec_id": started["api"]["spec_id"], "config": config}).json()
    return _wait_plan(client, out["plan"]["id"])


def _outcome(run, name):
    case = next(c for c in run["cases"] if c["name"] == name)
    return next(r for r in run["results"] if r["case_id"] == case["id"])


def test_two_new_users_catch_one_changing_the_other(client, demo_doc):  # noqa: F811
    started = client.post("/api/test-plans/start", json={"spec_text": json.dumps(demo_doc), "base_url": BASE}).json()
    auth = started["access"]["auth"]
    plan = _two_user_plan(client, started, {"token_variable": "token", "login": auth["flow"], "second_user": True}, ["GET /api/auth/me"])
    as_a = {"Authorization": "Bearer {{token}}"}
    as_b = {"Authorization": "Bearer {{token_b}}"}
    for case in (
        {"endpoint_id": "GET /api/auth/me", "name": "User B is signed in", "category": "positive", "request": {"method": "GET", "path": "/api/auth/me", "headers": as_b}, "expected_status": [200]},
        {
            "endpoint_id": "PUT /api/users/{user_id}",
            "name": "User B cannot rename user A",
            "category": "security",
            "setup": [{"method": "GET", "path": "/api/auth/me", "headers": as_a}],
            "request": {"method": "PUT", "path": "/api/users/{user_id}", "path_params": {"user_id": "{{setup.0.body.id}}"}, "headers": as_b, "body": {"name": "Hijacked"}},
            "expected_status": [403, 404],
        },
    ):
        assert client.post(f"/api/plans/{plan['id']}/cases", json=case).status_code == 200, case["name"]
    run = _wait_run(client, client.post(f"/api/plans/{plan['id']}/runs", json={}).json()["id"])
    assert run["status"] == "completed", run["message"]
    assert run["auth_note"].startswith("Signed in two new test users, A and B")
    assert len(run["auth_exchanges"]) == 4  # sign-up and sign-in, twice
    me_a = _outcome(run, "User B is signed in")
    assert me_a["outcome"] == "passed"
    hijack = _outcome(run, "User B cannot rename user A")
    assert hijack["outcome"] == "failed" and hijack["exchange"]["status"] == 200  # the planted ownership bug
    assert hijack["exchange"]["request_headers"]["Authorization"] == "Bearer ••••"


def test_second_test_login_reads_another_users_order(client, demo_client):  # noqa: F811
    doc = demo_client.get("/shop/openapi.json").json()
    started = client.post("/api/test-plans/start", json={"spec_text": json.dumps(doc), "base_url": BASE}).json()
    spec_id, env_id = started["api"]["spec_id"], started["environment_id"]
    half = client.post("/api/test-plans/access", json={"spec_id": spec_id, "environment_id": env_id, "username_b": "bob"})
    assert half.status_code == 422
    saved = client.post(
        "/api/test-plans/access",
        json={"spec_id": spec_id, "environment_id": env_id, "username": "alice", "password": "alice-pass-1", "username_b": "bob", "password_b": "bob-pass-2"},
    ).json()
    assert saved["has_login"] and saved["has_second_login"]

    auth = started["access"]["auth"]
    plan = _two_user_plan(client, started, {"token_variable": "token", "login": auth["flow"], "second_user": True}, ["GET /shop/orders"])
    case = {
        "endpoint_id": "GET /shop/orders/{order_id}",
        "name": "Bob cannot read Alice's order",
        "category": "security",
        "setup": [{"method": "POST", "path": "/shop/orders", "headers": {"Authorization": "Bearer {{token}}"}, "body": {"item": "Lamp", "quantity": 1}}],
        "request": {"method": "GET", "path": "/shop/orders/{order_id}", "path_params": {"order_id": "{{setup.0.body.id}}"}, "headers": {"Authorization": "Bearer {{token_b}}"}},
        "expected_status": [404],
    }
    assert client.post(f"/api/plans/{plan['id']}/cases", json=case).status_code == 200
    run = _wait_run(client, client.post(f"/api/plans/{plan['id']}/runs", json={}).json()["id"])
    assert run["auth_note"].startswith("Signed in your two test logins, A and B")
    leak = _outcome(run, "Bob cannot read Alice's order")
    assert leak["outcome"] == "failed" and leak["exchange"]["response_body"]["owner"] == "alice"
    assert "bob-pass-2" not in json.dumps(run)


def test_planner_tells_the_ai_about_user_b():
    from backend.planner import build_context, plan_variable_keys
    from backend.workspace_schemas import PlannerConfig

    flow = {"login": {"endpoint_id": "POST /login", "method": "POST", "path": "/login", "body": {}}}
    config = PlannerConfig(auth={"token_variable": "token", "login": flow, "second_user": True})
    keys = plan_variable_keys({"base": "x"}, config)
    assert keys == ["base", "token", "token_b"]
    text = build_context([], config, keys)
    assert "user B" in text and "Bearer {{token_b}}" in text
    assert "user B" not in build_context([], PlannerConfig(auth={"token_variable": "token", "login": flow}), ["token"])
