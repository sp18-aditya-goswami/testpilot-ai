import asyncio
import logging

import httpx

from backend import ai
from backend.config import get_settings
from backend.executor import BudgetExceeded, CaseContext, Executor, make_client
from backend.findings import failure_digest, regression_test, rules_analysis
from backend.schemas import (
    Analysis,
    ApiSummary,
    CaseResult,
    Endpoint,
    Run,
    RunCounts,
    TestCase,
    TestPlan,
    utcnow,
)
from backend.engines.fuzz import run_fuzz
from backend.store import NotFound, store
from backend.validator import outcome_for, validate

log = logging.getLogger("testpilot.runner")
ANALYSIS_BATCH = 12


async def _run_case(
    case: TestCase,
    ep: Endpoint | None,
    executor: Executor,
    allow_destructive: bool,
    variables: dict[str, str] | None = None,
) -> CaseResult:
    if case.destructive and not allow_destructive:
        return CaseResult(case_id=case.id, outcome="skipped", note="Destructive request skipped. Enable destructive tests to run it.")

    ctx = CaseContext(variables)
    result = CaseResult(case_id=case.id, outcome="error")
    try:
        for i, step in enumerate(case.setup):
            exchange = await executor.send(step, ctx)
            result.setup_exchanges.append(exchange)
            if exchange.status is None or exchange.status >= 400:
                result.note = f"Setup step {i + 1} failed ({exchange.status or exchange.error}), so the case could not run."
                return result
            ctx.setup.append({"status": exchange.status, "body": exchange.response_body})

        exchange = await executor.send(case.request, ctx)
    except BudgetExceeded as exc:
        return CaseResult(case_id=case.id, outcome="skipped", note=str(exc))

    result.exchange = exchange
    result.checks = validate(case, ep, exchange, get_settings().slow_response_ms)
    result.outcome = "error" if exchange.status is None else outcome_for(result.checks)
    return result


def _recount(run: Run) -> None:
    counts = RunCounts(total=len(run.cases))
    for r in run.results:
        setattr(counts, r.outcome, getattr(counts, r.outcome) + 1)
    run.counts = counts


async def _analyze(run: Run, plan: TestPlan | None) -> None:
    by_id = {c.id: c for c in run.cases}
    failed = [r for r in run.results if r.outcome == "failed"]
    for r in failed:
        case = by_id[r.case_id]
        r.analysis = rules_analysis(case, r)
        status_was_the_failure = r.exchange is None or r.exchange.status not in case.expected_status
        r.regression_test = regression_test(case, run.base_url) if status_was_the_failure else None

    if not failed or not get_settings().ai_enabled:
        if failed:
            run.message = "Failure explanations are rule-based. Turn on AI in Settings for AI analysis."
        return

    run.status = "analyzing"
    for start in range(0, len(failed), ANALYSIS_BATCH):
        batch = failed[start : start + ANALYSIS_BATCH]
        digests = [failure_digest(by_id[r.case_id], r) for r in batch]
        try:
            findings = await asyncio.to_thread(ai.analyze_failures, digests, plan.business_rules if plan else "")
        except ai.AiUnavailable as exc:
            run.message = f"AI analysis unavailable ({exc}); showing rule-based explanations."
            return
        by_case = {f.case_id: f for f in findings.findings}
        for r in batch:
            f = by_case.get(r.case_id)
            if f:
                r.analysis = Analysis(
                    title=f.title,
                    severity=f.severity,
                    summary=f.summary,
                    likely_cause=f.likely_cause,
                    investigation_steps=f.investigation_steps,
                    source="ai",
                )


async def _fuzz(run: Run, api: ApiSummary, max_examples: int) -> None:
    settings = get_settings()
    try:
        doc = store.load_raw("rawspecs", api.spec_id)
    except NotFound:
        run.fuzz_status = "error"
        run.fuzz_message = "Re-load the specification to enable fuzzing"
        return

    budget = settings.max_requests_per_run - run.request_count
    if budget <= 0:
        run.fuzz_status = "error"
        run.fuzz_message = "The request budget was used up by the planned cases"
        return

    run.fuzz_status = "running"
    run.fuzz_message = "Generating inputs from the specification"
    store.save("runs", run.id, run)
    try:
        outcome = await asyncio.to_thread(
            run_fuzz,
            doc,
            run.base_url,
            max_examples=max_examples,
            request_budget=budget,
            timeout_s=settings.request_timeout_s,
            allow_destructive=run.allow_destructive,
        )
    except Exception as exc:
        log.exception("fuzzing failed for run %s", run.id)
        run.fuzz_status = "error"
        run.fuzz_message = f"Fuzzing stopped: {type(exc).__name__}: {str(exc).strip().splitlines()[0] if str(exc).strip() else ''}"
        return

    run.cases += outcome.cases
    run.results += outcome.results
    run.request_count += outcome.requests_sent
    run.fuzz_examples_run = outcome.examples_run
    _recount(run)

    if outcome.operations and outcome.examples_run == 0 and outcome.errors:
        run.fuzz_status = "error"
        run.fuzz_message = outcome.errors[0]
        return
    run.fuzz_status = "ok"
    failures = len(outcome.cases)
    parts = [f"Covered {outcome.operations} operations and found {failures} distinct {'failure' if failures == 1 else 'failures'}"]
    if outcome.budget_hit:
        parts.append("Stopped at the request budget")
    if outcome.errors:
        parts.append(f"{len(outcome.errors)} operations could not be fuzzed")
    run.fuzz_message = ". ".join(parts) + "."


async def execute_run(
    run: Run,
    plan: TestPlan | None = None,
    api: ApiSummary | None = None,
    fuzz_examples: int | None = None,
    *,
    variables: dict[str, str] | None = None,
    secrets: set[str] | None = None,
) -> None:
    """Runs every case in `run`. Without `api` (saved-request runs) there is no contract to check against."""
    settings = get_settings()
    endpoints = {e.id: e for e in api.endpoints} if api else {}
    run.status = "running"
    store.save("runs", run.id, run)

    try:
        limits = httpx.Limits(max_connections=settings.max_concurrency)
        async with make_client(timeout=settings.request_timeout_s, limits=limits, follow_redirects=False) as client:
            executor = Executor(client, run.base_url, settings.max_requests_per_run, secrets=secrets)
            semaphore = asyncio.Semaphore(settings.max_concurrency)

            async def one(case: TestCase) -> None:
                async with semaphore:
                    result = await _run_case(case, endpoints.get(case.endpoint_id), executor, run.allow_destructive, variables)
                run.results.append(result)
                _recount(run)

            await asyncio.gather(*(one(c) for c in run.cases))
            run.request_count = executor.sent

        if fuzz_examples and api is not None:
            await _fuzz(run, api, fuzz_examples)

        order = {c.id: i for i, c in enumerate(run.cases)}
        run.results.sort(key=lambda r: order[r.case_id])
        await _analyze(run, plan)
        run.status = "completed"
    except Exception as exc:
        log.exception("run %s failed", run.id)
        run.status = "failed"
        run.message = f"Run stopped: {type(exc).__name__}: {exc}"
    finally:
        run.finished_at = utcnow()
        _recount(run)
        store.save("runs", run.id, run)
