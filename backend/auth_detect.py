"""Reads a spec's auth story so a test plan can get its own token, the way a Postman pre-request script would.

Four outcomes:
  none         no endpoint needs auth, so nothing is asked
  auto         a sign-up and a sign-in endpoint exist: each run registers a fresh test user and signs in
  credentials  a sign-in endpoint exists but no sign-up: the user gives a test login once
  token        auth is needed and the spec has no way to get a token: the user gives a token
"""

import re
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel

from backend.engines.examples import UNIQUE, example_for, primary_schema
from backend.schemas import ApiSummary, Endpoint
from backend.workspace_schemas import AuthStep, LoginFlow

AuthMode = Literal["none", "auto", "credentials", "token"]

TOKEN_KEYS = ("access_token", "accessToken", "token", "jwt", "id_token", "idToken", "auth_token", "authToken", "api_key", "apiKey")
ID_FIELDS = ("email", "username", "user_name", "userName", "login", "user", "phone", "mobile")
PASSWORD = re.compile(r"pass(word)?|pwd", re.I)
LOGIN_WORDS = {"login", "signin", "sign-in", "sign_in", "token", "tokens", "authenticate", "session", "sessions", "access-token", "access_token"}
REGISTER_WORDS = {"register", "signup", "sign-up", "sign_up", "registration"}
ACCOUNT_COLLECTIONS = {"users", "user", "accounts", "account"}
NOT_SIGN_IN = {"refresh", "logout", "signout", "sign-out", "revoke", "reset", "forgot", "verify", "confirm", "introspect"}

USERNAME_VAR = "auth_username"
PASSWORD_VAR = "auth_password"
TEST_EMAIL = f"testpilot.{UNIQUE}@example.com"
TEST_USERNAME = f"testpilot_{UNIQUE}"
TEST_PASSWORD = f"Tp-{UNIQUE}-Pass1!"


class AuthDetection(BaseModel):
    mode: AuthMode
    message: str
    header_name: str = "Authorization"
    scheme: str = "Bearer"
    login_endpoint: str | None = None
    register_endpoint: str | None = None
    username_label: str = "Username"
    flow: LoginFlow | None = None


def _segments(path: str) -> list[str]:
    return [p.lower() for p in path.strip("/").split("/") if p and not p.startswith("{")]


def _fields(ep: Endpoint) -> dict[str, Any]:
    schema = primary_schema(ep.request_body_schema)
    if "allOf" in schema:
        merged: dict[str, Any] = {}
        for part in schema["allOf"]:
            merged.update(part.get("properties", {}))
        return merged
    return schema.get("properties") or {}


def _password_fields(fields: dict[str, Any]) -> list[str]:
    return [k for k in fields if PASSWORD.search(k)]


def _identifier(fields: dict[str, Any], required: list[str]) -> str | None:
    lowered = {k.lower(): k for k in fields}
    for name in ID_FIELDS:
        if name.lower() in lowered:
            return lowered[name.lower()]
    for k in required:
        sub = primary_schema(fields.get(k))
        if not PASSWORD.search(k) and sub.get("type", "string") == "string":
            return k
    return None


def _required(ep: Endpoint) -> list[str]:
    return list(primary_schema(ep.request_body_schema).get("required") or [])


def _is_email(name: str, schema: dict[str, Any] | None) -> bool:
    return "email" in name.lower() or primary_schema(schema).get("format") == "email"


def _scheme(api: ApiSummary) -> tuple[str, str, list[str]]:
    """Header name, scheme word, and OAuth2 token URL paths, from the first usable security scheme."""
    token_paths: list[str] = []
    header, scheme = "Authorization", "Bearer"
    chosen = False
    for definition in api.security_schemes.values():
        kind = str(definition.get("type", "")).lower()
        for flow in (definition.get("flows") or {}).values():
            if isinstance(flow, dict) and flow.get("tokenUrl"):
                token_paths.append(urlparse(str(flow["tokenUrl"])).path.strip("/").lower())
        if kind == "oauth2" and definition.get("tokenUrl"):  # Swagger 2
            token_paths.append(urlparse(str(definition["tokenUrl"])).path.strip("/").lower())
        if chosen:
            continue
        if kind == "apikey" and definition.get("in") == "header" and definition.get("name"):
            header, scheme, chosen = str(definition["name"]), "", True
        elif kind == "http" and str(definition.get("scheme", "")).lower() == "basic":
            header, scheme, chosen = "Authorization", "Basic", True
        elif kind in ("http", "oauth2", "openidconnect"):
            header, scheme, chosen = "Authorization", "Bearer", True
    return header, scheme, token_paths


def _login_score(ep: Endpoint, token_paths: list[str]) -> int:
    if ep.method != "POST" or "{" in ep.path:
        return 0
    segs = _segments(ep.path)
    if not segs or NOT_SIGN_IN & set(segs) or REGISTER_WORDS & set(segs):
        return 0
    joined = "/".join(segs)
    fields = _fields(ep)
    if any(joined.endswith(t) for t in token_paths if t):
        return 3
    if segs[-1] in LOGIN_WORDS and _password_fields(fields) and _identifier(fields, _required(ep)):
        return 2 if not ep.requires_auth else 1
    return 0


def _register_score(ep: Endpoint) -> int:
    if ep.method != "POST" or "{" in ep.path:
        return 0
    segs = _segments(ep.path)
    fields = _fields(ep)
    if not segs or not _password_fields(fields) or not _identifier(fields, _required(ep)):
        return 0
    if segs[-1] in REGISTER_WORDS:
        return 2 if not ep.requires_auth else 1
    if segs[-1] in ACCOUNT_COLLECTIONS and not ep.requires_auth:
        return 1
    return 0


