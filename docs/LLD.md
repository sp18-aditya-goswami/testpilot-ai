# TestPilot AI: Low-Level Design

**Audience:** Python Mirai Squad (internal)
**Code revision:** `208eec6` on `main`
**Companion:** [HLD.md](HLD.md) for goals, principles and the system overview

This document follows the code: one section per module, with every important function, the REST API, the data models and the main sequences. Line numbers point at revision `208eec6`.

---

## 1. Code map

```
backend/
  main.py              FastAPI app, CORS, router registration
  config.py            Settings (env vars + data/settings.json overrides)
  state.py             spawn(): background tasks; active_runs registry
  db.py                SQLAlchemy tables and the SQLite session
  store.py             JSON document store (specs, plans, runs) on the objects table
  workspace_repo.py    Projects, environments, collections, folders, items
  schemas.py           Core models: Endpoint, ApiSummary, TestCase, TestPlan, Run, Exchange, Check, Fix
  workspace_schemas.py Workspace and planner models: PlannerConfig, AuthContext, LoginFlow, settings
  spec_parser.py       Fetch, parse and normalise OpenAPI 3 / Swagger 2
  auth_detect.py       Reads the spec's auth story; builds the sign-in flow
  planner.py           Staged planner: schema cases, AI strategy, AI cases, review, dedupe
  ai.py                Prompts and structured-output models for every AI task
  ai_auth.py           Provider gateway: Anthropic API, OpenAI, AWS Bedrock
  executor.py          Renders templates and sends HTTP requests; redaction; request budget
  runner.py            Runs a plan: sign-in, cases, fuzzing, failure analysis
  validator.py         Judges one exchange: status, schema, time
  findings.py          Rule-based analysis, failure digests, regression tests
  report.py            Standalone HTML report
  engines/
    base.py            PlanningEngine interface
    contract.py        Schema (contract) cases
    ai_planner.py      Turns AI drafts into validated TestCases
    examples.py        Example values from JSON Schema
    fuzz.py            Schemathesis fuzzing
  api/
    core.py            Health, specs, runs, reports
    testplans.py       The guided four-step flow
    planning.py        Plans, cases, refine, runs, fix
    workspace.py       Projects, environments, collections, folders, items, send, group runs
    navigation.py      Where a spec or suite is used
    settings.py        App settings and the AI connection check
frontend/
  app/                 Next.js App Router pages (see section 12)
  components/          Shell, steps bar, planner sections, sources, status, dialogs
  lib/                 api.ts, testplans.ts, workspace.ts: typed REST clients and models
demo_api/              User Management API and the login-only Shop Orders API
tests/                 pytest suite (53 tests)
```

## 2. Runtime model

- One FastAPI process. Long work runs as `asyncio` tasks started by `state.spawn(coro)`, which keeps a reference until the task finishes.
- A running run lives in `state.active_runs[run_id]` so `GET /api/runs/{id}` returns live progress; it is saved to the store on every milestone and at the end.
- Planning saves progress lines to the plan document as it goes (`planner.note`).
- Blocking work (AI SDK calls, Schemathesis) runs in a worker thread via `asyncio.to_thread`.
- The browser polls plans and runs until their status settles.

## 3. Configuration (`config.py`)

`Settings` (pydantic-settings, prefix `TESTPILOT_`, optional `.env`) merged with `data/settings.json` overrides written by the Settings page.

| Setting | Default | Meaning |
|---|---|---|
| `ai_provider` | `anthropic` | `anthropic`, `openai` or `bedrock` |
| `model`, `openai_model`, `bedrock_model` | per provider | Model id per provider |
| `effort` | `medium` | Reasoning effort where the provider supports it |
| `aws_region`, `bedrock_auth`, keys | none | Bedrock region and credential mode (`default`, `keys`, `api_key`) |
| `allowed_hosts` | `localhost,127.0.0.1` | Hosts the runner may call |
| `request_timeout_s` | 10.0 | Per request |
| `max_concurrency` | 4 | Parallel requests per run |
| `max_requests_per_run` | 300 | Request budget |
| `slow_response_ms` | 2000 | Latency warning threshold |
| `data_dir` | `./data` | SQLite file and settings overrides |

