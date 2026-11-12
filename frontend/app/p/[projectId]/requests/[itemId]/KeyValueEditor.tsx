"use client";

import { Icon } from "@/components/Icon";
import type { KeyValue } from "@/lib/workspace";
import styles from "./request.module.css";

export function KeyValueEditor({
  label,
  rows,
  onChange,
  keySuggestions,
}: {
  label: string;
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keySuggestions?: string[];
}) {
  const listId = keySuggestions ? `${label.toLowerCase().replace(/\s+/g, "-")}-keys` : undefined;
  const update = (i: number, patch: Partial<KeyValue>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className={styles.kv}>
      {listId && (
        <datalist id={listId}>
          {keySuggestions!.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      )}
      {rows.length > 0 && (
        <table className={`ledger ${styles.kvTable}`}>
          <thead>
            <tr>
              <th className={styles.kvToggle}>
                <span className="visually-hidden">On</span>
              </th>
              <th>Key</th>
              <th>Value</th>
              <th className={styles.kvAction}>
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.enabled ? undefined : styles.kvOff}>
                <td className={styles.kvToggle}>
                  <label className="check">
                    <input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                    <span className="visually-hidden">Send {r.key || "this row"}</span>
                  </label>
                </td>
                <td>
                  <input
                    className={`input ${styles.kvInput}`}
                    aria-label={`${label} key ${i + 1}`}
                    value={r.key}
                    list={listId}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => update(i, { key: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className={`input ${styles.kvInput}`}
                    aria-label={`${label} value ${i + 1}`}
                    value={r.value}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => update(i, { value: e.target.value })}
                  />
                </td>
                <td className={styles.kvAction}>
                  <button
                    type="button"
                    className="key key--plain"
                    aria-label={`Remove ${r.key || `row ${i + 1}`}`}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length === 0 && <p className="small muted">No {label.toLowerCase()} yet.</p>}
      <button type="button" className={`key ${styles.addRow}`} onClick={() => onChange([...rows, { key: "", value: "", enabled: true }])}>
        <Icon name="plus" />
        Add {label === "Params" ? "a parameter" : "a header"}
      </button>
    </div>
  );
}
