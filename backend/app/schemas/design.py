import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


SOURCE_TYPES = {"cad", "drawing", "document", "calculation", "spreadsheet", "manual", "other"}


def validate_source_type(source_reference: dict[str, Any]) -> dict[str, Any]:
    source_type = source_reference.get("source_type")
    if source_type is not None and (
        not isinstance(source_type, str) or source_type not in SOURCE_TYPES
    ):
        raise ValueError(f"source_type must be one of {sorted(SOURCE_TYPES)}.")
    return source_reference


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None


class ProjectOut(ProjectCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class VesselCreate(BaseModel):
    project_id: uuid.UUID
    name: str = Field(min_length=1, max_length=200)
    vessel_type: str | None = Field(default=None, max_length=100)
    description: str | None = None


class VesselOut(VesselCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID


class DesignRevisionCreate(BaseModel):
    vessel_id: uuid.UUID
    revision_name: str = Field(min_length=1, max_length=200)
    revision_number: int = Field(ge=1)
    schema_version: str = Field(default="1.0", min_length=1, max_length=50)
    status: str = Field(default="draft", min_length=1, max_length=40)


class DesignRevisionOut(DesignRevisionCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime


class DesignComponentCreate(BaseModel):
    revision_id: uuid.UUID
    component_type: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    properties: dict[str, Any] = Field(default_factory=dict)
    geometry_reference: dict[str, Any] | None = None
    source_reference: dict[str, Any] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    review_status: str = Field(default="unreviewed", min_length=1, max_length=40)

    @model_validator(mode="after")
    def validate_references(self) -> "DesignComponentCreate":
        if self.source_reference is not None:
            validate_source_type(self.source_reference)
        return self


class DesignComponentUpdate(BaseModel):
    component_type: str | None = Field(default=None, min_length=1, max_length=100)
    name: str | None = Field(default=None, min_length=1, max_length=200)
    properties: dict[str, Any] | None = None
    geometry_reference: dict[str, Any] | None = None
    source_reference: dict[str, Any] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    review_status: str | None = Field(default=None, min_length=1, max_length=40)

    @model_validator(mode="after")
    def reject_null_required_fields(self) -> "DesignComponentUpdate":
        for field in ("component_type", "name", "properties", "review_status"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        if self.source_reference is not None:
            validate_source_type(self.source_reference)
        return self


class DesignComponentOut(DesignComponentCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class ComponentRelationshipCreate(BaseModel):
    revision_id: uuid.UUID
    source_component_id: uuid.UUID
    target_component_id: uuid.UUID
    relationship_type: str = Field(min_length=1, max_length=100)
    properties: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def components_must_differ(self) -> "ComponentRelationshipCreate":
        if self.source_component_id == self.target_component_id:
            raise ValueError("A component cannot be related to itself.")
        return self


class ComponentRelationshipOut(ComponentRelationshipCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID


class DesignFactCreate(BaseModel):
    revision_id: uuid.UUID
    component_id: uuid.UUID | None = None
    fact_type: str = Field(min_length=1, max_length=100)
    statement: str = Field(min_length=1)
    value: Any | None = None
    source_reference: dict[str, Any]
    confidence: float | None = Field(default=None, ge=0, le=1)
    review_status: str = Field(default="unreviewed", min_length=1, max_length=40)

    @model_validator(mode="after")
    def validate_source(self) -> "DesignFactCreate":
        validate_source_type(self.source_reference)
        return self


class DesignFactUpdate(BaseModel):
    component_id: uuid.UUID | None = None
    fact_type: str | None = Field(default=None, min_length=1, max_length=100)
    statement: str | None = Field(default=None, min_length=1)
    value: Any | None = None
    source_reference: dict[str, Any] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    review_status: str | None = Field(default=None, min_length=1, max_length=40)

    @model_validator(mode="after")
    def validate_source(self) -> "DesignFactUpdate":
        for field in ("fact_type", "statement", "review_status"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null.")
        if "source_reference" in self.model_fields_set and self.source_reference is None:
            raise ValueError("source_reference cannot be null.")
        if self.source_reference is not None:
            validate_source_type(self.source_reference)
        return self


class DesignFactOut(DesignFactCreate):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


class DesignRevisionDetail(DesignRevisionOut):
    components: list[DesignComponentOut] = Field(default_factory=list)
    relationships: list[ComponentRelationshipOut] = Field(default_factory=list)
    facts: list[DesignFactOut] = Field(default_factory=list)


class RetrievalContextOut(BaseModel):
    revision_id: uuid.UUID
    description: str
