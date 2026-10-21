"""Versioned voice presets, project documents and immutable generation associations."""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = depends_on = None


def upgrade():
    op.create_table("presets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("voice_name", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("config", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False))
    op.create_table("projects",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False))
    # SQLite supports ADD COLUMN with a nullable REFERENCES column.
    op.execute("ALTER TABLE jobs ADD COLUMN project_id VARCHAR(36) REFERENCES projects(id)")
    op.add_column("jobs", sa.Column("segment_id", sa.String(36), nullable=True))
    op.add_column("jobs", sa.Column("input_revision", sa.Integer(), nullable=True))
    op.add_column("jobs", sa.Column("batch_id", sa.String(36), nullable=True))
    op.create_index("ix_jobs_project_id", "jobs", ["project_id"])


def downgrade():
    op.drop_index("ix_jobs_project_id", "jobs")
    for name in ("batch_id", "input_revision", "segment_id", "project_id"):
        op.drop_column("jobs", name)
    op.drop_table("projects")
    op.drop_table("presets")
