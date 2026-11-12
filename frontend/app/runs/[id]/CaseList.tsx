"use client";

import { Fragment, useState } from "react";
import { formatBody } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import { SOURCES, SourceTag } from "@/components/Source";
import { MethodPath, OutcomeText } from "@/components/Status";
import type { CaseResult, Source, TestCase } from "@/lib/api";
import styles from "../runs.module.css";
import { BodyPreview, CheckList, WhyThisCase, checkWords, findingId, firstFailure } from "./Finding";

export const OUTCOME_FILTERS = [
  { key: "all", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "passed", label: "Passed" },
  { key: "skipped", label: "Skipped" },
] as const;
export type OutcomeFilter = (typeof OUTCOME_FILTERS)[number]["key"];

export const SOURCE_FILTERS: { key: "all" | Source; label: string }[] = [
  { key: "all", label: "All sources" },
  { key: "ai", label: SOURCES.ai.label },
  { key: "contract", label: SOURCES.contract.label },
  { key: "fuzz", label: SOURCES.fuzz.label },
  { key: "saved", label: SOURCES.saved.label },
];
export type SourceFilter = "all" | Source;

const OUTCOME_ICON = {
  passed: { icon: "check", label: "Passed" },
  failed: { icon: "cross", label: "Failed" },
  error: { icon: "alert", label: "Error" },
  skipped: { icon: "minus", label: "Skipped" },
  pending: { icon: "minus", label: "Pending" },
} as const;

/** "Expected 404, got 200", or why there is no answer to compare. */
function expectedVsGot(c: TestCase, r: CaseResult | undefined): string {
  const expected = `Expected ${c.expected_status.join(" or ")}`;
  if (!r) return `${expected}, not run yet`;
  if (r.outcome === "skipped") return r.note || "Skipped";
  if (!r.exchange || r.exchange.status == null) return `${expected}, no response${r.note ? `: ${r.note}` : ""}`;
  const got = `${expected}, got ${r.exchange.status}`;
  if (r.outcome === "failed" && c.expected_status.includes(r.exchange.status)) {
    const check = firstFailure(r);
    return check ? `${got}, but the ${checkWords(check.name)} check failed` : got;
  }
  return got;
}

function CaseDetail({ testCase, result }: { testCase: TestCase; result: CaseResult | undefined }) {
  const ex = result?.exchange ?? null;
  return (
    <div className={styles.caseDetail}>
      <div className={styles.detailPart}>
        <h4>Why this case</h4>
        <WhyThisCase testCase={testCase} />
      </div>
      {ex ? (
        <div className={styles.detailPair}>
          <div className={styles.detailPart}>
            <h4>Request</h4>
            <div className="graphite">
              <p className={styles.paneUrl}>
                <span className="method">{ex.method}</span> {ex.url}
              </p>
              <BodyPreview body={ex.request_body == null ? "No body" : formatBody(ex.request_body)} lines={8} />
            </div>
          </div>
          <div className={styles.detailPart}>
            <h4>
              Response {ex.status ?? "none"}
              {ex.duration_ms != null && <span className={styles.detailTime}> in {Math.round(ex.duration_ms)} ms</span>}
            </h4>
            <div className="graphite">
              {ex.error && <p className={styles.paneError}>{ex.error}</p>}
              {ex.status != null && <BodyPreview body={formatBody(ex.response_body)} lines={8} />}
            </div>
          </div>
        </div>
      ) : (
        <p className="small muted">{result?.note || "This case has not run yet."}</p>
      )}
      {result && (
        <div className={styles.detailPart}>
          <h4>Checks</h4>
          <CheckList checks={result.checks} />
        </div>
      )}
    </div>
  );
}

interface EndpointGroup {
  endpoint: string;
  cases: TestCase[];
}

function groupByEndpoint(cases: TestCase[]): EndpointGroup[] {
  const groups = new Map<string, TestCase[]>();
  for (const c of cases) groups.set(c.endpoint_id, [...(groups.get(c.endpoint_id) ?? []), c]);
  return [...groups.entries()].map(([endpoint, list]) => ({ endpoint, cases: list }));
}

export function CaseList({
  cases,
  results,
  onGoToFinding,
}: {
  cases: TestCase[];
  results: Map<string, CaseResult>;
  onGoToFinding: (caseId: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="table-scroll">
      <table className={`ledger ${styles.caseTable}`}>
        <thead>
          <tr>
            <th>Case</th>
            <th className={styles.outcomeCol}>Result</th>
            <th>Made by</th>
            <th>Expected and actual</th>
            <th className="num">Time, ms</th>
          </tr>
        </thead>
        {groupByEndpoint(cases).map((g) => {
          const failed = g.cases.filter((c) => results.get(c.id)?.outcome === "failed").length;
          return (
            <tbody key={g.endpoint}>
              <tr className={styles.groupRow}>
                <th colSpan={5} scope="rowgroup">
                  <span className={styles.groupLabel}>
                    <MethodPath id={g.endpoint} />
                    <span className={styles.groupCount}>
                      {g.cases.length} {g.cases.length === 1 ? "case" : "cases"}
                      {failed > 0 && <span className={styles.codeFailed}>, {failed} failed</span>}
                    </span>
                  </span>
                </th>
              </tr>
              {g.cases.map((c) => {
                const r = results.get(c.id);
                const outcome = r?.outcome ?? "pending";
                const icon = OUTCOME_ICON[outcome];
                const isOpen = open.has(c.id);
                const detailId = `case-detail-${c.id}`;
                return (
                  <Fragment key={c.id}>
                    <tr className={isOpen ? styles.rowOpen : undefined}>
                      <td className={styles.caseName}>
                        <span className={styles.caseCell}>
                          <button
                            type="button"
                            className={styles.rowToggle}
                            aria-expanded={isOpen}
                            aria-controls={detailId}
                            aria-label={`${isOpen ? "Hide" : "Show"} details for ${c.name}`}
                            onClick={() => toggle(c.id)}
                          >
                            <Icon name="chevron" size={12} />
                          </button>
                          <span className={`status status--${outcome} ${styles.outcomeIcon}`}>
                            <Icon name={icon.icon} label={icon.label} />
                          </span>
                          <span className={styles.caseText}>
                            {outcome === "failed" ? (
                              <a
                                href={`#${findingId(c.id)}`}
                                className={styles.caseLink}
                                onClick={(e) => {
                                  e.preventDefault();
                                  onGoToFinding(c.id);
                                }}
                              >
                                {c.name}
                              </a>
                            ) : (
                              <span>{c.name}</span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td className={styles.outcomeCol}>
                        <OutcomeText outcome={outcome} />
                      </td>
                      <td>
                        <SourceTag source={c.source} />
                      </td>
                      <td className={styles.expectCell}>{expectedVsGot(c, r)}</td>
                      <td className="num">{r?.exchange?.duration_ms != null ? Math.round(r.exchange.duration_ms) : ""}</td>
                    </tr>
                    {isOpen && (
                      <tr id={detailId} className={styles.detailRow}>
                        <td colSpan={5}>
                          <CaseDetail testCase={c} result={r} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
