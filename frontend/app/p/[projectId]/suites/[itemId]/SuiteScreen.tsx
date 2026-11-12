"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type ApiSummary, type Health } from "@/lib/api";
import { DEFAULT_PLANNER_CONFIG, ws, type Item, type PlannerConfig, type SavedSuite } from "@/lib/workspace";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { itemTrail } from "@/components/itemTrail";
import { Steps } from "@/components/Steps";
import { Icon } from "@/components/Icon";
import { useProject } from "@/components/ProjectContext";
import { EndpointLedger } from "@/app/_new-test/EndpointLedger";
import { PlannerSections } from "./PlannerSections";
import { SpecSource } from "./SpecSource";
import { SuiteHistory } from "./SuiteHistory";
import styles from "./suite.module.css";

const SAVE_DELAY_MS = 700;
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

function normalize(suite: SavedSuite | null): SavedSuite {
  const config: Partial<PlannerConfig> = suite?.config ?? {};
  return {
    spec_id: suite?.spec_id ?? null,
    last_plan_id: suite?.last_plan_id ?? null,
    last_run_id: suite?.last_run_id ?? null,
    config: {
      ...DEFAULT_PLANNER_CONFIG,
      ...config,
      auth: { ...DEFAULT_PLANNER_CONFIG.auth, ...(config.auth ?? {}) },
      objectives: config.objectives ?? [...DEFAULT_PLANNER_CONFIG.objectives],
    },
  };
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className={`skeleton ${styles.skeletonTitle}`} />
      <div className={`skeleton ${styles.skeletonBlock}`} />
    </div>
  );
}

