"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Icon } from "@/components/Icon";
import { useProject } from "@/components/ProjectContext";
import { MethodPath } from "@/components/Status";
import { api, errorMessage, type ApiSummary, type Endpoint, type Json } from "@/lib/api";
import { DEFAULT_PLANNER_CONFIG, ws, type PlanSummary, type RunListItem, type SpecUsage } from "@/lib/workspace";
import { formatWhen, PlanList, RunResult } from "../PlanList";
import styles from "../specs.module.css";

type Schema = Record<string, Json> | null | undefined;

function asSchema(v: Json | undefined): Schema {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Json>) : null;
}

function typeLabel(schema: Schema): string {
  if (!schema) return "any";
  for (const combo of ["anyOf", "oneOf"] as const) {
    const opts = schema[combo];
    if (Array.isArray(opts)) {
      const real = opts.map(asSchema).filter((o) => o && o.type !== "null");
      const nullable = real.length < opts.length;
      return real.map(typeLabel).join(" or ") + (nullable ? ", or null" : "");
    }
  }
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (schema.type === "array") return `list of ${typeLabel(asSchema(schema.items))}`;
  if (schema.type === "object" || schema.properties) return "object";
  const t = typeof schema.type === "string" ? schema.type : "any";
  return typeof schema.format === "string" ? `${t} (${schema.format})` : t;
}

function constraints(schema: Schema): string {
  if (!schema) return "";
  const parts: string[] = [];
  const pick = (k: string, label: string) => {
    if (schema[k] !== undefined && schema[k] !== null) parts.push(`${label} ${JSON.stringify(schema[k])}`);
  };
  pick("minLength", "min length");
  pick("maxLength", "max length");
  pick("minimum", "min");
  pick("maximum", "max");
  pick("pattern", "pattern");
  pick("default", "default");
  return parts.join(", ");
}

function bodySummary(schema: Schema): string {
  if (schema === null || schema === undefined) return "No body documented";
  if (Object.keys(schema).length === 0) return "Any body";
  if (schema.type === "array") return `List of ${bodySummary(asSchema(schema.items)).toLowerCase()}`;
  const props = asSchema(schema.properties);
  if (props) {
    const keys = Object.keys(props);
    return `Object with ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ` and ${keys.length - 6} more` : ""}`;
  }
  return typeLabel(schema);
}