| Function | What it does |
|---|---|
| `get_settings()` | Builds `Settings`, applies overrides, records where each key came from |
| `read_overrides(data_dir)` / `write_overrides(data_dir, data)` | Read and write `settings.json`; writes with owner-only permissions |
| `Settings.allowed_host_set` | Lower-cased set of allowed hosts |
| `Settings.ai_enabled` | True when the selected provider has what it needs |

## 4. Data models

### 4.1 Core (`schemas.py`)

| Model | Key fields | Notes |
|---|---|---|
| `Parameter` | name, location, required, schema | One path, query, header or cookie parameter |
| `Endpoint` | id (`"METHOD /path"`), method, path, parameters, request_body_schema, request_body_media, responses, requires_auth | Normalised operation |
| `ApiSummary` | spec_id, title, version, server_url, endpoints, security_schemes | A parsed spec |
| `RequestSpec` | method, path, path_params, query, headers, body, raw_body, omit_content_type | May hold `{{templates}}` |
| `TestCase` | id, endpoint_id, name, category, source (`contract`, `ai`, `fuzz`, `saved`), rationale, setup, request, expected_status, destructive, max_ms, json_schema | One test |
| `TestPlan` | id, project_id, environment_id, suite_item_id, spec_id, cases, rejected, status, progress, ai_status, strategy, review_notes, config | Planning output |
| `Exchange` | method, url, request_headers, request_body, status, response_headers, response_body, duration_ms, error, size_bytes | One request and its response, redacted |
| `Check` | name, passed, severity (`fail`, `warn`), detail | One judgement |
| `Analysis` | title, severity, summary, likely_cause, investigation_steps, source (`ai`, `rules`), cause_group | Why a case failed |
| `Fix` | fault (`api`, `test`, `spec`), fault_reason, steps, code_language, code_caption, code, spec_change, confirm | AI fix suggestion |
| `CaseResult` | case_id, outcome, setup_exchanges, exchange, checks, analysis, regression_test, note, fix | Result of one case |
| `Run` | id, plan_id, cases, results, counts, status, message, auth_note, auth_exchanges, fuzz_status, fuzz_message | One execution |

### 4.2 Planner and workspace (`workspace_schemas.py`)

| Model | Key fields |
|---|---|
| `PlannerConfig` | instruction, objectives, depth (`quick`, `standard`, `thorough`), business_rules, endpoint_notes, auth, test_data, exclusions, review_pass, use_contract, use_ai, focus_endpoints |
| `BusinessRule` | text, endpoint_ids (empty = all), expected_status |
| `AuthContext` | description, header_name, scheme, token_variable, login, second_user, second_token_variable (`token_b`), roles |
| `LoginFlow` | signup (`AuthStep` or none), login (`AuthStep`), token_field |
| `AuthStep` | endpoint_id, method, path, body (may hold `{{unique}}`, `{{auth_username}}`), form |
| `SavedSuite` | spec_id, config, last_plan_id, last_run_id (JSON in `items.suite`) |
| `Environment` / `EnvVar` | base_url, variables (`key`, `value`, `secret`, `has_value`); secret values never returned |

## 5. Storage

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/storage-erd-dark.svg">
  <img alt="Entity relationship diagram of the SQLite file: projects, environments, collections, folders, items and the objects table of JSON documents." src="diagrams/storage-erd-light.svg">
</picture>

References between tables are kept by the code; SQLite has no foreign key constraints. Ids are strings such as `prj_…`, `env_…`, `itm_…`, `plan_…`, `run_…` (`new_id(prefix)`: prefix plus 10 hex characters).

### 5.1 `db.py`

