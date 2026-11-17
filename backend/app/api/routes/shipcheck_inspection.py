"""Unified FastAPI routes for the ShipCheck inspection UI, model streaming, and evidence endpoints."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services import shipcheck_runtime as rt
from app.services.shipcheck_catalog import read_active_catalog_json

router = APIRouter(tags=["shipcheck-inspection"], dependencies=[Depends(rt.enforce_rate_limit)])


class ApsFallbackIn(BaseModel):
    name: str
    dataUrl: str


class EvidenceReviewIn(BaseModel):
    filename: str = ""
    dataBase64: str = ""


@router.get("/api/evidence/provider")
def root_evidence_provider() -> dict[str, Any]:
    return rt.evidence_provider_info()


@router.get("/api/evidence/search")
def root_evidence_search(
    q: str = "",
    limit: int = Query(default=8, ge=1, le=50),
) -> dict[str, Any]:
    return rt.evidence_search(q, limit=limit)


@router.post("/api/evidence/review")
def root_evidence_review(payload: EvidenceReviewIn) -> dict[str, Any]:
    return rt.evidence_review(payload.filename, payload.dataBase64)


@router.get("/inspection/api/health")
def inspection_health() -> dict[str, Any]:
    return rt.health_payload()


@router.get("/inspection/api/catalog/{source_key}")
def inspection_catalog(source_key: str, db: Session = Depends(get_db)) -> Response:
    try:
        body = read_active_catalog_json(db, source_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown ShipCheck catalog.") from exc
    except (LookupError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(content=body, media_type="application/json", headers={"Cache-Control": "no-store"})


@router.get("/inspection/api/scenarios")
def inspection_scenarios(db: Session = Depends(get_db)) -> list[Any]:
    try:
        doc = json.loads(read_active_catalog_json(db, "scenarios"))
    except (LookupError, RuntimeError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return doc.get("scenarios", [])


@router.get("/inspection/api/rules")
def inspection_rules(db: Session = Depends(get_db)) -> Response:
    return inspection_catalog("rules", db=db)


@router.get("/inspection/api/regulations/text")
def inspection_regulation_text(
    rule: str | None = None,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return rt.regulation_text_for_rule(db, rule)


@router.get("/inspection/api/model/config")
def inspection_model_config() -> dict[str, Any]:
    return rt.model_config_payload()


@router.get("/inspection/api/aps/status")
def inspection_aps_status() -> dict[str, bool]:
    return rt.aps_status()


@router.get("/inspection/api/aps/token")
def inspection_aps_token(request: Request) -> dict[str, Any]:
    return rt.aps_token(request)


@router.post("/inspection/api/aps/fallback")
def inspection_aps_fallback(request: Request, payload: ApsFallbackIn) -> dict[str, Any]:
    return rt.save_aps_fallback(request, payload.name, payload.dataUrl)


@router.get("/inspection/api/evidence/provider")
def inspection_evidence_provider() -> dict[str, Any]:
    return rt.evidence_provider_info()


@router.get("/inspection/api/evidence/search")
def inspection_evidence_search(
    q: str = "",
    limit: int = Query(default=8, ge=1, le=50),
) -> dict[str, Any]:
    return rt.evidence_search(q, limit=limit)


@router.post("/inspection/api/evidence/review")
def inspection_evidence_review(request: Request, payload: EvidenceReviewIn) -> dict[str, Any]:
    rt.require_loopback(request)
    return rt.evidence_review(payload.filename, payload.dataBase64)


@router.api_route("/inspection/model/{file_path:path}", methods=["GET", "HEAD"])
def inspection_model_file(file_path: str, request: Request) -> Response:
    return rt.serve_model_file(file_path, request)


@router.get("/inspection", include_in_schema=False)
def inspection_redirect(request: Request) -> RedirectResponse:
    query = f"?{request.url.query}" if request.url.query else ""
    return RedirectResponse(url=f"/inspection/{query}", status_code=302)


@router.api_route("/inspection/{file_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def inspection_static(file_path: str, request: Request) -> Response:
    resolved = rt.resolve_static_file(file_path)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Not found")
    return rt._range_file_response(resolved, request)
