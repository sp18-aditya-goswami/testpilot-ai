"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs, type Crumb } from "@/components/Breadcrumbs";
import { CodeBlock } from "@/components/CodeBlock";
import { Icon } from "@/components/Icon";
import { itemTrail } from "@/components/itemTrail";
import { useOptionalProject } from "@/components/ProjectContext";
import { SourceLegend, SourceTag } from "@/components/Source";
import { MethodPath } from "@/components/Status";
import { Steps } from "@/components/Steps";
import { api, ApiError, errorMessage, type Category, type RequestSpec, type Source, type TestCase, type TestPlan } from "@/lib/api";
import { ws } from "@/lib/workspace";
import { planHref } from "@/app/runs/format";
import { CaseEditor, DeleteCaseDialog, type CaseBody } from "./CaseEditor";
import { CATEGORIES, CoverageGrid, sourceSplit, type CoverageFilter } from "./CoverageGrid";
import { PlanningProgress } from "./PlanningProgress";
import { RefineBox } from "./RefineBox";
import { RunPanel } from "./RunPanel";
import styles from "./plan.module.css";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string; notFound: boolean }
  | { state: "ready"; plan: TestPlan };

type SourceFilter = "all" | "ai" | "contract" | "saved";
const POLL_MS = 1500;
const NEW_MARK_MS = 15000;

const TEMPLATE = /\{\{\s*[\w.\-]+\s*\}\}/;

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function toCategory(value: string | null): Category | null {
  return CATEGORIES.some((c) => c.id === value) ? (value as Category) : null;
}

function homeHref(plan: TestPlan) {
  if (plan.project_id && plan.suite_item_id) return `/p/${plan.project_id}/suites/${plan.suite_item_id}`;
  return plan.project_id ? `/p/${plan.project_id}` : "/";
}

function toFilter(value: string | null): SourceFilter {
  return value === "ai" || value === "contract" || value === "saved" ? value : "all";
}

