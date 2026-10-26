"""P03 专用场景、不可变版本和持久化幂等回执；迁移由总集成分配。"""
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class InterferenceScene(Base):
    __tablename__ = "interference_frontend_scenes"
    __table_args__ = (CheckConstraint("latest_version_no >= 1", name="ck_interference_scene_latest"),)

    scene_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("planning_tasks.task_id"), nullable=False, index=True)
    # 不建立反向外键，避免与版本的 scene_id 外键形成迁移循环。
    latest_version_id: Mapped[str] = mapped_column(String(40), nullable=False)
    latest_version_no: Mapped[int] = mapped_column(Integer, nullable=False)


class InterferenceSceneVersion(Base):
    __tablename__ = "interference_frontend_scene_versions"
    __table_args__ = (
        UniqueConstraint("scene_id", "version_no", name="uq_interference_scene_version"),
        CheckConstraint("version_no >= 1", name="ck_interference_scene_version"),
    )

    version_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    scene_id: Mapped[str] = mapped_column(ForeignKey("interference_frontend_scenes.scene_id"), nullable=False, index=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("planning_tasks.task_id"), nullable=False, index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("planning_plans.plan_id"), nullable=False)
    resource_revision: Mapped[str] = mapped_column(ForeignKey("resource_dataset_versions.revision"), nullable=False)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    snapshot_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    saved_by: Mapped[str] = mapped_column(String(120), nullable=False)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class InterferenceSceneReceipt(Base):
    __tablename__ = "interference_frontend_scene_receipts"

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    task_id: Mapped[str] = mapped_column(ForeignKey("planning_tasks.task_id"), nullable=False, index=True)
    scene_id: Mapped[str] = mapped_column(ForeignKey("interference_frontend_scenes.scene_id"), nullable=False)
    version_id: Mapped[str] = mapped_column(ForeignKey("interference_frontend_scene_versions.version_id"), nullable=False)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


@event.listens_for(InterferenceSceneVersion, "before_update")
@event.listens_for(InterferenceSceneVersion, "before_delete")
@event.listens_for(InterferenceSceneReceipt, "before_update")
@event.listens_for(InterferenceSceneReceipt, "before_delete")
def _immutable(mapper, connection, target):
    raise ValueError("干扰场景版本和成功回执不可修改或删除")
