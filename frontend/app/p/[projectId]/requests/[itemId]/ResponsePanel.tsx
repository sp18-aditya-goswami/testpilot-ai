"use client";

import { useState } from "react";
import { CopyButton, formatBody } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import type { Check } from "@/lib/api";
import type { SendResult } from "@/lib/workspace";
import { formatBytes } from "./requestUtils";
import styles from "./request.module.css";

const PREVIEW_LINES = 12;
const OUTCOME_WORD = { passed: "Checks passed", failed: "Checks failed", error: "No response" } as const;

function CheckLine({ check }: { check: Check }) {
  const cls = check.passed ? styles.checkPass : check.severity === "warn" ? styles.checkWarn : styles.checkFail;
  return (
    <li className={cls}>
      <Icon name={check.passed ? "check" : check.severity === "warn" ? "alert" : "cross"} />
      <span className={styles.checkName}>{check.name}</span>
      <span className={styles.checkDetail}>{check.detail}</span>
    </li>
  );
}

function BodyView({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > PREVIEW_LINES;
  return (
    <figure className={`graphite ${styles.bodyWell}`}>
      <figcaption className={styles.wellHead}>
        <span className="mono muted">response body</span>
        <CopyButton text={text} />
      </figcaption>
      <pre className="code">{long && !full ? lines.slice(0, PREVIEW_LINES).join("\n") : text}</pre>
      {long && (
        <button type="button" className={`key key--plain ${styles.more}`} aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? `Show the first ${PREVIEW_LINES} lines` : `Show all ${lines.length} lines`}
        </button>
      )}
    </figure>
  );
}

export function ResponsePanel({ result, sending, error }: { result: SendResult | null; sending: boolean; error: string | null }) {
  const [tab, setTab] = useState<"body" | "headers">("body");

  if (sending && !result) {
    return (
      <section className={`panel ${styles.response}`} aria-label="Response" aria-busy="true">
        <div className={styles.responseHead}>
          <div className={`skeleton ${styles.skelFigure}`} />
          <div className={`skeleton ${styles.skelLine}`} />
        </div>
        <div className={`skeleton ${styles.skelBody}`} />
      </section>
    );
  }

  if (error) {
    return (
      <section className="error-state" aria-label="Response" role="alert">
        <h3>The request was not sent</h3>
        <p>{error}</p>
      </section>
    );
  }

  if (!result) {
    return (
      <section className={`empty ${styles.responseEmpty}`} aria-label="Response">
        <h3>No response yet</h3>
        <p>Send the request to see the response, its timing and every check.</p>
      </section>
    );
  }

  const ex = result.exchange;
  const failed = result.checks.filter((c) => !c.passed);
  const shown = [...failed, ...result.checks.filter((c) => c.passed)];
  const headers = Object.entries(ex.response_headers ?? {});

  return (
    <section className={`panel ${styles.response}`} aria-label="Response" aria-busy={sending}>
      <div className={styles.responseHead}>
        <span className={`figure ${styles.statusFigure} ${styles[`out_${result.outcome}`]}`}>{ex.status ?? "None"}</span>
        <div className={styles.responseMeta}>
          <span className={`status ${styles[`out_${result.outcome}`]}`}>
            <Icon name={result.outcome === "passed" ? "check" : result.outcome === "failed" ? "cross" : "alert"} />
            {OUTCOME_WORD[result.outcome]}
          </span>
          <span className={styles.metaLine}>
            <span>
              <span className="muted">Time </span>
              <span className="num">{ex.duration_ms != null ? `${Math.round(ex.duration_ms)} ms` : "none"}</span>
            </span>
            <span>
              <span className="muted">Size </span>
              <span className="num">{formatBytes(result.response_size_bytes)}</span>
            </span>
          </span>
          <span className={`mono ${styles.resolved}`}>
            <span className={styles.resolvedMethod}>{ex.method}</span> {result.resolved_url}
          </span>
        </div>
      </div>

      {ex.error && (
        <p className={`notice ${styles.exError}`}>
          <Icon name="alert" />
          <span>{ex.error}</span>
        </p>
      )}

      {shown.length > 0 && (
        <ul className={styles.checks} aria-label="Checks">
          {shown.map((c, i) => (
            <CheckLine key={`${c.name}-${i}`} check={c} />
          ))}
        </ul>
      )}

      {ex.status != null && (
        <>
          <div className="tray" role="tablist" aria-label="Response view">
            <button type="button" role="tab" aria-selected={tab === "body"} onClick={() => setTab("body")}>
              Body
            </button>
            <button type="button" role="tab" aria-selected={tab === "headers"} onClick={() => setTab("headers")}>
              Headers ({headers.length})
            </button>
          </div>
          <div className={styles.responseBody}>
            {tab === "body" ? (
              <BodyView text={formatBody(ex.response_body)} />
            ) : headers.length === 0 ? (
              <p className="small muted">The response had no headers worth keeping.</p>
            ) : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Header</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {headers.map(([k, v]) => (
                    <tr key={k}>
                      <td className="mono">{k}</td>
                      <td className="mono">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
