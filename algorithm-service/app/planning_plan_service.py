"""版本化 SR4 方案的保存、分页查询和详情读取。"""
from __future__ import annotations

import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from . import frontend_integration, planning_job_service
from .database import get_session_factory
from .planning_job_models import PlanningJob
from .planning_plan_models import PlanningPlan
from .planning_plan_schemas import PlanningPlanSaveRequest


class PlanningPlanError(ValueError):
    """可直接映射为接口错误的方案管理异常。"""

    def __init__(self, code: int, message: str, status: int,
                 data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


_SAVE_LOCK = threading.RLock()


def _digest(payload: PlanningPlanSaveRequest) -> str:
    body = payload.model_dump(mode="json", exclude_none=False)
    raw = json.dumps(body, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _source_changed(plan: PlanningPlan) -> bool:
    return plan.resource_revision != frontend_integration.resource_revision()


def _dto(plan: PlanningPlan) -> dict[str, Any]:
    data = {
        "plan_id": plan.plan_id,
        "task_id": plan.task_id,
        "job_id": plan.job_id,
        "revision": plan.revision_id,
        "version": f"V{plan.version_no}",
        "name": plan.name,
        "note": plan.note,
        "input_version": plan.revision_id,
        "condition_version": plan.condition_version,
        "resource_revision": plan.resource_revision,
        "input": plan.input_snapshot,
        "parent_plan_id": plan.parent_plan_id,
        "state": plan.state,
        "source_changed": _source_changed(plan),
        "current": False,
        "saved_at": _timestamp(plan.saved_at),
        "confirmed_at": _timestamp(plan.confirmed_at),
        "source": plan.source,
        "result": plan.result_snapshot,
        "outcome": plan.outcome_snapshot,
    }
    if plan.adjustment is not None:
        data["adjustment"] = plan.adjustment
    return data


def _replay(session: Session, request_id: str,
            digest: str) -> PlanningPlan | None:
    plan = session.scalar(select(PlanningPlan).where(
        PlanningPlan.request_id == request_id
    ))
    if plan is None:
        return None
    if plan.request_digest != digest:
        raise PlanningPlanError(1204, "同一请求编号对应不同内容", 409)
    return plan


def _job_result(payload: PlanningPlanSaveRequest,
                factory: sessionmaker[Session]) -> dict[str, Any]:
    try:
        response = planning_job_service.query_planning_job(
            payload.job_id, payload.task_id, factory
        )
    except planning_job_service.PlanningJobError as exc:
        raise PlanningPlanError(exc.code, str(exc), exc.status, exc.data) from exc
    if response is None:
        raise PlanningPlanError(2001, "规划作业不存在", 404)
    data = response.get("data") or {}
    if data.get("revision") != payload.expected_revision:
        raise PlanningPlanError(1203, "作业输入版本与保存请求不一致", 409, {
            "expected": payload.expected_revision,
            "actual": data.get("revision"),
            "suggestions": ["重新打开规划结果"],
        })
    if data.get("status") != "SUCCESS" or not data.get("result") or not data.get("outcome"):
        raise PlanningPlanError(2002, "规划作业尚未产生可保存结果", 409)
    if response.get("code") not in {0, 3001, 3002}:
        raise PlanningPlanError(5001, "规划作业结果状态异常", 500)
    if payload.solution_id is not None:
        raise PlanningPlanError(1001, "当前 SR4 作业暂不支持多方案结果保存", 422)
    return data


def save_planning_plan(payload: PlanningPlanSaveRequest,
                       factory: sessionmaker[Session] | None = None
                       ) -> dict[str, Any]:
    factory = factory or get_session_factory()
    digest = _digest(payload)
    with factory() as session:
        replay = _replay(session, payload.request_id, digest)
        if replay is not None:
            return _dto(replay)

    job_data = _job_result(payload, factory)
    now = datetime.now(timezone.utc)
    try:
        with _SAVE_LOCK, factory() as session, session.begin():
            replay = _replay(session, payload.request_id, digest)
            if replay is not None:
                return _dto(replay)
            existing = session.scalar(select(PlanningPlan).where(
                PlanningPlan.job_id == payload.job_id
            ))
            if existing is not None:
                raise PlanningPlanError(1204, "该作业结果已经保存", 409, {
                    "plan_id": existing.plan_id,
                })
            job = session.get(PlanningJob, payload.job_id)
            if job is None or job.task_id != payload.task_id:
                raise PlanningPlanError(2001, "规划作业不存在", 404)
            version_no = (session.scalar(select(func.max(PlanningPlan.version_no)).where(
                PlanningPlan.task_id == payload.task_id
            )) or 0) + 1
            outcome = job_data["outcome"]
            state = ("SAVED" if outcome.get("code") == 0
                     and not job_data.get("source_changed") else "REFERENCE")
            plan = PlanningPlan(
                plan_id="PLAN-" + uuid.uuid4().hex,
                request_id=payload.request_id,
                request_digest=digest,
                task_id=payload.task_id,
                job_id=payload.job_id,
                revision_id=job.revision_id,
                condition_version=job.condition_version,
                resource_revision=job.resource_revision,
                parent_plan_id=job.parent_plan_id,
                adjustment=job.adjustment,
                version_no=version_no,
                name=payload.name,
                note=payload.note,
                state=state,
                input_snapshot=job_data["input"],
                result_snapshot=job_data["result"],
                outcome_snapshot=outcome,
                source="SR4",
                saved_at=now,
                confirmed_at=None,
            )
            session.add(plan)
            session.flush()
            return _dto(plan)
    except IntegrityError:
        with factory() as session:
            replay = _replay(session, payload.request_id, digest)
            if replay is not None:
                return _dto(replay)
            existing = session.scalar(select(PlanningPlan).where(
                PlanningPlan.job_id == payload.job_id
            ))
            if existing is not None:
                raise PlanningPlanError(1204, "该作业结果已经保存", 409, {
                    "plan_id": existing.plan_id,
                }) from None
        raise


def list_planning_plans(task_id: str, page: int, page_size: int,
                        search: str | None = None,
                        factory: sessionmaker[Session] | None = None
                        ) -> dict[str, Any]:
    if page < 1 or page_size < 1 or page_size > 100:
        raise PlanningPlanError(1001, "分页参数超出范围", 422)
    factory = factory or get_session_factory()
    with factory() as session:
        filters = [PlanningPlan.task_id == task_id]
        if search:
            filters.append(PlanningPlan.name.contains(search.strip(), autoescape=True))
        total = session.scalar(select(func.count()).select_from(PlanningPlan).where(
            *filters
        )) or 0
        rows = session.scalars(select(PlanningPlan).where(*filters).order_by(
            PlanningPlan.saved_at.desc(), PlanningPlan.plan_id.desc()
        ).offset((page - 1) * page_size).limit(page_size)).all()
        return {
            "items": [_dto(row) for row in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }


def get_planning_plan(plan_id: str, task_id: str,
                      factory: sessionmaker[Session] | None = None
                      ) -> dict[str, Any]:
    factory = factory or get_session_factory()
    with factory() as session:
        plan = session.get(PlanningPlan, plan_id)
        if plan is None or plan.task_id != task_id:
            raise PlanningPlanError(2001, "规划方案不存在", 404)
        return _dto(plan)
