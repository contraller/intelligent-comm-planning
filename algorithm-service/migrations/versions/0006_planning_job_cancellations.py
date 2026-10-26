"""记录版本化规划作业的取消请求。

Revision ID: 0006_planning_job_cancellations
Revises: 0005_planning_plan_confirmation
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0006_planning_job_cancellations"
down_revision: Union[str, Sequence[str], None] = "0005_planning_plan_confirmation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "planning_job_cancellations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("job_id", sa.String(40), sa.ForeignKey("planning_jobs.job_id"), nullable=False),
        sa.Column("task_id", sa.String(120), nullable=False),
        sa.Column("revision_id", sa.String(40), nullable=False),
        sa.Column("outcome_status", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_planning_job_cancellations_job_id", "planning_job_cancellations", ["job_id"])


def downgrade() -> None:
    op.drop_index("ix_planning_job_cancellations_job_id", table_name="planning_job_cancellations")
    op.drop_table("planning_job_cancellations")
