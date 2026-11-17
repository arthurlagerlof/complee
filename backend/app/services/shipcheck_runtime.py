"""Unified runtime services for ShipCheck inspection UI, model streaming, regulation text, APS, and evidence."""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import threading
import time
import urllib.parse
import uuid
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR, settings
from app.services.retrieval.service import get_requirement
from app.services.shipcheck_catalog import read_active_catalog_json

REPO_ROOT = BACKEND_DIR.parent
DEFAULT_SHIPCHECK_ROOT = REPO_ROOT / "shipcheck"

_SERVABLE_PATTERNS = [
    re.compile(r"^manifest\.json$"),
    re.compile(r"^stream-hp/(manifest|audit)\.json$"),
    re.compile(r"^stream-hp/[a-z0-9_-]+-[0-9a-f]{12}\.glb$"),
    re.compile(r"^stream/overview-[a-z0-9_-]+-[0-9a-f]{12}\.glb$"),
    re.compile(r"^props/\d{1,6}\.json$"),
    re.compile(r"^[a-z0-9-]{1,40}\.glb$"),
]
_IMMUTABLE_PATTERN = re.compile(r"-[0-9a-f]{12}\.glb$")
_FALLBACK_NAME_RE = re.compile(r"^[a-z0-9-]{1,40}$")
_DATA_URL_PNG_RE = re.compile(r"^data:image/png;base64,([A-Za-z0-9+/=]+)$")
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

_MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".csv": "text/csv",
    ".png": "image/png",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".wasm": "application/wasm",
}

_STATIC_MOUNTS = [
    ("/src/", "src"),
    ("/demo/", "demo"),
    ("/node_modules/three/", "node_modules/three"),
    ("/node_modules/three-mesh-bvh/", "node_modules/three-mesh-bvh"),
    ("/", "public"),
]

_REGULATION_CACHE_TTL_S = 600.0
_regulation_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_aps_token_cache: dict[str, Any] | None = None
_manifest_choice_cache: dict[str, Any] | None = None


class SlidingWindowRateLimiter:
    """Thread-safe bounded per-client sliding-window rate limiter."""

    def __init__(self, window_s: float = 60.0, max_requests: int = 120, max_clients: int = 4096) -> None:
        self.window_s = window_s
        self.max_requests = max_requests
        self.max_clients = max_clients
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - self.window_s
        with self._lock:
            if key not in self._hits and len(self._hits) >= self.max_clients:
                oldest = next(iter(self._hits))
                del self._hits[oldest]
            stamps = [t for t in self._hits.get(key, []) if t > cutoff]
            if len(stamps) >= self.max_requests:
                retry_after = max(1, int(stamps[0] + self.window_s - now) + 1)
                self._hits[key] = stamps
                return False, retry_after
            stamps.append(now)
            self._hits[key] = stamps
            return True, 0


_api_rate_limiter = SlidingWindowRateLimiter(window_s=60.0, max_requests=120)
_model_rate_limiter = SlidingWindowRateLimiter(window_s=60.0, max_requests=5000)
_static_rate_limiter = SlidingWindowRateLimiter(window_s=60.0, max_requests=600)


def enforce_rate_limit(request: Request) -> None:
    if request.method == "OPTIONS":
        return
    path = request.url.path
    limiter = (
        _model_rate_limiter
        if path.startswith("/inspection/model/")
        else _api_rate_limiter
        if (path.startswith("/inspection/api/") or path.startswith("/api/evidence/"))
        else _static_rate_limiter
    )
    client_ip = request.headers.get("x-real-ip") or (request.client.host if request.client else "unknown")
    allowed, retry_after = limiter.check(client_ip.strip())
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please retry shortly.",
            headers={"Retry-After": str(retry_after)},
        )


def shipcheck_root() -> Path:
    if settings.shipcheck_root:
        return Path(settings.shipcheck_root).resolve()
    return DEFAULT_SHIPCHECK_ROOT.resolve()


def _read_dotenv_keys(env_path: Path, prefixes: tuple[str, ...]) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, raw_val = stripped.split("=", 1)
        key = key.strip()
        if not key.startswith(prefixes):
            continue
        val = raw_val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
            val = val[1:-1]
        values[key] = val
    return values


def shipcheck_version() -> str:
    pkg = shipcheck_root() / "package.json"
    if pkg.is_file():
        try:
            return str(json.loads(pkg.read_text(encoding="utf-8")).get("version", "0.2.0"))
        except Exception:
            pass
    return "0.2.0"


