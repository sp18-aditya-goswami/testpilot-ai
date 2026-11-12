"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Endpoint } from "@/lib/api";
import {
  DEFAULT_OBJECTIVES,
  OBJECTIVES,
  type BusinessRule,
  type Depth,
  type Environment,
  type Objective,
  type PlannerConfig,
} from "@/lib/workspace";
import { MethodPath } from "@/components/Status";
import { Icon } from "@/components/Icon";
import styles from "./suite.module.css";
import { SourceLegend, SourceTag } from "@/components/Source";

const DEPTH: { id: Depth; label: string; perEndpoint: number }[] = [
  { id: "quick", label: "Quick", perEndpoint: 3 },
  { id: "standard", label: "Standard", perEndpoint: 6 },
  { id: "thorough", label: "Thorough", perEndpoint: 12 },
];

type Patch = (next: Partial<PlannerConfig>) => void;

function Section({ id, title, help, actions, children }: { id: string; title: string; help: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`panel ${styles.section}`} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <div>
          <h3 id={id}>{title}</h3>
          <p className={styles.sectionHelp}>{help}</p>
        </div>
        {actions && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function parseStatuses(text: string): number[] {
  return Array.from(new Set((text.match(/\d{3}/g) ?? []).map(Number).filter((n) => n >= 100 && n <= 599)));
}

function RuleEditor({
  index,
  rule,
  endpoints,
  onChange,
  onRemove,
}: {
  index: number;
  rule: BusinessRule;
  endpoints: Endpoint[];
  onChange: (rule: BusinessRule) => void;
  onRemove: () => void;
}) {
  const [statusText, setStatusText] = useState(rule.expected_status.join(", "));
  useEffect(() => {
    setStatusText((current) => (parseStatuses(current).join() === rule.expected_status.join() ? current : rule.expected_status.join(", ")));
  }, [rule.expected_status]);

  const scope = new Set(rule.endpoint_ids);
  const scopeLabel = scope.size === 0 ? "All endpoints" : `${scope.size} of ${endpoints.length} endpoints`;
  const base = `rule-${index}`;

  return (
    <li className={styles.rule}>
      <div className={styles.ruleRow}>
        <div className="field">
          <label htmlFor={`${base}-text`}>Rule {index + 1}</label>
          <textarea
            id={`${base}-text`}
            name={`${base}_text`}
            className="input"
            rows={2}
            maxLength={500}
            value={rule.text}
            placeholder="Email must be unique across users"
            aria-invalid={rule.text.trim() ? undefined : true}
            aria-describedby={`${base}-help`}
            onChange={(e) => onChange({ ...rule, text: e.target.value })}
          />
          <p id={`${base}-help`} className={`helper${rule.text.trim() ? "" : " is-error"}`}>
            {rule.text.trim() ? "One rule, stated as the behaviour you expect." : "Write the rule, or remove it."}
          </p>
        </div>
        <div className="field">
          <label htmlFor={`${base}-status`}>Violation returns</label>
          <input
            id={`${base}-status`}
            name={`${base}_status`}
            className="input mono"
            inputMode="numeric"
            autoComplete="off"
            value={statusText}
            placeholder="409"
            onChange={(e) => {
              setStatusText(e.target.value);
              onChange({ ...rule, expected_status: parseStatuses(e.target.value) });
            }}
          />
          <p className="helper">Optional status codes.</p>
        </div>
      </div>
      <div className={styles.ruleFoot}>
        <details className={styles.scope}>
          <summary>Applies to: {scopeLabel}</summary>
          <ul className={styles.scopeList}>
            {endpoints.map((ep) => (
              <li key={ep.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={scope.has(ep.id)}
                    onChange={() => {
                      const next = new Set(scope);
                      if (next.has(ep.id)) next.delete(ep.id);
                      else next.add(ep.id);
                      onChange({ ...rule, endpoint_ids: endpoints.map((e) => e.id).filter((id) => next.has(id)) });
                    }}
                  />
                  <MethodPath id={ep.id} />
                </label>
              </li>
            ))}
          </ul>
          <p className="helper">Leave every box clear to apply the rule everywhere.</p>
        </details>
        <button type="button" className="key key--plain" onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>
          <Icon name="trash" />
          Remove
        </button>
      </div>
    </li>
  );
}

export function PlannerSections({
  config,
  onChange,
  endpoints,
  environment,
  aiEnabled,
}: {
  config: PlannerConfig;
  onChange: Patch;
  endpoints: Endpoint[];
  environment: Environment | null;
  aiEnabled: boolean | null;
}) {
  const [rolesText, setRolesText] = useState(config.auth.roles.join(", "));
  useEffect(() => {
    setRolesText((current) => {
      const parsed = current.split(",").map((r) => r.trim()).filter(Boolean);
      return parsed.join() === config.auth.roles.join() ? current : config.auth.roles.join(", ");
    });
  }, [config.auth.roles]);

  const objectives = new Set(config.objectives);
  const toggleObjective = (id: Objective) => {
    const next = new Set(objectives);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange({ objectives: OBJECTIVES.map((o) => o.id).filter((o) => next.has(o)) });
  };
  const depth = DEPTH.find((d) => d.id === config.depth) ?? DEPTH[1];
  const scopeCount = config.focus_endpoints.length || endpoints.length;
  const varKeys = environment?.variables.map((v) => v.key) ?? [];
  const aiOff = aiEnabled === false;

  const setRule = (i: number, rule: BusinessRule) => onChange({ business_rules: config.business_rules.map((r, j) => (j === i ? rule : r)) });

  return (
    <div className={styles.sections}>
      <Section id="sec-instruction" title="What to test" help="The goal of this suite in your own words. The AI planner starts here.">
        <div className="field">
          <label htmlFor="cfg-instruction">Testing instruction</label>
          <textarea
            id="cfg-instruction"
            name="instruction"
            className="input"
            rows={4}
            maxLength={4000}
            value={config.instruction}
            placeholder="Test registration and profile updates: duplicate emails, weak passwords, users editing each other"
            onChange={(e) => onChange({ instruction: e.target.value })}
          />
          <p className="helper">Used by the AI planner. The contract engine ignores it.</p>
        </div>
      </Section>

      <Section
        id="sec-objectives"
        title="Objectives"
        help="The kinds of risk the AI should spend its cases on."
        actions={
          <>
            <button type="button" className="key key--plain" onClick={() => onChange({ objectives: OBJECTIVES.map((o) => o.id) })}>
              Select all
            </button>
            <button type="button" className="key key--plain" onClick={() => onChange({ objectives: [...DEFAULT_OBJECTIVES] })}>
              Defaults
            </button>
          </>
        }
      >
        <ul className={styles.objectives}>
          {OBJECTIVES.map((o) => (
            <li key={o.id}>
              <label className="check">
                <input type="checkbox" name="objectives" value={o.id} checked={objectives.has(o.id)} onChange={() => toggleObjective(o.id)} />
                <span className={styles.objectiveLabel}>
                  <span>{o.label}</span>
                  <span className={styles.objectiveHint}>{o.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {objectives.size === 0 && <p className="helper is-error">Pick at least one objective, or turn AI scenarios off below.</p>}
      </Section>

      <Section id="sec-depth" title="Depth" help="How many AI scenarios to plan for each endpoint in scope.">
        <div className="tray" role="group" aria-label="Depth">
          {DEPTH.map((d) => (
            <button key={d.id} type="button" aria-pressed={config.depth === d.id} onClick={() => onChange({ depth: d.id })}>
              {d.label}
            </button>
          ))}
        </div>
        <p className={styles.depthNote}>
          About <b>{depth.perEndpoint}</b> AI scenarios per endpoint, roughly <b>{depth.perEndpoint * scopeCount}</b> for the{" "}
          {scopeCount} {scopeCount === 1 ? "endpoint" : "endpoints"} in scope.
        </p>
      </Section>

      <Section
        id="sec-rules"
        title="Business rules"
        help="Rules the schema cannot express. Each one becomes targeted scenarios."
        actions={
          <button
            type="button"
            className="key"
            onClick={() => onChange({ business_rules: [...config.business_rules, { text: "", endpoint_ids: [], expected_status: [] }] })}
          >
            <Icon name="plus" />
            Add rule
          </button>
        }
      >
        {config.business_rules.length === 0 ? (
          <p className={styles.emptyRules}>No rules yet. Add one for anything the API must enforce, such as unique emails or minimum password length.</p>
        ) : (
          <ol className={styles.rules}>
            {config.business_rules.map((rule, i) => (
              <RuleEditor
                key={i}
                index={i}
                rule={rule}
                endpoints={endpoints}
                onChange={(r) => setRule(i, r)}
                onRemove={() => onChange({ business_rules: config.business_rules.filter((_, j) => j !== i) })}
              />
            ))}
          </ol>
        )}
      </Section>

      <Section id="sec-auth" title="Auth and roles" help="How the API authenticates, so the planner can test missing tokens and wrong roles.">
        <div className="field">
          <label htmlFor="cfg-auth-desc">How auth works</label>
          <textarea
            id="cfg-auth-desc"
            name="auth_description"
            className="input"
            rows={2}
            maxLength={1000}
            value={config.auth.description}
            placeholder="Bearer token. Admins can delete users; members can only edit themselves"
            onChange={(e) => onChange({ auth: { ...config.auth, description: e.target.value } })}
          />
          <p className="helper">Leave empty if the API has no auth.</p>
        </div>
        <div className={styles.twoCol}>
          <div className="field">
            <label htmlFor="cfg-auth-header">Header name</label>
            <input
              id="cfg-auth-header"
              name="auth_header"
              className="input mono"
              autoComplete="off"
              value={config.auth.header_name}
              placeholder="Authorization"
              onChange={(e) => onChange({ auth: { ...config.auth, header_name: e.target.value } })}
            />
            <p className="helper">Where the token goes on each request.</p>
          </div>
          <div className="field">
            <label htmlFor="cfg-auth-var">Token variable</label>
            <select
              id="cfg-auth-var"
              name="auth_token_variable"
              className="input"
              value={config.auth.token_variable ?? ""}
              onChange={(e) => onChange({ auth: { ...config.auth, token_variable: e.target.value || null } })}
            >
              <option value="">None</option>
              {config.auth.token_variable && !varKeys.includes(config.auth.token_variable) && (
                <option value={config.auth.token_variable}>{config.auth.token_variable} (not in this environment)</option>
              )}
              {varKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <p className="helper">
              {varKeys.length ? `From ${environment?.name ?? "the environment"}.` : "The current environment has no variables yet."}
            </p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="cfg-auth-roles">Roles</label>
          <input
            id="cfg-auth-roles"
            name="auth_roles"
            className="input"
            autoComplete="off"
            value={rolesText}
            placeholder="admin, member, guest"
            onChange={(e) => {
              setRolesText(e.target.value);
              onChange({ auth: { ...config.auth, roles: e.target.value.split(",").map((r) => r.trim()).filter(Boolean) } });
            }}
          />
          <p className="helper">Comma separated. For role tests, add &lt;role&gt;_token variables to the environment.</p>
        </div>
      </Section>

      <div className={styles.twoCol}>
        <Section id="sec-data" title="Test data" help="Fixtures and sample values the planner may rely on.">
          <div className="field">
            <label htmlFor="cfg-data" className="visually-hidden">
              Test data
            </label>
            <textarea
              id="cfg-data"
              name="test_data"
              className="input"
              rows={4}
              maxLength={4000}
              value={config.test_data}
              placeholder={"User 1 exists with email admin@example.com\nProduct ids run from 100 to 120"}
              onChange={(e) => onChange({ test_data: e.target.value })}
            />
            <p className="helper">Optional.</p>
          </div>
        </Section>
        <Section id="sec-exclusions" title="Exclusions" help="Anything the planner must never send or test.">
          <div className="field">
            <label htmlFor="cfg-exclusions" className="visually-hidden">
              Exclusions
            </label>
            <textarea
              id="cfg-exclusions"
              name="exclusions"
              className="input"
              rows={4}
              maxLength={2000}
              value={config.exclusions}
              placeholder={"Never send real card numbers\nSkip the /admin endpoints"}
              onChange={(e) => onChange({ exclusions: e.target.value })}
            />
            <p className="helper">Optional.</p>
          </div>
        </Section>
      </div>

      <Section id="sec-engines" title="Engines" help="Which sources of test cases go into the plan.">
        <div className={styles.engines}>
          <label className="check">
            <input type="checkbox" name="use_contract" checked={config.use_contract} onChange={(e) => onChange({ use_contract: e.target.checked })} />
            <span>
              Contract cases <SourceTag source="contract" />
              <span className={styles.engineHint}>System-generated. Derived from the schema: types, required fields, bounds, unknown ids.</span>
            </span>
          </label>
          <label className={`check${aiOff ? ` ${styles.checkDisabled}` : ""}`}>
            <input
              type="checkbox"
              name="use_ai"
              checked={config.use_ai && !aiOff}
              disabled={aiOff}
              aria-describedby={aiOff ? "cfg-ai-off" : undefined}
              onChange={(e) => onChange({ use_ai: e.target.checked })}
            />
            <span>
              AI scenarios <SourceTag source="ai" />
              <span className={styles.engineHint}>AI-generated. Claude plans business-aware cases from everything above, and TestPilot validates each one.</span>
            </span>
          </label>
          <label className={`check${aiOff || !config.use_ai ? ` ${styles.checkDisabled}` : ""}`}>
            <input
              type="checkbox"
              name="review_pass"
              checked={config.review_pass && config.use_ai && !aiOff}
              disabled={aiOff || !config.use_ai}
              onChange={(e) => onChange({ review_pass: e.target.checked })}
            />
            <span>
              Review pass
              <span className={styles.engineHint}>Claude checks its own plan for gaps and wrong expectations before you see it.</span>
            </span>
          </label>
          {aiOff && (
            <p id="cfg-ai-off" className="helper">
              AI is off: no API key or CLI login is set up yet.{" "}
              <Link href="/settings" className={styles.settingsLink}>
                Set up AI in settings
              </Link>
              .
            </p>
          )}
        </div>
        <div className={styles.legend}>
          <p className="small">Every case in the plan and in the run report carries one of these labels, so you can always tell who wrote it.</p>
          <SourceLegend />
        </div>
      </Section>
    </div>
  );
}
