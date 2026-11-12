"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { Category, Json, RequestSpec, TestCase } from "@/lib/api";
import { CATEGORIES } from "./CoverageGrid";
import styles from "./plan.module.css";

export type CaseBody = Omit<TestCase, "id">;
type BodyMode = "none" | "json" | "raw";

function splitEndpoint(endpointId: string) {
  const i = endpointId.indexOf(" ");
  return i > 0 ? { method: endpointId.slice(0, i), path: endpointId.slice(i + 1) } : { method: "GET", path: endpointId };
}

const show = (value: unknown) => (value && typeof value === "object" && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : "");

type Errors = Partial<Record<"name" | "expected" | "path_params" | "query" | "headers" | "body", string>>;

function parseObject(text: string, label: string, stringValues = false): { value?: Record<string, Json>; error?: string } {
  if (!text.trim()) return { value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${label} is not valid JSON. Use an object such as {"key": "value"}.` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${label} must be a JSON object, not a list or a single value.` };
  if (stringValues && Object.values(parsed).some((v) => typeof v !== "string")) return { error: `${label} values must all be strings.` };
  return { value: parsed as Record<string, Json> };
}

/** Edit an existing case, or write a new one for an endpoint. Method and path stay fixed to the endpoint. */
export function CaseEditor({
  mode,
  endpointId,
  initial,
  onSubmit,
  onCancel,
}: {
  mode: "edit" | "add";
  endpointId: string;
  initial?: TestCase;
  onSubmit: (body: CaseBody) => Promise<void>;
  onCancel: () => void;
}) {
  const uid = useId();
  const { method, path } = splitEndpoint(endpointId);
  const req = initial?.request;

  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "positive");
  const [expected, setExpected] = useState(initial ? initial.expected_status.join(", ") : "200");
  const [rationale, setRationale] = useState(initial?.rationale ?? "");
  const [pathParams, setPathParams] = useState(show(req?.path_params));
  const [query, setQuery] = useState(show(req?.query));
  const [headers, setHeaders] = useState(show(req?.headers));
  const [bodyMode, setBodyMode] = useState<BodyMode>(req?.raw_body != null ? "raw" : req?.body != null ? "json" : "none");
  const [body, setBody] = useState(req?.raw_body ?? (req?.body != null ? JSON.stringify(req.body, null, 2) : ""));
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const needsPathParams = /\{[^}]+\}/.test(path);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    if (!name.trim()) next.name = "Give the case a name that says what it checks.";
    const codes = expected
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (codes.length === 0 || codes.some((n) => !Number.isInteger(n) || n < 100 || n > 599))
      next.expected = "List one or more status codes from 100 to 599, separated by commas.";
    else if (codes.some((n) => n >= 500)) next.expected = "A 5xx is never a correct outcome. Expect the client error or success instead.";
    const pp = parseObject(pathParams, "Path parameters");
    const q = parseObject(query, "Query");
    const h = parseObject(headers, "Headers", true);
    if (pp.error) next.path_params = pp.error;
    if (q.error) next.query = q.error;
    if (h.error) next.headers = h.error;
    let bodyValue: Json = null;
    if (bodyMode === "json" && body.trim()) {
      try {
        bodyValue = JSON.parse(body) as Json;
      } catch {
        next.body = "The body is not valid JSON. Switch to raw to send text as it is.";
      }
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      const first = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
      first?.focus();
      return;
    }

    const request: RequestSpec = {
      method,
      path,
      path_params: pp.value ?? {},
      query: q.value ?? {},
      headers: (h.value ?? {}) as Record<string, string>,
      body: bodyMode === "json" ? bodyValue : null,
      raw_body: bodyMode === "raw" ? body : null,
      omit_content_type: req?.omit_content_type ?? false,
    };
    setSaving(true);
    setFailure(null);
    try {
      await onSubmit({
        endpoint_id: endpointId,
        name: name.trim(),
        category,
        source: initial?.source ?? "saved",
        rationale: rationale.trim(),
        setup: initial?.setup ?? [],
        request,
        expected_status: Array.from(new Set(codes)).sort((a, b) => a - b),
        destructive: method === "DELETE",
      });
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "The case could not be saved.");
      setSaving(false);
    }
  }

  const field = (key: keyof Errors) => ({
    "aria-invalid": errors[key] ? (true as const) : undefined,
    "aria-describedby": `${uid}-${key}-help`,
  });
  const help = (key: keyof Errors, text = "") => (
    <p id={`${uid}-${key}-help`} className={`helper${errors[key] ? " is-error" : ""}`}>
      {errors[key] ?? text}
    </p>
  );

  return (
    <form ref={formRef} className={styles.editor} onSubmit={submit} noValidate aria-label={mode === "edit" ? `Edit ${initial?.name}` : `New case for ${endpointId}`}>
      <p className={styles.editorTarget}>
        <span className="mono">
          {method} {path}
        </span>
        {mode === "edit" && initial && initial.setup.length > 0 && (
          <span className="muted"> Setup steps stay as they are.</span>
        )}
      </p>

      <div className={styles.editorGrid}>
        <div className="field">
          <label htmlFor={`${uid}-name`}>Name</label>
          <input id={`${uid}-name`} name="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" {...field("name")} />
          {help("name")}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-category`}>Category</label>
          <select id={`${uid}-category`} name="category" className="input" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="helper" />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-expected`}>Expected status</label>
          <input
            id={`${uid}-expected`}
            name="expected_status"
            className="input mono"
            inputMode="numeric"
            placeholder="400, 422"
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
            autoComplete="off"
            {...field("expected")}
          />
          {help("expected", "Any of these codes passes.")}
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${uid}-rationale`}>Why this case matters</label>
        <input id={`${uid}-rationale`} name="rationale" className="input" value={rationale} onChange={(e) => setRationale(e.target.value)} autoComplete="off" />
        <p className="helper" />
      </div>

      <div className={styles.editorGrid}>
        {needsPathParams && (
          <div className="field">
            <label htmlFor={`${uid}-pp`}>Path parameters</label>
            <textarea id={`${uid}-pp`} name="path_params" className="input code-input" rows={4} placeholder='{"user_id": 1}' value={pathParams} onChange={(e) => setPathParams(e.target.value)} spellCheck={false} {...field("path_params")} />
            {help("path_params")}
          </div>
        )}
        <div className="field">
          <label htmlFor={`${uid}-query`}>Query</label>
          <textarea id={`${uid}-query`} name="query" className="input code-input" rows={4} placeholder='{"page": 2}' value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} {...field("query")} />
          {help("query")}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-headers`}>Headers</label>
          <textarea id={`${uid}-headers`} name="headers" className="input code-input" rows={4} placeholder='{"Authorization": "Bearer {{token}}"}' value={headers} onChange={(e) => setHeaders(e.target.value)} spellCheck={false} {...field("headers")} />
          {help("headers")}
        </div>
      </div>

      <div className="field">
        <div className={styles.bodyHead}>
          <span className="label" id={`${uid}-body-label`}>
            Body
          </span>
          <div className="tray" role="group" aria-labelledby={`${uid}-body-label`}>
            {(["none", "json", "raw"] as const).map((m) => (
              <button key={m} type="button" aria-pressed={bodyMode === m} onClick={() => setBodyMode(m)}>
                {m === "none" ? "No body" : m === "json" ? "JSON" : "Raw text"}
              </button>
            ))}
          </div>
        </div>
        {bodyMode !== "none" && (
          <>
            <textarea
              aria-labelledby={`${uid}-body-label`}
              name="body"
              className="input code-input"
              rows={8}
              placeholder={bodyMode === "json" ? '{"email": "tp.{{unique}}@example.com"}' : '{"truncated": '}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              {...field("body")}
            />
            {help("body", bodyMode === "raw" ? "Goes out exactly as written, useful for malformed input." : "")}
          </>
        )}
      </div>

      <div className={styles.editorActions}>
        <button type="submit" className="key key--primary" aria-busy={saving || undefined} disabled={saving}>
          {saving && <span className="spinner keep-motion" aria-hidden="true" />}
          {mode === "edit" ? (saving ? "Saving" : "Save case") : saving ? "Adding" : "Add case"}
        </button>
        <button type="button" className="key key--plain" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {failure && (
          <p className="helper is-error" role="alert">
            {failure}
          </p>
        )}
      </div>
    </form>
  );
}

/** A native dialog that asks before a case leaves the plan. */
export function DeleteCaseDialog({ testCase, onConfirm, onClose }: { testCase: TestCase | null; onConfirm: () => Promise<void>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (testCase && !d.open) {
      setError(null);
      setBusy(false);
      d.showModal();
    }
    if (!testCase && d.open) d.close();
  }, [testCase]);

  return (
    <dialog ref={ref} className={styles.dialog} onClose={onClose} aria-labelledby="delete-case-head">
      <h2 id="delete-case-head">Delete this case?</h2>
      <p>
        <strong>{testCase?.name}</strong> leaves the plan. Runs that already used it keep their results.
      </p>
      {error && (
        <p className="helper is-error" role="alert">
          {error}
        </p>
      )}
      <div className={styles.dialogActions}>
        <button
          type="button"
          className="key key--primary"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (err) {
              setError(err instanceof Error ? err.message : "The case could not be deleted.");
              setBusy(false);
            }
          }}
        >
          {busy && <span className="spinner keep-motion" aria-hidden="true" />}
          {busy ? "Deleting" : "Delete case"}
        </button>
        <button type="button" className="key" onClick={() => ref.current?.close()} disabled={busy}>
          Keep it
        </button>
      </div>
    </dialog>
  );
}
