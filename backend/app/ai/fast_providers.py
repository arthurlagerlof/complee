"""Adapters for the fast model chain: Claude through the official Anthropic SDK, GPT through the OpenAI Responses API.

Both keep the ProviderAdapter interface (generate / generate_structured / list_models). Per-step options such as
Anthropic fast mode, OpenAI service tiers and the reasoning effort come from ``request_options`` (set by the chain).
"""
from __future__ import annotations

from typing import Any

import anthropic
import httpx
from pydantic import BaseModel

from app.ai.providers import AIProviderResponseError, AIProviderUnavailable, AIResponse, ProviderAdapter


class ClaudeAdapter(ProviderAdapter):
    """Claude via the official SDK. Sampling parameters are not sent: current Claude models reject them."""

    def __init__(self, base_url: str, api_key: str | None, timeout: float, client: Any = None):
        super().__init__(base_url, api_key, timeout, None)
        self.request_options: dict[str, Any] = {}
        # Retries are the chain's job (it moves on to the next model), so the SDK does not retry on its own.
        self.sdk = client or anthropic.Anthropic(api_key=api_key, base_url=base_url or None, timeout=timeout, max_retries=0)

    def close(self) -> None:
        super().close()
        try:
            self.sdk.close()
        except Exception:  # noqa: BLE001
            pass

    def list_models(self) -> list[dict[str, Any]]:
        try:
            return [{"name": m.id, "display_name": getattr(m, "display_name", m.id)} for m in self.sdk.models.list()]
        except anthropic.APIError as exc:
            raise AIProviderUnavailable(_claude_error(exc)) from None

    def get_model_info(self, model_name: str) -> dict[str, Any]:
        return {"id": model_name}

    def generate(
        self,
        model_name: str,
        prompt: str,
        system_prompt: str | None,
        temperature: float | None,
        max_tokens: int | None,
        schema: type[BaseModel] | None = None,
    ) -> AIResponse:
        kwargs: dict[str, Any] = {
            "model": model_name,
            "max_tokens": max_tokens or 4000,
            "messages": [{"role": "user", "content": prompt}],
            "output_config": {"effort": self.request_options.get("effort", "low")},
        }
        if system_prompt:
            kwargs["system"] = system_prompt
        if self.request_options.get("speed") == "fast":
            kwargs["speed"] = "fast"
        try:
            message = self.sdk.messages.create(**kwargs)
        except anthropic.APITimeoutError:
            raise AIProviderUnavailable("The AI provider request timed out.") from None
        except anthropic.APIError as exc:
            raise AIProviderUnavailable(_claude_error(exc)) from None
        if message.stop_reason == "refusal":
            raise AIProviderResponseError("Claude declined the request (refusal).")
        if message.stop_reason == "max_tokens":
            raise AIProviderResponseError(
                f"Claude used the whole output limit ({kwargs['max_tokens']} tokens) before it finished; raise max_tokens."
            )
        text = "".join(block.text for block in message.content if block.type == "text")
        if not text:
            raise AIProviderResponseError("Claude returned no text.")
        usage = message.usage
        token_usage = {"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens}
        speed = getattr(usage, "speed", None)
        if speed:
            token_usage["speed"] = str(speed)
        return AIResponse(text=text, token_usage=token_usage)


def _claude_error(exc: anthropic.APIError) -> str:
    status = getattr(exc, "status_code", None)
    message = " ".join(str(getattr(exc, "message", "") or exc).split())[:300]
    return f"The AI provider returned HTTP {status}. Claude: {message}" if status else f"The AI provider could not be reached. {message}"


class OpenAIResponsesAdapter(ProviderAdapter):
    """GPT models through the Responses API (service tiers fast / ultrafast, reasoning effort)."""

    def __init__(self, base_url: str, api_key: str | None, timeout: float, client: httpx.Client | None = None):
        super().__init__(base_url, api_key, timeout, client)
        self.request_options: dict[str, Any] = {}

    def list_models(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/models", headers=self._headers())
        return [{"name": m["id"], "display_name": m["id"]} for m in result.get("data", []) if isinstance(m, dict) and "id" in m]

    def get_model_info(self, model_name: str) -> dict[str, Any]:
        return {"id": model_name}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self.client.request(method, f"{self.base_url}{path}", timeout=self.timeout, **kwargs)
        except httpx.TimeoutException:
            raise AIProviderUnavailable("The AI provider request timed out.") from None
        except httpx.HTTPError:
            raise AIProviderUnavailable("The AI provider could not be reached.") from None
        if response.is_error:
            detail = ""
            try:
                error = response.json().get("error") or {}
                detail = " ".join(str(error.get("message", "")).split())[:300]
            except (ValueError, AttributeError):
                pass
            raise AIProviderUnavailable(f"The AI provider returned HTTP {response.status_code}.{f' OpenAI: {detail}' if detail else ''}")
        try:
            return response.json()
        except ValueError:
            raise AIProviderResponseError("The AI provider returned invalid JSON.") from None

    def generate(
        self,
        model_name: str,
        prompt: str,
        system_prompt: str | None,
        temperature: float | None,
        max_tokens: int | None,
        schema: type[BaseModel] | None = None,
    ) -> AIResponse:
        body: dict[str, Any] = {
            "model": model_name,
            "input": prompt,
            "reasoning": {"effort": self.request_options.get("effort", "low")},
            "max_output_tokens": max_tokens or 4000,
        }
        if system_prompt:
            body["instructions"] = system_prompt
        if self.request_options.get("service_tier"):
            body["service_tier"] = self.request_options["service_tier"]
        if schema is not None:
            body["text"] = {"format": {"type": "json_object"}}
        result = self._request("POST", "/responses", json=body, headers=self._headers())
        if result.get("status") == "incomplete":
            reason = (result.get("incomplete_details") or {}).get("reason", "unknown")
            raise AIProviderResponseError(f"GPT stopped before it finished ({reason}); raise max_tokens.")
        text = "".join(
            part.get("text", "")
            for item in result.get("output", []) if isinstance(item, dict) and item.get("type") == "message"
            for part in item.get("content", []) if isinstance(part, dict) and part.get("type") == "output_text"
        )
        if not text:
            raise AIProviderResponseError("GPT returned no text.")
        usage = result.get("usage") or {}
        token_usage = {"input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens")}
        if result.get("service_tier"):
            token_usage["service_tier"] = result["service_tier"]
        return AIResponse(text=text, token_usage=token_usage)
