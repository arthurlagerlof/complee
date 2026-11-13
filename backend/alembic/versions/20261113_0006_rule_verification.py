"""Rule verification: official sources, immutable rule versions, quoted evidence, verifications, audit log.

Rows in these tables are never changed or deleted: triggers reject UPDATE and DELETE, so a verified rule version and
the evidence it was verified on stay exactly as they were.

Revision ID: 20261113_0006
Revises: 20261108_0005
Create Date: 2026-11-13
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20261113_0006"
down_revision = "20261108_0005"
branch_labels = None
depends_on = None

IMMUTABLE = ["sc_reg_sources", "sc_reg_rules", "sc_reg_rule_versions", "sc_reg_evidence", "sc_reg_verifications", "sc_reg_audit"]


def _jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "sc_reg_sources",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("instrument", sa.String(200), nullable=False),
        sa.Column("edition", sa.String(120), nullable=False),
        sa.Column("published", sa.String(20), nullable=True),
        sa.Column("effective", sa.String(20), nullable=True),
        sa.Column("publisher", sa.String(200), nullable=True),
        sa.Column("licence", sa.String(40), nullable=False),
        sa.Column("filename", sa.String(300), nullable=False),
        sa.Column("file_sha256", sa.String(64), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("text_sha256", sa.String(64), nullable=False),
        sa.Column("page_index", _jsonb(), nullable=False),
        sa.Column("acquired_by", sa.String(120), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_reg_sources"),
        sa.UniqueConstraint("file_sha256", name="uq_sc_reg_sources_file_sha256"),
        sa.CheckConstraint("licence IN ('public', 'licensed_internal', 'paraphrase_only')", name="ck_sc_reg_sources_licence"),
    )
    op.create_table(
        "sc_reg_rules",
        sa.Column("rule_id", sa.String(120), nullable=False),
        sa.Column("instrument", sa.String(300), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("rule_id", name="pk_sc_reg_rules"),
    )
    op.create_table(
        "sc_reg_rule_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("rule_id", sa.String(120), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("logic", _jsonb(), nullable=False),
        sa.Column("logic_sha256", sa.String(64), nullable=False),
        sa.Column("origin", sa.String(40), nullable=False),
        sa.Column("author", sa.String(120), nullable=False),
        sa.Column("change_reason", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_reg_rule_versions"),
        sa.ForeignKeyConstraint(["rule_id"], ["sc_reg_rules.rule_id"], name="fk_sc_reg_rule_versions_rule_id_sc_reg_rules", ondelete="RESTRICT"),
        sa.UniqueConstraint("rule_id", "version", name="uq_sc_reg_rule_versions_rule_version"),
        sa.CheckConstraint("version >= 1", name="ck_sc_reg_rule_versions_version"),
    )
    op.create_index("ix_sc_reg_rule_versions_rule_id", "sc_reg_rule_versions", ["rule_id"])
    op.create_table(
        "sc_reg_evidence",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("rule_version_id", sa.Uuid(), nullable=False),
        sa.Column("field", sa.String(80), nullable=False),
        sa.Column("source_id", sa.Uuid(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=False),
        sa.Column("start", sa.Integer(), nullable=False),
        sa.Column("end", sa.Integer(), nullable=False),
        sa.Column("page", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_reg_evidence"),
        sa.ForeignKeyConstraint(["rule_version_id"], ["sc_reg_rule_versions.id"], name="fk_sc_reg_evidence_rule_version_id_sc_reg_rule_versions", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["source_id"], ["sc_reg_sources.id"], name="fk_sc_reg_evidence_source_id_sc_reg_sources", ondelete="RESTRICT"),
        sa.CheckConstraint("start >= 0 AND \"end\" > start", name="ck_sc_reg_evidence_span"),
    )
    op.create_index("ix_sc_reg_evidence_rule_version_id", "sc_reg_evidence", ["rule_version_id"])
    op.create_table(
        "sc_reg_verifications",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("rule_version_id", sa.Uuid(), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("reviewer", sa.String(120), nullable=False),
        sa.Column("decision", sa.String(20), nullable=False),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("checklist", _jsonb(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_reg_verifications"),
        sa.ForeignKeyConstraint(["rule_version_id"], ["sc_reg_rule_versions.id"], name="fk_sc_reg_verifications_rule_version_id_sc_reg_rule_versions", ondelete="RESTRICT"),
        sa.CheckConstraint("level IN (1, 2)", name="ck_sc_reg_verifications_level"),
        sa.CheckConstraint("decision IN ('approved', 'rejected')", name="ck_sc_reg_verifications_decision"),
    )
    op.create_index("ix_sc_reg_verifications_rule_version_id", "sc_reg_verifications", ["rule_version_id"])
    op.create_table(
        "sc_reg_audit",
        sa.Column("id", sa.BigInteger(), sa.Identity(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor", sa.String(120), nullable=False),
        sa.Column("action", sa.String(60), nullable=False),
        sa.Column("entity", sa.String(60), nullable=False),
        sa.Column("entity_key", sa.String(200), nullable=False),
        sa.Column("detail", _jsonb(), nullable=True),
        sa.Column("ok", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.PrimaryKeyConstraint("id", name="pk_sc_reg_audit"),
    )

    # Written once, never changed: a verified rule version and the evidence it was verified on stay as they were.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION sc_reg_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'rows in % are immutable: write a new version or record instead', TG_TABLE_NAME;
        END;
        $$;
        """
    )
    for table in IMMUTABLE:
        op.execute(
            f"CREATE TRIGGER trg_{table}_immutable BEFORE UPDATE OR DELETE ON {table} "
            f"FOR EACH ROW EXECUTE FUNCTION sc_reg_reject_change()"
        )


def downgrade() -> None:
    for table in IMMUTABLE:
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_immutable ON {table}")
    op.execute("DROP FUNCTION IF EXISTS sc_reg_reject_change()")
    for table in reversed(IMMUTABLE):
        op.drop_table(table)
