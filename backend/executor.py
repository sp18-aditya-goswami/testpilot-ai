import json
import re
import time
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import httpx

from backend.schemas import Exchange, RequestSpec
from backend.spec_parser import SpecError, ensure_allowed_url

TEMPLATE = re.compile(r"\{\{\s*([\w.\-]+)\s*\}\}")
MAX_BODY_CHARS = 20_000
KEPT_RESPONSE_HEADERS = ("content-type", "location", "allow", "www-authenticate", "retry-after")
REDACTED = "••••"


def make_client(**kwargs) -> httpx.AsyncClient:
    """The one place HTTP clients are built, so tests can route them to an in-process app."""
    return httpx.AsyncClient(**kwargs)


def redact(value: Any, secrets: set[str]) -> Any:
    """Replaces every secret value inside strings, dict keys and values, and lists."""
    if not secrets:
        return value
    if isinstance(value, str):
        for secret in sorted(secrets, key=len, reverse=True):
            value = value.replace(secret, REDACTED)
        return value
    if isinstance(value, dict):
        return {redact(k, secrets): redact(v, secrets) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, secrets) for v in value]
    return value


class BudgetExceeded(RuntimeError):
    pass


class TemplateError(ValueError):
    pass


class CaseContext:
    """Per-case values that templates like {{unique}} and {{setup.0.body.id}} resolve against."""

    def __init__(self, variables: dict[str, str] | None = None) -> None:
        self.unique = uuid4().hex[:8]
        self.setup: list[dict[str, Any]] = []
        self.variables = variables or {}

    def lookup(self, expr: str) -> Any:
        if expr == "unique":
            return self.unique
        parts = expr.split(".")
        if parts[0] != "setup" or len(parts) < 3 or not parts[1].isdigit():
            if expr in self.variables:
                return self.variables[expr]
            raise TemplateError(f"Unknown variable '{{{{{expr}}}}}'. Define it in the environment.")
        index = int(parts[1])
        if index >= len(self.setup):
            raise TemplateError(f"Template refers to setup step {index}, which did not run")
        value: Any = self.setup[index]
        for part in parts[2:]:
            if isinstance(value, dict) and part in value:
                value = value[part]
            elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
                value = value[int(part)]
            else:
                raise TemplateError(f"Setup step {index} response has no '{'.'.join(parts[2:])}'")
        return value

    def render(self, value: Any) -> Any:
        if isinstance(value, str):
            whole = TEMPLATE.fullmatch(value.strip())
            if whole:
                return self.lookup(whole.group(1))
            return TEMPLATE.sub(lambda m: str(self.lookup(m.group(1))), value)
        if isinstance(value, dict):
            return {k: self.render(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.render(v) for v in value]
        return value


def _truncate(body: Any) -> Any:
    text = body if isinstance(body, str) else json.dumps(body, default=str)
    if len(text) <= MAX_BODY_CHARS:
        return body
    return text[:MAX_BODY_CHARS] + f"... [truncated {len(text) - MAX_BODY_CHARS} chars]"


class Executor:
    def __init__(self, client: httpx.AsyncClient, base_url: str, max_requests: int, secrets: set[str] | None = None):
        self.client = client
        self.base_url = base_url.rstrip("/")
        self.max_requests = max_requests
        self.sent = 0
        self.secrets = {s for s in (secrets or set()) if s}

    def build_url(self, spec: RequestSpec, ctx: CaseContext) -> str:
        path = str(ctx.render(spec.path))
        for name, value in ctx.render(spec.path_params).items():
            path = path.replace(f"{{{name}}}", quote(str(value), safe=""))
        if path.startswith(("http://", "https://")):
            ensure_allowed_url(path)
            return path
        return f"{self.base_url}{path}"

    async def send(self, spec: RequestSpec, ctx: CaseContext) -> Exchange:
        return self._redact(await self._send(spec, ctx))

    def _redact(self, exchange: Exchange) -> Exchange:
        if not self.secrets:
            return exchange
        data = redact(exchange.model_dump(), self.secrets)
        return Exchange.model_validate(data)

    async def _send(self, spec: RequestSpec, ctx: CaseContext) -> Exchange:
        if self.sent >= self.max_requests:
            raise BudgetExceeded(f"Request budget of {self.max_requests} reached")
        self.sent += 1

        try:
            url = self.build_url(spec, ctx)
            headers = {k: str(v) for k, v in ctx.render(spec.headers).items()}
            query = ctx.render(spec.query)
            body = ctx.render(spec.body)
        except TemplateError as exc:
            return Exchange(method=spec.method, url=spec.path, error=str(exc))
        except SpecError as exc:
            return Exchange(method=spec.method, url=spec.path, error=str(exc))

        content: bytes | None = None
        if spec.raw_body is not None:
            try:
                rendered = str(ctx.render(spec.raw_body))
            except TemplateError as exc:
                return Exchange(method=spec.method, url=url, error=str(exc))
            content = rendered.encode()
            try:
                shown_body: Any = json.loads(rendered)
            except ValueError:
                shown_body = rendered
        elif body is not None:
            content = json.dumps(body).encode()
            shown_body = body
        else:
            shown_body = None

        if content is not None and not spec.omit_content_type and not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/json"

        exchange = Exchange(method=spec.method, url=url, request_headers=headers, request_body=shown_body)
        started = time.perf_counter()
        try:
            resp = await self.client.request(spec.method, url, params=query or None, headers=headers, content=content)
        except httpx.HTTPError as exc:
            exchange.error = f"{type(exc).__name__}: {exc}"
            exchange.duration_ms = round((time.perf_counter() - started) * 1000, 1)
            return exchange

        exchange.duration_ms = round((time.perf_counter() - started) * 1000, 1)
        exchange.status = resp.status_code
        exchange.url = str(resp.request.url)
        exchange.response_headers = {k: v for k, v in resp.headers.items() if k.lower() in KEPT_RESPONSE_HEADERS}
        exchange.size_bytes = len(resp.content)
        if resp.content:
            try:
                exchange.response_body = _truncate(resp.json())
            except ValueError:
                exchange.response_body = _truncate(resp.text)
        return exchange
