import json
from typing import Any

from jinja2 import Environment, select_autoescape

from backend.schemas import Run

env = Environment(autoescape=select_autoescape(default=True, default_for_string=True))
env.filters["pretty"] = lambda v: v if isinstance(v, str) else json.dumps(v, indent=2, default=str)

TEMPLATE = env.from_string(
    """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ run.spec_title }} test report</title>
<style>
:root {
  --ink: #16181d; --muted: #5d6470; --line: #e3e5e8; --paper: #ffffff; --wash: #f6f7f8;
  --fail: #b42318; --pass: #2b6e3f; --warn: #8a5a00;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 var(--sans); }
main { max-width: 960px; margin: 0 auto; padding: 48px 24px 80px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 4px; font-weight: 600; }
h2 { font-size: 18px; margin: 48px 0 12px; font-weight: 600; }
h3 { font-size: 15px; margin: 0; font-weight: 600; }
.meta { color: var(--muted); margin: 0; }
.counts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: 6px; margin-top: 28px; }
.counts div { padding: 14px 16px; border-left: 1px solid var(--line); }
.counts div:first-child { border-left: 0; }
.counts b { display: block; font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.counts span { color: var(--muted); font-size: 13px; }
.finding { border: 1px solid var(--line); border-radius: 6px; padding: 18px 20px; margin-bottom: 12px; break-inside: avoid; }
.finding header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
.sev { font-size: 13px; color: var(--fail); white-space: nowrap; }
.sev.medium, .sev.low { color: var(--warn); }
.finding p { margin: 8px 0 0; }
.label { color: var(--muted); font-size: 13px; margin-top: 14px !important; }
pre { background: var(--wash); border-radius: 4px; padding: 12px; overflow-x: auto; font: 12.5px/1.5 var(--mono); margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-weight: 500; color: var(--muted); padding: 8px 10px; border-bottom: 1px solid var(--line); }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.mono { font-family: var(--mono); font-size: 12.5px; white-space: nowrap; }
.outcome-failed { color: var(--fail); } .outcome-passed { color: var(--pass); } .outcome-error, .outcome-skipped { color: var(--warn); }
@media (max-width: 640px) { .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } .counts div { border-left: 0; border-top: 1px solid var(--line); } }
</style>
</head>
<body>
<main>
  <h1>{{ run.spec_title }}</h1>
  <p class="meta">Run {{ run.id }} against {{ run.base_url }}, {{ run.created_at.strftime("%d %b %Y %H:%M UTC") }}{% if duration %}, {{ duration }}{% endif %}</p>

  <div class="counts">
    <div><b>{{ run.counts.total }}</b><span>cases</span></div>
    <div><b>{{ run.counts.passed }}</b><span>passed</span></div>
    <div><b>{{ run.counts.failed }}</b><span>failed</span></div>
    <div><b>{{ run.counts.error }}</b><span>errors</span></div>
    <div><b>{{ run.counts.skipped }}</b><span>skipped</span></div>
  </div>
  {% if run.message %}<p class="meta" style="margin-top:16px">{{ run.message }}</p>{% endif %}

  {% if failures %}
  <h2>Findings</h2>
  {% for item in failures %}
  <section class="finding">
    <header>
      <h3>{{ item.result.analysis.title if item.result.analysis else item.case.name }}</h3>
      {% if item.result.analysis %}<span class="sev {{ item.result.analysis.severity }}">{{ item.result.analysis.severity }}</span>{% endif %}
    </header>
    <p class="meta"><code>{{ item.case.endpoint_id }}</code>, {{ item.case.name | lower }}</p>
    {% if item.result.analysis %}
    <p>{{ item.result.analysis.summary }}</p>
    <p class="label">Likely cause</p>
    <p>{{ item.result.analysis.likely_cause }}</p>
    {% endif %}
    {% if item.result.exchange %}
    <p class="label">Request</p>
    <pre>{{ item.result.exchange.method }} {{ item.result.exchange.url }}{% if item.result.exchange.request_body is not none %}

{{ item.result.exchange.request_body | pretty }}{% endif %}</pre>
    <p class="label">Response {{ item.result.exchange.status }}</p>
    <pre>{{ item.result.exchange.response_body | pretty }}</pre>
    {% endif %}
    {% if item.result.regression_test %}
    <p class="label">Regression test</p>
    <pre>{{ item.result.regression_test }}</pre>
    {% endif %}
  </section>
  {% endfor %}
  {% endif %}

  <h2>All cases</h2>
  <table>
    <thead><tr><th>Outcome</th><th>Endpoint</th><th>Case</th><th>Source</th><th>Status</th></tr></thead>
    <tbody>
    {% for item in rows %}
      <tr>
        <td class="outcome-{{ item.result.outcome if item.result else 'skipped' }}">{{ item.result.outcome if item.result else "pending" }}</td>
        <td class="mono">{{ item.case.endpoint_id }}</td>
        <td>{{ item.case.name }}</td>
        <td>{{ {"ai": "AI", "fuzz": "Fuzzing"}.get(item.case.source, "Contract") }}</td>
        <td class="mono">{{ item.result.exchange.status if item.result and item.result.exchange and item.result.exchange.status else "" }}</td>
      </tr>
    {% endfor %}
    </tbody>
  </table>
</main>
</body>
</html>
"""
)

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}


def render_html(run: Run) -> str:
    results = {r.case_id: r for r in run.results}
    rows: list[dict[str, Any]] = [{"case": c, "result": results.get(c.id)} for c in run.cases]
    failures = [row for row in rows if row["result"] and row["result"].outcome == "failed"]
    failures.sort(key=lambda row: SEVERITY_ORDER.get(row["result"].analysis.severity if row["result"].analysis else "low", 9))

    duration = None
    if run.finished_at:
        seconds = (run.finished_at - run.created_at).total_seconds()
        duration = f"{seconds:.1f}s"
    return TEMPLATE.render(run=run, rows=rows, failures=failures, duration=duration)
