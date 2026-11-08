import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator


class AssessmentCreate(BaseModel):
    revision_id: uuid.UUID


class RequirementCandidateInput(BaseModel):
    requirement_id: uuid.UUID
    retrieval_finding_id: uuid.UUID | None = None
    component_ids: list[uuid.UUID] = Field(default_factory=list)
    required_information: list[str] = Field(default_factory=list)
    verification_method: str = Field(default="engineering_review", min_length=1, max_length=100)
    tool_name: str | None = Field(default=None, min_length=1, max_length=100)
    tool_inputs: dict[str, Any] = Field(default_factory=dict)


class AssessmentRunRequest(BaseModel):
    revision_id: uuid.UUID
    candidates: list[RequirementCandidateInput] = Field(default_factory=list, max_length=50)
    query: str | None = Field(default=None, min_length=1, max_length=2000)
    retrieval_mode: Literal["hybrid", "vector", "full_text"] = "hybrid"
    limit: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def require_candidate_source(self) -> "AssessmentRunRequest":
        if not self.candidates and not self.query:
            raise ValueError("Provide explicit candidates or a retrieval query.")
        return self


class FindingCreate(BaseModel):
    assessment_id: uuid.UUID
    requirement_id: uuid.UUID
    component_ids: list[uuid.UUID] = Field(default_factory=list)
    retrieval_finding_id: uuid.UUID | None = None
    verification_method: str = Field(default="engineering_review", min_length=1, max_length=100)
    finding_type: Literal[
        "potential_issue",
        "missing_information",
        "needs_review",
        "needs_engineering_review",
        "evidence_found",
        "verified_by_engineer",
    ]
    status: Literal["open", "under_review", "accepted", "resolved", "dismissed"] = "open"
    description: str = Field(min_length=1)
    evidence: dict[str, Any] = Field(default_factory=dict)
    calculation_results: dict[str, Any] = Field(default_factory=dict)
    assumptions: dict[str, Any] = Field(default_factory=dict)
    suggested_action: str | None = None

    @model_validator(mode="after")
    def require_review_for_verified_type(self) -> "FindingCreate":
        if self.finding_type == "verified_by_engineer":
            raise ValueError("Create the finding first, then record engineer verification through review.")
        return self


class FindingUpdate(BaseModel):
    finding_type: Literal[
        "potential_issue",
        "missing_information",
        "needs_review",
        "needs_engineering_review",
        "evidence_found",
        "verified_by_engineer",
    ] | None = None
    status: Literal["open", "under_review", "accepted", "resolved", "dismissed"] | None = None
    description: str | None = Field(default=None, min_length=1)
    evidence: dict[str, Any] | None = None
    calculation_results: dict[str, Any] | None = None
    assumptions: dict[str, Any] | None = None
    suggested_action: str | None = None
    reviewed_by: str | None = Field(default=None, min_length=1, max_length=200)
    review_notes: str | None = None

    @model_validator(mode="after")
    def reject_null_required_fields(self) -> "FindingUpdate":
        for field in (
            "finding_type",
            "status",
            "description",
            "evidence",
            "calculation_results",
            "assumptions",
            "reviewed_by",
        ):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        return self


class FindingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    assessment_id: uuid.UUID
    requirement_id: uuid.UUID
    component_ids: list[uuid.UUID]
    retrieval_finding_id: uuid.UUID | None
    requirement_snapshot: dict[str, Any]
    verification_method: str
    finding_type: str
    status: str
    description: str
    evidence: dict[str, Any]
    calculation_results: dict[str, Any]
    assumptions: dict[str, Any]
    suggested_action: str | None
    reviewed_by: str | None
    review_notes: str | None
    reviewed_at: datetime | None
    created_at: datetime

    # Convenience views of the stored record (nothing extra is stored): the assessment status, the provision reference
    # and the two scores kept in calculation_results.scores. The scores never change the status or review state.
    @computed_field
    @property
    def assessment_status(self) -> str:
        return self.finding_type

    @computed_field
    @property
    def review_status(self) -> str:
        if self.finding_type == "verified_by_engineer":
            return "verified_by_engineer"
        return "reviewed" if self.reviewed_by else "pending"

    @computed_field
    @property
    def provision_reference(self) -> dict[str, Any]:
        snapshot = self.requirement_snapshot or {}
        return {"provision_id": snapshot.get("id"), "source": snapshot.get("instrument_code"),
                "chapter": snapshot.get("heading_path"), "clause": snapshot.get("clause_key"),
                "edition": snapshot.get("edition")}

    @computed_field
    @property
    def rule_ambiguity(self) -> dict[str, Any] | None:
        return ((self.calculation_results or {}).get("scores") or {}).get("rule_ambiguity")

    @computed_field
    @property
    def compliance_likelihood(self) -> dict[str, Any] | None:
        return ((self.calculation_results or {}).get("scores") or {}).get("compliance_likelihood")


class AssessmentOut(AssessmentCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: str
    created_at: datetime
    completed_at: datetime | None
    findings: list[FindingOut] = Field(default_factory=list)
