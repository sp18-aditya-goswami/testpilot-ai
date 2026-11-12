import type { RunStatus, Severity } from "@/lib/api";

export const ACTIVE: RunStatus[] = ["queued", "running", "analyzing"];

export const STATUS_WORDS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  analyzing: "Explaining failures",
  completed: "Completed",
  failed: "Stopped",
};

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function seconds(from: string, to?: string | null): number {
  const end = to ? new Date(to).getTime() : Date.now();
  return Math.max(0, (end - new Date(from).getTime()) / 1000);
}

export function formatDuration(s: number): string {
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

export function formatStarted(iso: string): string {
  const d = new Date(iso);
  const ago = seconds(iso);
  if (ago < 60) return "just now";
  if (ago < 3600) return `${Math.floor(ago / 60)} min ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)} h ago`;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const SOURCE_KIND_LABEL = { suite: "Suite", collection: "Collection", folder: "Folder", request: "Request" } as const;

type RunRef = {
  id: string;
  spec_title: string;
  project_id?: string | null;
  source_kind?: keyof typeof SOURCE_KIND_LABEL;
  source_name?: string;
};

/** The project route when the run belongs to a project, the standalone route otherwise. */
export function runHref(r: RunRef): string {
  return r.project_id ? `/p/${r.project_id}/runs/${r.id}` : `/runs/${r.id}`;
}

/** Suites read as their API; collection, folder and request runs say what was run. */
export function runTitle(r: RunRef): string {
  if (!r.source_kind || r.source_kind === "suite" || !r.source_name) return r.spec_title || "Untitled run";
  return `${SOURCE_KIND_LABEL[r.source_kind]}: ${r.source_name}`;
}

export function planHref(planId: string, projectId: string | null | undefined): string {
  return projectId ? `/p/${projectId}/plans/${planId}` : `/plans/${planId}`;
}
