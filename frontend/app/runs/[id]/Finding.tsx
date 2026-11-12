"use client";

import { useState } from "react";
import { CodeBlock, formatBody } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import { ExplainedBy, SourceTag } from "@/components/Source";
import { MethodPath } from "@/components/Status";
import type { Analysis, CaseResult, Check, Exchange, Severity, TestCase } from "@/lib/api";
import { SEVERITY_ORDER } from "../format";
import styles from "../runs.module.css";

const SEV_WORD: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export function SeverityText({ severity }: { severity: Severity }) {
  return (
    <span className={`sev sev--${severity}`}>
      <Icon name={severity === "low" ? "minus" : "alert"} />
      {SEV_WORD[severity]}
    </span>
  );
}

const CHECK_WORDS: Record<string, string> = {
  "status code": "status code",
  status_code_conformance: "status code",
  "response schema": "response schema",
  response_schema_conformance: "response schema",
  "body schema": "body schema",
  "no server error": "server error",
  not_a_server_error: "server error",
  content_type_conformance: "content type",
  negative_data_rejection: "invalid input accepted",
  positive_data_acceptance: "valid input rejected",
  "request completed": "no response",
  "status documented": "status documented",
  latency: "response time",
  "time limit": "time limit",
};

const GROUP_TITLE: Record<string, string> = {
  "status code": "Status code outside the contract",
  "response schema": "Response violates the schema",
  "body schema": "Response body breaks the asserted schema",
  "server error": "Server error",
  "content type": "Wrong content type",
  "invalid input accepted": "Invalid input accepted",
  "valid input rejected": "Valid input rejected",
  "no response": "No response",
  "time limit": "Response slower than the limit",
};

export function checkWords(name: string): string {
  return CHECK_WORDS[name] ?? name.replace(/_/g, " ");
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function findingId(caseId: string) {
  return `finding-${caseId}`;
}

export interface FindingItem {
  testCase: TestCase;
  result: CaseResult;
}

export interface FindingGroup {
  key: string;
  members: FindingItem[];
  severity: Severity;
  check: string | null;
}

export function firstFailure(result: CaseResult): Check | undefined {
  return result.checks.find((c) => !c.passed && c.severity === "fail");
}

function groupKey(item: FindingItem): string {
  const a = item.result.analysis;
  const check = firstFailure(item.result);
  if (!a || !check) return `single:${item.testCase.id}`;
  return [a.source, a.likely_cause, a.investigation_steps.join("|"), check.name].join("::");
}

export function groupFindings(items: FindingItem[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const item of items) {
    const key = groupKey(item);
    const severity = item.result.analysis?.severity ?? "low";
    const g = groups.get(key);
    if (g) {
      g.members.push(item);
      if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[g.severity]) g.severity = severity;
    } else {
      const check = firstFailure(item.result);
      groups.set(key, { key, members: [item], severity, check: check ? checkWords(check.name) : null });
    }
  }
  return [...groups.values()].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s) return s;
    return b.members.length - a.members.length || a.members[0].testCase.name.localeCompare(b.members[0].testCase.name);
  });
}

export function groupTitle(group: FindingGroup): string {
  if (group.members.length === 1) {
    const { testCase, result } = group.members[0];
    return result.analysis?.title ?? testCase.name;
  }
  const endpoints = new Set(group.members.map((m) => m.testCase.endpoint_id)).size;
  const where = endpoints > 1 ? `on ${endpoints} endpoints` : `in ${group.members.length} cases`;
  return `${GROUP_TITLE[group.check ?? ""] ?? `The ${group.check} check failed`} ${where}`;
}

export function groupAnchor(group: FindingGroup): string {
  const id = group.members[0].testCase.id;
  return group.members.length === 1 ? findingId(id) : `group-${id}`;
}

/** A dark well with the first lines of a body and a toggle for the rest. */
export function BodyPreview({ body, lines = 12 }: { body: string; lines?: number }) {
  const [full, setFull] = useState(false);
  const all = body.split("\n");
  const long = all.length > lines;
  return (
    <div className={styles.paneBody}>
      <pre className="code">{long && !full ? all.slice(0, lines).join("\n") : body}</pre>
      {long && (
        <button type="button" className={`key key--plain ${styles.paneMore}`} aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? `Show the first ${lines} lines` : `Show all ${all.length} lines`}
        </button>
      )}
    </div>
  );
}

