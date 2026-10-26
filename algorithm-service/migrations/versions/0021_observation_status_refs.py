"""新增观测与冻结设备状态关联，不改0018的旧记录和NULL检查。"""
from alembic import op
import sqlalchemy as sa

revision = "0021_observation_status_refs"
down_revision = "0020_spectrum_sources"
branch_labels = depends_on = None


def upgrade():
    op.create_table("observation_device_status_refs",
        sa.Column("dataset_id", sa.String(120), sa.ForeignKey("observation_datasets.dataset_id", name="fk_observation_status_ref_dataset", ondelete="RESTRICT"), primary_key=True),
        sa.Column("dataset_revision", sa.String(120), nullable=False),
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("device_status_snapshots.snapshot_id", name="fk_observation_status_ref_snapshot", ondelete="RESTRICT"), nullable=False),
        sa.Column("snapshot_revision", sa.String(78), nullable=False),
        sa.Column("resource_revision", sa.String(120), nullable=False),
        sa.Column("device_ids", sa.JSON(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("data_origin", sa.String(40), nullable=False),
        sa.Column("ref_revision", sa.String(68), nullable=False),
        sa.Column("ref_hash", sa.String(64), nullable=False),
        sa.Column("metadata_hash", sa.String(64), nullable=False),
        sa.Column("actor_id", sa.String(120), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.UniqueConstraint("ref_revision", name="uq_observation_status_ref_revision"),
        sa.CheckConstraint("schema_version=1", name="ck_observation_status_ref_schema"),
        sa.CheckConstraint("data_origin='SYNTHETIC_INTEGRATION'", name="ck_observation_status_ref_origin"),
        sa.CheckConstraint("length(ref_hash)=64 AND length(metadata_hash)=64 AND ref_revision='OSR-' || ref_hash", name="ck_observation_status_ref_digest"))
    op.create_index("ix_observation_status_ref_snapshot", "observation_device_status_refs", ["snapshot_id", "snapshot_revision", "dataset_id"])
    if op.get_bind().dialect.name == "sqlite":
        for action in ("UPDATE", "DELETE"):
            op.execute(sa.text(f"CREATE TRIGGER observation_device_status_refs_immutable_{action.lower()} BEFORE {action} ON observation_device_status_refs "
                "BEGIN SELECT RAISE(ABORT, 'observation device status refs are immutable'); END"))


def downgrade():
    raise RuntimeError("观测与设备状态关联须保留，不允许破坏性降级")
