from datetime import datetime
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, model_validator

from backend.ai_auth import active_model, provider_of
from backend.config import get_settings
from backend.report import render_html
from backend.schemas import ApiSummary, Run, RunCounts
from backend.spec_parser import SpecError, fetch_spec, load_spec_text, parse_spec
from backend.state import active_runs
from backend.store import NotFound, store
from backend.workspace_repo import require_project

router = APIRouter()


class InspectRequest(BaseModel):
    spec_url: str | None = None
    spec_text: str | None = None
    project_id: str | None = None

    @model_validator(mode="after")
    def one_source(self):
        if not (self.spec_url or self.spec_text):
            raise ValueError("Provide spec_url or spec_text")
        return self


class InspectResponse(BaseModel):
    api: ApiSummary
    suggested_base_url: str | None


class RunListItem(BaseModel):
    id: str
    spec_title: str
    base_url: str
    status: str
    created_at: datetime
    finished_at: datetime | None
    counts: RunCounts
    project_id: str | None = None
    environment_name: str = ""
    source_kind: str = "suite"
    source_name: str = ""


def not_found(kind: str):
    return HTTPException(status_code=404, detail=f"{kind} not found")


def load_api(spec_id: str) -> ApiSummary:
    try:
        return store.load("specs", spec_id, ApiSummary)
    except NotFound:
        raise not_found("Specification")


def _get_run(run_id: str) -> Run:
    if run_id in active_runs:
        return active_runs[run_id]
    try:
        return store.load("runs", run_id, Run)
    except NotFound:
        raise not_found("Run")


@router.get("/api/health")
def health():
    s = get_settings()
    return {
        "status": "ok",
        "ai_enabled": s.ai_enabled,
        "model": active_model(s) if s.ai_enabled else None,
        "provider": provider_of(s),
        "allowed_hosts": sorted(s.allowed_host_set),
        "limits": {
            "max_concurrency": s.max_concurrency,
            "max_requests_per_run": s.max_requests_per_run,
            "request_timeout_s": s.request_timeout_s,
        },
    }


@router.post("/api/specs/inspect", response_model=InspectResponse)
def inspect_spec(body: InspectRequest):
    if body.project_id is not None:
        try:
            require_project(body.project_id)
        except NotFound:
            raise not_found("Project")
    try:
        doc = fetch_spec(body.spec_url) if body.spec_url else load_spec_text(body.spec_text or "")
        api = parse_spec(doc)
    except SpecError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    store.save("specs", api.spec_id, api, project_id=body.project_id)
    store.save_raw("rawspecs", api.spec_id, doc, project_id=body.project_id)

    suggested = None
    if api.server_url and api.server_url.startswith("http"):
        suggested = api.server_url
    elif body.spec_url:
        parsed = urlparse(body.spec_url)
        suggested = f"{parsed.scheme}://{parsed.netloc}{api.server_url or ''}".rstrip("/")
    return InspectResponse(api=api, suggested_base_url=suggested)


@router.get("/api/specs/{spec_id}", response_model=ApiSummary)
def get_spec(spec_id: str):
    return load_api(spec_id)


def _run_items(project_id: str | None = None) -> list[RunListItem]:
    runs = {r.id: r for r in store.list("runs", Run, project_id=project_id)}
    runs.update({k: v for k, v in active_runs.items() if project_id is None or v.project_id == project_id})
    items = sorted(runs.values(), key=lambda r: r.created_at, reverse=True)
    return [RunListItem(**r.model_dump(include=set(RunListItem.model_fields))) for r in items]


@router.get("/api/runs", response_model=list[RunListItem])
def list_runs():
    return _run_items()


@router.get("/api/projects/{project_id}/runs", response_model=list[RunListItem])
def list_project_runs(project_id: str):
    try:
        require_project(project_id)
    except NotFound:
        raise not_found("Project")
    return _run_items(project_id)


@router.get("/api/runs/{run_id}", response_model=Run)
def get_run(run_id: str):
    return _get_run(run_id)


@router.get("/api/runs/{run_id}/report.json")
def run_report_json(run_id: str):
    run = _get_run(run_id)
    return Response(
        content=run.model_dump_json(indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="testpilot-{run.id}.json"'},
    )


@router.get("/api/runs/{run_id}/report.html", response_class=HTMLResponse)
def run_report_html(run_id: str):
    run = _get_run(run_id)
    return HTMLResponse(
        render_html(run),
        headers={"Content-Disposition": f'inline; filename="testpilot-{run.id}.html"'},
    )
