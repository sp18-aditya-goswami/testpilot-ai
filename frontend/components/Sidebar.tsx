"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import {
  DEFAULT_PLANNER_CONFIG,
  EMPTY_REQUEST,
  ws,
  type CollectionNode,
  type FolderNode,
  type ItemSummary,
  type Project,
} from "@/lib/workspace";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Menu, type MenuItem } from "./Menu";
import { useProject } from "./ProjectContext";
import { ImportDialog, MoveDialog } from "./SidebarDialogs";
import styles from "./sidebar.module.css";

type ProjectSpec = Awaited<ReturnType<typeof ws.projectSpecs>>[number];

type Editing =
  | { kind: "new-collection" }
  | { kind: "new-folder"; collectionId: string; parentId: string | null; depth: number }
  | { kind: "rename"; target: "collection" | "folder" | "item"; id: string; name: string }
  | null;

type Deleting = { target: "collection" | "folder" | "item"; id: string; name: string } | null;
type Moving = { id: string; name: string; collectionId: string; folderId: string | null } | null;

const treeKey = (pid: string) => `testpilot-tree-${pid}`;

function readExpanded(pid: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(treeKey(pid));
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
}

function InlineName({
  initial,
  label,
  depth,
  onSubmit,
  onCancel,
}: {
  initial: string;
  label: string;
  depth: number;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const name = value.trim();
    if (!name) {
      setError("A name is needed.");
      return;
    }
    if (name === initial.trim()) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <li>
      <form
        className={styles.inline}
        style={{ "--depth": depth } as React.CSSProperties}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          autoFocus
          aria-label={label}
          aria-invalid={error ? true : undefined}
          value={value}
          disabled={busy}
          maxLength={120}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            if (!busy && !error) void submit();
          }}
        />
      </form>
      {error && (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function Sidebar() {
  const { projectId, tree, error, refresh, environment, setEnvironmentId } = useProject();
  const pathname = usePathname();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadedExpanded, setLoadedExpanded] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);
  const [moving, setMoving] = useState<Moving>(null);
  const [importing, setImporting] = useState(false);
  const [loadingSpec, setLoadingSpec] = useState(false);
  const [specs, setSpecs] = useState<ProjectSpec[] | null>(null);
  const [specsError, setSpecsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    ws.projects().then(setProjects, () => setProjects([]));
  }, [projectId]);

  useEffect(() => {
    setLoadedExpanded(false);
  }, [projectId]);

  // The tree changes after every import and edit, so the spec list follows it.
  useEffect(() => {
    let alive = true;
    ws.projectSpecs(projectId).then(
      (list) => {
        if (!alive) return;
        setSpecs(list);
        setSpecsError(null);
      },
      (err) => alive && setSpecsError(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [projectId, tree]);

  useEffect(() => {
    if (!tree || loadedExpanded) return;
    setExpanded(readExpanded(projectId) ?? new Set(tree.collections.map((c) => c.id)));
    setLoadedExpanded(true);
  }, [tree, projectId, loadedExpanded]);

  const persist = useCallback(
    (next: Set<string>) => {
      setExpanded(next);
      try {
        localStorage.setItem(treeKey(projectId), JSON.stringify([...next]));
      } catch {}
    },
    [projectId],
  );

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    persist(next);
  };

  const open = (...ids: string[]) => {
    const next = new Set(expanded);
    ids.forEach((id) => next.add(id));
    persist(next);
  };

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const createItem = (collectionId: string, folderId: string | null, kind: "request" | "suite") =>
    act(async () => {
      const item = await ws.createItem(collectionId, {
        kind,
        name: kind === "request" ? "New request" : "New test suite",
        folder_id: folderId,
        ...(kind === "request"
          ? { request: EMPTY_REQUEST }
          : { suite: { spec_id: null, config: DEFAULT_PLANNER_CONFIG, last_plan_id: null, last_run_id: null } }),
      });
      open(collectionId, ...(folderId ? [folderId] : []));
      await refresh();
      router.push(`/p/${projectId}/${kind === "request" ? "requests" : "suites"}/${item.id}`);
    });

  const runGroup = (target: "collection" | "folder", id: string) =>
    act(async () => {
      if (!environment) return;
      const run =
        target === "collection"
          ? await ws.runCollection(id, { environment_id: environment.id })
          : await ws.runFolder(id, { environment_id: environment.id });
      router.push(`/p/${projectId}/runs/${run.id}`);
    });

  const groupMenu = (target: "collection" | "folder", collectionId: string, folderId: string | null, name: string, depth: number): MenuItem[] => [
    {
      label: `Run ${target}`,
      icon: "play",
      disabled: !environment,
      reason: "Add an environment first",
      onSelect: () => runGroup(target, target === "collection" ? collectionId : (folderId as string)),
    },
    { label: "New request", icon: "request", onSelect: () => createItem(collectionId, folderId, "request") },
    { label: "New test suite", icon: "suite", onSelect: () => createItem(collectionId, folderId, "suite") },
    {
      label: "New folder",
      icon: "folder",
      onSelect: () => {
        open(collectionId, ...(folderId ? [folderId] : []));
        setEditing({ kind: "new-folder", collectionId, parentId: folderId, depth });
      },
    },
    { label: "Rename", icon: "pencil", onSelect: () => setEditing({ kind: "rename", target, id: target === "collection" ? collectionId : (folderId as string), name }) },
    { label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting({ target, id: target === "collection" ? collectionId : (folderId as string), name }) },
  ];

  const renderItem = (item: ItemSummary, collectionId: string, folderId: string | null, depth: number) => {
    if (editing?.kind === "rename" && editing.id === item.id) {
      return (
        <InlineName
          key={item.id}
          initial={item.name}
          label={`New name for ${item.name}`}
          depth={depth}
          onCancel={() => setEditing(null)}
          onSubmit={async (name) => {
            await ws.updateItem(item.id, { name });
            setEditing(null);
            await refresh();
          }}
        />
      );
    }
    const href = `/p/${projectId}/${item.kind === "request" ? "requests" : "suites"}/${item.id}`;
    const active = pathname.startsWith(href);
    return (
      <li key={item.id}>
        <div className={`${styles.row} ${active ? styles.active : ""}`} style={{ "--depth": depth } as React.CSSProperties}>
          <span className={styles.chevSpacer} aria-hidden="true" />
          <Link href={href} className={styles.rowMain} aria-current={active ? "page" : undefined}>
            {item.kind === "request" ? (
              <span className={styles.itemMethod}>{item.method ?? "GET"}</span>
            ) : (
              <span className={styles.rowIcon}>
                <Icon name="suite" />
              </span>
            )}
            <span className={styles.rowName}>{item.name}</span>
          </Link>
          <span className={styles.rowMenu}>
            <Menu
              label={`Actions for ${item.name}`}
              items={[
                { label: "Rename", icon: "pencil", onSelect: () => setEditing({ kind: "rename", target: "item", id: item.id, name: item.name }) },
                {
                  label: "Duplicate",
                  icon: "plus",
                  onSelect: () =>
                    act(async () => {
                      await ws.duplicateItem(item.id);
                      await refresh();
                    }),
                },
                { label: "Move to", icon: "folder", onSelect: () => setMoving({ id: item.id, name: item.name, collectionId, folderId }) },
                { label: "Delete", icon: "trash", danger: true, onSelect: () => setDeleting({ target: "item", id: item.id, name: item.name }) },
              ]}
            />
          </span>
        </div>
      </li>
    );
  };

  const renderFolder = (folder: FolderNode, collectionId: string, depth: number): React.ReactNode => {
    const isOpen = expanded.has(folder.id);
    if (editing?.kind === "rename" && editing.id === folder.id) {
      return (
        <InlineName
          key={folder.id}
          initial={folder.name}
          label={`New name for ${folder.name}`}
          depth={depth}
          onCancel={() => setEditing(null)}
          onSubmit={async (name) => {
            await ws.updateFolder(folder.id, { name });
            setEditing(null);
            await refresh();
          }}
        />
      );
    }
    return (
      <li key={folder.id}>
        <div className={styles.row} style={{ "--depth": depth } as React.CSSProperties}>
          <button type="button" className={styles.chev} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${folder.name}`} onClick={() => toggle(folder.id)}>
            <Icon name="chevron" size={12} />
          </button>
          <button type="button" className={styles.rowMain} onClick={() => toggle(folder.id)}>
            <span className={styles.rowIcon}>
              <Icon name="folder" />
            </span>
            <span className={styles.rowName}>{folder.name}</span>
          </button>
          <span className={styles.rowMenu}>
            <Menu label={`Actions for ${folder.name}`} items={groupMenu("folder", collectionId, folder.id, folder.name, depth + 1)} />
          </span>
        </div>
        {isOpen && (
          <ul>
            {editing?.kind === "new-folder" && editing.parentId === folder.id && newFolderInput(collectionId, folder.id, depth + 1)}
            {folder.folders.map((f) => renderFolder(f, collectionId, depth + 1))}
            {folder.items.map((i) => renderItem(i, collectionId, folder.id, depth + 1))}
            {!folder.folders.length && !folder.items.length && !(editing?.kind === "new-folder" && editing.parentId === folder.id) && (
              <li className={styles.row} style={{ "--depth": depth + 1 } as React.CSSProperties}>
                <span className={styles.chevSpacer} aria-hidden="true" />
                <span className="small muted">Empty folder</span>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const newFolderInput = (collectionId: string, parentId: string | null, depth: number) => (
    <InlineName
      key="new-folder"
      initial=""
      label="New folder name"
      depth={depth}
      onCancel={() => setEditing(null)}
      onSubmit={async (name) => {
        const folder = await ws.createFolder(collectionId, { name, parent_id: parentId });
        setEditing(null);
        open(collectionId, folder.id, ...(parentId ? [parentId] : []));
        await refresh();
      }}
    />
  );

  const renderCollection = (c: CollectionNode) => {
    const isOpen = expanded.has(c.id);
    if (editing?.kind === "rename" && editing.id === c.id) {
      return (
        <InlineName
          key={c.id}
          initial={c.name}
          label={`New name for ${c.name}`}
          depth={0}
          onCancel={() => setEditing(null)}
          onSubmit={async (name) => {
            await ws.updateCollection(c.id, { name });
            setEditing(null);
            await refresh();
          }}
        />
      );
    }
    return (
      <li key={c.id}>
        <div className={styles.row}>
          <button type="button" className={styles.chev} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${c.name}`} onClick={() => toggle(c.id)}>
            <Icon name="chevron" size={12} />
          </button>
          <button type="button" className={styles.rowMain} onClick={() => toggle(c.id)}>
            <span className={styles.rowIcon}>
              <Icon name="layers" />
            </span>
            <span className={`${styles.rowName} ${styles.collectionName}`}>{c.name}</span>
          </button>
          <span className={styles.rowMenu}>
            <Menu label={`Actions for ${c.name}`} items={groupMenu("collection", c.id, null, c.name, 1)} />
          </span>
        </div>
        {isOpen && (
          <ul>
            {editing?.kind === "new-folder" && editing.collectionId === c.id && editing.parentId === null && newFolderInput(c.id, null, 1)}
            {c.folders.map((f) => renderFolder(f, c.id, 1))}
            {c.items.map((i) => renderItem(i, c.id, null, 1))}
            {!c.folders.length && !c.items.length && !(editing?.kind === "new-folder" && editing.collectionId === c.id) && (
              <li className={styles.row} style={{ "--depth": 1 } as React.CSSProperties}>
                <span className={styles.chevSpacer} aria-hidden="true" />
                <span className="small muted">No requests yet. Use the menu to add one.</span>
              </li>
            )}
          </ul>
        )}
      </li>
    );
  };

  const links = [
    { href: `/p/${projectId}`, label: "Overview", icon: "layers" as const, active: pathname === `/p/${projectId}` },
    { href: `/p/${projectId}/environments`, label: "Environments", icon: "settings" as const, active: pathname.startsWith(`/p/${projectId}/environments`) },
    { href: `/p/${projectId}/runs`, label: "Run history", icon: "play" as const, active: pathname === `/p/${projectId}/runs` || pathname.startsWith(`/p/${projectId}/runs/`) },
  ];

  const envs = tree?.environments ?? [];

  return (
    <aside className={styles.sidebar} aria-label="Project">
      <div className={styles.top}>
        <div className={styles.pickRow}>
          <span className={styles.pickLabel}>
            <label htmlFor="project-switch">Project</label>
            <Link href="/">All projects</Link>
          </span>
          <select
            id="project-switch"
            className={styles.select}
            value={projectId}
            disabled={!projects}
            onChange={(e) => router.push(`/p/${e.target.value}`)}
          >
            {(projects ?? []).some((p) => p.id === projectId) ? null : <option value={projectId}>{tree?.project.name ?? "Loading"}</option>}
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.pickRow}>
          <span className={styles.pickLabel}>
            <label htmlFor="env-switch">Environment</label>
            <Link href={`/p/${projectId}/environments`}>Manage</Link>
          </span>
          {tree && envs.length === 0 ? (
            <p className={styles.emptyEnv}>
              No environment yet. <Link href={`/p/${projectId}/environments`}>Add one</Link> to send requests.
            </p>
          ) : (
            <select
              id="env-switch"
              className={styles.select}
              value={environment?.id ?? ""}
              disabled={!tree}
              onChange={(e) => setEnvironmentId(e.target.value)}
            >
              {envs.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          )}
          {environment && !environment.base_url_allowed && (
            <p className={styles.warn}>
              <Icon name="alert" size={12} />
              <span>{environment.base_url} is outside the allowed hosts, so requests to it are blocked.</span>
            </p>
          )}
        </div>

        <nav className={styles.links} aria-label="Project pages">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={styles.link} aria-current={l.active ? "page" : undefined}>
              <Icon name={l.icon} />
              {l.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className={styles.scrollArea}>
      <div className={styles.sectionHead}>
        <h2>API specs</h2>
        <div className={styles.headActions}>
          <button type="button" className={styles.iconBtn} disabled={!tree} onClick={() => setLoadingSpec(true)}>
            <Icon name="plus" size={12} />
            Load spec
          </button>
        </div>
      </div>
      <div className={styles.specList}>
        {specsError && !specs ? (
          <p className={styles.alert} role="alert">
            The specs could not be loaded. {specsError}
          </p>
        ) : !specs ? (
          <div className={styles.skeletonRows} aria-hidden="true">
            <div className="skeleton" />
          </div>
        ) : specs.length === 0 ? (
          <p className={styles.specEmpty}>No spec yet. Load an OpenAPI document to read its contract and plan tests from it.</p>
        ) : (
          <ul className={styles.tree}>
            {specs.map((sp) => {
              const href = `/p/${projectId}/specs/${sp.spec_id}`;
              const active = pathname === href;
              return (
                <li key={sp.spec_id}>
                  <div className={`${styles.row} ${active ? styles.active : ""}`}>
                    <Link href={href} className={styles.rowMain} aria-current={active ? "page" : undefined}>
                      <Icon name="spec" />
                      <span className={styles.rowName}>{sp.title}</span>
                      <span className={styles.specKind}>spec{sp.version ? ` ${sp.version}` : ""}</span>
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className={styles.sectionHead}>
        <h2>Collections</h2>
        <div className={styles.headActions}>
          <button type="button" className={styles.iconBtn} disabled={!tree} onClick={() => setEditing({ kind: "new-collection" })}>
            <Icon name="plus" size={12} />
            New
          </button>
          <button type="button" className={styles.iconBtn} disabled={!tree} onClick={() => setImporting(true)}>
            <Icon name="download" size={12} />
            Import
          </button>
        </div>
      </div>

      {actionError && (
        <p className={styles.alert} role="alert">
          {actionError}
        </p>
      )}

      <div className={styles.treeBody}>
        {error && !tree ? (
          <div className={styles.empty} role="alert">
            <p>The project could not be loaded. {error}</p>
            <button type="button" className="key" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : !tree ? (
          <div className={styles.skeletonRows} aria-hidden="true">
            <div className="skeleton" />
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        ) : (
          <ul className={styles.tree}>
            {editing?.kind === "new-collection" && (
              <InlineName
                initial=""
                label="New collection name"
                depth={0}
                onCancel={() => setEditing(null)}
                onSubmit={async (name) => {
                  const c = await ws.createCollection(projectId, { name });
                  setEditing(null);
                  open(c.id);
                  await refresh();
                }}
              />
            )}
            {tree.collections.map(renderCollection)}
            {tree.collections.length === 0 && editing?.kind !== "new-collection" && (
              <li className={styles.empty}>
                <p>Collections hold saved requests and test suites, grouped into folders.</p>
                <div className="row">
                  <button type="button" className="key" onClick={() => setEditing({ kind: "new-collection" })}>
                    New collection
                  </button>
                  <button type="button" className="key key--plain" onClick={() => setImporting(true)}>
                    Import OpenAPI
                  </button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
      </div>

      <ImportDialog
        open={loadingSpec}
        projectId={projectId}
        purpose="load"
        onClose={() => setLoadingSpec(false)}
        onLoaded={async (specId) => {
          await refresh();
          router.push(`/p/${projectId}/specs/${specId}`);
        }}
      />

      <ImportDialog
        open={importing}
        projectId={projectId}
        onClose={() => setImporting(false)}
        onImported={async (c) => {
          open(c.id);
          await refresh();
        }}
      />

      <MoveDialog
        open={moving !== null}
        itemName={moving?.name ?? ""}
        current={moving ? { collectionId: moving.collectionId, folderId: moving.folderId } : null}
        collections={tree?.collections ?? []}
        onClose={() => setMoving(null)}
        onMove={async (collectionId, folderId) => {
          if (!moving) return;
          await ws.moveItem(moving.id, { collection_id: collectionId, folder_id: folderId });
          open(collectionId, ...(folderId ? [folderId] : []));
          await refresh();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.name}?` : ""}
        confirmLabel={deleting ? `Delete ${deleting.target}` : "Delete"}
        danger
        requireText={deleting?.target === "collection" ? deleting.name : undefined}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          if (deleting.target === "collection") await ws.deleteCollection(deleting.id);
          else if (deleting.target === "folder") await ws.deleteFolder(deleting.id);
          else await ws.deleteItem(deleting.id);
          await refresh();
          if (pathname.includes(deleting.id)) router.push(`/p/${projectId}`);
        }}
      >
        <p>
          {deleting?.target === "item"
            ? "The saved request or suite goes. Past runs stay in the run history."
            : `Everything inside this ${deleting?.target ?? "group"} goes with it: folders, saved requests and test suites. Past runs stay in the run history.`}
        </p>
      </ConfirmDialog>
    </aside>
  );
}
