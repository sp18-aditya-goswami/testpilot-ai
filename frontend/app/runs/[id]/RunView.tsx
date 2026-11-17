"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Breadcrumbs, type Crumb } from "@/components/Breadcrumbs";
import { Icon } from "@/components/Icon";
import { itemTrail } from "@/components/itemTrail";
import { OutcomeBar } from "@/components/OutcomeBar";
import { useOptionalProject } from "@/components/ProjectContext";
import { Steps, type StepNumber } from "@/components/Steps";
import { api, errorMessage, type CaseResult, type Run } from "@/lib/api";
import { flowHref } from "@/lib/testplans";
import { ACTIVE, SOURCE_KIND_LABEL, STATUS_WORDS, formatDuration, formatStarted, isFlowPath, planHref, runHref, runTitle, seconds } from "../format";
import styles from "../runs.module.css";
import { CaseList, OUTCOME_FILTERS, SOURCE_FILTERS, type OutcomeFilter, type SourceFilter } from "./CaseList";
import { groupAnchor, groupFindings, groupTitle, type FindingItem } from "./Finding";
import { FindingTable } from "./FindingTable";
import { Summary } from "./Summary";

function useNow(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading run">
      <div className={`skeleton ${styles.skeletonCrumbs}`} />
      <div className={`ticks ${styles.verdict}`}>
        <div className={styles.verdictMain}>
          <div className={`skeleton ${styles.skeletonFigure}`} />
          <div className={`skeleton ${styles.skeletonBar}`} />
        </div>
        <div className={styles.verdictSide}>
          <div className={`skeleton ${styles.skeletonTitle}`} />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </div>
      <div className={styles.skeletonRows}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    </div>
  );
}

