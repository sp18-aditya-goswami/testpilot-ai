#!/usr/bin/env bash
# Starts the demo API (:8008), the TestPilot backend (:8001) and the frontend (:3000). Ctrl+C stops all three.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
if [ ! -d frontend/node_modules ]; then
  (cd frontend && npm install --no-fund --no-audit)
fi

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

DEMO_API_LATENCY_MS="${DEMO_API_LATENCY_MS:-0}" .venv/bin/uvicorn demo_api.main:app --host 127.0.0.1 --port 8008 & pids+=($!)
.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8001 & pids+=($!)
(cd frontend && exec npm run dev) & pids+=($!)

echo "TestPilot: http://localhost:3000   demo API: http://localhost:8008/docs"
wait
