import copy
import json
from typing import Any
from urllib.parse import urlparse

import httpx
import yaml

from backend.config import get_settings
from backend.schemas import ApiSummary, Endpoint, Parameter, new_id

HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")


class SpecError(ValueError):
    pass


def ensure_allowed_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise SpecError(f"Not an http(s) URL: {url}")
    allowed = get_settings().allowed_host_set
    if parsed.hostname.lower() not in allowed:
        raise SpecError(
            f"Host '{parsed.hostname}' is not in the allowlist ({', '.join(sorted(allowed))}). "
            "Add it to TESTPILOT_ALLOWED_HOSTS only if it is a local or staging environment."
        )


def load_spec_text(text: str) -> dict[str, Any]:
    text = text.strip()
    if not text:
        raise SpecError("Specification is empty")
    try:
        doc = json.loads(text) if text[0] in "{[" else yaml.safe_load(text)
    except (json.JSONDecodeError, yaml.YAMLError) as exc:
        raise SpecError(f"Could not parse specification: {exc}") from exc
    if not isinstance(doc, dict) or not ("openapi" in doc or "swagger" in doc):
        raise SpecError("Document has no 'openapi' or 'swagger' version field")
    return doc


def fetch_spec(url: str) -> dict[str, Any]:
    ensure_allowed_url(url)
    try:
        resp = httpx.get(url, timeout=get_settings().request_timeout_s, follow_redirects=False)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise SpecError(f"Could not fetch specification: {exc}") from exc
    return load_spec_text(resp.text)


def _resolve(node: Any, root: dict[str, Any], seen: frozenset[str] = frozenset()) -> Any:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            if ref in seen:
                return {"description": f"recursive reference {ref}"}
            target: Any = root
            for part in ref[2:].split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                if not isinstance(target, dict) or part not in target:
                    raise SpecError(f"Unresolvable reference {ref}")
                target = target[part]
            siblings = {k: v for k, v in node.items() if k != "$ref"}
            resolved = _resolve(copy.deepcopy(target), root, seen | {ref})
            return {**resolved, **siblings} if isinstance(resolved, dict) else resolved
        return {k: _resolve(v, root, seen) for k, v in node.items()}
    if isinstance(node, list):
        return [_resolve(v, root, seen) for v in node]
    return node


def _json_schema_from_content(content: dict[str, Any] | None) -> dict[str, Any] | None:
    if not content:
        return None
    for media, body in content.items():
        if "json" in media:
            return body.get("schema") or {}
    first = next(iter(content.values()), {})
    return first.get("schema")


def parse_spec(doc: dict[str, Any]) -> ApiSummary:
    root = _resolve(doc, doc)
    is_swagger2 = "swagger" in root
    info = root.get("info", {})
    global_security = bool(root.get("security"))

    server_url = None
    if is_swagger2 and root.get("host"):
        scheme = (root.get("schemes") or ["http"])[0]
        server_url = f"{scheme}://{root['host']}{root.get('basePath', '')}"
    elif root.get("servers"):
        server_url = root["servers"][0].get("url")

    endpoints: list[Endpoint] = []
    for path, item in (root.get("paths") or {}).items():
        shared_params = item.get("parameters", [])
        for method in HTTP_METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue

            params: list[Parameter] = []
            body_schema: dict[str, Any] | None = None
            body_required = False
            for p in [*shared_params, *op.get("parameters", [])]:
                if p.get("in") == "body":
                    body_schema = p.get("schema") or {}
                    body_required = bool(p.get("required"))
                    continue
                if p.get("in") == "formData":
                    continue
                schema = p.get("schema") or {k: p[k] for k in ("type", "format", "enum") if k in p}
                params.append(
                    Parameter(
                        name=p["name"],
                        location=p["in"],
                        required=bool(p.get("required")) or p["in"] == "path",
                        schema=schema,
                        description=p.get("description", ""),
                    )
                )

            if "requestBody" in op:
                body_schema = _json_schema_from_content(op["requestBody"].get("content"))
                body_required = bool(op["requestBody"].get("required"))

            responses: dict[str, dict[str, Any] | None] = {}
            for code, resp in (op.get("responses") or {}).items():
                schema = resp.get("schema") if is_swagger2 else _json_schema_from_content(resp.get("content"))
                responses[str(code)] = schema

            endpoints.append(
                Endpoint(
                    id=f"{method.upper()} {path}",
                    method=method.upper(),
                    path=path,
                    summary=op.get("summary", ""),
                    description=op.get("description", ""),
                    tags=op.get("tags", []),
                    parameters=params,
                    request_body_schema=body_schema,
                    request_body_required=body_required,
                    responses=responses,
                    requires_auth=bool(op["security"]) if "security" in op else global_security,
                )
            )

    if not endpoints:
        raise SpecError("Specification defines no operations")

    return ApiSummary(
        spec_id=new_id("spec"),
        title=info.get("title", "Untitled API"),
        version=str(info.get("version", "")),
        description=info.get("description", ""),
        openapi_version=str(root.get("openapi") or root.get("swagger")),
        server_url=server_url,
        endpoints=endpoints,
    )