def resolve_model_dir() -> Path:
    raw = os.environ.get("MODEL_DIR") or settings.model_dir or "model"
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate
    return (shipcheck_root() / candidate).resolve()


def is_servable_key(key: str) -> bool:
    if not isinstance(key, str) or ".." in key:
        return False
    return any(pattern.match(key) for pattern in _SERVABLE_PATTERNS)


def is_immutable_tile(key: str) -> bool:
    return bool(_IMMUTABLE_PATTERN.search(key))


@dataclass(frozen=True)
class S3Config:
    endpoint: str
    bucket: str
    access_key: str
    secret_key: str
    region: str = "us-east-1"
    prefix: str = ""


def load_s3_config() -> S3Config | None:
    root = shipcheck_root()
    env_file_vals = _read_dotenv_keys(root / ".env", ("MODEL_SOURCE", "VULTR_S3_"))

    def get(name: str, default: str | None = None) -> str | None:
        return os.environ.get(name) or getattr(settings, name.lower(), None) or env_file_vals.get(name) or default

    source = (get("MODEL_SOURCE") or "").lower()
    if source != "vultr":
        return None
    endpoint = get("VULTR_S3_ENDPOINT")
    bucket = get("VULTR_S3_BUCKET")
    access_key = get("VULTR_S3_ACCESS_KEY")
    secret_key = get("VULTR_S3_SECRET_KEY")
    if not all([endpoint, bucket, access_key, secret_key]):
        return None
    prefix = (get("VULTR_S3_PREFIX") or "").strip("/")
    return S3Config(
        endpoint=endpoint,  # type: ignore[arg-type]
        bucket=bucket,  # type: ignore[arg-type]
        access_key=access_key,  # type: ignore[arg-type]
        secret_key=secret_key,  # type: ignore[arg-type]
        region=get("VULTR_S3_REGION", "us-east-1") or "us-east-1",
        prefix=prefix,
    )


def _encode_segment(segment: str) -> str:
    return urllib.parse.quote(segment, safe="-_.~")


def _sign_v4(
    *,
    method: str,
    host: str,
    uri_path: str,
    access_key: str,
    secret_key: str,
    region: str,
    amz_date: str,
) -> dict[str, str]:
    payload_hash = hashlib.sha256(b"").hexdigest()
    headers = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    names = sorted(headers.keys())
    canonical_headers = "".join(f"{name}:{headers[name]}\n" for name in names)
    signed_headers = ";".join(names)
    canonical_request = "\n".join([method, uri_path, "", canonical_headers, signed_headers, payload_hash])
    date = amz_date[:8]
    scope = f"{date}/{region}/s3/aws4_request"
    string_to_sign = "\n".join(
        ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()]
    )
    k_date = hmac.new(f"AWS4{secret_key}".encode("utf-8"), date.encode("utf-8"), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return {
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "authorization": (
            f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }


def _s3_cache_dir() -> Path:
    raw = os.environ.get("MODEL_CACHE_DIR") or settings.model_cache_dir or ".cache/model-s3"
    path = Path(raw)
    return path if path.is_absolute() else (shipcheck_root() / path).resolve()


def _s3_get_bytes(cfg: S3Config, key: str) -> bytes:
    cache_dir = _s3_cache_dir()
    cached = (cache_dir / Path(*key.split("/"))) if is_immutable_tile(key) else None
    if cached and cached.is_file():
        return cached.read_bytes()

    parsed = urllib.parse.urlparse(cfg.endpoint)
    object_key = f"{cfg.prefix}/{key}" if cfg.prefix else key
    uri_path = "/" + _encode_segment(cfg.bucket) + "/" + "/".join(_encode_segment(seg) for seg in object_key.split("/"))
    amz_date = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    headers = _sign_v4(
        method="GET",
        host=parsed.netloc,
        uri_path=uri_path,
        access_key=cfg.access_key,
        secret_key=cfg.secret_key,
        region=cfg.region,
        amz_date=amz_date,
    )
    url = f"{parsed.scheme}://{parsed.netloc}{uri_path}"
    try:
        res = httpx.get(url, headers=headers, timeout=60.0)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Model storage unavailable") from exc
    if res.status_code in (403, 404):
        raise HTTPException(status_code=404, detail="Not found")
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail="Model storage unavailable")
    data = res.content
    if cached:
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_suffix(f".{os.getpid()}.{int(time.time() * 1000)}.tmp")
        tmp.write_bytes(data)
        tmp.replace(cached)
    return data


def _local_stream_manifest(model_dir: Path) -> str:
    override = os.environ.get("MODEL_MANIFEST") or settings.model_manifest
    if override:
        return override
    manifest = model_dir / "stream-hp" / "manifest.json"
    audit = model_dir / "stream-hp" / "audit.json"
    try:
        if manifest.is_file() and json.loads(audit.read_text(encoding="utf-8")).get("pass") is True:
            return "stream-hp/manifest.json"
    except Exception:
        pass
    raise HTTPException(
        status_code=503,
        detail=(
            "No audited high-precision viewport model is configured. "
            "Set MODEL_SOURCE=vultr with its VULTR_S3_* settings, or deploy the audited stream-hp model under MODEL_DIR."
        ),
    )


def _s3_stream_manifest(cfg: S3Config) -> str:
    global _manifest_choice_cache
    now = time.time()
    if _manifest_choice_cache and _manifest_choice_cache["until"] > now:
        return str(_manifest_choice_cache["value"])
    try:
        audit = json.loads(_s3_get_bytes(cfg, "stream-hp/audit.json").decode("utf-8"))
        if audit.get("pass") is not True:
            raise ValueError("audit did not pass")
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Vultr storage has no passing stream-hp audit; refusing to use the legacy stream manifest.",
        ) from exc
    _manifest_choice_cache = {"value": "stream-hp/manifest.json", "until": now + 300.0}
    return "stream-hp/manifest.json"


