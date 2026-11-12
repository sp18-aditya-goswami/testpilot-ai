import type { Environment, SavedRequest } from "@/lib/workspace";

export const VAR = /\{\{\s*([\w.\-]+)\s*\}\}/g;
const BUILT_IN = new Set(["unique"]);

export function variablesIn(req: SavedRequest): string[] {
  const texts = [
    req.path,
    req.body_mode === "none" ? "" : req.body,
    ...req.query.filter((p) => p.enabled).flatMap((p) => [p.key, p.value]),
    ...req.headers.filter((h) => h.enabled).flatMap((h) => [h.key, h.value]),
  ];
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(VAR)) found.add(m[1]);
  return [...found];
}

export function unknownVariables(req: SavedRequest, env: Environment | null): string[] {
  const known = new Set([...BUILT_IN, ...(env?.variables.map((v) => v.key) ?? [])]);
  return variablesIn(req).filter((v) => !known.has(v));
}

/** Where the item lives: "Collection / Folder / Subfolder". */
export function parseStatusList(text: string): { codes: number[]; error: string | null } {
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const codes: number[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (!Number.isInteger(n) || n < 100 || n > 599) return { codes, error: `"${t}" is not an HTTP status code between 100 and 599.` };
    if (!codes.includes(n)) codes.push(n);
  }
  if (!codes.length) return { codes, error: "List at least one expected status code." };
  return { codes, error: null };
}

export function jsonError(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Not valid JSON.";
  }
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A curl command for the request. Secret and unknown variables stay as {{placeholders}}. */
export function toCurl(req: SavedRequest, env: Environment | null): string {
  const values = new Map((env?.variables ?? []).filter((v) => !v.secret && v.has_value).map((v) => [v.key, v.value]));
  const fill = (s: string) => s.replace(VAR, (m, k: string) => values.get(k) ?? m);
  const base = (env?.base_url ?? "").replace(/\/+$/, "");
  const query = req.query
    .filter((p) => p.enabled && p.key)
    .map((p) => `${fill(p.key)}=${fill(p.value)}`)
    .join("&");
  const url = `${base}${fill(req.path)}${query ? (req.path.includes("?") ? "&" : "?") + query : ""}`;
  const lines = [`curl -X ${req.method} ${sq(url)}`];
  const headers = req.headers.filter((h) => h.enabled && h.key);
  for (const h of headers) lines.push(`  -H ${sq(`${fill(h.key)}: ${fill(h.value)}`)}`);
  if (req.body_mode !== "none" && req.body) {
    if (req.body_mode === "json" && !headers.some((h) => h.key.toLowerCase() === "content-type")) {
      lines.push(`  -H ${sq("Content-Type: application/json")}`);
    }
    lines.push(`  --data-raw ${sq(fill(req.body))}`);
  }
  return lines.join(" \\\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
