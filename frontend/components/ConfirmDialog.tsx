"use client";

import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import styles from "./dialog.module.css";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children?: React.ReactNode;
  confirmLabel: string;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  requireText?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}

/** A native <dialog> for confirmations; the error from a failed action stays in the dialog. */
export function ConfirmDialog({ open, title, children, confirmLabel, requireText, danger, onConfirm, onClose }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped("");
      setError(null);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const blocked = requireText !== undefined && typed !== requireText;

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current && !busy) ref.current?.close();
      }}
    >
      <form
        method="dialog"
        className={styles.body}
        onSubmit={async (e) => {
          e.preventDefault();
          if (blocked || busy) return;
          setBusy(true);
          setError(null);
          try {
            await onConfirm();
            ref.current?.close();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {children && <div className={styles.text}>{children}</div>}
        {requireText !== undefined && (
          <div className="field">
            <label htmlFor={inputId}>
              Type <strong>{requireText}</strong> to confirm
            </label>
            <input id={inputId} className="input" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </div>
        )}
        {error && (
          <p className="helper is-error" role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button type="button" className="key" onClick={() => ref.current?.close()} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={`key ${danger ? styles.dangerKey : "key--primary"}`} disabled={blocked || busy} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
