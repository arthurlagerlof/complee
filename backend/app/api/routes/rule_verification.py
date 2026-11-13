"""Rule verification API (see app/services/rule_verification.py). Needs the database."""
import base64
import binascii
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services import rule_verification as rv

router = APIRouter(prefix="/rule-verification", tags=["rule verification"])
MAX_SOURCE_BYTES = 40 * 1024 * 1024


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except rv.VerificationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/status")
def status(db: Session = Depends(get_db)):
    return rv.status(db)


@router.get("/catalog")
def catalog(db: Session = Depends(get_db)):
    return {"note": "Latest version of every rule in the verification database.", "rules": rv.catalog(db)}


@router.get("/rules/{rule_id}")
def rule(rule_id: str, db: Session = Depends(get_db)):
    return _guard(rv.rule_detail, db, rule_id)


@router.post("/import")
def import_rules(payload: dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    rules = payload.get("rules")
    if not isinstance(rules, list):
        raise HTTPException(status_code=422, detail='"rules" must be a list.')
    return _guard(rv.import_rules, db, rules, payload.get("actor", ""))


@router.get("/sources")
def sources(db: Session = Depends(get_db)):
    return {"sources": rv.list_sources(db)}


@router.post("/sources")
def add_source(payload: dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    try:
        data = base64.b64decode(payload.get("content_base64") or "", validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=422, detail="The file content is not valid base64.") from exc
    if not data:
        raise HTTPException(status_code=422, detail="The file is empty.")
    if len(data) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 40 MB.")
    src, created = _guard(
        rv.add_source, db, filename=str(payload.get("filename") or "source.txt"), data=data,
        instrument=payload.get("instrument", ""), edition=payload.get("edition", ""), licence=payload.get("licence", ""),
        actor=payload.get("actor", ""), published=payload.get("published"), effective=payload.get("effective"), publisher=payload.get("publisher"),
    )
    return {"source": rv.source_out(src), "created": created}


@router.post("/quote-check")
def quote_check(payload: dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    return _guard(rv.check_quote, db, payload.get("source_id"), payload.get("quote") or "")


@router.post("/rules/{rule_id}/propose")
def propose(rule_id: str, payload: dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    return _guard(rv.propose, db, rule_id, payload.get("source_id"), payload.get("hint") or "")


@router.post("/rules/{rule_id}/versions")
def create_version(rule_id: str, payload: dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    v = _guard(rv.create_version, db, rule_id, payload.get("logic"), payload.get("evidence") or [], payload.get("author", ""), payload.get("change_reason", ""))
    return {"id": str(v.id), "version": v.version}


@router.post("/versions/{version_id}/verifications")
def verify(version_id: str, payload: dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    level = payload.get("level")
    rec = _guard(rv.verify, db, version_id, level=int(level) if str(level).isdigit() else 0, reviewer=payload.get("reviewer", ""),
                 decision=payload.get("decision", ""), note=payload.get("note", ""), checklist=payload.get("checklist"))
    return {"id": str(rec.id), "level": rec.level, "decision": rec.decision}
