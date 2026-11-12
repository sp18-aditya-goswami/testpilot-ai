"""The staged test planner: contract cases, an AI strategy, per-endpoint generation, a review pass, then dedupe.

Every step appends to plan.progress and saves, so a client polling GET /api/plans/{id} watches it happen.
"""

import asyncio
import json
import logging
import re
from typing import Any

from backend import ai
from backend.config import get_settings
from backend.engines.ai_planner import PlanRejected, contract_summary, to_test_case, validate_expected
from backend.engines.base import PlanContext
from backend.engines.contract import ContractEngine
from backend.schemas import ApiSummary, Endpoint, RejectedCase, RequestSpec, TestCase, TestPlan
from backend.store import store
from backend.workspace_schemas import EndpointStrategy, PlannerConfig

log = logging.getLogger("testpilot.planner")

DEPTH_TARGET = {"quick": 3, "standard": 6, "thorough": 12}
MAX_CASES_PER_ENDPOINT = 20
GEN_CONCURRENCY = 3
CATEGORIES = ["positive", "negative", "boundary", "business", "security", "robustness"]
OBJECTIVE_TEXT = {
    "happy_path": "Happy path: valid requests return the documented success",
    "validation": "Input validation: missing, malformed and wrongly typed input is rejected",
    "boundaries": "Boundary values: lengths, ranges, empty and very large values",
    "business_rules": "Business rules: every rule listed in <business_rules>",
    "auth": "Auth and permissions: missing tokens, invalid tokens, wrong roles, another user's data",
    "security": "Security input: injection-shaped strings, unexpected fields, oversized payloads",
    "state": "State and sequences: create, read, update, delete in order, read-after-write",
    "idempotency": "Duplicates and retries: repeated submissions and conflicting writes",
    "errors": "Error handling: unknown ids, wrong methods, bad content types",
    "performance": "Latency: paths that should answer quickly",
}
ENDPOINT_TAG = re.compile(r"<endpoint>(.*?)</endpoint>", re.S)


def env_runtime(environment_id: str):
    from backend.workspace_repo import environment_runtime

    return environment_runtime(environment_id)


def ai_enabled() -> bool:
    return get_settings().ai_enabled


def save(plan: TestPlan) -> None:
    store.save("plans", plan.id, plan, project_id=plan.project_id)


def note(plan: TestPlan, line: str) -> None:
    plan.progress.append(line)
    save(plan)


def scoped_endpoints(api: ApiSummary, config: PlannerConfig) -> list[Endpoint]:
    if not config.focus_endpoints:
        return list(api.endpoints)
    wanted = set(config.focus_endpoints)
    return [e for e in api.endpoints if e.id in wanted]


# ---------- prompt material ----------

def build_context(endpoints: list[Endpoint], config: PlannerConfig, variable_keys: list[str]) -> str:
    """The cached block: identical for every call in one planning run."""
    rules = "\n".join(
        f"{i}. {r.text}"
        + (f" (applies to: {', '.join(r.endpoint_ids)})" if r.endpoint_ids else " (applies to every endpoint)")
        + (f" (a violation returns {' or '.join(map(str, r.expected_status))})" if r.expected_status else "")
        for i, r in enumerate(config.business_rules, start=1)
    )
    notes = "\n".join(f"{n.endpoint_id}: {n.note}" for n in config.endpoint_notes if n.note.strip())
    auth = config.auth
    auth_lines = []
    if auth.description.strip():
        auth_lines.append(auth.description.strip())
    if auth.token_variable:
        auth_lines.append(f'Valid requests send the header "{auth.header_name}: Bearer {{{{{auth.token_variable}}}}}".')
    if auth.roles:
        role_vars = [f"{r}: {{{{{r}_token}}}}" if f"{r}_token" in variable_keys else f"{r}: no token variable" for r in auth.roles]
        auth_lines.append("Roles and their token variables: " + "; ".join(role_vars) + ".")
    objectives = "\n".join(f"- {OBJECTIVE_TEXT[o]}" for o in config.objectives)
    return (
        f"<contract>\n{json.dumps(contract_summary(endpoints), indent=1, sort_keys=True)}\n</contract>\n\n"
        f"<objectives>\n{objectives or '- Happy path'}\n</objectives>\n\n"
        f"<business_rules>\n{rules or 'None given beyond the contract.'}\n</business_rules>\n\n"
        f"<endpoint_notes>\n{notes or 'None.'}\n</endpoint_notes>\n\n"
        f"<auth>\n{chr(10).join(auth_lines) or 'No authentication described.'}\n</auth>\n\n"
        f"<variables>\n{', '.join(sorted(variable_keys)) or 'None.'}\n</variables>\n\n"
        f"<test_data>\n{config.test_data.strip() or 'None given.'}\n</test_data>\n\n"
        f"<exclusions>\n{config.exclusions.strip() or 'None.'}\n</exclusions>\n\n"
        f"<instruction>\n{config.instruction.strip() or 'Test these endpoints thoroughly.'}\n</instruction>"
    )


