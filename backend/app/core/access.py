"""Who may call this backend.

The backend holds paid AI keys, the regulation database and the immutable rule-verification records, and has no
user accounts. Before this module every route was open to anyone who could reach the port. Now a request is served
when one of these holds:

* it comes from this computer: a loopback connection, a loopback host name (so a web page that points its own domain
  at 127.0.0.1, "DNS rebinding", is refused) and no proxy header (a reverse proxy on the same host would otherwise
  make every internet request look local);
* it carries the access token: ``Authorization: Bearer <BACKEND_API_TOKEN>`` (or ``X-Complee-Token``). The ShipCheck
  viewer server sends it when it has the same setting; set the token whenever the backend is reachable from another
  computer. Without a token configured, only this computer is served.

In both cases a request that changes something must not come from another website: a page open in the engineer's
browser could otherwise send a "simple" cross-site POST to 127.0.0.1:8000 (CORS hides the answer, but the request
runs). Its Origin must be listed in FRONTEND_ORIGINS or be the backend's own origin.

``GET /health`` stays public (load balancers and the viewer's status check).
"""

from __future__ import annotations

import hmac
import json
import re
from typing import Callable

LOCAL_CLIENTS = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
LOCAL_HOST = re.compile(r"^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+\.localhost)(:\d{1,5})?$", re.IGNORECASE)
PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip", "x-forwarded-host")
PUBLIC_PATHS = {"/health"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _host_of(origin: str) -> str | None:
    match = re.match(r"^https?://([^/]+)$", origin.strip(), re.IGNORECASE)
    return match.group(1).lower() if match else None


def presented_token(headers: dict[str, str]) -> str | None:
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return headers.get("x-complee-token", "").strip() or None


def is_local(client_host: str | None, headers: dict[str, str]) -> bool:
    if client_host not in LOCAL_CLIENTS:
        return False
    if not LOCAL_HOST.match(headers.get("host", "")):
        return False
    return not any(h in headers for h in PROXY_HEADERS)


def cross_site_refusal(method: str, headers: dict[str, str], allowed_origins: list[str]) -> str | None:
    """Reason to refuse a state-changing request sent by another website, or None."""
    if method in SAFE_METHODS:
        return None
    origin = headers.get("origin")
    if origin is None:
        # Scripts and server-to-server calls send no Origin; a browser that says "cross-site" is refused.
        return "Requests from other websites are not accepted." if headers.get("sec-fetch-site") == "cross-site" else None
    if origin == "null":
        return "Requests from other websites are not accepted."
    if origin.rstrip("/") in allowed_origins:
        return None
    if _host_of(origin) and _host_of(origin) == headers.get("host", "").lower():
        return None
    return "Requests from other websites are not accepted."


def decide(method: str, path: str, client_host: str | None, headers: dict[str, str], token: str | None,
           allowed_origins: list[str]) -> tuple[int, str, str] | None:
    """None to serve the request, else (status, code, message)."""
    if method == "OPTIONS" or path in PUBLIC_PATHS:
        return None
    refusal = cross_site_refusal(method, headers, allowed_origins)
    if refusal:
        return 403, "cross_site", refusal
    given = presented_token(headers)
    if given is not None:
        if token and hmac.compare_digest(given.encode(), token.encode()):
            return None
        return 401, "invalid_token", "The access token is not valid."
    if is_local(client_host, headers):
        return None
    if token:
        return 401, "token_required", "This backend needs its access token (BACKEND_API_TOKEN) for requests from other computers."
    return 403, "local_only", "This backend serves this computer only. Set BACKEND_API_TOKEN to allow other computers with that token."


class AccessMiddleware:
    """Pure ASGI middleware (keeps streamed AI answers streaming)."""

    def __init__(self, app, token: Callable[[], str | None], origins: Callable[[], list[str]]):
        self.app = app
        self.token = token
        self.origins = origins

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        client = scope.get("client")
        verdict = decide(scope["method"], scope["path"], client[0] if client else None, headers, self.token(), self.origins())
        if verdict is None:
            return await self.app(scope, receive, send)
        status, code, message = verdict
        body = json.dumps({"error": {"code": code, "message": message}}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
