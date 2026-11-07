"""Store uploaded source files and extracted engineering candidates.

Revision ID: 20261107_0003
Revises: 20261107_0002
Create Date: 2026-11-07
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20261107_0003"
down_revision = "20261107_0002"
branch_labels = None
depends_on = None


def _jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    with op.batch_alter_table("sc_ai_providers") as batch:
        batch.drop_constraint("ck_sc_ai_providers_provider_type_supported", type_="check")
        batch.create_check_constraint(
            "provider_type_supported",
            "provider_type IN ('ollama', 'openai_compatible', 'openai', 'anthropic', 'gemini')",
        )

    op.create_table(
        "sc_source_documents",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("filename", sa.String(500), nullable=False),
        sa.Column("media_type", sa.String(200), nullable=True),
        sa.Column("file_extension", sa.String(20), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("source_data", sa.LargeBinary(), nullable=False),
        sa.Column("source_reference", _jsonb(), nullable=False),
        sa.Column("parsed_data", _jsonb(), nullable=True),
        sa.Column("extraction_method", sa.String(80), nullable=True),
        sa.Column("provider_id", sa.Uuid(), nullable=True),
        sa.Column("model_id", sa.Uuid(), nullable=True),
        sa.Column("extraction_id", sa.Uuid(), nullable=True),
        sa.Column("processing_status", sa.String(40), nullable=False),
        sa.Column("error_message", sa.String(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["sc_design_revisions.id"],
            name="fk_sc_source_documents_revision",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["provider_id"], ["sc_ai_providers.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["model_id"], ["sc_ai_model_configs.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["extraction_id"], ["sc_ai_extractions.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_source_documents"),
    )
    op.create_index(
        "ix_sc_source_documents_revision_id", "sc_source_documents", ["revision_id"]
    )
    with op.batch_alter_table("sc_ai_extractions") as batch:
        batch.add_column(sa.Column("source_document_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_sc_ai_extractions_source_document",
            "sc_source_documents",
            ["source_document_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("sc_ai_extractions") as batch:
        batch.drop_constraint("fk_sc_ai_extractions_source_document", type_="foreignkey")
        batch.drop_column("source_document_id")
    op.drop_index("ix_sc_source_documents_revision_id", table_name="sc_source_documents")
    op.drop_table("sc_source_documents")
    with op.batch_alter_table("sc_ai_providers") as batch:
        batch.drop_constraint("ck_sc_ai_providers_provider_type_supported", type_="check")
        batch.create_check_constraint(
            "provider_type_supported",
            "provider_type IN ('ollama', 'openai_compatible', 'openai', 'anthropic')",
        )
