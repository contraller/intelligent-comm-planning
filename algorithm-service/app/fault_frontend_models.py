"""SR5 新版工作区修订、回执及冻结运行快照。"""
from __future__ import annotations
from typing import Any
from sqlalchemy import Float, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base


class FaultWorkspace(Base):
    __tablename__ = "fault_frontend_workspaces"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)


class FaultReceipt(Base):
    __tablename__ = "fault_frontend_receipts"
    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    digest: Mapped[str] = mapped_column(String(64), nullable=False)
    response: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)


class FaultRun(Base):
    __tablename__ = "fault_frontend_runs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    scenario_version_id: Mapped[str] = mapped_column(String(40), nullable=False)
    task_id: Mapped[str] = mapped_column(String(120), nullable=False)
    plan_id: Mapped[str] = mapped_column(String(40), nullable=False)
    diagnose_task_id: Mapped[str | None] = mapped_column(String(40))
    impact_task_id: Mapped[str | None] = mapped_column(String(40))
    started_at: Mapped[float] = mapped_column(Float, nullable=False)
    cancelled_at: Mapped[float | None] = mapped_column(Float)
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    diagnosis: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    impact: Mapped[dict[str, Any] | None] = mapped_column(JSON)
