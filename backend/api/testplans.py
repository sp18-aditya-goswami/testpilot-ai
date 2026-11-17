"""The guided AI test plan flow: one call sets up the API, one builds the plan, one lists every plan."""

import json
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select

from backend import workspace_repo as repo
from backend.api.core import RunListItem
from backend.api.navigation import _run_item
from backend.api.planning import create_plan
from backend.db import ItemRow, ProjectRow, session
from backend.engines.examples import example_for
from backend.schemas import ApiSummary, Run, TestPlan
from backend.spec_parser import SpecError, fetch_spec, load_spec_text, parse_spec
from backend.state import active_runs
from backend.store import NotFound, store
from backend.workspace_schemas import (
    CollectionIn,
    EnvironmentIn,
    EnvironmentPatch,
    EnvVarIn,
    ItemIn,
    PlanCreate,
    PlannerConfig,
    ProjectIn,
    SavedSuite,
)

router = APIRouter()

PLANS_COLLECTION = "Test plans"
TOKEN_VARIABLE = "token"


class StartIn(BaseModel):
    spec_url: str | None = None
    spec_text: str | None = None
    base_url: str = Field(min_length=1, max_length=500)
    token: str | None = Field(default=None, max_length=4000)  # stored as a secret environment variable
    project_id: str | None = None  # reuse this project; otherwise one named after the API

    @model_validator(mode="after")
    def one_source(self):
        if not (self.spec_url or self.spec_text):
            raise ValueError("Provide spec_url or spec_text")
        return self


class StartOut(BaseModel):
    project_id: str
    project_name: str
    environment_id: str
    environment_name: str
    has_token: bool
    api: ApiSummary


class TestPlanIn(BaseModel):
    project_id: str
    environment_id: str
    spec_id: str
    name: str | None = Field(default=None, max_length=120)
    config: PlannerConfig = PlannerConfig()


class TestPlanOut(BaseModel):
    suite_item_id: str
    plan: TestPlan


class TestPlanRow(BaseModel):
    suite_item_id: str
    name: str
    project_id: str
    project_name: str
    spec_id: str | None
    spec_title: str | None
    last_plan_id: str | None
    plan_status: Literal["planning", "ready", "failed"] | None
    case_count: int
    ai_case_count: int
    last_run: RunListItem | None
    updated_at: datetime


def _guard(call):
    try:
        return call()
    except NotFound as exc:
        raise HTTPException(status_code=404, detail=exc.args[0] if exc.args else "Not found")
    except repo.Invalid as exc:
        raise HTTPException(status_code=422, detail=str(exc))


def _project_for(title: str, project_id: str | None) -> tuple[str, str]:
    if project_id:
        p = _guard(lambda: repo.get_project(project_id))
        return p.id, p.name
    name = (title or "My API").strip()[:80] or "My API"
    for p in repo.list_projects():
        if p.name.strip().lower() == name.lower():
            return p.id, p.name
    p = _guard(lambda: repo.create_project(ProjectIn(name=name, description="Created by the AI test plan flow")))
    return p.id, p.name


def _environment_for(project_id: str, base_url: str, token: str | None) -> tuple[str, str]:
    """Reuses the project's environment with this base URL, or adds one. A token is stored as a secret variable."""
    wanted = base_url.strip().rstrip("/")
    tree = _guard(lambda: repo.project_tree(project_id))
    env = next((e for e in tree.environments if e.base_url.rstrip("/") == wanted), None)
    if env is None:
        taken = {e.name for e in tree.environments}
        name = "Default" if not taken else next(n for n in (f"Server {i}" for i in range(2, 100)) if n not in taken)
        variables = [EnvVarIn(key=TOKEN_VARIABLE, value=token, secret=True)] if token else []
        env = _guard(lambda: repo.create_environment(project_id, EnvironmentIn(name=name, base_url=wanted, variables=variables, is_default=not taken)))
    elif token:
        keep = [EnvVarIn(key=v.key, value=None if v.secret else v.value, secret=v.secret) for v in env.variables if v.key != TOKEN_VARIABLE]
        keep.append(EnvVarIn(key=TOKEN_VARIABLE, value=token, secret=True))
        env = _guard(lambda: repo.update_environment(env.id, EnvironmentPatch(variables=keep)))
    return env.id, env.name


@router.post("/api/test-plans/start", response_model=StartOut)
def start(body: StartIn):
    """Step 1: read the spec, then find or create the project and environment it will be tested in."""
    if not repo.host_allowed(body.base_url):
        raise HTTPException(
            status_code=422,
            detail="That server is not on the allowed hosts list. Add its host in Settings, then try again.",
        )
    try:
        doc = fetch_spec(body.spec_url) if body.spec_url else load_spec_text(body.spec_text or "")
        api = parse_spec(doc)
    except SpecError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    try:
        owner = store.project_of("specs", api.spec_id)
    except NotFound:
        owner = None
    if body.project_id and owner and owner != body.project_id:
        raise HTTPException(status_code=422, detail="This spec is already used by another project; open that project instead")
    project_id, project_name = _project_for(api.title, body.project_id or owner)
    store.save("specs", api.spec_id, api, project_id=project_id)
    store.save_raw("rawspecs", api.spec_id, doc, project_id=project_id)

    environment_id, environment_name = _environment_for(project_id, body.base_url, (body.token or "").strip() or None)
    path_defaults: dict[str, str] = {}
    for ep in api.endpoints:
        for p in ep.parameters:
            if p.location == "path":
                path_defaults.setdefault(p.name, str(example_for(p.schema_, p.name)))
    repo.add_missing_variables(project_id, path_defaults)
    has_token = any(v.key == TOKEN_VARIABLE and v.has_value for e in repo.project_tree(project_id).environments if e.id == environment_id for v in e.variables)
    return StartOut(
        project_id=project_id,
        project_name=project_name,
        environment_id=environment_id,
        environment_name=environment_name,
        has_token=has_token,
        api=api,
    )


