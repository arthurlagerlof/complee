import json

import httpx
import pytest
from pydantic import BaseModel

from app.ai.providers import (
    AIProviderResponseError,
    AIProviderUnavailable,
    GeminiAdapter,
    OllamaAdapter,
    OpenAICompatibleAdapter,
)


class Output(BaseModel):
    answer: str


def test_ollama_list_and_structured_generation_use_http_api():
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "gemma4:e4b"}]})
        if request.url.path == "/api/chat":
            return httpx.Response(
                200,
                json={
                    "message": {"content": '{"answer":"supported"}'},
                    "prompt_eval_count": 12,
                    "eval_count": 4,
                },
            )
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    adapter = OllamaAdapter("http://ollama.test", None, 2, client)
    adapter.supported_capabilities.add("json_schema")
    assert adapter.list_models() == [{"name": "gemma4:e4b", "display_name": "gemma4:e4b"}]
    response = adapter.generate_structured("gemma4:e4b", "prompt", None, 0, 100, Output)
    assert response.parsed == {"answer": "supported"}
    assert response.token_usage == {"input_tokens": 12, "output_tokens": 4}
    request_payload = json.loads(requests[-1].content)
    assert request_payload["format"] == Output.model_json_schema()
    assert request_payload["stream"] is False
    adapter.close()
    client.close()


def test_structured_response_validation_reports_malformed_json():
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200, json={"message": {"content": '{"answer":'}}, request=_request
            )
        )
    )
    adapter = OllamaAdapter("http://ollama.test", None, 2, client)
    response = adapter.generate_structured("model", "prompt", None, None, None, Output)
    assert response.parsed is None
    assert response.validation_errors
    adapter.close()
    client.close()


def test_openai_compatible_adapter_sends_auth_and_normalizes_response():
    def handler(request):
        assert request.headers["authorization"] == "Bearer test-secret"
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "answer"}}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 2},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    adapter = OpenAICompatibleAdapter("https://provider.test/v1", "test-secret", 2, client)
    response = adapter.generate("model", "prompt", None, 0.1, 50)
    assert response.text == "answer"
    assert response.token_usage == {"prompt_tokens": 7, "completion_tokens": 2}
    adapter.close()
    client.close()


def test_provider_rejects_malformed_model_list():
    client = httpx.Client(
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={"models": "invalid"}))
    )
    adapter = OllamaAdapter("http://ollama.test", None, 2, client)
    with pytest.raises(AIProviderResponseError, match="invalid model list"):
        adapter.list_models()
    adapter.close()
    client.close()


def test_ollama_adapter_uses_optional_bearer_token():
    def handler(request):
        assert request.headers["authorization"] == "Bearer gateway-token"
        return httpx.Response(200, json={"models": []})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    adapter = OllamaAdapter("http://ollama.test", "gateway-token", 2, client)
    assert adapter.list_models() == []
    adapter.close()
    client.close()


def test_provider_timeout_is_reported_as_unavailable():
    def timeout(_request):
        raise httpx.ReadTimeout("provider timed out")

    client = httpx.Client(transport=httpx.MockTransport(timeout))
    adapter = OllamaAdapter("http://ollama.test", None, 2, client)
    with pytest.raises(AIProviderUnavailable, match="timed out"):
        adapter.list_models()
    adapter.close()
    client.close()


