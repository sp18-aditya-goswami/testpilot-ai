import os
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="testpilot-tests-"))
os.environ["DEMO_API_DB"] = str(_tmp / "demo.db")
os.environ["TESTPILOT_DATA_DIR"] = str(_tmp / "data")
os.environ["ANTHROPIC_API_KEY"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.spec_parser import parse_spec  # noqa: E402
from demo_api.main import app as demo_app  # noqa: E402


@pytest.fixture(scope="session")
def demo_doc():
    return demo_app.openapi()


@pytest.fixture(scope="session")
def demo_api(demo_doc):
    return parse_spec(demo_doc)


@pytest.fixture
def demo_client():
    with TestClient(demo_app) as client:
        yield client
