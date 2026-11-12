"""Streaming answers from the chain's providers: text arrives piece by piece while the model writes.

stream_text(adapter, ...) is a generator of ("delta", str) items and ends with one ("usage", dict) item.
Structured answers use the same JSON instruction as ProviderAdapter.generate_structured; the complete text is
validated against the schema at the end (parse_structured), so a streamed answer is checked exactly like a normal one.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import anthropic
import httpx
from pydantic import BaseModel

from app.ai.fast_providers import ClaudeAdapter, OpenAIResponsesAdapter, _claude_error
from app.ai.providers import (
    AIProviderResponseError,
    AIProviderUnavailable,
    GeminiAdapter,
    GeminiHTTPError,
    GeminiTimeout,
    _google_error,
    _strip_json_fence,
)

Item = tuple[str, Any]


def structured_system(system_prompt: str | None, schema: type[BaseModel] | None) -> str | None:
    if schema is None:
        return system_prompt
    instruction = (
        "Return only a JSON value conforming to this JSON Schema; do not include markdown or commentary:\n"
        + json.dumps(schema.model_json_schema())
    )
    return "\n\n".join(part for part in (system_prompt, instruction) if part)


def parse_structured(text: str, schema: type[BaseModel]) -> tuple[dict[str, Any] | None, list[str]]:
    try:
        return schema.model_validate(json.loads(_strip_json_fence(text))).model_dump(mode="json"), []
    except (json.JSONDecodeError, ValueError) as exc:
        return None, [str(exc)]


def _sse_events(response: httpx.Response) -> Iterator[dict[str, Any]]:
    """JSON payloads of a server-sent-events response ('data: {...}' lines)."""
    for line in response.iter_lines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            yield json.loads(data)
        except json.JSONDecodeError:
            continue


def _stream_claude(adapter: ClaudeAdapter, model: str, prompt: str, system: str | None, max_tokens: int) -> Iterator[Item]:
    kwargs: dict[str, Any] = {
        "model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}],
        "output_config": {"effort": adapter.request_options.get("effort", "low")},
    }
    if system:
        kwargs["system"] = system
    if adapter.request_options.get("speed") == "fast":
        kwargs["speed"] = "fast"
    try:
        with adapter.sdk.messages.stream(**kwargs) as stream:
            for text in stream.text_stream:
                if text:
                    yield ("delta", text)
            message = stream.get_final_message()
    except anthropic.APITimeoutError:
        raise AIProviderUnavailable("The AI provider request timed out.") from None
    except anthropic.APIError as exc:
        raise AIProviderUnavailable(_claude_error(exc)) from None
    if message.stop_reason == "refusal":
        raise AIProviderResponseError("Claude declined the request (refusal).")
    if message.stop_reason == "max_tokens":
        raise AIProviderResponseError(f"Claude used the whole output limit ({max_tokens} tokens) before it finished.")
    usage = {"input_tokens": message.usage.input_tokens, "output_tokens": message.usage.output_tokens}
    if getattr(message.usage, "speed", None):
        usage["speed"] = str(message.usage.speed)
    yield ("usage", usage)


def _stream_openai(adapter: OpenAIResponsesAdapter, model: str, prompt: str, system: str | None, max_tokens: int,
                   json_mode: bool) -> Iterator[Item]:
    body: dict[str, Any] = {
        "model": model, "input": prompt, "stream": True, "max_output_tokens": max_tokens,
        "reasoning": {"effort": adapter.request_options.get("effort", "low")},
    }
    if system:
        body["instructions"] = system
    if adapter.request_options.get("service_tier"):
        body["service_tier"] = adapter.request_options["service_tier"]
    if json_mode:
        body["text"] = {"format": {"type": "json_object"}}
    usage: dict[str, Any] = {}
    try:
        with adapter.client.stream("POST", f"{adapter.base_url}/responses", json=body, headers=adapter._headers(),
                                   timeout=adapter.timeout) as response:
            if response.is_error:
                response.read()
                detail = ""
                try:
                    detail = " ".join(str((response.json().get("error") or {}).get("message", "")).split())[:300]
                except (ValueError, AttributeError):
                    pass
                raise AIProviderUnavailable(f"The AI provider returned HTTP {response.status_code}.{f' OpenAI: {detail}' if detail else ''}")
            for event in _sse_events(response):
                kind = event.get("type", "")
                if kind == "response.output_text.delta" and event.get("delta"):
                    yield ("delta", event["delta"])
                elif kind in {"response.completed", "response.incomplete"}:
                    resp = event.get("response") or {}
                    if kind == "response.incomplete" or resp.get("status") == "incomplete":
                        reason = (resp.get("incomplete_details") or {}).get("reason", "unknown")
                        raise AIProviderResponseError(f"GPT stopped before it finished ({reason}).")
                    u = resp.get("usage") or {}
                    usage = {"input_tokens": u.get("input_tokens"), "output_tokens": u.get("output_tokens")}
                    if resp.get("service_tier"):
                        usage["service_tier"] = resp["service_tier"]
                elif kind in {"response.failed", "error"}:
                    err = (event.get("response") or {}).get("error") or event.get("error") or {}
                    raise AIProviderUnavailable(f"GPT failed: {str(err.get('message', 'unknown error'))[:300]}")
    except httpx.TimeoutException:
        raise AIProviderUnavailable("The AI provider request timed out.") from None
    except httpx.HTTPError:
        raise AIProviderUnavailable("The AI provider could not be reached.") from None
    yield ("usage", usage)


def _stream_gemini(adapter: GeminiAdapter, model: str, prompt: str, system: str | None, max_tokens: int,
                   json_mode: bool) -> Iterator[Item]:
    if not adapter.api_key:
        raise AIProviderUnavailable("A Gemini API key is not configured.")
    body: dict[str, Any] = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"maxOutputTokens": max_tokens}}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"
    usage: dict[str, Any] = {}
    finish = None
    wrote = False
    try:
        with adapter.client.stream("POST", f"{adapter.base_url}/models/{model.removeprefix('models/')}:streamGenerateContent",
                                   params={"alt": "sse"}, json=body, headers=adapter._headers(), timeout=adapter.timeout) as response:
            if response.is_error:
                response.read()
                raise GeminiHTTPError(response.status_code, _google_error(response))
            for chunk in _sse_events(response):
                candidate = (chunk.get("candidates") or [{}])[0]
                for part in (candidate.get("content") or {}).get("parts") or []:
                    if isinstance(part.get("text"), str) and part["text"] and not part.get("thought"):
                        wrote = True
                        yield ("delta", part["text"])
                finish = candidate.get("finishReason") or finish
                if isinstance(chunk.get("usageMetadata"), dict):
                    usage = dict(chunk["usageMetadata"])
    except httpx.TimeoutException:
        raise GeminiTimeout("The AI provider request timed out.") from None
    except httpx.HTTPError:
        raise AIProviderUnavailable("The AI provider could not be reached.") from None
    if not wrote:
        raise AIProviderResponseError(f"Gemini returned no answer (finish reason {finish or 'unknown'}).")
    yield ("usage", usage)


def stream_text(adapter: Any, model: str, prompt: str, system: str | None, max_tokens: int,
                schema: type[BaseModel] | None = None) -> Iterator[Item]:
    system = structured_system(system, schema)
    if isinstance(adapter, ClaudeAdapter):
        yield from _stream_claude(adapter, model, prompt, system, max_tokens)
    elif isinstance(adapter, OpenAIResponsesAdapter):
        yield from _stream_openai(adapter, model, prompt, system, max_tokens, schema is not None)
    elif isinstance(adapter, GeminiAdapter):
        yield from _stream_gemini(adapter, model, prompt, system, max_tokens, schema is not None)
    else:  # any other adapter: one piece at the end
        response = adapter.generate(model, prompt, system, None, max_tokens, schema)
        yield ("delta", response.text)
        yield ("usage", response.token_usage)
