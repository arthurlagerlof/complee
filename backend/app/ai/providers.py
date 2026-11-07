import json
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


class AnthropicAdapter(ProviderAdapter):
    def _headers(self) -> dict[str, str]:
        if not self.api_key:
            raise AIProviderUnavailable("An API key is required for this Anthropic provider.")
        return {"x-api-key": self.api_key, "anthropic-version": "2023-06-01"}

    def list_models(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/v1/models", headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("Anthropic returned an invalid model list.")
        models = result.get("data")
        if not isinstance(models, list):
            raise AIProviderResponseError("Anthropic returned an invalid model list.")
        return [
            {"name": item["id"], "display_name": item.get("display_name", item["id"])}
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
        body: dict[str, Any] = {
            "model": model_name,
            "max_tokens": max_tokens or 2048,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system_prompt:
            body["system"] = system_prompt
        if temperature is not None:
            body["temperature"] = temperature
        result = self._request("POST", "/v1/messages", json=body, headers=self._headers())
        if not isinstance(result, dict):
            raise AIProviderResponseError("Anthropic returned an invalid message response.")
        try:
            text = "".join(
                block["text"] for block in result["content"]
                if isinstance(block, dict) and block.get("type") == "text"
            )
        except (KeyError, TypeError) as exc:
            raise AIProviderResponseError("Anthropic returned an invalid message response.") from exc
        usage = result.get("usage")
        return AIResponse(text=text, token_usage=usage if isinstance(usage, dict) else {})


class GeminiAdapter(ProviderAdapter):
    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not self.api_key:
            raise AIProviderUnavailable("A Gemini API key is not configured.")
        params = dict(kwargs.pop("params", {}))
        params["key"] = self.api_key
        kwargs["params"] = params
        return super()._request(method, path, **kwargs)

    def list_models(self) -> list[dict[str, Any]]:
        result = self._request("GET", "/models")
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
        result = self._request(
            "POST",
            f"/models/{model_name.removeprefix('models/')}:generateContent",
            json=body,
        )
        try:
            text = result["candidates"][0]["content"]["parts"][0]["text"]
            if not isinstance(text, str):
                raise TypeError
        except (KeyError, IndexError, TypeError) as exc:
            raise AIProviderResponseError("Gemini returned an invalid generation response.") from exc
        usage = result.get("usageMetadata")
        return AIResponse(text=text, token_usage=usage if isinstance(usage, dict) else {})


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
        adapter_type = AnthropicAdapter
    else:
        raise AIProviderResponseError("Unsupported AI provider type.")
    return adapter_type(provider.base_url, api_key, timeout, client)