def rule_numbers_for(config: PlannerConfig, endpoint_id: str) -> list[int]:
    return [i for i, r in enumerate(config.business_rules, start=1) if not r.endpoint_ids or endpoint_id in r.endpoint_ids]


def endpoint_brief(
    ep: Endpoint,
    strategy: EndpointStrategy | None,
    config: PlannerConfig,
    covered: list[str],
    target: int,
    refine: str | None = None,
) -> str:
    rules = rule_numbers_for(config, ep.id)
    endpoint_note = next((n.note for n in config.endpoint_notes if n.endpoint_id == ep.id and n.note.strip()), "")
    parts = [f"<endpoint>{ep.id}</endpoint>"]
    if strategy:
        parts.append(
            "<strategy>\nrisks: " + "; ".join(strategy.risks) + "\ncategories: " + ", ".join(strategy.categories) + "\n</strategy>"
        )
    parts.append(f"<rules_for_this_endpoint>{', '.join(f'rule {n}' for n in rules) or 'none'}</rules_for_this_endpoint>")
    if endpoint_note:
        parts.append(f"<note>{endpoint_note}</note>")
    parts.append("<already_covered>\n" + ("\n".join(f"- {c}" for c in covered) or "nothing yet") + "\n</already_covered>")
    if refine:
        parts.append(f"<refine>{refine}</refine>")
        parts.append(f"Write up to {target} new cases for {ep.id} that answer <refine>. Every case targets {ep.id}.")
    else:
        parts.append(f"Write about {target} cases for {ep.id}. Every case targets {ep.id}.")
    return "\n\n".join(parts)


# ---------- post-processing ----------

def has_header(spec: RequestSpec, name: str) -> bool:
    return any(k.lower() == name.lower() for k in spec.headers)


def apply_auth(case: TestCase, config: PlannerConfig, variable_keys: set[str], main_too: bool) -> None:
    """Sends the configured token on setup steps (always) and on the main request unless the case tests auth itself."""
    token = config.auth.token_variable
    if not token or token not in variable_keys:
        return
    header, value = config.auth.header_name or "Authorization", f"Bearer {{{{{token}}}}}"
    for step in case.setup:
        if not has_header(step, header):
            step.headers[header] = value
    if main_too and not has_header(case.request, header):
        case.request.headers[header] = value


def case_key(case: TestCase) -> str:
    r = case.request
    return json.dumps([case.endpoint_id, r.method, r.path_params, r.query, r.headers, r.body, r.raw_body], sort_keys=True, default=str)


def dedupe(cases: list[TestCase]) -> tuple[list[TestCase], int]:
    seen: set[str] = set()
    kept: list[TestCase] = []
    for c in cases:
        k = case_key(c)
        if k in seen:
            continue
        seen.add(k)
        kept.append(c)
    return kept, len(cases) - len(kept)


def review_digest(cases: list[TestCase]) -> tuple[list[dict[str, Any]], dict[str, TestCase]]:
    refs: dict[str, TestCase] = {}
    digest = []
    for i, c in enumerate(cases, start=1):
        ref = f"c{i}"
        refs[ref] = c
        body = c.request.raw_body if c.request.raw_body is not None else c.request.body
        body_text = body if isinstance(body, str) else json.dumps(body, default=str)
        digest.append(
            {
                "case_ref": ref,
                "endpoint": c.endpoint_id,
                "name": c.name,
                "category": c.category,
                "rationale": c.rationale,
                "setup_steps": [f"{s.method} {s.path}" for s in c.setup],
                "request": {
                    "path_params": c.request.path_params,
                    "query": c.request.query,
                    "header_names": sorted(c.request.headers),
                    "body": (body_text or "")[:400],
                },
                "expected_status": c.expected_status,
            }
        )
    return digest, refs


