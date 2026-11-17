"""The AI providers TestPilot can plan and explain with: the Anthropic API, OpenAI, or any model on AWS Bedrock."""

import json
import re
from typing import Any, Literal, TypeVar

import anthropic
import openai
from pydantic import BaseModel, ValidationError

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


# Catalog ids for the bedrock-runtime (InvokeModel) route: cross-region inference profiles such as
# "apac.anthropic.claude-sonnet-4-5-20250929-v1:0", versioned ids ending in ":0", and ARNs.
# Plain "anthropic.claude-…" ids go to Claude in Amazon Bedrock (the Mantle endpoint).
_RUNTIME_MODEL_ID = re.compile(r"^arn:|:\d+$|^(us|eu|apac|jp|au|ca|global|us-gov)\.")


def bedrock_uses_runtime(model: str) -> bool:
    return bool(_RUNTIME_MODEL_ID.search(model.strip()))


def bedrock_is_anthropic(model: str) -> bool:
    """Anthropic models go through the Messages API; every other Bedrock model through Converse. An ARN is tried as Anthropic first."""
    m = model.strip().lower()
    return m.startswith("arn:") or "anthropic." in m or "claude" in m


def _bedrock_client(s: Settings, timeout: float, max_retries: int) -> anthropic.AnthropicBedrockMantle | anthropic.AnthropicBedrock:
    kwargs: dict[str, Any] = {"aws_region": s.aws_region, "timeout": timeout, "max_retries": max_retries}
    if s.bedrock_auth == "keys":
        kwargs.update(aws_access_key=s.aws_access_key_id, aws_secret_key=s.aws_secret_access_key, aws_session_token=s.aws_session_token or None)
    elif s.bedrock_auth == "api_key":
        kwargs["api_key"] = s.bedrock_api_key
    elif s.aws_profile:
        kwargs["aws_profile"] = s.aws_profile
    if bedrock_uses_runtime(s.bedrock_model):
        return anthropic.AnthropicBedrock(**kwargs)
    return anthropic.AnthropicBedrockMantle(**kwargs)


def _bedrock_extra(s: Settings) -> dict[str, Any]:
    """Effort is sent only on the Mantle route; older runtime models reject the field."""
    return {} if bedrock_uses_runtime(s.bedrock_model) else {"output_config": {"effort": s.effort}}


# ---------- every other Bedrock model: the Converse API ----------

CONVERSE_TOOL = "submit_answer"
CONVERSE_MODES = ("tool", "any", "auto", "json")  # forced tool, any tool, optional tool, plain JSON text
MIN_CONVERSE_TOKENS = 2048


def _converse_client(s: Settings, timeout: float, max_retries: int) -> Any:
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config

    config = Config(region_name=s.aws_region, read_timeout=timeout, connect_timeout=10, retries={"max_attempts": max_retries + 1, "mode": "standard"})
    if s.bedrock_auth == "api_key":
        # A Bedrock API key is a bearer token: skip SigV4 and send it as the Authorization header.
        client = boto3.Session().client("bedrock-runtime", config=config.merge(Config(signature_version=UNSIGNED)))
        key = s.bedrock_api_key

        def add_bearer(request: Any, **_: Any) -> None:
            request.headers["Authorization"] = f"Bearer {key}"

        client.meta.events.register_first("before-send.bedrock-runtime.*", add_bearer)
        return client
    if s.bedrock_auth == "keys":
        return boto3.Session(
            aws_access_key_id=s.aws_access_key_id, aws_secret_access_key=s.aws_secret_access_key, aws_session_token=s.aws_session_token or None
        ).client("bedrock-runtime", config=config)
    return boto3.Session(profile_name=s.aws_profile or None).client("bedrock-runtime", config=config)


