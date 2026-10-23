"""不可变的设备配置请求/受理回执；迁移由总集成统一分配。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Index, JSON, String, event
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class DeviceConfigurationRequest(Base):
    __tablename__ = "device_configuration_requests"
    __table_args__ = (
        Index("ix_device_configuration_actor_time", "actor_id", "accepted_at", "configuration_id"),
        Index("ix_device_configuration_actor_device_time", "actor_id", "device_id", "accepted_at", "configuration_id"),
    )

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    configuration_id: Mapped[str] = mapped_column(String(35), unique=True, nullable=False)
    schema_version: Mapped[str] = mapped_column(String(40), nullable=False)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    device_id: Mapped[str] = mapped_column(String(120), nullable=False)
    model_id: Mapped[str] = mapped_column(String(120), nullable=False)
    base_revision: Mapped[str] = mapped_column(String(120), nullable=False)
    resource_content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    accepted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)


@event.listens_for(DeviceConfigurationRequest, "before_update")
@event.listens_for(DeviceConfigurationRequest, "before_delete")
def _immutable_acceptance(mapper, connection, target):
    raise ValueError("配置受理回执不可修改或删除")
