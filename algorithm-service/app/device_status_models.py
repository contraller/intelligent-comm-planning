"""P06 不可变状态快照三表；仅交模型，正式迁移由总集成分配。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, JSON, String, event
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class DeviceStatusSnapshot(Base):
    __tablename__ = "device_status_snapshots"
    __table_args__ = (
        CheckConstraint("data_origin = 'SYNTHETIC_INTEGRATION'", name="ck_device_status_origin"),
        CheckConstraint("total BETWEEN 1 AND 1000", name="ck_device_status_total"),
        Index("ix_device_status_snapshot_resource_time", "resource_revision", "imported_at", "snapshot_id"),
    )
    snapshot_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    snapshot_revision: Mapped[str] = mapped_column(String(78), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_revision: Mapped[str] = mapped_column(String(120), nullable=False)
    resource_content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    data_origin: Mapped[str] = mapped_column(String(40), nullable=False)
    source_label: Mapped[str] = mapped_column(String(120), nullable=False)
    provenance_note: Mapped[str] = mapped_column(String(1000), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    total: Mapped[int] = mapped_column(Integer, nullable=False)
    counts: Mapped[dict[str, int]] = mapped_column(JSON, nullable=False)
    first_observed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_observed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    original_input: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    header_hash: Mapped[str] = mapped_column(String(64), nullable=False)


class DeviceStatusRecord(Base):
    __tablename__ = "device_status_records"
    __table_args__ = (
        CheckConstraint("status IS NULL OR status IN ('NORMAL','FAULT','OFFLINE')", name="ck_device_status_value"),
        CheckConstraint("availability IN ('ACTIVE','OFF_SHELF')", name="ck_device_status_availability"),
        Index("ix_device_status_record_filter", "snapshot_id", "status", "device_id"),
    )
    snapshot_id: Mapped[str] = mapped_column(String(36), ForeignKey("device_status_snapshots.snapshot_id"), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    node_id: Mapped[str] = mapped_column(String(120), nullable=False)
    model_id: Mapped[str] = mapped_column(String(120), nullable=False)
    availability: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str | None] = mapped_column(String(12), nullable=True)
    alert: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    observed_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    unknown_reasons: Mapped[list[str]] = mapped_column(JSON, nullable=False)


class DeviceStatusImportOperation(Base):
    __tablename__ = "device_status_import_operations"
    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    snapshot_id: Mapped[str] = mapped_column(String(36), ForeignKey("device_status_snapshots.snapshot_id"), nullable=False)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


for _model in (DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation):
    @event.listens_for(_model, "before_update")
    @event.listens_for(_model, "before_delete")
    def _immutable(mapper, connection, target):
        raise ValueError("设备状态快照与回执不可修改或删除")