def health_payload() -> dict[str, Any]:
    s3_cfg = load_s3_config()
    model_dir = resolve_model_dir()
    manifest_ok = bool(s3_cfg) or (model_dir / "manifest.json").is_file() or (model_dir / "stream-hp" / "manifest.json").is_file()
    return {
        "status": "ok",
        "version": shipcheck_version(),
        "model_source": "vultr" if s3_cfg else "local",
        "model_available": manifest_ok,
        "catalog_source": "database",
    }


def model_config_payload() -> dict[str, Any]:
    base_url = os.environ.get("MODEL_BASE_URL") or settings.model_base_url or "model/"
    s3_cfg = load_s3_config()
    if s3_cfg:
        return {
            "base_url": base_url,
            "manifest": _s3_stream_manifest(s3_cfg),
            "legacy_manifest": "manifest.json",
            "source": "vultr",
        }
    return {
        "base_url": base_url,
        "manifest": _local_stream_manifest(resolve_model_dir()),
        "legacy_manifest": "manifest.json",
    }


def serve_model_file(key: str, request: Request) -> Response:
    if not is_servable_key(key):
        raise HTTPException(status_code=404, detail="Not found")
    s3_cfg = load_s3_config()
    if s3_cfg:
        data = _s3_get_bytes(s3_cfg, key)
        if key.endswith("/manifest.json"):
            try:
                manifest = json.loads(data.decode("utf-8"))
                if manifest.get("kind") == "viewport-tiles" and isinstance(manifest.get("streaming"), dict):
                    manifest["streaming"]["max_requests"] = max(int(manifest["streaming"].get("max_requests") or 2), 6)
                    data = json.dumps(manifest).encode("utf-8")
            except Exception:
                pass
        media_type = "application/json" if key.endswith(".json") else "model/gltf-binary"
        cache_control = "public, max-age=31536000, immutable" if is_immutable_tile(key) else "no-store"
        headers = {"Cache-Control": cache_control, "Content-Length": str(len(data))}
        if request.method == "HEAD":
            return Response(status_code=200, media_type=media_type, headers=headers)
        return Response(content=data, status_code=200, media_type=media_type, headers=headers)

    model_dir = resolve_model_dir()
    candidate = (model_dir / key).resolve()
    if not candidate.is_relative_to(model_dir.resolve()) or not candidate.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return _range_file_response(candidate, request)


