"""规划任务输入保存、版本比较和幂等回放。"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .database import get_session_factory
from . import frontend_integration
from . import resource_dataset_service
from .planning_job_models import PlanningJob
from .planning_operation_service import _append_owner, _business_context, _require_owner
from .task_input_models import PlanningOperationReceipt, PlanningTask, PlanningTaskRevision
from .task_input_schemas import (PlanningInput, TaskListQuery, TaskSaveRequest,
                                 TaskValidationRequest)
from scripts.planning.input_limits import input_limit_issues

if TYPE_CHECKING:
    from .local_business_context import LocalBusinessContext


class TaskInputError(Exception):
    def __init__(self, code: int, message: str, status: int, data: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _request_digest(payload: TaskSaveRequest) -> str:
    body = payload.model_dump(mode="json", exclude_unset=True)
    return hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()


def _condition_signature(input_data: dict[str, Any]) -> str:
    """按前端规划条件的比较口径，排除名称、说明及需求编号。"""
    deployment = input_data.get("deploymentConstraints")
    if deployment is not None:
        deployment = dict(deployment)
        if deployment.get("allowedLandcover") is not None:
            deployment["allowedLandcover"] = sorted(deployment["allowedLandcover"])
        deployment["losRequiredNodeIds"] = sorted(deployment["losRequiredNodeIds"])
    frequency = input_data.get("frequencyConstraints")
    if frequency is not None:
        frequency = {"filters": sorted(
            ({**item, "excludeFreqIds": sorted(item["excludeFreqIds"])} for item in frequency["filters"]),
            key=lambda item: item["deviceClass"],
        )}
    demands = []
    for row in input_data["demands"]:
        demand = {key: value for key, value in row.items()
                  if key not in ("id", "routeStrategy", "needBackup")}
        for key in ("routeStrategy", "needBackup"):
            if row.get(key) is not None:
                demand[key] = row[key]
        demand["endpointMode"] = row.get("endpointMode") or "station"
        for key in ("sourceDeviceId", "targetDeviceId", "preferredClass"):
            demand[key] = row.get(key)
        demands.append(demand)
    demands.sort(key=lambda item: _canonical([
        item["sourceId"], item["targetId"], item["service"], item["endpointMode"],
        item["sourceDeviceId"], item["targetDeviceId"],
    ]))
    conditions = {
        "startTime": input_data.get("startTime"),
        "durationH": input_data.get("durationH"),
        "bbox": input_data["bbox"],
        "constraints": input_data["constraints"],
        "deploymentConstraints": deployment,
        "frequencyConstraints": frequency,
        "deploymentSolve": input_data.get("deploymentSolve"),
        "stationIds": sorted(input_data["stationIds"]),
        "demands": demands,
        "presetId": input_data["presetId"],
        "frequencyId": input_data["frequencyId"],
    }
    return _canonical(conditions)


def _timestamp(value: datetime) -> str:
    # SQLite 读取 DateTime 时会丢失时区，库内约定按 UTC 保存。
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _dto(revision: PlanningTaskRevision) -> dict[str, Any]:
    return {
        "task_id": revision.task_id,
        "revision": revision.revision_id,
        "input_version": revision.revision_id,
        "condition_version": revision.condition_version,
        "resource_revision": revision.resource_revision,
        "input": revision.input_snapshot,
        "updated_at": _timestamp(revision.created_at),
        "active_job_id": None,
    }


def _current_dto(session: Session, revision: PlanningTaskRevision) -> dict[str, Any]:
    data = _dto(revision)
    job_id = session.scalar(select(PlanningJob.job_id).where(
        PlanningJob.task_id == revision.task_id,
        PlanningJob.context == revision.context,
    ).order_by(PlanningJob.created_at.desc(), PlanningJob.job_id.desc()).limit(1))
    data["active_job_id"] = job_id
    return data


def list_task_inputs(query: TaskListQuery,
                     factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    """只返回每个任务的当前版本，不回写历史快照。"""
    factory = factory or get_session_factory()
    base = select(PlanningTask, PlanningTaskRevision).join(
        PlanningTaskRevision,
        PlanningTask.current_revision_id == PlanningTaskRevision.revision_id,
    ).where(PlanningTaskRevision.context == query.context)
    term = query.search.strip()
    if term:
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        base = base.where(or_(
            PlanningTask.task_id.ilike(pattern, escape="\\"),
            PlanningTaskRevision.input_snapshot["name"].as_string().ilike(
                pattern, escape="\\"),
        ))
    with factory() as session:
        total = session.scalar(select(func.count()).select_from(base.subquery())) or 0
        rows = session.execute(base.order_by(
            PlanningTask.updated_at.desc(), PlanningTask.task_id.asc()
        ).offset((query.page - 1) * query.page_size).limit(query.page_size)).all()
        items = [_current_dto(session, revision) for _task, revision in rows]
    return {"items": items, "total": total,
            "page": query.page, "page_size": query.page_size}


def get_task_input(task_id: str, context: str,
                   factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    """按任务身份读取当前输入，跨场景不暴露另一任务版本。"""
    factory = factory or get_session_factory()
    with factory() as session:
        task = session.get(PlanningTask, task_id)
        revision = (session.get(PlanningTaskRevision, task.current_revision_id)
                    if task is not None else None)
        if revision is None or revision.context != context:
            raise TaskInputError(2001, "规划任务不存在", 404)
        return _current_dto(session, revision)


def availability_issues(input_data: dict[str, Any], catalog=None) -> list[dict[str, str]]:
    """只检查生命周期可用性，不把下架解释为运行故障或新增资源。"""
    catalog = catalog or frontend_integration.task_reference_catalog()
    devices = catalog["devices"]
    issues = []
    for node_id in input_data["stationIds"]:
        configured = [row for row in devices.values() if row["node_id"] == node_id]
        if configured and not any(row.get("availability", "ACTIVE") == "ACTIVE" for row in configured):
            issues.append({"objectId": node_id, "field": "stationIds", "message": "参与节点的设备均已下架，不能提交新规划"})
    for demand in input_data["demands"]:
        if demand.get("endpointMode") == "device":
            for key in ("sourceDeviceId", "targetDeviceId"):
                row = devices.get(demand.get(key))
                if row and row.get("availability", "ACTIVE") != "ACTIVE":
                    issues.append({"objectId": demand["id"], "field": key, "message": "指定设备已下架，请启用设备或修改通联需求"})
        elif demand.get("preferredClass"):
            for node_id in (demand["sourceId"], demand["targetId"]):
                configured = [row for row in devices.values() if row["node_id"] == node_id and row["device_class"] == demand["preferredClass"]]
                if configured and not any(row.get("availability", "ACTIVE") == "ACTIVE" for row in configured):
                    issues.append({"objectId": demand["id"], "field": "preferredClass", "message": "所需频段的设备均已下架"})
    return issues


def validate_task_input(payload: TaskValidationRequest,
                        factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    """只读预检当前输入结构与资源引用，返回可定位的字段问题。"""
    current_resource = frontend_integration.resource_revision()
    if payload.resource_revision != current_resource:
        raise TaskInputError(1205, "资源版本已变化，请刷新后重新校验", 409, {
            "expected": payload.resource_revision, "actual": current_resource,
        })
    factory = factory or get_session_factory()
    with factory() as session:
        task = session.get(PlanningTask, payload.task_id)
        revision = (session.get(PlanningTaskRevision, task.current_revision_id)
                    if task is not None else None)
        saved = (_current_dto(session, revision)
                 if revision is not None and revision.context == payload.context else None)

    issues = []
    try:
        data = PlanningInput.model_validate(payload.input)
    except ValidationError as exc:
        for error in exc.errors():
            location = error["loc"]
            object_id = payload.task_id
            if len(location) > 1 and location[0] == "demands" and isinstance(location[1], int):
                rows = payload.input.get("demands")
                if isinstance(rows, list) and location[1] < len(rows):
                    row = rows[location[1]]
                    if isinstance(row, dict) and isinstance(row.get("id"), str):
                        object_id = row["id"]
            issues.append({"objectId": object_id,
                           "field": ".".join(map(str, location)) or "input",
                           "message": error["msg"]})
        return {"valid": False, "issues": issues, "task": saved}

    catalog = frontend_integration.task_reference_catalog()
    if frontend_integration.resource_revision() != current_resource:
        raise TaskInputError(1205, "资源在校验期间发生变化，请重试", 409)
    node_ids = catalog["node_ids"]
    devices = catalog["devices"]
    issues.extend(input_limit_issues(data.model_dump(mode="json")))
    issues.extend(availability_issues(data.model_dump(mode="json"), catalog))
    for node_id in data.stationIds:
        if node_id not in node_ids:
            issues.append({"objectId": node_id, "field": "stationIds",
                           "message": "参与节点不存在"})
        elif not any(row["node_id"] == node_id for row in devices.values()):
            issues.append({"objectId": node_id, "field": "stationIds",
                           "message": "参与节点未配置设备"})
    for demand in data.demands:
        if demand.endpointMode != "device":
            continue
        for node_id, device_id in ((demand.sourceId, demand.sourceDeviceId),
                                   (demand.targetId, demand.targetDeviceId)):
            device = devices.get(device_id)
            if device is None or device["node_id"] != node_id:
                issues.append({"objectId": demand.id, "field": "devices",
                               "message": "指定设备不存在或归属节点不符"})
            elif (demand.preferredClass is not None
                  and device["device_class"] != demand.preferredClass):
                issues.append({"objectId": demand.id, "field": "preferredClass",
                               "message": "指定设备与偏好频段不符"})
    deployment = data.deploymentConstraints
    if deployment is not None and any(
            node_id not in node_ids for node_id in deployment.losRequiredNodeIds):
        issues.append({"objectId": payload.task_id,
                       "field": "deploymentConstraints.losRequiredNodeIds",
                       "message": "通视条件引用的节点不存在"})
    return {"valid": not issues, "issues": issues, "task": saved}


def _replay(session: Session, request_id: str, digest: str, audit_context=None) -> dict[str, Any] | None:
    receipt = session.get(PlanningOperationReceipt, request_id)
    if receipt is None:
        return None
    if receipt.request_digest != digest:
        raise TaskInputError(1204, "同一请求编号对应不同内容", 409)
    revision = session.get(PlanningTaskRevision, receipt.revision_id)
    if audit_context is not None:
        if revision is None or receipt.operation != "saveTask":
            raise TaskInputError(1204, "任务回执类型或冻结版本不一致", 409)
        _require_owner(session, audit_context, operation="task.save", request_id=request_id,
            object_id=receipt.task_id, page_context=revision.context, task_id=receipt.task_id, revision_id=receipt.revision_id)
    return _dto(revision)


def _save(session: Session, payload: TaskSaveRequest, digest: str, audit_context=None) -> dict[str, Any]:
    prepared = audit_context.prepare(session, "planning.execute") if audit_context is not None else None
    replay = _replay(session, payload.request_id, digest, audit_context)
    if replay is not None:
        return replay
    task = session.scalar(select(PlanningTask).where(
        PlanningTask.task_id == payload.task_id).with_for_update())
    # 等待同一任务的并发写入后，重新读取请求回执。
    replay = _replay(session, payload.request_id, digest, audit_context)
    if replay is not None:
        return replay
    current_id = task.current_revision_id if task else None
    if current_id != payload.expected_revision:
        raise TaskInputError(1203, "任务版本已变化，请重新打开后编辑", 409, {
            "expected": payload.expected_revision, "actual": current_id,
            "suggestions": ["重新打开任务"],
        })
    input_data = payload.input.model_dump(mode="json", exclude_unset=True)
    limit_issues = input_limit_issues(input_data)
    if limit_issues:
        raise TaskInputError(1001, "输入超过规划计算规模上限", 422, limit_issues)
    if resource_dataset_service.database_mode():
        if payload.resource_revision != frontend_integration.resource_revision():
            raise TaskInputError(1205, "资源版本已变化，请刷新后重新保存任务", 409)
        issues = availability_issues(input_data)
        if issues:
            raise TaskInputError(1001, "任务引用了不可用设备", 422, issues)
    previous = session.get(PlanningTaskRevision, current_id) if current_id else None
    now = datetime.now(timezone.utc)
    if (previous is not None and previous.input_snapshot == input_data
            and previous.resource_revision == payload.resource_revision):
        revision = previous
    else:
        revision_id = "TREV-" + uuid.uuid4().hex
        conditions = _condition_signature(input_data)
        old_conditions = _condition_signature(previous.input_snapshot) if previous else None
        condition_version = (previous.condition_version if previous and conditions == old_conditions
                             else "TCOND-" + uuid.uuid4().hex)
        if task is None:
            task = PlanningTask(task_id=payload.task_id, current_revision_id=revision_id,
                                current_version_no=1, created_at=now, updated_at=now)
            session.add(task)
            session.flush()
            version_no = 1
        else:
            version_no = task.current_version_no + 1
            task.current_revision_id = revision_id
            task.current_version_no = version_no
            task.updated_at = now
        revision = PlanningTaskRevision(
            revision_id=revision_id, task_id=payload.task_id, version_no=version_no,
            condition_version=condition_version, resource_revision=payload.resource_revision,
            context=payload.context, input_snapshot=input_data, created_at=now,
        )
        session.add(revision)
        session.flush()
    if audit_context is not None and revision.context != payload.context:
        raise TaskInputError(1204, "任务冻结场景与保存请求不一致", 409)
    session.add(PlanningOperationReceipt(
        request_id=payload.request_id, request_digest=digest, operation="saveTask",
        task_id=payload.task_id, revision_id=revision.revision_id, state="SUCCEEDED",
        message="任务已保存", created_at=now,
    ))
    session.flush()
    if audit_context is not None:
        _append_owner(audit_context, session, prepared, operation="task.save", request_id=payload.request_id,
            object_id=payload.task_id, page_context=revision.context, task_id=payload.task_id,
            revision_id=revision.revision_id, changed=revision is not previous)
    return _dto(revision)


def save_task_input(payload: TaskSaveRequest, path_task_id: str,
                    factory: sessionmaker[Session] | None = None, *,
                    audit_context: LocalBusinessContext | None = None) -> dict[str, Any]:
    owner = _business_context(audit_context)
    if path_task_id != payload.task_id:
        raise TaskInputError(1001, "路径任务编号与请求正文不一致", 422)
    digest = _request_digest(payload)
    if owner is not None:
        digest = owner.digest(digest, operation="task.save")
    factory = factory or get_session_factory()
    try:
        with factory() as session, session.begin():
            return _save(session, payload, digest, owner)
    except IntegrityError:
        # 并发创建可能先命中唯一约束；提交者完成后可按回执安全重放。
        with factory() as session, session.begin():
            if owner is not None:
                owner.prepare(session, "planning.execute")
            replay = _replay(session, payload.request_id, digest, owner)
            if replay is not None:
                return replay
            if owner is not None:
                raise
            actual = session.get(PlanningTask, payload.task_id)
            raise TaskInputError(1203, "任务版本已变化，请重新打开后编辑", 409, {
                "expected": payload.expected_revision,
                "actual": actual.current_revision_id if actual else None,
                "suggestions": ["重新打开任务"],
            }) from None
