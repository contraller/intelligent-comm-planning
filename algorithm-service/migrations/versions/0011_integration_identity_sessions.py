"""显式联调身份的浏览器会话。"""
from alembic import op
import sqlalchemy as sa

revision = "0011_integration_sessions"
down_revision = "0010_sr6_knowledge_workflow"
branch_labels = depends_on = None


def upgrade():
    op.create_table("integration_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("session_id", sa.String(80), unique=True, nullable=False),
        sa.Column("account_id", sa.String(80), nullable=False),
        sa.Column("csrf", sa.String(100), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("expires_at", sa.Float(), nullable=False))


def downgrade():
    # 项目保留历史数据，回退应通过新迁移处理，禁止自动清空会话表。
    raise RuntimeError("本迁移不支持破坏性回退")