def test_gemini_model_discovery_and_generation_use_google_api():
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/models"):
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "models/gemini-2.5-flash",
                            "displayName": "Gemini 2.5 Flash",
                            "supportedGenerationMethods": ["generateContent"],
                        },
                        {
                            "name": "models/text-embedding",
                            "supportedGenerationMethods": ["embedContent"],
                        },
                    ],
                },
            )
        return httpx.Response(
            200,
            json={
                "candidates": [{"content": {"parts": [{"text": '{"answer":"ok"}'}]}}],
                "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 3},
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    adapter = GeminiAdapter(
        "https://generativelanguage.googleapis.com/v1beta",
        "test-gemini-secret",
        2,
        client,
    )
    assert adapter.list_models() == [
        {"name": "gemini-2.5-flash", "display_name": "Gemini 2.5 Flash"}
    ]
    response = adapter.generate("gemini-2.5-flash", "prompt", None, 0, 100, Output)
    assert response.text == '{"answer":"ok"}'
    assert response.token_usage == {"promptTokenCount": 8, "candidatesTokenCount": 3}
    assert requests[0].headers["x-goog-api-key"] == "test-gemini-secret"
    assert "key" not in requests[0].url.params, "the API key is never part of a URL"
    assert requests[1].url.path.endswith("/models/gemini-2.5-flash:generateContent")
    adapter.close()
    client.close()


def _gemini(handler, **kwargs):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    adapter = GeminiAdapter("https://generativelanguage.googleapis.com/v1beta", "secret", 2, client, **kwargs)
    adapter.retry_delays = (0,)
    return adapter, client


def _ok(text, **extra):
    return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": text}]}, **extra}], "usageMetadata": {}})


def test_gemini_retries_overload_then_answers():
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) < 2:
            return httpx.Response(503, json={"error": {"status": "UNAVAILABLE", "message": "high demand"}})
        return _ok("ok")

    adapter, client = _gemini(handler)
    assert adapter.generate("gemini-x", "p", None, None, 10).text == "ok"
    assert len(calls) == 2
    client.close()


def test_gemini_falls_back_when_overloaded_and_records_it():
    seen = []

    def handler(request):
        seen.append(request.url.path.rsplit("/", 1)[-1])
        if "gemini-main" in request.url.path:
            return httpx.Response(503, json={"error": {"status": "UNAVAILABLE", "message": "high demand"}})
        return _ok("from fallback")

    adapter, client = _gemini(handler, fallback_model="models/gemini-lite")
    response = adapter.generate("gemini-main", "p", None, None, 10)
    assert response.text == "from fallback"
    assert response.token_usage["answered_by_fallback_model"] == "gemini-lite"
    assert seen == ["gemini-main:generateContent"] * 2 + ["gemini-lite:generateContent"]
    client.close()


def test_gemini_errors_carry_googles_reason_but_never_the_key():
    def handler(request):
        return httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED", "message": "You exceeded your current quota."}})

    adapter, client = _gemini(handler)
    with pytest.raises(AIProviderUnavailable) as info:
        adapter.generate("gemini-main", "p", None, None, 10)
    message = str(info.value)
    assert "HTTP 429" in message and "RESOURCE_EXHAUSTED" in message and "billing" in message
    assert "secret" not in message and info.value.__cause__ is None
    client.close()


def test_gemini_text_skips_thoughts_and_explains_an_exhausted_output_limit():
    def thoughts(request):
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [
            {"text": "thinking...", "thought": True}, {"text": "Hello "}, {"text": "world", "thoughtSignature": "x"}]}}]})

    adapter, client = _gemini(thoughts)
    assert adapter.generate("m", "p", None, None, 100).text == "Hello world"
    client.close()

    def exhausted(request):
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model"}, "finishReason": "MAX_TOKENS"}]})

    adapter, client = _gemini(exhausted)
    with pytest.raises(AIProviderResponseError, match="output limit"):
        adapter.generate("m", "p", None, None, 50)
    client.close()


def test_gemini_quota_or_timeout_on_the_main_model_uses_the_fallback():
    def quota(request):
        if "gemini-main" in request.url.path:
            return httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED", "message": "quota"}})
        return _ok("lite")

    adapter, client = _gemini(quota, fallback_model="gemini-lite")
    assert adapter.generate("gemini-main", "p", None, None, 10).token_usage["answered_by_fallback_model"] == "gemini-lite"
    client.close()

    def hang(request):
        if "gemini-main" in request.url.path:
            raise httpx.ReadTimeout("no answer", request=request)
        return _ok("lite")

    adapter, client = _gemini(hang, fallback_model="gemini-lite")
    assert adapter.generate("gemini-main", "p", None, None, 10).text == "lite"
    client.close()
