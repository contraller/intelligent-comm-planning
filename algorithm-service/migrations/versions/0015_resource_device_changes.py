"""单设备参数保存的幂等与审计回执，不修改已有资源和业务数据。"""
from alembic import op
import sqlalchemy as sa

revision = "0015_resource_device_changes"
down_revision = "0014_resource_datasets"
branch_labels = depends_on = None


def upgrade():
    op.create_table("resource_dataset_operations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("base_revision", sa.String(120), sa.ForeignKey("resource_dataset_versions.revision"), nullable=False),
        sa.Column("revision", sa.String(120), sa.ForeignKey("resource_dataset_versions.revision"), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))


def downgrade():
    raise RuntimeError("资源操作回执不可破坏性删除，请保留历史")
