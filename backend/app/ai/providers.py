import json
import time
from dataclasses import dataclass, field
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel

from app.db.models.ai import AIProvider


SchemaT = TypeVar("SchemaT", bound=BaseModel)


class AIProviderError(Exception):
    pass


class AIProviderUnavailable(AIProviderError):
    pass


class AIProviderResponseError(AIProviderError):
    pass


@dataclass
class AIResponse:
    text: str
    token_usage: dict[str, Any] = field(default_factory=dict)
    parsed: dict[str, Any] | list[Any] | None = None
    validation_errors: list[str] = field(default_factory=list)


class ProviderAdapter:
    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        timeout: float,
        client: httpx.Client | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.supported_capabilities: set[str] = set()
        self.client = client or httpx.Client(timeout=timeout, follow_redirects=False)
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self.client.request(method, f"{self.base_url}{path}", timeout=self.timeout, **kwargs)
            response.raise_for_status()
            return response.json()
        except httpx.TimeoutException as exc:
            raise AIProviderUnavailable("The AI provider request timed out.") from exc
        except httpx.HTTPStatusError as exc:
            raise AIProviderUnavailable(
                f"The AI provider returned HTTP {exc.response.status_code}."
            ) from exc
        except httpx.HTTPError as exc:
            raise AIProviderUnavailable("The AI provider could not be reached.") from exc
        except (ValueError, json.JSONDecodeError) as exc:
            raise AIProviderResponseError("The AI provider returned invalid JSON.") from exc

    def test_connection(self) -> dict[str, Any]:
        models = self.list_models()
        return {"connected": True, "model_count": len(models)}

    def list_models(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_model_info(self, model_name: str) -> dict[str, Any]:
        raise NotImplementedError

    def generate(
        self,
        model_name: str,
        prompt: str,
        system_prompt: str | None,
        temperature: float | None,
        max_tokens: int | None,
        schema: type[BaseModel] | None = None,
    ) -> AIResponse:
        raise NotImplementedError

    def generate_structured(
        self,
        model_name: str,
        prompt: str,
        system_prompt: str | None,
        temperature: float | None,
        max_tokens: int | None,
        schema: type[SchemaT],
    ) -> AIResponse:
        schema_instruction = (
            "Return only a JSON value conforming to this JSON Schema; do not include markdown or commentary:\n"
            + json.dumps(schema.model_json_schema())
        )
        structured_system_prompt = "\n\n".join(
            part for part in (system_prompt, schema_instruction) if part
        )
        response = self.generate(
            model_name, prompt, structured_system_prompt, temperature, max_tokens, schema
        )
        try:
            payload = json.loads(_strip_json_fence(response.text))
            parsed = schema.model_validate(payload)
        except (json.JSONDecodeError, ValueError) as exc:
            response.validation_errors = [str(exc)]
            response.parsed = None
            return response
        response.parsed = parsed.model_dump(mode="json")
        return response


class OllamaAdapter(ProviderAdapter):
    def list_models(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/api/tags", headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("Ollama returned an invalid model list.")
        models = result.get("models")
        if not isinstance(models, list):
            raise AIProviderResponseError("Ollama returned an invalid model list.")
        return [
            {"name": item["name"], "display_name": item.get("model", item["name"])}
            for item in models
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        ]

    def get_model_info(self, model_name: str) -> dict[str, Any]:
        result = self._request("POST", "/api/show", json={"name": model_name}, headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("Ollama returned invalid model information.")
        return result

    def generate(
        self,
        model_name: str,
        prompt: str,
        system_prompt: str | None,
        temperature: float | None,
        max_tokens: int | None,
        schema: type[BaseModel] | None = None,
    ) -> AIResponse:
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        body: dict[str, Any] = {"model": model_name, "messages": messages, "stream": False}
        options: dict[str, Any] = {}
        if temperature is not None:
            options["temperature"] = temperature
        if max_tokens is not None:
            options["num_predict"] = max_tokens
        if options:
            body["options"] = options
        if schema is not None and "json_schema" in self.supported_capabilities:
            body["format"] = schema.model_json_schema()
        result = self._request("POST", "/api/chat", json=body, headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("Ollama returned an invalid chat response.")
        try:
            text = result["message"]["content"]
            if not isinstance(text, str):
                raise TypeError
        except (KeyError, TypeError) as exc:
            raise AIProviderResponseError("Ollama returned an invalid chat response.") from exc
        return AIResponse(
            text=text,
            token_usage={
                "input_tokens": result.get("prompt_eval_count"),
                "output_tokens": result.get("eval_count"),
            },
        )


class OpenAICompatibleAdapter(ProviderAdapter):
    def list_models(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/models", headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("The OpenAI-compatible provider returned an invalid model list.")
        models = result.get("data")
        if not isinstance(models, list):
            raise AIProviderResponseError("The OpenAI-compatible provider returned an invalid model list.")
        return [
            {"name": item["id"], "display_name": item["id"]}
            for item in models
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]

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
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        body: dict[str, Any] = {"model": model_name, "messages": messages}
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if schema is not None and "json_object" in self.supported_capabilities:
            body["response_format"] = {"type": "json_object"}
        result = self._request("POST", "/chat/completions", json=body, headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("The OpenAI-compatible provider returned an invalid chat response.")
        try:
            text = result["choices"][0]["message"]["content"]
            if not isinstance(text, str):
                raise TypeError
        except (KeyError, IndexError, TypeError) as exc:
            raise AIProviderResponseError("The OpenAI-compatible provider returned an invalid chat response.") from exc
        usage = result.get("usage")
        return AIResponse(text=text, token_usage=usage if isinstance(usage, dict) else {})


class GeminiAdapter(ProviderAdapter):
    # Temporary overload or server errors are retried after these delays (seconds); quota errors (429) are not.
    # One retry only: an overloaded model usually stays overloaded for minutes, the fallback model answers sooner.
    retry_delays: tuple[float, ...] = (2.0,)
    retry_statuses = {500, 502, 503, 504}

    def __init__(self, *args: Any, fallback_model: str | None = None, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.fallback_model = (fallback_model or "").removeprefix("models/") or None

    def _headers(self) -> dict[str, str]:
        # The key travels in a header, never in the URL: URLs end up in logs and in exception messages.
        return {"x-goog-api-key": self.api_key} if self.api_key else {}

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not self.api_key:
            raise AIProviderUnavailable("A Gemini API key is not configured.")
        headers = {**kwargs.pop("headers", {}), **self._headers()}
        for attempt in range(len(self.retry_delays) + 1):
            try:
                response = self.client.request(
                    method, f"{self.base_url}{path}", headers=headers, timeout=self.timeout, **kwargs
                )
            except httpx.TimeoutException as exc:
                raise GeminiTimeout("The AI provider request timed out.") from None
            except httpx.HTTPError:
                raise AIProviderUnavailable("The AI provider could not be reached.") from None
            if response.status_code in self.retry_statuses and attempt < len(self.retry_delays):
                time.sleep(self.retry_delays[attempt])
                continue
            if response.is_error:
                raise GeminiHTTPError(response.status_code, _google_error(response))
            try:
                return response.json()
            except (ValueError, json.JSONDecodeError) as exc:
                raise AIProviderResponseError("The AI provider returned invalid JSON.") from exc
        raise AssertionError("unreachable")

    def list_models(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/models", params={"pageSize": 1000})
        if not isinstance(result, dict) or not isinstance(result.get("models"), list):
            raise AIProviderResponseError("Gemini returned an invalid model list.")
        models = []
        for item in result["models"]:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                continue
            methods = item.get("supportedGenerationMethods", [])
            if "generateContent" in methods:
                name = item["name"].removeprefix("models/")
                models.append({"name": name, "display_name": item.get("displayName", name)})
        return models

    def get_model_info(self, model_name: str) -> dict[str, Any]:
        name = model_name.removeprefix("models/")
        result = self._request("GET", f"/models/{name}")
        if not isinstance(result, dict):
            raise AIProviderResponseError("Gemini returned invalid model information.")
        return result

    def generate(
        self,
        model_name: str,
        prompt: str,
        system_prompt: str | None,
        temperature: float | None,
        max_tokens: int | None,
        schema: type[BaseModel] | None = None,
    ) -> AIResponse:
        body: dict[str, Any] = {"contents": [{"parts": [{"text": prompt}]}]}
        if system_prompt:
            body["systemInstruction"] = {"parts": [{"text": system_prompt}]}
        generation_config: dict[str, Any] = {}
        if temperature is not None:
            generation_config["temperature"] = temperature
        if max_tokens is not None:
            generation_config["maxOutputTokens"] = max_tokens
        if schema is not None:
            generation_config["responseMimeType"] = "application/json"
        if generation_config:
            body["generationConfig"] = generation_config
        model = model_name.removeprefix("models/")
        fallback_used = None
        try:
            result = self._request("POST", f"/models/{model}:generateContent", json=body)
        except (GeminiHTTPError, GeminiTimeout) as exc:
            # The configured model is overloaded (503, or no answer within the timeout) or its quota is used up (429):
            # answer with the fallback model, if one is set, and record it, so the execution log shows which model
            # really answered. Quotas are counted per model, so the fallback usually still has capacity.
            overloaded = isinstance(exc, GeminiTimeout) or exc.status in {429, 503}
            if not overloaded or not self.fallback_model or self.fallback_model == model:
                raise
            fallback_used = self.fallback_model
            result = self._request("POST", f"/models/{fallback_used}:generateContent", json=body)
        text = _gemini_text(result, max_tokens)
        usage = result.get("usageMetadata") if isinstance(result, dict) else None
        token_usage = dict(usage) if isinstance(usage, dict) else {}
        if fallback_used:
            token_usage["answered_by_fallback_model"] = fallback_used
        return AIResponse(text=text, token_usage=token_usage)


class GeminiTimeout(AIProviderUnavailable):
    pass


class GeminiHTTPError(AIProviderUnavailable):
    def __init__(self, status: int, detail: str):
        self.status = status
        hint = {
            429: " The quota of this API key is used up or the model is not part of its plan (check billing in Google AI Studio).",
            403: " The API key is not allowed to use this API or model.",
            404: " The model name is unknown or no longer offered to this key; set another GEMINI_MODEL.",
            503: " The model is overloaded at the moment; try again later or set GEMINI_FALLBACK_MODEL.",
        }.get(status, "")
        super().__init__(f"The AI provider returned HTTP {status}.{f' Gemini: {detail}' if detail else ''}{hint}")


def _google_error(response: httpx.Response) -> str:
    """Google's own error text (status and message). It never contains the API key."""
    try:
        error = response.json().get("error", {})
    except (ValueError, AttributeError):
        return ""
    if not isinstance(error, dict):
        return ""
    message = " ".join(str(error.get("message", "")).split())
    return f"{error.get('status', '')}: {message}"[:300].strip(": ")


def _gemini_text(result: Any, max_tokens: int | None) -> str:
    """The answer text: every text part of the first candidate except thought summaries."""
    try:
        candidate = result["candidates"][0]
    except (KeyError, IndexError, TypeError) as exc:
        blocked = (result or {}).get("promptFeedback", {}).get("blockReason") if isinstance(result, dict) else None
        if blocked:
            raise AIProviderResponseError(f"Gemini refused the request ({blocked}).") from exc
        raise AIProviderResponseError("Gemini returned an invalid generation response.") from exc
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str) and not p.get("thought"))
    if text:
        return text
    reason = candidate.get("finishReason")
    if reason == "MAX_TOKENS":
        raise AIProviderResponseError(
            f"Gemini used the whole output limit ({max_tokens} tokens) before it answered; "
            "the model's reasoning counts against this limit. Raise max_tokens for this task."
        )
    if reason:
        raise AIProviderResponseError(f"Gemini returned no answer (finish reason {reason}).")
    raise AIProviderResponseError("Gemini returned an invalid generation response.")

def _strip_json_fence(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline >= 0:
            text = text[first_newline + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def adapter_for(
    provider: AIProvider,
    api_key: str | None,
    timeout: float,
    client: httpx.Client | None = None,
) -> ProviderAdapter:
    adapter_type: type[ProviderAdapter]
    if provider.provider_type == "ollama":
        adapter_type = OllamaAdapter
    elif provider.provider_type in {"openai", "openai_compatible"}:
        adapter_type = OpenAICompatibleAdapter
    elif provider.provider_type == "anthropic":
        from app.ai.fast_providers import ClaudeAdapter  # official SDK; imported here to avoid an import cycle

        return ClaudeAdapter(provider.base_url, api_key, timeout)
    elif provider.provider_type == "gemini":
        adapter_type = GeminiAdapter
    else:
        raise AIProviderResponseError("Unsupported AI provider type.")
    if adapter_type is GeminiAdapter:
        from app.core.config import settings

        return GeminiAdapter(provider.base_url, api_key, timeout, client, fallback_model=settings.gemini_fallback_model)
    return adapter_type(provider.base_url, api_key, timeout, client)
