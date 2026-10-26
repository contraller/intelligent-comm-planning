"""设备配置系统受理记录；不代表真实下发或执行。"""
from alembic import op
import sqlalchemy as sa

revision = "0017_device_configuration"
down_revision = "0016_interference_scenes"
branch_labels = depends_on = None


def upgrade():
    op.create_table("device_configuration_requests",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("configuration_id", sa.String(35), unique=True, nullable=False),
        sa.Column("schema_version", sa.String(40), nullable=False),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("device_id", sa.String(120), nullable=False),
        sa.Column("model_id", sa.String(120), nullable=False),
        sa.Column("base_revision", sa.String(120), nullable=False),
        sa.Column("resource_content_hash", sa.String(64), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False))
    op.create_index("ix_device_configuration_actor_time", "device_configuration_requests",
        ["actor_id", "accepted_at", "configuration_id"])
    op.create_index("ix_device_configuration_actor_device_time", "device_configuration_requests",
        ["actor_id", "device_id", "accepted_at", "configuration_id"])


def downgrade():
    raise RuntimeError("配置受理回执不可破坏性删除，请保留历史")
