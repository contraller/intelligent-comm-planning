"""建立规划任务输入、版本和保存回执表。

Revision ID: 0002_task_input_persistence
Revises: 0001_baseline
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0002_task_input_persistence"
down_revision: Union[str, Sequence[str], None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "planning_tasks",
        sa.Column("task_id", sa.String(120), primary_key=True),
        sa.Column("current_revision_id", sa.String(40), nullable=False),
        sa.Column("current_version_no", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "planning_task_revisions",
        sa.Column("revision_id", sa.String(40), primary_key=True),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("condition_version", sa.String(40), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("context", sa.String(16), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("task_id", "version_no", name="uq_task_revision_number"),
    )
    op.create_index("ix_planning_task_revisions_task_id", "planning_task_revisions", ["task_id"])
    op.create_table(
        "planning_operation_receipts",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("operation", sa.String(16), nullable=False),
        sa.Column("task_id", sa.String(120), nullable=False),
        sa.Column("revision_id", sa.String(40), sa.ForeignKey("planning_task_revisions.revision_id"), nullable=False),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("message", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("planning_operation_receipts")
    op.drop_index("ix_planning_task_revisions_task_id", table_name="planning_task_revisions")
    op.drop_table("planning_task_revisions")
    op.drop_table("planning_tasks")
