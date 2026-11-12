import type { EndpointStrategy, PlannerConfig } from "./workspace";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Parameter {
  name: string;
  location: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: Record<string, Json>;
  description: string;
}

export interface Endpoint {
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: Parameter[];
  request_body_schema: Record<string, Json> | null;
  request_body_required: boolean;
  responses: Record<string, Record<string, Json> | null>;
  requires_auth: boolean;
}

export interface ApiSummary {
  spec_id: string;
  title: string;
  version: string;
  description: string;
  openapi_version: string;
  server_url: string | null;
  endpoints: Endpoint[];
}

export type Category = "positive" | "negative" | "boundary" | "business" | "security" | "robustness";
export type Source = "contract" | "ai" | "fuzz" | "saved";

export interface RequestSpec {
  method: string;
  path: string;
  path_params: Record<string, Json>;
  query: Record<string, Json>;
  headers: Record<string, string>;
  body: Json;
  raw_body: string | null;
  omit_content_type: boolean;
}

export interface TestCase {
  id: string;
  endpoint_id: string;
  name: string;
  category: Category;
  source: Source;
  rationale: string;
  setup: RequestSpec[];
  request: RequestSpec;
  expected_status: number[];
  destructive: boolean;
}

export interface TestPlan {
  id: string;
  created_at: string;
  project_id: string | null;
  environment_id: string | null;
  suite_item_id: string | null;
  status: "planning" | "ready" | "failed";
  progress: string[];
  config: Partial<PlannerConfig>;
  strategy: EndpointStrategy[];
  review_notes: string[];
  spec_id: string;
  spec_title: string;
  base_url: string;
  instruction: string;
  business_rules: string;
  cases: TestCase[];
  rejected: { name: string; reason: string }[];
  ai_status: "ok" | "disabled" | "error" | "skipped";
  ai_message: string;
}

export interface Exchange {
  method: string;
  url: string;
  request_headers: Record<string, string>;
  request_body: Json;
  status: number | null;
  response_headers: Record<string, string>;
  response_body: Json;
  duration_ms: number | null;
  error: string | null;
}

export interface Check {
  name: string;
  passed: boolean;
  severity: "fail" | "warn";
  detail: string;
}

export type Severity = "critical" | "high" | "medium" | "low";

export interface Analysis {
  title: string;
  severity: Severity;
  summary: string;
  likely_cause: string;
  investigation_steps: string[];
  source: "ai" | "rules";
}

export type Outcome = "passed" | "failed" | "error" | "skipped";

export interface CaseResult {
  case_id: string;
  outcome: Outcome;
  setup_exchanges: Exchange[];
  exchange: Exchange | null;
  checks: Check[];
  analysis: Analysis | null;
  regression_test: string | null;
  note: string;
}

export interface RunCounts {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export type RunStatus = "queued" | "running" | "analyzing" | "completed" | "failed";

export interface Run {
  id: string;
  plan_id: string | null;
  project_id: string | null;
  environment_id: string | null;
  environment_name: string;
  source_kind: "suite" | "collection" | "folder" | "request";
  source_id: string | null;
  source_name: string;
  spec_title: string;
  base_url: string;
  status: RunStatus;
  created_at: string;
  finished_at: string | null;
  allow_destructive: boolean;
  cases: TestCase[];
  results: CaseResult[];
  counts: RunCounts;
  request_count: number;
  message: string;
  fuzz_status: "off" | "running" | "ok" | "error";
  fuzz_message: string;
  fuzz_examples_run: number;
}

export interface RunListItem {
  id: string;
  spec_title: string;
  base_url: string;
  status: RunStatus;
  created_at: string;
  finished_at: string | null;
  counts: RunCounts;
}

export interface Health {
  status: string;
  ai_enabled: boolean;
  model: string | null;
  allowed_hosts: string[];
  limits: { max_concurrency: number; max_requests_per_run: number; request_timeout_s: number };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function detailMessage(detail: unknown): string | null {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
      .join("; ");
  }
  return null;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("The TestPilot backend is not reachable. Start it on port 8001 and retry.", 0);
  }
  if (!res.ok) {
    let message = `Request failed with ${res.status}`;
    try {
      const body = await res.json();
      message = detailMessage(body?.detail) ?? message;
    } catch {
      if (res.status >= 500) message = "The TestPilot backend is not reachable. Start it on port 8001 and retry.";
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<Health>("/api/health"),
  inspect: (input: { spec_url?: string; spec_text?: string }) =>
    request<{ api: ApiSummary; suggested_base_url: string | null }>("/api/specs/inspect", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  spec: (id: string) => request<ApiSummary>(`/api/specs/${encodeURIComponent(id)}`),
  createPlan: (input: {
    spec_id: string;
    base_url: string;
    instruction: string;
    business_rules: string;
    use_contract: boolean;
    use_ai: boolean;
    focus_endpoints: string[];
    max_ai_cases: number;
  }) => request<TestPlan>("/api/plans", { method: "POST", body: JSON.stringify(input) }),
  plan: (id: string) => request<TestPlan>(`/api/plans/${encodeURIComponent(id)}`),
  startRun: (planId: string, input: { case_ids: string[] | null; allow_destructive: boolean; fuzz: boolean; fuzz_examples: number }) =>
    request<Run>(`/api/plans/${encodeURIComponent(planId)}/runs`, { method: "POST", body: JSON.stringify(input) }),
  runs: () => request<RunListItem[]>("/api/runs"),
  run: (id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}`),
  reportHtmlUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/report.html`,
  reportJsonUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/report.json`,
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
