import { request, type Exchange, type Check, type Run, type TestCase, type TestPlan } from "./api";

// ---------- projects ----------

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  collection_count: number;
  environment_count: number;
  run_count: number;
  last_run_at: string | null;
}

// ---------- environments ----------

export interface EnvVar {
  key: string;
  value: string; // "" for secrets
  secret: boolean;
  has_value: boolean;
}

/** value null on a secret var keeps the stored value */
export interface EnvVarIn {
  key: string;
  value: string | null;
  secret: boolean;
}

export interface Environment {
  id: string;
  project_id: string;
  name: string;
  base_url: string;
  variables: EnvVar[];
  is_default: boolean;
  base_url_allowed: boolean;
}

// ---------- saved requests and suites ----------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export interface Assertions {
  expected_status: number[];
  max_ms: number | null;
  json_schema: Record<string, unknown> | null;
}

export interface SavedRequest {
  method: HttpMethod;
  path: string;
  query: KeyValue[];
  headers: KeyValue[];
  body_mode: "none" | "json" | "raw";
  body: string;
  assertions: Assertions;
  description: string;
}

export const EMPTY_REQUEST: SavedRequest = {
  method: "GET",
  path: "/",
  query: [],
  headers: [],
  body_mode: "none",
  body: "",
  assertions: { expected_status: [200, 201, 202, 204], max_ms: null, json_schema: null },
  description: "",
};

export type Objective =
  | "happy_path"
  | "validation"
  | "boundaries"
  | "business_rules"
  | "auth"
  | "security"
  | "state"
  | "idempotency"
  | "errors"
  | "performance";

export const OBJECTIVES: { id: Objective; label: string; hint: string }[] = [
  { id: "happy_path", label: "Happy path", hint: "Valid requests return the documented success" },
  { id: "validation", label: "Input validation", hint: "Missing, malformed and wrongly typed input is rejected" },
  { id: "boundaries", label: "Boundary values", hint: "Lengths, ranges, empty and very large values" },
  { id: "business_rules", label: "Business rules", hint: "The rules you list below" },
  { id: "auth", label: "Auth and permissions", hint: "Missing tokens, wrong roles, another user's data" },
  { id: "security", label: "Security input", hint: "Injection-shaped strings, unexpected fields" },
  { id: "state", label: "State and sequences", hint: "Create, read, update, delete in order" },
  { id: "idempotency", label: "Duplicates and retries", hint: "Repeated submissions and conflicting writes" },
  { id: "errors", label: "Error handling", hint: "Unknown ids, wrong methods, bad content types" },
  { id: "performance", label: "Latency", hint: "Responses inside the time you expect" },
];

export const DEFAULT_OBJECTIVES: Objective[] = ["happy_path", "validation", "boundaries", "business_rules", "state"];

export interface BusinessRule {
  text: string;
  endpoint_ids: string[];
  expected_status: number[];
}

export interface EndpointNote {
  endpoint_id: string;
  note: string;
}

export interface AuthContext {
  description: string;
  header_name: string;
  token_variable: string | null;
  roles: string[];
}

export type Depth = "quick" | "standard" | "thorough";

export interface PlannerConfig {
  instruction: string;
  objectives: Objective[];
  depth: Depth;
  business_rules: BusinessRule[];
  endpoint_notes: EndpointNote[];
  auth: AuthContext;
  test_data: string;
  exclusions: string;
  review_pass: boolean;
  use_contract: boolean;
  use_ai: boolean;
  focus_endpoints: string[];
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  instruction: "",
  objectives: DEFAULT_OBJECTIVES,
  depth: "standard",
  business_rules: [],
  endpoint_notes: [],
  auth: { description: "", header_name: "Authorization", token_variable: null, roles: [] },
  test_data: "",
  exclusions: "",
  review_pass: true,
  use_contract: true,
  use_ai: true,
  focus_endpoints: [],
};

export interface EndpointStrategy {
  endpoint_id: string;
  risks: string[];
  categories: string[];
  planned_cases: number;
}

export interface SavedSuite {
  spec_id: string | null;
  config: PlannerConfig;
  last_plan_id: string | null;
  last_run_id: string | null;
}

export type ItemKind = "request" | "suite";

export interface Item {
  id: string;
  project_id: string;
  collection_id: string;
  folder_id: string | null;
  kind: ItemKind;
  name: string;
  position: number;
  request: SavedRequest | null;
  suite: SavedSuite | null;
  updated_at: string;
}

// ---------- the tree ----------

export interface ItemSummary {
  id: string;
  kind: ItemKind;
  name: string;
  method: string | null;
  position: number;
}

