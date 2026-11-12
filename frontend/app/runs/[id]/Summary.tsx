import { Icon } from "@/components/Icon";
import { ExplainedBy, SourceLegend, SourceTag } from "@/components/Source";
import type { CaseResult, Run, Source } from "@/lib/api";
import { formatDuration, seconds } from "../format";
import styles from "../runs.module.css";
import { groupTitle, type FindingGroup } from "./Finding";

const ORDER: Source[] = ["ai", "contract", "fuzz", "saved"];
const SEV_WORD = { critical: "critical", high: "high", medium: "medium", low: "low" } as const;

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

interface SourceRow {
  source: Source;
  cases: number;
  passed: number;
  failed: number;
  other: number;
}

function sourceRows(run: Run, results: Map<string, CaseResult>): SourceRow[] {
  const rows = new Map<Source, SourceRow>();
  for (const c of run.cases) {
    const row = rows.get(c.source) ?? { source: c.source, cases: 0, passed: 0, failed: 0, other: 0 };
    row.cases += 1;
    const outcome = results.get(c.id)?.outcome;
    if (outcome === "passed") row.passed += 1;
    else if (outcome === "failed") row.failed += 1;
    else row.other += 1;
    rows.set(c.source, row);
  }
  return ORDER.filter((s) => rows.has(s)).map((s) => rows.get(s) as SourceRow);
}

/** The opening paragraph of the report, composed from the run itself. */
function sentences(run: Run, results: Map<string, CaseResult>, findings: FindingGroup[], active: boolean): string[] {
  const total = run.counts.total || run.cases.length;
  const where = run.environment_name ? `against ${run.environment_name}` : `against ${run.base_url}`;
  const out: string[] = [];
  if (active) {
    out.push(`${run.results.length} of ${plural(total, "case")} have finished ${where} so far.`);
  } else {
    out.push(`${plural(total, "case")} ran ${where} in ${formatDuration(seconds(run.created_at, run.finished_at))}.`);
  }

  const { passed, failed, skipped, error } = run.counts;
  const parts: string[] = [];
  if (passed) parts.push(`${passed} passed`);
  if (failed) parts.push(`${failed} failed`);
  if (skipped) {
    const destructive = [...results.values()].some((r) => r.outcome === "skipped" && r.note.toLowerCase().includes("destructive"));
    parts.push(`${skipped} ${skipped === 1 ? "was" : "were"} skipped${destructive ? " because destructive requests were off" : ""}`);
  }
  if (error) parts.push(`${error} could not run`);
  if (parts.length) out.push(`${sentenceCase(joinWords(parts))}.`);

  if (findings.length && !active) {
    const worst = findings[0];
    const causes = findings.length === 1 ? "one cause" : `${findings.length} causes`;
    out.push(
      `The ${plural(failed, "failure")} come from ${causes}; the most severe, rated ${SEV_WORD[worst.severity]}, is ${lowerFirst(groupTitle(worst))}.`,
    );
  } else if (!active && !failed) {
    out.push("No case failed.");
  }
  return out;
}

function sentenceCase(t: string) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function lowerFirst(t: string) {
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

export function Summary({
  run,
  results,
  findings,
  active,
}: {
  run: Run;
  results: Map<string, CaseResult>;
  findings: FindingGroup[];
  active: boolean;
}) {
  const rows = sourceRows(run, results);
  const failedResults = [...results.values()].filter((r) => r.outcome === "failed");
  const byClaude = failedResults.filter((r) => r.analysis?.source === "ai").length;
  const byRules = failedResults.filter((r) => r.analysis && r.analysis.source !== "ai").length;
  const counts = Object.fromEntries(rows.map((r) => [r.source, r.cases])) as Partial<Record<Source, number>>;

  let fuzzLine: string | null = null;
  if (run.fuzz_status === "running") fuzzLine = "Schemathesis is fuzzing the API with generated requests.";
  else if (run.fuzz_status === "ok" || run.fuzz_status === "error") {
    fuzzLine = `Schemathesis sent ${run.fuzz_examples_run} generated requests.${run.fuzz_message ? ` ${run.fuzz_message}` : ""}`;
  }
  const extraMessage = run.message && !run.message.startsWith("Failure explanations are rule-based") ? run.message : null;

  return (
    <section id="summary" className={styles.reportSection} aria-labelledby="summary-head">
      <h2 id="summary-head">Summary</h2>
      <div className={styles.summaryProse}>
        {sentences(run, results, findings, active).map((s) => (
          <p key={s}>{s}</p>
        ))}
      </div>

      <div className={styles.summaryBlock}>
        <h3>Where the cases came from</h3>
        <div className="table-scroll">
          <table className={`ledger ${styles.sourceTable}`}>
            <thead>
              <tr>
                <th>Made by</th>
                <th className="num">Cases</th>
                <th className="num">Passed</th>
                <th className="num">Failed</th>
                <th className="num">Skipped or not run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.source}>
                  <td>
                    <SourceTag source={r.source} withGroup />
                  </td>
                  <td className="num">{r.cases}</td>
                  <td className={`num ${r.passed ? styles.codePassed : styles.codeMuted}`}>{r.passed}</td>
                  <td className={`num ${r.failed ? styles.codeFailed : styles.codeMuted}`}>{r.failed}</td>
                  <td className={`num ${styles.codeMuted}`}>{r.other}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <SourceLegend counts={counts} />
      </div>

      {(failedResults.length > 0 || fuzzLine || extraMessage) && (
        <div className={styles.summaryBlock}>
          <h3>How failures were explained</h3>
          {failedResults.length > 0 && (
            <p className={styles.explainLine}>
              {byClaude > 0 && (
                <span>
                  <ExplainedBy source="ai" />
                  <span className={styles.explainCount}>{plural(byClaude, "failure")}</span>
                </span>
              )}
              {byRules > 0 && (
                <span>
                  <ExplainedBy source="rules" />
                  <span className={styles.explainCount}>{plural(byRules, "failure")}</span>
                </span>
              )}
            </p>
          )}
          {byRules > 0 && byClaude === 0 && (
            <p className="small muted">Turn on AI in Settings and Claude explains each failure from the request, the response and your rules.</p>
          )}
          {fuzzLine && (
            <p className={styles.runNote}>
              <Icon name="dice" />
              <span>{fuzzLine}</span>
            </p>
          )}
          {extraMessage && (
            <p className={styles.runNote}>
              <Icon name="alert" />
              <span>{extraMessage}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
