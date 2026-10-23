"""观测独立元数据；迁移编号与统一注册由总集成负责。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import CheckConstraint, DDL, ForeignKey, Integer, JSON, String, UniqueConstraint, event
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class ObservationBase(DeclarativeBase):
    pass


class ObservationDataset(ObservationBase):
    __tablename__ = "observation_datasets"
    __table_args__ = (
        CheckConstraint("schema_version = 1", name="ck_observation_schema"),
        CheckConstraint("data_origin = 'SYNTHETIC_INTEGRATION'", name="ck_observation_origin"),
        CheckConstraint("frame_count BETWEEN 1 AND 256", name="ck_observation_frame_count"),
        CheckConstraint("device_status_snapshot_id IS NULL", name="ck_observation_no_device_snapshot"),
    )

    dataset_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    dataset_revision: Mapped[str] = mapped_column(String(120), unique=True)
    schema_version: Mapped[int] = mapped_column(Integer)
    data_origin: Mapped[str] = mapped_column(String(40))
    content_hash: Mapped[str] = mapped_column(String(64))
    metadata_hash: Mapped[str] = mapped_column(String(64))
    resource_revision: Mapped[str] = mapped_column(String(120))
    provenance_note: Mapped[str] = mapped_column(String(500))
    source_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON)
    device_status_snapshot_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    frame_count: Mapped[int] = mapped_column(Integer)
    first_observed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_observed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    actor_id: Mapped[str] = mapped_column(String(120))
    imported_at: Mapped[str] = mapped_column(String(40))


class ObservationFrame(ObservationBase):
    __tablename__ = "observation_frames"
    __table_args__ = (
        UniqueConstraint("dataset_id", "frame_id", name="uq_observation_frame_id"),
        CheckConstraint("frame_index BETWEEN 0 AND 255", name="ck_observation_frame_index"),
    )

    dataset_id: Mapped[str] = mapped_column(ForeignKey("observation_datasets.dataset_id", ondelete="RESTRICT"), primary_key=True)
    frame_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    frame_id: Mapped[str] = mapped_column(String(120))
    frame_payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    frame_hash: Mapped[str] = mapped_column(String(64))


class ObservationImportOperation(ObservationBase):
    __tablename__ = "observation_import_operations"

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64))
    actor_id: Mapped[str] = mapped_column(String(120))
    dataset_id: Mapped[str] = mapped_column(ForeignKey("observation_datasets.dataset_id", ondelete="RESTRICT"))
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[str] = mapped_column(String(40))


OBSERVATION_METADATA = ObservationBase.metadata


def sqlite_immutability_ddl() -> tuple[str, ...]:
    """集成迁移须显式执行这些 DDL；仅注册 metadata 不会创建触发器。"""
    return tuple(
        f"CREATE TRIGGER {table}_immutable_{operation.lower()} BEFORE {operation} ON {table} "
        "BEGIN SELECT RAISE(ABORT, 'observation records are immutable'); END"
        for table in OBSERVATION_METADATA.tables
        for operation in ("UPDATE", "DELETE")
    )


for _table in OBSERVATION_METADATA.tables.values():
    for _statement in sqlite_immutability_ddl():
        if f" ON {_table.name} " in _statement:
            event.listen(_table, "after_create", DDL(_statement).execute_if(dialect="sqlite"))


def _immutable(mapper, connection, target):
    raise ValueError("观测数据、帧和导入回执不可修改或删除")


for _model in (ObservationDataset, ObservationFrame, ObservationImportOperation):
    event.listen(_model, "before_update", _immutable)
    event.listen(_model, "before_delete", _immutable)
