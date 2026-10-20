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
from .planning_plan_models import (
    PlanningCurrentPlan,
    PlanningPlan,
    PlanningPlanConfirmation,
)
from .planning_plan_schemas import PlanningPlanConfirmRequest, PlanningPlanSaveRequest


class PlanningPlanError(ValueError):
    """可直接映射为接口错误的方案管理异常。"""

    def __init__(self, code: int, message: str, status: int,
                 data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


_SAVE_LOCK = threading.RLock()
_CONFIRM_LOCK = threading.RLock()


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


def _dto(plan: PlanningPlan, current_plan_id: str | None = None) -> dict[str, Any]:
    source_changed = _source_changed(plan)
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
        "source_changed": source_changed,
        "current": current_plan_id == plan.plan_id and not source_changed,
        "saved_at": _timestamp(plan.saved_at),
        "confirmed_at": _timestamp(plan.confirmed_at),
        "source": plan.source,
        "result": plan.result_snapshot,
        "outcome": plan.outcome_snapshot,
    }
    if plan.adjustment is not None:
        data["adjustment"] = plan.adjustment
    return data


def _current_plan_id(session: Session, task_id: str) -> str | None:
    pointer = session.get(PlanningCurrentPlan, task_id)
    return pointer.plan_id if pointer is not None else None


def _plan_dto(session: Session, plan: PlanningPlan) -> dict[str, Any]:
    return _dto(plan, _current_plan_id(session, plan.task_id))


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
            return _plan_dto(session, replay)

    job_data = _job_result(payload, factory)
    now = datetime.now(timezone.utc)
    try:
        with _SAVE_LOCK, factory() as session, session.begin():
            replay = _replay(session, payload.request_id, digest)
            if replay is not None:
                return _plan_dto(session, replay)
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
            return _plan_dto(session, plan)
    except IntegrityError:
        with factory() as session:
            replay = _replay(session, payload.request_id, digest)
            if replay is not None:
                return _plan_dto(session, replay)
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
        current_plan_id = _current_plan_id(session, task_id)
        return {
            "items": [_dto(row, current_plan_id) for row in rows],
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
        return _plan_dto(session, plan)


def _confirmation_digest(plan_id: str,
                         payload: PlanningPlanConfirmRequest) -> str:
    body = payload.model_dump(mode="json")
    body["plan_id"] = plan_id
    raw = json.dumps(body, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _confirmation_replay(session: Session, request_id: str,
                         digest: str) -> PlanningPlan | None:
    receipt = session.get(PlanningPlanConfirmation, request_id)
    if receipt is None:
        return None
    if receipt.request_digest != digest:
        raise PlanningPlanError(1204, "同一请求编号对应不同内容", 409)
    plan = session.get(PlanningPlan, receipt.plan_id)
    if plan is None:
        raise PlanningPlanError(5001, "确认记录引用的方案不存在", 500)
    return plan


def confirm_planning_plan(plan_id: str, payload: PlanningPlanConfirmRequest,
                          factory: sessionmaker[Session] | None = None
                          ) -> dict[str, Any]:
    """确认达标且来源未变化的方案，并切换任务的当前方案指针。"""
    factory = factory or get_session_factory()
    digest = _confirmation_digest(plan_id, payload)
    try:
        with _CONFIRM_LOCK, factory() as session, session.begin():
            replay = _confirmation_replay(session, payload.request_id, digest)
            if replay is not None:
                return _plan_dto(session, replay)
            plan = session.get(PlanningPlan, plan_id)
            if plan is None or plan.task_id != payload.task_id:
                raise PlanningPlanError(2001, "规划方案不存在", 404)
            if plan.revision_id != payload.expected_revision:
                raise PlanningPlanError(1203, "方案输入版本与确认请求不一致", 409, {
                    "expected": payload.expected_revision,
                    "actual": plan.revision_id,
                    "suggestions": ["重新打开方案"],
                })
            if _source_changed(plan):
                raise PlanningPlanError(1205, "方案资源版本已经变化，不能确认", 409, {
                    "expected": plan.resource_revision,
                    "actual": frontend_integration.resource_revision(),
                    "suggestions": ["按当前资源重新运行规划"],
                })
            current_plan_id = _current_plan_id(session, payload.task_id)
            if plan.state == "REFERENCE":
                raise PlanningPlanError(3001, "参考方案未满足全部硬约束，不能确认", 409, {
                    "plan_id": plan.plan_id,
                    "gap": plan.outcome_snapshot.get("gap", []),
                })
            if plan.state == "CONFIRMED":
                if current_plan_id != plan.plan_id:
                    raise PlanningPlanError(3001, "历史确认方案不能重新设为当前方案", 409)
                session.add(PlanningPlanConfirmation(
                    request_id=payload.request_id,
                    request_digest=digest,
                    plan_id=plan.plan_id,
                    task_id=plan.task_id,
                    revision_id=plan.revision_id,
                    created_at=datetime.now(timezone.utc),
                ))
                session.flush()
                return _plan_dto(session, plan)
            if plan.state != "SAVED":
                raise PlanningPlanError(1001, "方案状态不允许确认", 409)

            now = datetime.now(timezone.utc)
            plan.state = "CONFIRMED"
            plan.confirmed_at = now
            pointer = session.get(PlanningCurrentPlan, plan.task_id)
            if pointer is None:
                session.add(PlanningCurrentPlan(
                    task_id=plan.task_id, plan_id=plan.plan_id, updated_at=now
                ))
            else:
                pointer.plan_id = plan.plan_id
                pointer.updated_at = now
            session.add(PlanningPlanConfirmation(
                request_id=payload.request_id,
                request_digest=digest,
                plan_id=plan.plan_id,
                task_id=plan.task_id,
                revision_id=plan.revision_id,
                created_at=now,
            ))
            session.flush()
            return _plan_dto(session, plan)
    except IntegrityError:
        with factory() as session:
            replay = _confirmation_replay(session, payload.request_id, digest)
            if replay is not None:
                return _plan_dto(session, replay)
        raise
