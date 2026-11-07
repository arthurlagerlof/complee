import uuid
from typing import Any

from pydantic import BaseModel, Field


class RequirementOut(BaseModel):
    id: uuid.UUID
    instrument_id: uuid.UUID
    text: str
    regulatory_document: str | None = None
    document_code: str | None = None
    edition: str | None = None
    chapter: str | None = None
    clause_reference: str | None = None
    page_number: int | None = None
    language: str | None = None
    applicability: list[str] | None = None
    instrument_applicability: list[str] = Field(default_factory=list)
    source_availability: str | None = None
    provision_availability: str | None = None
    source_url: str | None = None
    similarity_score: float | None = None
    meaning_distance: float | None = None
    word_search_score: float | None = None
    combined_score: float | None = None
    ranking_score: float | None = None
    retrieval_method: str | None = None
    retrieval_explanation: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class InstrumentOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    authority: str | None = None
    availability: str
    source_url: str | None = None
    note: str | None = None
    applies_to: list[str] = Field(default_factory=list)


class RetrievalFindingOut(BaseModel):
    id: uuid.UUID
    design_fact_id: uuid.UUID | None
    provision_id: uuid.UUID | None
    why: str | None
    clause_key: str | None
    heading_path: str | None
    body: str | None
    availability: str | None


class LegacyDesignFactOut(BaseModel):
    id: uuid.UUID
    kind: str | None = None
    name: str | None = None
    deck: str | None = None
    value: str | None = None
    source_file: str | None = None
