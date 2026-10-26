"""SR5 正式故障场景及不可变版本。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class FaultScenario(Base):
    __tablename__ = "fault_scenarios"

    scenario_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    task_id: Mapped[str] = mapped_column(
        String(120), ForeignKey("planning_tasks.task_id"), nullable=False, index=True
    )
    archived: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class FaultScenarioVersion(Base):
    __tablename__ = "fault_scenario_versions"
    __table_args__ = (
        UniqueConstraint("scenario_id", "version_no", name="uq_fault_scenario_version"),
    )

    version_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    scenario_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("fault_scenarios.scenario_id"), nullable=False, index=True
    )
    version_no: Mapped[int] = mapped_column(Integer, nullable=False)
    plan_id: Mapped[str] = mapped_column(
        String(40), ForeignKey("planning_plans.plan_id"), nullable=False
    )
    plan_revision: Mapped[str] = mapped_column(String(40), nullable=False)
    resource_revision: Mapped[str] = mapped_column(String(120), nullable=False)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
