"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Icon } from "@/components/Icon";
import { MethodPath } from "@/components/Status";
import { Steps } from "@/components/Steps";
import { api, errorMessage, type ApiSummary } from "@/lib/api";
import { flowHref, testPlans } from "@/lib/testplans";
import { DEFAULT_PLANNER_CONFIG, OBJECTIVES, ws, type BusinessRule, type Depth, type Item, type Objective, type PlannerConfig } from "@/lib/workspace";
import styles from "./new-plan.module.css";

const TOKEN_VARIABLE = "token";

const DEPTH: { id: Depth; label: string; hint: string }[] = [
  { id: "quick", label: "Quick", hint: "about 3 AI cases per endpoint" },
  { id: "standard", label: "Standard", hint: "about 6 AI cases per endpoint" },
  { id: "thorough", label: "Thorough", hint: "about 12 AI cases per endpoint" },
];

/** What step 1 settled: the API under test and where it runs. */
interface Target {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  baseUrl: string;
  hasToken: boolean;
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

/** One rule per line. A three-digit code in the line is what a violation must return; scoping set elsewhere is kept. */
function rulesFromText(text: string, previous: BusinessRule[]): BusinessRule[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const kept = previous.find((r) => r.text === line);
      if (kept) return kept;
      const codes = Array.from(new Set((line.match(/\b[1-5]\d\d\b/g) ?? []).map(Number)));
      return { text: line.slice(0, 500), endpoint_ids: [], expected_status: codes };
    });
}

