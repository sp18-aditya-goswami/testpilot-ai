import { ACTIVE } from "@/app/runs/format";
import type { TestPlanRow } from "@/lib/testplans";
import { flowHref } from "@/lib/testplans";
import { Icon } from "./Icon";

/** Where a saved plan opens: its latest run when there is one, otherwise the plan, otherwise step 2. */
export function planRowHref(row: TestPlanRow): string {
  if (row.last_run) return flowHref.run(row.last_run.id);
  if (row.last_plan_id) return flowHref.plan(row.last_plan_id);
  if (row.spec_id) return flowHref.edit(row.suite_item_id);
  return `/p/${encodeURIComponent(row.project_id)}/suites/${encodeURIComponent(row.suite_item_id)}`;
}

/** A saved plan's latest result in a few words, coloured by outcome. */
export function PlanResult({ row }: { row: TestPlanRow }) {
  const run = row.last_run;
  if (run && ACTIVE.includes(run.status)) {
    return <span className="status status--pending">Running</span>;
  }
  if (run) {
    const bad = run.counts.failed + run.counts.error;
    if (run.status === "failed") return <span className="status status--error">Run stopped</span>;
    if (bad > 0) {
      return (
        <span className="status status--failed">
          <Icon name="cross" />
          {bad} of {run.counts.total} failed
        </span>
      );
    }
    return (
      <span className="status status--passed">
        <Icon name="check" />
        All {run.counts.passed} passed
      </span>
    );
  }
  if (row.plan_status === "planning") return <span className="status status--pending">AI is planning</span>;
  if (row.plan_status === "failed") return <span className="status status--error">Planning failed</span>;
  if (row.last_plan_id) return <span className="status status--skipped">{row.case_count} cases, not run yet</span>;
  return <span className="status status--skipped">{row.spec_id ? "Not planned yet" : "No spec chosen yet"}</span>;
}