export interface FolderNode {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  folders: FolderNode[];
  items: ItemSummary[];
}

export interface CollectionNode {
  id: string;
  name: string;
  description: string;
  position: number;
  folders: FolderNode[];
  items: ItemSummary[];
}

export interface ProjectTree {
  project: Project;
  environments: Environment[];
  collections: CollectionNode[];
}

// ---------- sending ----------

export interface SendResult {
  exchange: Exchange;
  checks: Check[];
  outcome: "passed" | "failed" | "error";
  resolved_url: string;
  response_size_bytes: number;
}

// ---------- settings ----------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type AiProvider = "anthropic" | "openai" | "bedrock";
export type BedrockAuth = "default" | "keys" | "api_key";

export interface KeyedProvider {
  key_hint: string | null;
  key_source: "app" | "env" | null;
  model: string;
}

export interface BedrockSettings {
  region: string | null;
  auth: BedrockAuth;
  profile: string | null;
  access_key_hint: string | null;
  has_secret_key: boolean;
  has_session_token: boolean;
  api_key_hint: string | null;
  default_credentials_found: boolean;
  model: string;
}

export interface Settings {
  ai: {
    provider: AiProvider;
    configured: boolean;
    model: string;
    effort: Effort;
    anthropic: KeyedProvider;
    openai: KeyedProvider;
    bedrock: BedrockSettings;
  };
  allowed_hosts: string[];
  max_concurrency: number;
  max_requests_per_run: number;
  request_timeout_s: number;
}

/** For every secret: omit to keep it, "" to clear it. */
export interface SettingsPatch {
  ai_provider?: AiProvider;
  effort?: Effort;
  anthropic_api_key?: string;
  anthropic_model?: string;
  openai_api_key?: string;
  openai_model?: string;
  aws_region?: string;
  bedrock_auth?: BedrockAuth;
  aws_profile?: string;
  aws_access_key_id?: string;
  aws_secret_access_key?: string;
  aws_session_token?: string;
  bedrock_api_key?: string;
  bedrock_model?: string;
  allowed_hosts?: string[];
}

export interface RunListItem {
  id: string;
  spec_title: string;
  base_url: string;
  status: Run["status"];
  created_at: string;
  finished_at: string | null;
  counts: Run["counts"];
  project_id: string | null;
  environment_name: string;
  source_kind: Run["source_kind"];
  source_name: string;
}

export interface PlanSummary {
  id: string;
  created_at: string;
  status: "planning" | "ready" | "failed";
  case_count: number;
  ai_case_count: number;
  ai_status: "ok" | "disabled" | "error" | "skipped";
  suite_item_id: string | null;
  spec_id: string;
}

export interface SuiteRef {
  item_id: string;
  name: string;
  collection_id: string;
  collection_name: string;
  last_plan_id: string | null;
  last_run_id: string | null;
}

export interface SpecUsage {
  suites: SuiteRef[];
  plans: PlanSummary[];
  runs: RunListItem[];
}

export interface ItemHistory {
  plans: PlanSummary[];
  runs: RunListItem[];
}

const j = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const e = encodeURIComponent;

