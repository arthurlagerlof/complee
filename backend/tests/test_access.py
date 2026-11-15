"""Access to the backend: this computer, or the access token; never a state-changing request from another website."""

import re

import pytest
from fastapi.testclient import TestClient

from app.core import access
from app.core.config import settings
from app.main import app

ORIGINS = ["http://localhost:5173"]
TOKEN = "t" * 32
LOCAL = {"host": "localhost:8000"}


def decide(method="GET", path="/api/v1/x", client="127.0.0.1", headers=None, token=None):
    return access.decide(method, path, client, {**LOCAL, **(headers or {})} if headers is None or "host" not in headers else headers, token, ORIGINS)


@pytest.fixture
def production_rules(monkeypatch):
    """The real access rules (conftest makes the TestClient count as local for the other tests)."""
    monkeypatch.setattr(access, "LOCAL_CLIENTS", {"127.0.0.1", "::1", "::ffff:127.0.0.1"})
    monkeypatch.setattr(access, "LOCAL_HOST", re.compile(r"^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?$", re.I))


def test_this_computer_is_served_without_a_token(production_rules):
    assert decide() is None
    assert decide(client="::1") is None
    assert decide("POST", headers={**LOCAL, "origin": "http://localhost:5173"}) is None, "the landing page in development"


def test_other_computers_need_the_token(production_rules):
    assert decide(client="192.168.1.20")[1] == "local_only"
    assert decide(client="192.168.1.20", token=TOKEN)[1] == "token_required"
    assert decide(client="192.168.1.20", headers={"host": "api.example", "authorization": f"Bearer {TOKEN}"}, token=TOKEN) is None
    assert decide(client="192.168.1.20", headers={"host": "api.example", "x-complee-token": TOKEN}, token=TOKEN) is None
    assert decide(client="192.168.1.20", headers={"host": "api.example", "authorization": "Bearer wrong"}, token=TOKEN)[1] == "invalid_token"
    assert decide(client="192.168.1.20", headers={"host": "api.example", "authorization": f"Bearer {TOKEN}"}, token=None)[1] == "invalid_token"


def test_a_proxy_or_a_foreign_host_name_is_not_this_computer(production_rules):
    assert decide(headers={**LOCAL, "x-forwarded-for": "203.0.113.9"})[1] == "local_only"
    assert decide(headers={"host": "attacker.example:8000"})[1] == "local_only", "DNS rebinding"


def test_another_website_cannot_change_anything_even_from_this_computer(production_rules):
    for headers in ({**LOCAL, "origin": "https://evil.example"}, {**LOCAL, "origin": "null"}, {**LOCAL, "sec-fetch-site": "cross-site"}):
        assert decide("POST", headers=headers)[1] == "cross_site", headers
        assert decide("POST", headers={**headers, "authorization": f"Bearer {TOKEN}"}, token=TOKEN)[1] == "cross_site"
    # Reading stays possible (CORS keeps the answer from the other site); health is always public.
    assert decide("GET", headers={**LOCAL, "origin": "https://evil.example"}) is None
    assert decide("GET", path="/health", client="203.0.113.9", headers={"host": "x"}) is None
    # The backend's own origin (behind a proxy with the token) is not another website.
    assert decide("POST", client="10.0.0.2", headers={"host": "api.example", "origin": "https://api.example", "authorization": f"Bearer {TOKEN}"}, token=TOKEN) is None


def test_the_running_app_applies_the_rules(production_rules, monkeypatch):
    client = TestClient(app)  # connects as "testclient" to "testserver": another computer
    assert client.get("/health").status_code == 200
    r = client.get("/api/v1/ai/assist/status")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "local_only"
    monkeypatch.setattr(settings, "backend_api_token", TOKEN)
    assert client.get("/api/v1/ai/assist/status").status_code == 401
    assert client.get("/api/v1/ai/assist/status", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    refused = client.post("/api/v1/rule-verification/import", headers={"Authorization": f"Bearer {TOKEN}", "Origin": "https://evil.example"}, json={})
    assert refused.status_code == 403


def test_a_short_token_is_refused_at_startup():
    with pytest.raises(Exception):
        type(settings)(backend_api_token="short")
