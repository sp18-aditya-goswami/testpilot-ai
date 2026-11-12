"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { errorMessage } from "@/lib/api";
import type { Environment, EnvVarIn } from "@/lib/workspace";
import styles from "./environments.module.css";

interface Row {
  rid: number;
  key: string;
  value: string;
  secret: boolean;
  /** A stored secret whose value the browser never sees; sent as null unless replaced. */
  stored: boolean;
}

let nextRid = 1;
const toRows = (env?: Environment): Row[] =>
  (env?.variables ?? []).map((v) => ({ rid: nextRid++, key: v.key, value: v.secret ? "" : v.value, secret: v.secret, stored: v.secret && v.has_value }));

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface EnvFormValue {
  name: string;
  base_url: string;
  is_default: boolean;
  variables: EnvVarIn[];
}

export function EnvForm({
  initial,
  allowedHosts,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Environment;
  allowedHosts: string[] | null;
  submitLabel: string;
  onSubmit: (value: EnvFormValue) => Promise<void>;
  onCancel: () => void;
}) {
  const ids = { name: useId(), url: useId(), def: useId() };
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "http://localhost:8008");
  const [isDefault, setIsDefault] = useState(initial?.is_default ?? false);
  const [rows, setRows] = useState<Row[]>(toRows(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; url?: string; rows?: string }>({});

  const update = (rid: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));

  const validate = () => {
    const errs: typeof fieldErrors = {};
    if (!name.trim()) errs.name = "Give the environment a name, such as Local or Staging.";
    try {
      const u = new URL(baseUrl.trim());
      if (!/^https?:$/.test(u.protocol)) errs.url = "Use an http or https URL.";
    } catch {
      errs.url = "Enter a full URL, such as http://localhost:8008.";
    }
    const keys = rows.filter((r) => r.key.trim()).map((r) => r.key.trim());
    if (keys.some((k) => !KEY_RE.test(k))) errs.rows = "Variable names start with a letter or underscore and use letters, digits, _ or -.";
    else if (new Set(keys).size !== keys.length) errs.rows = "Each variable name can be used once.";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !validate()) return;
        setBusy(true);
        setError(null);
        try {
          await onSubmit({
            name: name.trim(),
            base_url: baseUrl.trim().replace(/\/+$/, ""),
            is_default: isDefault,
            variables: rows
              .filter((r) => r.key.trim())
              .map((r) => ({ key: r.key.trim(), value: r.stored ? null : r.value, secret: r.secret })),
          });
        } catch (err) {
          setError(errorMessage(err));
          setBusy(false);
        }
      }}
    >
      <div className={styles.formGrid}>
        <div className="field">
          <label htmlFor={ids.name}>Name</label>
          <input
            id={ids.name}
            className="input"
            value={name}
            maxLength={60}
            autoComplete="off"
            placeholder="Staging"
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={`${ids.name}-help`}
            onChange={(e) => setName(e.target.value)}
          />
          <p id={`${ids.name}-help`} className={`helper ${fieldErrors.name ? "is-error" : ""}`}>
            {fieldErrors.name ?? ""}
          </p>
        </div>
        <div className="field">
          <label htmlFor={ids.url}>Base URL</label>
          <input
            id={ids.url}
            className="input"
            type="url"
            inputMode="url"
            autoComplete="off"
            value={baseUrl}
            aria-invalid={fieldErrors.url ? true : undefined}
            aria-describedby={`${ids.url}-help`}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p id={`${ids.url}-help`} className={`helper ${fieldErrors.url ? "is-error" : ""}`}>
            {fieldErrors.url ??
              (allowedHosts ? `The host must be one of the allowed hosts: ${allowedHosts.join(", ")}.` : "The host must be in the allowed hosts set in Settings.")}
          </p>
        </div>
      </div>

      <label className="check">
        <input id={ids.def} type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <span>Use as the default environment for this project</span>
      </label>

      <fieldset className={styles.vars}>
        <legend>Variables</legend>
        <p className="small muted">
          Use them anywhere in a request as <span className="mono">{"{{name}}"}</span>. Secret values are stored on the server and never shown again.
        </p>
        {rows.length > 0 && (
          <div className="table-scroll">
            <table className={`ledger ${styles.varTable}`}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Secret</th>
                  <th>
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.rid}>
                    <td>
                      <input
                        className={`input ${styles.cellInput} mono`}
                        aria-label={`Variable ${i + 1} name`}
                        value={r.key}
                        maxLength={64}
                        autoComplete="off"
                        placeholder="token"
                        onChange={(e) => update(r.rid, { key: e.target.value })}
                      />
                    </td>
                    <td>
                      {r.stored ? (
                        <span className={styles.stored}>
                          <span className="muted">Stored</span>
                          <button type="button" className="key key--plain" onClick={() => update(r.rid, { stored: false, value: "" })}>
                            Replace
                          </button>
                        </span>
                      ) : (
                        <input
                          className={`input ${styles.cellInput} mono`}
                          aria-label={`Variable ${i + 1} value`}
                          type={r.secret ? "password" : "text"}
                          autoComplete="off"
                          value={r.value}
                          onChange={(e) => update(r.rid, { value: e.target.value })}
                        />
                      )}
                    </td>
                    <td>
                      <label className="check">
                        <input
                          type="checkbox"
                          aria-label={`Variable ${i + 1} is secret`}
                          checked={r.secret}
                          onChange={(e) => update(r.rid, { secret: e.target.checked, stored: e.target.checked ? r.stored : false })}
                        />
                      </label>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.remove}
                        aria-label={`Remove variable ${r.key || i + 1}`}
                        onClick={() => setRows((rs) => rs.filter((x) => x.rid !== r.rid))}
                      >
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {fieldErrors.rows && (
          <p className="helper is-error" role="alert">
            {fieldErrors.rows}
          </p>
        )}
        <div>
          <button
            type="button"
            className="key"
            onClick={() => setRows((rs) => [...rs, { rid: nextRid++, key: "", value: "", secret: false, stored: false }])}
          >
            <Icon name="plus" />
            Add variable
          </button>
        </div>
      </fieldset>

      {error && (
        <div className="error-state" role="alert">
          <h3>The environment was not saved</h3>
          <p>{error}</p>
        </div>
      )}

      <div className={styles.actions}>
        <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {submitLabel}
        </button>
        <button type="button" className="key" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