export function NewPlanFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const suiteParam = params.get("suite");
  const projectParam = params.get("project");
  const specParam = params.get("spec");
  const ids = { spec: useId(), paste: useId(), base: useId(), token: useId(), name: useId(), rules: useId(), instruction: useId(), data: useId(), exclusions: useId(), auth: useId() };

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
  const [token, setToken] = useState("");
  const [fixedSpec, setFixedSpec] = useState<{ projectId: string; projectName: string; api: ApiSummary } | null>(null);

  // step 2
  const [target, setTarget] = useState<Target | null>(null);
  const [suite, setSuite] = useState<Item | null>(null);
  const [config, setConfig] = useState<PlannerConfig>(DEFAULT_PLANNER_CONFIG);
  const [rulesText, setRulesText] = useState("");
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
          if (cancelled) return;
          const cfg = { ...DEFAULT_PLANNER_CONFIG, ...item.suite.config };
          setSuite(item);
          setConfig(cfg);
          setRulesText(cfg.business_rules.map((r) => r.text).join("\n"));
          setName(item.name);
          setTarget({
            projectId: item.project_id,
            projectName: tree.project.name,
            environmentId: env.id,
            environmentName: env.name,
            baseUrl: env.base_url,
            hasToken: env.variables.some((v) => v.key === TOKEN_VARIABLE && v.has_value),
            api: spec,
          });
        } else if (projectParam && specParam) {
          const [tree, spec] = await Promise.all([ws.tree(projectParam), api.spec(specParam)]);
          if (cancelled) return;
          const env = tree.environments.find((e) => e.is_default) ?? tree.environments[0];
          setName(`${spec.title} test plan`);
          if (env) {
            setTarget({
              projectId: projectParam,
              projectName: tree.project.name,
              environmentId: env.id,
              environmentName: env.name,
              baseUrl: env.base_url,
              hasToken: env.variables.some((v) => v.key === TOKEN_VARIABLE && v.has_value),
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
      if (fixedSpec) {
        const env = await ws.createEnvironment(fixedSpec.projectId, {
          name: "Default",
          base_url: server,
          is_default: true,
          variables: token.trim() ? [{ key: TOKEN_VARIABLE, value: token.trim(), secret: true }] : [],
        });
        setTarget({ projectId: fixedSpec.projectId, projectName: fixedSpec.projectName, environmentId: env.id, environmentName: env.name, baseUrl: env.base_url, hasToken: !!token.trim(), api: fixedSpec.api });
      } else {
        const out = await testPlans.start({
          ...(source === "link" ? { spec_url: specUrl.trim() } : { spec_text: specText }),
          base_url: server,
          token: token.trim() || undefined,
        });
        setTarget({ projectId: out.project_id, projectName: out.project_name, environmentId: out.environment_id, environmentName: out.environment_name, baseUrl: server.replace(/\/+$/, ""), hasToken: out.has_token, api: out.api });
        if (!name) setName(`${out.api.title} test plan`);
      }
      setToken("");
      setStep(2);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function buildPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    const useAi = config.use_ai && !aiOff;
    if (!useAi && !config.use_contract) return setError("Turn on at least one source of test cases under More options.");
    if (useAi && config.objectives.length === 0) return setError("Pick at least one thing for the AI to focus on.");
    if (selected.size === 0) return setError("Choose at least one endpoint to test under More options.");
    const finalConfig: PlannerConfig = {
      ...config,
      use_ai: useAi,
      business_rules: rulesFromText(rulesText, config.business_rules),
      auth: target.hasToken && !config.auth.token_variable ? { ...config.auth, token_variable: TOKEN_VARIABLE } : config.auth,
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

  const toggleObjective = (id: Objective) => {
    const next = new Set(config.objectives);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({ objectives: OBJECTIVES.map((o) => o.id).filter((o) => next.has(o)) });
  };
  const toggleEndpoint = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    patch({ focus_endpoints: next.size === endpoints.length ? [] : endpoints.map((e) => e.id).filter((x) => next.has(x)) });
  };

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
            <div className="field">
              <label htmlFor={ids.token}>Auth token (optional)</label>
              <input id={ids.token} name="token" className="input mono" type="password" autoComplete="off" placeholder="Leave empty if the API needs no login" value={token} onChange={(e) => setToken(e.target.value)} />
              <p className="helper">Sent as a Bearer token. Stored as a secret and never shown again or saved in reports.</p>
            </div>
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

  return (
    <>
      <Breadcrumbs items={crumbs} />
      <Steps current={2} hrefs={stepHrefs} />
      <div className={styles.head}>
        <h1>{editing ? "Change what to test" : "What should the AI focus on?"}</h1>
        <p>The defaults are good. Business rules make the biggest difference: they are what the schema cannot say.</p>
      </div>

      <div className={`panel ${styles.target}`}>
        <div className={styles.targetMain}>
          <span className={styles.targetTitle}>{target.api.title}</span>
          <span className="muted small">
            {endpoints.length} {endpoints.length === 1 ? "endpoint" : "endpoints"}, tested on <span className="mono">{target.baseUrl}</span>
            {target.hasToken ? " with your token" : ""}
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
        <section className={`panel ${styles.card}`} aria-labelledby="focus-title">
          <div className={styles.blockHead}>
            <h2 id="focus-title" className={styles.cardTitle}>
              Focus
            </h2>
            <button type="button" className="key key--plain" onClick={() => patch({ objectives: OBJECTIVES.map((o) => o.id) })}>
              Select all
            </button>
          </div>
          <ul className={styles.chips} aria-label="What the AI should test">
            {OBJECTIVES.map((o) => (
              <li key={o.id}>
                <button type="button" className={styles.chip} aria-pressed={config.objectives.includes(o.id)} title={o.hint} onClick={() => toggleObjective(o.id)} disabled={aiOff}>
                  {config.objectives.includes(o.id) && <Icon name="check" size={12} />}
                  {o.label}
                </button>
              </li>
            ))}
          </ul>

          <div className={styles.depth}>
            <span className="label" id="depth-label">
              Depth
            </span>
            <div className="tray" role="group" aria-labelledby="depth-label">
              {DEPTH.map((d) => (
                <button key={d.id} type="button" aria-pressed={config.depth === d.id} onClick={() => patch({ depth: d.id })} disabled={aiOff}>
                  {d.label}
                </button>
              ))}
            </div>
            <span className="muted small">{DEPTH.find((d) => d.id === config.depth)?.hint}</span>
          </div>
        </section>

        <section className={`panel ${styles.card}`} aria-labelledby="rules-title">
          <h2 id="rules-title" className={styles.cardTitle}>
            Business rules
          </h2>
          <div className="field">
            <label htmlFor={ids.rules}>One rule per line. Put the status a violation must return in the line if you know it.</label>
            <textarea
              id={ids.rules}
              name="business_rules"
              className="input"
              rows={4}
              placeholder={"Email must be unique, a duplicate returns 409\nPassword needs at least 8 characters, otherwise 422"}
              value={rulesText}
              onChange={(e) => setRulesText(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.instruction}>Anything else the AI should know (optional)</label>
            <textarea
              id={ids.instruction}
              name="instruction"
              className="input"
              rows={2}
              maxLength={4000}
              placeholder="Focus on registration and profile updates"
              value={config.instruction}
              onChange={(e) => patch({ instruction: e.target.value })}
            />
          </div>
        </section>

        <details className={`panel ${styles.more}`}>
          <summary>
            <span>More options</span>
            <span className="muted small">endpoints, auth, test data, exclusions, case sources</span>
          </summary>
          <div className={styles.moreBody}>
            <fieldset className={styles.fieldset}>
              <legend className="label">
                Endpoints to test ({selected.size} of {endpoints.length})
              </legend>
              <ul className={styles.endpoints}>
                {endpoints.map((ep) => (
                  <li key={ep.id}>
                    <label className="check">
                      <input type="checkbox" name="focus_endpoints" value={ep.id} checked={selected.has(ep.id)} onChange={() => toggleEndpoint(ep.id)} />
                      <span className={styles.endpointLabel}>
                        <MethodPath id={ep.id} />
                        {ep.summary && <span className="muted small">{ep.summary}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>

            <div className="field">
              <label htmlFor={ids.auth}>How auth works (optional)</label>
              <textarea
                id={ids.auth}
                name="auth_description"
                className="input"
                rows={2}
                maxLength={1000}
                placeholder="Bearer token. Admins can delete users; members can only edit themselves"
                value={config.auth.description}
                onChange={(e) => patch({ auth: { ...config.auth, description: e.target.value } })}
              />
            </div>
            <div className={styles.twoCol}>
              <div className="field">
                <label htmlFor={ids.data}>Known test data (optional)</label>
                <textarea id={ids.data} name="test_data" className="input" rows={3} maxLength={4000} placeholder="User 1 exists with email admin@example.com" value={config.test_data} onChange={(e) => patch({ test_data: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={ids.exclusions}>Never send or test (optional)</label>
                <textarea id={ids.exclusions} name="exclusions" className="input" rows={3} maxLength={2000} placeholder="Skip the /admin endpoints" value={config.exclusions} onChange={(e) => patch({ exclusions: e.target.value })} />
              </div>
            </div>

            <fieldset className={styles.fieldset}>
              <legend className="label">Where cases come from</legend>
              <label className="check">
                <input type="checkbox" name="use_ai" checked={config.use_ai && !aiOff} disabled={aiOff} onChange={(e) => patch({ use_ai: e.target.checked })} />
                <span>AI cases, planned from your focus and rules</span>
              </label>
              <label className="check">
                <input type="checkbox" name="review_pass" checked={config.review_pass && config.use_ai && !aiOff} disabled={aiOff || !config.use_ai} onChange={(e) => patch({ review_pass: e.target.checked })} />
                <span>AI reviews its own plan before you see it</span>
              </label>
              <label className="check">
                <input type="checkbox" name="use_contract" checked={config.use_contract} onChange={(e) => patch({ use_contract: e.target.checked })} />
                <span>Schema cases, derived from the spec by TestPilot</span>
              </label>
            </fieldset>
          </div>
        </details>

        <div className={`panel ${styles.card} ${styles.finish}`}>
          <div className="field">
            <label htmlFor={ids.name}>Plan name</label>
            <input id={ids.name} name="name" className="input" autoComplete="off" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <p className={`helper ${error ? "is-error" : ""}`} role={error ? "alert" : undefined}>
            {error ?? ""}
          </p>
          <div className={styles.actions}>
            <button type="submit" className="key key--primary" disabled={busy} aria-busy={busy}>
              {busy && <span className="spinner" aria-hidden="true" />}
              {busy ? "Starting" : editing ? "Build a new version of the plan" : "Build the plan"}
            </button>
            {!editing && !(projectParam && specParam) ? (
              <button type="button" className="key" disabled={busy} onClick={() => setStep(1)}>
                Back
              </button>
            ) : (
              <button type="button" className="key" disabled={busy} onClick={() => router.back()}>
                Back
              </button>
            )}
            <span className="muted small">Takes a minute or two. You review every case before anything runs.</span>
          </div>
        </div>
      </form>
    </>
  );
}
