import Link from "next/link";
import type { ReactNode } from "react";
import type { PlanSummary, RunListItem } from "@/lib/workspace";
import { Icon } from "@/components/Icon";
import { OutcomeBar } from "@/components/OutcomeBar";
import styles from "./specs.module.css";

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const STATUS: Record<PlanSummary["status"], string> = { planning: "Planning", ready: "Ready", failed: "Failed" };

/** "21 passed, 7 failed" beside a compact bar of the same counts. */
export function RunResult({ run }: { run: RunListItem }) {
  const c = run.counts;
  if (run.status !== "completed" && run.status !== "failed") return <span className="status status--pending">Running</span>;
  return (
    <span className={styles.result}>
      <span className={styles.resultBar}>
        <OutcomeBar counts={c} legend={false} />
      </span>
      <span>
        {c.passed} passed, <span className={c.failed > 0 ? "status--failed" : undefined}>{c.failed} failed</span>
      </span>
    </span>
  );
}

/**
 * Plans, newest first. `suiteName` adds a column naming each plan's suite (the spec page lists plans from several);
 * `result` shows the run of that plan when one is known. "From Claude" appears only when some plan has AI cases.
 */
export function PlanList({
  projectId,
  plans,
  suiteName,
  result,
}: {
  projectId: string;
  plans: PlanSummary[];
  suiteName?: (p: PlanSummary) => string;
  result?: (p: PlanSummary) => ReactNode;
}) {
  const anyAi = plans.some((p) => p.ai_case_count > 0);
  return (
    <div className={`panel ${styles.listPanel}`}>
      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th>{suiteName ? "Suite" : "Plan"}</th>
              {suiteName && <th>Planned</th>}
              <th className="num">Cases</th>
              {anyAi && <th className="num">From Claude</th>}
              <th>Status</th>
              {result && <th>Latest run</th>}
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link href={`/p/${projectId}/plans/${p.id}`} className={styles.rowLink}>
                    {suiteName ? suiteName(p) : `Planned ${formatWhen(p.created_at)}`}
                  </Link>
                </td>
                {suiteName && <td className="muted">{formatWhen(p.created_at)}</td>}
                <td className="num">{p.case_count}</td>
                {anyAi && (
                  <td className="num">
                    {p.ai_case_count > 0 ? (
                      <span className="src src--ai">
                        <Icon name="spark" />
                        {p.ai_case_count}
                      </span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                )}
                <td className={p.status === "failed" ? "status status--failed" : p.status === "planning" ? "status status--pending" : undefined}>
                  {STATUS[p.status]}
                </td>
                {result && <td>{result(p) ?? <span className="muted">Not run</span>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