| Function | What it does |
|---|---|
| `_engine_for(path)` | Creates the SQLite engine (WAL journal, 30 s busy timeout) and the tables |
| `db_path()` | `data_dir/testpilot.db` |
| `session()` | Context-managed SQLAlchemy session; commits on success |

### 5.2 `store.py`: JSON documents

`Store` keeps specs (`specs`), raw specs (`rawspecs`), plans (`plans`) and runs (`runs`) in the `objects` table. Safe to call from worker threads.

| Method | What it does |
|---|---|
| `save(kind, id, model, project_id)` / `save_raw(...)` | Upsert a Pydantic model or raw dict as JSON |
| `load(kind, id, Model)` / `load_raw(kind, id)` | Read back; raises `NotFound` |
| `list(kind, Model, project_id)` / `list_rows(...)` | All documents of a kind, optionally per project |
| `project_of(kind, id)` | The owning project id |
| `delete_project(project_id)` | Remove every document of a project |
| `_check(id)` | Rejects ids that are not `prefix_10hex` (`SAFE_ID`) |

### 5.3 `workspace_repo.py`

CRUD for projects, environments, collections, folders and items, plus:

| Function | What it does |
|---|---|
| `host_allowed(url)` | Is the URL's host on the allowlist |
| `add_missing_variables(project_id, defaults)` | Adds path variables (such as `user_id`) to every environment that lacks them; never overwrites |
| `environment_runtime(env_id)` | `EnvRuntime(name, base_url, variables, secret_values)` for a run; includes secrets, never returned to clients |
| `environment_project(env_id)` | The project an environment belongs to |
| `project_tree(project_id)` | Project, environments and the full collection tree |
| `requests_in(collection_id, folder_id)` | Saved requests of a subtree in tree order, for group runs |
| `move_item`, `duplicate_item`, `delete_folder` | Tree editing; folders delete their subtree |

## 6. REST API

All routes are under `/api`. Planning and runs return `202` and continue in the background.

### 6.1 Guided flow (`api/testplans.py`)

| Method and path | Purpose |
|---|---|
| `POST /test-plans/start` | Step 1. Body: `spec_url` or `spec_text`, `base_url`, optional `project_id`. Parses the spec, finds or creates the project (by title) and environment (by base URL), adds path variables, returns `StartOut` with the API summary and `AccessStatus` |
| `GET /test-plans/access?spec_id&environment_id` | How runs authenticate (`AuthDetection`) and whether the environment already holds a token, a login or a second login |
| `POST /test-plans/access` | Saves a token, a test login, or user B's login as secret variables; returns the new `AccessStatus` |
| `POST /test-plans` | Step 2. Saves the config as a suite in the project's "Test plans" collection, then calls `create_plan` |
| `GET /test-plans` | Every suite across projects with its latest plan and run, newest activity first |

### 6.2 Plans and runs (`api/planning.py`)

| Method and path | Purpose |
|---|---|
| `POST /plans` | Creates a plan (`PlanCreate`) and spawns `planner.run_planning` |
| `GET /plans/{id}` | The plan with live progress |
| `POST /plans/{id}/cases`, `PATCH /plans/{id}/cases/{case}`, `DELETE ...` | Hand edits, checked by `checked_case` |
| `POST /plans/{id}/refine` | Spawns `planner.run_refine` with an instruction |
| `POST /plans/{id}/runs` | Starts a run (`RunRequest`: case_ids, allow_destructive, fuzz, fuzz_examples) |
| `POST /runs/{id}/cases/{case}/fix` | AI fix suggestion for one failed case, stored on the run |

### 6.3 Core, navigation, settings

