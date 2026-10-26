"""规划任务当前指针、不可变输入版本和保存回执。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class PlanningTask(Base):
    __tablename__ = "planning_tasks"

    task_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    current_revision_id: Mapped[str] = mapped_column(String(40), nullable=False)
    current_version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PlanningTaskRevision(Base):
    __tablename__ = "planning_task_revisions"
    __table_args__ = (UniqueConstraint("task_id", "version_no", name="uq_task_revision_number"),)

    revision_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), nullable=False, index=True
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    condition_version: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_revision: Mapped[str] = mapped_column(String(120), nullable=False)
    context: Mapped[str] = mapped_column(String(16), nullable=False)
    input_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PlanningOperationReceipt(Base):
    __tablename__ = "planning_operation_receipts"

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    operation: Mapped[str] = mapped_column(String(16), nullable=False)
    task_id: Mapped[str] = mapped_column(String(120), nullable=False)
    revision_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_task_revisions.revision_id"), nullable=False
    )
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    message: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
