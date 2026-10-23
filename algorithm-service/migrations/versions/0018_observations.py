"""显式构造观测集、有限帧与导入回执；GET 不生成资料。"""
from alembic import op
import sqlalchemy as sa

revision = "0018_observations"
down_revision = "0017_device_configuration"
branch_labels = depends_on = None


def upgrade():
    op.create_table("observation_datasets",
        sa.Column("dataset_id", sa.String(120), primary_key=True),
        sa.Column("dataset_revision", sa.String(120), unique=True, nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("data_origin", sa.String(40), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("metadata_hash", sa.String(64), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("provenance_note", sa.String(500), nullable=False),
        sa.Column("source_snapshot", sa.JSON(), nullable=False),
        sa.Column("device_status_snapshot_id", sa.String(120), nullable=True),
        sa.Column("frame_count", sa.Integer(), nullable=False),
        sa.Column("first_observed_at", sa.String(40), nullable=True),
        sa.Column("last_observed_at", sa.String(40), nullable=True),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("imported_at", sa.String(40), nullable=False),
        sa.CheckConstraint("schema_version = 1", name="ck_observation_schema"),
        sa.CheckConstraint("data_origin = 'SYNTHETIC_INTEGRATION'", name="ck_observation_origin"),
        sa.CheckConstraint("frame_count BETWEEN 1 AND 256", name="ck_observation_frame_count"),
        sa.CheckConstraint("device_status_snapshot_id IS NULL", name="ck_observation_no_device_snapshot"))
    op.create_table("observation_frames",
        sa.Column("dataset_id", sa.String(120), sa.ForeignKey("observation_datasets.dataset_id", ondelete="RESTRICT"), primary_key=True),
        sa.Column("frame_index", sa.Integer(), primary_key=True),
        sa.Column("frame_id", sa.String(120), nullable=False),
        sa.Column("frame_payload", sa.JSON(), nullable=False),
        sa.Column("frame_hash", sa.String(64), nullable=False),
        sa.UniqueConstraint("dataset_id", "frame_id", name="uq_observation_frame_id"),
        sa.CheckConstraint("frame_index BETWEEN 0 AND 255", name="ck_observation_frame_index"))
    op.create_table("observation_import_operations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("dataset_id", sa.String(120), sa.ForeignKey("observation_datasets.dataset_id", ondelete="RESTRICT"), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False))
    # 显式创建六个 SQLite 触发器；仅比较 metadata 不会建立不可变约束。
    if op.get_bind().dialect.name == "sqlite":
        for table in ("observation_datasets", "observation_frames", "observation_import_operations"):
            for operation in ("UPDATE", "DELETE"):
                op.execute(sa.text(f"CREATE TRIGGER {table}_immutable_{operation.lower()} BEFORE {operation} ON {table} "
                    "BEGIN SELECT RAISE(ABORT, 'observation records are immutable'); END"))


def downgrade():
    raise RuntimeError("观测集、帧及导入回执不可破坏性删除，请保留历史")