| Method and path | Purpose |
|---|---|
| `GET /health` | Backend up, AI enabled, provider and model |
| `POST /specs/inspect`, `GET /specs/{id}` | Parse a spec without the guided flow; read a saved spec |
| `GET /specs/{id}/usage`, `GET /items/{id}/history` | Suites, plans and runs that use a spec or suite |
| `GET /runs`, `GET /projects/{id}/runs`, `GET /runs/{id}` | Run lists and one run (live while active) |
| `GET /runs/{id}/report.json`, `GET /runs/{id}/report.html` | Downloadable reports |
| `GET /settings`, `PUT /settings`, `POST /settings/check-ai` | Settings with masked secrets; one tiny AI call to test the connection |

### 6.4 Workspace (`api/workspace.py`)

CRUD routes for projects, environments, collections, folders and items; `POST /requests/send` sends one saved request; `POST /collections/{id}/run` and `POST /folders/{id}/run` run saved requests as a group; `POST /projects/{id}/import` turns a spec into a collection of requests. `http_errors` maps `NotFound` to 404 and `Invalid` to 422.

## 7. Spec parsing (`spec_parser.py`)

| Function | What it does |
|---|---|
| `ensure_allowed_url(url)` | Raises `SpecError` unless the URL is http(s) and its host is allowed |
| `fetch_spec(url)` | GET the spec (allowed hosts only, no redirects), then `load_spec_text` |
| `load_spec_text(text)` | JSON or YAML; requires an `openapi` or `swagger` field |
| `_resolve(node, root)` | Inlines local `$ref`s; recursive refs become a description |
| `parse_spec(doc)` | Builds `ApiSummary`: endpoints with parameters, JSON body schema, body media type, response schemas, `requires_auth` from global or per-operation `security`, plus `security_schemes` |
| `_body_media(content)` | JSON when offered, else the first media type (form logins) |

## 8. Auth detection (`auth_detect.py`)

`detect(api) -> AuthDetection` decides the mode:

1. No endpoint has `requires_auth`: mode `none`.
2. `_scheme(api)` reads the first usable security scheme: Bearer (`http`, `oauth2`, `openIdConnect`), an API key header (header name, no scheme word) or Basic; it also collects OAuth2 `tokenUrl` paths.
3. `_best(endpoints, _login_score)` finds the sign-in endpoint: a POST without path parameters whose path matches an OAuth token URL (score 3), or ends in a login word (`login`, `token`, `session`, ...) with an identifier and a password field (score 2, or 1 if it is itself protected). Paths with `refresh`, `logout`, `reset` and similar are skipped.
4. No sign-in endpoint (or Basic auth): mode `token`.
5. `_best(..., _register_score)` finds a sign-up endpoint (`register`, `signup`, or a `users`/`accounts` collection with identifier and password).
6. With sign-up: mode `auto`. The flow signs up with `testpilot.{{unique}}@example.com` (or `testpilot_{{unique}}`) and `Tp-{{unique}}-Pass1!`, then signs in with the same values. Without: mode `credentials`, signing in with `{{auth_username}}` and `{{auth_password}}`.

| Helper | What it does |
|---|---|
| `_fields(ep)`, `_required(ep)` | Body properties and required names (handles `oneOf`, `allOf`) |
| `_identifier(fields, required)` | The username field: email, username, login, phone, ... or the first required string |
| `_password_fields(fields)` | Every field matching `pass`, `password`, `pwd` |
| `_step(ep, values, full)` | Builds an `AuthStep`; a sign-up sends every documented field with sensible values, a sign-in only what it needs; form-encoded when the body media is a form |
| `_token_field(ep)` | Dotted path of a token key in the documented 2xx response, if any |
| `second_user_flow(flow)` | User B's flow: the same sign-up flow (a fresh user), or the login with `_b` variables |
| `find_token(body, token_field)` | The token in a sign-in response: the documented field, else a known key (`access_token`, `token`, `jwt`, ...) up to three levels deep, else a bare string body |

## 9. Planning

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/planning-sequence-dark.svg">
  <img alt="Sequence: the web app calls start, the API saves the spec, project and environment; the web app calls create, the API saves the suite and plan and spawns the planner, which calls the AI for strategy, endpoint cases and review, then saves the plan as ready." src="diagrams/planning-sequence-light.svg">
