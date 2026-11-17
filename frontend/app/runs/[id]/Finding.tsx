"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { SourceTag } from "@/components/Source";
import type { CaseResult, Check, Severity, TestCase } from "@/lib/api";
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
  if (a?.cause_group) return `cause:${a.source}:${a.cause_group.trim().toLowerCase()}`;
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
  const label = group.members[0].result.analysis?.cause_group;
  if (label) return label;
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