export function SuiteScreen({ projectId, itemId }: { projectId: string; itemId: string }) {
  const router = useRouter();
  const { environment, refresh: refreshTree, tree } = useProject();
  const trail = useMemo(() => itemTrail(tree, projectId, itemId), [tree, projectId, itemId]);

  const [item, setItem] = useState<Item | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suite, setSuite] = useState<SavedSuite | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [spec, setSpec] = useState<ApiSummary | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [changingSpec, setChangingSpec] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<SavedSuite | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setItem(null);
    try {
      const it = await ws.item(itemId);
      if (it.kind !== "suite") throw new Error("This item is a saved request, not a test suite.");
      setItem(it);
      setName(it.name);
      setSuite(normalize(it.suite));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [itemId]);

  useEffect(() => {
    void load();
    api.health().then(setHealth, () => setHealth(null));
  }, [load]);

  const specId = suite?.spec_id ?? null;
  useEffect(() => {
    if (!specId) {
      setSpec(null);
      return;
    }
    if (spec?.spec_id === specId) return;
    let cancelled = false;
    setSpecError(null);
    api.spec(specId).then(
      (s) => !cancelled && setSpec(s),
      (err) => !cancelled && setSpecError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [specId, spec?.spec_id]);

  const persist = useCallback(
    async (next: SavedSuite) => {
      setSaveState("saving");
      try {
        await ws.updateItem(itemId, { suite: next });
        if (pending.current === next) pending.current = null;
        setSaveState("saved");
        setSaveError(null);
      } catch (err) {
        setSaveState("error");
        setSaveError(errorMessage(err));
      }
    },
    [itemId],
  );

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current) await persist(pending.current);
  }, [persist]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void ws.updateItem(itemId, { suite: pending.current });
    },
    [itemId],
  );

  function schedule(next: SavedSuite) {
    setSuite(next);
    pending.current = next;
    setSaveState("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (pending.current) void persist(pending.current);
    }, SAVE_DELAY_MS);
  }

  const patchConfig = (patch: Partial<PlannerConfig>) => {
    if (!suite) return;
    schedule({ ...suite, config: { ...suite.config, ...patch } });
  };

  async function pickSpec(newSpecId: string, loaded?: ApiSummary) {
    if (!suite) return;
    const changed = newSpecId !== suite.spec_id;
    const next: SavedSuite = {
      ...suite,
      spec_id: newSpecId,
      config: changed ? { ...suite.config, focus_endpoints: [], endpoint_notes: [] } : suite.config,
    };
    if (loaded) setSpec(loaded);
    setSuite(next);
    pending.current = next;
    await flush();
    setChangingSpec(false);
  }

  async function saveName() {
    if (!item) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("A suite needs a name.");
      return;
    }
    setNameError(null);
    if (trimmed === item.name) return;
    try {
      const updated = await ws.updateItem(item.id, { name: trimmed });
      setItem(updated);
      void refreshTree();
    } catch (err) {
      setNameError(errorMessage(err));
    }
  }

  const aiEnabled = health ? health.ai_enabled : null;
  const config = suite?.config;
  const endpoints = useMemo(() => spec?.endpoints ?? [], [spec]);
  const focus = useMemo(() => {
    const ids = config?.focus_endpoints ?? [];
    return new Set(ids.length ? ids : endpoints.map((e) => e.id));
  }, [config?.focus_endpoints, endpoints]);
  const notes = useMemo(() => Object.fromEntries((config?.endpoint_notes ?? []).map((n) => [n.endpoint_id, n.note])), [config?.endpoint_notes]);

  const aiActive = Boolean(config?.use_ai) && aiEnabled !== false;
  const blocked = !suite?.spec_id
    ? "Choose a specification first."
    : !spec
      ? "Loading the specification."
      : !environment
        ? "Add an environment to this project first."
        : !environment.base_url_allowed
          ? `${environment.name} points at a host outside the allowlist.`
          : !config?.use_contract && !aiActive
            ? "Turn on contract cases or AI scenarios."
            : aiActive && config && config.objectives.length === 0 && !config.use_contract
              ? "Pick at least one objective."
              : focus.size === 0
                ? "Include at least one endpoint."
                : config?.business_rules.some((r) => !r.text.trim())
                  ? "Fill in or remove the empty business rule."
                  : null;

  async function generate() {
    if (!item || !suite || !suite.spec_id || !environment || blocked) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      await flush();
      const cfg: PlannerConfig = { ...suite.config, use_ai: aiActive, review_pass: suite.config.review_pass && aiActive };
      const plan = await ws.createPlan({
        project_id: projectId,
        spec_id: suite.spec_id,
        environment_id: environment.id,
        suite_item_id: item.id,
        config: cfg,
      });
      const next = { ...suite, last_plan_id: plan.id };
      setSuite(next);
      await ws.updateItem(item.id, { suite: next });
      router.push(`/p/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(plan.id)}`);
    } catch (err) {
      setGenerateError(errorMessage(err));
      setGenerating(false);
    }
  }

  if (loadError) {
    return (
      <>
        <Breadcrumbs items={trail} />
        <Steps current={1} />
        <div className="error-state" role="alert">
          <h3>Could not open this suite</h3>
          <p>{loadError}</p>
          <button type="button" className="key" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </>
    );
  }

  if (!item || !suite || !config) {
    return (
      <>
        <Breadcrumbs items={trail} />
        <Steps current={1} />
        <p className="visually-hidden" role="status">
          Loading suite
        </p>
        <Skeleton />
      </>
    );
  }

  const savedLabel =
    saveState === "pending" || saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : saveState === "error" ? "Not saved" : "";
  const pid = encodeURIComponent(projectId);

  return (
    <>
      <Breadcrumbs items={trail} />
      <Steps current={1} planHref={suite.last_plan_id ? `/p/${pid}/plans/${encodeURIComponent(suite.last_plan_id)}` : undefined} />

      <div className={styles.head}>
        <div className={styles.nameField}>
          <label htmlFor="suite-name" className="visually-hidden">
            Suite name
          </label>
          <input
            id="suite-name"
            name="suite_name"
            className={styles.nameInput}
            value={name}
            maxLength={120}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            aria-describedby="suite-name-help"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <p id="suite-name-help" className={`helper${nameError ? " is-error" : ""}`}>
            {nameError ?? "Test suite. Settings below save as you edit."}
          </p>
        </div>
        <div className={styles.headLinks}>
          <span className={`${styles.saveState}${saveState === "error" ? ` ${styles.saveError}` : ""}`} role="status" title={saveError ?? undefined}>
            {savedLabel}
          </span>
          {suite.last_plan_id && (
            <Link className="key" href={`/p/${pid}/plans/${encodeURIComponent(suite.last_plan_id)}`}>
              Last plan
            </Link>
          )}
          {suite.last_run_id && (
            <Link className="key" href={`/p/${pid}/runs/${encodeURIComponent(suite.last_run_id)}`}>
              Last run
            </Link>
          )}
        </div>
      </div>

      {saveState === "error" && saveError && (
        <p className="notice" role="alert">
          <Icon name="alert" />
          <span>
            Changes are not saved yet: {saveError}{" "}
            <button type="button" className="key key--plain" onClick={() => void flush()}>
              Retry
            </button>
          </span>
        </p>
      )}

      <div className={styles.layout}>
        <section className={styles.block} aria-labelledby="spec-heading">
          {!suite.spec_id || changingSpec ? (
            <>
              <div className={styles.blockHead}>
                <div>
                  <h2 id="spec-heading">Specification</h2>
                  <p className={styles.blockLede}>The OpenAPI document this suite tests. Pick one this project already has, or read a new one.</p>
                </div>
              </div>
              <SpecSource
                projectId={projectId}
                allowedHosts={health?.allowed_hosts ?? null}
                onPick={pickSpec}
                onCancel={changingSpec && suite.spec_id ? () => setChangingSpec(false) : undefined}
              />
            </>
          ) : specError ? (
            <div className="error-state" role="alert">
              <h3 id="spec-heading">Specification not found</h3>
              <p>{specError}</p>
              <button type="button" className="key" onClick={() => setChangingSpec(true)}>
                Choose another
              </button>
            </div>
          ) : !spec ? (
            <div aria-hidden="true">
              <div className={`skeleton ${styles.skeletonTitle}`} />
              <div className={`skeleton ${styles.skeletonBlock}`} />
            </div>
          ) : (
            <>
              <div className={styles.blockHead}>
                <div>
                  <h2 id="spec-heading">{spec.title}</h2>
                  <p className={styles.blockLede}>
                    Version {spec.version || "unversioned"}, OpenAPI {spec.openapi_version}. Uncheck endpoints to leave them out; add a note to steer the planner.
                  </p>
                </div>
                <div className={styles.specSummary}>
                  <p className={styles.count}>
                    <span className="figure">{endpoints.length}</span>
                    <span className={styles.countLabel}>{endpoints.length === 1 ? "endpoint" : "endpoints"}</span>
                  </p>
                  <Link className="key key--plain" href={`/p/${pid}/specs/${encodeURIComponent(suite.spec_id)}`}>
                    <Icon name="spec" />
                    View the contract
                  </Link>
                  <button type="button" className="key" onClick={() => setChangingSpec(true)}>
                    Change specification
                  </button>
                </div>
              </div>
              <div className={`panel ${styles.ledgerPanel}`}>
                <EndpointLedger
                  endpoints={endpoints}
                  selected={focus}
                  onChange={(next) =>
                    patchConfig({ focus_endpoints: next.size === endpoints.length ? [] : endpoints.map((e) => e.id).filter((id) => next.has(id)) })
                  }
                  notes={notes}
                  onNoteChange={(endpointId, note) => {
                    const others = config.endpoint_notes.filter((n) => n.endpoint_id !== endpointId);
                    patchConfig({ endpoint_notes: note ? [...others, { endpoint_id: endpointId, note }] : others });
                  }}
                />
              </div>
            </>
          )}
        </section>

        <section className={styles.block} aria-labelledby="planner-heading">
          <div className={styles.blockHead}>
            <div>
              <h2 id="planner-heading">How to plan</h2>
              <p className={styles.blockLede}>The more you tell the planner, the sharper the cases. Everything here is optional except the engines.</p>
            </div>
          </div>
          <PlannerSections config={config} onChange={patchConfig} endpoints={endpoints} environment={environment} aiEnabled={aiEnabled} />
        </section>

        <SuiteHistory projectId={projectId} itemId={itemId} />
      </div>

      <div className={styles.bar}>
        <div className={styles.barInner}>
          <div className={styles.barEnv}>
            {environment ? (
              <>
                <span className={styles.barEnvName}>Runs against {environment.name}</span>
                <span className="mono muted">{environment.base_url}</span>
                {!environment.base_url_allowed && (
                  <span className={styles.barWarn}>
                    <Icon name="alert" />
                    This host is outside the allowlist.
                  </span>
                )}
              </>
            ) : (
              <span className={styles.barWarn}>
                <Icon name="alert" />
                No environment in this project yet.
              </span>
            )}
          </div>
          <div className={styles.barAction}>
            <button
              type="button"
              className="key key--primary"
              disabled={Boolean(blocked) || generating}
              aria-busy={generating || undefined}
              aria-describedby="generate-help"
              onClick={() => void generate()}
            >
              {generating && <span className="spinner" aria-hidden="true" />}
              Generate test plan
            </button>
            <p id="generate-help" className={`helper${generateError ? " is-error" : ""}`} role={generateError ? "alert" : undefined}>
              {generateError ?? blocked ?? (aiActive ? "Claude plans in the background; you can watch its progress." : "Contract cases only.")}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
