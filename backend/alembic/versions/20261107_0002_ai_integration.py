"""Add provider-independent AI configuration and extraction review storage.

Revision ID: 20261107_0002
Revises: 20261107_0001
Create Date: 2026-11-07
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20261107_0002"
down_revision = "20261107_0001"
branch_labels = None
depends_on = None


def _jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "sc_ai_providers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("provider_type", sa.String(40), nullable=False),
        sa.Column("base_url", sa.String(2048), nullable=False),
        sa.Column("encrypted_api_key", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("is_local", sa.Boolean(), nullable=False),
        sa.Column("configuration", _jsonb(), nullable=False),
        sa.Column("last_tested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_successful_test_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_test_success", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint(
            "provider_type IN ('ollama', 'openai_compatible', 'openai', 'anthropic')",
            name="ck_sc_ai_providers_provider_type_supported",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_ai_providers"),
        sa.UniqueConstraint("name", name="uq_sc_ai_providers_name"),
    )
    op.create_table(
        "sc_ai_model_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("model_name", sa.String(300), nullable=False),
        sa.Column("display_name", sa.String(300), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("supported_capabilities", _jsonb(), nullable=False),
        sa.Column("configuration", _jsonb(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["provider_id"], ["sc_ai_providers.id"], name="fk_sc_ai_models_provider", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_ai_model_configs"),
        sa.UniqueConstraint("provider_id", "id", name="uq_sc_ai_model_provider_id"),
        sa.UniqueConstraint("provider_id", "model_name", name="uq_sc_ai_model_provider_name"),
    )
    op.create_index("ix_sc_ai_model_configs_provider_id", "sc_ai_model_configs", ["provider_id"])
    op.create_table(
        "sc_ai_task_configurations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_name", sa.String(80), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("generation_settings", _jsonb(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["provider_id"], ["sc_ai_providers.id"], name="fk_sc_ai_tasks_provider", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["provider_id", "model_id"],
            ["sc_ai_model_configs.provider_id", "sc_ai_model_configs.id"],
            name="fk_sc_ai_task_model_provider",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_ai_task_configurations"),
        sa.UniqueConstraint("task_name", name="uq_sc_ai_task_configurations_task_name"),
    )
    op.create_table(
        "sc_ai_executions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("task_name", sa.String(80), nullable=False),
        sa.Column("prompt_template_version", sa.String(80), nullable=True),
        sa.Column("output_schema_version", sa.String(80), nullable=True),
        sa.Column("processing_status", sa.String(40), nullable=False),
        sa.Column("execution_duration_ms", sa.Integer(), nullable=False),
        sa.Column("token_usage", _jsonb(), nullable=False),
        sa.Column("validation_outcome", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["provider_id"], ["sc_ai_providers.id"], name="fk_sc_ai_executions_provider", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["provider_id", "model_id"],
            ["sc_ai_model_configs.provider_id", "sc_ai_model_configs.id"],
            name="fk_sc_ai_execution_model_provider",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_ai_executions"),
    )
    op.create_table(
        "sc_ai_extractions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("provider_id", sa.Uuid(), nullable=False),
        sa.Column("model_id", sa.Uuid(), nullable=False),
        sa.Column("execution_id", sa.Uuid(), nullable=False),
        sa.Column("task_name", sa.String(80), nullable=False),
        sa.Column("source_reference", _jsonb(), nullable=False),
        sa.Column("result", _jsonb(), nullable=False),
        sa.Column("processing_status", sa.String(40), nullable=False),
        sa.Column("execution_duration_ms", sa.Integer(), nullable=False),
        sa.Column("token_usage", _jsonb(), nullable=False),
        sa.Column("validation_outcome", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["revision_id"], ["sc_design_revisions.id"], name="fk_sc_ai_extractions_revision", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"], ["sc_ai_providers.id"], name="fk_sc_ai_extractions_provider", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["provider_id", "model_id"],
            ["sc_ai_model_configs.provider_id", "sc_ai_model_configs.id"],
            name="fk_sc_ai_extraction_model_provider",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["execution_id"],
            ["sc_ai_executions.id"],
            name="fk_sc_ai_extractions_execution",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_ai_extractions"),
    )
    op.create_index("ix_sc_ai_extractions_revision_id", "sc_ai_extractions", ["revision_id"])


def downgrade() -> None:
    op.drop_index("ix_sc_ai_extractions_revision_id", table_name="sc_ai_extractions")
    op.drop_table("sc_ai_extractions")
    op.drop_table("sc_ai_executions")
    op.drop_table("sc_ai_task_configurations")
    op.drop_index("ix_sc_ai_model_configs_provider_id", table_name="sc_ai_model_configs")
    op.drop_table("sc_ai_model_configs")
    op.drop_table("sc_ai_providers")
