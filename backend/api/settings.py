import re

from fastapi import APIRouter, HTTPException

from backend.ai_auth import _bedrock_has_default_credentials, active_model, check_connection, provider_of
from backend.config import get_settings, read_overrides, write_overrides
from backend.workspace_schemas import AiCheck, AiSettings, BedrockSettings, KeyedProvider, SettingsOut, SettingsPatch

router = APIRouter()

HOSTNAME = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$")
AWS_REGION = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{1,199}$")
SECRET_FIELDS = ("anthropic_api_key", "openai_api_key", "aws_access_key_id", "aws_secret_access_key", "aws_session_token", "bedrock_api_key")


def _hint(secret: str | None) -> str | None:
    if not secret:
        return None
    return f"{secret[:7]}…{secret[-4:]}" if len(secret) > 14 else "…" + secret[-2:]


def _access_key_hint(key: str | None) -> str | None:
    return f"{key[:4]}…{key[-4:]}" if key and len(key) > 8 else None


def _settings_out() -> SettingsOut:
    s = get_settings()
    effort = s.effort if s.effort in ("low", "medium", "high", "xhigh", "max") else "medium"
    bedrock_auth = s.bedrock_auth if s.bedrock_auth in ("default", "keys", "api_key") else "default"
    return SettingsOut(
        ai=AiSettings(
            provider=provider_of(s),
            configured=s.ai_enabled,
            model=active_model(s),
            effort=effort,
            anthropic=KeyedProvider(key_hint=_hint(s.anthropic_api_key), key_source=s.ai_key_source, model=s.model),
            openai=KeyedProvider(key_hint=_hint(s.openai_api_key), key_source=s.openai_key_source, model=s.openai_model),
            bedrock=BedrockSettings(
                region=s.aws_region,
                auth=bedrock_auth,
                profile=s.aws_profile,
                access_key_hint=_access_key_hint(s.aws_access_key_id),
                has_secret_key=bool(s.aws_secret_access_key),
                has_session_token=bool(s.aws_session_token),
                api_key_hint=_hint(s.bedrock_api_key),
                default_credentials_found=bedrock_auth == "default" and _bedrock_has_default_credentials(s),
                model=s.bedrock_model,
            ),
        ),
        allowed_hosts=sorted(s.allowed_host_set),
        max_concurrency=s.max_concurrency,
        max_requests_per_run=s.max_requests_per_run,
        request_timeout_s=s.request_timeout_s,
    )


def _model(value: str, label: str) -> str:
    value = value.strip()
    if not MODEL_ID.match(value):
        raise HTTPException(status_code=422, detail=f"{label} must be a model id, such as the default shown")
    return value


@router.get("/api/settings", response_model=SettingsOut)
def get_app_settings():
    return _settings_out()


@router.put("/api/settings", response_model=SettingsOut)
def update_app_settings(body: SettingsPatch):
    data_dir = get_settings().data_dir
    current = read_overrides(data_dir)

    for field in SECRET_FIELDS:
        value = getattr(body, field)
        if value is None:
            continue
        value = value.strip()
        if value:
            current[field] = value
        else:
            current.pop(field, None)

    if body.ai_provider is not None:
        current["ai_provider"] = body.ai_provider
    if body.effort is not None:
        current["effort"] = body.effort
    if body.anthropic_model is not None:
        current["model"] = _model(body.anthropic_model, "The Anthropic model")
    if body.openai_model is not None:
        current["openai_model"] = _model(body.openai_model, "The OpenAI model")
    if body.bedrock_model is not None:
        current["bedrock_model"] = _model(body.bedrock_model, "The Bedrock model")
    if body.bedrock_auth is not None:
        current["bedrock_auth"] = body.bedrock_auth
    if body.aws_region is not None:
        region = body.aws_region.strip().lower()
        if region and not AWS_REGION.match(region):
            raise HTTPException(status_code=422, detail="Use an AWS region code such as us-east-1")
        if region:
            current["aws_region"] = region
        else:
            current.pop("aws_region", None)
    if body.aws_profile is not None:
        profile = body.aws_profile.strip()
        if profile:
            current["aws_profile"] = profile
        else:
            current.pop("aws_profile", None)

    if body.allowed_hosts is not None:
        hosts = sorted({h.strip().lower() for h in body.allowed_hosts if h.strip()})
        if not hosts:
            raise HTTPException(status_code=422, detail="Keep at least one allowed host")
        bad = [h for h in hosts if not HOSTNAME.match(h)]
        if bad:
            raise HTTPException(status_code=422, detail=f"Not a hostname: {', '.join(bad)}")
        current["allowed_hosts"] = hosts

    write_overrides(data_dir, current)
    return _settings_out()


@router.post("/api/settings/check-ai", response_model=AiCheck)
def check_ai():
    ok, message = check_connection()
    return AiCheck(ok=ok, message=message)
