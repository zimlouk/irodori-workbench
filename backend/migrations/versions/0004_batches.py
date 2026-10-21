"""Automatic batch drafts, priority scheduling and version retention."""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = depends_on = None


def upgrade():
    op.create_table("batches", sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("origin", sa.Text(), nullable=False),
        sa.Column("document", sa.JSON(), nullable=False), sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False))
    op.create_table("preferences", sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False), sa.Column("document", sa.JSON(), nullable=False))
    op.execute("ALTER TABLE jobs ADD COLUMN workbench_batch_id VARCHAR(36) REFERENCES batches(id)")
    op.add_column("jobs", sa.Column("priority", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("jobs", sa.Column("expires_at", sa.String(40), nullable=True))
    op.add_column("jobs", sa.Column("purged", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_jobs_workbench_batch_id", "jobs", ["workbench_batch_id"])


def downgrade():
    op.drop_index("ix_jobs_workbench_batch_id", "jobs")
    for name in ("purged", "expires_at", "priority", "workbench_batch_id"):
        op.drop_column("jobs", name)
    op.drop_table("preferences")
    op.drop_table("batches")
