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


def test_stream_endpoint_sends_events_in_order(monkeypatch):
    def fake_stream(prompt, system, max_tokens, schema):
        yield {"type": "model", "model": "gpt-6.1-sol"}
        yield {"type": "delta", "text": '{"summary": "850'}
        yield {"type": "delta", "text": ' mm"}'}
        yield {"type": "done", "result": {"summary": "850 mm"}, "model": "gpt-6.1-sol", "duration_ms": 900,
               "attempts": [{"model": "gpt-6.1-sol", "status": "completed", "duration_ms": 900}], "cost_usd": 0.004}

    monkeypatch.setattr(ai_chain, "run_chain_stream", fake_stream)
    monkeypatch.setattr(ai_assist, "_log_sessionmaker", lambda: None)
    import json as _json
    with TestClient(app).stream("POST", "/api/v1/ai/assist/explain-finding/stream", json={"rule": {}, "finding": {}}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        events = [_json.loads(line[5:]) for line in r.iter_lines() if line.startswith("data:")]
    assert [e["type"] for e in events] == ["model", "delta", "delta", "done"]
    assert events[-1]["cost_usd"] == 0.004
    assert TestClient(app).post("/api/v1/ai/assist/unknown/stream", json={}).status_code == 404


def test_comment_reply_task_builds_a_prompt_with_the_check_result():
    system, schema, max_tokens, build, log_name = ai_assist.STREAM_TASKS["comment-reply"]
    prompt = build({
        "comment": {"ref": "1", "text": "Corridor MD-C1 clear width to be at least 900 mm."},
        "evidence": {"state": "Rule check: no deviation now", "items": [{"element": "MD-C1", "measured": "950 mm"}]},
        "notes": {}, "revision": "rev C",
    })
    assert "MD-C1" in prompt and "950 mm" in prompt and "rev C" in prompt
    assert schema.__name__ == "CommentReply" and log_name == "viewer_comment_reply"
    assert "Never claim class acceptance" in system