</picture>

### 9.1 `planner.py`

Constants: `DEPTH_TARGET = {quick: 3, standard: 6, thorough: 12}` AI cases per endpoint, `MAX_CASES_PER_ENDPOINT = 20`, `GEN_CONCURRENCY = 3`.

| Function | What it does |
|---|---|
| `run_planning(plan, api, config, variable_keys)` | Entry point; wraps `_plan`, records a failure line and sets status on error |
| `_plan(...)` | 1) scoped endpoints; 2) `ContractEngine` cases with `apply_auth`; 3) if AI is on: `build_context`, `ai.plan_strategy` (falls back to default depth on failure), `generate_for_endpoints`, optional `review`; 4) `dedupe` AI + schema cases; 5) status `ready` (or `failed` with no cases) and an AI summary message |
| `generate_for_endpoints(...)` | One `ai.plan_endpoint` call per endpoint, three at a time; each raw case goes through `to_test_case`, must belong to that endpoint and stay under the per-endpoint cap; rejected drafts are recorded with a reason |
| `review(plan, context, cases)` | `ai.review_cases` on a digest; `apply_review` drops weak cases and changes expectations, with notes |
| `run_refine(...)` | Adds cases for an instruction, optionally only for some endpoints |
| `build_context(endpoints, config, variable_keys)` | The prompt block shared by every call of one planning run (prompt-cached): contract summary, objectives, numbered rules, endpoint notes, auth lines, variables, test data, exclusions, instruction |
| `endpoint_brief(ep, strategy, config, covered, target, refine)` | The per-endpoint part: strategy, rules for this endpoint, note, what is already covered, how many cases |
| `plan_variable_keys(env_keys, config)` | Environment variable names plus `token` (and `token_b` for two-user plans) when the run signs in itself |
| `apply_auth(case, config, keys, main_too)` | Adds the auth header to setup steps, and to the main request unless the case is a security case; never overrides a header the case set |
| `auth_header_value(config, variable)` | `"Bearer {{token}}"`, or just `"{{token}}"` for API-key schemes |
| `dedupe(cases)` / `case_key(case)` | Drops cases with the same endpoint and request |
| `scoped_endpoints(api, config)` | The endpoints ticked in section 1 |

With **Test with a second user** on, `build_context` adds an instruction for user B: find or create something that belongs to user A, then try to read, change or delete it as user B, expecting 403 or 404, with the user B header set explicitly.

### 9.2 `engines/contract.py`: schema cases

`ContractEngine.plan(ctx)` derives, per endpoint: a valid request (positive), missing required query parameters, an empty JSON object, each missing or null required field, wrong types, `maxLength`/`minLength`/`maximum` bounds, values outside an enum, an unknown resource id (expects 404), a non-numeric id for a numeric path parameter, and malformed JSON. Validation failures expect `[400, 422]`.

| Function | What it does |
|---|---|
| `_base_request(ep, endpoints)` | Example request; for a path like `/users/{id}` it adds a setup step that creates the resource with the collection's POST (`find_creator`) and uses `{{setup.0.body.id}}` |
| `success_statuses(ep)` | The first documented 2xx, else 200/201/202/204 |
| `_id_field(creator, param)` | The response field that holds the new id |

`engines/examples.py`: `example_for(schema, field_name)` builds example values (emails and names get `{{unique}}` so repeated runs do not collide); `wrong_type_value(schema)` gives a value of the wrong type.

### 9.3 `engines/ai_planner.py`: from AI draft to test case

