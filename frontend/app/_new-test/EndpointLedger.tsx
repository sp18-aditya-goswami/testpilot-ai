"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import type { Endpoint, Json } from "@/lib/api";
import { MethodPath } from "@/components/Status";
import styles from "./new-test.module.css";

function bodyFields(ep: Endpoint): { name: string; required: boolean }[] {
  const schema = ep.request_body_schema;
  if (!schema) return [];
  const props = schema.properties;
  const required = Array.isArray(schema.required) ? (schema.required as Json[]).map(String) : [];
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  return Object.keys(props).map((name) => ({ name, required: required.includes(name) }));
}

function RequestFields({ ep }: { ep: Endpoint }) {
  const params = ep.parameters.filter((p) => p.location === "path" || p.location === "query");
  const fields = bodyFields(ep);
  if (!params.length && !fields.length) return <span className="muted">none</span>;
  return (
    <span className={styles.fields}>
      {params.map((p, i) => (
        <span key={`p-${p.name}`}>
          {i > 0 && ", "}
          <span className={p.required ? `mono ${styles.fieldRequired}` : "mono"}>{p.name}</span> in {p.location}
        </span>
      ))}
      {fields.map((f, i) => (
        <span key={`f-${f.name}`}>
          {(i > 0 || params.length > 0) && ", "}
          <span className={f.required ? `mono ${styles.fieldRequired}` : "mono"}>{f.name}</span>
          {f.required && <span className={styles.requiredWord}> required</span>}
        </span>
      ))}
    </span>
  );
}

function StatusCodes({ ep }: { ep: Endpoint }) {
  const codes = Object.keys(ep.responses);
  if (!codes.length) return <span className="muted">none</span>;
  return (
    <span className={styles.codes}>
      {codes.map((c) => (
        <span key={c} className={/^\d/.test(c) ? `http http--${c[0]}` : "http muted"}>
          {c}
        </span>
      ))}
    </span>
  );
}

export function EndpointLedger({
  endpoints,
  selected,
  onChange,
  notes,
  onNoteChange,
}: {
  endpoints: Endpoint[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Per-endpoint notes for the planner; the note column shows only when onNoteChange is given. */
  notes?: Record<string, string>;
  onNoteChange?: (endpointId: string, note: string) => void;
}) {
  const allRef = useRef<HTMLInputElement>(null);
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  const withNotes = Boolean(onNoteChange);
  const columns = withNotes ? 6 : 5;
  const all = selected.size === endpoints.length;
  const none = selected.size === 0;

  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = !all && !none;
  }, [all, none]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="table-scroll">
      <table className="ledger">
        <caption className="visually-hidden">Endpoints in the specification. Checked endpoints are included in the plan.</caption>
        <thead>
          <tr>
            <th className={styles.checkCell} scope="col">
              <label className="check">
                <input
                  ref={allRef}
                  type="checkbox"
                  checked={all}
                  onChange={() => onChange(all ? new Set() : new Set(endpoints.map((e) => e.id)))}
                />
                <span className="visually-hidden">Include all endpoints</span>
              </label>
            </th>
            <th scope="col">Endpoint</th>
            <th scope="col">Summary</th>
            <th scope="col">Request fields</th>
            <th scope="col">Documented</th>
            {withNotes && (
              <th scope="col">
                <span className="visually-hidden">Planner note</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep) => {
            const on = selected.has(ep.id);
            const note = notes?.[ep.id] ?? "";
            const noteOpen = openNotes.has(ep.id);
            const noteId = `note-${ep.id.replace(/[^a-zA-Z0-9]+/g, "-")}`;
            return (
              <Fragment key={ep.id}>
              <tr className={on ? undefined : "muted"}>
                <td className={styles.checkCell}>
                  <label className="check">
                    <input type="checkbox" checked={on} onChange={() => toggle(ep.id)} />
                    <span className="visually-hidden">Include {ep.id}</span>
                  </label>
                </td>
                <td>
                  <MethodPath id={ep.id} />
                </td>
                <td className={styles.summaryCell}>{ep.summary || <span className="muted">No summary</span>}</td>
                <td>
                  <RequestFields ep={ep} />
                </td>
                <td>
                  <StatusCodes ep={ep} />
                </td>
                {withNotes && (
                  <td className={styles.noteCell}>
                    <button
                      type="button"
                      className="key key--plain"
                      aria-expanded={noteOpen}
                      aria-controls={noteId}
                      onClick={() => {
                        const next = new Set(openNotes);
                        if (next.has(ep.id)) next.delete(ep.id);
                        else next.add(ep.id);
                        setOpenNotes(next);
                      }}
                    >
                      {note ? "Edit note" : "Add note"}
                    </button>
                  </td>
                )}
              </tr>
              {withNotes && noteOpen && (
                <tr id={noteId} className={styles.noteRow}>
                  <td />
                  <td colSpan={columns - 1}>
                    <div className="field">
                      <label htmlFor={`${noteId}-text`}>Note for {ep.id}</label>
                      <textarea
                        id={`${noteId}-text`}
                        name={`note_${ep.id}`}
                        className="input"
                        rows={2}
                        maxLength={1000}
                        value={note}
                        placeholder="Only admins may call this; ids are UUIDs"
                        onChange={(e) => onNoteChange?.(ep.id, e.target.value)}
                      />
                      <p className="helper">The AI planner reads this when it plans cases for this endpoint.</p>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
