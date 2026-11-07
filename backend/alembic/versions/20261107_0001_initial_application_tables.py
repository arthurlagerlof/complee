"""Create only application-owned Ship Compliance tables.

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


def _jsonb() -> postgresql.JSONB:
    return postgresql.JSONB(astext_type=sa.Text())


def upgrade() -> None:
    op.create_table(
        "sc_projects",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_sc_projects"),
    )
    op.create_table(
        "sc_vessels",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("vessel_type", sa.String(100), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(
            ["project_id"], ["sc_projects.id"], name="fk_sc_vessels_project_id_sc_projects", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_vessels"),
    )
    op.create_index("ix_sc_vessels_project_id", "sc_vessels", ["project_id"])
    op.create_table(
        "sc_design_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("vessel_id", sa.Uuid(), nullable=False),
        sa.Column("revision_name", sa.String(200), nullable=False),
        sa.Column("revision_number", sa.Integer(), nullable=False),
        sa.Column("schema_version", sa.String(50), nullable=False),
        sa.Column("status", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["vessel_id"], ["sc_vessels.id"], name="fk_sc_design_revisions_vessel_id_sc_vessels", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_design_revisions"),
        sa.UniqueConstraint("vessel_id", "revision_number", name="uq_sc_revision_vessel_number"),
    )
    op.create_index("ix_sc_design_revisions_vessel_id", "sc_design_revisions", ["vessel_id"])
    op.create_table(
        "sc_design_components",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("component_type", sa.String(100), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("properties", _jsonb(), nullable=False),
        sa.Column("geometry_reference", _jsonb(), nullable=True),
        sa.Column("source_reference", _jsonb(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("review_status", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["sc_design_revisions.id"],
            name="fk_sc_design_components_revision_id_sc_design_revisions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_design_components"),
        sa.UniqueConstraint("revision_id", "id", name="uq_sc_component_revision_id"),
    )
    op.create_index("ix_sc_design_components_revision_id", "sc_design_components", ["revision_id"])
    op.create_table(
        "sc_component_relationships",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("source_component_id", sa.Uuid(), nullable=False),
        sa.Column("target_component_id", sa.Uuid(), nullable=False),
        sa.Column("relationship_type", sa.String(100), nullable=False),
        sa.Column("properties", _jsonb(), nullable=False),
        sa.CheckConstraint("source_component_id <> target_component_id", name="relationship_components_differ"),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["sc_design_revisions.id"],
            name="fk_sc_component_relationships_revision_id_sc_design_revisions",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["revision_id", "source_component_id"],
            ["sc_design_components.revision_id", "sc_design_components.id"],
            name="fk_sc_relationship_source_same_revision",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["revision_id", "target_component_id"],
            ["sc_design_components.revision_id", "sc_design_components.id"],
            name="fk_sc_relationship_target_same_revision",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_component_relationships"),
        sa.UniqueConstraint(
            "revision_id", "source_component_id", "target_component_id", "relationship_type",
            name="uq_sc_component_relationship",
        ),
    )
    op.create_index("ix_sc_component_relationships_revision_id", "sc_component_relationships", ["revision_id"])
    op.create_table(
        "sc_design_facts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("component_id", sa.Uuid(), nullable=True),
        sa.Column("fact_type", sa.String(100), nullable=False),
        sa.Column("statement", sa.String(), nullable=False),
        sa.Column("value", _jsonb(), nullable=True),
        sa.Column("source_reference", _jsonb(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("review_status", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["sc_design_revisions.id"],
            name="fk_sc_design_facts_revision_id_sc_design_revisions",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["revision_id", "component_id"],
            ["sc_design_components.revision_id", "sc_design_components.id"],
            name="fk_sc_design_fact_component_same_revision",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_design_facts"),
    )
    op.create_index("ix_sc_design_facts_revision_id", "sc_design_facts", ["revision_id"])
    op.create_index("ix_sc_design_facts_component_id", "sc_design_facts", ["component_id"])
    op.create_table(
        "sc_assessments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(40), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["revision_id"],
            ["sc_design_revisions.id"],
            name="fk_sc_assessments_revision_id_sc_design_revisions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_assessments"),
        sa.UniqueConstraint("id", "revision_id", name="uq_sc_assessment_revision"),
    )
    op.create_index("ix_sc_assessments_revision_id", "sc_assessments", ["revision_id"])
    op.create_table(
        "sc_findings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("assessment_id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.Column("requirement_id", sa.Uuid(), nullable=False),
        sa.Column("retrieval_finding_id", sa.Uuid(), nullable=True),
        sa.Column("requirement_snapshot", _jsonb(), nullable=False),
        sa.Column("verification_method", sa.String(100), nullable=False),
        sa.Column("finding_type", sa.String(40), nullable=False),
        sa.Column("status", sa.String(40), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column("evidence", _jsonb(), nullable=False),
        sa.Column("calculation_results", _jsonb(), nullable=False),
        sa.Column("assumptions", _jsonb(), nullable=False),
        sa.Column("suggested_action", sa.String(), nullable=True),
        sa.Column("reviewed_by", sa.String(200), nullable=True),
        sa.Column("review_notes", sa.String(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(
            ["assessment_id", "revision_id"],
            ["sc_assessments.id", "sc_assessments.revision_id"],
            name="fk_sc_finding_assessment_revision",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_sc_findings"),
        sa.UniqueConstraint("id", "revision_id", name="uq_sc_finding_revision"),
    )
    op.create_index("ix_sc_findings_assessment_id", "sc_findings", ["assessment_id"])
    op.create_index("ix_sc_findings_revision_id", "sc_findings", ["revision_id"])
    op.create_index("ix_sc_findings_requirement_id", "sc_findings", ["requirement_id"])
    op.create_table(
        "sc_finding_components",
        sa.Column("finding_id", sa.Uuid(), nullable=False),
        sa.Column("component_id", sa.Uuid(), nullable=False),
        sa.Column("revision_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["finding_id", "revision_id"],
            ["sc_findings.id", "sc_findings.revision_id"],
            name="fk_sc_finding_component_finding_revision",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["revision_id", "component_id"],
            ["sc_design_components.revision_id", "sc_design_components.id"],
            name="fk_sc_finding_component_design_revision",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("finding_id", "component_id", name="pk_sc_finding_components"),
    )
    op.create_index("ix_sc_finding_components_revision_id", "sc_finding_components", ["revision_id"])


def downgrade() -> None:
    op.drop_index("ix_sc_finding_components_revision_id", table_name="sc_finding_components")
    op.drop_table("sc_finding_components")
    op.drop_index("ix_sc_findings_requirement_id", table_name="sc_findings")
    op.drop_index("ix_sc_findings_revision_id", table_name="sc_findings")
    op.drop_index("ix_sc_findings_assessment_id", table_name="sc_findings")
    op.drop_table("sc_findings")
    op.drop_index("ix_sc_assessments_revision_id", table_name="sc_assessments")
    op.drop_table("sc_assessments")
    op.drop_index("ix_sc_design_facts_component_id", table_name="sc_design_facts")
    op.drop_index("ix_sc_design_facts_revision_id", table_name="sc_design_facts")
    op.drop_table("sc_design_facts")
    op.drop_index("ix_sc_component_relationships_revision_id", table_name="sc_component_relationships")
    op.drop_table("sc_component_relationships")
    op.drop_index("ix_sc_design_components_revision_id", table_name="sc_design_components")
    op.drop_table("sc_design_components")
    op.drop_index("ix_sc_design_revisions_vessel_id", table_name="sc_design_revisions")
    op.drop_table("sc_design_revisions")
    op.drop_index("ix_sc_vessels_project_id", table_name="sc_vessels")
    op.drop_table("sc_vessels")
    op.drop_table("sc_projects")
