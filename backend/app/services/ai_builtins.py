from datetime import datetime, timezone
from threading import Lock
from typing import Any
from urllib.parse import urlsplit

from app.ai.providers import AIProviderError, AIProviderUnavailable, GeminiAdapter, OllamaAdapter, ProviderAdapter
from app.core.config import settings
from app.ai.schemas import normalize_provider_url, validate_provider_transport
from app.services.ai import AIConfigurationError, _validate_provider_destination


_test_status: dict[str, dict[str, Any]] = {}
_status_lock = Lock()


def _builtin(provider_id: str) -> dict[str, Any]:
    if provider_id == "ollama":
        endpoint = settings.ollama_base_url.rstrip("/") if settings.ollama_base_url else None
        return {
            "id": "ollama",
            "name": "Ollama",
            "provider_type": "ollama",
            "endpoint": endpoint,
            "configured": bool(endpoint),
            "models": settings.ollama_configured_models,
        }
    if provider_id == "gemini":
        endpoint = settings.gemini_base_url.rstrip("/")
        return {
            "id": "gemini",
            "name": "Gemini",
            "provider_type": "gemini",
            "endpoint": endpoint,
            "configured": bool(settings.gemini_api_key),
            "models": [settings.gemini_model.removeprefix("models/")] if settings.gemini_model else [],
        }
    raise AIConfigurationError("Unknown built-in AI provider.")


def list_builtins() -> list[dict[str, Any]]:
    with _status_lock:
        return [
            {**_builtin(provider_id), **_test_status.get(provider_id, {})}
            for provider_id in ("ollama", "gemini")
        ]


def _validate_destination(endpoint: str, *, is_gemini: bool) -> None:
    try:
        normalized = normalize_provider_url(endpoint)
        parsed = urlsplit(normalized)
    except ValueError as exc:
        raise AIConfigurationError("The configured AI provider URL is invalid.") from exc
    if is_gemini:
        if (
            parsed.scheme != "https"
            or parsed.hostname != "generativelanguage.googleapis.com"
            or parsed.port not in {None, 443}
        ):
            raise AIConfigurationError("The Gemini endpoint must use the official Google Generative Language API host.")
        return
    try:
        validate_provider_transport("ollama", normalized, settings.ollama_api_key)
    except ValueError as exc:
        raise AIConfigurationError(str(exc)) from exc
    placeholder = type(
        "ProviderEndpoint", (), {"base_url": endpoint, "provider_type": "ollama"}
    )()
    _validate_provider_destination(placeholder)


def _adapter(provider: dict[str, Any]) -> ProviderAdapter:
    if not provider["configured"]:
        raise AIProviderUnavailable(f"{provider['name']} is not configured on the backend.")
    endpoint = provider["endpoint"]
    _validate_destination(endpoint, is_gemini=provider["id"] == "gemini")
    if provider["id"] == "ollama":
        return OllamaAdapter(endpoint, settings.ollama_api_key, settings.ai_request_timeout_seconds)
    return GeminiAdapter(endpoint, settings.gemini_api_key, settings.ai_request_timeout_seconds)


def test_builtin(provider_id: str) -> dict[str, Any]:
    provider = _builtin(provider_id)
    attempted_at = datetime.now(timezone.utc)
    adapter: ProviderAdapter | None = None
    try:
        adapter = _adapter(provider)
        discovered = adapter.list_models()
        configured_names = set(provider["models"])
        if configured_names:
            configured_models = [model for model in discovered if model["name"] in configured_names]
            missing_models = sorted(configured_names - {model["name"] for model in configured_models})
        else:
            configured_models = discovered
            missing_models = []
        status = {
            "connection_status": "connected",
            "last_tested_at": attempted_at,
            "last_successful_test_at": attempted_at,
            "available_models": [model["name"] for model in discovered],
            "model_count": len(configured_models),
            "missing_models": missing_models,
            "error": None,
        }
        with _status_lock:
            _test_status[provider_id] = status
        return {**provider, **status}
    except AIConfigurationError as exc:
        status = {
            "connection_status": "failed",
            "last_tested_at": attempted_at,
            "last_successful_test_at": _test_status.get(provider_id, {}).get("last_successful_test_at"),
            "error": str(exc),
        }
        with _status_lock:
            _test_status[provider_id] = status
        raise
    except AIProviderError as exc:
        status = {
            "connection_status": "failed",
            "last_tested_at": attempted_at,
            "last_successful_test_at": _test_status.get(provider_id, {}).get("last_successful_test_at"),
            "error": str(exc),
        }
        with _status_lock:
            _test_status[provider_id] = status
        raise
    finally:
        if adapter is not None:
            adapter.close()


def get_builtin(provider_id: str) -> dict[str, Any]:
    provider = _builtin(provider_id)
    with _status_lock:
        return {**provider, **_test_status.get(provider_id, {})}