def _range_file_response(file_path: Path, request: Request) -> Response:
    ext = file_path.suffix.lower()
    media_type = _MIME_TYPES.get(ext) or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    size = file_path.stat().st_size
    cache_control = "public, max-age=31536000, immutable" if ext == ".glb" else "no-store"
    base_headers = {
        "Cache-Control": cache_control,
        "Accept-Ranges": "bytes",
    }
    range_header = request.headers.get("range", "")
    match = _RANGE_RE.match(range_header.strip())
    if match and (match.group(1) or match.group(2)):
        start = int(match.group(1)) if match.group(1) else size - int(match.group(2))
        end = int(match.group(2)) if (match.group(1) and match.group(2)) else size - 1
        start = max(0, start)
        end = min(size - 1, end)
        if start > end or start >= size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        length = end - start + 1
        headers = {
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        }
        if request.method == "HEAD":
            return Response(status_code=206, media_type=media_type, headers=headers)

        def _iter_range():
            with file_path.open("rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(_iter_range(), status_code=206, media_type=media_type, headers=headers)

    if request.method == "HEAD":
        return Response(
            status_code=200,
            media_type=media_type,
            headers={**base_headers, "Content-Length": str(size)},
        )
    return FileResponse(file_path, media_type=media_type, headers=base_headers)


def resolve_static_file(rel_path: str) -> Path | None:
    clean = "/" + rel_path.lstrip("/")
    if clean == "/":
        clean = "/evidence.html"
    root = shipcheck_root()
    for prefix, folder in _STATIC_MOUNTS:
        if not clean.startswith(prefix):
            continue
        base = (root / folder).resolve()
        sub = clean[len(prefix) :] or "index.html"
        candidate = (base / sub).resolve()
        if (candidate == base or candidate.is_relative_to(base)) and candidate.is_file():
            return candidate
        return None
    return None


def _get_cached_provision(db: Session, provision_id: str) -> dict[str, Any]:
    now = time.time()
    cached = _regulation_cache.get(provision_id)
    if cached and cached[0] > now:
        return cached[1]
    try:
        parsed_id = uuid.UUID(provision_id)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Invalid provision UUID: {provision_id}") from exc
    req = get_requirement(db, parsed_id)
    if req is None:
        raise HTTPException(status_code=404, detail=f"Provision {provision_id} not found")
    metadata = req.get("metadata") or {}
    value = {
        "provision_id": str(req["id"]),
        "document": req.get("regulatory_document"),
        "document_code": req.get("document_code"),
        "edition": req.get("edition"),
        "heading": req.get("chapter"),
        "clause": req.get("clause_reference"),
        "text": req.get("text"),
        "availability": req.get("provision_availability") or req.get("source_availability"),
        "document_note": metadata.get("document_note"),
    }
    _regulation_cache[provision_id] = (now + _REGULATION_CACHE_TTL_S, value)
    return value


def regulation_text_for_rule(db: Session, rule_id: str | None) -> dict[str, Any]:
    if not rule_id:
        raise HTTPException(status_code=404, detail="Unknown rule")
    try:
        rules_doc = json.loads(read_active_catalog_json(db, "rules"))
        links_doc = json.loads(read_active_catalog_json(db, "regulation-links"))
    except LookupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    rule_ids = {r.get("id") for r in rules_doc.get("rules", [])}
    if rule_id not in rule_ids:
        raise HTTPException(status_code=404, detail="Unknown rule")

    head = {
        "rule_id": rule_id,
        "database": links_doc.get("database"),
        "loaded_instruments": links_doc.get("loaded_instruments"),
        "method": links_doc.get("method"),
    }
    entry = (links_doc.get("rules") or {}).get(rule_id)
    if not entry:
        return {
            **head,
            "linked": False,
            "note": "No provision in the regulation database is linked to this rule.",
            "provisions": [],
        }

    provisions = []
    try:
        for link in entry.get("links", []):
            prov = _get_cached_provision(db, str(link["provision_id"]))
            provisions.append({**prov, "match": link.get("match"), "note": link.get("note")})
    except (SQLAlchemyError, HTTPException) as exc:
        reason = exc.detail if isinstance(exc, HTTPException) else "regulation table unavailable"
        return {
            **head,
            "linked": True,
            "reachable": False,
            "note": entry.get("note"),
            "error": f"Regulation database unavailable ({reason}).",
            "provisions": [
                {
                    "provision_id": link.get("provision_id"),
                    "clause": link.get("clause"),
                    "match": link.get("match"),
                    "note": link.get("note"),
                    "text": None,
                }
                for link in entry.get("links", [])
            ],
        }
    return {
        **head,
        "linked": True,
        "reachable": True,
        "note": entry.get("note"),
        "provisions": provisions,
    }


def is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in {"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"}


def require_loopback(request: Request) -> None:
    if not is_loopback(request):
        raise HTTPException(status_code=403, detail="Only available on this computer")


def _aps_credentials() -> tuple[str | None, str | None]:
    env_vals = _read_dotenv_keys(shipcheck_root() / "3D_Since_AI" / ".env", ("APS_CLIENT_",))
    cid = settings.aps_client_id or os.environ.get("APS_CLIENT_ID") or env_vals.get("APS_CLIENT_ID")
    secret = settings.aps_client_secret or os.environ.get("APS_CLIENT_SECRET") or env_vals.get("APS_CLIENT_SECRET")
    return cid, secret


def aps_status() -> dict[str, bool]:
    cid, secret = _aps_credentials()
    return {"configured": bool(cid and secret)}


def aps_token(request: Request) -> dict[str, Any]:
    global _aps_token_cache
    require_loopback(request)
    cid, secret = _aps_credentials()
    if not cid or not secret:
        raise HTTPException(status_code=503, detail="APS not configured")
    now = time.time()
    if _aps_token_cache and _aps_token_cache["expires"] > now + 60.0:
        return {
            "access_token": _aps_token_cache["access_token"],
            "expires_in": round(_aps_token_cache["expires"] - now),
        }
    basic = base64.b64encode(f"{cid}:{secret}".encode("utf-8")).decode("ascii")
    try:
        res = httpx.post(
            "https://developer.api.autodesk.com/authentication/v2/token",
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={"grant_type": "client_credentials", "scope": "viewables:read"},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="APS authentication failed") from exc
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"APS authentication failed ({res.status_code})")
    payload = res.json()
    expires_in = int(payload["expires_in"])
    _aps_token_cache = {
        "access_token": payload["access_token"],
        "expires": now + expires_in,
    }
    return {"access_token": payload["access_token"], "expires_in": expires_in}


