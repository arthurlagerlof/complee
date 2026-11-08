"""Store immutable ShipCheck JSON datasets in the application database.

Revision ID: 20261108_0004
Revises: 20261107_0003
Create Date: 2026-11-08
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20261108_0004"
down_revision = "20261107_0003"
branch_labels = None
depends_on = None


def _jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "sc_shipcheck_dataset_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("source_key", sa.String(80), nullable=False),
        sa.Column("source_path", sa.String(300), nullable=False),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("collection_key", sa.String(80), nullable=True),
        sa.Column("document_metadata", _jsonb(), nullable=True),
        sa.Column("record_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_shipcheck_dataset_versions"),
        sa.UniqueConstraint("source_key", "content_sha256", name="uq_sc_shipcheck_version_source_hash"),
    )
    op.create_index(
        "ix_sc_shipcheck_dataset_versions_source_key",
        "sc_shipcheck_dataset_versions",
        ["source_key"],
    )
    op.create_table(
        "sc_shipcheck_dataset_records",
        sa.Column("dataset_version_id", sa.Uuid(), nullable=False),
        sa.Column("record_key", sa.String(200), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("payload", _jsonb(), nullable=False),
        sa.ForeignKeyConstraint(
            ["dataset_version_id"],
            ["sc_shipcheck_dataset_versions.id"],
            name="fk_sc_shipcheck_record_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("dataset_version_id", "record_key", name="pk_sc_shipcheck_dataset_records"),
        sa.UniqueConstraint(
            "dataset_version_id",
            "ordinal",
            name="uq_sc_shipcheck_record_version_ordinal",
        ),
    )
    op.create_table(
        "sc_shipcheck_active_datasets",
        sa.Column("source_key", sa.String(80), nullable=False),
        sa.Column("dataset_version_id", sa.Uuid(), nullable=False),
        sa.Column("activated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["dataset_version_id"],
            ["sc_shipcheck_dataset_versions.id"],
            name="fk_sc_shipcheck_active_version",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("source_key", name="pk_sc_shipcheck_active_datasets"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    for table in (
        "sc_shipcheck_active_datasets",
        "sc_shipcheck_dataset_records",
        "sc_shipcheck_dataset_versions",
    ):
        has_rows = bind.execute(sa.text(f"SELECT EXISTS (SELECT 1 FROM {table})")).scalar_one()
        if has_rows:
            raise RuntimeError(
                "ShipCheck catalog history is populated; downgrade is blocked to preserve imported records."
            )
    op.drop_table("sc_shipcheck_active_datasets")
    op.drop_table("sc_shipcheck_dataset_records")
    op.drop_index(
        "ix_sc_shipcheck_dataset_versions_source_key",
        table_name="sc_shipcheck_dataset_versions",
    )
    op.drop_table("sc_shipcheck_dataset_versions")