function sentenceCase(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function requestText(r: RequestSpec): string {
  const blocks: string[] = [];
  const add = (label: string, value: unknown) => blocks.push(`# ${label}\n${JSON.stringify(value, null, 2)}`);
  if (Object.keys(r.path_params ?? {}).length) add("path parameters", r.path_params);
  if (Object.keys(r.query ?? {}).length) add("query", r.query);
  if (Object.keys(r.headers ?? {}).length) add("headers", r.headers);
  if (r.raw_body !== null && r.raw_body !== undefined) {
    blocks.push(`# raw body${r.omit_content_type ? ", no Content-Type" : ""}\n${r.raw_body}`);
  } else if (r.body !== null && r.body !== undefined) {
    add(r.omit_content_type ? "body, no Content-Type" : "body", r.body);
  }
  return blocks.join("\n\n") || "# no parameters and no body";
}

function hasTemplates(c: TestCase) {
  return TEMPLATE.test(JSON.stringify([c.setup, c.request]));
}

export function PlanSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the plan">
      <Steps current={2} />
      <div className="page-head">
        <div className="stack" style={{ width: "min(100%, 34rem)" }}>
          <div className="skeleton" style={{ height: "var(--space-xl)", width: "80%" }} />
          <div className="skeleton" style={{ width: "60%" }} />
        </div>
      </div>
      {Array.from({ length: 3 }, (_, g) => (
        <div key={g} className={`panel ${styles.group}`}>
          <div className={styles.groupHead}>
            <div className="skeleton" style={{ width: "14rem" }} />
          </div>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={styles.skeletonRow}>
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function GroupCheckbox({
  checked,
  indeterminate,
  label,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function Expects({ codes }: { codes: number[] }) {
  return (
    <>
      {codes.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <span className="muted"> or </span>}
          <span className="http">{s}</span>
        </Fragment>
      ))}
    </>
  );
}

const REASON_LABEL: Record<Source, string> = {
  ai: "Claude's reasoning",
  contract: "Schema rule",
  fuzz: "Fuzzing",
  saved: "Your note",
};

function Reasoning({ c }: { c: TestCase }) {
  if (!c.rationale) return null;
  return (
    <span className={styles.rationale}>
      <span className={c.source === "ai" ? `${styles.reasonLabel} ${styles.reasonAi}` : styles.reasonLabel}>{REASON_LABEL[c.source]}</span>
      {c.rationale}
    </span>
  );
}

function planTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CaseDetail({ c, onEdit, onDelete }: { c: TestCase; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className={styles.detail}>
      <div className={styles.detailActions}>
        <button type="button" className="key" onClick={onEdit}>
          <Icon name="pencil" />
          Edit case
        </button>
        <button type="button" className="key key--plain" onClick={onDelete}>
          <Icon name="trash" />
          Delete
        </button>
      </div>
      <p className={styles.detailWho}>
        Made by <SourceTag source={c.source} withGroup />
      </p>
      {c.setup.length > 0 && (
        <div className={styles.detailStep}>
          <h3 className={styles.detailLabel}>Setup first</h3>
          <p className={styles.detailHint}>These requests run before the case to create the state it needs. They are not judged.</p>
          {c.setup.map((step, i) => (
            <CodeBlock key={i} title={`Step ${i}: ${step.method} ${step.path}`} code={requestText(step)} />
          ))}
        </div>
      )}
      <div className={styles.detailStep}>
        <h3 className={styles.detailLabel}>What will be sent</h3>
        <CodeBlock title={`${c.request.method} ${c.request.path}`} code={requestText(c.request)} />
      </div>
      <div className={styles.detailStep}>
        <h3 className={styles.detailLabel}>Passes when</h3>
        <p className={styles.expectLine}>
          The response status is <Expects codes={c.expected_status} />
          {c.source === "contract" ? ", no server error occurs and the body matches the documented schema." : " and no server error occurs."}
        </p>
      </div>
    </div>
  );
}

export function PlanReview({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filter = toFilter(searchParams.get("source"));
  const coverage: CoverageFilter = { endpoint: searchParams.get("endpoint"), category: toCategory(searchParams.get("category")) };

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // a case id, or "new:<endpoint id>"
  const [deleting, setDeleting] = useState<TestCase | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [planningSince, setPlanningSince] = useState<number>(() => Date.now());
  const knownIds = useRef<Set<string> | null>(null);
  const project = useOptionalProject();
  const [suiteName, setSuiteName] = useState<string | null>(null);

  /** Swap in a newer copy of the plan: new cases start selected, removed ones drop out of the selection. */
  const accept = useCallback((plan: TestPlan, markNew: boolean) => {
    const before = knownIds.current;
    const ids = plan.cases.map((c) => c.id);
    setSelected((prev) => {
      if (!before) return new Set(ids);
      return new Set(ids.filter((i) => prev.has(i) || !before.has(i)));
    });
    if (before && markNew && plan.status === "ready") {
      const added = ids.filter((i) => !before.has(i));
      if (added.length) setNewIds(new Set(added));
    }
    if (plan.status !== "planning") knownIds.current = new Set(ids);
    else if (!before) knownIds.current = null;
    setLoad({ state: "ready", plan });
  }, []);

  const fetchPlan = useCallback(() => {
    setLoad({ state: "loading" });
    knownIds.current = null;
    api.plan(id).then(
      (plan) => {
        if (plan.status === "planning") setPlanningSince(new Date(plan.created_at).getTime());
        accept(plan, false);
      },
      (err) =>
        setLoad({
          state: "error",
          message: errorMessage(err),
          notFound: err instanceof ApiError && err.status === 404,
        }),
    );
  }, [id]);

  useEffect(fetchPlan, [fetchPlan]);

  const plan = load.state === "ready" ? load.plan : null;
  const planning = plan?.status === "planning";
  const suiteItemId = plan?.suite_item_id ?? null;

  const tree = project?.tree ?? null;
  const treeHasSuite = !!(tree && suiteItemId && plan?.project_id && itemTrail(tree, plan.project_id, suiteItemId).length > 1);

  useEffect(() => {
    if (!suiteItemId || treeHasSuite) return;
    let live = true;
    ws.item(suiteItemId).then(
      (item) => live && setSuiteName(item.name),
      () => live && setSuiteName(null),
    );
    return () => {
      live = false;
    };
  }, [suiteItemId, treeHasSuite]);

  function crumbs(pl: TestPlan): Crumb[] {
    const last: Crumb = { label: `Plan, ${planTime(pl.created_at)}` };
    if (!pl.project_id) return [last];
    const suiteHref = pl.suite_item_id ? `/p/${pl.project_id}/suites/${pl.suite_item_id}` : undefined;
    const trail = itemTrail(tree, pl.project_id, pl.suite_item_id, suiteHref);
    if (pl.suite_item_id && trail.length === 1) trail.push({ label: suiteName ?? "Test suite", href: suiteHref });
    return [...trail, last];
  }

  useEffect(() => {
    if (!planning) return;
    let stopped = false;
    const t = setTimeout(async () => {
      try {
        const next = await api.plan(id);
        if (!stopped) accept(next, true);
      } catch {
        if (!stopped) setLoad((l) => (l.state === "ready" ? { ...l, plan: { ...l.plan } } : l));
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [planning, plan, id, accept]);

  useEffect(() => {
    if (newIds.size === 0) return;
    const t = setTimeout(() => setNewIds(new Set()), NEW_MARK_MS);
    return () => clearTimeout(t);
  }, [newIds]);

  useEffect(() => {
    if (plan?.project_id && !pathname.startsWith("/p/")) router.replace(planHref(plan.id, plan.project_id));
  }, [plan?.project_id, plan?.id, pathname, router]);

  const groups = useMemo(() => {
    const map = new Map<string, TestCase[]>();
    for (const c of plan?.cases ?? []) {
      if (filter !== "all" && c.source !== filter) continue;
      if (coverage.endpoint && c.endpoint_id !== coverage.endpoint) continue;
      if (coverage.category && c.category !== coverage.category) continue;
      const list = map.get(c.endpoint_id) ?? [];
      list.push(c);
      map.set(c.endpoint_id, list);
    }
    return Array.from(map.entries());
  }, [plan, filter, coverage.endpoint, coverage.category]);

  if (load.state === "loading") return <PlanSkeleton />;

  if (load.state === "error") {
    return (
      <>
        <Steps current={2} />
        <div className="error-state" role="alert">
          <h3>{load.notFound ? "This plan does not exist" : "The plan could not be loaded"}</h3>
          <p>{load.notFound ? "It may have been created on another machine, or the link is incomplete." : load.message}</p>
          <div className="row">
            {!load.notFound && (
              <button type="button" className="key" onClick={fetchPlan}>
                Try again
              </button>
            )}
            <Link href="/" className="key key--plain">
              Open projects
            </Link>
          </div>
        </div>
      </>
    );
  }

  const p = load.plan;

  if (p.status === "planning") {
    return (
      <>
        <Breadcrumbs items={crumbs(p)} />
        <Steps current={2} suiteHref={homeHref(p)} />
        <div className="page-head">
          <div>
            <h1>Planning tests for {p.spec_title}</h1>
            <p>
              Against <span className={styles.base}>{p.base_url}</span>. The cases appear here when the plan is ready.
            </p>
          </div>
        </div>
        <PlanningProgress plan={p} since={planningSince} />
      </>
    );
  }

  if (p.status === "failed") {
    return (
      <>
        <Breadcrumbs items={crumbs(p)} />
        <Steps current={2} suiteHref={homeHref(p)} />
        <div className="error-state" role="alert">
          <h3>The plan could not be built</h3>
          <p>{p.progress[p.progress.length - 1] ?? p.ai_message ?? "The planner stopped before it finished."}</p>
          <div className="row">
            <button type="button" className="key" onClick={fetchPlan}>
              Check again
            </button>
            <Link href={homeHref(p)} className="key key--plain">
              {p.suite_item_id ? "Back to the suite" : "Back to the project"}
            </Link>
          </div>
        </div>
      </>
    );
  }

  const aiCount = p.cases.filter((c) => c.source === "ai").length;
  const contractCount = p.cases.filter((c) => c.source === "contract").length;
  const savedCount = p.cases.filter((c) => c.source === "saved").length;
  const sourceCounts: Partial<Record<Source, number>> = { ai: aiCount, contract: contractCount, saved: savedCount };
  const coverageCases = p.cases.filter(
    (c) => (!coverage.endpoint || c.endpoint_id === coverage.endpoint) && (!coverage.category || c.category === coverage.category),
  );
  const strategyEndpoints = (p.strategy ?? []).map((s) => s.endpoint_id);
  const allEndpoints = Array.from(new Set([...p.cases.map((c) => c.endpoint_id), ...strategyEndpoints]));
  const coverageOn = coverage.endpoint !== null || coverage.category !== null;
  const destructiveSelected = p.cases.filter((c) => c.destructive && selected.has(c.id)).length;
  const willRun = selected.size - (allowDestructive ? 0 : destructiveSelected);
  const visible = groups.flatMap(([, cases]) => cases);
  const visibleSelected = visible.filter((c) => selected.has(c.id)).length;
  const showTemplateNote = p.cases.some(hasTemplates);

  function setQuery(next: { source?: SourceFilter; endpoint?: string | null; category?: Category | null }) {
    const q = new URLSearchParams(searchParams.toString());
    const put = (key: string, value: string | null | undefined) => {
      if (value === undefined) return;
      if (value === null || value === "all") q.delete(key);
      else q.set(key, value);
    };
    put("source", next.source);
    put("endpoint", next.endpoint);
    put("category", next.category);
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function setFilter(next: SourceFilter) {
    setQuery({ source: next });
  }

  async function saveCase(caseId: string | null, body: CaseBody) {
    const next = caseId ? await ws.updateCase(p.id, caseId, body) : await ws.addCase(p.id, body);
    accept(next, !caseId);
    setEditing(null);
    if (caseId) setExpanded((prev) => new Set(prev).add(caseId));
  }

  async function removeCase(c: TestCase) {
    const next = await ws.deleteCase(p.id, c.id);
    accept(next, false);
    setDeleting(null);
  }

  async function refine(instruction: string, endpointIds: string[]) {
    const next = await ws.refinePlan(p.id, { instruction, endpoint_ids: endpointIds });
    setPlanningSince(Date.now());
    accept(next, true);
  }

  function setMany(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of ids) {
        if (on) next.add(i);
        else next.delete(i);
      }
      return next;
    });
  }

  function toggleExpanded(caseId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  }

  return (
    <>
      <Breadcrumbs items={crumbs(p)} />
      <Steps current={2} suiteHref={homeHref(p)} />

      <div className="page-head">
        <div>
          <h1>Review the plan for {p.spec_title}</h1>
          <p>
            Runs against <span className={styles.base}>{p.base_url}</span>. Untick anything you do not want sent.
          </p>
        </div>
      </div>

      <section className={styles.provenance} aria-labelledby="provenance-head">
        <div className={styles.provenanceHead}>
          <h2 id="provenance-head">Where these cases come from</h2>
          <p className={styles.willRun}>
            <span className="figure">{willRun}</span> will run
          </p>
        </div>
        <SourceLegend counts={sourceCounts} />
      </section>

      <div className={styles.aiLine}>
        {p.ai_status === "ok" && (
          <p className="notice">
            <span className="src src--ai">
              <Icon name="spark" />
              Claude
            </span>
            <span>
              proposed {plural(aiCount + p.rejected.length, "scenario")}. TestPilot checked each one against the spec before it could join the plan
              {p.rejected.length > 0 ? ` and turned ${p.rejected.length} away.` : "."}
            </span>
          </p>
        )}
        {p.ai_status !== "ok" && (
          <p className="notice" role={p.ai_status === "error" ? "alert" : undefined}>
            <Icon name="alert" />
            <span>
              {p.ai_status === "error"
                ? `Claude could not plan this time: ${p.ai_message} Every case below is system-generated or written by you. `
                : p.ai_status === "disabled"
                  ? "AI planning is off, so every case below comes from the contract engine or from you. "
                  : "AI scenarios were not requested for this plan, so every case below comes from the contract engine or from you. "}
              <Link href="/settings">Turn on AI in Settings</Link>
            </span>
          </p>
        )}
        {p.rejected.length > 0 && (
          <details className={styles.rejected}>
            <summary>
              <Icon name="chevron" size={12} />
              {p.rejected.length} rejected by plan validation
            </summary>
            <ul className="panel">
              {p.rejected.map((r, i) => (
                <li key={i}>
                  {r.name}
                  <span>{sentenceCase(r.reason)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {p.cases.length === 0 ? (
        <div className="empty">
          <h3>This plan has no cases</h3>
          <p>Neither the contract engine nor the AI planner produced a case. Check that the specification has operations and that AI planning is on.</p>
          <Link href={homeHref(p)} className="key">
            {p.suite_item_id ? "Back to the suite" : "Back to the project"}
          </Link>
        </div>
      ) : (
        <>
          {((p.strategy ?? []).length > 0 || (p.review_notes ?? []).length > 0) && (
            <div className={styles.explain}>
              {(p.strategy ?? []).length > 0 && (
                <details className={styles.disclosure}>
                  <summary>
                    <Icon name="chevron" size={12} />
                    <span className="src src--ai">
                      <Icon name="spark" />
                      How Claude planned this
                    </span>
                  </summary>
                  <ul className={styles.strategy}>
                    {p.strategy.map((s) => (
                      <li key={s.endpoint_id}>
                        <div className={styles.strategyHead}>
                          <MethodPath id={s.endpoint_id} />
                          <span className="muted">{plural(s.planned_cases, "case")} planned</span>
                        </div>
                        {s.risks.length > 0 && (
                          <ul className={styles.risks}>
                            {s.risks.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        )}
                        {s.categories.length > 0 && <p className="muted small">Covers {s.categories.map((c) => c.toLowerCase()).join(", ")}</p>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {(p.review_notes ?? []).length > 0 && (
                <details className={styles.disclosure}>
                  <summary>
                    <Icon name="chevron" size={12} />
                    <span className="src src--ai">
                      <Icon name="spark" />
                      What Claude&rsquo;s review pass changed
                    </span>
                  </summary>
                  <ul className={styles.reviewNotes}>
                    {p.review_notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <CoverageGrid
            cases={p.cases}
            extraEndpoints={strategyEndpoints}
            filter={coverage}
            onFilter={(f) => setQuery({ endpoint: f.endpoint, category: f.category })}
          />

          <RefineBox endpoints={allEndpoints} aiOff={p.ai_status === "disabled"} onRefine={refine} />

          <div className={styles.toolbar}>
            <div className="tray" role="group" aria-label="Filter by source">
              <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All ({p.cases.length})
              </button>
              <button type="button" aria-pressed={filter === "ai"} onClick={() => setFilter("ai")}>
                <Icon name="spark" />
                Claude ({aiCount})
              </button>
              <button type="button" aria-pressed={filter === "contract"} onClick={() => setFilter("contract")}>
                <Icon name="schema" />
                Contract ({contractCount})
              </button>
              <button type="button" aria-pressed={filter === "saved"} onClick={() => setFilter("saved")}>
                <Icon name="pencil" />
                Written by you ({savedCount})
              </button>
            </div>
            {visible.length > 0 && (
              <label className="check">
                <GroupCheckbox
                  label="Select every case shown"
                  checked={visibleSelected === visible.length}
                  indeterminate={visibleSelected > 0 && visibleSelected < visible.length}
                  onChange={(on) => setMany(visible.map((c) => c.id), on)}
                />
                <span>Select all shown</span>
              </label>
            )}
          </div>

          {coverageOn && (
            <p className={styles.filterLine} role="status">
              <span>
                Showing {coverage.endpoint ? <MethodPath id={coverage.endpoint} /> : "every endpoint"}
                {coverage.category ? `, ${coverage.category} cases` : ""}: {plural(coverageCases.length, "case")}
                {coverageCases.length > 0 ? `, ${sourceSplit(coverageCases)}` : ""}
              </span>
              <button type="button" className="key key--plain" onClick={() => setQuery({ endpoint: null, category: null })}>
                Show all
              </button>
            </p>
          )}

          {showTemplateNote && (
            <p className={styles.templateNote}>
              <code>{"{{unique}}"}</code> becomes a fresh token for each case, so emails and names never collide.{" "}
              <code>{"{{setup.0.body.id}}"}</code> reads a field from the response of setup step 0.
            </p>
          )}

          {visible.length === 0 ? (
            <div className="empty">
              <h3>
                {coverageOn
                  ? "No case matches both filters"
                  : filter === "ai"
                    ? "No cases from Claude in this plan"
                    : filter === "saved"
                      ? "No cases written by you yet"
                      : "No contract cases in this plan"}
              </h3>
              <p>
                {coverageOn
                  ? "The coverage cell and the source filter together leave nothing to show."
                  : filter === "ai"
                    ? "AI planning was off or returned nothing. Contract cases still cover the schema."
                    : filter === "saved"
                      ? "Use Add case on an endpoint to write one by hand."
                      : "Contract cases were turned off when this plan was created."}
              </p>
              <button type="button" className="key" onClick={() => setQuery({ source: "all", endpoint: null, category: null })}>
                Show all cases
              </button>
            </div>
          ) : (
            <div className={styles.groups}>
              {groups.map(([endpointId, cases]) => {
                const groupSelected = cases.filter((c) => selected.has(c.id)).length;
                return (
                  <section key={endpointId} className={`panel ${styles.group}`} aria-label={endpointId}>
                    <div className={styles.groupHead}>
                      <GroupCheckbox
                        label={`Select every case for ${endpointId}`}
                        checked={groupSelected === cases.length}
                        indeterminate={groupSelected > 0 && groupSelected < cases.length}
                        onChange={(on) => setMany(cases.map((c) => c.id), on)}
                      />
                      <MethodPath id={endpointId} />
                      <span className={styles.groupCount}>
                        {groupSelected} of {plural(cases.length, "case")} selected
                      </span>
                      <button type="button" className={`key key--plain ${styles.addCase}`} onClick={() => setEditing(`new:${endpointId}`)}>
                        <Icon name="plus" />
                        Add case
                      </button>
                    </div>
                    {editing === `new:${endpointId}` && (
                      <div className={styles.addPanel}>
                        <CaseEditor mode="add" endpointId={endpointId} onSubmit={(body) => saveCase(null, body)} onCancel={() => setEditing(null)} />
                      </div>
                    )}
                    <div className="table-scroll">
                      <table className={`ledger ${styles.cases}`}>
                        <colgroup>
                          <col className={styles.colCheck} />
                          <col />
                          <col className={`${styles.colCategory} ${styles.wideCol}`} />
                          <col className={`${styles.colSource} ${styles.wideCol}`} />
                          <col className={`${styles.colExpects} ${styles.wideCol}`} />
                        </colgroup>
                        <thead className={styles.colHead}>
                          <tr>
                            <th>
                              <span className="visually-hidden">Selected</span>
                            </th>
                            <th>Case</th>
                            <th className={styles.wideCol}>Category</th>
                            <th className={styles.wideCol}>Made by</th>
                            <th className={styles.wideCol}>Expects</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cases.map((c) => {
                            const open = expanded.has(c.id);
                            const detailId = `detail-${c.id}`;
                            return (
                              <Fragment key={c.id}>
                                <tr
                                  className={`is-link${open ? ` ${styles.openRow}` : ""}`}
                                  onClick={(e) => {
                                    if ((e.target as HTMLElement).closest("input, button, a, label")) return;
                                    toggleExpanded(c.id);
                                  }}
                                >
                                  <td className={styles.checkCell}>
                                    <input
                                      type="checkbox"
                                      aria-label={`Include ${c.name}`}
                                      checked={selected.has(c.id)}
                                      onChange={(e) => setMany([c.id], e.target.checked)}
                                    />
                                  </td>
                                  <td>
                                    <span className={styles.caseTitle}>
                                      <button
                                        type="button"
                                        className={styles.caseButton}
                                        aria-expanded={open}
                                        aria-controls={detailId}
                                        aria-label={`${open ? "Hide" : "Show"} request for ${c.name}`}
                                        onClick={() => toggleExpanded(c.id)}
                                      >
                                        <Icon name="chevron" size={12} />
                                      </button>
                                      <span className={styles.caseName}>{c.name}</span>
                                      {newIds.has(c.id) && <span className={styles.newMark}>New</span>}
                                    </span>
                                    <Reasoning c={c} />
                                    <span className={styles.caseFacts}>
                                      {c.destructive && (
                                        <span className={styles.destructive}>
                                          <Icon name="alert" size={12} />
                                          Destructive
                                        </span>
                                      )}
                                      {c.setup.length > 0 && <span className="muted">{plural(c.setup.length, "setup step")}</span>}
                                    </span>
                                    <span className={styles.phoneMeta}>
                                      <span>{sentenceCase(c.category)}</span>
                                      <SourceTag source={c.source} />
                                      <span>
                                        Expects <Expects codes={c.expected_status} />
                                      </span>
                                    </span>
                                  </td>
                                  <td className={`${styles.nowrap} ${styles.wideCol} muted`}>{sentenceCase(c.category)}</td>
                                  <td className={`${styles.nowrap} ${styles.wideCol}`}>
                                    <SourceTag source={c.source} />
                                  </td>
                                  <td className={`${styles.nowrap} ${styles.wideCol}`}>
                                    <Expects codes={c.expected_status} />
                                  </td>
                                </tr>
                                {open && (
                                  <tr id={detailId}>
                                    <td colSpan={5} className={styles.detailCell}>
                                      {editing === c.id ? (
                                        <CaseEditor
                                          mode="edit"
                                          endpointId={c.endpoint_id}
                                          initial={c}
                                          onSubmit={(body) => saveCase(c.id, body)}
                                          onCancel={() => setEditing(null)}
                                        />
                                      ) : (
                                        <CaseDetail c={c} onEdit={() => setEditing(c.id)} onDelete={() => setDeleting(c)} />
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })}
            </div>
          )}

          <RunPanel plan={p} selected={selected} allowDestructive={allowDestructive} onAllowDestructive={setAllowDestructive} />
          <DeleteCaseDialog testCase={deleting} onConfirm={() => (deleting ? removeCase(deleting) : Promise.resolve())} onClose={() => setDeleting(null)} />
        </>
      )}
    </>
  );
}