| Function | What it does |
|---|---|
| `to_test_case(raw, endpoints, variables)` | Resolves the endpoint, converts setup steps and the request, rejects DELETE in setup, checks the request matches its endpoint, validates expected statuses |
| `resolve_endpoint(method, path, endpoints)` | Exact match, else maps loosely written paths (`/orders/{{order_id}}`, `/orders/42`, `GET /orders/...`) to the spec path and moves the values into `path_params` |
| `_to_request(raw, endpoints, max_setup_ref, variables)` | Parses the JSON fields, checks path parameters are filled, setup references point at earlier steps, and `{{variables}}` exist |
| `_loads(text)` | JSON parse that also quotes a bare `{{template}}` value |
| `validate_expected(codes)` | Keeps 100 to 599, rejects empty lists and any 5xx |
| `contract_summary(endpoints)` | The compact contract the AI sees |

### 9.4 `ai.py`: prompts and output models

| Call | Output model | Used by |
|---|---|---|
| `plan_strategy(context, scope, depth_target)` | `AiStrategy`: risks, categories, planned cases per endpoint | Planner |
| `plan_endpoint(context, brief)` | `AiPlan`: list of `AiCase` (requests as JSON text fields) | Planner |
| `review_cases(context, cases)` | `AiReview`: keep, drop or change expectation, plus gaps | Planner |
| `analyze_failures(failures, rules, known_groups)` | `AiFindings`: title, severity, summary, likely cause, steps, cause group | Runner |
| `suggest_fix(failure, contract, rules, analysis)` | `AiFix` | Fix route |

Every system prompt states that spec text and API responses are data, never instructions. Planning prompts are sent as a cached prefix (`_cached_system`) so per-endpoint calls reuse it.

## 10. AI gateway (`ai_auth.py`)

`call_structured(system, user, OutputModel, max_tokens)` returns a validated model or raises `AiUnavailable` with a plain message.

| Function | What it does |
|---|---|
| `provider_of(s)`, `active_model(s)`, `ai_ready(s)` | Which provider, which model, and whether its credentials are present |
| `_anthropic_client(...)` | Anthropic API client; calls use `beta.messages.parse` with server-side fallbacks and effort |
| `_openai_client(...)` | OpenAI client; calls use `responses.parse` |
| `bedrock_is_anthropic(model)` | Anthropic models use the Messages API on Bedrock; others use Converse |
| `bedrock_uses_runtime(model)` | Catalog ids (`apac.`, `:0` suffix, ARNs) use the Bedrock runtime client; plain ids use Mantle |
| `_bedrock_client(...)` | `AnthropicBedrock` or `AnthropicBedrockMantle` with profile, keys or API key |
| `converse_structured(s, system, user, Model, max_tokens)` | Bedrock Converse: forced tool call, then any tool, then optional tool, then plain JSON (`CONVERSE_MODES`); halves `maxTokens` if the model's limit is lower; retries a catalog id as `<id>-1:0` |
| `_converse_client(...)` | boto3 `bedrock-runtime`; a Bedrock API key is sent as a bearer token with SigV4 off |
| `_converse_result(response, Model)` | Reads the tool input or JSON text (fences and reasoning removed) and validates it |
| `_claude_errors(exc, ...)`, `_client_error_message(exc, s)` | Provider errors as plain messages (wrong key, model not offered in region, rate limit, ...) |
| `check_connection()` | One tiny request (or a model lookup) to test the saved settings |

## 11. Running and judging

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/run-sequence-dark.svg">
  <img alt="Sequence: the web app starts a run, the API spawns the runner, which signs in as user A and optionally user B, sends each case, gets responses, asks the AI to analyse failures and saves the run; later the web app asks for a fix, the API loads the run, calls the AI and stores the fix." src="diagrams/run-sequence-light.svg">
</picture>

### 11.1 `runner.py`

