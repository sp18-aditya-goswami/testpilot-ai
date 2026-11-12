"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { OutcomeBar } from "@/components/OutcomeBar";
import type { RunListItem } from "@/lib/workspace";
import { STATUS_WORDS, formatStarted } from "../../runs/format";
import styles from "./project.module.css";

const KIND_WORD: Record<RunListItem["source_kind"], string> = {
  suite: "Test suite",
  collection: "Collection",
  folder: "Folder",
  request: "Request",
};

/** Project run history as a ruled table; rows open the run. */
export function RunHistoryTable({ projectId, runs }: { projectId: string; runs: RunListItem[] }) {
  const router = useRouter();
  return (
    <div className={`panel ${styles.tablePanel}`}>
      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th>Source</th>
              <th>Environment</th>
              <th>Started</th>
              <th>Status</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const href = `/p/${projectId}/runs/${r.id}`;
              return (
                <tr key={r.id} className="is-link" onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  router.push(href);
                }}>
                  <td>
                    <span className={styles.runSource}>
                      <Link href={href} className="nowrap">{r.source_name || r.spec_title || "Untitled run"}</Link>
                      <span className={styles.runKind}>{KIND_WORD[r.source_kind] ?? "Run"}</span>
                    </span>
                  </td>
                  <td>{r.environment_name || <span className="mono">{r.base_url}</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{formatStarted(r.created_at)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>{STATUS_WORDS[r.status]}</td>
                  <td className={styles.barCell}>
                    <OutcomeBar counts={r.counts} legend={false} />
                    <span className={styles.counts}>
                      <span className={styles.passed}>{r.counts.passed} passed</span>
                      <span className={r.counts.failed > 0 ? styles.failed : styles.clean}>{r.counts.failed} failed</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
