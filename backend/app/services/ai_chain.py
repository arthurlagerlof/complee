"""Fast model chain: ask the best fast model first and move on when it fails, is too slow or answers badly.

Default order (from the model comparison of 2026-11-12, speed and quality first):
  1. Claude Opus 5.5 in fast mode
  2. GPT-6.1 Sol, Ultrafast tier
  3. GPT-6 Astra, Fast tier
  4. the backend's Gemini model, if GEMINI_API_KEY is set (slower, last resort)

A step is skipped when its provider has no key. A step fails over to the next when the provider errors, the request
takes longer than AI_CHAIN_STEP_TIMEOUT_SECONDS, the model refuses, or a structured answer does not validate.
Every attempt is recorded as its own AI execution, so the log shows which model really answered and why others did not.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.fast_providers import ClaudeAdapter, OpenAIResponsesAdapter
from app.ai.providers import AIProviderError, GeminiAdapter, ProviderAdapter
from app.core.config import settings
from app.db.models import AIModelConfig, AIProvider

CHAIN_MARKER = "fast_model_chain"


@dataclass
class ChainStep:
    provider_type: str  # anthropic | openai | gemini
    model_name: str
    options: dict[str, Any] = field(default_factory=dict)

    @property
    def label(self) -> str:
        extra = self.options.get("speed") or self.options.get("service_tier")
        return f"{self.model_name}{f' ({extra})' if extra else ''}"


def parse_chain(spec: str) -> list[ChainStep]:
    """'anthropic:claude-opus-5-5:speed=fast,openai:gpt-6.1-sol:service_tier=ultrafast' -> steps."""
    steps = []
    for item in (part.strip() for part in spec.split(",")):
        if not item:
            continue
        provider_type, _, rest = item.partition(":")
        model_name, _, opts = rest.partition(":")
        options = dict(o.split("=", 1) for o in opts.split(";") if "=" in o)
        if provider_type in {"anthropic", "openai", "gemini"} and model_name:
            steps.append(ChainStep(provider_type, model_name, options))
    return steps


def _key(provider_type: str) -> str | None:
    return {"anthropic": settings.anthropic_api_key, "openai": settings.openai_api_key, "gemini": settings.gemini_api_key}.get(provider_type)


def active_steps() -> list[ChainStep]:
    steps = [s for s in parse_chain(settings.ai_model_chain) if _key(s.provider_type)]
    if settings.gemini_api_key and settings.gemini_model and not any(s.provider_type == "gemini" for s in steps):
        steps.append(ChainStep("gemini", settings.gemini_model.removeprefix("models/")))
    return steps


def chain_enabled() -> bool:
    # The chain is worth using only when a fast provider (Claude or GPT) is configured.
    return any(s.provider_type in {"anthropic", "openai"} for s in active_steps())


_BASE_URL = {
    "anthropic": lambda: settings.anthropic_base_url,
    "openai": lambda: settings.openai_base_url,
    "gemini": lambda: settings.gemini_base_url,
}
_PROVIDER_NAME = {
    "anthropic": "Anthropic (backend environment)",
    "openai": "OpenAI (backend environment)",
    "gemini": "Gemini (backend environment)",
}


def builtin_model(session: Session, step: ChainStep, chain_head: bool = False) -> tuple[AIProvider, AIModelConfig]:
    """Provider and model rows for a chain step (created on first use; used for the execution log)."""
    name = _PROVIDER_NAME[step.provider_type]
    provider = session.scalar(select(AIProvider).where(AIProvider.name == name))
    if provider is None:
        provider = AIProvider(
            name=name, provider_type=step.provider_type, base_url=_BASE_URL[step.provider_type]().rstrip("/"),
            enabled=True, is_local=False, configuration={"managed_by": "backend_environment"},
        )
        session.add(provider)
        session.flush()
    model_name = step.label
    model = session.scalar(select(AIModelConfig).where(AIModelConfig.provider_id == provider.id, AIModelConfig.model_name == model_name))
    if model is None:
        model = AIModelConfig(
            provider_id=provider.id, model_name=model_name, display_name=model_name, enabled=True,
            supported_capabilities=["chat", "json_schema"], configuration={"managed_by": "backend_environment"},
        )
        session.add(model)
        session.flush()
    if chain_head and (model.configuration or {}).get(CHAIN_MARKER) is not True:
        model.configuration = {**(model.configuration or {}), CHAIN_MARKER: True}
    return provider, model


def chain_head(session: Session) -> tuple[uuid.UUID, uuid.UUID]:
    """Provider and model ids that stand for the whole chain (stored on documents and task configurations)."""
    provider, model = builtin_model(session, active_steps()[0], chain_head=True)
    session.commit()
    return provider.id, model.id


def is_chain_head(model: AIModelConfig) -> bool:
    return bool((model.configuration or {}).get(CHAIN_MARKER))


def adapter_for_step(step: ChainStep, timeout: float) -> ProviderAdapter:
    key = _key(step.provider_type)
    if step.provider_type == "anthropic":
        adapter: ProviderAdapter = ClaudeAdapter(settings.anthropic_base_url, key, timeout)
    elif step.provider_type == "openai":
        adapter = OpenAIResponsesAdapter(settings.openai_base_url.rstrip("/"), key, timeout)
    else:
        adapter = GeminiAdapter(settings.gemini_base_url, key, timeout)
    adapter.request_options = {"effort": "low", **step.options}
    return adapter


def run_chain(
    session: Session,
    prompt: str,
    system_prompt: str | None,
    max_tokens: int,
    schema: type[BaseModel] | None,
    record,  # callable(provider, model, status, duration_ms, token_usage, validation_outcome) -> execution
) -> dict[str, Any]:
    steps = active_steps()
    if not steps:
        raise AIProviderError("No AI model is configured (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY).")
    attempts: list[dict[str, Any]] = []
    last_error = "no attempt"
    for index, step in enumerate(steps):
        provider, model = builtin_model(session, step, chain_head=index == 0)
        # The last step gets the normal timeout: there is nothing left to fall back to.
        timeout = settings.ai_request_timeout_seconds if index == len(steps) - 1 else settings.ai_chain_step_timeout_seconds
        adapter = adapter_for_step(step, timeout)
        started = time.perf_counter()
        try:
            response = (
                adapter.generate_structured(step.model_name, prompt, system_prompt, None, max_tokens, schema)
                if schema is not None
                else adapter.generate(step.model_name, prompt, system_prompt, None, max_tokens)
            )
        except AIProviderError as exc:
            duration_ms = round((time.perf_counter() - started) * 1000)
            last_error = str(exc)
            record(provider, model, "failed", duration_ms, {"fallback_reason": last_error[:300]}, "error")
            attempts.append({"model": step.label, "status": "failed", "duration_ms": duration_ms, "reason": last_error[:300]})
            continue
        finally:
            adapter.close()
        duration_ms = round((time.perf_counter() - started) * 1000)
        if schema is not None and response.validation_errors:
            last_error = "the answer did not match the required structure"
            record(provider, model, "failed", duration_ms, {**response.token_usage, "fallback_reason": last_error}, "invalid")
            attempts.append({"model": step.label, "status": "invalid", "duration_ms": duration_ms, "reason": last_error})
            continue
        execution = record(provider, model, "completed", duration_ms, response.token_usage,
                           "valid" if schema is not None else "not_applicable")
        attempts.append({"model": step.label, "status": "completed", "duration_ms": duration_ms})
        return {
            "execution_id": execution.id,
            "provider_id": provider.id,
            "model_id": model.id,
            "model_name": step.label,
            "text": response.text,
            "parsed": response.parsed,
            "validation_errors": [],
            "duration_ms": sum(a["duration_ms"] for a in attempts),
            "token_usage": response.token_usage,
            "attempts": attempts,
        }
    raise AIProviderError(f"Every model in the chain failed. Last error: {last_error}")