export function RunView({ id }: { id: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const show = (OUTCOME_FILTERS.find((f) => f.key === params.get("show"))?.key ?? "all") as OutcomeFilter;
  const sourceFilter = (SOURCE_FILTERS.find((f) => f.key === params.get("source"))?.key ?? "all") as SourceFilter;

  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const [casesOpen, setCasesOpen] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const projectCtx = useOptionalProject();
  const flow = isFlowPath(pathname);

  const load = useCallback(async () => {
    try {
      const r = await api.run(id);
      setRun(r);
      setError(null);
      return r;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [id]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await load();
      if (stopped) return;
      if (!r) timer = setTimeout(tick, 3000);
      else if (ACTIVE.includes(r.status)) timer = setTimeout(tick, 1000);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const active = run ? ACTIVE.includes(run.status) : false;
  useNow(active);

  const projectId = run?.project_id ?? null;

  const resultsById = useMemo(() => {
    const m = new Map<string, CaseResult>();
    run?.results.forEach((r) => m.set(r.case_id, r));
    return m;
  }, [run]);

  const findings = useMemo(() => {
    if (!run) return [];
    const failed = run.cases
      .map((c) => ({ testCase: c, result: resultsById.get(c.id) }))
      .filter((f): f is FindingItem => f.result?.outcome === "failed");
    return groupFindings(failed);
  }, [run, resultsById]);
  const failedCount = findings.reduce((n, g) => n + g.members.length, 0);

  if (!run) {
    if (error) {
      return (
        <div className="error-state" role="alert">
          <h3>This run could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="key" onClick={() => load()}>
            Retry
          </button>
        </div>
      );
    }
    return <Skeleton />;
  }

  const done = run.results.length;
  const total = run.counts.total || run.cases.length;
  const elapsed = seconds(run.created_at, run.finished_at);

  const setParam = (name: "show" | "source", value: string) => {
    const q = new URLSearchParams(params.toString());
    if (value === "all") q.delete(name);
    else q.set(name, value);
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const rows = run.cases.filter((c) => {
    if (sourceFilter !== "all" && c.source !== sourceFilter) return false;
    if (show === "all") return true;
    const outcome = resultsById.get(c.id)?.outcome;
    if (show === "skipped") return outcome === "skipped" || outcome === "error";
    return outcome === show;
  });
  const sourcesPresent = new Set(run.cases.map((c) => c.source));

  /** Opens the finding that holds this case and brings it into view. */
  const goToFinding = (caseId: string) => {
    const group = findings.find((g) => g.members.some((m) => m.testCase.id === caseId));
    if (!group) return;
    setOpenFinding(group.key);
    requestAnimationFrame(() => document.getElementById(groupAnchor(group))?.scrollIntoView({ block: "start" }));
  };

  const isSuite = run.source_kind === "suite";
  /** The plan this run came from, in the flow or in the workspace. */
  const planLink = isSuite && run.plan_id ? (flow ? flowHref.plan(run.plan_id) : planHref(run.plan_id, projectId)) : null;
  const stepHrefs: Partial<Record<StepNumber, string>> = {};
  if (planLink) stepHrefs[3] = planLink;
  if (flow) {
    if (run.source_id) stepHrefs[2] = flowHref.edit(run.source_id);
  } else stepHrefs[2] = projectId && run.source_id ? `/p/${projectId}/suites/${run.source_id}` : projectId ? `/p/${projectId}` : "/workspace";

  /** Run the same plan again with the same cases and options; fuzz findings are regenerated, not replayed. */
  const runAgain = async () => {
    if (!run.plan_id || rerunning) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const next = await api.startRun(run.plan_id, {
        case_ids: run.cases.filter((c) => c.source !== "fuzz").map((c) => c.id),
        allow_destructive: run.allow_destructive,
        fuzz: run.fuzz_status !== "off",
        fuzz_examples: 20,
      });
      router.push(flow ? flowHref.run(next.id) : runHref(next));
    } catch (err) {
      setRerunError(errorMessage(err));
      setRerunning(false);
    }
  };

  const tree = projectCtx?.tree ?? null;
  const crumbs: Crumb[] = [];
  if (flow) {
    crumbs.push({ label: "Test plans", href: flowHref.list });
    crumbs.push({ label: isSuite ? run.source_name || run.spec_title : runTitle(run), href: planLink ?? undefined });
  } else if (projectId && run.source_kind === "suite") {
    crumbs.push(...itemTrail(tree, projectId, run.source_id, run.source_id ? `/p/${projectId}/suites/${run.source_id}` : undefined));
  } else if (projectId) {
    crumbs.push({ label: tree?.project.name ?? "Project", href: `/p/${projectId}` });
    if (run.source_name) crumbs.push({ label: run.source_name });
  }
  if (!flow && isSuite && run.plan_id) crumbs.push({ label: "Plan", href: planHref(run.plan_id, projectId) });
  crumbs.push({ label: `Run at ${shortTime(run.created_at)}` });

  const worst = findings[0];
  const analyzing = run.status === "analyzing";
  let figure: React.ReactNode;
  let figureTone = "";
  let caption: string;
  if (active) {
    figure = (
      <>
        {done}
        <span className={styles.figureOf}> of {total}</span>
      </>
    );
    caption = analyzing ? "All cases finished, explaining failures" : "cases finished";
  } else if (run.counts.failed > 0) {
    figure = run.counts.failed;
    figureTone = styles.figureFailed;
    caption = `failed of ${total} ${total === 1 ? "case" : "cases"}`;
  } else if (run.status === "failed") {
    figure = done;
    caption = `of ${total} cases finished before the run stopped`;
  } else {
    figure = total;
    figureTone = styles.figurePassed;
    caption = run.counts.skipped > 0 ? "cases ran, none failed" : "All cases passed";
  }

  return (
    <>
      <Breadcrumbs items={crumbs} />
      {isSuite && <Steps current={4} hrefs={stepHrefs} />}

      <section className={`ticks ${styles.verdict}`} aria-label="Run result">
        <div className={styles.verdictMain}>
          <p className={styles.verdictFigure} role="status" aria-live="polite">
            <span className={`figure ${figureTone}`}>{figure}</span>
            <span className={styles.verdictCaption}>{caption}</span>
          </p>
          {!active && worst && (
            <p className={styles.verdictWorst}>
              Most severe:{" "}
              <a
                href={`#${groupAnchor(worst)}`}
                onClick={(e) => {
                  e.preventDefault();
                  goToFinding(worst.members[0].testCase.id);
                }}
              >
                {groupTitle(worst)}
              </a>
            </p>
          )}
          <OutcomeBar counts={{ ...run.counts, total }} />
        </div>
        <div className={styles.verdictSide}>
          <h1 className={styles.runTitle}>{runTitle(run)}</h1>
          <dl className={styles.meta}>
            {run.source_kind !== "suite" && (
              <div>
                <dt>Ran</dt>
                <dd>{SOURCE_KIND_LABEL[run.source_kind]}</dd>
              </div>
            )}
            {run.environment_name && (
              <div>
                <dt>Environment</dt>
                <dd>{run.environment_name}</dd>
              </div>
            )}
            <div>
              <dt>Target</dt>
              <dd className="mono">{run.base_url}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{formatStarted(run.created_at)}</dd>
            </div>
            <div>
              <dt>{active ? "Running for" : "Took"}</dt>
              <dd>{formatDuration(elapsed)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd className={run.status === "failed" ? "status status--failed" : undefined}>{STATUS_WORDS[run.status]}</dd>
            </div>
          </dl>
          <div className={styles.actions}>
            {planLink && (
              <button type="button" className="key" onClick={runAgain} disabled={active || rerunning} aria-busy={rerunning || undefined}>
                {rerunning ? <span className="spinner keep-motion" aria-hidden="true" /> : <Icon name="play" />}
                {rerunning ? "Starting run" : "Run again"}
              </button>
            )}
            {planLink && (
              <Link className="key" href={planLink}>
                Back to the plan
              </Link>
            )}
            <a className="key" href={api.reportHtmlUrl(run.id)} target="_blank" rel="noopener noreferrer">
              HTML report
              <Icon name="external" />
            </a>
            <a className="key" href={api.reportJsonUrl(run.id)} download={`testpilot-${run.id}.json`}>
              <Icon name="download" />
              JSON
            </a>
          </div>
          {rerunError && (
            <p className="helper is-error" role="alert">
              {rerunError}
            </p>
          )}
        </div>
      </section>

      {error && (
        <p className={`notice ${styles.liveNotice}`} role="alert">
          <Icon name="alert" />
          <span>Live updates paused ({error.replace(/\.$/, "")}). Retrying every few seconds.</span>
        </p>
      )}

      {total === 0 ? (
        <section className="section">
          <div className="empty">
            <h3>This run has no cases</h3>
            <p>Nothing was selected when it started, so there is nothing to report.</p>
            {flow ? (
              <Link className="key" href={planLink ?? flowHref.list}>
                {planLink ? "Back to the plan" : "Open test plans"}
              </Link>
            ) : (
              <Link className="key" href={projectId ? `/p/${projectId}` : "/workspace"}>
                {projectId ? "Back to the project" : "Open projects"}
              </Link>
            )}
          </div>
        </section>
      ) : (
        <div className={styles.report}>
          {run.status === "failed" && run.message && (
            <p className="notice" role="alert">
              <Icon name="alert" />
              <span>{run.message}</span>
            </p>
          )}

          <section id="findings" className={styles.reportSection} aria-labelledby="findings-head">
            <div className={styles.sectionHead}>
              <h2 id="findings-head">What to fix</h2>
              {findings.length > 0 && (
                <p className={styles.caption}>
                  {findings.length === failedCount
                    ? `${failedCount} failed ${failedCount === 1 ? "case" : "cases"}, most severe first. Open a row for the request, the response and a fix.`
                    : `${failedCount} failed cases from ${findings.length} causes, most severe first. Open a row for the request, the response and a fix.`}
                </p>
              )}
            </div>
            {findings.length === 0 ? (
              <p className={`notice ${active ? "" : styles.allClear}`}>
                <Icon name={active ? "minus" : "check"} />
                <span>{active ? "No failures so far. They appear here as cases finish." : "Nothing to fix. Every check passed or was skipped."}</span>
              </p>
            ) : (
              <FindingTable run={run} findings={findings} open={openFinding} onToggle={(key) => setOpenFinding((k) => (k === key ? null : key))} flow={flow} />
            )}
          </section>

          <details id="cases" className={`panel ${styles.fold}`} open={casesOpen} onToggle={(e) => setCasesOpen((e.target as HTMLDetailsElement).open)}>
            <summary>
              <span className={styles.foldTitle}>All {total} cases</span>
              <span className={styles.foldMeta}>
                {run.counts.passed > 0 && <span className={styles.passedText}>{run.counts.passed} passed</span>}
                {run.counts.failed > 0 && <span className={styles.failedText}>{run.counts.failed} failed</span>}
                {run.counts.skipped + run.counts.error > 0 && <span>{run.counts.skipped + run.counts.error} skipped or not run</span>}
              </span>
            </summary>
            {casesOpen && (
              <div className={styles.foldBody}>
                <div className={styles.filters}>
                  <div className="tray" role="group" aria-label="Show cases by result">
                    {OUTCOME_FILTERS.map((f) => (
                      <button key={f.key} type="button" aria-pressed={show === f.key} onClick={() => setParam("show", f.key)}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                  <div className="tray" role="group" aria-label="Show cases by who made them">
                    {SOURCE_FILTERS.filter((f) => f.key === "all" || sourcesPresent.has(f.key)).map((f) => (
                      <button key={f.key} type="button" aria-pressed={sourceFilter === f.key} onClick={() => setParam("source", f.key)}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
                {rows.length === 0 ? (
                  <p className={`muted ${styles.noRows}`}>No case matches these filters.</p>
                ) : (
                  <CaseList cases={rows} results={resultsById} onGoToFinding={goToFinding} />
                )}
              </div>
            )}
          </details>

          <details className={`panel ${styles.fold}`}>
            <summary>
              <span className={styles.foldTitle}>About this run</span>
              <span className={styles.foldMeta}>
                <span>{run.auth_note ? "sign-in, " : ""}where the cases came from, how failures were explained</span>
              </span>
            </summary>
            <div className={styles.foldBody}>
              <Summary run={run} results={resultsById} findings={findings} active={active} />
            </div>
          </details>
        </div>
      )}
    </>
  );
}
