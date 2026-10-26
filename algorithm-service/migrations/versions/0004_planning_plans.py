"""建立版本化规划方案表。

Revision ID: 0004_planning_plans
Revises: 0003_planning_jobs
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0004_planning_plans"
down_revision: Union[str, Sequence[str], None] = "0003_planning_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "planning_plans",
        sa.Column("plan_id", sa.String(40), primary_key=True),
        sa.Column("request_id", sa.String(120), nullable=False, unique=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("job_id", sa.String(40), sa.ForeignKey("planning_jobs.job_id"), nullable=False, unique=True),
        sa.Column("revision_id", sa.String(40), sa.ForeignKey("planning_task_revisions.revision_id"), nullable=False),
        sa.Column("condition_version", sa.String(40), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("parent_plan_id", sa.String(40), nullable=True),
        sa.Column("adjustment", sa.JSON(), nullable=True),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("note", sa.String(500), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("result_snapshot", sa.JSON(), nullable=False),
        sa.Column("outcome_snapshot", sa.JSON(), nullable=False),
        sa.Column("source", sa.String(40), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("task_id", "version_no", name="uq_planning_plan_version"),
    )
    op.create_index("ix_planning_plans_task_id", "planning_plans", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_planning_plans_task_id", table_name="planning_plans")
    op.drop_table("planning_plans")
