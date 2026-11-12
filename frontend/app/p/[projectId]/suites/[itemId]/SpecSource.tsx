"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage, type ApiSummary } from "@/lib/api";
import { ws } from "@/lib/workspace";
import styles from "./suite.module.css";

const DEMO_SPEC_URL = "http://localhost:8008/openapi.json";

type ProjectSpec = { spec_id: string; title: string; version: string; endpoint_count: number; created_at: string };
type Mode = "url" | "paste";

/** Choose one of the project's specifications or read a new one; calls onPick with the spec id. */
export function SpecSource({
  projectId,
  allowedHosts,
  onPick,
  onCancel,
}: {
  projectId: string;
  allowedHosts: string[] | null;
  onPick: (specId: string, api?: ApiSummary) => Promise<void>;
  onCancel?: () => void;
}) {
  const [specs, setSpecs] = useState<ProjectSpec[] | null>(null);
  const [specsError, setSpecsError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("url");
  const [specUrl, setSpecUrl] = useState(DEMO_SPEC_URL);
  const [specText, setSpecText] = useState("");
  const [reading, setReading] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    ws.projectSpecs(projectId).then(
      (list) => !cancelled && setSpecs(list),
      (err) => !cancelled && setSpecsError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function pickExisting(specId: string) {
    setPicking(specId);
    setError(null);
    try {
      await onPick(specId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPicking(null);
    }
  }

  async function read(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = mode === "url" ? specUrl.trim() : specText.trim();
    if (!value) {
      setError(mode === "url" ? "Enter the URL of an OpenAPI document." : "Paste an OpenAPI document in JSON or YAML.");
      sourceRef.current?.focus();
      return;
    }
    setReading(true);
    try {
      const res = await ws.inspectForProject(projectId, mode === "url" ? { spec_url: value } : { spec_text: value });
      await onPick(res.api.spec_id, res.api);
    } catch (err) {
      setError(errorMessage(err));
      sourceRef.current?.focus();
    } finally {
      setReading(false);
    }
  }

  const helper =
    error ??
    (mode === "url"
      ? allowedHosts
        ? `Fetched only from allowlisted hosts: ${allowedHosts.join(", ")}.`
        : "Fetched only from allowlisted hosts."
      : "JSON or YAML, OpenAPI 3 or Swagger 2.");

  return (
    <form className={`panel ${styles.source}`} onSubmit={read} noValidate aria-label="Specification source">
      {specsError && (
        <p className="notice" role="alert">
          Could not list this project&rsquo;s specifications: {specsError}
        </p>
      )}
      {specs && specs.length > 0 && (
        <div className={styles.existing}>
          <h3 className="label">Specifications in this project</h3>
          <ul className={styles.existingList}>
            {specs.map((s) => (
              <li key={s.spec_id}>
                <button
                  type="button"
                  className={styles.existingButton}
                  disabled={picking !== null || reading}
                  aria-busy={picking === s.spec_id || undefined}
                  onClick={() => pickExisting(s.spec_id)}
                >
                  <span>
                    {s.title} <span className="muted">{s.version ? `version ${s.version}` : ""}</span>
                  </span>
                  <span className={styles.existingMeta}>
                    {picking === s.spec_id && <span className="spinner" aria-hidden="true" />} {s.endpoint_count}{" "}
                    {s.endpoint_count === 1 ? "endpoint" : "endpoints"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {specs === null && !specsError && <div className={`skeleton ${styles.specsSkeleton}`} aria-hidden="true" />}

      <div className={`row ${styles.sourceTop}`}>
        <div className="tray" role="group" aria-label="New specification source">
          <button type="button" aria-pressed={mode === "url"} onClick={() => { setMode("url"); setError(null); }}>
            From URL
          </button>
          <button type="button" aria-pressed={mode === "paste"} onClick={() => { setMode("paste"); setError(null); }}>
            Paste document
          </button>
        </div>
        {onCancel && (
          <button type="button" className="key key--plain" onClick={onCancel}>
            Keep current
          </button>
        )}
      </div>

      {mode === "url" ? (
        <div className="field">
          <label htmlFor="suite-spec-url">Specification URL</label>
          <div className={styles.sourceRow}>
            <input
              ref={sourceRef}
              id="suite-spec-url"
              name="spec_url"
              type="url"
              inputMode="url"
              autoComplete="url"
              className="input"
              value={specUrl}
              onChange={(e) => {
                setSpecUrl(e.target.value);
                if (error) setError(null);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby="suite-source-help"
            />
            <button type="submit" className="key key--primary" disabled={reading || picking !== null} aria-busy={reading || undefined}>
              {reading && <span className="spinner" aria-hidden="true" />}
              Read specification
            </button>
          </div>
          <p id="suite-source-help" className={`helper${error ? " is-error" : ""}`}>
            {helper}
          </p>
        </div>
      ) : (
        <div className="field">
          <label htmlFor="suite-spec-text">OpenAPI document</label>
          <textarea
            ref={sourceRef}
            id="suite-spec-text"
            name="spec_text"
            className="input code-input"
            value={specText}
            onChange={(e) => {
              setSpecText(e.target.value);
              if (error) setError(null);
            }}
            placeholder={"openapi: 3.1.0\ninfo:\n  title: Orders API\n  version: 1.0.0\npaths: …"}
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby="suite-source-help"
          />
          <p id="suite-source-help" className={`helper${error ? " is-error" : ""}`}>
            {helper}
          </p>
          <div>
            <button type="submit" className="key key--primary" disabled={reading || picking !== null} aria-busy={reading || undefined}>
              {reading && <span className="spinner" aria-hidden="true" />}
              Read specification
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
