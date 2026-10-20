"""正式故障分析任务的幂等回执。

Revision ID: 0009_fault_task_submissions
Revises: 0008_fault_scenario_versions
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0009_fault_task_submissions"
down_revision: Union[str, Sequence[str], None] = "0008_fault_scenario_versions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "fault_task_submissions",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("algorithm_task_id", sa.String(40), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id"), nullable=False),
        sa.Column("scenario_id", sa.String(40), sa.ForeignKey("fault_scenarios.scenario_id"), nullable=False),
        sa.Column("scenario_version_id", sa.String(40), sa.ForeignKey("fault_scenario_versions.version_id"), nullable=False),
        sa.Column("diagnose_task_id", sa.String(40), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("algorithm_task_id", name="uq_fault_task_submission_task"),
    )
    op.create_index("ix_fault_task_submissions_task_id", "fault_task_submissions", ["task_id"])


def downgrade() -> None:
    op.drop_index("ix_fault_task_submissions_task_id", table_name="fault_task_submissions")
    op.drop_table("fault_task_submissions")
