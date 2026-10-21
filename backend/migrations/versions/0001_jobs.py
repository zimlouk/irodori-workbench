"""Persistent P0 test-generation jobs."""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("jobs",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("mode", sa.String(20), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("audio_file", sa.String(80), nullable=True))
    op.create_index("ix_jobs_status", "jobs", ["status"])


def downgrade():
    op.drop_index("ix_jobs_status", table_name="jobs")
    op.drop_table("jobs")