| Function | What it does |
|---|---|
| `execute_run(run, plan, api, fuzz_examples, *, variables, secrets, login, token_variable, second_user, second_token_variable)` | Opens one HTTP client; signs in (A, then B if enabled); runs every case with `max_concurrency`; optional fuzzing; sorts results; failure analysis; final status and save |
| `sign_in(run, executor, flow, variables, who)` | Sends the sign-up (if any) and sign-in steps with one `CaseContext` (same `{{unique}}`), reads the token with `find_token`, adds it to the redaction set, records redacted sign-in exchanges and a note; returns `None` on failure |
| `_run_case(case, ep, executor, allow_destructive, variables)` | Skips destructive cases unless allowed; runs setup steps (no response or a 4xx/5xx stops the case as `error`); sends the request; validates |
| `_analyze(run, plan)` | Rule-based analysis and a pytest regression test for every failure; then AI analysis in batches of 12, passing cause labels already used so repeats share one label |
| `_fuzz(run, api, max_examples)` | Runs `engines.fuzz.run_fuzz` in a thread within the remaining request budget; adds only failing examples as `fuzz` cases |

If the first sign-in fails, the run stops with status `failed` and the reason in `auth_note` and `message`. If user B's sign-in fails, the run continues and cases that use `{{token_b}}` end as errors.

### 11.2 `executor.py`

| Item | What it does |
|---|---|
| `CaseContext(variables)` | Per-case values: `{{unique}}` (8 hex), environment variables, and `{{setup.N.body.path}}` from earlier setup responses; `render(value)` fills templates in strings, dicts and lists (a whole-value template keeps its type) |
| `Executor(client, base_url, max_requests, secrets)` | `send(spec, ctx)` builds the URL (absolute URLs must be allowed hosts), renders headers, query and body, enforces the request budget (`BudgetExceeded`), records the exchange and redacts every secret |
| `redact(value, secrets)` | Replaces secret values with `••••` in strings, keys and lists |
| `make_client(**kwargs)` | The single place HTTP clients are built, so tests can route them to the in-process demo API |

Responses keep only a few headers (`content-type`, `location`, `allow`, `www-authenticate`, `retry-after`); bodies over 20,000 characters are truncated.

### 11.3 `validator.py`

`validate(case, ep, exchange, slow_ms) -> list[Check]`:

| Check | Fails when |
|---|---|
| request completed | No response (error or timeout) |
| status code | Status not in `expected_status` |
| no server error | Any 5xx |
| status documented | Status not listed in the contract (warning) |
| response schema | 2xx body does not match the documented schema (OpenAPI `nullable` converted to JSON Schema) |
| body schema | Body does not match a case's own `json_schema` |
| time limit / latency | Slower than the case's `max_ms` (fail) or `slow_response_ms` (warning) |

`outcome_for(checks)` is `failed` when any `fail` check fails, else `passed`.

### 11.4 `engines/fuzz.py`

`run_fuzz(doc, base_url, max_examples, request_budget, timeout_s, allow_destructive)` runs Schemathesis positive and negative generation per operation with the checks `not_a_server_error`, `status_code_conformance`, `content_type_conformance`, `response_schema_conformance`, `negative_data_rejection` and `positive_data_acceptance`. Each failing example becomes a `fuzz` case with a result (`_to_case_and_result`), with `expected_status` from the check (`_expected`). It stops at the request budget.

### 11.5 `findings.py` and `report.py`

| Function | What it does |
|---|---|
| `rules_analysis(case, result)` | Explanation without AI: no response, server error, invalid input accepted, valid request rejected, or contract mismatch |
| `failure_digest(case, result)` | The compact, redacted view of a failure sent to the AI |
| `regression_test(case, base_url)` | A pytest file that reproduces the failed request, setup steps included |
| `report.render_html(run)` | A standalone HTML report (Jinja2), severity ordered |

### 11.6 Fix suggestions (`api/planning.suggest_fix`)

Only for `failed` cases of a finished run. Returns the stored `Fix` if there is one. Otherwise it builds the endpoint's contract summary from the run's plan, calls `ai.suggest_fix` with the failure digest, rules and analysis, reloads the run (so fixes saved meanwhile are kept), stores the fix on the result and returns it. Errors: 409 while the run is active, 422 when AI is off or the case did not fail, 502 when the AI call fails.

