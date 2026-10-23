"""按请求编号读取已持久化的规划写操作结果。"""
from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from .database import get_session_factory
from .planning_job_models import PlanningJob, PlanningJobCancellation
from .planning_plan_models import PlanningPlan, PlanningPlanConfirmation
from .task_input_models import PlanningOperationReceipt, PlanningTaskRevision
from .task_input_schemas import Identifier
from .system_management_models import SystemAuditEvent
from .system_management_schemas import SystemManagementError

if TYPE_CHECKING:
    from .local_business_context import LocalBusinessContext


_OPERATIONS = {"saveTask": "task.save", "submit": "planning.submit", "cancel": "planning.cancel",
               "savePlan": "plan.save", "confirm": "plan.confirm"}


def _business_context(audit_context: LocalBusinessContext | None):
    if audit_context is None:
        if os.environ.get("AUTH_MODE") == "LOCAL_PASSWORD":
            raise SystemManagementError("本地规划操作缺少可信业务上下文", 5001, 503)
        return None
    from .local_business_context import LocalBusinessContext
    if type(audit_context) is not LocalBusinessContext:
        raise SystemManagementError("本地规划业务上下文无效", 1101, 401)
    return audit_context


def _require_owner(session, context, *, operation, request_id, object_id,
                   page_context, task_id, revision_id):
    context.require_owner(session, operation=operation, request_id=request_id, object_id=object_id)
    metadata = session.scalar(select(SystemAuditEvent.changes).where(
        SystemAuditEvent.module == "planning", SystemAuditEvent.action == operation,
        SystemAuditEvent.request_id == request_id, SystemAuditEvent.object_id == object_id,
        SystemAuditEvent.outcome.in_(("SUCCESS", "UNCHANGED"))))
    expected = {"context": page_context, "task_id": task_id, "revision_id": revision_id}
    if not isinstance(metadata, dict) or any(metadata.get(key) != value for key, value in expected.items()):
        raise SystemManagementError("业务归属证明与冻结回执不一致", 1204, 409)


def _append_owner(context, session, prepared, *, operation, request_id, object_id,
                  page_context, task_id, revision_id, changed=True):
    try:
        context.append_owner(session, prepared, operation=operation, request_id=request_id, object_id=object_id,
            changed=changed, changes={"context": page_context, "task_id": task_id, "revision_id": revision_id})
    except SQLAlchemyError as exc:
        # 审计失败不能进入业务唯一约束的并发重放分支；外层事务负责整笔回滚。
        raise SystemManagementError("规划业务审计未能完成", 5002, 503) from exc


class OperationQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context: Literal["gis", "planning"]
    task_id: Identifier
    kind: Literal["saveTask", "submit", "cancel", "savePlan", "confirm"]
    request_id: Identifier


class OperationError(ValueError):
    def __init__(self, code: int, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _record(session: Session, kind: str, request_id: str) -> Any:
    if kind == "saveTask":
        return session.get(PlanningOperationReceipt, request_id)
    if kind == "submit":
        return session.scalar(select(PlanningJob).where(PlanningJob.request_id == request_id))
    if kind == "cancel":
        return session.get(PlanningJobCancellation, request_id)
    if kind == "savePlan":
        return session.scalar(select(PlanningPlan).where(PlanningPlan.request_id == request_id))
    return session.get(PlanningPlanConfirmation, request_id)


def query_operation(query: OperationQuery,
                    factory: sessionmaker[Session] | None = None, *,
                    audit_context: LocalBusinessContext | None = None) -> dict[str, Any]:
    """只查询已提交记录；未持久化的失败请求不可推断为成功。"""
    owner = _business_context(audit_context)
    factory = factory or get_session_factory()
    if query.context != "planning" and query.kind != "saveTask":
        raise OperationError(1001, "该操作只支持 planning 场景", 422)
    with factory() as session, session.begin():
        if owner is not None:
            owner.prepare(session, "planning.view")
        record = _record(session, query.kind, query.request_id)
        if record is not None:
            if record.task_id != query.task_id:
                raise OperationError(1204, "回执归属与查询任务不一致", 409)
            if query.kind == "saveTask":
                revision = session.get(PlanningTaskRevision, record.revision_id)
                if record.operation != query.kind or revision is None or revision.context != query.context:
                    raise OperationError(1204, "回执归属与查询类型或场景不一致", 409)
                entity_id = record.task_id
                state, message = record.state, record.message
            elif query.kind == "submit":
                entity_id, state, message = record.job_id, "SUCCEEDED", "规划作业已提交"
            elif query.kind == "cancel":
                entity_id, state, message = record.job_id, "SUCCEEDED", "取消请求已处理"
            elif query.kind == "savePlan":
                entity_id, state, message = record.plan_id, "SUCCEEDED", "方案已保存"
            else:
                entity_id, state, message = record.plan_id, "SUCCEEDED", "方案确认请求已处理"
            if owner is not None:
                _require_owner(session, owner, operation=_OPERATIONS[query.kind], request_id=query.request_id,
                    object_id=entity_id, page_context=query.context, task_id=record.task_id, revision_id=record.revision_id)
        else:
            # 请求编号跨操作复用时明确拒绝，避免把已有回执误报为未提交。
            if any(_record(session, kind, query.request_id) is not None for kind in
                   ("saveTask", "submit", "cancel", "savePlan", "confirm")
                   if kind != query.kind):
                raise OperationError(1204, "请求编号对应其他操作类型", 409)
            if owner is not None and session.scalar(select(SystemAuditEvent.id).where(
                    SystemAuditEvent.module == "planning", SystemAuditEvent.action.in_(_OPERATIONS.values()),
                    SystemAuditEvent.request_id == query.request_id,
                    SystemAuditEvent.outcome.in_(("SUCCESS", "UNCHANGED")),
                    SystemAuditEvent.changes["ownerProofVersion"].as_string() == "local-owner-v1").limit(1)):
                raise OperationError(5002, "已提交归属证明缺少业务回执", 503)
            entity_id, state, message = None, "NOT_FOUND", "没有此请求回执"
    return {"request_id": query.request_id, "task_id": query.task_id,
            "kind": query.kind, "state": state, "entity_id": entity_id,
            "message": message}
