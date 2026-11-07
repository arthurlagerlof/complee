"""Ship engineering knowledge layer API: component taxonomy, expected properties, relationships, terminology,
units and the link from component types to regulatory provision retrieval. Read-only."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.services import knowledge

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


class InterpretRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    include_context: bool = False


class ConvertRequest(BaseModel):
    value: float
    unit: str = Field(min_length=1, max_length=20)


@router.get("/catalogue")
def catalogue_summary() -> dict[str, Any]:
    c = knowledge.catalogue()
    return {
        "version": c.version,
        "scope_note": c.scope_note,
        "categories": c.categories,
        "relationship_types": c.relationship_types,
        "component_type_count": len(c.component_types),
        "abbreviation_count": len(c.abbreviations),
        "regulatory_term_count": len(c.regulatory_terms),
        "units": c.units["canonical"],
    }


@router.get("/component-types")
def component_types(category: str | None = None) -> list[dict[str, Any]]:
    return [
        t.model_dump()
        for t in knowledge.catalogue().component_types
        if category is None or t.category == category
    ]


@router.get("/component-types/{type_id}")
def component_type(type_id: str) -> dict[str, Any]:
    t = knowledge.component_type(type_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Component type not found.")
    return t.model_dump()


@router.get("/component-types/{type_id}/regulations")
def component_type_regulations(
    type_id: str, limit: int = Query(default=10, ge=1, le=50), db: Session = Depends(get_db)
) -> dict[str, Any]:
    try:
        return knowledge.regulations_for_type(db, type_id, limit)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Component type not found.") from exc


@router.get("/abbreviations")
def abbreviations() -> list[dict[str, Any]]:
    return [a.model_dump() for a in knowledge.catalogue().abbreviations]


@router.get("/terms")
def terms(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    c = knowledge.catalogue()
    defs = knowledge.definitions(db, [t["definition"] for t in c.regulatory_terms])
    return [{**t, "definition_text": defs.get(t["definition"])} for t in c.regulatory_terms]


@router.post("/interpret")
def interpret(payload: InterpretRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    """Deterministic hints for a name, label or text: component types, abbreviations and tag structure."""
    out: dict[str, Any] = {
        "component_types": knowledge.match_component_types(payload.text),
        "abbreviations": knowledge.find_abbreviations(payload.text),
        "tag": knowledge.parse_tag(payload.text) if len(payload.text) <= 80 else None,
        "note": "Hints for engineer review and AI context; not a classification.",
    }
    if payload.include_context:
        out["context"] = knowledge.context_for_source(payload.text, db)
    return out


@router.post("/convert")
def convert(payload: ConvertRequest) -> dict[str, Any]:
    result = knowledge.convert(payload.value, payload.unit)
    if result is None:
        raise HTTPException(status_code=422, detail=f"Unknown unit: {payload.unit}")
    return result
