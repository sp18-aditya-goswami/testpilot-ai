"use client";

import { useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { MethodPath } from "@/components/Status";
import styles from "./plan.module.css";

/** Ask Claude for more cases in plain words, optionally for a few endpoints only. */
export function RefineBox({
  endpoints,
  aiOff,
  onRefine,
}: {
  endpoints: string[];
  aiOff: boolean;
  onRefine: (instruction: string, endpointIds: string[]) => Promise<void>;
}) {
  const uid = useId();
  const [text, setText] = useState("");
  const [only, setOnly] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || aiOff) return;
    if (!text.trim()) {
      setError("Say what to add, for example: cases for pagination and an empty page.");
      document.getElementById(`${uid}-text`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRefine(text.trim(), Array.from(only));
      setText("");
      setOnly(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claude could not add cases.");
    } finally {
      setBusy(false);
    }
  }

  const helpId = `${uid}-help`;
  return (
    <form className={`panel ${styles.refine}`} onSubmit={submit} aria-labelledby={`${uid}-head`} noValidate>
      <div className={styles.refineHead}>
        <Icon name="spark" />
        <h2 id={`${uid}-head`}>Ask Claude for more cases</h2>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-text`} className="visually-hidden">
          What to add
        </label>
        <textarea
          id={`${uid}-text`}
          name="instruction"
          className="input"
          rows={3}
          placeholder="Add cases for pagination, and for updating a user that was just deleted"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={aiOff}
          aria-invalid={error && !text.trim() ? true : undefined}
          aria-describedby={helpId}
        />
      </div>
      <div className={styles.refineFoot}>
        <details className={styles.refineScope}>
          <summary>{only.size === 0 ? "All endpoints" : `${only.size} ${only.size === 1 ? "endpoint" : "endpoints"} only`}</summary>
          <fieldset>
            <legend className="visually-hidden">Limit to endpoints</legend>
            {endpoints.map((e) => (
              <label key={e} className="check">
                <input
                  type="checkbox"
                  checked={only.has(e)}
                  disabled={aiOff}
                  onChange={(ev) =>
                    setOnly((prev) => {
                      const next = new Set(prev);
                      if (ev.target.checked) next.add(e);
                      else next.delete(e);
                      return next;
                    })
                  }
                />
                <MethodPath id={e} />
              </label>
            ))}
          </fieldset>
        </details>
        <button type="submit" className="key" disabled={aiOff || busy} aria-busy={busy || undefined} aria-describedby={helpId}>
          {busy && <span className="spinner keep-motion" aria-hidden="true" />}
          {busy ? "Asking Claude" : "Add cases"}
        </button>
      </div>
      <p id={helpId} className={`helper${error ? " is-error" : ""}`} role={error ? "alert" : undefined}>
        {aiOff ? "AI is off for this plan. Add an Anthropic key in Settings, then create a new plan." : (error ?? "New cases are checked against the spec before they join the plan.")}
      </p>
    </form>
  );
}
