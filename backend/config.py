import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
SECRET_KEYS = ("anthropic_api_key", "openai_api_key", "aws_access_key_id", "aws_secret_access_key", "aws_session_token", "bedrock_api_key")
PLAIN_KEYS = ("ai_provider", "model", "openai_model", "bedrock_model", "effort", "aws_region", "aws_profile", "bedrock_auth")
OVERRIDE_KEYS = (*SECRET_KEYS, *PLAIN_KEYS, "allowed_hosts")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", env_prefix="TESTPILOT_", extra="ignore")

    anthropic_api_key: str | None = Field(
        default=None, validation_alias=AliasChoices("ANTHROPIC_API_KEY", "TESTPILOT_ANTHROPIC_API_KEY")
    )
    ai_provider: str = "anthropic"  # "anthropic" | "openai" | "bedrock"
    model: str = "claude-opus-5-5"  # the Anthropic API model
    effort: str = "medium"

    openai_api_key: str | None = Field(default=None, validation_alias=AliasChoices("OPENAI_API_KEY", "TESTPILOT_OPENAI_API_KEY"))
    openai_model: str = "gpt-5.1"

    aws_region: str | None = Field(default=None, validation_alias=AliasChoices("TESTPILOT_AWS_REGION", "AWS_REGION"))
    bedrock_auth: str = "default"  # "default": the AWS credential chain | "keys": access key + secret | "api_key": a Bedrock API key
    aws_profile: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    aws_session_token: str | None = None
    bedrock_api_key: str | None = None
    bedrock_model: str = "anthropic.claude-opus-5-5"

    allowed_hosts: str = "localhost,127.0.0.1"
    request_timeout_s: float = 10.0
    max_concurrency: int = 4
    max_requests_per_run: int = 300
    slow_response_ms: int = 2000
    max_ai_cases: int = 25

    data_dir: Path = ROOT / "data"

    # Set by get_settings(), never read from the environment.
    ai_key_source: str | None = Field(default=None, exclude=True, validation_alias="__testpilot_unused__")
    openai_key_source: str | None = Field(default=None, exclude=True, validation_alias="__testpilot_unused_2__")

    @property
    def allowed_host_set(self) -> set[str]:
        return {h.strip().lower() for h in self.allowed_hosts.split(",") if h.strip()}

    @property
    def ai_enabled(self) -> bool:
        from backend.ai_auth import ai_ready

        return ai_ready(self)


def overrides_path(data_dir: Path) -> Path:
    return data_dir / "settings.json"


def read_overrides(data_dir: Path) -> dict[str, Any]:
    path = overrides_path(data_dir)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in data.items() if k in OVERRIDE_KEYS} if isinstance(data, dict) else {}


def write_overrides(data_dir: Path, data: dict[str, Any]) -> None:
    """Writes the app-level settings readable by the owner only, since they may hold an API key."""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = overrides_path(data_dir)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump({k: v for k, v in data.items() if k in OVERRIDE_KEYS}, fh)
    os.chmod(path, 0o600)
    get_settings.cache_clear()


@lru_cache
def get_settings() -> Settings:
    base = Settings()
    overrides = read_overrides(base.data_dir)
    update: dict[str, Any] = {
        "ai_key_source": "env" if base.anthropic_api_key else None,
        "openai_key_source": "env" if base.openai_api_key else None,
    }
    for key in (*SECRET_KEYS, *PLAIN_KEYS):
        if overrides.get(key):
            update[key] = overrides[key]
    if overrides.get("anthropic_api_key"):
        update["ai_key_source"] = "app"
    if overrides.get("openai_api_key"):
        update["openai_key_source"] = "app"
    if isinstance(overrides.get("allowed_hosts"), list) and overrides["allowed_hosts"]:
        update["allowed_hosts"] = ",".join(overrides["allowed_hosts"])
    return base.model_copy(update=update)
