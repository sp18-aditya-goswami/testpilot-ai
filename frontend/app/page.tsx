"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { errorMessage } from "@/lib/api";
import { ws, type Project } from "@/lib/workspace";
import { formatStarted } from "./runs/format";
import styles from "./projects.module.css";

function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const ids = { name: useId(), desc: useId() };
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className={`panel ${styles.form}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) {
          setError("Give the project a name, such as the service it tests.");
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const p = await ws.createProject({ name: name.trim(), description: desc.trim() });
          router.push(`/p/${p.id}`);
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <h2>New project</h2>
      <div className="field">
        <label htmlFor={ids.name}>Name</label>
        <input
          id={ids.name}
          className="input"
          autoFocus
          autoComplete="off"
          maxLength={80}
          placeholder="User service"
          value={name}
          aria-invalid={error && !name.trim() ? true : undefined}
          aria-describedby={`${ids.name}-help`}
          onChange={(e) => setName(e.target.value)}
        />
        <p id={`${ids.name}-help`} className={`helper ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
          {error ?? ""}
        </p>
      </div>
      <div className="field">
        <label htmlFor={ids.desc}>Description</label>
        <textarea id={ids.desc} className="input" maxLength={500} placeholder="What this API does and who owns it" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className={styles.actions}>
        <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Create project
        </button>
        <button type="button" className="key" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function ProjectsHome() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProjects(await ws.projects());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>One project per API: its environments, collections of saved requests, test suites and run history.</p>
        </div>
        {!creating && projects && projects.length > 0 && (
          <button type="button" className="key key--primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New project
          </button>
        )}
      </div>

      {creating && <NewProjectForm onCancel={() => setCreating(false)} />}

      {error ? (
        <div className="error-state" role="alert">
          <h3>Projects could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="key" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !projects ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading projects">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : projects.length === 0 ? (
        !creating && (
          <div className={`empty ${styles.empty}`}>
            <h3>No projects yet</h3>
            <p>A project holds everything for one API: the OpenAPI specs it publishes, the environments you test it in, and collections of saved requests and test suites.</p>
            <button type="button" className="key key--primary" onClick={() => setCreating(true)}>
              <Icon name="plus" />
              New project
            </button>
          </div>
        )
      ) : (
        <ul className={`panel ${styles.list}`}>
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/p/${p.id}`} className={styles.project}>
                <span className={styles.name}>
                  <span className={styles.title}>{p.name}</span>
                  {p.description && <span className={styles.desc}>{p.description}</span>}
                </span>
                <span className={styles.stats}>
                  <span>
                    <b>{p.collection_count}</b> {p.collection_count === 1 ? "collection" : "collections"}
                  </span>
                  <span>
                    <b>{p.environment_count}</b> {p.environment_count === 1 ? "environment" : "environments"}
                  </span>
                  <span>
                    <b>{p.run_count}</b> {p.run_count === 1 ? "run" : "runs"}
                  </span>
                  <span className={styles.last}>{p.last_run_at ? `Last run ${formatStarted(p.last_run_at)}` : "Not run yet"}</span>
                </span>
                <Icon name="chevron" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