def apply_review(review: ai.AiReview, refs: dict[str, TestCase]) -> tuple[set[str], list[str]]:
    """Returns the ids of dropped cases and human-readable notes."""
    dropped: set[str] = set()
    notes: list[str] = []
    for item in review.items:
        case = refs.get(item.case_ref)
        if case is None or item.action == "keep":
            continue
        if item.action == "drop":
            dropped.add(case.id)
            notes.append(f"Dropped '{case.name}': {item.reason}")
        else:
            try:
                fixed = validate_expected(item.expected_status)
            except PlanRejected:
                continue
            if fixed != case.expected_status:
                notes.append(f"Changed expected status of '{case.name}' to {' or '.join(map(str, fixed))}: {item.reason}")
                case.expected_status = fixed
    for gap in review.gaps[:5]:
        notes.append(f"Gap: {gap}")
    return dropped, notes


# ---------- generation ----------

async def generate_for_endpoints(
    plan: TestPlan,
    api: ApiSummary,
    endpoints: list[Endpoint],
    config: PlannerConfig,
    context: str,
    variable_keys: set[str],
    strategies: dict[str, EndpointStrategy],
    targets: dict[str, int],
    refine: str | None = None,
) -> tuple[list[TestCase], int]:
    """One AI call per endpoint, at most GEN_CONCURRENCY at a time. Returns validated cases and the failed-call count."""
    by_id = {e.id: e for e in api.endpoints}
    variables = frozenset(variable_keys)
    semaphore = asyncio.Semaphore(GEN_CONCURRENCY)
    failures = 0

    async def one(ep: Endpoint) -> list[TestCase]:
        nonlocal failures
        covered = [c.name for c in plan.cases if c.endpoint_id == ep.id]
        brief = endpoint_brief(ep, strategies.get(ep.id), config, covered, targets[ep.id], refine)
        async with semaphore:
            try:
                proposal = await asyncio.to_thread(ai.plan_endpoint, context, brief)
            except ai.AiUnavailable as exc:
                failures += 1
                note(plan, f"Could not plan {ep.id}: {exc}")
                return []
        accepted: list[TestCase] = []
        cap = max(targets[ep.id] * 2, 4)
        for raw in proposal.cases:
            if len(accepted) >= min(cap, MAX_CASES_PER_ENDPOINT):
                plan.rejected.append(RejectedCase(name=raw.name, reason="over the case limit for this endpoint"))
                continue
            if raw.endpoint_id != ep.id:
                plan.rejected.append(RejectedCase(name=raw.name, reason=f"written for {raw.endpoint_id}, not {ep.id}"))
                continue
            try:
                case = to_test_case(raw, by_id, variables)
            except PlanRejected as exc:
                plan.rejected.append(RejectedCase(name=raw.name, reason=str(exc)))
                continue
            apply_auth(case, config, variable_keys, main_too=case.category != "security")
            accepted.append(case)
        note(plan, f"Planned {len(accepted)} {'case' if len(accepted) == 1 else 'cases'} for {ep.id}")
        return accepted

    results = await asyncio.gather(*(one(ep) for ep in endpoints))
    return [c for group in results for c in group], failures


async def review(plan: TestPlan, context: str, cases: list[TestCase]) -> list[TestCase]:
    if not cases:
        return cases
    note(plan, f"Reviewing {len(cases)} AI cases against the contract and the rules")
    digest, refs = review_digest(cases)
    try:
        result = await asyncio.to_thread(ai.review_cases, context, digest)
    except ai.AiUnavailable as exc:
        note(plan, f"Review skipped: {exc}")
        return cases
    dropped, notes = apply_review(result, refs)
    plan.review_notes += notes
    changed = sum(1 for n in notes if n.startswith("Changed"))
    note(plan, f"Review changed {changed} expectations and dropped {len(dropped)} cases")
    return [c for c in cases if c.id not in dropped]


async def run_planning(plan: TestPlan, api: ApiSummary, config: PlannerConfig, variable_keys: list[str]) -> None:
    try:
        await _plan(plan, api, config, set(variable_keys))
    except Exception as exc:
        log.exception("planning %s failed", plan.id)
        plan.ai_status = "error" if config.use_ai else plan.ai_status
        plan.progress.append(f"Planning stopped: {type(exc).__name__}: {exc}")
        plan.status = "ready" if plan.cases else "failed"
        save(plan)


