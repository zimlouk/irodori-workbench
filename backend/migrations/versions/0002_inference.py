"""Immutable WAV assets and per-attempt input/result evidence."""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = depends_on = None


def upgrade():
    op.add_column("jobs", sa.Column("request_config", sa.JSON(), nullable=True))
    op.add_column("jobs", sa.Column("result_metadata", sa.JSON(), nullable=True))
    op.create_table("assets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("filename", sa.String(80), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("duration_seconds", sa.Float(), nullable=False),
        sa.Column("sample_rate", sa.Integer(), nullable=False),
        sa.Column("channels", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False))


def downgrade():
    op.drop_table("assets")
    op.drop_column("jobs", "result_metadata")
    op.drop_column("jobs", "request_config")