export const ws = {
  // projects
  projects: () => request<Project[]>("/api/projects"),
  createProject: (body: { name: string; description?: string }) => request<Project>("/api/projects", { method: "POST", ...j(body) }),
  updateProject: (id: string, body: { name?: string; description?: string }) => request<Project>(`/api/projects/${e(id)}`, { method: "PATCH", ...j(body) }),
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${e(id)}`, { method: "DELETE" }),
  tree: (id: string) => request<ProjectTree>(`/api/projects/${e(id)}/tree`),
  projectRuns: (id: string) => request<RunListItem[]>(`/api/projects/${e(id)}/runs`),
  projectSpecs: (id: string) => request<{ spec_id: string; title: string; version: string; endpoint_count: number; created_at: string }[]>(`/api/projects/${e(id)}/specs`),

  // environments
  createEnvironment: (projectId: string, body: { name: string; base_url: string; variables?: EnvVarIn[]; is_default?: boolean }) =>
    request<Environment>(`/api/projects/${e(projectId)}/environments`, { method: "POST", ...j(body) }),
  updateEnvironment: (id: string, body: { name?: string; base_url?: string; variables?: EnvVarIn[]; is_default?: boolean }) =>
    request<Environment>(`/api/environments/${e(id)}`, { method: "PATCH", ...j(body) }),
  deleteEnvironment: (id: string) => request<{ ok: true }>(`/api/environments/${e(id)}`, { method: "DELETE" }),

  // collections and folders
  createCollection: (projectId: string, body: { name: string; description?: string }) =>
    request<CollectionNode>(`/api/projects/${e(projectId)}/collections`, { method: "POST", ...j(body) }),
  updateCollection: (id: string, body: { name?: string; description?: string }) => request<CollectionNode>(`/api/collections/${e(id)}`, { method: "PATCH", ...j(body) }),
  deleteCollection: (id: string) => request<{ ok: true }>(`/api/collections/${e(id)}`, { method: "DELETE" }),
  createFolder: (collectionId: string, body: { name: string; parent_id?: string | null }) =>
    request<FolderNode>(`/api/collections/${e(collectionId)}/folders`, { method: "POST", ...j(body) }),
  updateFolder: (id: string, body: { name?: string; parent_id?: string | null }) => request<FolderNode>(`/api/folders/${e(id)}`, { method: "PATCH", ...j(body) }),
  deleteFolder: (id: string) => request<{ ok: true }>(`/api/folders/${e(id)}`, { method: "DELETE" }),
  importSpec: (projectId: string, body: { spec_id: string; collection_name?: string; group_by_tag?: boolean }) =>
    request<CollectionNode>(`/api/projects/${e(projectId)}/import`, { method: "POST", ...j(body) }),

  // items
  createItem: (collectionId: string, body: { kind: ItemKind; name: string; folder_id?: string | null; request?: SavedRequest; suite?: SavedSuite }) =>
    request<Item>(`/api/collections/${e(collectionId)}/items`, { method: "POST", ...j(body) }),
  item: (id: string) => request<Item>(`/api/items/${e(id)}`),
  updateItem: (id: string, body: { name?: string; request?: SavedRequest; suite?: SavedSuite }) => request<Item>(`/api/items/${e(id)}`, { method: "PATCH", ...j(body) }),
  moveItem: (id: string, body: { collection_id: string; folder_id: string | null; position?: number | null }) =>
    request<Item>(`/api/items/${e(id)}/move`, { method: "POST", ...j(body) }),
  duplicateItem: (id: string) => request<Item>(`/api/items/${e(id)}/duplicate`, { method: "POST" }),
  deleteItem: (id: string) => request<{ ok: true }>(`/api/items/${e(id)}`, { method: "DELETE" }),

  // sending and running
  send: (body: { environment_id: string; request: SavedRequest }) => request<SendResult>("/api/requests/send", { method: "POST", ...j(body) }),
  runCollection: (id: string, body: { environment_id: string; allow_destructive?: boolean }) =>
    request<Run>(`/api/collections/${e(id)}/run`, { method: "POST", ...j(body) }),
  runFolder: (id: string, body: { environment_id: string; allow_destructive?: boolean }) => request<Run>(`/api/folders/${e(id)}/run`, { method: "POST", ...j(body) }),

  // planning
  inspectForProject: (projectId: string, input: { spec_url?: string; spec_text?: string }) =>
    request<{ api: import("./api").ApiSummary; suggested_base_url: string | null }>("/api/specs/inspect", {
      method: "POST",
      ...j({ ...input, project_id: projectId }),
    }),
  createPlan: (body: { project_id: string; spec_id: string; environment_id: string; suite_item_id?: string | null; config: PlannerConfig }) =>
    request<TestPlan>("/api/plans", { method: "POST", ...j(body) }), // returns status "planning"; poll api.plan(id)
  addCase: (planId: string, body: Omit<TestCase, "id">) => request<TestPlan>(`/api/plans/${e(planId)}/cases`, { method: "POST", ...j(body) }),
  updateCase: (planId: string, caseId: string, body: Partial<Omit<TestCase, "id">>) =>
    request<TestPlan>(`/api/plans/${e(planId)}/cases/${e(caseId)}`, { method: "PATCH", ...j(body) }),
  deleteCase: (planId: string, caseId: string) => request<TestPlan>(`/api/plans/${e(planId)}/cases/${e(caseId)}`, { method: "DELETE" }),
  refinePlan: (planId: string, body: { instruction: string; endpoint_ids?: string[] }) =>
    request<TestPlan>(`/api/plans/${e(planId)}/refine`, { method: "POST", ...j(body) }), // status goes back to "planning"; poll

  // navigation
  specUsage: (specId: string) => request<SpecUsage>(`/api/specs/${e(specId)}/usage`),
  itemHistory: (itemId: string) => request<ItemHistory>(`/api/items/${e(itemId)}/history`),

  // settings
  settings: () => request<Settings>("/api/settings"),
  updateSettings: (body: SettingsPatch) => request<Settings>("/api/settings", { method: "PUT", ...j(body) }),
  checkAi: () => request<{ ok: boolean; message: string }>("/api/settings/check-ai", { method: "POST" }),
};
