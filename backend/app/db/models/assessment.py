import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base
from app.db.models.design import JSON_DOCUMENT


class Assessment(Base):
    __tablename__ = "sc_assessments"
    __table_args__ = (UniqueConstraint("id", "revision_id", name="uq_sc_assessment_revision"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_design_revisions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="in_progress")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revision: Mapped["DesignRevision"] = relationship(back_populates="assessments")
    findings: Mapped[list["Finding"]] = relationship(
        back_populates="assessment", cascade="all, delete-orphan"
    )


class Finding(Base):
    __tablename__ = "sc_findings"
    __table_args__ = (
        UniqueConstraint("id", "revision_id", name="uq_sc_finding_revision"),
        ForeignKeyConstraint(
            ["assessment_id", "revision_id"],
            ["sc_assessments.id", "sc_assessments.revision_id"],
            name="fk_sc_finding_assessment_revision",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assessment_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), nullable=False, index=True
    )
    revision_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    requirement_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    retrieval_finding_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    requirement_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    verification_method: Mapped[str] = mapped_column(String(100), nullable=False, default="engineering_review")
    finding_type: Mapped[str] = mapped_column(String(40), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="open")
    description: Mapped[str] = mapped_column(String, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    calculation_results: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    assumptions: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    suggested_action: Mapped[str | None] = mapped_column(String, nullable=True)
    reviewed_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    review_notes: Mapped[str | None] = mapped_column(String, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    assessment: Mapped[Assessment] = relationship(back_populates="findings")
    component_links: Mapped[list["FindingComponent"]] = relationship(
        back_populates="finding", cascade="all, delete-orphan", foreign_keys="FindingComponent.finding_id"
    )

    @property
    def component_ids(self) -> list[uuid.UUID]:
        return [link.component_id for link in self.component_links]


class FindingComponent(Base):
    __tablename__ = "sc_finding_components"
    __table_args__ = (
        ForeignKeyConstraint(
            ["finding_id", "revision_id"],
            ["sc_findings.id", "sc_findings.revision_id"],
            name="fk_sc_finding_component_finding_revision",
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["revision_id", "component_id"],
            ["sc_design_components.revision_id", "sc_design_components.id"],
            name="fk_sc_finding_component_design_revision",
            ondelete="CASCADE",
        ),
    )

    finding_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    component_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    revision_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False, index=True)
    finding: Mapped[Finding] = relationship(back_populates="component_links", foreign_keys=[finding_id])