## 12. Frontend

### 12.1 Routes (`frontend/app`)

| Route | Page |
|---|---|
| `/` | Landing page: two doors (AI test plan, workspace) and recent plans |
| `/plans` | All test plans with their latest result |
| `/plans/new` | Steps 1 and 2 (`NewPlanFlow`); `?suite=` edits a saved plan, `?project=&spec=` starts from a workspace spec |
| `/plans/[id]` | Step 3: plan review (`PlanReview`, `RunPanel`, `RefineBox`, `CoverageGrid`) |
| `/runs/[id]` | Step 4: the report (`RunView`, `FindingTable`, `CaseList`, `Summary`) |
| `/workspace`, `/p/[projectId]/...` | Postman-style workspace: projects, environments, specs, suites, requests, runs |
| `/settings` | AI provider, allowed hosts, limits |

### 12.2 Key components

| Component | What it does |
|---|---|
| `NewPlanFlow` | Step 1 form, the access screen for a test login or token (`AccessForm`), step 2 with `PlannerSections` and the pinned action bar; builds `config.auth` from the detected access (`authFor`) |
| `PlannerSections` (`components/planner`) | Numbered sections shared by step 2 and the workspace suite page: endpoints with notes, goal, objectives, depth, business rules as rows, case sources, auth and roles (with the second-user switch), test data, exclusions |
| `AccessForm`, `SecondLoginForm` | Save a token, a test login, or user B's login |
| `PlanReview` | Cases grouped by endpoint with source tags, reasoning and expectations; edit, delete, add, refine; run options |
| `RunView` | Verdict, "What to fix", folded "All cases" and "About this run"; polls while active |
| `FindingTable` | One row per root cause (`groupFindings` by AI cause label); detail with three facts and Request, Response, Checks, Fix tabs; "Show fix" and "Re-run this case" |
| `Shell`, `Steps`, `Source`, `Status` | Layout, the four-step bar, AI/Schema/Fuzzing/You tags, status words |

### 12.3 Client libraries

| File | What it holds |
|---|---|
| `lib/api.ts` | `request<T>()` (JSON fetch with readable errors), core types (`TestPlan`, `Run`, `Fix`, ...) and `api.*` calls |
| `lib/testplans.ts` | Guided flow calls (`start`, `create`, `list`, `access`, `saveAccess`) and `flowHref` links |
| `lib/workspace.ts` | Workspace and planner types (`PlannerConfig`, `AuthContext`, `LoginFlow`), `OBJECTIVES`, `DEFAULT_PLANNER_CONFIG`, `ws.*` calls |

## 13. Error handling

| Situation | Behaviour |
|---|---|
| Spec cannot be fetched or parsed | 422 with the reason; nothing is saved |
| Server host not allowed | 422 "not on the allowed hosts list" |
| AI not set up | Plans hold schema cases only; failures get rule-based explanations; fix returns 422 |
| AI call fails for one endpoint | That endpoint is skipped with a progress line; the plan still completes |
| AI draft is invalid | Rejected with a reason, listed on the plan |
| Sign-in fails | Run stops with the endpoint and status in the note |
| Setup step fails | That case ends as `error` with the reason |
| Request budget reached | Remaining cases are `skipped` |
| Planner or runner crash | Status `failed` with the exception in the progress line or message |

## 14. Testing

- `tests/` (pytest, 53 tests) runs the backend against the in-process demo API (`make_client` is patched), with AI calls faked where needed.
- Coverage: spec parsing, contract cases, AI draft validation and repair, planning stages, auth detection for every mode, sign-in with one and two users, redaction, runs, fuzzing, fix suggestions, providers (Anthropic, OpenAI, Bedrock Messages and Converse), settings validation, workspace CRUD and navigation.
- Browser checks (Puppeteer, run locally) walk the whole flow on desktop and phone, in both themes, checking console errors, failed requests and overflow.

Run: `.venv/bin/pytest -q`.
