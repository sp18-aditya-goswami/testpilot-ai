import json
import os
import stat
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

import backend.ai_auth as ai_auth
from backend.config import get_settings, overrides_path
from backend.main import app


class Answer(BaseModel):
    word: str


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
        c.put("/api/settings", json={
            "ai_provider": "anthropic", "anthropic_api_key": "", "openai_api_key": "", "aws_access_key_id": "",
            "aws_secret_access_key": "", "aws_session_token": "", "bedrock_api_key": "", "aws_region": "", "bedrock_auth": "default",
        })


def test_openai_key_is_masked_and_selects_provider(client):
    r = client.put("/api/settings", json={"ai_provider": "openai", "openai_api_key": "sk-proj-abcdefghijklmnopqrstuv9876", "openai_model": "gpt-5.1"})
    assert r.status_code == 200, r.text
    ai = r.json()["ai"]
    assert ai["provider"] == "openai" and ai["configured"] and ai["model"] == "gpt-5.1"
    assert ai["openai"]["key_hint"] == "sk-proj…9876" and ai["openai"]["key_source"] == "app"
    assert "abcdefghijklmnop" not in r.text
    assert stat.S_IMODE(os.stat(overrides_path(get_settings().data_dir)).st_mode) == 0o600
    health = client.get("/api/health").json()
    assert health["provider"] == "openai" and health["ai_enabled"] is True


def test_bedrock_keys_are_masked_and_validated(client):
    assert client.put("/api/settings", json={"aws_region": "not a region"}).status_code == 422
    r = client.put("/api/settings", json={
        "ai_provider": "bedrock", "aws_region": "us-east-1", "bedrock_auth": "keys",
        "aws_access_key_id": "AKIAIOSFODNN7EXAMPLE", "aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    })
    assert r.status_code == 200, r.text
    ai = r.json()["ai"]
    assert ai["provider"] == "bedrock" and ai["configured"] and ai["model"] == "anthropic.claude-opus-5-5"
    b = ai["bedrock"]
    assert b["region"] == "us-east-1" and b["auth"] == "keys" and b["access_key_hint"] == "AKIA…MPLE" and b["has_secret_key"]
    assert "wJalrXUtnFEMI" not in r.text and "IOSFODNN7" not in r.text

    half = client.put("/api/settings", json={"aws_secret_access_key": ""}).json()["ai"]
    assert half["configured"] is False
    check = client.post("/api/settings/check-ai").json()
    assert check["ok"] is False and "access key and secret" in check["message"]


def test_bedrock_call_omits_first_party_only_fields(client, monkeypatch):
    client.put("/api/settings", json={"ai_provider": "bedrock", "aws_region": "us-west-2", "bedrock_auth": "api_key", "bedrock_api_key": "bedrock-api-key-123456789"})
    seen = {}

    class FakeMessages:
        def parse(self, **kwargs):
            seen.update(kwargs)
            return SimpleNamespace(stop_reason="end_turn", stop_details=None, parsed_output=Answer(word="ready"))

    monkeypatch.setattr(ai_auth, "_bedrock_client", lambda s, t, r: SimpleNamespace(messages=FakeMessages()))
    out = ai_auth.call_structured("system", "hello", Answer)
    assert out.word == "ready"
    assert seen["model"] == "anthropic.claude-opus-5-5" and seen["output_format"] is Answer
    assert "fallbacks" not in seen and "betas" not in seen


def test_openai_call_uses_structured_responses(client, monkeypatch):
    client.put("/api/settings", json={"ai_provider": "openai", "openai_api_key": "sk-proj-abcdefghijklmnopqrstuv9876", "effort": "max"})
    seen = {}

    class FakeResponses:
        def parse(self, **kwargs):
            seen.update(kwargs)
            return SimpleNamespace(status="completed", output_parsed=Answer(word="ready"))

    monkeypatch.setattr(ai_auth, "_openai_client", lambda s, t, r: SimpleNamespace(responses=FakeResponses()))
    system = [{"type": "text", "text": "rules"}, {"type": "text", "text": "context", "cache_control": {"type": "ephemeral"}}]
    out = ai_auth.call_structured(system, "hello", Answer)
    assert out.word == "ready"
    assert seen["text_format"] is Answer and seen["instructions"] == "rules\n\ncontext"
    assert seen["reasoning"] == {"effort": "high"} and seen["store"] is False
    client.put("/api/settings", json={"effort": "medium"})


def test_not_ready_provider_raises_clear_message(client):
    client.put("/api/settings", json={"ai_provider": "openai", "openai_api_key": ""})
    with pytest.raises(ai_auth.AiUnavailable, match="OpenAI API key"):
        ai_auth.call_structured("s", "u", Answer)
