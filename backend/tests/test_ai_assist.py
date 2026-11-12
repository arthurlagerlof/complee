"""Viewer AI assistance: works without a database, returns the chain's attempts, never invents a status."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import ai_assist, ai_chain


@pytest.fixture
def client(monkeypatch):
    def fake_chain(session, prompt, system, max_tokens, schema, record):
        if schema is ai_assist.FindingExplanation:
            parsed = {"summary": "850 mm is below 900 mm.", "reasons": ["corridor"], "exceptions_to_check": [], "options": [], "questions": []}
        else:
            parsed = {"suggestions": [{"title": "t", "rationale": "r", "rooms": ["A"], "actions": [
                {"type": "add_passage", "deck": "01", "from_element": "A", "to_element": "B", "clear_width_mm": 900}]}]}
        assert "never change" in system or "recomputed by the tool" in system
        return {"parsed": parsed, "model_name": "claude-opus-5-5 (fast)", "duration_ms": 1200,
                "attempts": [{"model": "claude-opus-5-5 (fast)", "status": "completed", "duration_ms": 1200}],
                "token_usage": {"input_tokens": 10, "output_tokens": 20}}

    monkeypatch.setattr(ai_chain, "run_chain", fake_chain)
    monkeypatch.setattr(ai_assist, "_log_sessionmaker", lambda: None)  # no database in tests
    return TestClient(app)


def test_explain_finding_answers_without_a_database(client):
    r = client.post("/api/v1/ai/assist/explain-finding", json={"rule": {"id": "R"}, "finding": {"status": "non_compliant"}})
    assert r.status_code == 200
    body = r.json()
    assert body["result"]["summary"].startswith("850 mm")
    assert body["model"] == "claude-opus-5-5 (fast)" and body["attempts"][0]["status"] == "completed"


def test_escape_suggestions_return_machine_applicable_actions(client):
    r = client.post("/api/v1/ai/assist/escape-suggestions", json={"analysis": {}, "elements": [], "decks": []})
    assert r.status_code == 200
    action = r.json()["result"]["suggestions"][0]["actions"][0]
    assert action == {"type": "add_passage", "deck": "01", "from_element": "A", "to_element": "B", "clear_width_mm": 900}


def test_status_lists_the_chain(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "k")
    body = TestClient(app).get("/api/v1/ai/assist/status").json()
    assert body["available"] is True and body["chain"][0] == "claude-opus-5-5 (fast)"