async def _plan(plan: TestPlan, api: ApiSummary, config: PlannerConfig, variable_keys: set[str]) -> None:
    endpoints = scoped_endpoints(api, config)
    if not endpoints:
        plan.status = "failed"
        note(plan, "No endpoints are in scope")
        return

    ai_cases: list[TestCase] = []
    contract_cases: list[TestCase] = []
    if config.use_contract:
        ctx = PlanContext(api=api, focus_endpoints=config.focus_endpoints)
        contract_cases = ContractEngine().plan(ctx).cases
        for case in contract_cases:
            apply_auth(case, config, variable_keys, main_too=True)
        plan.cases = list(contract_cases)
        note(plan, f"Derived {len(contract_cases)} contract cases from the specification")

    if config.use_ai and not ai_enabled():
        plan.ai_status = "disabled"
        plan.ai_message = "Set an Anthropic API key in Settings to plan AI scenarios."
    elif config.use_ai:
        context = build_context(endpoints, config, sorted(variable_keys))
        target = DEPTH_TARGET[config.depth]
        note(plan, f"Drafting a test strategy for {len(endpoints)} endpoints")
        strategies: dict[str, EndpointStrategy] = {}
        try:
            strat = await asyncio.to_thread(ai.plan_strategy, context, [e.id for e in endpoints], target)
            scope_ids = {e.id for e in endpoints}
            for s in strat.endpoints:
                if s.endpoint_id in scope_ids:
                    strategies[s.endpoint_id] = EndpointStrategy(
                        endpoint_id=s.endpoint_id,
                        risks=[r.strip() for r in s.risks if r.strip()][:6],
                        categories=[c for c in s.categories if c in CATEGORIES],
                        planned_cases=max(1, min(int(s.planned_cases), MAX_CASES_PER_ENDPOINT)),
                    )
            plan.strategy = [s.model_dump() for s in strategies.values()]
            note(plan, f"Strategy ready: {sum(s.planned_cases for s in strategies.values())} AI cases planned")
        except ai.AiUnavailable as exc:
            note(plan, f"Strategy step failed ({exc}); planning each endpoint at the default depth")

        targets = {e.id: strategies[e.id].planned_cases if e.id in strategies else target for e in endpoints}
        ai_cases, failures = await generate_for_endpoints(plan, api, endpoints, config, context, variable_keys, strategies, targets)
        if config.review_pass:
            ai_cases = await review(plan, context, ai_cases)

        if failures == len(endpoints):
            plan.ai_status = "error"
            plan.ai_message = "Claude could not plan any endpoint; see the progress log."
        else:
            plan.ai_status = "ok"
            plan.ai_message = f"Claude planned {len(ai_cases)} scenarios across {len(endpoints)} endpoints"
            if plan.rejected:
                plan.ai_message += f"; {len(plan.rejected)} rejected by validation"

    plan.cases, removed = dedupe(ai_cases + contract_cases)
    if removed:
        plan.progress.append(f"Removed {removed} duplicate {'case' if removed == 1 else 'cases'}")
    plan.status = "ready" if plan.cases else "failed"
    note(plan, f"Plan ready with {len(plan.cases)} cases" if plan.cases else "The plan has no cases")


async def run_refine(
    plan: TestPlan, api: ApiSummary, config: PlannerConfig, variable_keys: list[str], instruction: str, endpoint_ids: list[str]
) -> None:
    try:
        keys = set(variable_keys)
        scope = scoped_endpoints(api, config)
        if endpoint_ids:
            wanted = set(endpoint_ids)
            scope = [e for e in api.endpoints if e.id in wanted]
        context = build_context(scope, config, sorted(keys))
        per = max(3, DEPTH_TARGET[config.depth] // 2)
        strategies = {s["endpoint_id"]: EndpointStrategy(**s) for s in plan.strategy if s.get("endpoint_id")}
        note(plan, f"Refining {len(scope)} {'endpoint' if len(scope) == 1 else 'endpoints'}: {instruction}")
        added, _ = await generate_for_endpoints(plan, api, scope, config, context, keys, strategies, {e.id: per for e in scope}, refine=instruction)
        if config.review_pass:
            added = await review(plan, context, added)
        before = len(plan.cases)
        plan.cases, _ = dedupe(plan.cases + added)
        plan.status = "ready"
        note(plan, f"Added {len(plan.cases) - before} cases")
    except Exception as exc:
        log.exception("refining %s failed", plan.id)
        plan.status = "ready"
        note(plan, f"Refining stopped: {type(exc).__name__}: {exc}")


def extract_endpoint(brief: str) -> str | None:
    m = ENDPOINT_TAG.search(brief)
    return m.group(1).strip() if m else None
