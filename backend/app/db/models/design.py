import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON, String, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base


JSON_DOCUMENT = JSON().with_variant(JSONB(), "postgresql")


class Project(Base):
    __tablename__ = "sc_projects"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    vessels: Mapped[list["Vessel"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class Vessel(Base):
    __tablename__ = "sc_vessels"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    vessel_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    project: Mapped[Project] = relationship(back_populates="vessels")
    revisions: Mapped[list["DesignRevision"]] = relationship(
        back_populates="vessel", cascade="all, delete-orphan"
    )


class DesignRevision(Base):
    __tablename__ = "sc_design_revisions"
    __table_args__ = (
        UniqueConstraint("vessel_id", "revision_number", name="uq_sc_revision_vessel_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vessel_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_vessels.id", ondelete="CASCADE"), nullable=False, index=True
    )
    revision_name: Mapped[str] = mapped_column(String(200), nullable=False)
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_version: Mapped[str] = mapped_column(String(50), nullable=False, default="1.0")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="draft")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    vessel: Mapped[Vessel] = relationship(back_populates="revisions")
    components: Mapped[list["DesignComponent"]] = relationship(
        back_populates="revision", cascade="all, delete-orphan"
    )
    relationships: Mapped[list["ComponentRelationship"]] = relationship(
        back_populates="revision", cascade="all, delete-orphan"
    )
    assessments: Mapped[list["Assessment"]] = relationship(
        back_populates="revision", cascade="all, delete-orphan"
    )


class DesignComponent(Base):
    __tablename__ = "sc_design_components"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_design_revisions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    component_type: Mapped[str] = mapped_column(String(100), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    properties: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    geometry_reference: Mapped[dict[str, Any] | None] = mapped_column(JSON_DOCUMENT, nullable=True)
    source_reference: Mapped[dict[str, Any] | None] = mapped_column(JSON_DOCUMENT, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    review_status: Mapped[str] = mapped_column(String(40), nullable=False, default="unreviewed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    revision: Mapped[DesignRevision] = relationship(back_populates="components")


class ComponentRelationship(Base):
    __tablename__ = "sc_component_relationships"
    __table_args__ = (
        UniqueConstraint(
            "revision_id", "source_component_id", "target_component_id", "relationship_type",
            name="uq_sc_component_relationship",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_design_revisions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_component_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_design_components.id", ondelete="CASCADE"), nullable=False
    )
    target_component_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("sc_design_components.id", ondelete="CASCADE"), nullable=False
    )
    relationship_type: Mapped[str] = mapped_column(String(100), nullable=False)
    properties: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    revision: Mapped[DesignRevision] = relationship(back_populates="relationships")
