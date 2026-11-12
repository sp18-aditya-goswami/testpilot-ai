"use client";

import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import { ws, type CollectionNode, type FolderNode } from "@/lib/workspace";
import { Icon } from "./Icon";
import styles from "./sidebar.module.css";

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

/** Reads an OpenAPI document. "import" also turns it into a collection of saved requests; "load" only adds it to the project's API specs. */
export function ImportDialog({
  open,
  projectId,
  purpose = "import",
  onClose,
  onImported,
  onLoaded,
}: {
  open: boolean;
  projectId: string;
  purpose?: "import" | "load";
  onClose: () => void;
  onImported?: (collection: CollectionNode) => void;
  onLoaded?: (specId: string) => void;
}) {
  const ref = useModal(open);
  const ids = { url: useId(), text: useId(), name: useId(), title: useId() };
  const [mode, setMode] = useState<"url" | "paste">("url");
  const [url, setUrl] = useState("http://localhost:8008/openapi.json");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [byTag, setByTag] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={ids.title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current && !busy) ref.current?.close();
      }}
    >
      <form
        className={styles.dialogBody}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const res = await ws.inspectForProject(projectId, mode === "url" ? { spec_url: url.trim() } : { spec_text: text });
            if (purpose === "load") {
              ref.current?.close();
              onLoaded?.(res.api.spec_id);
              return;
            }
            const collection = await ws.importSpec(projectId, {
              spec_id: res.api.spec_id,
              collection_name: name.trim() || undefined,
              group_by_tag: byTag,
            });
            onImported?.(collection);
            ref.current?.close();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id={ids.title}>{purpose === "load" ? "Load an API spec" : "Import an OpenAPI document"}</h2>
        <p className="small">
          {purpose === "load"
            ? "Adds the contract to this project so you can read it and build test suites from it. Nothing is sent to the API."
            : "Each operation becomes a saved request with its documented success status as the check."}
        </p>
        <div className="tray" role="group" aria-label="Source">
          <button type="button" aria-pressed={mode === "url"} onClick={() => setMode("url")}>
            From URL
          </button>
          <button type="button" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>
            Paste document
          </button>
        </div>
        {mode === "url" ? (
          <div className="field">
            <label htmlFor={ids.url}>Specification URL</label>
            <input id={ids.url} className="input" type="url" inputMode="url" autoComplete="off" required value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
        ) : (
          <div className="field">
            <label htmlFor={ids.text}>OpenAPI JSON or YAML</label>
            <textarea id={ids.text} className="input code-input" required placeholder="openapi: 3.1.0" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
        {purpose === "import" && (
          <>
            <div className="field">
              <label htmlFor={ids.name}>Collection name</label>
              <input id={ids.name} className="input" autoComplete="off" placeholder="The specification's title" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <label className="check">
              <input type="checkbox" checked={byTag} onChange={(e) => setByTag(e.target.checked)} />
              <span>Make one folder per tag</span>
            </label>
          </>
        )}
        {error && (
          <p className="helper is-error" role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className="key" disabled={busy} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
            {busy && <span className="spinner" aria-hidden="true" />}
            {purpose === "load" ? "Load spec" : "Import"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

interface Destination {
  key: string;
  label: string;
  depth: number;
  collectionId: string;
  folderId: string | null;
  isCollection: boolean;
}

function destinations(collections: CollectionNode[]): Destination[] {
  const out: Destination[] = [];
  const walk = (folders: FolderNode[], collectionId: string, depth: number) => {
    for (const f of folders) {
      out.push({ key: f.id, label: f.name, depth, collectionId, folderId: f.id, isCollection: false });
      walk(f.folders, collectionId, depth + 1);
    }
  };
  for (const c of collections) {
    out.push({ key: c.id, label: c.name, depth: 0, collectionId: c.id, folderId: null, isCollection: true });
    walk(c.folders, c.id, 1);
  }
  return out;
}

/** Lists every collection and folder; picking one moves the item there. */
export function MoveDialog({
  open,
  itemName,
  current,
  collections,
  onClose,
  onMove,
}: {
  open: boolean;
  itemName: string;
  current: { collectionId: string; folderId: string | null } | null;
  collections: CollectionNode[];
  onClose: () => void;
  onMove: (collectionId: string, folderId: string | null) => Promise<void>;
}) {
  const ref = useModal(open);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

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
      <div className={styles.dialogBody}>
        <h2 id={titleId}>Move {itemName}</h2>
        <ul className={styles.destinations}>
          {destinations(collections).map((d) => {
            const here = current?.collectionId === d.collectionId && current?.folderId === d.folderId;
            return (
              <li key={d.key}>
                <button
                  type="button"
                  className={styles.dest}
                  style={{ "--depth": d.depth } as React.CSSProperties}
                  disabled={here || busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      await onMove(d.collectionId, d.folderId);
                      ref.current?.close();
                    } catch (err) {
                      setError(errorMessage(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Icon name={d.isCollection ? "layers" : "folder"} />
                  {d.label}
                  {here && <span className={styles.destHere}>Here now</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {error && (
          <p className="helper is-error" role="alert">
            {error}
          </p>
        )}
        <div className={styles.dialogActions}>
          <button type="button" className="key" disabled={busy} onClick={() => ref.current?.close()}>
            Cancel
          </button>
        </div>
      </div>
    </dialog>
  );
}
