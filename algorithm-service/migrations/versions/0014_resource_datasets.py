"""资源不可变快照与当前指针；迁移不自动导入或覆盖业务数据。"""
from alembic import op
import sqlalchemy as sa

revision = "0014_resource_datasets"
down_revision = "0013_sr6_frontend_metadata"
branch_labels = depends_on = None


def upgrade():
    op.create_table("resource_dataset_versions",
        sa.Column("revision", sa.String(120), primary_key=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("source", sa.String(500), nullable=False),
        sa.Column("data_origin", sa.String(40), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_table("resource_dataset_current",
        sa.Column("scope", sa.String(40), primary_key=True),
        sa.Column("revision", sa.String(120), sa.ForeignKey("resource_dataset_versions.revision"), nullable=False))


def downgrade():
    raise RuntimeError("资源历史不能破坏性回退，请通过新增版本恢复")
