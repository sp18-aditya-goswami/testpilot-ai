"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EndpointLedger } from "@/app/_new-test/EndpointLedger";
import { Icon } from "@/components/Icon";
import { SourceTag } from "@/components/Source";
import { MethodPath } from "@/components/Status";
import type { Endpoint } from "@/lib/api";
import { DEFAULT_OBJECTIVES, OBJECTIVES, type BusinessRule, type Depth, type Environment, type Objective, type PlannerConfig } from "@/lib/workspace";
import styles from "./planner.module.css";

export const DEPTH: { id: Depth; label: string; perEndpoint: number }[] = [
  { id: "quick", label: "Quick", perEndpoint: 3 },
  { id: "standard", label: "Standard", perEndpoint: 6 },
  { id: "thorough", label: "Thorough", perEndpoint: 12 },
];

type Patch = (next: Partial<PlannerConfig>) => void;

function Section({
  id,
  num,
  title,
  help,
  actions,
  children,
}: {
  id: string;
  num: number;
  title: string;
  help: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel ${styles.section}`} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <span className={styles.num} aria-hidden="true">
          {num}
        </span>
        <div className={styles.sectionTitle}>
          <h2 id={id}>{title}</h2>
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

function RuleRow({
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
  const scopeLabel = scope.size === 0 ? "Every endpoint" : scope.size === 1 ? rule.endpoint_ids[0] : `${scope.size} endpoints`;
  const base = `rule-${index}`;

  return (
    <li className={styles.rule}>
      <div className="field">
        <label htmlFor={`${base}-text`}>Rule {index + 1}</label>
        <input
          id={`${base}-text`}
          name={`${base}_text`}
          className="input"
          autoComplete="off"
          maxLength={500}
          value={rule.text}
          placeholder="Email must be unique across users"
          onChange={(e) => onChange({ ...rule, text: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor={`${base}-status`}>A violation returns</label>
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
      </div>
      <div className="field">
        <span className="label" id={`${base}-scope`}>
          Applies to
        </span>
        <details className={styles.scope}>
          <summary className="input" aria-describedby={`${base}-scope`}>
            <span className={styles.scopeValue}>{scopeLabel}</span>
            <Icon name="chevron" size={12} />
          </summary>
          <div className={styles.scopePop}>
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
          </div>
        </details>
      </div>
      <button type="button" className={`key key--plain ${styles.ruleRemove}`} onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>
        <Icon name="trash" />
      </button>
    </li>
  );
}

/**
 * Everything that shapes a plan, as numbered sections: the endpoints (when given), the goal, objectives, depth,
 * business rules and case sources, then the optional auth, test data and exclusions.
 */
export function PlannerSections({
  config,
  onChange,
  endpoints,
  showEndpoints = false,
  environment = null,
  aiEnabled,
  authNote,
}: {
  config: PlannerConfig;
  onChange: Patch;
  endpoints: Endpoint[];
  /** Show the endpoint table as section 1; the workspace shows it beside the spec instead. */
  showEndpoints?: boolean;
  /** The environment whose variables can hold tokens; without one the token fields are hidden. */
  environment?: Environment | null;
  aiEnabled: boolean | null;
  /** How runs of this API sign in, when TestPilot knows. */
  authNote?: React.ReactNode;
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
  const selected = new Set(config.focus_endpoints.length ? config.focus_endpoints : endpoints.map((e) => e.id));
  const notes = Object.fromEntries(config.endpoint_notes.map((n) => [n.endpoint_id, n.note]));
  const setRule = (i: number, rule: BusinessRule) => onChange({ business_rules: config.business_rules.map((r, j) => (j === i ? rule : r)) });

  let n = 0;
  const next = () => ++n;

  return (
    <div className={styles.sections}>
      {showEndpoints && (
        <Section id="sec-endpoints" num={next()} title="Endpoints" help="Uncheck an endpoint to leave it out. Add a note to steer the AI on one endpoint.">
          <div className={styles.ledger}>
            <EndpointLedger
              endpoints={endpoints}
              selected={selected}
              onChange={(set) => onChange({ focus_endpoints: set.size === endpoints.length ? [] : endpoints.map((e) => e.id).filter((id) => set.has(id)) })}
              notes={notes}
              onNoteChange={(endpointId, note) => {
                const others = config.endpoint_notes.filter((x) => x.endpoint_id !== endpointId);
                onChange({ endpoint_notes: note ? [...others, { endpoint_id: endpointId, note }] : others });
              }}
            />
          </div>
          {selected.size === 0 && <p className="helper is-error">Choose at least one endpoint to test.</p>}
        </Section>
      )}

      <Section id="sec-instruction" num={next()} title="What to test" help="The goal of this plan in your own words. The AI starts here.">
        <div className="field">
          <label htmlFor="cfg-instruction" className="visually-hidden">
            Testing goal
          </label>
          <textarea
            id="cfg-instruction"
            name="instruction"
            className="input"
            rows={3}
            maxLength={4000}
            value={config.instruction}
            placeholder="Focus on registration and profile updates. Users must never see each other's data."
            onChange={(e) => onChange({ instruction: e.target.value })}
          />
        </div>
      </Section>

      <Section
        id="sec-objectives"
        num={next()}
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
                <input type="checkbox" name="objectives" value={o.id} checked={objectives.has(o.id)} disabled={aiOff} onChange={() => toggleObjective(o.id)} />
                <span className={styles.objectiveLabel}>
                  <span>{o.label}</span>
                  <span className={styles.objectiveHint}>{o.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {objectives.size === 0 && !aiOff && <p className="helper is-error">Pick at least one objective, or turn AI cases off in “Where cases come from”.</p>}
      </Section>

      <Section id="sec-depth" num={next()} title="Depth" help="How many AI cases to plan for each endpoint in scope.">
        <div className={styles.depth}>
          <div className="tray" role="group" aria-label="Depth">
            {DEPTH.map((d) => (
              <button key={d.id} type="button" aria-pressed={config.depth === d.id} disabled={aiOff} onClick={() => onChange({ depth: d.id })}>
                {d.label}
              </button>
            ))}
          </div>
          <p className={styles.depthNote}>
            About <b>{depth.perEndpoint}</b> AI cases per endpoint, roughly <b>{depth.perEndpoint * scopeCount}</b> for the {scopeCount}{" "}
            {scopeCount === 1 ? "endpoint" : "endpoints"} in scope.
          </p>
        </div>
      </Section>

      <Section
        id="sec-rules"
        num={next()}
        title="Business rules"
        help="What the schema cannot say. Each rule becomes cases that try to break it."
        actions={
          <button type="button" className="key" onClick={() => onChange({ business_rules: [...config.business_rules, { text: "", endpoint_ids: [], expected_status: [] }] })}>
            <Icon name="plus" />
            Add rule
          </button>
        }
      >
        {config.business_rules.length === 0 ? (
          <p className={styles.emptyRules}>No rules yet. Add one for anything the API must enforce, such as unique emails or a minimum password length.</p>
        ) : (
          <ol className={styles.rules}>
            {config.business_rules.map((rule, i) => (
              <RuleRow
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

      <Section id="sec-engines" num={next()} title="Where cases come from" help="Every case in the plan and the report is labelled with who made it.">
        <div className={styles.engines}>
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
              <SourceTag source="ai" /> AI cases, planned from the sections above
              <span className={styles.engineHint}>AI-generated. TestPilot validates each one before it can run.</span>
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
              <SourceTag source="ai" /> Review pass
              <span className={styles.engineHint}>The AI checks its own plan for gaps and wrong expectations before you see it.</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" name="use_contract" checked={config.use_contract} onChange={(e) => onChange({ use_contract: e.target.checked })} />
            <span>
              <SourceTag source="contract" /> Schema cases
              <span className={styles.engineHint}>System-generated from the OpenAPI spec: required fields, types, bounds, documented status codes.</span>
            </span>
          </label>
          {aiOff && (
            <p id="cfg-ai-off" className="helper">
              AI is off.{" "}
              <Link href="/settings" className={styles.settingsLink}>
                Choose an AI provider in Settings
              </Link>{" "}
              to add AI cases.
            </p>
          )}
        </div>
      </Section>

      <div className={styles.optional} role="separator" aria-label="Optional sections">
        <span>Optional</span>
      </div>

      <Section id="sec-auth" num={next()} title="Auth and roles" help="How the API authenticates, so the AI can test missing tokens and wrong roles.">
        {authNote && (
          <p className={styles.authNote}>
            <Icon name="key" />
            <span>{authNote}</span>
          </p>
        )}
        <div className={styles.twoCol}>
          <div className="field">
            <label htmlFor="cfg-auth-desc">How auth works</label>
            <textarea
              id="cfg-auth-desc"
              name="auth_description"
              className="input"
              rows={2}
              maxLength={1000}
              value={config.auth.description}
              placeholder="Admins can delete users; members can only edit themselves"
              onChange={(e) => onChange({ auth: { ...config.auth, description: e.target.value } })}
            />
          </div>
          <div className="field">
            <label htmlFor="cfg-auth-roles">Roles to test</label>
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
        </div>
        {environment && (
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
              <p className="helper">{varKeys.length ? `From ${environment.name}.` : "The current environment has no variables yet."}</p>
            </div>
          </div>
        )}
      </Section>

      <div className={styles.twoCol}>
        <Section id="sec-data" num={next()} title="Test data" help="Fixtures and sample values the AI may rely on.">
          <div className="field">
            <label htmlFor="cfg-data" className="visually-hidden">
              Test data
            </label>
            <textarea
              id="cfg-data"
              name="test_data"
              className="input"
              rows={3}
              maxLength={4000}
              value={config.test_data}
              placeholder="User 1 exists with email admin@example.com"
              onChange={(e) => onChange({ test_data: e.target.value })}
            />
          </div>
        </Section>
        <Section id="sec-exclusions" num={next()} title="Exclusions" help="Anything the AI must never send or test.">
          <div className="field">
            <label htmlFor="cfg-exclusions" className="visually-hidden">
              Exclusions
            </label>
            <textarea
              id="cfg-exclusions"
              name="exclusions"
              className="input"
              rows={3}
              maxLength={2000}
              value={config.exclusions}
              placeholder="Skip the /admin endpoints"
              onChange={(e) => onChange({ exclusions: e.target.value })}
            />
          </div>
        </Section>
      </div>
    </div>
  );
}
