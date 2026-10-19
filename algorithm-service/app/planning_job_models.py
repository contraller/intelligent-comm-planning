"""规划作业与其冻结输入版本的持久化关联。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Float, ForeignKey, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class PlanningJob(Base):
    __tablename__ = "planning_jobs"

    job_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), nullable=False, index=True
    )
    revision_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_task_revisions.revision_id"), nullable=False
    )
    condition_version: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_revision: Mapped[str] = mapped_column(String(120), nullable=False)
    context: Mapped[str] = mapped_column(String(16), nullable=False)
    parent_plan_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    adjustment: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    progress: Mapped[float] = mapped_column(Float, nullable=False)
    stage: Mapped[str] = mapped_column(String(200), nullable=False)
    error: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
