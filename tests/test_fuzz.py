import ast
import asyncio
import socket
import threading
import time

import pytest
import uvicorn

from backend.findings import regression_test
from backend.runner import execute_run
from backend.schemas import Run, TestPlan
from backend.spec_parser import parse_spec
from backend.store import store
from demo_api.main import app as demo_app


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def live_demo():
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(demo_app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "demo server did not start"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)


def _run(doc, base_url, *, save_raw=True, fuzz_examples=10):
    api = parse_spec(doc)
    store.save("specs", api.spec_id, api)
    if save_raw:
        store.save_raw("rawspecs", api.spec_id, doc)
    plan = TestPlan(spec_id=api.spec_id, spec_title=api.title, base_url=base_url, cases=[])
    run = Run(plan_id=plan.id, spec_title=api.title, base_url=base_url, cases=[])
    asyncio.run(execute_run(run, plan, api, fuzz_examples=fuzz_examples))
    return run


def test_fuzzing_completes_and_records_failures(live_demo, demo_doc):
    run = _run(demo_doc, live_demo)
    assert run.status == "completed"
    assert run.fuzz_status == "ok", run.fuzz_message
    assert run.fuzz_examples_run > 0
    assert run.request_count >= run.fuzz_examples_run

    fuzz_cases = [c for c in run.cases if c.source == "fuzz"]
    results = {r.case_id: r for r in run.results}
    assert len(fuzz_cases) == run.counts.failed
    for case in fuzz_cases:
        result = results[case.id]
        assert result.outcome == "failed" and result.checks and result.exchange.status
        assert result.analysis is not None
        ast.parse(regression_test(case, live_demo))
    assert not any(c.request.method == "DELETE" for c in fuzz_cases)

    keys = [(c.endpoint_id, r.checks[0].name) for c in fuzz_cases for r in [results[c.id]]]
    assert len(keys) == len(set(keys)), "failures must be deduplicated per operation and check"


def test_fuzzing_without_raw_spec_reports_error(live_demo, demo_doc):
    run = _run(demo_doc, live_demo, save_raw=False)
    assert run.status == "completed"
    assert run.fuzz_status == "error"
    assert "Re-load the specification" in run.fuzz_message