def save_aps_fallback(request: Request, name: str, data_url: str) -> dict[str, Any]:
    require_loopback(request)
    if not _FALLBACK_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Expected { name: [a-z0-9-], dataUrl: PNG }")
    match = _DATA_URL_PNG_RE.match(data_url)
    if not match:
        raise HTTPException(status_code=400, detail="Expected { name: [a-z0-9-], dataUrl: PNG }")
    raw = base64.b64decode(match.group(1))
    fallback_dir = shipcheck_root() / "public" / "fallback"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    target = fallback_dir / f"{name}.png"
    target.write_bytes(raw)
    return {"saved": f"fallback/{name}.png", "bytes": len(raw)}


def _sinceai_data_dir() -> Path:
    return shipcheck_root() / "integrations" / "sinceai" / "data"


def evidence_provider_info() -> dict[str, Any]:
    kind = (os.environ.get("EVIDENCE_PROVIDER") or settings.evidence_provider or "sinceai").lower()
    if kind != "sinceai":
        return {"id": "none", "metadata": None}
    meta_file = _sinceai_data_dir() / "solas_ii2_revised_mca_metadata.json"
    metadata = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.is_file() else None
    return {"id": "sinceai", "metadata": metadata}


def evidence_search(query: str, limit: int = 8) -> dict[str, Any]:
    info = evidence_provider_info()
    if info["id"] == "none":
        return {"provider": "none", "results": []}
    corpus_file = _sinceai_data_dir() / "solas_ii2_revised_mca.jsonl"
    if not corpus_file.is_file():
        return {"provider": "sinceai", "results": []}
    terms = [t.lower() for t in re.findall(r"[a-z0-9]+", query) if len(t) > 1]
    if not terms:
        return {"provider": "sinceai", "results": []}
    scored: list[tuple[int, dict[str, Any]]] = []
    for line in corpus_file.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        haystack = " ".join(str(row.get(k, "")) for k in ("title", "heading", "clause", "text")).lower()
        hits = sum(haystack.count(t) for t in terms)
        if hits > 0:
            scored.append((hits, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return {"provider": "sinceai", "results": [item[1] for item in scored[:limit]]}


def evidence_review(filename: str, data_base64: str) -> dict[str, Any]:
    if len(data_base64) > 16_000_000:
        raise HTTPException(status_code=413, detail="Request too large")
    if not filename.lower().endswith(".docx"):
        raise HTTPException(status_code=422, detail="Only .docx files are supported by the local evidence review demo.")
    try:
        raw = base64.b64decode(data_base64)
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            xml_bytes = zf.read("word/document.xml")
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Could not read DOCX word/document.xml.") from exc

    root = ET.fromstring(xml_bytes)
    paragraphs: list[str] = []
    for p_el in root.iter():
        if p_el.tag.endswith("}p"):
            texts = [t.text for t in p_el.iter() if t.tag.endswith("}t") and t.text]
            joined = "".join(texts).strip()
            if joined:
                paragraphs.append(joined)
    preview = "\n\n".join(paragraphs[:12])
    query = " ".join(paragraphs[:3])[:200]
    matches = evidence_search(query, limit=6) if query else {"provider": evidence_provider_info()["id"], "results": []}
    return {
        "filename": filename,
        "paragraphCount": len(paragraphs),
        "preview": preview,
        "evidence": matches,
    }