function EndpointDetail({ ep }: { ep: Endpoint }) {
  const body = ep.request_body_schema;
  const props = asSchema(body?.properties);
  const required = new Set(Array.isArray(body?.required) ? (body?.required as string[]) : []);
  const codes = Object.keys(ep.responses).sort();
  return (
    <div className={styles.detail}>
      {ep.description && ep.description !== ep.summary && <p className={styles.description}>{ep.description}</p>}

      <div>
        <h3>Parameters</h3>
        {ep.parameters.length === 0 ? (
          <p className={styles.detailNote}>None.</p>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>In</th>
                  <th>Type</th>
                  <th>Required</th>
                </tr>
              </thead>
              <tbody>
                {ep.parameters.map((p) => (
                  <tr key={`${p.location}-${p.name}`}>
                    <td className="mono">{p.name}</td>
                    <td>{p.location}</td>
                    <td>{typeLabel(p.schema)}</td>
                    <td>{p.required ? "Required" : "Optional"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3>Request body</h3>
        {!body ? (
          <p className={styles.detailNote}>No request body.</p>
        ) : !props ? (
          <p className={styles.detailNote}>{bodySummary(body)}.</p>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Rules</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(props).map(([name, sub]) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td>{typeLabel(asSchema(sub))}</td>
                    <td>{required.has(name) ? "Required" : "Optional"}</td>
                    <td className="muted">{constraints(asSchema(sub)) || "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3>Documented responses</h3>
        {codes.length === 0 ? (
          <p className={styles.detailNote}>None documented.</p>
        ) : (
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Body</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((code) => (
                  <tr key={code}>
                    <td className="http">{code}</td>
                    <td>{bodySummary(ep.responses[code])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function groupByTag(endpoints: Endpoint[]): [string, Endpoint[]][] {
  const groups = new Map<string, Endpoint[]>();
  for (const ep of endpoints) {
    const tag = ep.tags[0] ?? "Untagged";
    groups.set(tag, [...(groups.get(tag) ?? []), ep]);
  }
  return [...groups.entries()];
}

function suiteOfPlan(usage: SpecUsage, p: PlanSummary) {
  return p.suite_item_id ? usage.suites.find((s) => s.item_id === p.suite_item_id) : undefined;
}

/** The suite keeps its last run; that run belongs to this plan only when the plan is also the suite's last plan. */
function latestRunOfPlan(usage: SpecUsage, p: PlanSummary): RunListItem | undefined {
  const suite = suiteOfPlan(usage, p);
  if (!suite || suite.last_plan_id !== p.id || !suite.last_run_id) return undefined;
  return usage.runs.find((r) => r.id === suite.last_run_id);
}

/** New suite runs carry the suite name; older ones carry the spec title, so fall back to the suite whose last run it was. */
function suiteOfRun(usage: SpecUsage, r: RunListItem, specTitle: string): string {
  if (r.source_name && r.source_name !== specTitle) return r.source_name;
  return usage.suites.find((s) => s.last_run_id === r.id)?.name ?? "Suite run";
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; spec: ApiSummary };

export function SpecView({ projectId, specId }: { projectId: string; specId: string }) {
  const router = useRouter();
  const { tree, refresh } = useProject();
  const ids = { collection: useId(), name: useId() };
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [usage, setUsage] = useState<SpecUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [collectionId, setCollectionId] = useState("");
  const [suiteName, setSuiteName] = useState("");
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const fetchAll = useCallback(() => {
    setLoad({ state: "loading" });
    api.spec(specId).then(
      (spec) => setLoad({ state: "ready", spec }),
      (err) => setLoad({ state: "error", message: errorMessage(err) }),
    );
    ws.specUsage(specId).then(
      (u) => {
        setUsage(u);
        setUsageError(null);
      },
      (err) => setUsageError(errorMessage(err)),
    );
  }, [specId]);

  useEffect(fetchAll, [fetchAll]);

  const collections = useMemo(() => tree?.collections ?? [], [tree]);
  const projectName = tree?.project.name ?? "Project";

  if (load.state === "loading") {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: projectName, href: `/p/${projectId}` }, { label: "API specs" }, { label: "Loading" }]} />
        <div className={styles.skeleton} aria-hidden="true">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: projectName, href: `/p/${projectId}` }, { label: "API specs" }, { label: "Not found" }]} />
        <div className="error-state" role="alert">
          <h3>The spec could not be loaded</h3>
          <p>{load.message}</p>
          <button type="button" className="key" onClick={fetchAll}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const spec = load.spec;
  const groups = groupByTag(spec.endpoints);

  const openCreate = () => {
    setCollectionId(collections[0]?.id ?? "");
    setSuiteName(`${spec.title} suite`);
    setCreating(true);
  };

  return (
    <div className={styles.page}>
      <div>
        <Breadcrumbs items={[{ label: projectName, href: `/p/${projectId}` }, { label: "API specs" }, { label: spec.title }]} />
        <header className={styles.head}>
          <div>
            <h1>{spec.title}</h1>
            <p className={styles.meta}>
              Version {spec.version || "not set"}, OpenAPI {spec.openapi_version}
              {spec.server_url ? `, server ${spec.server_url}` : ""}
            </p>
          </div>
          <div className={styles.headSide}>
            <div className={styles.count}>
              <span className="figure">{spec.endpoints.length}</span>
              <span className={styles.countLabel}>{spec.endpoints.length === 1 ? "endpoint" : "endpoints"}</span>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className="key"
                disabled={importing}
                aria-busy={importing}
                onClick={async () => {
                  setImporting(true);
                  setMessage(null);
                  try {
                    const c = await ws.importSpec(projectId, { spec_id: specId });
                    await refresh();
                    setMessage({ ok: true, text: `Imported as the collection ${c.name}, one saved request per endpoint. It is in the sidebar.` });
                  } catch (err) {
                    setMessage({ ok: false, text: errorMessage(err) });
                  } finally {
                    setImporting(false);
                  }
                }}
              >
                {importing && <span className="spinner" aria-hidden="true" />}
                Import as requests
              </button>
              <button type="button" className="key key--primary" onClick={openCreate}>
                <Icon name="plus" />
                New test suite
              </button>
            </div>
          </div>
        </header>
      </div>

      {message && (
        <p className={`${message.ok ? "status status--passed" : "status status--failed"} ${styles.notice}`} role="status">
          <Icon name={message.ok ? "check" : "cross"} />
          {message.text}
        </p>
      )}

      <section className={styles.section} aria-labelledby="endpoints-head">
        <div className={styles.sectionHead}>
          <h2 id="endpoints-head">Endpoints</h2>
          <p>The contract every test is judged against. Open an endpoint to see its parameters, body rules and documented responses.</p>
        </div>
        {spec.endpoints.length === 0 ? (
          <div className={styles.empty}>
            <p>This spec defines no operations.</p>
          </div>
        ) : (
          groups.map(([tag, eps]) => (
            <div key={tag} className={styles.tagGroup}>
              <div className={styles.tagHead}>{tag}</div>
              <ul className={styles.endpoints}>
                {eps.map((ep) => (
                  <li key={ep.id} className={styles.endpoint}>
                    <details>
                      <summary>
                        <span className={styles.chev}>
                          <Icon name="chevron" size={12} />
                        </span>
                        <MethodPath id={ep.id} />
                        <span className={styles.endpointSummary}>{ep.summary || "No summary"}</span>
                        <span className={styles.endpointCodes}>
                          {Object.keys(ep.responses)
                            .sort()
                            .map((c) => (
                              <span key={c} className="http">
                                {c}
                              </span>
                            ))}
                        </span>
                      </summary>
                      <EndpointDetail ep={ep} />
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section className={styles.section} aria-labelledby="suites-head">
        <div className={styles.sectionHead}>
          <h2 id="suites-head">Test suites for this spec</h2>
          <p>Each suite plans cases from this contract and keeps its last plan and run.</p>
        </div>
        {usageError && !usage ? (
          <div className="error-state" role="alert">
            <p>{usageError}</p>
            <button type="button" className="key" onClick={fetchAll}>
              Try again
            </button>
          </div>
        ) : !usage ? (
          <div className={styles.usageSkeleton} aria-hidden="true"><div className="skeleton" /></div>
        ) : usage.suites.length === 0 ? (
          <div className={styles.empty}>
            <p>No suite uses this spec yet. A suite turns the contract, your rules and Claude&rsquo;s scenarios into a test plan.</p>
            <button type="button" className="key" onClick={openCreate}>
              New test suite
            </button>
          </div>
        ) : (
          <ul className={`panel ${styles.suites}`}>
            {usage.suites.map((s) => (
              <li key={s.item_id} className={styles.suite}>
                <span className={styles.suiteName}>
                  <Icon name="suite" />
                  <Link href={`/p/${projectId}/suites/${s.item_id}`} className={styles.rowLink}>
                    {s.name}
                  </Link>
                  <span className="muted small">in {s.collection_name}</span>
                </span>
                <span className={styles.suiteLinks}>
                  {s.last_plan_id && <Link href={`/p/${projectId}/plans/${s.last_plan_id}`}>Last plan</Link>}
                  {s.last_run_id && <Link href={`/p/${projectId}/runs/${s.last_run_id}`}>Last run</Link>}
                  {!s.last_plan_id && !s.last_run_id && <span className="muted">Not planned yet</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {usage && usage.plans.length > 0 && (
        <section className={styles.section} aria-labelledby="plans-head">
          <div className={styles.sectionHead}>
            <h2 id="plans-head">Plans</h2>
          </div>
          <PlanList
            projectId={projectId}
            plans={usage.plans.slice(0, 8)}
            suiteName={(p) => suiteOfPlan(usage, p)?.name ?? "No suite"}
            result={(p) => {
              const run = latestRunOfPlan(usage, p);
              return run ? (
                <Link href={`/p/${projectId}/runs/${run.id}`} className={styles.rowLink}>
                  <RunResult run={run} />
                </Link>
              ) : null;
            }}
          />
        </section>
      )}

      {usage && (
        <section className={styles.section} aria-labelledby="runs-head">
          <div className={styles.sectionHead}>
            <h2 id="runs-head">Recent runs</h2>
          </div>
          {usage.runs.length === 0 ? (
            <div className={styles.empty}>
              <p>No run has tested this spec yet. Generate a plan in a suite, then run it.</p>
            </div>
          ) : (
            <div className={`panel ${styles.listPanel}`}>
              <div className="table-scroll">
                <table className="ledger">
                  <thead>
                    <tr>
                      <th>Suite</th>
                      <th>Environment</th>
                      <th>Started</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.runs.slice(0, 8).map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link href={`/p/${projectId}/runs/${r.id}`} className={styles.rowLink}>
                            {suiteOfRun(usage, r, spec.title)}
                          </Link>
                        </td>
                        <td>{r.environment_name || <span className="muted">Not recorded</span>}</td>
                        <td className="muted">{formatWhen(r.created_at)}</td>
                        <td>
                          <RunResult run={r} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={creating}
        title="New test suite"
        confirmLabel="Create suite"
        onClose={() => setCreating(false)}
        onConfirm={async () => {
          const name = suiteName.trim() || `${spec.title} suite`;
          let target = collectionId;
          if (!target) target = (await ws.createCollection(projectId, { name: spec.title })).id;
          const item = await ws.createItem(target, {
            kind: "suite",
            name,
            suite: { spec_id: specId, config: DEFAULT_PLANNER_CONFIG, last_plan_id: null, last_run_id: null },
          });
          await refresh();
          router.push(`/p/${projectId}/suites/${item.id}`);
        }}
      >
        <div className={styles.dialogFields}>
          <div className="field">
            <label htmlFor={ids.name}>Suite name</label>
            <input id={ids.name} className="input" autoComplete="off" value={suiteName} onChange={(e) => setSuiteName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={ids.collection}>Collection</label>
            {collections.length === 0 ? (
              <p className="helper">No collection yet. One named {spec.title} is created for it.</p>
            ) : (
              <select id={ids.collection} className="input" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
