"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { itemTrail } from "@/components/itemTrail";
import { useProject } from "@/components/ProjectContext";
import { errorMessage } from "@/lib/api";
import { EMPTY_REQUEST, HTTP_METHODS, ws, type HttpMethod, type Item, type SavedRequest, type SendResult } from "@/lib/workspace";
import { KeyValueEditor } from "./KeyValueEditor";
import { ResponsePanel } from "./ResponsePanel";
import { jsonError, parseStatusList, toCurl, unknownVariables } from "./requestUtils";
import styles from "./request.module.css";

const TABS = [
  { id: "params", label: "Params" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "checks", label: "Checks" },
  { id: "docs", label: "Docs" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const HEADER_SUGGESTIONS = ["Authorization", "Content-Type", "Accept", "Accept-Language", "Cache-Control", "X-Request-Id"];
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function EditorSkeleton() {
  return (
    <div className={styles.page} aria-busy="true" aria-label="Loading the request">
      <div className={`skeleton ${styles.skelTitle}`} />
      <div className={`skeleton ${styles.skelBar}`} />
      <div className={`skeleton ${styles.skelBody}`} />
    </div>
  );
}

export function RequestEditor({ projectId, itemId }: { projectId: string; itemId: string }) {
  const { tree, environment, refresh } = useProject();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = TABS.some((t) => t.id === tabParam) ? (tabParam as Tab) : "params";

  const [item, setItem] = useState<Item | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [req, setReq] = useState<SavedRequest>(EMPTY_REQUEST);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [statusText, setStatusText] = useState("");
  const [schemaText, setSchemaText] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);

  const adopt = useCallback((it: Item) => {
    const r = it.request ?? EMPTY_REQUEST;
    setItem(it);
    setName(it.name);
    setReq(r);
    setSavedSnapshot(JSON.stringify(r));
    setStatusText(r.assertions.expected_status.join(", "));
    setSchemaText(r.assertions.json_schema ? JSON.stringify(r.assertions.json_schema, null, 2) : "");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      adopt(await ws.item(itemId));
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [itemId, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = item !== null && JSON.stringify(req) !== savedSnapshot;
  const status = useMemo(() => parseStatusList(statusText), [statusText]);
  const schemaErr = useMemo(() => jsonError(schemaText), [schemaText]);
  const bodyErr = req.body_mode === "json" ? jsonError(req.body) : null;
  const unknown = useMemo(() => unknownVariables(req, environment), [req, environment]);
  const curl = useMemo(() => toCurl(req, environment), [req, environment]);

  const patch = (p: Partial<SavedRequest>) => setReq((r) => ({ ...r, ...p }));
  const patchAssert = (p: Partial<SavedRequest["assertions"]>) => setReq((r) => ({ ...r, assertions: { ...r.assertions, ...p } }));

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", t);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const save = useCallback(async () => {
    if (!item || saving) return;
    if (status.error || schemaErr) {
      setSaveError("Fix the checks before saving.");
      setTab("checks");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await ws.updateItem(item.id, { name: name.trim() || item.name, request: req });
      adopt(updated);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
      void refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [item, saving, status.error, schemaErr, name, req, adopt, refresh]);

  const saveName = async () => {
    if (!item) return;
    const next = name.trim();
    if (!next) {
      setName(item.name);
      return;
    }
    if (next === item.name) return;
    try {
      const updated = await ws.updateItem(item.id, { name: next });
      setItem(updated);
      void refresh();
    } catch (err) {
      setSaveError(errorMessage(err));
      setName(item.name);
    }
  };

  const send = useCallback(async () => {
    if (!environment || sending) return;
    if (bodyErr) {
      setSendError(`The JSON body does not parse: ${bodyErr}`);
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      setResult(await ws.send({ environment_id: environment.id, request: req }));
    } catch (err) {
      setSendError(errorMessage(err));
      setResult(null);
    } finally {
      setSending(false);
    }
  }, [environment, sending, bodyErr, req]);

  const saveRef = useRef(save);
  const sendRef = useRef(send);
  saveRef.current = save;
  sendRef.current = send;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "s") {
        e.preventDefault();
        void saveRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void sendRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loading && !item) return <EditorSkeleton />;

  if (loadError) {
    return (
      <div className={styles.page}>
        <div className="error-state" role="alert">
          <h3>This request could not be loaded</h3>
          <p>{loadError}</p>
          <button type="button" className="key" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!item) return null;

  if (item.kind !== "request") {
    return (
      <div className={styles.page}>
        <div className="empty">
          <h3>{item.name} is a test suite</h3>
          <p>Suites plan and run generated cases instead of one saved request.</p>
          <Link className="key" href={`/p/${projectId}/suites/${item.id}`}>
            Open the suite
          </Link>
        </div>
      </div>
    );
  }

  const mod = isMac() ? "Cmd" : "Ctrl";
  const envVarKeys = environment?.variables.map((v) => v.key) ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <Breadcrumbs items={itemTrail(tree, projectId, itemId)} />
          <label className="visually-hidden" htmlFor="request-name">
            Request name
          </label>
          <input
            id="request-name"
            className={styles.nameInput}
            value={name}
            maxLength={120}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(item.name);
                e.currentTarget.blur();
              }
            }}
          />
        </div>
        <div className={styles.headActions}>
          <span className={`small ${dirty ? styles.unsaved : "muted"}`} role="status">
            {saving ? "Saving" : justSaved ? "Saved" : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <CopyButton text={curl} label="Copy as cURL" />
          <button type="button" className="key" onClick={() => void save()} disabled={!dirty} aria-busy={saving} title={`Save (${mod}+S)`}>
            {saving && <span className="spinner" aria-hidden="true" />}
            Save
          </button>
        </div>
      </header>
      {saveError && (
        <p className="helper is-error" role="alert">
          {saveError}
        </p>
      )}

      <div className={styles.bar}>
        <label className="visually-hidden" htmlFor="request-method">
          Method
        </label>
        <select
          id="request-method"
          className={`input ${styles.method}`}
          value={req.method}
          onChange={(e) => patch({ method: e.target.value as HttpMethod })}
        >
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className={styles.url}>
          <span className={styles.base} title={environment?.base_url}>
            {environment ? environment.base_url.replace(/\/+$/, "") : "No environment"}
          </span>
          <label className="visually-hidden" htmlFor="request-path">
            Path
          </label>
          <input
            id="request-path"
            className={`input ${styles.path}`}
            value={req.path}
            placeholder="/api/users/{{user_id}}"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={unknown.length > 0}
            aria-describedby="request-path-help"
            onChange={(e) => patch({ path: e.target.value })}
          />
        </div>
        <button
          type="button"
          className="key key--primary"
          onClick={() => void send()}
          disabled={!environment || sending}
          aria-busy={sending}
          title={`Send (${mod}+Enter)`}
        >
          {sending ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" />}
          Send
        </button>
      </div>
      <p id="request-path-help" className={`helper ${unknown.length ? "is-error" : ""}`}>
        {!environment ? (
          <>
            Choose or create an environment to send this request.{" "}
            <Link href={`/p/${projectId}/environments`}>Open environments</Link>
          </>
        ) : unknown.length ? (
          <>
            Unknown {unknown.length === 1 ? "variable" : "variables"}: {unknown.map((v) => `{{${v}}}`).join(", ")}.{" "}
            {envVarKeys.length ? `${environment.name} defines ${envVarKeys.join(", ")}.` : `${environment.name} defines no variables yet.`}
          </>
        ) : (
          <>
            Sends to {environment.name}. {environment.base_url_allowed ? "" : "This host is outside the allowlist, so the backend will refuse it."}
          </>
        )}
      </p>

      <div className="tray" role="tablist" aria-label="Request parts">
        {TABS.map((t) => {
          const count =
            t.id === "params"
              ? req.query.filter((q) => q.enabled).length
              : t.id === "headers"
                ? req.headers.filter((h) => h.enabled).length
                : 0;
          const flagged = (t.id === "checks" && (status.error || schemaErr)) || (t.id === "body" && bodyErr);
          return (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-controls={`tab-${t.id}`} onClick={() => setTab(t.id)}>
              {t.label}
              {count > 0 && <span className={styles.tabCount}>{count}</span>}
              {flagged && <span className={styles.tabFlag}>needs a fix</span>}
            </button>
          );
        })}
      </div>

      <section id={`tab-${tab}`} role="tabpanel" className={styles.tabPanel}>
        {tab === "params" && <KeyValueEditor label="Params" rows={req.query} onChange={(query) => patch({ query })} />}

        {tab === "headers" && (
          <KeyValueEditor label="Headers" rows={req.headers} onChange={(headers) => patch({ headers })} keySuggestions={HEADER_SUGGESTIONS} />
        )}

        {tab === "body" && (
          <div className="stack">
            <div className="tray" role="group" aria-label="Body type">
              {(["none", "json", "raw"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={req.body_mode === m} onClick={() => patch({ body_mode: m })}>
                  {m === "none" ? "None" : m === "json" ? "JSON" : "Raw text"}
                </button>
              ))}
            </div>
            {req.body_mode === "none" ? (
              <p className="small muted">This request sends no body.</p>
            ) : (
              <div className="field">
                <div className={styles.bodyHead}>
                  <label htmlFor="request-body">{req.body_mode === "json" ? "JSON body" : "Raw body"}</label>
                  {req.body_mode === "json" && (
                    <button
                      type="button"
                      className="key key--plain"
                      disabled={!!bodyErr || !req.body.trim()}
                      onClick={() => patch({ body: JSON.stringify(JSON.parse(req.body), null, 2) })}
                    >
                      Format
                    </button>
                  )}
                </div>
                <textarea
                  id="request-body"
                  className="input code-input"
                  value={req.body}
                  spellCheck={false}
                  placeholder={req.body_mode === "json" ? '{ "email": "tp.{{unique}}@example.com" }' : "plain text"}
                  aria-invalid={!!bodyErr}
                  aria-describedby="request-body-help"
                  onChange={(e) => patch({ body: e.target.value })}
                />
                <p id="request-body-help" className={`helper ${bodyErr ? "is-error" : ""}`}>
                  {bodyErr ? `Not valid JSON: ${bodyErr}` : "Variables like {{token}} and {{unique}} are filled in when the request is sent."}
                </p>
              </div>
            )}
          </div>
        )}

        {tab === "checks" && (
          <div className={styles.checksGrid}>
            <div className="field">
              <label htmlFor="expected-status">Expected status codes</label>
              <input
                id="expected-status"
                className="input"
                value={statusText}
                inputMode="numeric"
                placeholder="201, 409"
                aria-invalid={!!status.error}
                aria-describedby="expected-status-help"
                onChange={(e) => {
                  setStatusText(e.target.value);
                  const parsed = parseStatusList(e.target.value);
                  if (!parsed.error) patchAssert({ expected_status: parsed.codes });
                }}
              />
              <p id="expected-status-help" className={`helper ${status.error ? "is-error" : ""}`}>
                {status.error ?? "The check fails when the response status is not one of these."}
              </p>
            </div>
            <div className="field">
              <label htmlFor="max-ms">Slowest acceptable response, ms</label>
              <input
                id="max-ms"
                className="input"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="No limit"
                value={req.assertions.max_ms ?? ""}
                onChange={(e) => patchAssert({ max_ms: e.target.value === "" ? null : Math.max(1, Math.round(Number(e.target.value))) })}
              />
              <p className="helper">Leave empty for no time limit.</p>
            </div>
            <div className={`field ${styles.schemaField}`}>
              <label htmlFor="json-schema">Response JSON schema</label>
              <textarea
                id="json-schema"
                className="input code-input"
                value={schemaText}
                spellCheck={false}
                placeholder='{ "type": "object", "required": ["id"] }'
                aria-invalid={!!schemaErr}
                aria-describedby="json-schema-help"
                onChange={(e) => {
                  setSchemaText(e.target.value);
                  const err = jsonError(e.target.value);
                  if (!err) patchAssert({ json_schema: e.target.value.trim() ? JSON.parse(e.target.value) : null });
                }}
              />
              <p id="json-schema-help" className={`helper ${schemaErr ? "is-error" : ""}`}>
                {schemaErr ? `Not valid JSON: ${schemaErr}` : "Optional. The response body must validate against it."}
              </p>
            </div>
          </div>
        )}

        {tab === "docs" && (
          <div className="field">
            <label htmlFor="request-docs">What this request is for</label>
            <textarea
              id="request-docs"
              className="input"
              value={req.description}
              placeholder="Registers a user. Needs a fresh email each time."
              onChange={(e) => patch({ description: e.target.value })}
            />
            <p className="helper">Teammates see this when they open the request.</p>
          </div>
        )}
      </section>

      <ResponsePanel result={result} sending={sending} error={sendError} />
    </div>
  );
}
