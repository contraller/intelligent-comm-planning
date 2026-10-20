"""按请求编号读取已持久化的规划写操作结果。"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from .database import get_session_factory
from .planning_job_models import PlanningJob, PlanningJobCancellation
from .planning_plan_models import PlanningPlan, PlanningPlanConfirmation
from .task_input_models import PlanningOperationReceipt, PlanningTaskRevision
from .task_input_schemas import Identifier


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
                    factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    """只查询已提交记录；未持久化的失败请求不可推断为成功。"""
    factory = factory or get_session_factory()
    if query.context != "planning" and query.kind != "saveTask":
        raise OperationError(1001, "该操作只支持 planning 场景", 422)
    with factory() as session:
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
        else:
            # 请求编号跨操作复用时明确拒绝，避免把已有回执误报为未提交。
            if any(_record(session, kind, query.request_id) is not None for kind in
                   ("saveTask", "submit", "cancel", "savePlan", "confirm")
                   if kind != query.kind):
                raise OperationError(1204, "请求编号对应其他操作类型", 409)
            entity_id, state, message = None, "NOT_FOUND", "没有此请求回执"
    return {"request_id": query.request_id, "task_id": query.task_id,
            "kind": query.kind, "state": state, "entity_id": entity_id,
            "message": message}
