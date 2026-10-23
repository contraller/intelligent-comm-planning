"""独立构造设备状态快照，不更新资源基线或伪造设备上报。"""
from alembic import op
import sqlalchemy as sa

revision = "0019_device_status"
down_revision = "0018_observations"
branch_labels = depends_on = None


def upgrade():
    op.create_table("device_status_snapshots",
        sa.Column("snapshot_id", sa.String(36), primary_key=True),
        sa.Column("snapshot_revision", sa.String(78), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("resource_content_hash", sa.String(64), nullable=False),
        sa.Column("data_origin", sa.String(40), nullable=False),
        sa.Column("source_label", sa.String(120), nullable=False),
        sa.Column("provenance_note", sa.String(1000), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("first_observed_at", sa.String(40), nullable=True),
        sa.Column("last_observed_at", sa.String(40), nullable=True),
        sa.Column("original_input", sa.JSON(), nullable=False),
        sa.Column("header_hash", sa.String(64), nullable=False),
        sa.CheckConstraint("data_origin = 'SYNTHETIC_INTEGRATION'", name="ck_device_status_origin"),
        sa.CheckConstraint("total BETWEEN 1 AND 1000", name="ck_device_status_total"))
    op.create_index("ix_device_status_snapshot_resource_time", "device_status_snapshots", ["resource_revision", "imported_at", "snapshot_id"])
    op.create_table("device_status_records",
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("device_status_snapshots.snapshot_id"), primary_key=True),
        sa.Column("device_id", sa.String(120), primary_key=True),
        sa.Column("node_id", sa.String(120), nullable=False),
        sa.Column("model_id", sa.String(120), nullable=False),
        sa.Column("availability", sa.String(20), nullable=False),
        sa.Column("status", sa.String(12), nullable=True),
        sa.Column("alert", sa.Boolean(), nullable=True),
        sa.Column("observed_at", sa.String(40), nullable=True),
        sa.Column("unknown_reasons", sa.JSON(), nullable=False),
        sa.CheckConstraint("status IS NULL OR status IN ('NORMAL','FAULT','OFFLINE')", name="ck_device_status_value"),
        sa.CheckConstraint("availability IN ('ACTIVE','OFF_SHELF')", name="ck_device_status_availability"))
    op.create_index("ix_device_status_record_filter", "device_status_records", ["snapshot_id", "status", "device_id"])
    op.create_table("device_status_import_operations",
        sa.Column("request_id", sa.String(120), primary_key=True),
        sa.Column("request_digest", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("device_status_snapshots.snapshot_id"), nullable=False),
        sa.Column("receipt", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    if op.get_bind().dialect.name == "sqlite":
        for table in ("device_status_snapshots", "device_status_records", "device_status_import_operations"):
            for operation in ("UPDATE", "DELETE"):
                op.execute(sa.text(f"CREATE TRIGGER {table}_immutable_{operation.lower()} BEFORE {operation} ON {table} "
                    "BEGIN SELECT RAISE(ABORT, 'immutable device status'); END"))


def downgrade():
    raise RuntimeError("设备状态快照及回执须保留，不允许破坏性降级")
