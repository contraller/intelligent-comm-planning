"""SR5 正式诊断与影响任务的持久化提交回执。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class FaultTaskSubmission(Base):
    __tablename__ = "fault_task_submissions"
    __table_args__ = (
        UniqueConstraint("algorithm_task_id", name="uq_fault_task_submission_task"),
    )

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    algorithm_task_id: Mapped[str] = mapped_column(String(40), nullable=False)
    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), nullable=False, index=True
    )
    plan_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_plans.plan_id"), nullable=False
    )
    scenario_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("fault_scenarios.scenario_id"), nullable=False
    )
    scenario_version_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("fault_scenario_versions.version_id"), nullable=False
    )
    diagnose_task_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
