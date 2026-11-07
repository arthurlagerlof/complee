import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

class AssessmentCreate(BaseModel):
    revision_id: uuid.UUID


class FindingCreate(BaseModel):
    assessment_id: uuid.UUID
    requirement_id: uuid.UUID
    component_ids: list[uuid.UUID] = Field(default_factory=list)
    finding_type: Literal[
        "potential_issue", "missing_information", "needs_review", "evidence_found", "verified_by_engineer"
    ]
    status: Literal["open", "under_review", "accepted", "resolved", "dismissed"] = "open"
    description: str = Field(min_length=1)
    evidence: dict[str, Any] = Field(default_factory=dict)
    calculation_results: dict[str, Any] = Field(default_factory=dict)
    assumptions: dict[str, Any] = Field(default_factory=dict)
    suggested_action: str | None = None


class FindingUpdate(BaseModel):
    status: Literal["open", "under_review", "accepted", "resolved", "dismissed"] | None = None
    description: str | None = Field(default=None, min_length=1)
    evidence: dict[str, Any] | None = None
    calculation_results: dict[str, Any] | None = None
    assumptions: dict[str, Any] | None = None
    suggested_action: str | None = None
    reviewed_by: str | None = Field(default=None, min_length=1, max_length=200)
    review_notes: str | None = None


class FindingOut(FindingCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    reviewed_by: str | None
    review_notes: str | None
    reviewed_at: datetime | None
    created_at: datetime


class AssessmentOut(AssessmentCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    created_at: datetime
    completed_at: datetime | None
    findings: list[FindingOut] = Field(default_factory=list)
