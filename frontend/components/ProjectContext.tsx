"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { errorMessage } from "@/lib/api";
import { ws, type Environment, type ProjectTree } from "@/lib/workspace";

interface ProjectState {
  projectId: string;
  tree: ProjectTree | null;
  error: string | null;
  /** Re-fetch the tree after any create, rename, move or delete. */
  refresh: () => Promise<void>;
  environment: Environment | null;
  setEnvironmentId: (id: string) => void;
}

const Ctx = createContext<ProjectState | null>(null);
const envKey = (projectId: string) => `testpilot-env-${projectId}`;

export function ProjectProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [tree, setTree] = useState<ProjectTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const t = await ws.tree(projectId);
      setTree(t);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [projectId]);

  useEffect(() => {
    setTree(null);
    try {
      setEnvId(localStorage.getItem(envKey(projectId)));
    } catch {
      setEnvId(null);
    }
    void refresh();
  }, [projectId, refresh]);

  const environment = useMemo(() => {
    const envs = tree?.environments ?? [];
    return envs.find((e) => e.id === envId) ?? envs.find((e) => e.is_default) ?? envs[0] ?? null;
  }, [tree, envId]);

  const setEnvironmentId = useCallback(
    (id: string) => {
      setEnvId(id);
      try {
        localStorage.setItem(envKey(projectId), id);
      } catch {}
    },
    [projectId],
  );

  return <Ctx.Provider value={{ projectId, tree, error, refresh, environment, setEnvironmentId }}>{children}</Ctx.Provider>;
}

export function useProject(): ProjectState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProject must be used inside a ProjectProvider");
  return ctx;
}

/** For screens that may render inside or outside a project. */
export function useOptionalProject(): ProjectState | null {
  return useContext(Ctx);
}
