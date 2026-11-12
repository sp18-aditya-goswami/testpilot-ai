import type { Crumb } from "./Breadcrumbs";
import type { FolderNode, ProjectTree } from "@/lib/workspace";

function findInFolders(folders: FolderNode[], itemId: string, path: FolderNode[]): { item: string; path: FolderNode[] } | null {
  for (const f of folders) {
    const hit = f.items.find((i) => i.id === itemId);
    if (hit) return { item: hit.name, path: [...path, f] };
    const deeper = findInFolders(f.folders, itemId, [...path, f]);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * The one breadcrumb path every screen uses: project, collection, folders, item.
 * Plan and run screens append their own last crumbs, so suite, plan and run always read as the same trail.
 */
export function itemTrail(tree: ProjectTree | null, projectId: string, itemId: string | null | undefined, itemHref?: string): Crumb[] {
  const project: Crumb = { label: tree?.project.name ?? "Project", href: `/p/${projectId}` };
  if (!tree || !itemId) return [project];
  for (const c of tree.collections) {
    const root = c.items.find((i) => i.id === itemId);
    if (root) return [project, { label: c.name }, { label: root.name, href: itemHref }];
    const found = findInFolders(c.folders, itemId, []);
    if (found) return [project, { label: c.name }, ...found.path.map((f) => ({ label: f.name })), { label: found.item, href: itemHref }];
  }
  return [project];
}
