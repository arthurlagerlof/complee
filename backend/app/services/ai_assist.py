"""AI assistance for the 3D viewer: explain a finding, propose escape-route improvements.

Both run through the fast model chain (ai_chain) and work without a database. When a database is configured, every
attempt is logged in the background afterwards (a slow or unreachable database never delays an answer).
Neither function decides compliance: the explanation works from the checker's result, and every escape suggestion
is machine-applicable so the viewer can recompute it with its deterministic route analysis before showing it.
"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.services import ai_chain

log = logging.getLogger(__name__)
PROMPT_VERSION = "viewer-assist.v1"


# ---------------------------------------------------------------- outputs

class Option(BaseModel):
    change: str = Field(description="One concrete design change, at most 12 words")
    effect: str = Field(description="Its effect on the check result, at most 10 words")


class FindingExplanation(BaseModel):
    summary: str = Field(description="One or two short sentences, at most 35 words: required value, design value, gap")
    reasons: list[str] = Field(default_factory=list, description="At most 2 points, each at most 15 words; omit what the summary already says")
    exceptions_to_check: list[str] = Field(default_factory=list, description="At most 2 points, each at most 15 words; empty if none apply")
    options: list[Option] = Field(default_factory=list, description="At most 3 ways to resolve the finding, most practical first")
    questions: list[str] = Field(default_factory=list, description="At most 2 questions, each at most 15 words")


class EscapeAction(BaseModel):
    type: Literal["add_passage", "add_door"]
    deck: str
    from_element: str = Field(description="Existing element id")
    to_element: str = Field(description="Existing element id on the same deck")
    clear_width_mm: float = Field(default=1000, ge=600, le=3000)


class EscapeSuggestion(BaseModel):
    title: str = Field(description="At most 8 words")
    rationale: str = Field(description="One sentence, at most 25 words")
    rooms: list[str] = Field(default_factory=list, description="Room ids this should give a second route")
    actions: list[EscapeAction] = Field(default_factory=list, max_length=4)


class EscapeSuggestions(BaseModel):
    suggestions: list[EscapeSuggestion] = Field(default_factory=list, max_length=4)


# ---------------------------------------------------------------- running and logging

class _NullSession:
    """ai_chain needs a session only to name its log rows; without a database nothing is stored."""

    def scalar(self, _query):
        return None

    def add(self, row):
        row.id = uuid.uuid4()

    def flush(self):
        pass

    def commit(self):
        pass


_log_engine = None


def _log_sessionmaker():
    global _log_engine
    if not settings.sqlalchemy_database_url:
        return None
    if _log_engine is None:
        # Own engine with a short connect timeout: logging must never hang a worker for minutes.
        _log_engine = create_engine(settings.sqlalchemy_database_url, pool_pre_ping=True, connect_args={"connect_timeout": 5})
    return sessionmaker(bind=_log_engine, autoflush=False, expire_on_commit=False)


def log_attempts(task_name: str, schema_name: str, attempts: list[dict[str, Any]]) -> None:
    """Background task: store each attempt as an AI execution, if a database is reachable."""
    make = _log_sessionmaker()
    if make is None:
        return
    try:
        from app.services.ai import _record_execution  # local import: ai.py imports ai_chain

        with make() as session:
            steps = {s.label: s for s in ai_chain.active_steps()}
            for attempt in attempts:
                step = steps.get(attempt["model"])
                if step is None:
                    continue
                provider, model = ai_chain.builtin_model(session, step)
                ok = attempt["status"] == "completed"
                usage = attempt.get("token_usage") or ({} if ok else {"fallback_reason": attempt.get("reason", "")})
                _record_execution(session, provider, model, task_name, PROMPT_VERSION, schema_name,
                                  "completed" if ok else "failed", attempt["duration_ms"], usage,
                                  "valid" if ok else ("invalid" if attempt["status"] == "invalid" else "error"))
    except Exception as exc:  # noqa: BLE001 - logging is best effort
        log.warning("AI assist executions were not logged: %s", type(exc).__name__)


def _run(prompt: str, system: str, schema: type[BaseModel], max_tokens: int) -> dict[str, Any]:
    result = ai_chain.run_chain(_NullSession(), prompt, system, max_tokens, schema,
                                lambda *a, **k: type("Execution", (), {"id": None})())
    result["attempts"][-1]["token_usage"] = result["token_usage"]
    return {
        "result": result["parsed"],
        "model": result["model_name"],
        "duration_ms": result["duration_ms"],
        "attempts": result["attempts"],
        "token_usage": result["token_usage"],
        "cost_usd": result.get("cost_usd"),
    }


def _compact(value: Any, limit: int = 6000) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= limit else text[:limit] + "…(truncated)"


# ---------------------------------------------------------------- tasks

EXPLAIN_SYSTEM = (
    "You assist a naval architect reviewing class and statutory compliance. The rule check result below was computed "
    "by a deterministic checker and is final: never change, question or restate a different status, measured value or "
    "required value. Explain it in plain engineering language, name exceptions or alternative arrangements only if the "
    "rule text or well-known provisions of that instrument allow them (say 'check' when unsure), and propose at most "
    "three concrete design changes. Rule texts in this tool are paraphrases until verified against the official text. "
    "Keep it short and easy to scan: plain words, no repetition between fields, no general background, respect the "
    "word limits in the schema. A reviewer should understand the finding in ten seconds. Return JSON only."
)


def explain_prompt(payload: dict[str, Any]) -> str:
    return (
        "Rule:\n" + _compact(payload.get("rule", {}), 3000)
        + "\n\nChecker result for this element:\n" + _compact(payload.get("finding", {}), 3000)
        + "\n\nShip particulars:\n" + _compact(payload.get("ship", {}), 1500)
        + "\n\nJSON schema:\n" + json.dumps(FindingExplanation.model_json_schema())
    )


def explain_finding(payload: dict[str, Any]) -> dict[str, Any]:
    return _run(explain_prompt(payload), EXPLAIN_SYSTEM, FindingExplanation, 1800)


ESCAPE_SYSTEM = (
    "You assist a naval architect with means of escape. The route analysis below was computed from the model geometry. "
    "Propose at most 3 design changes that give rooms with a single route a second, independent route to the muster "
    "station (not through the same stair, ladder or door). Express every change only with these actions: "
    "add_passage (a new corridor on one deck between two existing elements on that deck: from_element and to_element) "
    "and add_door (a new door between two existing elements on one deck that touch each other). Use only element ids "
    "and deck ids from the input. Give every new passage or door at least the minimum clear width listed in the "
    "analysis for its type. Each suggestion is recomputed by the tool; suggestions that do not help are dropped. "
    "Keep titles and rationales short (see the word limits in the schema). Return JSON only."
)


def escape_prompt(payload: dict[str, Any]) -> str:
    return (
        "Route analysis:\n" + _compact(payload.get("analysis", {}), 6000)
        + "\n\nElements (id, type, name, deck, footprint x/y/lx/ly in mm):\n" + _compact(payload.get("elements", []), 14000)
        + "\n\nDecks:\n" + _compact(payload.get("decks", []), 1500)
        + "\n\nJSON schema:\n" + json.dumps(EscapeSuggestions.model_json_schema())
    )


def escape_suggestions(payload: dict[str, Any]) -> dict[str, Any]:
    return _run(escape_prompt(payload), ESCAPE_SYSTEM, EscapeSuggestions, 3000)


# Streaming: system prompt, schema, output limit, prompt builder, log task name
STREAM_TASKS = {
    "explain-finding": (EXPLAIN_SYSTEM, FindingExplanation, 1800, explain_prompt, "viewer_explain_finding"),
    "escape-suggestions": (ESCAPE_SYSTEM, EscapeSuggestions, 3000, escape_prompt, "viewer_escape_suggestions"),
}


def stream(task: str, payload: dict[str, Any], holder: dict[str, Any]):
    """Events of ai_chain.run_chain_stream for a viewer task; holder receives the attempts for logging."""
    system, schema, max_tokens, build, _ = STREAM_TASKS[task]
    for event in ai_chain.run_chain_stream(build(payload), system, max_tokens, schema):
        if event["type"] in {"done", "error"}:
            holder["attempts"] = event.get("attempts", [])
        yield event


def status() -> dict[str, Any]:
    steps = ai_chain.active_steps()
    explicit = "ai_model_chain" in settings.model_fields_set
    return {
        "available": bool(steps),
        "profile": "custom" if explicit else settings.ai_cost_profile.strip().lower(),
        "chain": [s.label for s in steps],
        "prices_usd_per_million": [ai_chain.PRICES.get((s.model_name, s.options.get("speed") or s.options.get("service_tier"))) for s in steps],
    }
