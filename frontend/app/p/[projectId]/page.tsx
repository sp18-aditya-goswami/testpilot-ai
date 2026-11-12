"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useProject } from "@/components/ProjectContext";
import { errorMessage } from "@/lib/api";
import { ws, type RunListItem } from "@/lib/workspace";
import { RunHistoryTable } from "./RunHistoryTable";
import styles from "./project.module.css";

export default function ProjectOverview() {
  const { projectId, tree, error, refresh } = useProject();
  const router = useRouter();
  const ids = { name: useId(), desc: useId() };
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadRuns = useCallback(async () => {
    setRunsError(null);
    try {
      setRuns(await ws.projectRuns(projectId));
    } catch (err) {
      setRunsError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  if (error && !tree) {
    return (
      <div className="error-state" role="alert">
        <h3>The project could not be loaded</h3>
        <p>{error}</p>
        <button type="button" className="key" onClick={() => void refresh()}>
          Try again
        </button>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className={styles.skeletonBlock} aria-busy="true" aria-label="Loading project">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    );
  }

  const p = tree.project;
  const isEmpty = tree.collections.length === 0 && tree.environments.length === 0;

  return (
    <>
      {editing ? (
        <form
          className={styles.editForm}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) {
              setSaveError("A project needs a name.");
              return;
            }
            setSaving(true);
            setSaveError(null);
            try {
              await ws.updateProject(projectId, { name: name.trim(), description: desc.trim() });
              await refresh();
              setEditing(false);
            } catch (err) {
              setSaveError(errorMessage(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor={ids.name}>Project name</label>
            <input id={ids.name} className="input" value={name} maxLength={80} autoComplete="off" aria-invalid={saveError ? true : undefined} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.desc}>Description</label>
            <textarea id={ids.desc} className="input" value={desc} maxLength={500} onChange={(e) => setDesc(e.target.value)} />
          </div>
          {saveError && (
            <p className="helper is-error" role="alert">
              {saveError}
            </p>
          )}
          <div className={styles.formActions}>
            <button type="submit" className="key key--primary" disabled={saving} aria-busy={saving}>
              {saving && <span className="spinner" aria-hidden="true" />}
              Save
            </button>
            <button type="button" className="key" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className={styles.head}>
          <div>
            <h1>{p.name}</h1>
            <p>{p.description || "No description yet."}</p>
          </div>
          <button
            type="button"
            className="key"
            onClick={() => {
              setName(p.name);
              setDesc(p.description);
              setSaveError(null);
              setEditing(true);
            }}
          >
            Edit details
          </button>
        </div>
      )}

      <div className={styles.figures}>
        <div className={styles.figure}>
          <span className="figure">{tree.collections.length}</span>
          <span className={styles.figureLabel}>collections</span>
        </div>
        <div className={styles.figure}>
          <span className="figure">{tree.environments.length}</span>
          <span className={styles.figureLabel}>environments</span>
        </div>
        <div className={styles.figure}>
          <span className="figure">{runs ? runs.length : p.run_count}</span>
          <span className={styles.figureLabel}>runs</span>
        </div>
      </div>

      {isEmpty && (
        <div className="notice notice--accent" style={{ marginBottom: "var(--space-2xl)" }}>
          <span>
            Add an environment, then import an OpenAPI spec or create a collection.{" "}
            <Link href={`/p/${projectId}/environments`}>Add an environment</Link>
          </span>
        </div>
      )}

      <section className={styles.block} aria-labelledby="recent-runs">
        <div className={styles.sectionHead}>
          <h2 id="recent-runs">Recent runs</h2>
          {runs && runs.length > 5 && <Link href={`/p/${projectId}/runs`}>All {runs.length} runs</Link>}
        </div>
        {runsError ? (
          <div className="error-state" role="alert">
            <h3>Runs could not be loaded</h3>
            <p>{runsError}</p>
            <button type="button" className="key" onClick={() => void loadRuns()}>
              Try again
            </button>
          </div>
        ) : !runs ? (
          <div className={styles.skeletonBlock} aria-busy="true" aria-label="Loading runs">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : runs.length === 0 ? (
          <div className="empty">
            <h3>No runs yet</h3>
            <p>Run a collection or folder from its menu in the sidebar, or open a test suite and run its plan.</p>
          </div>
        ) : (
          <RunHistoryTable projectId={projectId} runs={runs.slice(0, 5)} />
        )}
      </section>

      <section className={styles.danger} aria-labelledby="danger-zone">
        <div>
          <h2 id="danger-zone">Delete this project</h2>
          <p>Removes its environments, collections, specs, plans and run history.</p>
        </div>
        <button type="button" className={`key ${styles.dangerKey}`} onClick={() => setDeleting(true)}>
          Delete project
        </button>
      </section>

      <ConfirmDialog
        open={deleting}
        title={`Delete ${p.name}?`}
        confirmLabel="Delete project"
        danger
        requireText={p.name}
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await ws.deleteProject(projectId);
          router.push("/");
        }}
      >
        <p>This cannot be undone. Everything in the project goes, including its run history.</p>
      </ConfirmDialog>
    </>
  );
}
