"""Fast model chain: order, skipping, fail-over on errors / timeouts / invalid answers, and the execution log."""
import pytest
from pydantic import BaseModel

from app.ai.providers import AIProviderUnavailable, AIResponse
from app.core.config import settings
from app.services import ai_chain


class Answer(BaseModel):
    value: int


class FakeAdapter:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.request_options = {}

    def generate_structured(self, model, prompt, system, temperature, max_tokens, schema):
        return self.generate(model, prompt, system, temperature, max_tokens, schema)

    def generate(self, model, prompt, system, temperature, max_tokens, schema=None):
        if isinstance(self.behaviour, Exception):
            raise self.behaviour
        response = AIResponse(text=self.behaviour, token_usage={"input_tokens": 1, "output_tokens": 1})
        if schema is not None:
            try:
                response.parsed = schema.model_validate_json(self.behaviour).model_dump()
            except ValueError as exc:
                response.validation_errors = [str(exc)]
        return response

    def close(self):
        pass


@pytest.fixture
def chain(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", "a")
    monkeypatch.setattr(settings, "openai_api_key", "o")
    monkeypatch.setattr(settings, "gemini_api_key", None)
    behaviours = {}
    monkeypatch.setattr(ai_chain, "adapter_for_step", lambda step, timeout: FakeAdapter(behaviours[step.label]))
    return behaviours


class Session:
    """Just enough of a session for builtin_model (rows are not persisted in these unit tests)."""

    def __init__(self):
        self.rows = []

    def scalar(self, _query):
        return None

    def add(self, row):
        import uuid
        row.id = uuid.uuid4()
        self.rows.append(row)

    def flush(self):
        pass

    def commit(self):
        pass


def run(chain_behaviours, schema=Answer):
    log = []
    result = ai_chain.run_chain(Session(), "p", None, 100, schema,
                                lambda p, m, status, ms, usage, outcome: log.append((m.model_name, status, outcome, usage)) or type("E", (), {"id": len(log)})())
    return result, log


def test_default_order_is_opus_fast_then_sol_ultrafast_then_astra_fast(chain):
    assert [s.label for s in ai_chain.active_steps()] == [
        "claude-opus-5-5 (fast)", "gpt-6.1-sol (ultrafast)", "gpt-6-astra (fast)"]


def test_first_model_answers_when_it_works(chain):
    chain.update({"claude-opus-5-5 (fast)": '{"value": 1}', "gpt-6.1-sol (ultrafast)": '{"value": 2}', "gpt-6-astra (fast)": '{"value": 3}'})
    result, log = run(chain)
    assert result["parsed"] == {"value": 1} and result["model_name"] == "claude-opus-5-5 (fast)"
    assert [a["status"] for a in result["attempts"]] == ["completed"]


def test_error_timeout_and_invalid_answer_move_to_the_next_model(chain):
    chain.update({
        "claude-opus-5-5 (fast)": AIProviderUnavailable("The AI provider request timed out."),
        "gpt-6.1-sol (ultrafast)": "not json",
        "gpt-6-astra (fast)": '{"value": 3}',
    })
    result, log = run(chain)
    assert result["parsed"] == {"value": 3} and result["model_name"] == "gpt-6-astra (fast)"
    assert [a["status"] for a in result["attempts"]] == ["failed", "invalid", "completed"]
    assert [(name, status) for name, status, *_ in log] == [
        ("claude-opus-5-5 (fast)", "failed"), ("gpt-6.1-sol (ultrafast)", "failed"), ("gpt-6-astra (fast)", "completed")]
    assert "timed out" in log[0][3]["fallback_reason"]


def test_steps_without_a_key_are_skipped_and_gemini_is_the_last_resort(chain, monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    monkeypatch.setattr(settings, "gemini_api_key", "g")
    monkeypatch.setattr(settings, "gemini_model", "gemini-3.8-flash")
    assert [s.label for s in ai_chain.active_steps()] == ["gpt-6.1-sol (ultrafast)", "gpt-6-astra (fast)", "gemini-3.8-flash"]


def test_all_failing_raises_with_the_last_reason(chain):
    chain.update({label: AIProviderUnavailable(f"down {label}") for label in
                  ["claude-opus-5-5 (fast)", "gpt-6.1-sol (ultrafast)", "gpt-6-astra (fast)"]})
    with pytest.raises(Exception, match="Every model in the chain failed. Last error: down gpt-6-astra"):
        run(chain)


def test_chain_is_off_without_claude_or_gpt_keys(monkeypatch):
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    monkeypatch.setattr(settings, "openai_api_key", None)
    assert ai_chain.chain_enabled() is False


def test_parse_chain_reads_options():
    steps = ai_chain.parse_chain("anthropic:claude-opus-5-5:speed=fast, openai:gpt-6.1-sol:service_tier=ultrafast;effort=medium, bogus:x")
    assert [(s.provider_type, s.model_name, s.options) for s in steps] == [
        ("anthropic", "claude-opus-5-5", {"speed": "fast"}),
        ("openai", "gpt-6.1-sol", {"service_tier": "ultrafast", "effort": "medium"}),
    ]


def test_budget_profile_puts_cheap_models_first_and_prices_the_answer(chain, monkeypatch):
    monkeypatch.setattr(settings, "ai_cost_profile", "budget")
    monkeypatch.setattr(settings, "gemini_api_key", "g")
    assert [s.label for s in ai_chain.active_steps()] == ["gpt-6.1-sol", "gemini-3.8-flash", "claude-sonnet-5-5"]
    sol = ai_chain.ChainStep("openai", "gpt-6.1-sol", {})
    assert ai_chain.estimate_cost(sol, {"input_tokens": 1000, "output_tokens": 1000}) == 0.012  # 0.2 ct + 1 ct
    gemini = ai_chain.ChainStep("gemini", "gemini-3.8-flash", {})
    # Gemini's reasoning tokens are billed as output
    assert ai_chain.estimate_cost(gemini, {"promptTokenCount": 1000, "candidatesTokenCount": 200, "thoughtsTokenCount": 800}) == 0.0045
    assert ai_chain.estimate_cost(ai_chain.ChainStep("openai", "unknown-model", {}), {"input_tokens": 1}) is None