function Pane({
  label,
  figure,
  failed,
  url,
  method,
  body,
  error,
  lines,
}: {
  label: string;
  figure?: string;
  failed?: string;
  url?: string;
  method?: string;
  body: string | null;
  error?: string | null;
  lines?: number;
}) {
  return (
    <section className={`graphite ${styles.pane}`} aria-label={label}>
      <div className={styles.paneHead}>
        <span className={styles.paneLabel}>{label}</span>
        {(failed || figure) && (
          <span className={styles.paneVerdict}>
            {failed && (
              <span className={styles.paneFail}>
                <Icon name="cross" size={16} />
                {failed}
              </span>
            )}
            {figure && <span className="figure">{figure}</span>}
          </span>
        )}
      </div>
      <div>
        {url && (
          <p className={styles.paneUrl}>
            <span className={`method method--${(method ?? "").toLowerCase()}`}>{method}</span> {url}
          </p>
        )}
        {error && <p className={styles.paneError}>{error}</p>}
        {body !== null && <BodyPreview body={body} lines={lines} />}
      </div>
    </section>
  );
}

export function ExchangeView({ exchange, failedCheck, lines }: { exchange: Exchange; failedCheck?: Check; lines?: number }) {
  const requestBody = exchange.request_body === null || exchange.request_body === undefined ? null : formatBody(exchange.request_body);
  const responseBody = exchange.status === null ? null : formatBody(exchange.response_body);
  return (
    <div className={styles.exchange}>
      <Pane label="Request" method={exchange.method} url={exchange.url} body={requestBody ?? "No body"} lines={lines} />
      <Pane
        label={exchange.duration_ms != null ? `Response in ${Math.round(exchange.duration_ms)} ms` : "Response"}
        figure={exchange.status != null ? String(exchange.status) : "None"}
        failed={failedCheck ? checkWords(failedCheck.name) : undefined}
        body={responseBody}
        error={exchange.error}
        lines={lines}
      />
    </div>
  );
}

