# AI test planner first

Approved in conversation on 2026-11-17 (landing option B, four-step flow, plans and workspace share projects).

## Why
Building a test plan today needs a project, an environment, a spec import and a suite before the planner is even visible, and nothing says where to click. The product's point is the AI test planner; the Postman-style workspace is secondary.

## Goals
- A landing page at `/` that explains the product in one screen and offers two doors: **Build an AI test plan** (primary, larger) and **Send requests by hand** (the workspace).
- One guided flow, four steps with a visible step bar and Back: 1 Your API, 2 What to test, 3 Review plan, 4 Results.
- A **Test plans** page listing every saved plan with its latest result; opening one shows its cases and latest results with Run again and Edit what to test.
- The word **AI** everywhere the app describes AI work. Provider names appear only in Settings (and the top-bar status that says which provider is on).
- Every screen says where you are; every empty state names the next click.

## Non-goals
- No new workspace features. Collections, folders, requests and environments keep working as they are, moved to `/workspace`.
- No login.

## Decisions
- Top bar: Test plans, Workspace, Settings. `/` is the landing page; the old projects list moves to `/workspace`.
- Step 1 asks for the spec link (or pasted spec), the server URL and an optional bearer token. The backend creates or reuses the project (named after the API), the environment (matched by base URL, token stored as the secret variable `token`) and saves the spec.
- Step 2 is the planner: focus chips (objectives), business rules one per line, depth, and a "More options" disclosure (endpoints to skip or focus, per-endpoint notes, known test data, auth description). It creates a suite item in the project's "Test plans" collection and starts planning.
- Step 3 is the existing plan review screen; step 4 the existing run report. Both get the four-step bar and breadcrumbs Test plans, plan name, run.
- Importing a spec in the workspace offers "Build an AI test plan from this spec", landing on step 2 with step 1 filled.
- Plans and the workspace share projects and environments.
- Source labels: AI, Schema (contract engine), Fuzzing, Written by you.

## Backend contract
- `POST /api/test-plans/start` `{spec_url | spec_text, base_url, token?, project_id?}` -> `{project_id, project_name, environment_id, environment_name, api}`.
- `POST /api/test-plans` `{project_id, environment_id, spec_id, name?, config}` -> `{suite_item_id, plan}`.
- `GET /api/test-plans` -> one row per suite item across projects with its latest plan and run.
- Starting a run from a plan records `last_plan_id` and `last_run_id` on its suite.

## Left to the builder
Copy, exact layout within the locked design system (`frontend/DESIGN.md`), and how the existing suite screen links into the new flow.
