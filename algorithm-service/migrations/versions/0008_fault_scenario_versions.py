"""正式故障场景及不可变版本。

Revision ID: 0008_fault_scenario_versions
Revises: 0007_planning_plan_raw_snapshot
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0008_fault_scenario_versions"
down_revision: Union[str, Sequence[str], None] = "0007_planning_plan_raw_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "fault_scenarios",
        sa.Column("scenario_id", sa.String(40), primary_key=True),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("archived", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_fault_scenarios_task_id", "fault_scenarios", ["task_id"])
    op.create_table(
        "fault_scenario_versions",
        sa.Column("version_id", sa.String(40), primary_key=True),
        sa.Column("scenario_id", sa.String(40), sa.ForeignKey("fault_scenarios.scenario_id"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id"), nullable=False),
        sa.Column("plan_revision", sa.String(40), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("scenario_id", "version_no", name="uq_fault_scenario_version"),
    )
    op.create_index("ix_fault_scenario_versions_scenario_id", "fault_scenario_versions", ["scenario_id"])


def downgrade() -> None:
    op.drop_index("ix_fault_scenario_versions_scenario_id", table_name="fault_scenario_versions")
    op.drop_table("fault_scenario_versions")
    op.drop_index("ix_fault_scenarios_task_id", table_name="fault_scenarios")
    op.drop_table("fault_scenarios")
