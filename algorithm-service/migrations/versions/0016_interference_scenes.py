"""干扰场景的不可变版本和幂等回执，不改规划或资源原件。"""
from alembic import op
import sqlalchemy as sa

revision = "0016_interference_scenes"
down_revision = "0015_resource_device_changes"
branch_labels = depends_on = None


def upgrade():
    op.create_table("interference_frontend_scenes",
        sa.Column("scene_id", sa.String(120), primary_key=True),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("latest_version_id", sa.String(40), nullable=False),
        sa.Column("latest_version_no", sa.Integer(), nullable=False),
        sa.CheckConstraint("latest_version_no >= 1", name="ck_interference_scene_latest"))
    op.create_index("ix_interference_frontend_scenes_task_id", "interference_frontend_scenes", ["task_id"])
    op.create_table("interference_frontend_scene_versions",
        sa.Column("version_id", sa.String(40), primary_key=True),
        sa.Column("scene_id", sa.String(120), sa.ForeignKey("interference_frontend_scenes.scene_id"), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("plan_id", sa.String(40), sa.ForeignKey("planning_plans.plan_id"), nullable=False),
        sa.Column("resource_revision", sa.String(120), sa.ForeignKey("resource_dataset_versions.revision"), nullable=False),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("snapshot_hash", sa.String(64), nullable=False),
        sa.Column("saved_by", sa.String(120), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("scene_id", "version_no", name="uq_interference_scene_version"),
        sa.CheckConstraint("version_no >= 1", name="ck_interference_scene_version"))
    op.create_index("ix_interference_frontend_scene_versions_scene_id", "interference_frontend_scene_versions", ["scene_id"])
    op.create_index("ix_interference_frontend_scene_versions_task_id", "interference_frontend_scene_versions", ["task_id"])
    op.create_table("interference_frontend_scene_receipts",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("task_id", sa.String(120), sa.ForeignKey("planning_tasks.task_id"), nullable=False),
        sa.Column("scene_id", sa.String(120), sa.ForeignKey("interference_frontend_scenes.scene_id"), nullable=False),
        sa.Column("version_id", sa.String(40), sa.ForeignKey("interference_frontend_scene_versions.version_id"), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_interference_frontend_scene_receipts_task_id", "interference_frontend_scene_receipts", ["task_id"])


def downgrade():
    raise RuntimeError("干扰场景及回执不可破坏性删除，请保留历史")
