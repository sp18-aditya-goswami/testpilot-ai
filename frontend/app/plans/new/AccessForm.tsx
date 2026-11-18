"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { errorMessage } from "@/lib/api";
import { testPlans, type AccessStatus } from "@/lib/testplans";
import type { AuthContext } from "@/lib/workspace";
import styles from "./new-plan.module.css";

export const TOKEN_VARIABLE = "token";

/** The auth part of a plan's settings, from what the spec says. */
export function authFor(current: AuthContext, access: AccessStatus | null): AuthContext {
  if (!access) return current;
  const a = access.auth;
  if (a.mode === "auto" || a.mode === "credentials")
    return { ...current, token_variable: TOKEN_VARIABLE, header_name: a.header_name, scheme: a.scheme, login: a.flow, second_user: Boolean(current.second_user) };
  if (a.mode === "token") return { ...current, token_variable: TOKEN_VARIABLE, header_name: a.header_name, scheme: a.scheme, login: null, second_user: false };
  return { ...current, token_variable: access.has_token ? (current.token_variable ?? TOKEN_VARIABLE) : current.token_variable, login: null, second_user: false };
}

/** A second test login (user B) for two-user tests on an API without sign-up. */
export function SecondLoginForm({
  access,
  specId,
  environmentId,
  onSaved,
}: {
  access: AccessStatus;
  specId: string;
  environmentId: string;
  onSaved: (next: AccessStatus) => void;
}) {
  const ids = { user: useId(), password: useId() };
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = access.auth.username_label.toLowerCase();

  async function save() {
    setError(null);
    if (!(username.trim() && password)) return setError(`Enter user B's ${label} and password.`);
    setBusy(true);
    try {
      const next = await testPlans.saveAccess({ spec_id: specId, environment_id: environmentId, username_b: username.trim(), password_b: password });
      setPassword("");
      onSaved(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.second}>
      <div className={styles.twoCol}>
        <div className="field">
          <label htmlFor={ids.user}>User B {label}</label>
          <input id={ids.user} name="auth_username_b" className="input" autoComplete="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={ids.password}>User B password</label>
          <input id={ids.password} name="auth_password_b" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <div className={styles.actions}>
        <button type="button" className="key" onClick={save} disabled={busy} aria-busy={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "Saving" : "Save user B"}
        </button>
        <span className={`small ${error ? "helper is-error" : "muted"}`} role={error ? "alert" : undefined}>
          {error ?? "A different test account from user A. Stored as a secret."}
        </span>
      </div>
    </div>
  );
}

/** Asks for the one thing the spec's auth needs: a test login when there is no sign-up endpoint, a token when there is no sign-in. */
export function AccessForm({
  access,
  specId,
  environmentId,
  onSaved,
  onSkip,
  saveLabel = "Save and continue",
}: {
  access: AccessStatus;
  specId: string;
  environmentId: string;
  onSaved: (next: AccessStatus) => void;
  onSkip?: () => void;
  saveLabel?: string;
}) {
  const ids = { user: useId(), password: useId(), token: useId() };
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = access.auth;
  const wantsLogin = a.mode === "credentials";

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (wantsLogin && !(username.trim() && password)) return setError(`Enter the test ${a.username_label.toLowerCase()} and its password.`);
    if (!wantsLogin && !token.trim()) return setError(`Paste a ${a.scheme ? "token" : "key"} for the test server.`);
    setBusy(true);
    try {
      const next = await testPlans.saveAccess(
        wantsLogin ? { spec_id: specId, environment_id: environmentId, username: username.trim(), password } : { spec_id: specId, environment_id: environmentId, token: token.trim() },
      );
      setPassword("");
      setToken("");
      onSaved(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={`panel ${styles.card} ${styles.access}`} onSubmit={save} noValidate aria-labelledby="access-title">
      <div className={styles.accessHead}>
        <Icon name="key" />
        <div>
          <h2 id="access-title" className={styles.cardTitle}>
            {wantsLogin ? "This API needs a test login" : `This API needs ${a.scheme ? "a token" : "an API key"}`}
          </h2>
          <p className="muted small">{a.message}</p>
        </div>
      </div>

      {wantsLogin ? (
        <div className={styles.twoCol}>
          <div className="field">
            <label htmlFor={ids.user}>Test {a.username_label.toLowerCase()}</label>
            <input id={ids.user} name="auth_username" className="input" autoComplete="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.password}>Password</label>
            <input id={ids.password} name="auth_password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={ids.token}>{a.scheme ? "Token" : "API key"}</label>
          <input id={ids.token} name="token" className="input mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          <p className="helper">
            Sent as <span className="mono">{a.header_name}: {a.scheme ? `${a.scheme} ` : ""}…</span>
          </p>
        </div>
      )}
      <p className="helper">Use a test account on a test server. The password or token is stored as a secret, never shown again and never put in reports.</p>

      <p className={`helper ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
        {error ?? ""}
      </p>
      <div className={styles.actions}>
        <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? "Saving" : saveLabel}
        </button>
        {onSkip && (
          <button type="button" className="key key--plain" disabled={busy} onClick={onSkip}>
            Skip for now
          </button>
        )}
      </div>
    </form>
  );
}
