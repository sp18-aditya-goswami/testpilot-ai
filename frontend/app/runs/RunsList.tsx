"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { OutcomeBar } from "@/components/OutcomeBar";
import { api, errorMessage } from "@/lib/api";
import { ws, type RunListItem } from "@/lib/workspace";
import { STATUS_WORDS, formatStarted, runHref, runTitle } from "./format";
import styles from "./runs.module.css";

function ResultCounts({ counts }: { counts: RunListItem["counts"] }) {
  return (
    <span className={styles.resultCounts}>
      <span className={styles.passedText}>{counts.passed} passed</span>
      <span className={counts.failed > 0 ? styles.failedText : styles.cleanText}>{counts.failed} failed</span>
    </span>
  );
}

/** Run history, for one project when `projectId` is given. */
export function RunsList({ projectId }: { projectId?: string } = {}) {
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(projectId ? await ws.projectRuns(projectId) : ((await api.runs()) as RunListItem[]));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="error-state" role="alert">
        <h3>Run history could not be loaded</h3>
        <p>{error}</p>
        <button type="button" className="key" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  if (!runs) {
    return (
      <div className={styles.skeletonRows} aria-busy="true" aria-label="Loading runs">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="empty">
        <h3>No runs yet</h3>
        <p>Each run keeps its requests, responses and explanations here so you can come back to them.</p>
        <Link className="key key--primary" href={projectId ? `/p/${projectId}` : "/"}>
          {projectId ? "Open the project" : "Open projects"}
        </Link>
      </div>
    );
  }

  return (
    <div className={`panel ${styles.listPanel}`}>
      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th>Run</th>
              <th>Result</th>
              <th>Status</th>
              <th>Started</th>
              <th>Target</th>
              <th className="num">Cases</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link className={styles.listTitle} href={runHref(r)}>
                    {runTitle(r)}
                  </Link>
                  {r.environment_name && <span className={styles.listEnv}>{r.environment_name}</span>}
                  <span className={styles.listCounts}>
                    <ResultCounts counts={r.counts} />
                  </span>
                </td>
                <td>
                  <span className={styles.resultCell}>
                    <span className={styles.miniBar}>
                      <OutcomeBar counts={r.counts} legend={false} />
                    </span>
                    <ResultCounts counts={r.counts} />
                  </span>
                </td>
                <td className={r.status === "failed" ? "status status--failed" : undefined}>{STATUS_WORDS[r.status]}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <time dateTime={r.created_at}>{formatStarted(r.created_at)}</time>
                </td>
                <td className="mono muted">{r.base_url}</td>
                <td className="num">{r.counts.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
