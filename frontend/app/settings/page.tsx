"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Icon } from "@/components/Icon";
import { errorMessage } from "@/lib/api";
import { ws, type AiProvider, type BedrockAuth, type Effort, type Settings, type SettingsPatch } from "@/lib/workspace";
import styles from "./settings.module.css";

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low, fastest" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max, slowest" },
];

function Saved({ text }: { text: string | null }) {
  return (
    <p className="helper" role="status" aria-live="polite">
      {text}
    </p>
  );
}

const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: "anthropic", label: "Anthropic API" },
  { id: "openai", label: "OpenAI" },
  { id: "bedrock", label: "AWS Bedrock" },
];
const PROVIDER_NAME: Record<AiProvider, string> = { anthropic: "Anthropic API", openai: "OpenAI", bedrock: "AWS Bedrock" };
const AWS_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1"];

type Busy = "provider" | "save" | "remove" | "effort" | "check" | null;

function SecretField({
  id,
  name,
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  hint: string | null;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        className="input mono"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={hint ? `Stored, ${hint}. Type to replace` : placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function AiSection({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const ai = settings.ai;
  const ids = {
    providers: useId(),
    key: useId(),
    model: useId(),
    region: useId(),
    regions: useId(),
    bedrockAuth: useId(),
    profile: useId(),
    accessKey: useId(),
    secret: useId(),
    session: useId(),
    bedrockKey: useId(),
    effort: useId(),
  };
  const [secrets, setSecrets] = useState({ anthropic: "", openai: "", accessKey: "", secret: "", session: "", bedrockKey: "" });
  const [anthropicModel, setAnthropicModel] = useState(ai.anthropic.model);
  const [openaiModel, setOpenaiModel] = useState(ai.openai.model);
  const [bedrockModel, setBedrockModel] = useState(ai.bedrock.model);
  const [region, setRegion] = useState(ai.bedrock.region ?? "");
  const [profile, setProfile] = useState(ai.bedrock.profile ?? "");
  const [bedrockAuth, setBedrockAuth] = useState<BedrockAuth>(ai.bedrock.auth);
  const [effort, setEffort] = useState<Effort>(ai.effort);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);

  const run = async (kind: NonNullable<Busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setSaved(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const apply = (next: Settings, message: string) => {
    onChange(next);
    setSecrets({ anthropic: "", openai: "", accessKey: "", secret: "", session: "", bedrockKey: "" });
    setCheck(null);
    setSaved(message);
  };

  const provider = ai.provider;
  const status = ai.configured
    ? `Using ${PROVIDER_NAME[provider]}, ${ai.model}`
    : `${PROVIDER_NAME[provider]} is not set up yet, so AI planning and explanations are off`;

  const saveProvider = () => {
    const patch: SettingsPatch = {};
    if (provider === "anthropic") {
      patch.anthropic_model = anthropicModel.trim();
      if (secrets.anthropic.trim()) patch.anthropic_api_key = secrets.anthropic.trim();
    } else if (provider === "openai") {
      patch.openai_model = openaiModel.trim();
      if (secrets.openai.trim()) patch.openai_api_key = secrets.openai.trim();
    } else {
      patch.aws_region = region.trim();
      patch.bedrock_auth = bedrockAuth;
      patch.bedrock_model = bedrockModel.trim();
      patch.aws_profile = profile.trim();
      if (secrets.accessKey.trim()) patch.aws_access_key_id = secrets.accessKey.trim();
      if (secrets.secret.trim()) patch.aws_secret_access_key = secrets.secret.trim();
      if (secrets.session.trim()) patch.aws_session_token = secrets.session.trim();
      if (secrets.bedrockKey.trim()) patch.bedrock_api_key = secrets.bedrockKey.trim();
    }
    void run("save", async () => apply(await ws.updateSettings(patch), `${PROVIDER_NAME[provider]} settings saved.`));
  };

  const removeSecrets = () => {
    const patch: SettingsPatch =
      provider === "anthropic"
        ? { anthropic_api_key: "" }
        : provider === "openai"
          ? { openai_api_key: "" }
          : { aws_access_key_id: "", aws_secret_access_key: "", aws_session_token: "", bedrock_api_key: "" };
    void run("remove", async () => apply(await ws.updateSettings(patch), "Stored credentials removed."));
  };

  const keyed = provider === "anthropic" ? ai.anthropic : provider === "openai" ? ai.openai : null;
  const storedSecrets = keyed ? keyed.key_source === "app" : Boolean(ai.bedrock.access_key_hint || ai.bedrock.has_secret_key || ai.bedrock.api_key_hint);

  return (
    <section className={`panel ${styles.section}`} aria-labelledby="ai-head">
      <div className={styles.sectionHead}>
        <h2 id="ai-head">AI provider</h2>
        <p className={ai.configured ? "status status--passed" : "status status--skipped"}>
          <Icon name={ai.configured ? "check" : "minus"} />
          {status}
        </p>
      </div>
      <p className="small">
        Claude or OpenAI plans test cases and explains failures. Credentials stay on the TestPilot server in a file only its owner can read, and are never
        sent back to the browser.
      </p>

      <div className="field">
        <span className="label" id={ids.providers}>
          Provider
        </span>
        <div className="tray" role="group" aria-labelledby={ids.providers}>
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={provider === p.id}
              disabled={busy !== null}
              onClick={() =>
                provider !== p.id &&
                run("provider", async () => apply(await ws.updateSettings({ ai_provider: p.id }), `${PROVIDER_NAME[p.id]} is now the AI provider.`))
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <form
        className={styles.providerBlock}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          saveProvider();
        }}
      >
        {keyed && (
          <>
            <SecretField
              id={ids.key}
              name={provider === "anthropic" ? "anthropic-key" : "openai-key"}
              label={provider === "anthropic" ? "Anthropic API key" : "OpenAI API key"}
              hint={keyed.key_hint}
              placeholder={provider === "anthropic" ? "sk-ant-…" : "sk-…"}
              value={provider === "anthropic" ? secrets.anthropic : secrets.openai}
              onChange={(v) => setSecrets((s) => (provider === "anthropic" ? { ...s, anthropic: v } : { ...s, openai: v }))}
            />
            {keyed.key_source === "env" && <p className="helper">The current key comes from the .env file. A key saved here takes precedence.</p>}
            <div className="field">
              <label htmlFor={ids.model}>Model</label>
              <input
                id={ids.model}
                className="input mono"
                autoComplete="off"
                spellCheck={false}
                value={provider === "anthropic" ? anthropicModel : openaiModel}
                onChange={(e) => (provider === "anthropic" ? setAnthropicModel(e.target.value) : setOpenaiModel(e.target.value))}
              />
              <p className="helper">
                {provider === "anthropic"
                  ? "Default claude-opus-5-5."
                  : "Default gpt-5.1. Any model your key can use with structured outputs works; responses are not stored by OpenAI."}
              </p>
            </div>
          </>
        )}

        {provider === "bedrock" && (
          <>
            <p className="small">
              Runs Claude through Amazon Bedrock, billed to your AWS account and credits. Enable the Claude model in the Bedrock console for the region first.
            </p>
            <div className={styles.grid}>
              <div className="field">
                <label htmlFor={ids.region}>AWS region</label>
                <input
                  id={ids.region}
                  className="input mono"
                  list={ids.regions}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="us-east-1"
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
                <datalist id={ids.regions}>
                  {AWS_REGIONS.map((r) => (
                    <option key={r} value={r} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor={ids.model}>Model or inference profile</label>
                <input id={ids.model} className="input mono" autoComplete="off" spellCheck={false} value={bedrockModel} onChange={(e) => setBedrockModel(e.target.value)} />
                <p className="helper">Default anthropic.claude-opus-5-5. Use the id your Bedrock console shows.</p>
              </div>
            </div>

            <div className="field">
              <span className="label" id={ids.bedrockAuth}>
                Sign in with
              </span>
              <div className="tray" role="group" aria-labelledby={ids.bedrockAuth}>
                <button type="button" aria-pressed={bedrockAuth === "default"} onClick={() => setBedrockAuth("default")}>
                  AWS credentials on this machine
                </button>
                <button type="button" aria-pressed={bedrockAuth === "keys"} onClick={() => setBedrockAuth("keys")}>
                  Access key
                </button>
                <button type="button" aria-pressed={bedrockAuth === "api_key"} onClick={() => setBedrockAuth("api_key")}>
                  Bedrock API key
                </button>
              </div>
            </div>

            {bedrockAuth === "default" && (
              <div className="field">
                <label htmlFor={ids.profile}>AWS profile (optional)</label>
                <input id={ids.profile} className="input mono" autoComplete="off" spellCheck={false} placeholder="default" value={profile} onChange={(e) => setProfile(e.target.value)} />
                <p className="helper">
                  {ai.bedrock.default_credentials_found
                    ? "AWS credentials found on the backend machine (aws configure, SSO or environment variables)."
                    : "No AWS credentials found on the backend machine yet. Run aws configure or aws sso login there, or use an access key."}
                </p>
              </div>
            )}
            {bedrockAuth === "keys" && (
              <div className={styles.grid}>
                <SecretField id={ids.accessKey} name="aws-access-key-id" label="Access key id" hint={ai.bedrock.access_key_hint} placeholder="AKIA…" value={secrets.accessKey} onChange={(v) => setSecrets((s) => ({ ...s, accessKey: v }))} />
                <SecretField id={ids.secret} name="aws-secret-access-key" label="Secret access key" hint={ai.bedrock.has_secret_key ? "hidden" : null} placeholder="Secret access key" value={secrets.secret} onChange={(v) => setSecrets((s) => ({ ...s, secret: v }))} />
                <div className={styles.gridAction}>
                  <SecretField id={ids.session} name="aws-session-token" label="Session token (temporary credentials only)" hint={ai.bedrock.has_session_token ? "hidden" : null} placeholder="Optional" value={secrets.session} onChange={(v) => setSecrets((s) => ({ ...s, session: v }))} />
                </div>
              </div>
            )}
            {bedrockAuth === "api_key" && (
              <SecretField id={ids.bedrockKey} name="bedrock-api-key" label="Bedrock API key" hint={ai.bedrock.api_key_hint} placeholder="Bedrock API key" value={secrets.bedrockKey} onChange={(v) => setSecrets((s) => ({ ...s, bedrockKey: v }))} />
            )}
          </>
        )}

        <div className={styles.buttons}>
          <button type="submit" className="key key--primary" disabled={busy !== null} aria-busy={busy === "save"}>
            {busy === "save" && <span className="spinner" aria-hidden="true" />}
            Save {PROVIDER_NAME[provider]} settings
          </button>
          {storedSecrets && (
            <button type="button" className="key" disabled={busy !== null} aria-busy={busy === "remove"} onClick={removeSecrets}>
              {busy === "remove" && <span className="spinner" aria-hidden="true" />}
              Remove stored credentials
            </button>
          )}
        </div>
      </form>

      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          void run("effort", async () => apply(await ws.updateSettings({ effort }), "Effort saved."));
        }}
      >
        <div className="field">
          <label htmlFor={ids.effort}>Effort</label>
          <select id={ids.effort} className="input" value={effort} onChange={(e) => setEffort(e.target.value as Effort)}>
            {EFFORTS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
          <p className="helper">Higher effort plans more carefully and takes longer. OpenAI uses high for the top three levels.</p>
        </div>
        <button type="submit" className="key" disabled={busy !== null} aria-busy={busy === "effort"}>
          {busy === "effort" && <span className="spinner" aria-hidden="true" />}
          Save effort
        </button>
      </form>

      <div className={styles.buttons}>
        <button
          type="button"
          className="key"
          disabled={busy !== null || !ai.configured}
          title={ai.configured ? undefined : "Save the provider settings first"}
          aria-busy={busy === "check"}
          onClick={() => run("check", async () => setCheck(await ws.checkAi()))}
        >
          {busy === "check" && <span className="spinner" aria-hidden="true" />}
          Check connection
        </button>
        {provider === "bedrock" && <p className="helper">Bedrock has no free check, so this sends one tiny request.</p>}
      </div>
      {check && (
        <p className={check.ok ? "status status--passed" : "status status--failed"} role="status">
          <Icon name={check.ok ? "check" : "cross"} />
          {check.message}
        </p>
      )}
      {error && (
        <p className="helper is-error" role="alert">
          {error}
        </p>
      )}
      <Saved text={saved} />
    </section>
  );
}

function HostsSection({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const id = useId();
  const [hosts, setHosts] = useState<string[]>(settings.allowed_hosts);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = hosts.join(",") !== settings.allowed_hosts.join(",");

  const add = () => {
    const h = draft.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
    if (!h) return;
    if (!/^[a-z0-9.-]+$/.test(h)) {
      setError("Enter a host name only, such as staging.internal or 127.0.0.1.");
      return;
    }
    if (hosts.includes(h)) {
      setError(`${h} is already allowed.`);
      return;
    }
    setHosts([...hosts, h]);
    setDraft("");
    setError(null);
  };

  return (
    <section className={`panel ${styles.section}`} aria-labelledby="hosts-head">
      <div className={styles.sectionHead}>
        <h2 id="hosts-head">Allowed hosts</h2>
      </div>
      <p className={`small ${styles.caution}`}>
        <Icon name="alert" />
        <span>TestPilot only sends requests to these hosts. Add local or staging servers only, never production.</span>
      </p>
      <ul className={styles.hostList}>
        {hosts.map((h) => (
          <li key={h}>
            <span className="mono">{h}</span>
            <button
              type="button"
              className="key key--plain"
              disabled={hosts.length === 1}
              title={hosts.length === 1 ? "Keep at least one host" : undefined}
              aria-label={`Remove ${h}`}
              onClick={() => setHosts(hosts.filter((x) => x !== h))}
            >
              <Icon name="trash" />
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="field">
          <label htmlFor={id}>Add a host</label>
          <input id={id} className="input mono" autoComplete="off" spellCheck={false} placeholder="staging.internal" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
        <div className={styles.buttons}>
          <button type="submit" className="key">
            <Icon name="plus" />
            Add
          </button>
          <button
            type="button"
            className="key key--primary"
            disabled={!dirty || busy}
            aria-busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setSaved(null);
              try {
                const s = await ws.updateSettings({ allowed_hosts: hosts });
                onChange(s);
                setHosts(s.allowed_hosts);
                setSaved("Allowed hosts saved.");
              } catch (err) {
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            Save hosts
          </button>
        </div>
      </form>
      {error && (
        <p className="helper is-error" role="alert">
          {error}
        </p>
      )}
      <Saved text={saved} />
    </section>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSettings(await ws.settings());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Connect Claude for AI test planning and failure explanations, and choose where TestPilot may send requests.</p>
        </div>
      </div>
      {error ? (
        <div className="error-state" role="alert">
          <h3>Settings could not be loaded</h3>
          <p>{error}</p>
          <button type="button" className="key" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : !settings ? (
        <div className={styles.skeleton} aria-busy="true" aria-label="Loading settings">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : (
        <div className={styles.stack}>
          <AiSection settings={settings} onChange={setSettings} />
          <HostsSection settings={settings} onChange={setSettings} />
          <section className={`panel ${styles.section}`} aria-labelledby="limits-head">
            <div className={styles.sectionHead}>
              <h2 id="limits-head">Limits</h2>
            </div>
            <dl className={styles.limits}>
              <div>
                <dt>Requests at once</dt>
                <dd className="num">{settings.max_concurrency}</dd>
              </div>
              <div>
                <dt>Requests per run</dt>
                <dd className="num">{settings.max_requests_per_run}</dd>
              </div>
              <div>
                <dt>Request timeout</dt>
                <dd className="num">{settings.request_timeout_s} s</dd>
              </div>
            </dl>
            <p className="small muted">Set these with TESTPILOT_ variables in the .env file.</p>
          </section>
        </div>
      )}
    </>
  );
}
