"""前端可保存、查询和后续确认的规划方案版本。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class PlanningPlan(Base):
    __tablename__ = "planning_plans"
    __table_args__ = (
        UniqueConstraint("task_id", "version_no", name="uq_planning_plan_version"),
    )

    plan_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), nullable=False, index=True
    )
    job_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_jobs.job_id"), nullable=False, unique=True
    )
    revision_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_task_revisions.revision_id"), nullable=False
    )
    condition_version: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_revision: Mapped[str] = mapped_column(String(120), nullable=False)
    parent_plan_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    adjustment: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(60), nullable=False)
    note: Mapped[str] = mapped_column(String(500), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    input_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    result_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    outcome_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    source: Mapped[str] = mapped_column(String(40), nullable=False)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class PlanningCurrentPlan(Base):
    """每个任务唯一的当前确认方案指针。"""

    __tablename__ = "planning_current_plans"
    __table_args__ = (
        UniqueConstraint("plan_id", name="uq_planning_current_plan_id"),
    )

    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), primary_key=True
    )
    plan_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_plans.plan_id"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class PlanningPlanConfirmation(Base):
    """方案确认操作的幂等及审计记录。"""

    __tablename__ = "planning_plan_confirmations"

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    plan_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_plans.plan_id"), nullable=False
    )
    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), nullable=False, index=True
    )
    revision_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_task_revisions.revision_id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
