from typing import Literal, Protocol
from typing import Any

from pydantic import BaseModel, Field


SourceType = Literal["cad", "drawing", "document", "calculation", "spreadsheet", "manual", "other"]


class ImportedComponent(BaseModel):
    source_id: str
    component_type: str
    name: str
    properties: dict[str, Any] = Field(default_factory=dict)
    geometry_reference: dict[str, Any] | None = None
    source_reference: dict[str, Any] = Field(default_factory=dict)
    confidence: float | None = Field(default=None, ge=0, le=1)


class ImportedRelationship(BaseModel):
    source_id: str
    target_id: str
    relationship_type: str
    properties: dict[str, Any] = Field(default_factory=dict)


class ImportedFact(BaseModel):
    source_component_id: str | None = None
    fact_type: str
    statement: str
    value: Any | None = None
    source_reference: dict[str, Any]
    confidence: float | None = Field(default=None, ge=0, le=1)


class DesignImportResult(BaseModel):
    source_type: SourceType
    components: list[ImportedComponent] = Field(default_factory=list)
    relationships: list[ImportedRelationship] = Field(default_factory=list)
    facts: list[ImportedFact] = Field(default_factory=list)


class DesignImporter(Protocol):
    source_type: SourceType

    def parse(self, source: bytes, source_reference: dict[str, str]) -> DesignImportResult:
        """Convert an input source to the canonical design representation."""
