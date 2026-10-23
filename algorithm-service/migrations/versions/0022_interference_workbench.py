"""持久化干扰分析、措施采纳作业和不可变受理回执。"""
from alembic import op
import sqlalchemy as sa

revision = "0022_interference_workbench"
down_revision = "0021_observation_status_refs"
branch_labels = depends_on = None


def upgrade():
    op.create_table("interference_workbench_runs",
        sa.Column("run_id", sa.String(40), primary_key=True),
        sa.Column("request_id", sa.String(120), unique=True, nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id"), nullable=False),
        sa.Column("scene_version_id", sa.String(40), sa.ForeignKey("interference_frontend_scene_versions.version_id"), nullable=False),
        sa.Column("resource_revision", sa.String(120), sa.ForeignKey("resource_dataset_versions.revision"), nullable=False),
        sa.Column("active_task_key", sa.String(120), unique=True),
        sa.Column("run_version", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(200), nullable=False),
        sa.Column("source_snapshot", sa.JSON(), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("result_snapshot", sa.JSON()),
        sa.Column("result_hash", sa.String(64)),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("error", sa.String(2000)),
        sa.Column("lease_owner", sa.String(40)),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("run_version >= 1", name="ck_iwb_run_version"),
        sa.CheckConstraint("progress >= 0 AND progress <= 100", name="ck_iwb_run_progress"),
        sa.CheckConstraint("state IN ('PENDING','RUNNING','CANCEL_REQUESTED','SUCCESS','FAILED','CANCELLED')", name="ck_iwb_run_state"),
        sa.CheckConstraint("(state IN ('PENDING','RUNNING','CANCEL_REQUESTED') AND active_task_key IS NOT NULL AND active_task_key = task_id) OR (state IN ('SUCCESS','FAILED','CANCELLED') AND active_task_key IS NULL)", name="ck_iwb_run_active_key"))
    op.create_index("ix_interference_workbench_runs_task_id", "interference_workbench_runs", ["task_id"])
    op.create_index("ix_interference_workbench_runs_state", "interference_workbench_runs", ["state"])
    op.create_table("interference_workbench_adoptions",
        sa.Column("adoption_id", sa.String(40), primary_key=True),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("run_id", sa.String(40), sa.ForeignKey("interference_workbench_runs.run_id"), nullable=False),
        sa.Column("measure_id", sa.String(40), nullable=False),
        sa.Column("adoption_version", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(24), nullable=False),
        sa.Column("source_hash", sa.String(64), nullable=False),
        sa.Column("change_set", sa.JSON(), nullable=False),
        sa.Column("change_hash", sa.String(64), nullable=False),
        sa.Column("planning_request_id", sa.String(120), unique=True, nullable=False),
        sa.Column("planning_job_id", sa.String(40), sa.ForeignKey("planning_jobs.job_id")),
        sa.Column("result_plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id")),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("error", sa.String(2000)),
        sa.Column("lease_owner", sa.String(40)),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("run_id", "measure_id", name="uq_iwb_adoption_measure"),
        sa.CheckConstraint("adoption_version >= 1", name="ck_iwb_adoption_version"),
        sa.CheckConstraint("state IN ('PENDING','RUNNING','CANCEL_REQUESTED','SUCCESS','FAILED','CANCELLED')", name="ck_iwb_adoption_state"))
    op.create_index("ix_interference_workbench_adoptions_task_id", "interference_workbench_adoptions", ["task_id"])
    op.create_index("ix_interference_workbench_adoptions_run_id", "interference_workbench_adoptions", ["run_id"])
    op.create_table("interference_workbench_operations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("object_type", sa.String(16), nullable=False),
        sa.Column("object_id", sa.String(40), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("receipt_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("operation IN ('SUBMIT_ANALYSIS','CANCEL_ANALYSIS','ADOPT_MEASURE','CANCEL_ADOPTION')", name="ck_iwb_operation"))
    op.create_index("ix_interference_workbench_operations_task_id", "interference_workbench_operations", ["task_id"])
    # 作业状态允许检查点更新，受理事实只能追加。
    if op.get_bind().dialect.name == "sqlite":
        for action in ("UPDATE", "DELETE"):
            op.execute(sa.text(f"CREATE TRIGGER interference_workbench_operations_immutable_{action.lower()} BEFORE {action} ON interference_workbench_operations "
                "BEGIN SELECT RAISE(ABORT, 'interference workbench receipts are immutable'); END"))


def downgrade():
    raise RuntimeError("干扰作业及回执须保留，不允许破坏性降级")
