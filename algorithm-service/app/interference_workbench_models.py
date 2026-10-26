"""R2 运行、采纳待调度和不可变受理回执；不分配迁移号。"""
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from .database import Base


class InterferenceWorkbenchRun(Base):
    __tablename__ = "interference_workbench_runs"
    __table_args__ = (
        CheckConstraint("run_version >= 1", name="ck_iwb_run_version"),
        CheckConstraint("progress >= 0 AND progress <= 100", name="ck_iwb_run_progress"),
        CheckConstraint("state IN ('PENDING','RUNNING','CANCEL_REQUESTED','SUCCESS','FAILED','CANCELLED')", name="ck_iwb_run_state"),
        CheckConstraint("(state IN ('PENDING','RUNNING','CANCEL_REQUESTED') AND active_task_key IS NOT NULL AND active_task_key = task_id) OR (state IN ('SUCCESS','FAILED','CANCELLED') AND active_task_key IS NULL)", name="ck_iwb_run_active_key"),
    )

    run_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("planning_tasks.task_id"), nullable=False, index=True)
    plan_id: Mapped[str] = mapped_column(ForeignKey("planning_plans.plan_id"), nullable=False)
    scene_version_id: Mapped[str] = mapped_column(ForeignKey("interference_frontend_scene_versions.version_id"), nullable=False)
    resource_revision: Mapped[str] = mapped_column(ForeignKey("resource_dataset_versions.revision"), nullable=False)
    active_task_key: Mapped[str | None] = mapped_column(String(120), unique=True)
    run_version: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    progress: Mapped[int] = mapped_column(Integer, nullable=False)
    phase: Mapped[str] = mapped_column(String(200), nullable=False)
    source_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    result_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    result_hash: Mapped[str | None] = mapped_column(String(64))
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    error: Mapped[str | None] = mapped_column(String(2000))
    lease_owner: Mapped[str | None] = mapped_column(String(40))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class InterferenceWorkbenchAdoption(Base):
    __tablename__ = "interference_workbench_adoptions"
    __table_args__ = (
        UniqueConstraint("run_id", "measure_id", name="uq_iwb_adoption_measure"),
        CheckConstraint("adoption_version >= 1", name="ck_iwb_adoption_version"),
        CheckConstraint("state IN ('PENDING','RUNNING','CANCEL_REQUESTED','SUCCESS','FAILED','CANCELLED')", name="ck_iwb_adoption_state"),
    )

    adoption_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    task_id: Mapped[str] = mapped_column(ForeignKey("planning_tasks.task_id"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("interference_workbench_runs.run_id"), nullable=False, index=True)
    measure_id: Mapped[str] = mapped_column(String(40), nullable=False)
    adoption_version: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String(24), nullable=False)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    change_set: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    change_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    planning_request_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    planning_job_id: Mapped[str | None] = mapped_column(ForeignKey("planning_jobs.job_id"))
    result_plan_id: Mapped[str | None] = mapped_column(ForeignKey("planning_plans.plan_id"))
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    error: Mapped[str | None] = mapped_column(String(2000))
    lease_owner: Mapped[str | None] = mapped_column(String(40))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class InterferenceWorkbenchOperation(Base):
    __tablename__ = "interference_workbench_operations"
    __table_args__ = (CheckConstraint("operation IN ('SUBMIT_ANALYSIS','CANCEL_ANALYSIS','ADOPT_MEASURE','CANCEL_ADOPTION')", name="ck_iwb_operation"),)

    request_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    operation: Mapped[str] = mapped_column(String(32), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(120), nullable=False)
    task_id: Mapped[str] = mapped_column(ForeignKey("planning_tasks.task_id"), nullable=False, index=True)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    object_type: Mapped[str] = mapped_column(String(16), nullable=False)
    object_id: Mapped[str] = mapped_column(String(40), nullable=False)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    receipt_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


@event.listens_for(InterferenceWorkbenchOperation, "before_update")
@event.listens_for(InterferenceWorkbenchOperation, "before_delete")
def _keep_receipt(mapper, connection, target):
    raise ValueError("干扰受理回执不可修改或删除")
