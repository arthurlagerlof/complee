import uuid
from typing import Any

from pydantic import BaseModel, Field


class RequirementOut(BaseModel):
    id: uuid.UUID
    text: str
    regulatory_document: str | None = None
    document_code: str | None = None
    edition: str | None = None
    chapter: str | None = None
    clause_reference: str | None = None
    page_number: int | None = None
    language: str | None = None
    applicability: list[str] | None = None
    source_url: str | None = None
    ranking_score: float | None = None
    retrieval_method: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
