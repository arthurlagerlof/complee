import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.schemas.regulation import RequirementOut
from app.services.retrieval.service import EmbeddingProviderError, get_requirement, search_regulations


router = APIRouter()


class RegulationSearchResponse(BaseModel):
    results: list[RequirementOut]
    semantic_search_enabled: bool


@router.get("/regulations/search", response_model=RegulationSearchResponse)
def search(
    query: str = Query(min_length=1, max_length=2000),
    document: str | None = Query(default=None, max_length=200),
    edition: str | None = Query(default=None, max_length=200),
    chapter: str | None = Query(default=None, max_length=300),
    clause: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=10, ge=1, le=50),
    db: Session = Depends(get_db),
):
    try:
        results, semantic_enabled = search_regulations(
            db,
            query,
            limit,
            {"document": document, "edition": edition, "chapter": chapter, "clause": clause},
        )
    except EmbeddingProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return RegulationSearchResponse(results=results, semantic_search_enabled=semantic_enabled)


@router.get("/regulations/{requirement_id}", response_model=RequirementOut)
def retrieve_requirement(requirement_id: uuid.UUID, db: Session = Depends(get_db)):
    requirement = get_requirement(db, requirement_id)
    if requirement is None:
        raise HTTPException(status_code=404, detail="Regulatory requirement not found.")
    return requirement