def _plans_collection(project_id: str) -> str:
    tree = _guard(lambda: repo.project_tree(project_id))
    existing = next((c for c in tree.collections if c.name == PLANS_COLLECTION), None)
    if existing:
        return existing.id
    return repo.create_collection(project_id, CollectionIn(name=PLANS_COLLECTION, description="Saved AI test plans")).id


@router.post("/api/test-plans", response_model=TestPlanOut, status_code=202)
async def create_test_plan(body: TestPlanIn):
    """Step 2: save the plan settings as a suite in the project's "Test plans" collection and start planning."""
    _guard(lambda: repo.require_project(body.project_id))
    if _guard(lambda: repo.environment_project(body.environment_id)) != body.project_id:
        raise HTTPException(status_code=422, detail="That environment belongs to another project")
    try:
        api = store.load("specs", body.spec_id, ApiSummary)
    except NotFound:
        raise HTTPException(status_code=404, detail="Specification not found")

    collection_id = _plans_collection(body.project_id)
    name = (body.name or "").strip() or f"{api.title} test plan"
    item = _guard(
        lambda: repo.create_item(
            collection_id,
            ItemIn(kind="suite", name=name[:120], suite=SavedSuite(spec_id=body.spec_id, config=body.config)),
        )
    )
    plan = await create_plan(
        PlanCreate(project_id=body.project_id, spec_id=body.spec_id, environment_id=body.environment_id, suite_item_id=item.id, config=body.config)
    )
    record_suite(item.id, last_plan_id=plan.id)
    return TestPlanOut(suite_item_id=item.id, plan=plan)


def record_suite(item_id: str, **fields: str) -> None:
    """Stores the latest plan or run id on a suite item; quietly does nothing when the item is gone."""
    with session() as s:
        row = s.get(ItemRow, item_id)
        if row is None or row.kind != "suite":
            return
        try:
            suite = json.loads(row.suite or "{}")
        except ValueError:
            suite = {}
        suite.update(fields)
        row.suite = json.dumps(suite)


@router.get("/api/test-plans", response_model=list[TestPlanRow])
def list_test_plans():
    """Every suite across projects with its latest plan and run, most recent activity first."""
    with session() as s:
        rows = s.execute(
            select(ItemRow, ProjectRow.name).join(ProjectRow, ProjectRow.id == ItemRow.project_id).where(ItemRow.kind == "suite")
        ).all()
        items = [(r.id, r.name, r.project_id, pname, r.suite, r.updated_at) for r, pname in rows]

    runs: dict[str, Run] = {r.id: r for r in store.list("runs", Run)}
    runs.update(active_runs)
    plans: dict[str, TestPlan] = {p.id: p for p in store.list("plans", TestPlan)}
    titles: dict[str, str] = {}

    out: list[TestPlanRow] = []
    for item_id, name, project_id, project_name, raw, updated_at in items:
        try:
            suite = json.loads(raw or "{}")
        except ValueError:
            suite = {}
        spec_id = suite.get("spec_id")
        plan = plans.get(suite.get("last_plan_id") or "")
        if plan is None:
            mine = [p for p in plans.values() if p.suite_item_id == item_id]
            plan = max(mine, key=lambda p: p.created_at) if mine else None
        suite_runs = [r for r in runs.values() if r.source_id == item_id or (plan and r.plan_id == plan.id)]
        last_run = max(suite_runs, key=lambda r: r.created_at) if suite_runs else None
        if spec_id and spec_id not in titles:
            try:
                titles[spec_id] = store.load("specs", spec_id, ApiSummary).title
            except NotFound:
                titles[spec_id] = ""
        activity = max([updated_at] + ([plan.created_at] if plan else []) + ([last_run.created_at] if last_run else []), key=_naive)
        out.append(
            TestPlanRow(
                suite_item_id=item_id,
                name=name,
                project_id=project_id,
                project_name=project_name,
                spec_id=spec_id,
                spec_title=titles.get(spec_id or "") or (plan.spec_title if plan else None),
                last_plan_id=plan.id if plan else None,
                plan_status=plan.status if plan else None,
                case_count=len(plan.cases) if plan else 0,
                ai_case_count=sum(1 for c in plan.cases if c.source == "ai") if plan else 0,
                last_run=_run_item(last_run) if last_run else None,
                updated_at=activity,
            )
        )
    out.sort(key=lambda r: _naive(r.updated_at), reverse=True)
    return out


def _naive(d: datetime) -> datetime:
    return d.replace(tzinfo=None)
