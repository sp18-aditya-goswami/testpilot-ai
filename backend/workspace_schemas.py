"""API contract for the workspace: projects, environments, collections, folders, items and settings."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from backend.schemas import Check, Exchange

HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]


# ---------- projects ----------

class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)


class Project(BaseModel):
    id: str
    name: str
    description: str
    created_at: datetime
    collection_count: int = 0
    environment_count: int = 0
    run_count: int = 0
    last_run_at: datetime | None = None


# ---------- environments ("connections") ----------

class EnvVarIn(BaseModel):
    key: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z_][A-Za-z0-9_\-]*$")
    value: str | None = None  # None on a secret var means "keep the stored value"
    secret: bool = False


class EnvVar(BaseModel):
    key: str
    value: str  # always "" for secrets in responses
    secret: bool
    has_value: bool


class EnvironmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    base_url: str
    variables: list[EnvVarIn] = []
    is_default: bool = False


class EnvironmentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    base_url: str | None = None
    variables: list[EnvVarIn] | None = None
    is_default: bool | None = None


class Environment(BaseModel):
    id: str
    project_id: str
    name: str
    base_url: str
    variables: list[EnvVar]
    is_default: bool
    base_url_allowed: bool  # false when the host is outside the allowlist


# ---------- saved requests and suites ----------

class KeyValue(BaseModel):
    key: str
    value: str = ""
    enabled: bool = True


class Assertions(BaseModel):
    expected_status: list[int] = [200, 201, 202, 204]
    max_ms: int | None = None
    json_schema: dict | None = None  # response body must validate against it


class SavedRequest(BaseModel):
    method: HttpMethod = "GET"
    path: str = "/"  # appended to the environment base_url; may contain {{variables}}
    query: list[KeyValue] = []
    headers: list[KeyValue] = []
    body_mode: Literal["none", "json", "raw"] = "none"
    body: str = ""
    assertions: Assertions = Assertions()
    description: str = ""


class SavedSuite(BaseModel):
    spec_id: str | None = None
    config: "PlannerConfig" = Field(default_factory=lambda: PlannerConfig())
    last_plan_id: str | None = None
    last_run_id: str | None = None


ItemKind = Literal["request", "suite"]


class ItemIn(BaseModel):
    kind: ItemKind
    name: str = Field(min_length=1, max_length=120)
    folder_id: str | None = None
    request: SavedRequest | None = None
    suite: SavedSuite | None = None


class ItemPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    request: SavedRequest | None = None
    suite: SavedSuite | None = None


class ItemMove(BaseModel):
    collection_id: str
    folder_id: str | None = None
    position: int | None = None  # None appends


class Item(BaseModel):
    id: str
    project_id: str
    collection_id: str
    folder_id: str | None
    kind: ItemKind
    name: str
    position: int
    request: SavedRequest | None = None
    suite: SavedSuite | None = None
    updated_at: datetime


# ---------- collections and folders ----------

class CollectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)


class CollectionPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)


class FolderIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: str | None = None


class FolderPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    parent_id: str | None = None  # moving a folder; may not move into its own subtree


class ItemSummary(BaseModel):
    id: str
    kind: ItemKind
    name: str
    method: str | None = None  # for requests
    position: int


class FolderNode(BaseModel):
    id: str
    name: str
    parent_id: str | None
    position: int
    folders: list["FolderNode"] = []
    items: list[ItemSummary] = []


class CollectionNode(BaseModel):
    id: str
    name: str
    description: str
    position: int
    folders: list[FolderNode] = []
    items: list[ItemSummary] = []  # items at the collection root


class ProjectTree(BaseModel):
    project: Project
    environments: list[Environment]
    collections: list[CollectionNode]


class ImportSpecIn(BaseModel):
    spec_id: str
    collection_name: str | None = None  # defaults to the spec title
    group_by_tag: bool = True


# ---------- sending and running ----------

class SendIn(BaseModel):
    environment_id: str
    request: SavedRequest


class SendResult(BaseModel):
    exchange: Exchange
    checks: list[Check]
    outcome: Literal["passed", "failed", "error"]
    resolved_url: str
    response_size_bytes: int


class GroupRunIn(BaseModel):
    environment_id: str
    allow_destructive: bool = False


# ---------- settings ----------

Effort = Literal["low", "medium", "high", "xhigh", "max"]
AiProviderName = Literal["anthropic", "openai", "bedrock"]


class KeyedProvider(BaseModel):
    key_hint: str | None  # e.g. "sk-ant-…a1b2", never the key
    key_source: Literal["app", "env"] | None
    model: str


class BedrockSettings(BaseModel):
    region: str | None
    auth: Literal["default", "keys", "api_key"]
    profile: str | None
    access_key_hint: str | None  # e.g. "AKIA…WXYZ"
    has_secret_key: bool
    has_session_token: bool
    api_key_hint: str | None
    default_credentials_found: bool  # whether the AWS credential chain resolves on the backend machine
    model: str


class AiSettings(BaseModel):
    provider: AiProviderName
    configured: bool  # the selected provider is ready to use
    model: str  # the selected provider's model
    effort: Effort
    anthropic: KeyedProvider
    openai: KeyedProvider
    bedrock: BedrockSettings


class SettingsOut(BaseModel):
    ai: AiSettings
    allowed_hosts: list[str]
    max_concurrency: int
    max_requests_per_run: int
    request_timeout_s: float


class SettingsPatch(BaseModel):
    """Every secret: None leaves it as stored, "" clears it."""

    ai_provider: AiProviderName | None = None
    effort: Effort | None = None
    anthropic_api_key: str | None = None
    anthropic_model: str | None = None
    openai_api_key: str | None = None
    openai_model: str | None = None
    aws_region: str | None = None
    bedrock_auth: Literal["default", "keys", "api_key"] | None = None
    aws_profile: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    aws_session_token: str | None = None
    bedrock_api_key: str | None = None
    bedrock_model: str | None = None
    allowed_hosts: list[str] | None = None


class AiCheck(BaseModel):
    ok: bool
    message: str


# ---------- the test planner ----------

Objective = Literal[
    "happy_path", "validation", "boundaries", "business_rules", "auth",
    "security", "state", "idempotency", "errors", "performance",
]
DEFAULT_OBJECTIVES: list[str] = ["happy_path", "validation", "boundaries", "business_rules", "state"]


class BusinessRule(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    endpoint_ids: list[str] = []  # empty: applies to every endpoint in scope
    expected_status: list[int] = []  # what a violation must return, when the rule names it


class EndpointNote(BaseModel):
    endpoint_id: str
    note: str = Field(max_length=1000)


class AuthContext(BaseModel):
    description: str = Field(default="", max_length=1000)  # e.g. "Bearer token; admins can delete, users cannot"
    header_name: str = "Authorization"
    token_variable: str | None = None  # environment variable holding a valid token, e.g. "token"
    roles: list[str] = []  # roles the API distinguishes, each optionally backed by an env variable "<role>_token"


class PlannerConfig(BaseModel):
    instruction: str = Field(default="", max_length=4000)
    objectives: list[Objective] = Field(default_factory=lambda: list(DEFAULT_OBJECTIVES))
    depth: Literal["quick", "standard", "thorough"] = "standard"
    business_rules: list[BusinessRule] = []
    endpoint_notes: list[EndpointNote] = []
    auth: AuthContext = AuthContext()
    test_data: str = Field(default="", max_length=4000)  # known fixtures and sample values
    exclusions: str = Field(default="", max_length=2000)  # what must not be tested or sent
    review_pass: bool = True
    use_contract: bool = True
    use_ai: bool = True
    focus_endpoints: list[str] = []


class EndpointStrategy(BaseModel):
    endpoint_id: str
    risks: list[str]
    categories: list[str]
    planned_cases: int


class PlanCreate(BaseModel):
    project_id: str
    spec_id: str
    environment_id: str
    suite_item_id: str | None = None
    config: PlannerConfig = PlannerConfig()


class PlanRefine(BaseModel):
    instruction: str = Field(min_length=1, max_length=2000)
    endpoint_ids: list[str] = []


SavedSuite.model_rebuild()
ItemIn.model_rebuild()
ItemPatch.model_rebuild()
Item.model_rebuild()
FolderNode.model_rebuild()
