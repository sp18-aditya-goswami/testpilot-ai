from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend import planner
from backend.api.core import load_api, not_found
from backend.engines.ai_planner import PATH_PARAM, PlanRejected, validate_expected
from backend.runner import execute_run
from backend.schemas import ApiSummary, Category, RequestSpec, Run, RunCounts, TestCase, TestPlan
from backend.spec_parser import SpecError, ensure_allowed_url
from backend.state import active_runs, spawn
from backend.store import NotFound, store
from backend.workspace_schemas import PlanCreate, PlannerConfig, PlanRefine

router = APIRouter()


class RunRequest(BaseModel):
    case_ids: list[str] | None = None
    allow_destructive: bool = False
    fuzz: bool = False
    fuzz_examples: int = Field(default=20, ge=1, le=100)


class CaseIn(BaseModel):
    endpoint_id: str
    name: str = Field(min_length=1, max_length=120)
    category: Category
    source: Literal["contract", "ai", "fuzz", "saved"] = "contract"
    rationale: str = Field(default="", max_length=500)
    setup: list[RequestSpec] = []
    request: RequestSpec
    expected_status: list[int]
    max_ms: int | None = None
    json_schema: dict | None = None


class CasePatch(BaseModel):
    endpoint_id: str | None = None
    name: str | None = Field(default=None, min_length=1, max_length=120)
    category: Category | None = None
    rationale: str | None = Field(default=None, max_length=500)
    setup: list[RequestSpec] | None = None
    request: RequestSpec | None = None
    expected_status: list[int] | None = None
    max_ms: int | None = None
    json_schema: dict | None = None


def get_plan_or_404(plan_id: str) -> TestPlan:
    try:
        return store.load("plans", plan_id, TestPlan)
    except NotFound:
        raise not_found("Plan")


def resolve_environment(environment_id: str):
    try:
        runtime = planner.env_runtime(environment_id)
    except NotFound:
        raise not_found("Environment")
    try:
        ensure_allowed_url(runtime.base_url)
    except SpecError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return runtime


def editable(plan: TestPlan) -> None:
    if plan.status == "planning":
        raise HTTPException(status_code=409, detail="The plan is still being built; wait until it is ready")


def checked_case(case: TestCase, api: ApiSummary) -> TestCase:
    endpoints = {e.id for e in api.endpoints}
    if case.endpoint_id not in endpoints:
        raise HTTPException(status_code=422, detail=f"{case.endpoint_id} is not in the specification")
    if f"{case.request.method.upper()} {case.request.path}" != case.endpoint_id:
        raise HTTPException(status_code=422, detail="The request's method and path must match its endpoint")
    missing = set(PATH_PARAM.findall(case.request.path)) - set(case.request.path_params)
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing path parameters: {', '.join(sorted(missing))}")
    if any(step.method.upper() == "DELETE" for step in case.setup):
        raise HTTPException(status_code=422, detail="Setup steps may not delete data")
    try:
        case.expected_status = validate_expected(case.expected_status)
    except PlanRejected as exc:
        raise HTTPException(status_code=422, detail=f"Expected status: {exc}")
    case.request.method = case.request.method.upper()
    case.destructive = case.request.method == "DELETE"
    return case


@router.post("/api/plans", response_model=TestPlan, status_code=202)
async def create_plan(body: PlanCreate):
    api = load_api(body.spec_id)
    spec_project = store.project_of("specs", body.spec_id)
    if spec_project and spec_project != body.project_id:
        raise HTTPException(status_code=422, detail="That specification belongs to another project")
    config = body.config
    if not (config.use_contract or config.use_ai):
        raise HTTPException(status_code=422, detail="Choose at least one source of test cases")
    runtime = resolve_environment(body.environment_id)

    plan = TestPlan(
        spec_id=api.spec_id,
        spec_title=api.title,
        base_url=runtime.base_url,
        instruction=config.instruction,
        business_rules="\n".join(r.text for r in config.business_rules),
        cases=[],
        project_id=body.project_id,
        environment_id=body.environment_id,
        suite_item_id=body.suite_item_id,
        status="planning",
        progress=["Queued"],
        config=config.model_dump(),
    )
    planner.save(plan)
    snapshot = plan.model_copy(deep=True)
    spawn(planner.run_planning(plan, api, config, sorted(runtime.variables)))
    return snapshot


@router.get("/api/plans/{plan_id}", response_model=TestPlan)
def get_plan(plan_id: str):
    return get_plan_or_404(plan_id)


