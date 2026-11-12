"""The AI providers TestPilot can plan and explain with: the Anthropic API, OpenAI, or Claude on AWS Bedrock."""

from typing import Any, Literal, TypeVar

import anthropic
import openai
from pydantic import BaseModel

from backend.config import Settings, get_settings

Provider = Literal["anthropic", "openai", "bedrock"]
PROVIDER_NAMES: dict[str, str] = {"anthropic": "Anthropic API", "openai": "OpenAI", "bedrock": "AWS Bedrock"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"
OPENAI_EFFORT = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}

M = TypeVar("M", bound=BaseModel)


class AiUnavailable(RuntimeError):
    pass


def provider_of(s: Settings) -> Provider:
    return s.ai_provider if s.ai_provider in PROVIDER_NAMES else "anthropic"  # type: ignore[return-value]


def active_model(s: Settings) -> str:
    return {"anthropic": s.model, "openai": s.openai_model, "bedrock": s.bedrock_model}[provider_of(s)]


def _bedrock_has_default_credentials(s: Settings) -> bool:
    try:
        import boto3

        session = boto3.Session(profile_name=s.aws_profile or None, region_name=s.aws_region)
        return session.get_credentials() is not None
    except Exception:
        return False


def ai_ready(settings: Settings | None = None) -> bool:
    s = settings or get_settings()
    provider = provider_of(s)
    if provider == "openai":
        return bool(s.openai_api_key)
    if provider == "bedrock":
        if not s.aws_region:
            return False
        if s.bedrock_auth == "keys":
            return bool(s.aws_access_key_id and s.aws_secret_access_key)
        if s.bedrock_auth == "api_key":
            return bool(s.bedrock_api_key)
        return _bedrock_has_default_credentials(s)
    return bool(s.anthropic_api_key)


def _not_ready_message(s: Settings) -> str:
    provider = provider_of(s)
    if provider == "openai":
        return "Add an OpenAI API key in Settings"
    if provider == "bedrock":
        if not s.aws_region:
            return "Choose an AWS region for Bedrock in Settings"
        if s.bedrock_auth == "keys":
            return "Add an AWS access key and secret for Bedrock in Settings"
        if s.bedrock_auth == "api_key":
            return "Add a Bedrock API key in Settings"
        return "No AWS credentials found on the backend machine. Configure the AWS CLI, or add keys in Settings"
    return "Add an Anthropic API key in Settings"


def _anthropic_client(s: Settings, timeout: float, max_retries: int) -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=s.anthropic_api_key, timeout=timeout, max_retries=max_retries)


def _bedrock_client(s: Settings, timeout: float, max_retries: int) -> anthropic.AnthropicBedrockMantle:
    kwargs: dict[str, Any] = {"aws_region": s.aws_region, "timeout": timeout, "max_retries": max_retries}
    if s.bedrock_auth == "keys":
        kwargs.update(aws_access_key=s.aws_access_key_id, aws_secret_key=s.aws_secret_access_key, aws_session_token=s.aws_session_token or None)
    elif s.bedrock_auth == "api_key":
        kwargs["api_key"] = s.bedrock_api_key
    elif s.aws_profile:
        kwargs["aws_profile"] = s.aws_profile
    return anthropic.AnthropicBedrockMantle(**kwargs)


def _openai_client(s: Settings, timeout: float, max_retries: int) -> openai.OpenAI:
    return openai.OpenAI(api_key=s.openai_api_key, timeout=timeout, max_retries=max_retries)


def _system_text(system: str | list[dict[str, Any]]) -> str:
    if isinstance(system, str):
        return system
    return "\n\n".join(block.get("text", "") for block in system)


def _claude_result(response: Any, provider_name: str) -> Any:
    if response.stop_reason == "refusal":
        category = response.stop_details.category if getattr(response, "stop_details", None) else None
        raise AiUnavailable(f"The model declined this request (category: {category})")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise AiUnavailable("The model's answer was cut off before it finished")
    return response.parsed_output


