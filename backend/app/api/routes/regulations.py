import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.database import get_db
from app.schemas.regulation import InstrumentOut, LegacyDesignFactOut, RequirementOut, RetrievalFindingOut
from app.services.retrieval.adapters import design_query_adapter
from app.services.retrieval.service import (
    EmbeddingProviderError,
    VectorSearchUnavailable,
    get_legacy_design_fact,
    get_instrument,
    get_requirement,
    get_retrieval_finding,
    list_legacy_design_facts,
    list_retrieval_findings,
    search_regulations,
)


router = APIRouter()


class RegulationSearchResponse(BaseModel):
    results: list[RequirementOut]
    semantic_search_enabled: bool
    search_mode: str


@router.get("/regulations/search", response_model=RegulationSearchResponse)
def search(
    query: str | None = Query(default=None, min_length=1, max_length=2000),
    design_revision_id: uuid.UUID | None = None,
    design_component_id: uuid.UUID | None = None,
    design_fact_id: list[uuid.UUID] | None = Query(default=None, max_length=20),
    legacy_design_fact_id: uuid.UUID | None = None,
    document: str | None = Query(default=None, max_length=200),
    edition: str | None = Query(default=None, max_length=200),
    chapter: str | None = Query(default=None, max_length=300),
    clause: str | None = Query(default=None, max_length=200),
    ship_type: str | None = Query(default=None, max_length=100),
    topic: list[str] | None = Query(default=None, max_length=20),
    mode: Literal["hybrid", "vector", "full_text"] = "hybrid",
    limit: int = Query(default=10, ge=1, le=50),
    db: Session = Depends(get_db),
):
    search_query = design_query_adapter.build_query(
        db,
        query=query,
        revision_id=design_revision_id,
        component_id=design_component_id,
        fact_ids=design_fact_id,
        legacy_fact_id=legacy_design_fact_id,
    )
    try:
        results, semantic_enabled = search_regulations(
            db,
            search_query,
            limit,
            {
                "document": document,
                "edition": edition,
                "chapter": chapter,
                "clause": clause,
                "ship_type": ship_type,
                "topics": topic,
            },
            mode,
        )
    except (EmbeddingProviderError, VectorSearchUnavailable) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return RegulationSearchResponse(
        results=results, semantic_search_enabled=semantic_enabled, search_mode=mode
    )


@router.get("/legacy-design-facts", response_model=list[LegacyDesignFactOut])
def list_existing_design_facts(
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    return list_legacy_design_facts(db, limit)


@router.get("/legacy-design-facts/{fact_id}", response_model=LegacyDesignFactOut)
def retrieve_existing_design_fact(fact_id: uuid.UUID, db: Session = Depends(get_db)):
    fact = get_legacy_design_fact(db, fact_id)
    if fact is None:
        raise HTTPException(status_code=404, detail="Legacy design fact not found.")
    return fact


@router.get("/instruments/{instrument_id}", response_model=InstrumentOut)
def retrieve_instrument(instrument_id: uuid.UUID, db: Session = Depends(get_db)):
    instrument = get_instrument(db, instrument_id)
    if instrument is None:
        raise HTTPException(status_code=404, detail="Regulatory instrument not found.")
    return instrument


@router.get("/retrieval-findings", response_model=list[RetrievalFindingOut])
def retrieve_matches(
    design_fact_id: uuid.UUID | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    return list_retrieval_findings(db, design_fact_id, limit)


@router.get("/retrieval-findings/{finding_id}", response_model=RetrievalFindingOut)
def retrieve_match(finding_id: uuid.UUID, db: Session = Depends(get_db)):
    finding = get_retrieval_finding(db, finding_id)
    if finding is None:
        raise HTTPException(status_code=404, detail="Saved retrieval finding not found.")
    return finding


@router.get("/regulations/{requirement_id}", response_model=RequirementOut)
def retrieve_requirement(requirement_id: uuid.UUID, db: Session = Depends(get_db)):
    requirement = get_requirement(db, requirement_id)
    if requirement is None:
        raise HTTPException(status_code=404, detail="Regulatory requirement not found.")
    return requirement
