"""建立当前方案指针和确认记录表。

Revision ID: 0005_planning_plan_confirmation
Revises: 0004_planning_plans
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0005_planning_plan_confirmation"
down_revision: Union[str, Sequence[str], None] = "0004_planning_plans"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "planning_current_plans",
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), primary_key=True),
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("plan_id", name="uq_planning_current_plan_id"),
    )
    op.create_table(
        "planning_plan_confirmations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id"), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("revision_id", sa.String(40), sa.ForeignKey("planning_task_revisions.revision_id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_planning_plan_confirmations_task_id",
        "planning_plan_confirmations",
        ["task_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_planning_plan_confirmations_task_id",
        table_name="planning_plan_confirmations",
    )
    op.drop_table("planning_plan_confirmations")
    op.drop_table("planning_current_plans")
