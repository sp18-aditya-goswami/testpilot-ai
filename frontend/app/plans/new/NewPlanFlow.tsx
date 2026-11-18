"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Icon } from "@/components/Icon";
import { PlannerSections } from "@/components/planner/PlannerSections";
import { Steps } from "@/components/Steps";
import { api, errorMessage, type ApiSummary } from "@/lib/api";
import { flowHref, testPlans, type AccessStatus } from "@/lib/testplans";
import { DEFAULT_PLANNER_CONFIG, ws, type Item, type PlannerConfig } from "@/lib/workspace";
import { AccessForm, SecondLoginForm, authFor } from "./AccessForm";
import styles from "./new-plan.module.css";

/** What step 1 settled: the API under test and where it runs. */
interface Target {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  baseUrl: string;
  access: AccessStatus | null;
  api: ApiSummary;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol.startsWith("http") ? u.origin : null;
  } catch {
    return null;
  }
}

export function NewPlanFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const suiteParam = params.get("suite");
  const projectParam = params.get("project");
  const specParam = params.get("spec");
  const ids = { spec: useId(), paste: useId(), base: useId(), name: useId() };

  const [step, setStep] = useState<1 | 2>(suiteParam || specParam ? 2 : 1);
  const [loading, setLoading] = useState(!!(suiteParam || specParam));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);

  // step 1
  const [source, setSource] = useState<"link" | "paste">("link");
  const [specUrl, setSpecUrl] = useState("");
  const [specText, setSpecText] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [baseTouched, setBaseTouched] = useState(false);
  const [fixedSpec, setFixedSpec] = useState<{ projectId: string; projectName: string; api: ApiSummary } | null>(null);

  // step 2
  const [target, setTarget] = useState<Target | null>(null);
  const [suite, setSuite] = useState<Item | null>(null);
  const [config, setConfig] = useState<PlannerConfig>(DEFAULT_PLANNER_CONFIG);
  const [name, setName] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then((h) => setAiEnabled(h.ai_enabled), () => setAiEnabled(null));
  }, []);

  // Editing a saved plan, or starting from a spec already in the workspace.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (suiteParam) {
          const item = await ws.item(suiteParam);
          if (!item.suite?.spec_id) throw new Error("This suite has no API spec yet. Open it in the workspace to choose one.");
          const [tree, spec] = await Promise.all([ws.tree(item.project_id), api.spec(item.suite.spec_id)]);
          let envId: string | null = null;
          if (item.suite.last_plan_id) {
            envId = await api.plan(item.suite.last_plan_id).then((p) => p.environment_id, () => null);
          }
          const env = tree.environments.find((e) => e.id === envId) ?? tree.environments.find((e) => e.is_default) ?? tree.environments[0];
          if (!env) throw new Error("This project has no environment yet. Add one in the workspace first.");
          const access = await testPlans.access(spec.spec_id, env.id).catch(() => null);
          if (cancelled) return;
          const cfg = { ...DEFAULT_PLANNER_CONFIG, ...item.suite.config };
          setSuite(item);
          setConfig(cfg);
          setName(item.name);
          setTarget({
            projectId: item.project_id,
            projectName: tree.project.name,
            environmentId: env.id,
            environmentName: env.name,
            baseUrl: env.base_url,
            access,
            api: spec,
          });
        } else if (projectParam && specParam) {
          const [tree, spec] = await Promise.all([ws.tree(projectParam), api.spec(specParam)]);
          const env = tree.environments.find((e) => e.is_default) ?? tree.environments[0];
          const access = env ? await testPlans.access(spec.spec_id, env.id).catch(() => null) : null;
          if (cancelled) return;
          setName(`${spec.title} test plan`);
          if (env) {
            setTarget({
              projectId: projectParam,
              projectName: tree.project.name,
              environmentId: env.id,
              environmentName: env.name,
              baseUrl: env.base_url,
              access,
              api: spec,
            });
          } else {
            setFixedSpec({ projectId: projectParam, projectName: tree.project.name, api: spec });
            setStep(1);
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (suiteParam || (projectParam && specParam)) void load();
    return () => {
      cancelled = true;
    };
  }, [suiteParam, projectParam, specParam]);

  const patch = (next: Partial<PlannerConfig>) => setConfig((c) => ({ ...c, ...next }));
  const endpoints = target?.api.endpoints ?? [];
  const selected = useMemo(() => new Set(config.focus_endpoints.length ? config.focus_endpoints : endpoints.map((e) => e.id)), [config.focus_endpoints, endpoints]);
  const aiOff = aiEnabled === false;

  async function continueToStep2(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const server = baseUrl.trim();
    if (!fixedSpec && source === "link" && !specUrl.trim()) return setError("Paste the link to your OpenAPI spec, or switch to pasting the spec itself.");
    if (!fixedSpec && source === "paste" && !specText.trim()) return setError("Paste the OpenAPI spec as JSON or YAML.");
    if (!originOf(server)) return setError("Enter the server to test as an http or https address, for example http://localhost:8000.");
    setBusy(true);
    try {
      let next: Target;
      if (fixedSpec) {
        const env = await ws.createEnvironment(fixedSpec.projectId, { name: "Default", base_url: server, is_default: true, variables: [] });
        const access = await testPlans.access(fixedSpec.api.spec_id, env.id).catch(() => null);
        next = { projectId: fixedSpec.projectId, projectName: fixedSpec.projectName, environmentId: env.id, environmentName: env.name, baseUrl: env.base_url, access, api: fixedSpec.api };
      } else {
        const out = await testPlans.start({ ...(source === "link" ? { spec_url: specUrl.trim() } : { spec_text: specText }), base_url: server });
        next = { projectId: out.project_id, projectName: out.project_name, environmentId: out.environment_id, environmentName: out.environment_name, baseUrl: server.replace(/\/+$/, ""), access: out.access, api: out.api };
        if (!name) setName(`${out.api.title} test plan`);
      }
      setTarget(next);
      if (!next.access?.needs_input) goToStep2();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function goToStep2() {
    setStep(2);
    window.scrollTo({ top: 0 });
  }

  const accessSaved = (access: AccessStatus) => setTarget((t) => (t ? { ...t, access } : t));

  async function buildPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    const useAi = config.use_ai && !aiOff;
    if (!useAi && !config.use_contract) return setError("Turn on at least one source of test cases under More options.");
    if (useAi && config.objectives.length === 0) return setError("Pick at least one thing for the AI to focus on.");
    if (selected.size === 0) return setError("Choose at least one endpoint to test in section 1.");
    const mode = target.access?.auth.mode;
    if (config.auth.second_user && mode === "credentials" && !target.access?.has_second_login)
      return setError("Save user B's test login in section 7, or turn off “Test with a second user”.");
    const finalConfig: PlannerConfig = {
      ...config,
      use_ai: useAi,
      business_rules: config.business_rules.filter((r) => r.text.trim()).map((r) => ({ ...r, text: r.text.trim() })),
      auth: authFor(config.auth, target.access),
    };
    const planName = name.trim() || `${target.api.title} test plan`;
    setBusy(true);
    try {
      if (suite) {
        await ws.updateItem(suite.id, { name: planName, suite: { ...(suite.suite ?? { spec_id: target.api.spec_id, last_plan_id: null, last_run_id: null }), config: finalConfig } });
        const plan = await ws.createPlan({ project_id: target.projectId, spec_id: target.api.spec_id, environment_id: target.environmentId, suite_item_id: suite.id, config: finalConfig });
        router.push(flowHref.plan(plan.id));
      } else {
        const out = await testPlans.create({ project_id: target.projectId, environment_id: target.environmentId, spec_id: target.api.spec_id, name: planName, config: finalConfig });
        router.push(flowHref.plan(out.plan.id));
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const crumbs = [{ label: "Test plans", href: flowHref.list }, { label: suite ? suite.name : "New test plan" }];
  const editing = !!suite;
  const stepHrefs = suite?.suite?.last_plan_id ? { 3: flowHref.plan(suite.suite.last_plan_id) } : {};

  if (loading) {
    return (
      <>
        <Breadcrumbs items={crumbs} />
        <Steps current={2} />
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading the plan settings">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      </>
    );
  }

  if (loadError) {
    return (
      <>
        <Breadcrumbs items={crumbs} />
        <div className="error-state" role="alert">
          <h3>This plan could not be opened</h3>
          <p>{loadError}</p>
          <Link href={flowHref.list} className="key">
            Back to test plans
          </Link>
        </div>
      </>
    );
  }

  if (step === 1 && target?.access?.needs_input) {
    return (
      <>
        <Breadcrumbs items={crumbs} />
        <Steps current={1} />
        <div className={styles.head}>
          <h1>One more thing before planning.</h1>
          <p>
            TestPilot read {target.api.title}: {target.api.endpoints.length} {target.api.endpoints.length === 1 ? "endpoint" : "endpoints"}, tested on{" "}
            <span className="mono">{target.baseUrl}</span>.
          </p>
        </div>
        <AccessForm
          access={target.access}
          specId={target.api.spec_id}
          environmentId={target.environmentId}
          onSaved={(access) => {
            accessSaved(access);
            goToStep2();
          }}
          onSkip={goToStep2}
        />
        <button type="button" className="key key--plain" onClick={() => setTarget(null)}>
          Back to the spec and server
        </button>
      </>
    );
  }

  if (step === 1) {
    return (
      <>
        <Breadcrumbs items={crumbs} />
        <Steps current={1} />
        <div className={styles.head}>
          <h1>Which API are we testing?</h1>
          <p>{fixedSpec ? `The spec is ${fixedSpec.api.title}. Tell TestPilot where the API runs.` : "Two things and you can go: the OpenAPI spec and the server to send requests to."}</p>
        </div>

        <form className={`panel ${styles.card}`} onSubmit={continueToStep2} noValidate>
          {!fixedSpec && (
            <div className={styles.block}>
              <div className={styles.blockHead}>
                <span className="label" id={`${ids.spec}-label`}>
                  OpenAPI spec
                </span>
                <div className="tray" role="group" aria-labelledby={`${ids.spec}-label`}>
                  <button type="button" aria-pressed={source === "link"} onClick={() => setSource("link")}>
                    Link
                  </button>
                  <button type="button" aria-pressed={source === "paste"} onClick={() => setSource("paste")}>
                    Paste
                  </button>
                </div>
              </div>
              {source === "link" ? (
                <div className="field">
                  <label htmlFor={ids.spec} className="visually-hidden">
                    Link to the OpenAPI spec
                  </label>
                  <input
                    id={ids.spec}
                    name="spec_url"
                    className="input mono"
                    type="url"
                    inputMode="url"
                    autoComplete="off"
                    autoFocus
                    placeholder="http://localhost:8008/openapi.json"
                    value={specUrl}
                    onChange={(e) => {
                      setSpecUrl(e.target.value);
                      if (!baseTouched) setBaseUrl(originOf(e.target.value) ?? "");
                    }}
                  />
                  <p className="helper">JSON or YAML, OpenAPI 3. The host must be on the allowed list in Settings.</p>
                </div>
              ) : (
                <div className="field">
                  <label htmlFor={ids.paste} className="visually-hidden">
                    OpenAPI spec text
                  </label>
                  <textarea id={ids.paste} name="spec_text" className="input code-input" spellCheck={false} placeholder='{"openapi": "3.1.0", ...}' value={specText} onChange={(e) => setSpecText(e.target.value)} />
                </div>
              )}
            </div>
          )}

          <div className={styles.block}>
            <div className="field">
              <label htmlFor={ids.base}>Server to test</label>
              <input
                id={ids.base}
                name="base_url"
                className="input mono"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoFocus={!!fixedSpec}
                placeholder="http://localhost:8008"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setBaseTouched(true);
                }}
              />
              <p className="helper">Every test request goes here. Use a staging or local server, never production.</p>
            </div>
            <p className="helper">No token needed here. TestPilot reads the spec and asks for a login only when the API needs one it cannot get by itself.</p>
          </div>

          <p className={`helper ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
            {error ?? ""}
          </p>
          <div className={styles.actions}>
            <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Reading the spec" : "Continue"}
              {!busy && <Icon name="arrowRight" />}
            </button>
            <Link href={flowHref.list} className="key key--plain">
              Cancel
            </Link>
          </div>
        </form>
      </>
    );
  }

  if (!target) return null;

  const a = target.access?.auth;
  const authNote =
    a?.mode === "auto"
      ? `Each run signs itself in: a new test user from ${a.register_endpoint}, then ${a.login_endpoint}. Nothing to enter.`
      : a?.mode === "credentials"
        ? target.access?.has_login
          ? `Each run signs in with ${a.login_endpoint} using your test login.`
          : `Each run signs in with ${a.login_endpoint}; no test login is saved yet, so runs will stop at sign-in.`
        : a?.mode === "token"
          ? target.access?.has_token
            ? `Your token is sent in the ${a.header_name} header.`
            : "This API needs a token and none is saved yet, so protected endpoints will fail."
          : undefined;
  const secondUser =
    a?.mode === "auto"
      ? { hint: "Each run also signs up user B, then checks that user B cannot read, change or delete user A's data." }
      : a?.mode === "credentials" && target.access
        ? {
            hint: target.access.has_second_login
              ? "Each run also signs in your second test login (user B) and checks that user B cannot read, change or delete user A's data."
              : "Needs a second test account (user B). Add it below.",
            extra: !target.access.has_second_login ? (
              <SecondLoginForm access={target.access} specId={target.api.spec_id} environmentId={target.environmentId} onSaved={accessSaved} />
            ) : undefined,
          }
        : undefined;
  const scopeCount = selected.size;
  const perEndpoint = { quick: 3, standard: 6, thorough: 12 }[config.depth];
  const useAi = config.use_ai && !aiOff;
  const estimate = useAi ? `About ${perEndpoint * scopeCount} AI cases${config.use_contract ? " plus schema cases" : ""}.` : config.use_contract ? "Schema cases only." : "No case source chosen.";

  return (
    <>
      <Breadcrumbs items={crumbs} />
      <Steps current={2} hrefs={stepHrefs} />
      <div className={styles.head}>
        <h1>{editing ? "Change what to test" : "What should the AI test?"}</h1>
        <p>Sections 1 to 6 shape the plan. The defaults are good; business rules make the biggest difference.</p>
      </div>

      <div className={`panel ${styles.target}`}>
        <div className={styles.targetMain}>
          <span className={styles.targetTitle}>{target.api.title}</span>
          <span className="muted small">
            {endpoints.length} {endpoints.length === 1 ? "endpoint" : "endpoints"}, tested on <span className="mono">{target.baseUrl}</span>
          </span>
        </div>
        {!editing && !fixedSpec && !(projectParam && specParam) ? (
          <button type="button" className="key key--plain" onClick={() => setStep(1)}>
            <Icon name="pencil" />
            Change
          </button>
        ) : (
          <Link href={`/p/${encodeURIComponent(target.projectId)}/environments`} className="key key--plain">
            <Icon name="pencil" />
            Edit server
          </Link>
        )}
      </div>

      {aiOff && (
        <p className="notice">
          <Icon name="alert" />
          <span>
            AI is off, so this plan will hold only schema cases. <Link href="/settings">Choose an AI provider in Settings</Link> to add AI-planned cases.
          </span>
        </p>
      )}

      <form className={styles.form} onSubmit={buildPlan} noValidate>
        <PlannerSections config={config} onChange={patch} endpoints={endpoints} showEndpoints aiEnabled={aiEnabled} authNote={authNote} secondUser={secondUser} />

        <div className={styles.bar}>
          <div className={styles.barInner}>
            <div className={`field ${styles.barName}`}>
              <label htmlFor={ids.name}>Plan name</label>
              <input id={ids.name} name="name" className="input" autoComplete="off" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <p className={`small ${error ? "helper is-error" : "muted"} ${styles.barNote}`} role={error ? "alert" : undefined}>
              {error ?? `${estimate} You review every case before anything runs.`}
            </p>
            <div className={styles.actions}>
              {!editing && !(projectParam && specParam) ? (
                <button type="button" className="key" disabled={busy} onClick={() => setStep(1)}>
                  Back
                </button>
              ) : (
                <button type="button" className="key" disabled={busy} onClick={() => router.back()}>
                  Back
                </button>
              )}
              <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
                {busy && <span className="spinner" aria-hidden="true" />}
                {busy ? "Starting" : editing ? "Build a new version" : "Build the plan"}
              </button>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}
