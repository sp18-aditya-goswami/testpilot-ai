import json
import re
from collections.abc import Callable
from functools import wraps
from typing import TypeVar

from fastapi import APIRouter, HTTPException

from backend.config import get_settings
from backend.engines.examples import example_for
from backend.executor import CaseContext, Executor, TemplateError, make_client
from backend.runner import execute_run
from backend.schemas import ApiSummary, RequestSpec, Run, RunCounts, TestCase
from backend.spec_parser import SpecError, ensure_allowed_url
from backend.state import active_runs, spawn
from backend.store import NotFound, store
from backend.validator import outcome_for, validate
from backend import workspace_repo as repo
from backend.workspace_schemas import (
    CollectionIn,
    CollectionNode,
    CollectionPatch,
    Environment,
    EnvironmentIn,
    EnvironmentPatch,
    FolderIn,
    FolderNode,
    FolderPatch,
    GroupRunIn,
    ImportSpecIn,
    Item,
    ItemIn,
    ItemMove,
    ItemPatch,
    KeyValue,
    Project,
    ProjectIn,
    ProjectPatch,
    ProjectTree,
    SavedRequest,
    SendIn,
    SendResult,
)

router = APIRouter()
T = TypeVar("T")
OK = {"ok": True}


def http_errors(fn: Callable[..., T]) -> Callable[..., T]:
    """Maps repository errors to HTTP: NotFound → 404, Invalid → 422."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except NotFound as exc:
            raise HTTPException(status_code=404, detail=exc.args[0] if exc.args else "Not found")
        except repo.Invalid as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    return wrapper


def _guard(call: Callable[[], T]) -> T:
    return http_errors(call)()


# ---------- projects ----------

@router.get("/api/projects", response_model=list[Project])
def list_projects():
    return repo.list_projects()


@router.post("/api/projects", response_model=Project, status_code=201)
def create_project(body: ProjectIn):
    return repo.create_project(body)


@router.get("/api/projects/{project_id}", response_model=Project)
def get_project(project_id: str):
    return _guard(lambda: repo.get_project(project_id))


@router.patch("/api/projects/{project_id}", response_model=Project)
def update_project(project_id: str, body: ProjectPatch):
    return _guard(lambda: repo.update_project(project_id, body))


@router.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    _guard(lambda: repo.delete_project(project_id))
    return OK


@router.get("/api/projects/{project_id}/tree", response_model=ProjectTree)
def project_tree(project_id: str):
    return _guard(lambda: repo.project_tree(project_id))


@router.get("/api/projects/{project_id}/specs")
def project_specs(project_id: str):
    _guard(lambda: repo.require_project(project_id))
    out = []
    for row in store.list_rows("specs", project_id):
        api = ApiSummary.model_validate_json(row.data)
        out.append(
            {
                "spec_id": api.spec_id,
                "title": api.title,
                "version": api.version,
                "endpoint_count": len(api.endpoints),
                "created_at": row.created_at,
            }
        )
    return out


# ---------- environments ----------

@router.post("/api/projects/{project_id}/environments", response_model=Environment, status_code=201)
def create_environment(project_id: str, body: EnvironmentIn):
    return _guard(lambda: repo.create_environment(project_id, body))


@router.patch("/api/environments/{env_id}", response_model=Environment)
def update_environment(env_id: str, body: EnvironmentPatch):
    return _guard(lambda: repo.update_environment(env_id, body))


@router.delete("/api/environments/{env_id}")
def delete_environment(env_id: str):
    _guard(lambda: repo.delete_environment(env_id))
    return OK


# ---------- collections and folders ----------

@router.post("/api/projects/{project_id}/collections", response_model=CollectionNode, status_code=201)
def create_collection(project_id: str, body: CollectionIn):
    return _guard(lambda: repo.create_collection(project_id, body))


@router.patch("/api/collections/{collection_id}", response_model=CollectionNode)
def update_collection(collection_id: str, body: CollectionPatch):
    return _guard(lambda: repo.update_collection(collection_id, body))


@router.delete("/api/collections/{collection_id}")
def delete_collection(collection_id: str):
    _guard(lambda: repo.delete_collection(collection_id))
    return OK


@router.post("/api/collections/{collection_id}/folders", response_model=FolderNode, status_code=201)
def create_folder(collection_id: str, body: FolderIn):
    return _guard(lambda: repo.create_folder(collection_id, body))


@router.patch("/api/folders/{folder_id}", response_model=FolderNode)
def update_folder(folder_id: str, body: FolderPatch):
    return _guard(lambda: repo.update_folder(folder_id, body))


@router.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str):
    _guard(lambda: repo.delete_folder(folder_id))
    return OK


# ---------- items ----------

@router.post("/api/collections/{collection_id}/items", response_model=Item, status_code=201)
def create_item(collection_id: str, body: ItemIn):
    return _guard(lambda: repo.create_item(collection_id, body))


@router.get("/api/items/{item_id}", response_model=Item)
def get_item(item_id: str):
    return _guard(lambda: repo.get_item(item_id))


@router.patch("/api/items/{item_id}", response_model=Item)
def update_item(item_id: str, body: ItemPatch):
    return _guard(lambda: repo.update_item(item_id, body))


@router.post("/api/items/{item_id}/move", response_model=Item)
def move_item(item_id: str, body: ItemMove):
    return _guard(lambda: repo.move_item(item_id, body))


@router.post("/api/items/{item_id}/duplicate", response_model=Item, status_code=201)
def duplicate_item(item_id: str):
    return _guard(lambda: repo.duplicate_item(item_id))


@router.delete("/api/items/{item_id}")
def delete_item(item_id: str):
    _guard(lambda: repo.delete_item(item_id))
    return OK


# ---------- saved request → executable case ----------

def _request_spec(req: SavedRequest) -> RequestSpec:
    """Keeps {{variables}} unresolved so stored cases never hold secret values; the executor resolves them per send."""
    query = {kv.key: kv.value for kv in req.query if kv.enabled and kv.key}
    headers = {kv.key: kv.value for kv in req.headers if kv.enabled and kv.key}
    spec = RequestSpec(method=req.method, path=req.path or "/", query=query, headers=headers)
    if req.body_mode == "json" and req.body.strip():
        spec.raw_body = req.body
    elif req.body_mode == "raw":
        spec.raw_body = req.body
        spec.omit_content_type = True
    return spec


def _case_for(name: str, req: SavedRequest) -> TestCase:
    return TestCase(
        endpoint_id=f"{req.method} {req.path}",
        name=name,
        category="positive",
        source="saved",
        rationale=req.description or "Saved request with its own assertions.",
        request=_request_spec(req),
        expected_status=sorted(set(req.assertions.expected_status)) or [200, 201, 202, 204],
        destructive=req.method == "DELETE",
        max_ms=req.assertions.max_ms,
        json_schema=req.assertions.json_schema,
    )


def _check_json_body(req: SavedRequest, variables: dict[str, str]) -> None:
    if req.body_mode != "json" or not req.body.strip():
        return
    try:
        rendered = CaseContext(variables).render(req.body)
    except TemplateError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    try:
        json.loads(rendered if isinstance(rendered, str) else json.dumps(rendered))
    except ValueError:
        raise HTTPException(status_code=422, detail="Body is not valid JSON")


def _runtime(environment_id: str) -> repo.EnvRuntime:
    runtime = _guard(lambda: repo.environment_runtime(environment_id))
    try:
        ensure_allowed_url(runtime.base_url)
    except SpecError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return runtime


@router.post("/api/requests/send", response_model=SendResult)
async def send_request(body: SendIn):
    runtime = _runtime(body.environment_id)
    _check_json_body(body.request, runtime.variables)
    settings = get_settings()
    case = _case_for("Request", body.request)
    async with make_client(timeout=settings.request_timeout_s, follow_redirects=False) as client:
        executor = Executor(client, runtime.base_url, max_requests=1, secrets=runtime.secret_values)
        exchange = await executor.send(case.request, CaseContext(runtime.variables))
    checks = validate(case, None, exchange, settings.slow_response_ms)
    outcome = "error" if exchange.status is None else outcome_for(checks)
    return SendResult(
        exchange=exchange,
        checks=checks,
        outcome=outcome,
        resolved_url=exchange.url,
        response_size_bytes=exchange.size_bytes or 0,
    )


# ---------- group runs ----------

def _start_group_run(
    *,
    project_id: str,
    collection_id: str,
    folder_id: str | None,
    source_kind: str,
    source_id: str,
    source_name: str,
    body: GroupRunIn,
) -> Run:
    if repo.environment_project(body.environment_id) != project_id:
        raise HTTPException(status_code=422, detail="The environment belongs to another project")
    runtime = _runtime(body.environment_id)
    items = repo.requests_in(collection_id, folder_id)
    if not items:
        raise HTTPException(status_code=422, detail=f"No saved requests in this {source_kind}")
    for item in items:
        _check_json_body(item.request, runtime.variables)
    cases = [_case_for(i.name, i.request) for i in items]
    run = Run(
        project_id=project_id,
        environment_id=body.environment_id,
        environment_name=runtime.name,
        source_kind=source_kind,
        source_id=source_id,
        source_name=source_name,
        spec_title=source_name,
        base_url=runtime.base_url,
        allow_destructive=body.allow_destructive,
        cases=cases,
        counts=RunCounts(total=len(cases)),
    )
    active_runs[run.id] = run
    store.save("runs", run.id, run)

    async def work():
        try:
            await execute_run(run, variables=runtime.variables, secrets=runtime.secret_values)
        finally:
            active_runs.pop(run.id, None)

    spawn(work())
    return run


@router.post("/api/collections/{collection_id}/run", response_model=Run, status_code=202)
async def run_collection(collection_id: str, body: GroupRunIn):
    project_id, name = _guard(lambda: repo.collection_meta(collection_id))
    return _guard(
        lambda: _start_group_run(
            project_id=project_id,
            collection_id=collection_id,
            folder_id=None,
            source_kind="collection",
            source_id=collection_id,
            source_name=name,
            body=body,
        )
    )


@router.post("/api/folders/{folder_id}/run", response_model=Run, status_code=202)
async def run_folder(folder_id: str, body: GroupRunIn):
    project_id, collection_id, name = _guard(lambda: repo.folder_meta(folder_id))
    return _guard(
        lambda: _start_group_run(
            project_id=project_id,
            collection_id=collection_id,
            folder_id=folder_id,
            source_kind="folder",
            source_id=folder_id,
            source_name=name,
            body=body,
        )
    )


# ---------- import a spec as a collection ----------

PATH_PARAM = re.compile(r"\{([^{}]+)\}")


def _saved_request_for(ep) -> SavedRequest:
    query = [
        KeyValue(key=p.name, value=str(example_for(p.schema_, p.name)), enabled=True)
        for p in ep.parameters
        if p.location == "query" and p.required
    ]
    body_mode, body = "none", ""
    if ep.request_body_schema is not None:
        body_mode, body = "json", json.dumps(example_for(ep.request_body_schema), indent=2)
    success = sorted(int(c) for c in ep.responses if c.isdigit() and 200 <= int(c) < 300)
    return SavedRequest(
        method=ep.method if ep.method in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS") else "GET",
        path=PATH_PARAM.sub(lambda m: "{{" + m.group(1) + "}}", ep.path),
        query=query,
        body_mode=body_mode,
        body=body,
        assertions={"expected_status": success or [200, 201, 202, 204]},
        description=ep.description or ep.summary,
    )


@router.post("/api/projects/{project_id}/import", response_model=CollectionNode, status_code=201)
def import_spec(project_id: str, body: ImportSpecIn):
    _guard(lambda: repo.require_project(project_id))
    try:
        owner = store.project_of("specs", body.spec_id)
        api = store.load("specs", body.spec_id, ApiSummary)
    except NotFound:
        raise HTTPException(status_code=404, detail="Specification not found")
    if owner not in (None, project_id):
        raise HTTPException(status_code=422, detail="The specification belongs to another project")

    col = repo.create_collection(project_id, CollectionIn(name=(body.collection_name or f"{api.title} requests")[:80]))
    folders: dict[str, str] = {}
    for ep in api.endpoints:
        folder_id = None
        if body.group_by_tag:
            tag = (ep.tags[0] if ep.tags else "Untagged")[:80]
            if tag not in folders:
                folders[tag] = repo.create_folder(col.id, FolderIn(name=tag)).id
            folder_id = folders[tag]
        name = (ep.summary or f"{ep.method} {ep.path}")[:120]
        repo.create_item(col.id, ItemIn(kind="request", name=name, folder_id=folder_id, request=_saved_request_for(ep)))
    path_defaults: dict[str, str] = {}
    for ep in api.endpoints:
        for p in ep.parameters:
            if p.location == "path":
                path_defaults.setdefault(p.name, str(example_for(p.schema_, p.name)))
    repo.add_missing_variables(project_id, path_defaults)
    return repo.get_collection(col.id)
