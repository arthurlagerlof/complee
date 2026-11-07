from app.core.config import settings
from app.services import ai_builtins


def test_builtin_provider_status_is_environment_managed_and_masks_credentials(api_client, monkeypatch):
    monkeypatch.setattr(settings, "ollama_base_url", "http://127.0.0.1:11434")
    monkeypatch.setattr(settings, "ollama_api_key", "ollama-secret")
    monkeypatch.setattr(settings, "ollama_models", "gemma4:e4b")
    monkeypatch.setattr(settings, "ollama_model", None)
    monkeypatch.setattr(settings, "gemini_api_key", "gemini-secret")
    monkeypatch.setattr(settings, "gemini_model", "gemini-2.5-flash")

    providers = api_client.get("/api/v1/ai/built-in-providers")
    assert providers.status_code == 200
    payload = providers.json()
    assert [provider["id"] for provider in payload] == ["ollama", "gemini"]
    ollama, gemini = payload
    assert ollama["endpoint"] == "http://127.0.0.1:11434"
    assert ollama["models"] == ["gemma4:e4b"]
    assert gemini["models"] == ["gemini-2.5-flash"]
    assert "ollama-secret" not in providers.text
    assert "gemini-secret" not in providers.text
    assert "api_key" not in providers.text

    class Adapter:
        def __init__(self, _endpoint, _api_key, _timeout):
            pass

        def list_models(self):
            return [{"name": "gemma4:e4b"}]

        def close(self):
            pass

    monkeypatch.setattr(ai_builtins, "OllamaAdapter", Adapter)
    monkeypatch.setattr(settings, "ai_allowed_hosts", "localhost,127.0.0.1")
    tested = api_client.post("/api/v1/ai/built-in-providers/ollama/test")
    assert tested.status_code == 200, tested.text
    result = tested.json()
    assert result["connection_status"] == "connected"
    assert result["models"] == ["gemma4:e4b"]
    assert result["available_models"] == ["gemma4:e4b"]
    assert result["last_successful_test_at"]


def test_builtin_provider_connection_failure_is_visible(api_client, monkeypatch):
    monkeypatch.setattr(settings, "ollama_base_url", "http://127.0.0.1:11434")
    monkeypatch.setattr(settings, "ollama_models", "")

    class Adapter:
        def __init__(self, _endpoint, _api_key, _timeout):
            pass

        def list_models(self):
            from app.ai.providers import AIProviderUnavailable

            raise AIProviderUnavailable("The AI provider could not be reached.")

        def close(self):
            pass

    monkeypatch.setattr(ai_builtins, "OllamaAdapter", Adapter)
    response = api_client.post("/api/v1/ai/built-in-providers/ollama/test")
    assert response.status_code == 502
    status = api_client.get("/api/v1/ai/built-in-providers").json()[0]
    assert status["connection_status"] == "failed"
    assert status["error"] == "The AI provider could not be reached."


def test_unconfigured_builtin_provider_cannot_be_tested(api_client, monkeypatch):
    monkeypatch.setattr(settings, "ollama_base_url", None)
    response = api_client.post("/api/v1/ai/built-in-providers/ollama/test")
    assert response.status_code == 502
    assert "not configured" in response.json()["error"]["message"]
