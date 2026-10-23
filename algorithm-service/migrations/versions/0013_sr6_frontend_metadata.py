"""SR6 页面内容及操作时身份，不回填伪造历史。"""
from alembic import op
import sqlalchemy as sa

revision = "0013_sr6_frontend_metadata"
down_revision = "0012_sr5_frontend_workspace"
branch_labels = depends_on = None


def upgrade():
    for table, column in (("kg_versions", "frontend_metadata"), ("kg_changes", "frontend_content"),
                          ("kg_submissions", "frontend_content"), ("kg_audit", "identity_snapshot")):
        op.add_column(table, sa.Column(column, sa.JSON(), nullable=True))


def downgrade():
    raise RuntimeError("历史知识与身份元数据不可破坏性回退")
