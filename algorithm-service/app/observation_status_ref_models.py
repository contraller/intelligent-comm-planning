"""仅新增不可变关联；0018旧表、NULL约束和历史摘要不变。"""
from __future__ import annotations

from sqlalchemy import CheckConstraint, DDL, ForeignKey, Index, Integer, JSON, String, UniqueConstraint, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .device_status_models import DeviceStatusSnapshot
from .observation_models import ObservationDataset


class ObservationStatusRefBase(DeclarativeBase):
    pass


class ObservationDeviceStatusRef(ObservationStatusRefBase):
    __tablename__ = "observation_device_status_refs"
    __table_args__ = (
        UniqueConstraint("ref_revision", name="uq_observation_status_ref_revision"),
        CheckConstraint("schema_version=1", name="ck_observation_status_ref_schema"),
        CheckConstraint("data_origin='SYNTHETIC_INTEGRATION'", name="ck_observation_status_ref_origin"),
        CheckConstraint("length(ref_hash)=64 AND length(metadata_hash)=64 AND ref_revision='OSR-' || ref_hash",
            name="ck_observation_status_ref_digest"),
        Index("ix_observation_status_ref_snapshot", "snapshot_id", "snapshot_revision", "dataset_id"),
    )
    dataset_id: Mapped[str] = mapped_column(String(120), ForeignKey(ObservationDataset.__table__.c.dataset_id,
        name="fk_observation_status_ref_dataset", ondelete="RESTRICT"), primary_key=True)
    dataset_revision: Mapped[str] = mapped_column(String(120))
    snapshot_id: Mapped[str] = mapped_column(String(36), ForeignKey(DeviceStatusSnapshot.__table__.c.snapshot_id,
        name="fk_observation_status_ref_snapshot", ondelete="RESTRICT"))
    snapshot_revision: Mapped[str] = mapped_column(String(78))
    resource_revision: Mapped[str] = mapped_column(String(120))
    device_ids: Mapped[list[str]] = mapped_column(JSON)
    schema_version: Mapped[int] = mapped_column(Integer)
    data_origin: Mapped[str] = mapped_column(String(40))
    ref_revision: Mapped[str] = mapped_column(String(68))
    ref_hash: Mapped[str] = mapped_column(String(64))
    metadata_hash: Mapped[str] = mapped_column(String(64))
    actor_id: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[str] = mapped_column(String(40))


OBSERVATION_REF_METADATA = ObservationStatusRefBase.metadata


def sqlite_status_ref_immutability_ddl() -> tuple[str, ...]:
    return tuple(f"CREATE TRIGGER observation_device_status_refs_immutable_{operation.lower()} "
        f"BEFORE {operation} ON observation_device_status_refs "
        "BEGIN SELECT RAISE(ABORT, 'observation device status refs are immutable'); END"
        for operation in ("UPDATE", "DELETE"))


for _statement in sqlite_status_ref_immutability_ddl():
    event.listen(ObservationDeviceStatusRef.__table__, "after_create", DDL(_statement).execute_if(dialect="sqlite"))


@event.listens_for(ObservationDeviceStatusRef, "before_update")
@event.listens_for(ObservationDeviceStatusRef, "before_delete")
def _immutable(mapper, connection, target):
    raise ValueError("观测状态关联不可修改或删除")
