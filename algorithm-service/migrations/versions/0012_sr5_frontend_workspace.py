"""SR5 新版前端运行和回执。"""
from alembic import op
import sqlalchemy as sa

revision = "0012_sr5_frontend_workspace"
down_revision = "0011_integration_sessions"
branch_labels = depends_on = None


def upgrade():
    op.create_table("fault_frontend_workspaces", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("revision", sa.Integer(), nullable=False))
    op.create_table("fault_frontend_receipts", sa.Column("request_id", sa.String(120), primary_key=True), sa.Column("digest", sa.String(64), nullable=False), sa.Column("response", sa.JSON(), nullable=False))
    op.create_table("fault_frontend_runs",
        sa.Column("id", sa.String(40), primary_key=True),
        sa.Column("scenario_version_id", sa.String(40), nullable=False),
        sa.Column("task_id", sa.String(120), nullable=False), sa.Column("plan_id", sa.String(40), nullable=False),
        sa.Column("diagnose_task_id", sa.String(40)), sa.Column("impact_task_id", sa.String(40)),
        sa.Column("started_at", sa.Float(), nullable=False), sa.Column("cancelled_at", sa.Float()),
        sa.Column("snapshot", sa.JSON(), nullable=False), sa.Column("diagnosis", sa.JSON()), sa.Column("impact", sa.JSON()))


def downgrade():
    raise RuntimeError("历史诊断不可通过回退迁移清空")