def _inline_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Inlines $defs so models with simple JSON Schema support can read it."""
    from backend.spec_parser import _resolve

    resolved = _resolve(schema, schema)
    resolved.pop("$defs", None)
    return resolved


def _converse_request(model: str, system: str, user: str, schema: dict[str, Any], mode: str, max_tokens: int) -> dict[str, Any]:
    if mode == "json":
        system = f"{system}\n\nReply with one JSON object and nothing else. It must match this JSON Schema:\n{json.dumps(schema)}"
    elif mode != "tool":
        system = f"{system}\n\nGive your answer by calling the {CONVERSE_TOOL} tool."
    req: dict[str, Any] = {
        "modelId": model,
        "system": [{"text": system}],
        "messages": [{"role": "user", "content": [{"text": user}]}],
        "inferenceConfig": {"maxTokens": max_tokens},
    }
    if mode != "json":
        tool = {"toolSpec": {"name": CONVERSE_TOOL, "description": "Submit the final answer.", "inputSchema": {"json": schema}}}
        req["toolConfig"] = {"tools": [tool]}
        if mode == "tool":
            req["toolConfig"]["toolChoice"] = {"tool": {"name": CONVERSE_TOOL}}
        elif mode == "any":
            req["toolConfig"]["toolChoice"] = {"any": {}}
    return req


def _json_from_text(text: str) -> Any:
    text = re.sub(r"<(reasoning|think)>.*?</\1>", "", text, flags=re.S).strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise AiUnavailable("The model answered without the JSON TestPilot asked for. A stronger model may do better.")
    try:
        return json.loads(text[start : end + 1])
    except ValueError as exc:
        raise AiUnavailable("The model's JSON answer could not be read. A stronger model may do better.") from exc


def _converse_result(response: dict[str, Any], output_format: type[M]) -> M:
    content = ((response.get("output") or {}).get("message") or {}).get("content") or []
    tool_input = next((b["toolUse"].get("input") for b in content if "toolUse" in b), None)
    if tool_input is None:
        if response.get("stopReason") == "max_tokens":
            raise AiUnavailable("The model's answer was cut off before it finished")
        tool_input = _json_from_text("".join(b.get("text", "") for b in content))
    if isinstance(tool_input, str):
        tool_input = _json_from_text(tool_input)
    try:
        return output_format.model_validate(tool_input)
    except ValidationError as exc:
        raise AiUnavailable("The model's answer did not have the shape TestPilot asked for. A stronger model may do better.") from exc


def _client_error_message(exc: Exception, s: Settings) -> str:
    from botocore.exceptions import ClientError

    if isinstance(exc, ClientError):
        error = exc.response.get("Error", {})
        code, message = error.get("Code", ""), error.get("Message", "")
        if code in ("UnrecognizedClientException", "InvalidSignatureException", "ExpiredTokenException"):
            return "AWS Bedrock rejected the credentials. Check Settings."
        if code == "AccessDeniedException":
            return f"AWS Bedrock denied access to {s.bedrock_model} in {s.aws_region}: {message} Check that model access is granted."
        if code == "ResourceNotFoundException" or (code == "ValidationException" and "model identifier" in message.lower()):
            return (
                f"AWS Bedrock in {s.aws_region} does not offer the model {s.bedrock_model}. Copy the model id or inference profile id "
                "from the Bedrock console for that region, and check that model access is granted."
            )
        if code in ("ThrottlingException", "ServiceQuotaExceededException"):
            return "Rate limited by AWS Bedrock; try again shortly"
        return f"AWS Bedrock error ({code}): {message}"
    return f"AWS Bedrock could not be used: {exc}"


def _invalid_model(exc: Exception) -> bool:
    from botocore.exceptions import ClientError

    if not isinstance(exc, ClientError):
        return False
    error = exc.response.get("Error", {})
    return error.get("Code") == "ValidationException" and "model identifier" in error.get("Message", "").lower()


def _versioned(model: str) -> str | None:
    """The Bedrock catalog shows ids like openai.gpt-oss-120b; the runtime wants openai.gpt-oss-120b-1:0."""
    return None if re.search(r":\d+$", model) or model.startswith("arn:") else f"{model}-1:0"


def _token_limit_error(message: str) -> bool:
    low = message.lower().replace(" ", "").replace("_", "")
    return "maxtokens" in low or "maximumtokens" in low or "outputtokens" in low


def converse_structured(s: Settings, system: str, user: str, output_format: type[M], max_tokens: int) -> M:
    """Structured output from any Bedrock model: a forced tool call where the model supports it, plain JSON where it does not."""
    from botocore.exceptions import BotoCoreError, ClientError

    client = _converse_client(s, 240.0, 2)
    schema = _inline_refs(output_format.model_json_schema())
    model, mode, tokens = s.bedrock_model, 0, max_tokens
    for _ in range(9):
        try:
            response = client.converse(**_converse_request(model, system, user, schema, CONVERSE_MODES[mode], tokens))
        except ClientError as exc:
            if _invalid_model(exc) and model == s.bedrock_model and _versioned(model):
                model = _versioned(model)
                continue
            error = exc.response.get("Error", {})
            message = error.get("Message", "")
            if error.get("Code") == "ValidationException":
                if _token_limit_error(message) and tokens > MIN_CONVERSE_TOKENS:
                    tokens = max(MIN_CONVERSE_TOKENS, tokens // 2)
                    continue
                if "tool" in message.lower() and mode < len(CONVERSE_MODES) - 1:
                    mode += 1
                    continue
            raise AiUnavailable(_client_error_message(exc, s)) from exc
        except BotoCoreError as exc:
            raise AiUnavailable(_client_error_message(exc, s)) from exc
        return _converse_result(response, output_format)
    raise AiUnavailable("AWS Bedrock rejected every request shape TestPilot tried for this model")


def _converse_check(s: Settings) -> str:
    """One tiny request; returns the model id that answered."""
    client = _converse_client(s, 30.0, 0)
    request = {"messages": [{"role": "user", "content": [{"text": "Reply with the word ready."}]}], "inferenceConfig": {"maxTokens": 256}}
    try:
        client.converse(modelId=s.bedrock_model, **request)
        return s.bedrock_model
    except Exception as exc:
        versioned = _versioned(s.bedrock_model)
        if not (_invalid_model(exc) and versioned):
            raise
        try:
            client.converse(modelId=versioned, **request)
        except Exception:
            raise exc
        return versioned


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


def _claude_errors(exc: Exception, provider_name: str, s: Settings | None = None) -> AiUnavailable:
    if isinstance(exc, anthropic.AuthenticationError):
        return AiUnavailable(f"{provider_name} rejected the credentials. Check Settings.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        extra = " Enable access to this Claude model in the Bedrock console for your region." if provider_name == "AWS Bedrock" else ""
        return AiUnavailable(f"{provider_name} denied access to the model.{extra}")
    if isinstance(exc, anthropic.NotFoundError):
        if provider_name == "AWS Bedrock" and s is not None:
            return AiUnavailable(
                f"AWS Bedrock in {s.aws_region} does not offer the model {s.bedrock_model}. Copy the model id or inference profile id "
                "from the Bedrock console for that region, and check that model access is granted."
            )
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

    if provider == "bedrock" and not bedrock_is_anthropic(s.bedrock_model):
        return converse_structured(s, _system_text(system), user, output_format, max_tokens)
    try:
        if provider == "bedrock":
            # Bedrock has no server-side fallbacks; a refusal surfaces as a clear message instead.
            response = _bedrock_client(s, 240.0, 2).messages.parse(
                model=s.bedrock_model,
                max_tokens=max_tokens,
                **_bedrock_extra(s),
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
    except anthropic.BadRequestError as exc:
        if provider == "bedrock" and _not_messages_model(exc):  # an ARN that points at a non-Anthropic model
            return converse_structured(s, _system_text(system), user, output_format, max_tokens)
        raise _claude_errors(exc, name, s) from exc
    except anthropic.AnthropicError as exc:
        raise _claude_errors(exc, name, s) from exc
    return _claude_result(response, name)


def _not_messages_model(exc: anthropic.BadRequestError) -> bool:
    return "does not support" in str(exc.message) and "messages" in str(exc.message)


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
        elif provider == "bedrock" and not bedrock_is_anthropic(model):
            model = _converse_check(s)
        elif provider == "bedrock":
            # Bedrock has no Models API, so the check is one tiny real request (a few tokens on your AWS bill).
            _bedrock_client(s, 30.0, 0).messages.create(
                model=model,
                max_tokens=64,
                **({} if bedrock_uses_runtime(model) else {"output_config": {"effort": "low"}}),
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
        return False, str(_claude_errors(exc, name, s))
    except Exception as exc:  # botocore errors: Converse calls and credential or region problems
        return False, _client_error_message(exc, s) if provider == "bedrock" else f"{name} could not be used: {exc}"
    where = f" in {s.aws_region}" if provider == "bedrock" else ""
    return True, f"{name}{where} works. {model} answered."
