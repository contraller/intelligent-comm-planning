"""频谱来源声明的不可变版本、可变指针及受理回执。"""
from alembic import op
import sqlalchemy as sa

revision = "0020_spectrum_sources"
down_revision = "0019_device_status"
branch_labels = depends_on = None


def upgrade():
    op.create_table("spectrum_source_versions",
        sa.Column("config_revision", sa.String(120), primary_key=True),
        sa.Column("source_id", sa.String(120), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("data_origin", sa.String(40), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("snapshot", sa.JSON(), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.CheckConstraint("schema_version=1", name="ck_spectrum_source_schema"),
        sa.CheckConstraint("data_origin='SYNTHETIC_INTEGRATION'", name="ck_spectrum_source_origin"))
    op.create_index("ix_spectrum_source_versions_source_id", "spectrum_source_versions", ["source_id"])
    op.create_table("spectrum_source_current",
        sa.Column("source_id", sa.String(120), primary_key=True),
        sa.Column("config_revision", sa.String(120), sa.ForeignKey("spectrum_source_versions.config_revision", ondelete="RESTRICT"), nullable=False))
    op.create_table("spectrum_source_operations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("operation_type", sa.String(30), nullable=False),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("source_id", sa.String(120), nullable=False),
        sa.Column("config_revision", sa.String(120), sa.ForeignKey("spectrum_source_versions.config_revision", ondelete="RESTRICT"), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.CheckConstraint("operation_type IN ('SOURCE_SAVE','SOURCE_CHECK')", name="ck_spectrum_source_operation"))
    op.create_index("ix_spectrum_source_operation_history", "spectrum_source_operations", ["source_id", "operation_type", "created_at", "request_id"])
    # 指针允许 CAS 更新，只有版本和操作事实受不可变约束。
    if op.get_bind().dialect.name == "sqlite":
        for table in ("spectrum_source_versions", "spectrum_source_operations"):
            for action in ("UPDATE", "DELETE"):
                op.execute(sa.text(f"CREATE TRIGGER {table}_immutable_{action.lower()} BEFORE {action} ON {table} "
                    "BEGIN SELECT RAISE(ABORT, 'spectrum source history is immutable'); END"))


def downgrade():
    raise RuntimeError("频谱来源版本及回执须保留，不允许破坏性降级")