def _claude_errors(exc: Exception, provider_name: str) -> AiUnavailable:
    if isinstance(exc, anthropic.AuthenticationError):
        return AiUnavailable(f"{provider_name} rejected the credentials. Check Settings.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        extra = " Enable access to this Claude model in the Bedrock console for your region." if provider_name == "AWS Bedrock" else ""
        return AiUnavailable(f"{provider_name} denied access to the model.{extra}")
    if isinstance(exc, anthropic.NotFoundError):
        return AiUnavailable(f"{provider_name} does not know this model id. Check the model in Settings.")
    if isinstance(exc, anthropic.RateLimitError):
        return AiUnavailable(f"Rate limited by {provider_name}; try again shortly")
    if isinstance(exc, anthropic.APIStatusError):
        return AiUnavailable(f"{provider_name} error {exc.status_code}: {exc.message}")
    if isinstance(exc, anthropic.APIConnectionError):
        return AiUnavailable(f"Could not reach {provider_name}")
    return AiUnavailable(f"{provider_name} could not be used: {exc}")


def call_structured(system: str | list[dict[str, Any]], user: str, output_format: type[M], max_tokens: int = 16000) -> M:
    """One request, one validated Pydantic object back, whichever provider is selected."""
    s = get_settings()
    if not ai_ready(s):
        raise AiUnavailable(_not_ready_message(s))
    provider = provider_of(s)
    name = PROVIDER_NAMES[provider]
    messages = [{"role": "user", "content": user}]

    if provider == "openai":
        try:
            response = _openai_client(s, 240.0, 2).responses.parse(
                model=s.openai_model,
                instructions=_system_text(system),
                input=user,
                text_format=output_format,
                reasoning={"effort": OPENAI_EFFORT.get(s.effort, "medium")},
                max_output_tokens=max(max_tokens * 2, 32000),
                store=False,
            )
        except openai.AuthenticationError as exc:
            raise AiUnavailable("OpenAI rejected the API key. Check Settings.") from exc
        except openai.NotFoundError as exc:
            raise AiUnavailable(f"OpenAI does not know the model {s.openai_model}. Check Settings.") from exc
        except openai.RateLimitError as exc:
            raise AiUnavailable("Rate limited by OpenAI, or the account is out of credit") from exc
        except openai.APIStatusError as exc:
            raise AiUnavailable(f"OpenAI error {exc.status_code}: {exc.message}") from exc
        except openai.APIConnectionError as exc:
            raise AiUnavailable("Could not reach OpenAI") from exc
        if response.status == "incomplete":
            raise AiUnavailable("The model's answer was cut off before it finished")
        if response.output_parsed is None:
            raise AiUnavailable("The model declined this request or returned no usable answer")
        return response.output_parsed

    try:
        if provider == "bedrock":
            # Bedrock has no server-side fallbacks; a refusal surfaces as a clear message instead.
            response = _bedrock_client(s, 240.0, 2).messages.parse(
                model=s.bedrock_model,
                max_tokens=max_tokens,
                output_config={"effort": s.effort},
                system=system,
                messages=messages,
                output_format=output_format,
            )
        else:
            response = _anthropic_client(s, 240.0, 2).beta.messages.parse(
                model=s.model,
                max_tokens=max_tokens,
                betas=[FALLBACK_BETA],
                fallbacks="default",
                output_config={"effort": s.effort},
                system=system,
                messages=messages,
                output_format=output_format,
            )
    except anthropic.AnthropicError as exc:
        raise _claude_errors(exc, name) from exc
    return _claude_result(response, name)


def check_connection() -> tuple[bool, str]:
    s = get_settings()
    if not ai_ready(s):
        return False, _not_ready_message(s) + "."
    provider = provider_of(s)
    name = PROVIDER_NAMES[provider]
    model = active_model(s)
    try:
        if provider == "openai":
            _openai_client(s, 20.0, 0).models.retrieve(model)
        elif provider == "bedrock":
            # Bedrock has no Models API, so the check is one tiny real request (a few tokens on your AWS bill).
            _bedrock_client(s, 30.0, 0).messages.create(
                model=model,
                max_tokens=64,
                output_config={"effort": "low"},
                messages=[{"role": "user", "content": "Reply with the word ready."}],
            )
        else:
            _anthropic_client(s, 20.0, 0).models.retrieve(model)
    except openai.AuthenticationError:
        return False, "OpenAI rejected the API key."
    except openai.NotFoundError:
        return False, f"OpenAI does not offer the model {model} to this key."
    except openai.APIStatusError as exc:
        return False, f"OpenAI error {exc.status_code}."
    except openai.APIConnectionError:
        return False, "Could not reach OpenAI."
    except anthropic.AnthropicError as exc:
        return False, str(_claude_errors(exc, name))
    except Exception as exc:  # botocore credential and region errors on Bedrock
        return False, f"{name} could not be used: {exc}"
    return True, f"{name} works. {model} is available."