@router.post("/api/plans/{plan_id}/cases", response_model=TestPlan)
def add_case(plan_id: str, body: CaseIn):
    plan = get_plan_or_404(plan_id)
    editable(plan)
    case = checked_case(TestCase(**body.model_dump()), load_api(plan.spec_id))
    plan.cases.append(case)
    planner.save(plan)
    return plan


@router.patch("/api/plans/{plan_id}/cases/{case_id}", response_model=TestPlan)
def update_case(plan_id: str, case_id: str, body: CasePatch):
    plan = get_plan_or_404(plan_id)
    editable(plan)
    index = next((i for i, c in enumerate(plan.cases) if c.id == case_id), None)
    if index is None:
        raise not_found("Case")
    merged = plan.cases[index].model_dump()
    merged.update(body.model_dump(exclude_unset=True))
    plan.cases[index] = checked_case(TestCase(**merged), load_api(plan.spec_id))
    planner.save(plan)
    return plan


@router.delete("/api/plans/{plan_id}/cases/{case_id}", response_model=TestPlan)
def delete_case(plan_id: str, case_id: str):
    plan = get_plan_or_404(plan_id)
    editable(plan)
    remaining = [c for c in plan.cases if c.id != case_id]
    if len(remaining) == len(plan.cases):
        raise not_found("Case")
    plan.cases = remaining
    planner.save(plan)
    return plan


@router.post("/api/plans/{plan_id}/refine", response_model=TestPlan, status_code=202)
async def refine_plan(plan_id: str, body: PlanRefine):
    plan = get_plan_or_404(plan_id)
    editable(plan)
    if not planner.ai_enabled():
        raise HTTPException(status_code=422, detail="Set an Anthropic API key in Settings to refine plans with AI")
    api = load_api(plan.spec_id)
    known = {e.id for e in api.endpoints}
    unknown = [e for e in body.endpoint_ids if e not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Not in the specification: {', '.join(unknown)}")
    variable_keys: list[str] = []
    if plan.environment_id:
        variable_keys = sorted(resolve_environment(plan.environment_id).variables)
    config = PlannerConfig(**plan.config) if plan.config else PlannerConfig()

    plan.status = "planning"
    plan.progress.append("Queued a refinement")
    planner.save(plan)
    snapshot = plan.model_copy(deep=True)
    spawn(planner.run_refine(plan, api, config, variable_keys, body.instruction, body.endpoint_ids))
    return snapshot


@router.post("/api/plans/{plan_id}/runs", response_model=Run, status_code=202)
async def start_run(plan_id: str, body: RunRequest):
    plan = get_plan_or_404(plan_id)
    editable(plan)
    api = load_api(plan.spec_id)

    base_url = plan.base_url
    variables: dict[str, str] | None = None
    secrets: set[str] | None = None
    environment_name = ""
    if plan.environment_id:
        runtime = resolve_environment(plan.environment_id)
        base_url, variables, secrets, environment_name = runtime.base_url, runtime.variables, runtime.secret_values, runtime.name
    else:
        try:
            ensure_allowed_url(base_url)
        except SpecError as exc:
            raise HTTPException(status_code=422, detail=str(exc))

    cases = plan.cases
    if body.case_ids is not None:
        wanted = set(body.case_ids)
        cases = [c for c in plan.cases if c.id in wanted]
    if not cases:
        raise HTTPException(status_code=422, detail="No cases selected")

    source_name = plan.spec_title
    if plan.suite_item_id:
        from backend import workspace_repo

        try:
            source_name = workspace_repo.get_item(plan.suite_item_id).name
        except Exception:
            pass

    run = Run(
        plan_id=plan.id,
        project_id=plan.project_id,
        environment_id=plan.environment_id,
        environment_name=environment_name,
        source_kind="suite",
        source_id=plan.suite_item_id,
        source_name=source_name,
        spec_title=plan.spec_title,
        base_url=base_url,
        allow_destructive=body.allow_destructive,
        cases=cases,
        counts=RunCounts(total=len(cases)),
        fuzz_message="Waiting for planned cases to finish" if body.fuzz else "",
    )
    active_runs[run.id] = run
    store.save("runs", run.id, run, project_id=plan.project_id)

    async def work():
        try:
            await execute_run(
                run, plan, api, fuzz_examples=body.fuzz_examples if body.fuzz else None, variables=variables, secrets=secrets
            )
        finally:
            active_runs.pop(run.id, None)

    spawn(work())
    return run
