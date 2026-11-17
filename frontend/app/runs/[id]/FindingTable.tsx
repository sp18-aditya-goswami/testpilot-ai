"use client";

import { useRouter } from "next/navigation";
import { Fragment, useId, useState } from "react";
import { CodeBlock, formatBody } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import { ExplainedBy, SourceTag } from "@/components/Source";
import { MethodPath } from "@/components/Status";
import { api, errorMessage, type Fix, type Run } from "@/lib/api";
import { flowHref } from "@/lib/testplans";
import { runHref } from "../format";
import styles from "../runs.module.css";
import { expectedVsGot } from "./CaseList";
import { BodyPreview, CheckList, SeverityText, WhyThisCase, firstFailure, groupAnchor, groupTitle, type FindingGroup, type FindingItem } from "./Finding";

type Tab = "request" | "response" | "checks" | "fix";
const TABS: { id: Tab; label: string }[] = [
  { id: "request", label: "Request" },
  { id: "response", label: "Response" },
  { id: "checks", label: "Checks" },
  { id: "fix", label: "Fix" },
];

/** AI text with `names` in backticks, shown as code. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <code key={i} className="mono">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const FAULT: Record<Fix["fault"], string> = {
  api: "The API needs to change",
  test: "The test expected the wrong thing",
  spec: "The spec is out of date",
};

/** What to fix, most severe first: one row per root cause, opened in place. */
export function FindingTable({
  run,
  findings,
  open,
  onToggle,
  flow,
}: {
  run: Run;
  findings: FindingGroup[];
  open: string | null;
  onToggle: (key: string) => void;
  flow: boolean;
}) {
  return (
    <div className="table-scroll">
      <table className={`ledger ${styles.fixTable}`}>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Problem</th>
            <th>Endpoint</th>
            <th>Made by</th>
            <th>
              <span className="visually-hidden">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {findings.map((g) => {
            const isOpen = open === g.key;
            const endpoints = [...new Set(g.members.map((m) => m.testCase.endpoint_id))];
            const sources = [...new Set(g.members.map((m) => m.testCase.source))];
            const detailId = `detail-${groupAnchor(g)}`;
            return (
              <Fragment key={g.key}>
                <tr id={groupAnchor(g)} className={`${styles.fixRow} ${isOpen ? styles.rowOpen : ""}`}>
                  <td>
                    <SeverityText severity={g.severity} />
                  </td>
                  <td>
                    <span className={styles.fixProblem}>
                      <button type="button" className={styles.fixTitle} aria-expanded={isOpen} aria-controls={detailId} onClick={() => onToggle(g.key)}>
                        {groupTitle(g)}
                      </button>
                      {g.members.length > 1 && <span className={styles.fixCount}>{g.members.length} failed cases</span>}
                    </span>
                  </td>
                  <td className={styles.fixEndpoint}>{endpoints.length === 1 ? <MethodPath id={endpoints[0]} /> : <span>{endpoints.length} endpoints</span>}</td>
                  <td>
                    <span className={styles.fixSources}>
                      {sources.map((s) => (
                        <SourceTag key={s} source={s} />
                      ))}
                    </span>
                  </td>
                  <td className={styles.fixToggleCell}>
                    <button type="button" className="key key--plain" aria-expanded={isOpen} aria-controls={detailId} onClick={() => onToggle(g.key)}>
                      {isOpen ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
                {isOpen && (
                  <tr id={detailId} className={styles.detailRow}>
                    <td colSpan={5}>
                      <FindingDetail group={g} run={run} flow={flow} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FindingDetail({ group, run, flow }: { group: FindingGroup; run: Run; flow: boolean }) {
  const [index, setIndex] = useState(0);
  const [tab, setTab] = useState<Tab>("request");
  const pickId = useId();
  const tabsId = useId();
  const item = group.members[Math.min(index, group.members.length - 1)];
  const { testCase, result } = item;
  const a = result.analysis;
  const check = firstFailure(result);

  return (
    <div className={styles.fixDetail}>
      {group.members.length > 1 && (
        <div className={styles.fixPick}>
          <label htmlFor={pickId} className="label">
            Failed case {index + 1} of {group.members.length}
          </label>
          <select id={pickId} className="input" value={index} onChange={(e) => setIndex(Number(e.target.value))}>
            {group.members.map((m, i) => (
              <option key={m.testCase.id} value={i}>
                {m.testCase.endpoint_id}: {m.testCase.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <dl className={styles.fixFacts}>
        <div>
          <dt>What happened</dt>
          <dd>
            <Rich text={a?.summary ?? (check ? check.detail : result.note || "The case failed.")} />
          </dd>
        </div>
        <div>
          <dt>Expected vs got</dt>
          <dd>{expectedVsGot(testCase, result)}</dd>
        </div>
        {a && (
          <div>
            <dt>Likely cause</dt>
            <dd>
              <Rich text={a.likely_cause} /> <ExplainedBy source={a.source} />
            </dd>
          </div>
        )}
      </dl>

      <div className="tray" role="tablist" aria-label="Finding details">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${tabsId}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${tabsId}-panel`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} className={styles.fixPanel}>
        {tab === "request" && <RequestTab item={item} />}
        {tab === "response" && <ResponseTab item={item} />}
        {tab === "checks" && (
          <>
            <CheckList checks={result.checks} />
            <div className={styles.part}>
              <h4 className={styles.fixSub}>Why this case exists</h4>
              <WhyThisCase testCase={testCase} />
            </div>
          </>
        )}
        {tab === "fix" && <FixTab key={testCase.id} item={item} run={run} flow={flow} />}
      </div>
    </div>
  );
}

function RequestTab({ item }: { item: FindingItem }) {
  const ex = item.result.exchange;
  const setup = item.result.setup_exchanges;
  if (!ex) return <p className="small muted">{item.result.note || "The request never completed."}</p>;
  return (
    <>
      <div className="graphite">
        <p className={styles.paneUrl}>
          <span className={`method method--${ex.method.toLowerCase()}`}>{ex.method}</span> {ex.url}
        </p>
        <BodyPreview body={ex.request_body == null ? "No body" : formatBody(ex.request_body)} />
      </div>
      {setup.length > 0 && (
        <details className={styles.setup}>
          <summary>
            Sent before it to set up, {setup.length} {setup.length === 1 ? "request" : "requests"}
          </summary>
          <ul className={styles.setupList}>
            {setup.map((s, i) => (
              <li key={i} className="small">
                <span className={`method method--${s.method.toLowerCase()}`}>{s.method}</span> <span className="mono">{s.url}</span>, got {s.status ?? "no response"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function ResponseTab({ item }: { item: FindingItem }) {
  const ex = item.result.exchange;
  if (!ex) return <p className="small muted">{item.result.note || "No response came back."}</p>;
  return (
    <div className="graphite">
      <div className={styles.paneHead}>
        <span className={styles.paneLabel}>{ex.duration_ms != null ? `Status, in ${Math.round(ex.duration_ms)} ms` : "Status"}</span>
        <span className="figure">{ex.status ?? "None"}</span>
      </div>
      {ex.error && <p className={styles.paneError}>{ex.error}</p>}
      {ex.status != null && <BodyPreview body={formatBody(ex.response_body)} />}
    </div>
  );
}

function FixTab({ item, run, flow }: { item: FindingItem; run: Run; flow: boolean }) {
  const router = useRouter();
  const [fix, setFix] = useState<Fix | null>(item.result.fix ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const steps = item.result.analysis?.investigation_steps ?? [];
  const canRerun = !!run.plan_id && item.testCase.source !== "fuzz";

  async function showFix() {
    setBusy(true);
    setError(null);
    try {
      setFix(await api.suggestFix(run.id, item.testCase.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rerun() {
    if (!run.plan_id) return;
    setRerunning(true);
    setError(null);
    try {
      const next = await api.startRun(run.plan_id, { case_ids: [item.testCase.id], allow_destructive: run.allow_destructive, fuzz: false, fuzz_examples: 20 });
      router.push(flow ? flowHref.run(next.id) : runHref(next));
    } catch (err) {
      setError(errorMessage(err));
      setRerunning(false);
    }
  }

  return (
    <div className={styles.fixBody}>
      {!fix && (
        <>
          {steps.length > 0 && (
            <div className={styles.part}>
              <h4 className={styles.fixSub}>What to check first</h4>
              <ol className={styles.steps}>
                {steps.map((s) => (
                  <li key={s}>
                    <Rich text={s} />
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className={styles.fixAsk}>
            <button type="button" className="key key--primary" onClick={showFix} disabled={busy} aria-busy={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="spark" />}
              {busy ? "The AI is working out a fix" : "Show fix"}
            </button>
            <span className="small muted">The AI reads the spec, the request, the response and your rules. Asked once, then kept with this run.</span>
          </div>
        </>
      )}

      {fix && (
        <>
          <p className={styles.fault}>
            <span className={`${styles.faultWord} ${styles[`fault_${fix.fault}`]}`}>{FAULT[fix.fault]}.</span> <Rich text={fix.fault_reason} />
          </p>
          {fix.steps.length > 0 && (
            <div className={styles.part}>
              <h4 className={styles.fixSub}>Steps</h4>
              <ol className={styles.steps}>
                {fix.steps.map((s) => (
                  <li key={s}>
                    <Rich text={s} />
                  </li>
                ))}
              </ol>
            </div>
          )}
          {fix.code.trim() && (
            <div className={styles.part}>
              <h4 className={styles.fixSub}>
                <span className="src src--ai">
                  <Icon name="spark" />
                  Suggested by AI, check before applying
                </span>
              </h4>
              {fix.code_caption && (
                <p className="small muted">
                  <Rich text={fix.code_caption} />
                </p>
              )}
              <CodeBlock title={fix.code_language || "code"} code={fix.code} copy />
            </div>
          )}
          {fix.spec_change.trim() && (
            <div className={styles.part}>
              <h4 className={styles.fixSub}>Change to the OpenAPI spec</h4>
              <CodeBlock title="openapi.yaml" code={fix.spec_change} copy />
            </div>
          )}
          <div className={styles.fixAsk}>
            {canRerun && (
              <button type="button" className="key" onClick={rerun} disabled={rerunning} aria-busy={rerunning}>
                {rerunning ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" />}
                {rerunning ? "Starting" : "Re-run this case"}
              </button>
            )}
            {fix.confirm && (
              <span className="small muted">
                <Rich text={fix.confirm} />
              </span>
            )}
          </div>
        </>
      )}

      {item.result.regression_test && (
        <details className={styles.regression}>
          <summary>Regression test, pytest</summary>
          <CodeBlock title="test_regression.py" code={item.result.regression_test} copy />
        </details>
      )}

      {error && (
        <p className="helper is-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
