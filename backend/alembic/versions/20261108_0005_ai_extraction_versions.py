"""Add prompt and output-schema versions to stored AI extractions.

Revision ID: 20261108_0005
Revises: 20261108_0004
Create Date: 2026-11-08
"""

from alembic import op
import sqlalchemy as sa


revision = "20261108_0005"
down_revision = "20261108_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sc_ai_extractions",
        sa.Column(
            "prompt_template_version",
            sa.String(80),
            nullable=False,
            server_default="legacy-unknown",
        ),
    )
    op.add_column(
        "sc_ai_extractions",
        sa.Column(
            "output_schema_version",
            sa.String(80),
            nullable=False,
            server_default="legacy-unknown",
        ),
    )
    op.alter_column("sc_ai_extractions", "prompt_template_version", server_default=None)
    op.alter_column("sc_ai_extractions", "output_schema_version", server_default=None)


def downgrade() -> None:
    bind = op.get_bind()
    has_rows = bind.execute(sa.text("SELECT EXISTS (SELECT 1 FROM sc_ai_extractions)")).scalar_one()
    if has_rows:
        raise RuntimeError(
            "AI extraction records contain version metadata; downgrade is blocked to preserve that data."
        )
    op.drop_column("sc_ai_extractions", "output_schema_version")
    op.drop_column("sc_ai_extractions", "prompt_template_version")
