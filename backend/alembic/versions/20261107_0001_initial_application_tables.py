"""Create Ship Compliance application tables without modifying existing data.

Revision ID: 20261107_0001
Revises:
Create Date: 2026-11-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20261107_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "sc_projects",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_projects"),
    )
    op.create_table(
        "sc_vessels",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("vessel_type", sa.String(length=100), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["sc_projects.id"], name="fk_sc_vessels_project_id_sc_projects", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_sc_vessels"),
    )
    op.create_index("ix_sc_vessels_project_id", "sc_vessels", ["project_id"])
    op.create_table(
        "sc_design_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("vessel_id", sa.Uuid(), nullable=False),
        sa.Column("revision_name", sa.String(length=200), nullable=False),
        sa.Column("revision_number", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.String(length=50), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["vessel_id"], ["sc_vessels.id"], name="fk_sc_design_revisions_vessel_id_sc_vessels", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_sc_design_revisions"),
        sa.UniqueConstraint("vessel_id", "revision_number", name="uq_sc_revision_vessel_number"),
    )
    op.create_index("ix_sc_design_revisions_vessel_id", "sc_design_revisions", ["vessel_id"])
    op.create_table(
        "sc_design_components",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("component_type", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("properties", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("geometry_reference", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("source_reference", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("review_status", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["revision_id"], ["sc_design_revisions.id"], name="fk_sc_design_components_revision_id_sc_design_revisions", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_sc_design_components"),
    )
    op.create_index("ix_sc_design_components_revision_id", "sc_design_components", ["revision_id"])
    op.create_table(
        "sc_component_relationships",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("source_component_id", sa.Uuid(), nullable=False),
        sa.Column("target_component_id", sa.Uuid(), nullable=False),
        sa.Column("relationship_type", sa.String(length=100), nullable=False),
        sa.Column("properties", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.ForeignKeyConstraint(["revision_id"], ["sc_design_revisions.id"], name="fk_sc_component_relationships_revision_id_sc_design_revisions", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_component_id"], ["sc_design_components.id"], name="fk_sc_component_relationships_source_component_id_sc_design_components", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["target_component_id"], ["sc_design_components.id"], name="fk_sc_component_relationships_target_component_id_sc_design_components", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_sc_component_relationships"),
        sa.UniqueConstraint("revision_id", "source_component_id", "target_component_id", "relationship_type", name="uq_sc_component_relationship"),
    )
    op.create_index("ix_sc_component_relationships_revision_id", "sc_component_relationships", ["revision_id"])
    op.create_table(
        "sc_assessments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["revision_id"], ["sc_design_revisions.id"], name="fk_sc_assessments_revision_id_sc_design_revisions", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_sc_assessments"),
    )
    op.create_index("ix_sc_assessments_revision_id", "sc_assessments", ["revision_id"])
    op.create_table(
        "sc_findings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("assessment_id", sa.Uuid(), nullable=False),
        sa.Column("requirement_id", sa.Uuid(), nullable=False),
        sa.Column("component_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("finding_type", sa.String(length=40), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("evidence", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("calculation_results", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("assumptions", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("suggested_action", sa.String(), nullable=True),
        sa.Column("reviewed_by", sa.String(length=200), nullable=True),
        sa.Column("review_notes", sa.String(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["assessment_id"], ["sc_assessments.id"], name="fk_sc_findings_assessment_id_sc_assessments", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_id"], ["public.provisions.id"], name="fk_sc_findings_requirement_id_provisions", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name="pk_sc_findings"),
    )
    op.create_index("ix_sc_findings_assessment_id", "sc_findings", ["assessment_id"])
    op.create_index("ix_sc_findings_requirement_id", "sc_findings", ["requirement_id"])


def downgrade() -> None:
    op.drop_table("sc_findings")
    op.drop_table("sc_assessments")
    op.drop_table("sc_component_relationships")
    op.drop_table("sc_design_components")
    op.drop_table("sc_design_revisions")
    op.drop_table("sc_vessels")
    op.drop_table("sc_projects")