def _best(endpoints: list[Endpoint], score) -> Endpoint | None:
    ranked = sorted(((score(ep), i, ep) for i, ep in enumerate(endpoints)), key=lambda t: (-t[0], t[1]))
    return ranked[0][2] if ranked and ranked[0][0] > 0 else None


def _token_field(ep: Endpoint) -> str:
    """The dotted path of the token in the sign-in response, when the spec documents it."""
    for code, schema in sorted(ep.responses.items()):
        if not code.startswith("2") or not schema:
            continue
        found = _find_key(primary_schema(schema), "")
        if found:
            return found
    return ""


def _find_key(schema: dict[str, Any], prefix: str, depth: int = 0) -> str:
    props = schema.get("properties") or {}
    for key in TOKEN_KEYS:
        if key in props:
            return prefix + key
    if depth < 2:
        for name, sub in props.items():
            found = _find_key(primary_schema(sub), f"{prefix}{name}.", depth + 1)
            if found:
                return found
    return ""


def _step(ep: Endpoint, values: dict[str, Any], full: bool = False) -> AuthStep:
    """A sign-up sends every documented field (business rules often need more than the schema requires); a sign-in only what it needs."""
    form = "x-www-form-urlencoded" in (ep.request_body_media or "") or "form-data" in (ep.request_body_media or "")
    fields = _fields(ep)
    required = set(_required(ep))
    example = example_for(ep.request_body_schema) if ep.request_body_schema else {}
    body: dict[str, Any] = {}
    if isinstance(example, dict):
        body = {k: v for k, v in example.items() if full or k in required or k in values or (form and k == "grant_type")}
        if full:  # an empty default is rarely a valid sign-up value
            body = {k: ("TestPilot User" if "name" in k.lower() else "sample") if v == "" else v for k, v in body.items()}
    body.update({k: v for k, v in values.items() if k in fields or not fields})
    return AuthStep(endpoint_id=ep.id, method=ep.method, path=ep.path, body=body, form=form)


def _credentials(ep: Endpoint, username: Any, password: Any) -> dict[str, Any]:
    fields = _fields(ep)
    values: dict[str, Any] = {}
    ident = _identifier(fields, _required(ep))
    if ident:
        values[ident] = username
    for name in _password_fields(fields):
        values[name] = password
    return values


def detect(api: ApiSummary) -> AuthDetection:
    header, scheme, token_paths = _scheme(api)
    protected = [ep for ep in api.endpoints if ep.requires_auth]
    if not protected:
        return AuthDetection(mode="none", message="", header_name=header, scheme=scheme)

    login = _best(api.endpoints, lambda ep: _login_score(ep, token_paths))
    if login is None or scheme == "Basic":
        what = "an API key" if scheme == "" else "a token"
        return AuthDetection(
            mode="token",
            header_name=header,
            scheme=scheme,
            message=(
                f"{len(protected)} of {len(api.endpoints)} endpoints need {what}, and the spec has no sign-in endpoint "
                f"to get one. Paste a valid {what} for the test server."
            ),
        )

    login_fields = _fields(login)
    ident = _identifier(login_fields, _required(login))
    register = _best([ep for ep in api.endpoints if ep.id != login.id], _register_score)
    token_field = _token_field(login)

    if register is not None:
        reg_fields = _fields(register)
        reg_ident = _identifier(reg_fields, _required(register))
        email_login = _is_email(ident or "", login_fields.get(ident or ""))
        email_reg = _is_email(reg_ident or "", reg_fields.get(reg_ident or ""))
        username = TEST_EMAIL if (email_login or email_reg) else TEST_USERNAME
        flow = LoginFlow(
            signup=_step(register, _credentials(register, username, TEST_PASSWORD), full=True),
            login=_step(login, _credentials(login, username, TEST_PASSWORD)),
            token_field=token_field,
        )
        return AuthDetection(
            mode="auto",
            header_name=header,
            scheme=scheme,
            login_endpoint=login.id,
            register_endpoint=register.id,
            flow=flow,
            message=(
                f"This API needs a login. At the start of each run TestPilot registers a fresh test user with {register.id} "
                f"and signs in with {login.id}. Nothing to enter."
            ),
        )

    label = "Email" if _is_email(ident or "", login_fields.get(ident or "")) else (ident or "username").replace("_", " ").capitalize()
    flow = LoginFlow(login=_step(login, _credentials(login, f"{{{{{USERNAME_VAR}}}}}", f"{{{{{PASSWORD_VAR}}}}}")), token_field=token_field)
    return AuthDetection(
        mode="credentials",
        header_name=header,
        scheme=scheme,
        login_endpoint=login.id,
        username_label=label,
        flow=flow,
        message=(
            f"This API needs a login and has no sign-up endpoint. Give TestPilot a test account: "
            f"each run signs in with {login.id} and uses the token it gets back."
        ),
    )


def find_token(body: Any, token_field: str = "") -> str | None:
    """The token in a sign-in response: the documented field first, then any well-known token key."""
    if token_field and isinstance(body, dict):
        value: Any = body
        for part in token_field.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        if isinstance(value, str) and value:
            return value
    if isinstance(body, str):
        text = body.strip().strip('"')
        return text if len(text) >= 8 and " " not in text and not text.startswith("<") else None
    queue: list[tuple[Any, int]] = [(body, 0)]
    while queue:
        node, depth = queue.pop(0)
        if not isinstance(node, dict):
            continue
        for key in TOKEN_KEYS:
            if isinstance(node.get(key), str) and node[key]:
                return node[key]
        if depth < 3:
            queue += [(v, depth + 1) for v in node.values() if isinstance(v, dict)]
    return None
