import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


JSON_DOCUMENT = JSON().with_variant(JSONB(), "postgresql")


class ShipCheckDatasetVersion(Base):
    __tablename__ = "sc_shipcheck_dataset_versions"
    __table_args__ = (
        UniqueConstraint("source_key", "content_sha256", name="uq_sc_shipcheck_version_source_hash"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    source_path: Mapped[str] = mapped_column(String(300), nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    collection_key: Mapped[str | None] = mapped_column(String(80), nullable=True)
    document_metadata: Mapped[dict[str, Any] | None] = mapped_column(JSON_DOCUMENT, nullable=True)
    record_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ShipCheckDatasetRecord(Base):
    __tablename__ = "sc_shipcheck_dataset_records"
    __table_args__ = (
        UniqueConstraint("dataset_version_id", "ordinal", name="uq_sc_shipcheck_record_version_ordinal"),
    )

    dataset_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey(
            "sc_shipcheck_dataset_versions.id",
            name="fk_sc_shipcheck_record_version",
            ondelete="RESTRICT",
        ),
        primary_key=True,
    )
    record_key: Mapped[str] = mapped_column(String(200), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[Any] = mapped_column(JSON_DOCUMENT, nullable=False)


class ShipCheckActiveDataset(Base):
    __tablename__ = "sc_shipcheck_active_datasets"

    source_key: Mapped[str] = mapped_column(String(80), primary_key=True)
    dataset_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey(
            "sc_shipcheck_dataset_versions.id",
            name="fk_sc_shipcheck_active_version",
            ondelete="RESTRICT",
        ),
        nullable=False,
    )
    activated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
