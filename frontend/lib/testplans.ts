import { request, type ApiSummary, type RunListItem, type TestPlan } from "./api";
import type { PlannerConfig } from "./workspace";

/** Step 1 of the guided flow: the API under test, found or created as a project and environment. */
export interface StartIn {
  spec_url?: string;
  spec_text?: string;
  base_url: string;
  token?: string;
  project_id?: string;
}

export interface StartOut {
  project_id: string;
  project_name: string;
  environment_id: string;
  environment_name: string;
  has_token: boolean;
  api: ApiSummary;
}

export interface TestPlanIn {
  project_id: string;
  environment_id: string;
  spec_id: string;
  name?: string;
  config: PlannerConfig;
}

export interface TestPlanOut {
  suite_item_id: string;
  plan: TestPlan;
}

/** One saved test plan (a suite item) with its latest plan and run. */
export interface TestPlanRow {
  suite_item_id: string;
  name: string;
  project_id: string;
  project_name: string;
  spec_id: string | null;
  spec_title: string | null;
  last_plan_id: string | null;
  plan_status: "planning" | "ready" | "failed" | null;
  case_count: number;
  ai_case_count: number;
  last_run: RunListItem | null;
  updated_at: string;
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const testPlans = {
  list: () => request<TestPlanRow[]>("/api/test-plans"),
  start: (body: StartIn) => request<StartOut>("/api/test-plans/start", json(body)),
  create: (body: TestPlanIn) => request<TestPlanOut>("/api/test-plans", json(body)),
};

/** Where the flow's screens live, so every link agrees. */
export const flowHref = {
  list: "/plans",
  start: "/plans/new",
  edit: (suiteItemId: string) => `/plans/new?suite=${encodeURIComponent(suiteItemId)}`,
  fromSpec: (projectId: string, specId: string) => `/plans/new?project=${encodeURIComponent(projectId)}&spec=${encodeURIComponent(specId)}`,
  plan: (planId: string) => `/plans/${encodeURIComponent(planId)}`,
  run: (runId: string) => `/runs/${encodeURIComponent(runId)}`,
};
