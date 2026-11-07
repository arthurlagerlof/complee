import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base
from app.db.models.design import JSON_DOCUMENT


class AIProvider(Base):
    __tablename__ = "sc_ai_providers"
    __table_args__ = (
        CheckConstraint(
            "provider_type IN ('ollama', 'openai_compatible', 'openai', 'anthropic')",
            name="provider_type_supported",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    provider_type: Mapped[str] = mapped_column(String(40), nullable=False)
    base_url: Mapped[str] = mapped_column(String(2048), nullable=False)
    encrypted_api_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    is_local: Mapped[bool] = mapped_column(default=False, nullable=False)
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_successful_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_success: Mapped[bool | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AIModelConfig(Base):
    __tablename__ = "sc_ai_model_configs"
    __table_args__ = (
        UniqueConstraint("provider_id", "id", name="uq_sc_ai_model_provider_id"),
        UniqueConstraint("provider_id", "model_name", name="uq_sc_ai_model_provider_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("sc_ai_providers.id", name="fk_sc_ai_models_provider", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    model_name: Mapped[str] = mapped_column(String(300), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    supported_capabilities: Mapped[list[str]] = mapped_column(JSON_DOCUMENT, nullable=False, default=list)
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AITaskConfiguration(Base):
    __tablename__ = "sc_ai_task_configurations"
    __table_args__ = (
        ForeignKeyConstraint(
            ["provider_id", "model_id"],
            ["sc_ai_model_configs.provider_id", "sc_ai_model_configs.id"],
            name="fk_sc_ai_task_model_provider",
            ondelete="CASCADE",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_name: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    provider_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("sc_ai_providers.id", name="fk_sc_ai_tasks_provider", ondelete="CASCADE"),
        nullable=False,
    )
    model_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    generation_settings: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AIExecution(Base):
    __tablename__ = "sc_ai_executions"
    __table_args__ = (
        ForeignKeyConstraint(
            ["provider_id", "model_id"],
            ["sc_ai_model_configs.provider_id", "sc_ai_model_configs.id"],
            name="fk_sc_ai_execution_model_provider",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("sc_ai_providers.id", name="fk_sc_ai_executions_provider", ondelete="RESTRICT"),
        nullable=False,
    )
    model_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    task_name: Mapped[str] = mapped_column(String(80), nullable=False)
    prompt_template_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    output_schema_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    processing_status: Mapped[str] = mapped_column(String(40), nullable=False)
    execution_duration_ms: Mapped[int] = mapped_column(nullable=False)
    token_usage: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    validation_outcome: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class AIExtraction(Base):
    __tablename__ = "sc_ai_extractions"
    __table_args__ = (
        ForeignKeyConstraint(
            ["provider_id", "model_id"],
            ["sc_ai_model_configs.provider_id", "sc_ai_model_configs.id"],
            name="fk_sc_ai_extraction_model_provider",
            ondelete="RESTRICT",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    revision_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("sc_design_revisions.id", name="fk_sc_ai_extractions_revision", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("sc_ai_providers.id", name="fk_sc_ai_extractions_provider", ondelete="RESTRICT"),
        nullable=False,
    )
    model_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    execution_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("sc_ai_executions.id", name="fk_sc_ai_extractions_execution", ondelete="RESTRICT"),
        nullable=False,
    )
    task_name: Mapped[str] = mapped_column(String(80), nullable=False)
    prompt_template_version: Mapped[str] = mapped_column(String(80), nullable=False)
    output_schema_version: Mapped[str] = mapped_column(String(80), nullable=False)
    source_reference: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    result: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False)
    processing_status: Mapped[str] = mapped_column(String(40), nullable=False, default="completed")
    execution_duration_ms: Mapped[int] = mapped_column(nullable=False)
    token_usage: Mapped[dict[str, Any]] = mapped_column(JSON_DOCUMENT, nullable=False, default=dict)
    validation_outcome: Mapped[str] = mapped_column(String(40), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
