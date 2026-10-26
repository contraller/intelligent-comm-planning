"""为父方案调整保留完整算法拓扑快照。

Revision ID: 0007_planning_plan_raw_snapshot
Revises: 0006_planning_job_cancellations
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0007_planning_plan_raw_snapshot"
down_revision: Union[str, Sequence[str], None] = "0006_planning_job_cancellations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("planning_plans", sa.Column("raw_snapshot", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("planning_plans", "raw_snapshot")
