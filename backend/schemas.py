from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------- API specification ----------

class Parameter(BaseModel):
    name: str
    location: Literal["path", "query", "header", "cookie"]
    required: bool = False
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")
    description: str = ""

    model_config = {"populate_by_name": True, "serialize_by_alias": True}


class Endpoint(BaseModel):
    id: str
    method: str
    path: str
    summary: str = ""
    description: str = ""
    tags: list[str] = []
    parameters: list[Parameter] = []
    request_body_schema: dict[str, Any] | None = None
    request_body_required: bool = False
    responses: dict[str, dict[str, Any] | None] = {}
    requires_auth: bool = False


class ApiSummary(BaseModel):
    spec_id: str
    title: str
    version: str
    description: str = ""
    openapi_version: str
    server_url: str | None = None
    endpoints: list[Endpoint]


# ---------- Test plan ----------

Category = Literal["positive", "negative", "boundary", "business", "security", "robustness"]


class RequestSpec(BaseModel):
    method: str
    path: str
    path_params: dict[str, Any] = {}
    query: dict[str, Any] = {}
    headers: dict[str, str] = {}
    body: Any = None
    raw_body: str | None = None
    omit_content_type: bool = False


class TestCase(BaseModel):
    __test__ = False

    id: str = Field(default_factory=lambda: new_id("tc"))
    endpoint_id: str
    name: str
    category: Category
    source: Literal["contract", "ai", "fuzz", "saved"]
    rationale: str = ""
    setup: list[RequestSpec] = []
    request: RequestSpec
    expected_status: list[int]
    destructive: bool = False
    max_ms: int | None = None
    json_schema: dict | None = None


class RejectedCase(BaseModel):
    name: str
    reason: str


class TestPlan(BaseModel):
    __test__ = False

    id: str = Field(default_factory=lambda: new_id("plan"))
    created_at: datetime = Field(default_factory=utcnow)
    project_id: str | None = None
    environment_id: str | None = None
    suite_item_id: str | None = None
    spec_id: str
    spec_title: str
    base_url: str
    instruction: str = ""
    business_rules: str = ""
    cases: list[TestCase]
    rejected: list[RejectedCase] = []
    ai_status: Literal["ok", "disabled", "error", "skipped"] = "skipped"
    ai_message: str = ""
    status: Literal["planning", "ready", "failed"] = "ready"
    progress: list[str] = []  # human-readable steps, newest last, while planning
    config: dict = {}  # the PlannerConfig the plan was built from
    strategy: list[dict] = []  # EndpointStrategy entries from the AI's first pass
    review_notes: list[str] = []  # what the review pass changed


# ---------- Execution ----------

class Exchange(BaseModel):
    method: str
    url: str
    request_headers: dict[str, str] = {}
    request_body: Any = None
    status: int | None = None
    response_headers: dict[str, str] = {}
    response_body: Any = None
    duration_ms: float | None = None
    error: str | None = None
    size_bytes: int | None = None


class Check(BaseModel):
    name: str
    passed: bool
    severity: Literal["fail", "warn"] = "fail"
    detail: str = ""


class Analysis(BaseModel):
    title: str
    severity: Literal["critical", "high", "medium", "low"]
    summary: str
    likely_cause: str
    investigation_steps: list[str] = []
    source: Literal["ai", "rules"] = "rules"


class CaseResult(BaseModel):
    case_id: str
    outcome: Literal["passed", "failed", "error", "skipped"]
    setup_exchanges: list[Exchange] = []
    exchange: Exchange | None = None
    checks: list[Check] = []
    analysis: Analysis | None = None
    regression_test: str | None = None
    note: str = ""


class RunCounts(BaseModel):
    total: int = 0
    passed: int = 0
    failed: int = 0
    error: int = 0
    skipped: int = 0


class Run(BaseModel):
    id: str = Field(default_factory=lambda: new_id("run"))
    plan_id: str | None = None
    project_id: str | None = None
    environment_id: str | None = None
    environment_name: str = ""
    source_kind: Literal["suite", "collection", "folder", "request"] = "suite"
    source_id: str | None = None
    source_name: str = ""
    spec_title: str
    base_url: str
    status: Literal["queued", "running", "analyzing", "completed", "failed"] = "queued"
    created_at: datetime = Field(default_factory=utcnow)
    finished_at: datetime | None = None
    allow_destructive: bool = False
    cases: list[TestCase] = []
    results: list[CaseResult] = []
    counts: RunCounts = RunCounts()
    request_count: int = 0
    message: str = ""
    fuzz_status: Literal["off", "running", "ok", "error"] = "off"
    fuzz_message: str = ""
    fuzz_examples_run: int = 0
