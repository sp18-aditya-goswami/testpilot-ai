"use client";

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { ws, type ItemHistory } from "@/lib/workspace";
import { RunHistoryTable } from "../../RunHistoryTable";
import { PlanList } from "../../specs/PlanList";
import styles from "./suite.module.css";

/** Every plan this suite generated and every run of them, newest first. */
export function SuiteHistory({ projectId, itemId }: { projectId: string; itemId: string }) {
  const [history, setHistory] = useState<ItemHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    ws.itemHistory(itemId).then(setHistory, (err) => setError(errorMessage(err)));
  }, [itemId]);

  useEffect(load, [load]);

  return (
    <section className={styles.history} aria-labelledby="history-heading">
      <div className={styles.historyHead}>
        <h2 id="history-heading">History</h2>
        <p>Plans this suite generated and the runs of them.</p>
      </div>
      {error && !history ? (
        <div className="error-state" role="alert">
          <p>The history could not be loaded. {error}</p>
          <button type="button" className="key" onClick={load}>
            Try again
          </button>
        </div>
      ) : !history ? (
        <div className={styles.historySkeleton} aria-hidden="true">
          <div className="skeleton" />
        </div>
      ) : history.plans.length === 0 && history.runs.length === 0 ? (
        <p className={styles.historyEmpty}>Nothing yet. Generate a test plan below, review it, then run it; both land here.</p>
      ) : (
        <>
          {history.plans.length > 0 && <PlanList projectId={projectId} plans={history.plans.slice(0, 10)} />}
          {history.runs.length > 0 && <RunHistoryTable projectId={projectId} runs={history.runs.slice(0, 10)} />}
        </>
      )}
    </section>
  );
}
