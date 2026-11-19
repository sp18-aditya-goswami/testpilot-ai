# Presenting TestPilot AI from another machine

Everything needed to run the demo on the presenter's laptop.

## What you receive

| Item | How it reaches you |
|---|---|
| The code | This GitHub repo, branch `main` |
| The data: plans, runs and projects (`testpilot-demo-data.json`) | Sent to you directly; it is not in Git |
| The AI key | Shared with you personally; never put it in a file in the repo |

The data file holds three projects: **User Management API**, **Shop Orders API** and **User service**. It contains no passwords, tokens or AI keys; you re-enter the two demo passwords below when the app asks.

## 1. Get the code

```bash
git clone git@github.com:sp18-aditya-goswami/testpilot-ai.git   # or: git pull, if you already have it
cd testpilot-ai
```

Needs Python 3.12 or newer and Node 20 or newer.

## 2. Start it once

```bash
./scripts/dev.sh
```

The first run creates `.venv/` and installs the Python and Node packages inside the repo (nothing global). It then starts three things; leave this terminal open:

| What | Address |
|---|---|
| TestPilot | http://localhost:3000 |
| TestPilot backend | http://localhost:8001 |
| Demo APIs | http://localhost:8008 |

Stop everything with `Ctrl+C`.

## 3. Import the data

Put the file in the repo's `exports/` folder, then in a second terminal:

```bash
.venv/bin/python scripts/import_data.py exports/testpilot-demo-data.json
```

Refresh http://localhost:3000; the plans appear under **Test plans**. Running the import again is safe: anything already there is left alone. Add `--dry-run` to preview.

## 4. Turn on the AI

Open **Settings**, choose the AI provider, paste the key you were given, then click **Save and check connection**. It should say the provider works. The key stays in `data/settings.json` on your machine only.

## 5. The two sample APIs

Both run inside the demo server from step 2. In step 1 of a new test plan, paste the spec link; the server address fills in by itself.

| Sample | Spec link | Auth | What to enter |
|---|---|---|---|
| **User Management API** (has sign-up) | `http://localhost:8008/openapi.json` | Signs itself in: registers a fresh test user, then logs in | Nothing |
| **Shop Orders API** (login only, no sign-up) | `http://localhost:8008/shop/openapi.json` | Asks for a test login | `alice` / `alice-pass-1`; for two-user tests, user B is `bob` / `bob-pass-2` |

No network? The same specs are in `docs/demo/specs/` as files; use **Paste** in step 1 and set the server to `http://localhost:8008`.

Planted bugs to show:

- **User Management API:** duplicate emails, short passwords and invalid emails are accepted, the name is not required, a missing user returns 200 instead of 404, and any signed-in user can change or delete another user.
- **Shop Orders API:** any signed-in user can read another user's order.

The demo APIs reset their own data every time they start, so each demo begins clean.

## 6. Demo flow (slide 5)

1. **Start a test plan**, paste `http://localhost:8008/openapi.json`, **Continue**.
2. Step 2: keep the defaults, tick **Auth and permissions** (this turns on **Test with a second user** in section 7), add a business rule such as "Email must be unique", return **409**. **Build the plan**.
3. Step 3: show who made each case and why, then **Run**.
4. Step 4: open a row in **What to fix**, show the tabs, then **Show fix**.

To slow the demo API so the audience can watch a run progress: `DEMO_API_LATENCY_MS=150 ./scripts/dev.sh`.

## Slides and documents

| File | What |
|---|---|
| `docs/demo/TestPilot-AI-demo.pptx` | The 9-slide deck (Arial, opens anywhere) |
| `docs/demo/TestPilot-AI-overview.pdf` | The one-page overview for the audience |
| `docs/HLD.md`, `docs/LLD.md` | Design documents for the squad |

## If something goes wrong

| Problem | Fix |
|---|---|
| "AI off" in the top bar | Step 4: set the provider and key in Settings |
| "not on the allowed hosts list" | Settings → Allowed hosts must include `localhost` (it does by default) |
| A port is already in use | Close whatever uses 3000, 8001 or 8008, then run `./scripts/dev.sh` again |
| Shop plan stops at sign-in | Re-enter the login: alice / alice-pass-1 |
| User service's **Local** environment needs a token | Its saved token was not shared; add one under Workspace → Environments if you use it |
