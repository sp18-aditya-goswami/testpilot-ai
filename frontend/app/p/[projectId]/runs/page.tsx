"use client";

import { useCallback, useEffect, useState } from "react";
import { useProject } from "@/components/ProjectContext";
import { errorMessage } from "@/lib/api";
import { ws, type RunListItem } from "@/lib/workspace";
import { RunHistoryTable } from "../RunHistoryTable";
import styles from "../project.module.css";

export default function ProjectRuns() {
  const { projectId, tree } = useProject();
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await ws.projectRuns(projectId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className={styles.head}>
        <div>
          <h1>Run history</h1>
          <p>Every run of a test suite, collection or folder in {tree?.project.name ?? "this project"}, newest first.</p>
        </div>
      </div>
      {error ? (
        <div className="error-state" role="alert">
          <h3>Runs could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="key" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !runs ? (
        <div className={styles.skeletonBlock} aria-busy="true" aria-label="Loading runs">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : runs.length === 0 ? (
        <div className="empty">
          <h3>No runs yet</h3>
          <p>Run a collection or folder from its menu in the sidebar, or open a test suite and run its plan.</p>
        </div>
      ) : (
        <RunHistoryTable projectId={projectId} runs={runs} />
      )}
    </>
  );
}
