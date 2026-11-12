"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { useProject } from "@/components/ProjectContext";
import { ws, type Environment } from "@/lib/workspace";
import { EnvForm } from "./EnvForm";
import base from "../project.module.css";
import styles from "./environments.module.css";

export default function EnvironmentsPage() {
  const { projectId, tree, error, refresh, environment, setEnvironmentId } = useProject();
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Environment | null>(null);

  useEffect(() => {
    ws.settings().then((s) => setAllowed(s.allowed_hosts), () => setAllowed(null));
  }, []);

  const envs = tree?.environments ?? [];

  return (
    <>
      <div className={base.head}>
        <div>
          <h1>Environments</h1>
          <p>Each environment is one place to send requests, such as your laptop or a staging server, with its own variables.</p>
        </div>
        {!creating && (
          <button type="button" className="key key--primary" disabled={!tree} onClick={() => setCreating(true)}>
            <Icon name="plus" />
            New environment
          </button>
        )}
      </div>

      {creating && (
        <section className={`panel ${styles.env} ${styles.newWrap}`} aria-label="New environment">
          <EnvForm
            allowedHosts={allowed}
            submitLabel="Create environment"
            onCancel={() => setCreating(false)}
            onSubmit={async (v) => {
              const env = await ws.createEnvironment(projectId, { ...v, is_default: v.is_default || envs.length === 0 });
              await refresh();
              if (!environment) setEnvironmentId(env.id);
              setCreating(false);
            }}
          />
        </section>
      )}

      {error && !tree ? (
        <div className="error-state" role="alert">
          <h3>Environments could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="key" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : !tree ? (
        <div className={base.skeletonBlock} aria-busy="true" aria-label="Loading environments">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : envs.length === 0 && !creating ? (
        <div className="empty">
          <h3>No environments yet</h3>
          <p>Requests need somewhere to go. Add one for the API running on your machine, such as http://localhost:8008.</p>
          <button type="button" className="key" onClick={() => setCreating(true)}>
            New environment
          </button>
        </div>
      ) : (
        <div className={styles.list}>
          {envs.map((env) =>
            editingId === env.id ? (
              <section key={env.id} className={`panel ${styles.env}`} aria-label={`Edit ${env.name}`}>
                <EnvForm
                  initial={env}
                  allowedHosts={allowed}
                  submitLabel="Save changes"
                  onCancel={() => setEditingId(null)}
                  onSubmit={async (v) => {
                    await ws.updateEnvironment(env.id, v);
                    await refresh();
                    setEditingId(null);
                  }}
                />
              </section>
            ) : (
              <section key={env.id} className={`panel ${styles.env}`} aria-labelledby={`env-${env.id}`}>
                <div className={styles.envHead}>
                  <h2 id={`env-${env.id}`}>
                    {env.name}
                    {env.is_default && <span className={styles.defaultWord}>default</span>}
                  </h2>
                  <div className={styles.envActions}>
                    {environment?.id !== env.id && (
                      <button type="button" className="key key--plain" onClick={() => setEnvironmentId(env.id)}>
                        Use now
                      </button>
                    )}
                    <button type="button" className="key" onClick={() => setEditingId(env.id)}>
                      <Icon name="pencil" />
                      Edit
                    </button>
                    <button type="button" className="key key--plain" onClick={() => setDeleting(env)}>
                      <Icon name="trash" />
                      Delete
                    </button>
                  </div>
                </div>
                <div className={styles.envMeta}>
                  <span className="mono">{env.base_url}</span>
                  {environment?.id === env.id && <span>In use in this browser</span>}
                </div>
                {!env.base_url_allowed && (
                  <p className={styles.warn}>
                    <Icon name="alert" />
                    <span>This host is not in the allowed hosts, so TestPilot will not send requests to it. Add it in Settings if it is a local or staging server.</span>
                  </p>
                )}
                {env.variables.length > 0 ? (
                  <p className={styles.varList}>
                    {env.variables.map((v) => (
                      <span key={v.key} className="mono">
                        {v.key}
                        {v.secret ? " (secret)" : ""}
                      </span>
                    ))}
                  </p>
                ) : (
                  <p className="small muted">No variables.</p>
                )}
              </section>
            ),
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.name}?` : ""}
        confirmLabel="Delete environment"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await ws.deleteEnvironment(deleting.id);
          await refresh();
        }}
      >
        <p>Its variables and secrets go with it. Past runs keep their results.</p>
      </ConfirmDialog>
    </>
  );
}
