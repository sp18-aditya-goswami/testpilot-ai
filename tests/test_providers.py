import json
import os
import stat
from types import SimpleNamespace

import anthropic
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


def test_bedrock_catalog_ids_use_the_runtime_client(client):
    client.put("/api/settings", json={"ai_provider": "bedrock", "aws_region": "ap-south-1", "bedrock_auth": "api_key", "bedrock_api_key": "bedrock-api-key-123456789"})
    assert not ai_auth.bedrock_uses_runtime("anthropic.claude-opus-5-5")
    for model in ("apac.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-3-5-sonnet-20241022-v2:0", "global.anthropic.claude-opus-4-8", "arn:aws:bedrock:ap-south-1:1:inference-profile/x"):
        assert ai_auth.bedrock_uses_runtime(model), model
    client.put("/api/settings", json={"bedrock_model": "apac.anthropic.claude-sonnet-4-5-20250929-v1:0"})
    s = ai_auth.get_settings()
    assert isinstance(ai_auth._bedrock_client(s, 5.0, 0), anthropic.AnthropicBedrock)
    assert ai_auth._bedrock_extra(s) == {}
    client.put("/api/settings", json={"bedrock_model": "anthropic.claude-opus-5-5"})
    s = ai_auth.get_settings()
    assert isinstance(ai_auth._bedrock_client(s, 5.0, 0), anthropic.AnthropicBedrockMantle)
    assert ai_auth._bedrock_extra(s) == {"output_config": {"effort": s.effort}}


def _bedrock_settings(client, model):
    client.put("/api/settings", json={"ai_provider": "bedrock", "aws_region": "us-west-2", "bedrock_auth": "api_key", "bedrock_api_key": "bedrock-api-key-123456789", "bedrock_model": model})


class FakeConverse:
    """Stands in for the bedrock-runtime client: replays errors and answers in order, recording each request."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []

    def converse(self, **req):
        self.requests.append(req)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def _validation(message):
    from botocore.exceptions import ClientError

    return ClientError({"Error": {"Code": "ValidationException", "Message": message}}, "Converse")


def test_non_anthropic_bedrock_models_use_converse(client, monkeypatch):
    _bedrock_settings(client, "openai.gpt-oss-120b")
    assert ai_auth.bedrock_is_anthropic("anthropic.claude-opus-5-5") and ai_auth.bedrock_is_anthropic("arn:aws:bedrock:us-west-2:1:application-inference-profile/x")
    assert not ai_auth.bedrock_is_anthropic("openai.gpt-oss-120b") and not ai_auth.bedrock_is_anthropic("meta.llama3-3-70b-instruct-v1:0")

    fake = FakeConverse(
        _validation("This model doesn't support the toolChoice.tool field."),
        {"output": {"message": {"content": [{"toolUse": {"toolUseId": "t1", "name": "submit_answer", "input": {"word": "ready"}}}]}}, "stopReason": "tool_use"},
    )
    monkeypatch.setattr(ai_auth, "_converse_client", lambda *a: fake)
    assert ai_auth.call_structured("be brief", "say ready", Answer).word == "ready"
    first, second = fake.requests
    assert first["modelId"] == "openai.gpt-oss-120b" and first["toolConfig"]["toolChoice"] == {"tool": {"name": "submit_answer"}}
    assert second["toolConfig"]["toolChoice"] == {"any": {}}  # stepped down after the model refused a forced tool
    assert "output_config" not in first

    text_only = FakeConverse(
        _validation("The model does not support tool use."),
        _validation("Tool use is not supported for this model."),
        _validation("Tool use is not supported for this model."),
        {"output": {"message": {"content": [{"reasoningContent": {"reasoningText": {"text": "thinking"}}}, {"text": 'Sure:\n```json\n{"word": "plain"}\n```'}]}}, "stopReason": "end_turn"},
    )
    monkeypatch.setattr(ai_auth, "_converse_client", lambda *a: text_only)
    assert ai_auth.call_structured("s", "u", Answer).word == "plain"
    assert "toolConfig" not in text_only.requests[-1] and "JSON Schema" in text_only.requests[-1]["system"][0]["text"]

    shrink = FakeConverse(_validation("max_tokens must be at most 8192"), {"output": {"message": {"content": [{"text": '{"word": "ok"}'}]}}})
    monkeypatch.setattr(ai_auth, "_converse_client", lambda *a: shrink)
    assert ai_auth.call_structured("s", "u", Answer, max_tokens=16000).word == "ok"
    assert [r["inferenceConfig"]["maxTokens"] for r in shrink.requests] == [16000, 8000]

    versioned = FakeConverse(_validation("The provided model identifier is invalid."), {"output": {"message": {"content": [{"text": '{"word": "v"}'}]}}})
    monkeypatch.setattr(ai_auth, "_converse_client", lambda *a: versioned)
    assert ai_auth.call_structured("s", "u", Answer).word == "v"
    assert [r["modelId"] for r in versioned.requests] == ["openai.gpt-oss-120b", "openai.gpt-oss-120b-1:0"]

    denied = FakeConverse(_validation("The provided model identifier is invalid."), _validation("The provided model identifier is invalid."))
    monkeypatch.setattr(ai_auth, "_converse_client", lambda *a: denied)
    with pytest.raises(ai_auth.AiUnavailable, match="does not offer the model openai.gpt-oss-120b"):
        ai_auth.call_structured("s", "u", Answer)

    check = FakeConverse(_validation("The provided model identifier is invalid."), {"output": {"message": {"content": [{"text": "ready"}]}}})
    monkeypatch.setattr(ai_auth, "_converse_client", lambda *a: check)
    r = client.post("/api/settings/check-ai").json()
    assert r["ok"] and "openai.gpt-oss-120b-1:0 answered" in r["message"]
    client.put("/api/settings", json={"bedrock_model": "anthropic.claude-opus-5-5"})


def test_bedrock_api_key_is_sent_as_a_bearer_token(client):
    from botocore.awsrequest import AWSResponse

    _bedrock_settings(client, "openai.gpt-oss-120b")
    bedrock = ai_auth._converse_client(ai_auth.get_settings(), 5.0, 0)
    seen = {}

    class Raw:
        def stream(self, **_):
            yield json.dumps({"output": {"message": {"role": "assistant", "content": [{"text": "ready"}]}}, "stopReason": "end_turn", "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}, "metrics": {"latencyMs": 1}}).encode()

    def capture(request, **_):
        seen.update(request.headers)
        return AWSResponse(request.url, 200, {"content-type": "application/json"}, Raw())

    bedrock.meta.events.register("before-send.bedrock-runtime.Converse", capture)
    out = bedrock.converse(modelId="openai.gpt-oss-120b", messages=[{"role": "user", "content": [{"text": "hi"}]}])
    assert out["output"]["message"]["content"][0]["text"] == "ready"
    auth = seen["Authorization"]
    assert (auth.decode() if isinstance(auth, bytes) else auth) == "Bearer bedrock-api-key-123456789"
    client.put("/api/settings", json={"bedrock_model": "anthropic.claude-opus-5-5"})


def test_aws_profile_rejects_a_pasted_key(client):
    r = client.put("/api/settings", json={"aws_profile": "ABSK" + "x" * 100 + "="})
    assert r.status_code == 422 and "short name" in r.json()["detail"]
    assert client.put("/api/settings", json={"aws_profile": "work-sso"}).json()["ai"]["bedrock"]["profile"] == "work-sso"
    client.put("/api/settings", json={"aws_profile": ""})