/** Every check the case ran, each in words: what it looked at and what it found. */
export function CheckList({ checks, onlyProblems = false }: { checks: Check[]; onlyProblems?: boolean }) {
  if (!checks.length) return <p className="small muted">No checks ran because no response came back.</p>;
  const shown = onlyProblems ? checks.filter((c) => !c.passed) : checks;
  return (
    <ul className={styles.checks}>
      {shown.map((c, i) => {
        const state = c.passed ? "pass" : c.severity === "fail" ? "fail" : "warn";
        const word = state === "pass" ? "Passed" : state === "fail" ? "Failed" : "Warning";
        return (
          <li key={`${c.name}-${i}`} className={styles[`check_${state}`]}>
            <Icon name={state === "pass" ? "check" : state === "fail" ? "cross" : "alert"} label={word} />
            <span>
              <span className={styles.checkName}>{sentence(checkWords(c.name))}:</span> {c.detail}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Why the case exists, in the voice of whoever made it. */
export function WhyThisCase({ testCase }: { testCase: TestCase }) {
  return (
    <div className={styles.why}>
      <SourceTag source={testCase.source} withGroup />
      <p>{testCase.rationale || "No reasoning was recorded for this case."}</p>
    </div>
  );
}

function Part({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={styles.part}>
      <div className={styles.partHead}>
        <h4>{title}</h4>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Evidence({ item, compact = false }: { item: FindingItem; compact?: boolean }) {
  const { testCase, result } = item;
  const setup = result.setup_exchanges;
  return (
    <>
      <Part title={compact ? "Sent and received" : "What we sent and what came back"}>
        {result.exchange ? (
          <ExchangeView exchange={result.exchange} failedCheck={firstFailure(result)} />
        ) : (
          <p className="small muted">{result.note || "The request never completed."}</p>
        )}
        {setup.length > 0 && (
          <details className={styles.setup}>
            <summary>
              Setup before it, {setup.length} {setup.length === 1 ? "request" : "requests"}
            </summary>
            <div className={styles.setupList}>
              {setup.map((ex, i) => (
                <ExchangeView key={i} exchange={ex} />
              ))}
            </div>
          </details>
        )}
      </Part>
      {compact ? (
        <CheckList checks={result.checks} onlyProblems />
      ) : (
        <>
          <Part title="Checks">
            <CheckList checks={result.checks} />
          </Part>
          <Part title="Why this case exists">
            <WhyThisCase testCase={testCase} />
          </Part>
        </>
      )}
    </>
  );
}

function RegressionTest({ result }: { result: CaseResult }) {
  if (!result.regression_test) return null;
  return (
    <details className={styles.regression}>
      <summary>
        Regression test, pytest, {result.regression_test.trimEnd().split("\n").length} lines
      </summary>
      <CodeBlock title="test_regression.py" code={result.regression_test} copy />
    </details>
  );
}

function Explanation({ analysis }: { analysis: Analysis }) {
  return (
    <>
      <Part title="Likely cause" aside={<ExplainedBy source={analysis.source} />}>
        <p className={styles.prose}>{analysis.likely_cause}</p>
      </Part>
      {analysis.investigation_steps.length > 0 && (
        <Part title="What to do next">
          <ol className={styles.steps}>
            {analysis.investigation_steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Part>
      )}
    </>
  );
}

function Head({ title, index, total, severity, meta }: { title: string; index: number; total: number; severity: Severity; meta: React.ReactNode }) {
  return (
    <header className={styles.findingHead}>
      <div className={styles.findingTitle}>
        <h3>{title}</h3>
        <div className={styles.findingMeta}>
          <span>
            Finding {index} of {total}
          </span>
          {meta}
        </div>
      </div>
      <SeverityText severity={severity} />
    </header>
  );
}

export function Finding({ group, index, total, focusedId }: { group: FindingGroup; index: number; total: number; focusedId: string | null }) {
  if (group.members.length === 1) {
    const item = group.members[0];
    const { testCase, result } = item;
    const a = result.analysis;
    return (
      <article
        id={findingId(testCase.id)}
        className={`${styles.finding} ${focusedId === testCase.id ? styles.findingFocus : ""}`}
        tabIndex={-1}
        aria-label={`Finding ${index} of ${total}`}
      >
        <Head
          title={a?.title ?? testCase.name}
          index={index}
          total={total}
          severity={a?.severity ?? "low"}
          meta={
            <>
              <MethodPath id={testCase.endpoint_id} />
              <span>{testCase.name}</span>
            </>
          }
        />
        <div className={styles.findingBody}>
          {a && <p className={styles.verdictLine}>{a.summary}</p>}
          <Evidence item={item} />
          {a && <Explanation analysis={a} />}
          <RegressionTest result={result} />
        </div>
      </article>
    );
  }

  const analysis = group.members[0].result.analysis as Analysis;
  const summaries = new Set(group.members.map((m) => m.result.analysis?.summary));
  const sharedSummary = summaries.size === 1;
  const title = groupTitle(group);
  const first = group.members[0].testCase;
  const sameReason = group.members.every((m) => m.testCase.source === first.source && m.testCase.rationale === first.rationale);
  const failedNames = (m: FindingItem) => m.result.checks.filter((c) => !c.passed && c.severity === "fail").map((c) => checkWords(c.name));
  const sharedChecks = failedNames(group.members[0]).filter((n) => group.members.every((m) => failedNames(m).includes(n)));

  return (
    <article id={groupAnchor(group)} className={styles.finding} aria-label={`Finding ${index} of ${total}`} tabIndex={-1}>
      <Head
        title={title}
        index={index}
        total={total}
        severity={group.severity}
        meta={<span>{group.members.length} failed cases share one cause</span>}
      />
      <div className={styles.findingBody}>
        {sharedSummary && <p className={styles.verdictLine}>{analysis.summary}</p>}
        {sharedChecks.length > 0 && (
          <Part title="Failed in every case">
            <p className={styles.prose}>{sentence(sharedChecks.join(", "))}</p>
          </Part>
        )}
        {sameReason && (
          <Part title="Why these cases exist">
            <WhyThisCase testCase={first} />
          </Part>
        )}
        <Explanation analysis={analysis} />
        <ol className={styles.members}>
          {group.members.map((item) => (
            <li
              key={item.testCase.id}
              id={findingId(item.testCase.id)}
              className={`${styles.member} ${focusedId === item.testCase.id ? styles.findingFocus : ""}`}
              tabIndex={-1}
              aria-label={`${item.testCase.endpoint_id}, ${item.testCase.name}`}
            >
              <div className={styles.memberHead}>
                <MethodPath id={item.testCase.endpoint_id} />
                <span>{item.testCase.name}</span>
              </div>
              {!sharedSummary && item.result.analysis && <p className={styles.verdictLine}>{item.result.analysis.summary}</p>}
              {!sameReason && <WhyThisCase testCase={item.testCase} />}
              <Evidence item={item} compact />
              <RegressionTest result={item.result} />
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}
