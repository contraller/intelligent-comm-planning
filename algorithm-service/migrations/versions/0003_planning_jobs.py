"""建立版本化规划作业表。

Revision ID: 0003_planning_jobs
Revises: 0002_task_input_persistence
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_planning_jobs"
down_revision: Union[str, Sequence[str], None] = "0002_task_input_persistence"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "planning_jobs",
        sa.Column("job_id", sa.String(40), primary_key=True),
        sa.Column("request_id", sa.String(120), nullable=False, unique=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("revision_id", sa.String(40), sa.ForeignKey("planning_task_revisions.revision_id"), nullable=False),
        sa.Column("condition_version", sa.String(40), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("context", sa.String(16), nullable=False),
        sa.Column("parent_plan_id", sa.String(40), nullable=True),
        sa.Column("adjustment", sa.JSON(), nullable=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("stage", sa.String(200), nullable=False),
        sa.Column("error", sa.String(1000), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_planning_jobs_task_id", "planning_jobs", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_planning_jobs_task_id", table_name="planning_jobs")
    op.drop_table("planning_jobs")
