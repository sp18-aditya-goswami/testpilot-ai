# TestPilot AI

An API testing workspace for teams. Organise work into projects, collections and folders like Postman, send saved requests against environments, and let Claude plan and explain test suites built from your OpenAPI specs.

The rule the design follows: **AI plans and explains, deterministic code executes and judges.** The LLM never decides whether a response is correct.

## Run it

```bash
./scripts/dev.sh              # demo API :8008, backend :8001, frontend :3000
```

Open http://localhost:3000, create a project, add an environment (base URL `http://localhost:8008`), then use **Import** in the sidebar with `http://localhost:8008/openapi.json`.

To turn on the AI planner and AI failure explanations, open **Settings** and choose a provider. No `.env` edit or restart is needed:

| Provider | What it needs |
| --- | --- |
| Anthropic API | An API key from the Claude Console (a Claude Team or Pro plan does not include API access) |
| OpenAI | An OpenAI API key; uses the Responses API with structured outputs |
| AWS Bedrock | An AWS region with the Claude model enabled, and credentials: whatever the AWS CLI already uses on the backend machine, an access key, or a Bedrock API key. Billed to your AWS account |

Credentials are stored in `data/settings.json` with owner-only permissions and are never sent back to the browser.

For a live demo, slow the demo API so the audience can watch a run progress: `DEMO_API_LATENCY_MS=150 ./scripts/dev.sh`.

Everything installs locally: Python packages into `.venv/`, Node packages into `frontend/node_modules/`. Data lives in `data/testpilot.db` (SQLite, gitignored).

## The workspace

| Concept | What it holds |
| --- | --- |
| Project | One API or service: its specs, environments, collections and run history |
| Environment | A connection: base URL plus variables such as `{{token}}`; secret values are masked in the UI and redacted from every stored request and response |
| Collection, folder | Saved items, nested as deep as you like |
| Request | Method, path with `{{variables}}`, params, headers, body, and checks (expected status, max time, JSON schema) |
| Test suite | A spec plus planner settings; generates a plan, runs it, keeps the last plan and run |

Run a single request, a folder or a whole collection against any environment. Importing a spec creates a collection with one request per operation, grouped by tag, and adds any path variables (such as `user_id`) to the project's environments.

## The test planner

A suite's planner takes more than a prompt: objectives (happy path, validation, boundaries, business rules, auth and roles, security input, state and sequences, duplicates, error handling, latency), depth (quick, standard, thorough), business rules scoped to endpoints with the status a violation must return, per-endpoint notes, auth setup, known test data and exclusions.

Planning runs in stages, in the background, with live progress:

1. Contract cases from the schema.
2. A strategy per endpoint: risks, categories and how many cases.
3. Cases generated endpoint by endpoint, three at a time, each call seeing only that endpoint's rules and notes.
4. Validation: the endpoint exists, path params are filled, JSON parses, `{{variables}}` exist in the environment, setup never deletes, no case expects a 5xx.
5. A review pass where Claude corrects wrong expectations and drops weak cases, with notes on what it changed.

The plan screen shows a coverage grid (endpoints by category), lets you edit, add and delete cases, and accepts follow-up requests in plain English ("add pagination cases for GET /users").

Alongside the AI, two deterministic engines always run: the contract engine (`backend/engines/contract.py`) and Schemathesis fuzzing (`backend/engines/fuzz.py`).

## Teams

```bash
docker compose up -d --build                 # TestPilot on http://<host>:3000
docker compose --profile demo up -d --build  # also starts the demo API
```

One shared instance serves the team; data persists in the `testpilot-data` volume. Only the frontend port is published. **There is no login yet**: anyone who can reach the port can use the workspace and the stored AI key, so run it on a trusted network or behind a VPN. Set `TESTPILOT_ALLOWED_HOSTS` to the staging hosts your team tests.

## The demo API and its planted bugs

| Business rule | Planted defect | Engine meant to catch it |
| --- | --- | --- |
| Unknown user returns 404 | Returns 200 with `null` | Contract |
| Email must be unique (409) | Duplicates accepted | AI |
| Password at least 8 characters | Any length accepted | AI |
| Email must be valid | Any string accepted | AI |
| Name is required | Defaults to empty string | AI |
| Updated email must be valid | Any string accepted | AI |

Fuzzing also finds defects nobody planted: a 500 on very large user ids (SQLite integer overflow) and timestamps without a timezone.

## Safety

- Requests only go to hosts on the allowlist (Settings, or `TESTPILOT_ALLOWED_HOSTS`). Spec URLs and environments follow the same rule.
- DELETE requests are skipped unless a run enables destructive tests.
- Per-run request budget, concurrency limit and per-request timeout; redirects are never followed.
- Secret environment values never reach the browser and are redacted from stored runs; AI provider credentials are stored in `data/settings.json` with owner-only permissions and are never sent back.
- Spec text, user instructions and response bodies are passed to the model as data, never as instructions.

## Layout

```
backend/        FastAPI: api/ (core, planning, workspace routes), planner, engines, executor, storage
demo_api/       Deliberately buggy target API
frontend/       Next.js app (Hallmark, Vantage theme, light and dark); DESIGN.md holds the design system
tests/          pytest suite (no network, no API key)
scripts/dev.sh  Starts all three processes locally
```

## Tests

```bash
.venv/bin/python -m pytest -q tests
cd frontend && npx tsc --noEmit
```
