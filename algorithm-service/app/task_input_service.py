"""规划任务输入保存、版本比较和幂等回放。"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .database import get_session_factory
from .task_input_models import PlanningOperationReceipt, PlanningTask, PlanningTaskRevision
from .task_input_schemas import TaskSaveRequest


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


def _replay(session: Session, request_id: str, digest: str) -> dict[str, Any] | None:
    receipt = session.get(PlanningOperationReceipt, request_id)
    if receipt is None:
        return None
    if receipt.request_digest != digest:
        raise TaskInputError(1204, "同一请求编号对应不同内容", 409)
    revision = session.get(PlanningTaskRevision, receipt.revision_id)
    return _dto(revision)


def _save(session: Session, payload: TaskSaveRequest, digest: str) -> dict[str, Any]:
    replay = _replay(session, payload.request_id, digest)
    if replay is not None:
        return replay
    task = session.scalar(select(PlanningTask).where(
        PlanningTask.task_id == payload.task_id).with_for_update())
    # 等待同一任务的并发写入后，重新读取请求回执。
    replay = _replay(session, payload.request_id, digest)
    if replay is not None:
        return replay
    current_id = task.current_revision_id if task else None
    if current_id != payload.expected_revision:
        raise TaskInputError(1203, "任务版本已变化，请重新打开后编辑", 409, {
            "expected": payload.expected_revision, "actual": current_id,
            "suggestions": ["重新打开任务"],
        })
    input_data = payload.input.model_dump(mode="json", exclude_unset=True)
    previous = session.get(PlanningTaskRevision, current_id) if current_id else None
    now = datetime.now(timezone.utc)
    if previous is not None and previous.input_snapshot == input_data:
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
    session.add(PlanningOperationReceipt(
        request_id=payload.request_id, request_digest=digest, operation="saveTask",
        task_id=payload.task_id, revision_id=revision.revision_id, state="SUCCEEDED",
        message="任务已保存", created_at=now,
    ))
    session.flush()
    return _dto(revision)


def save_task_input(payload: TaskSaveRequest, path_task_id: str,
                    factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    if path_task_id != payload.task_id:
        raise TaskInputError(1001, "路径任务编号与请求正文不一致", 422)
    digest = _request_digest(payload)
    factory = factory or get_session_factory()
    try:
        with factory() as session, session.begin():
            return _save(session, payload, digest)
    except IntegrityError:
        # 并发创建可能先命中唯一约束；提交者完成后可按回执安全重放。
        with factory() as session:
            replay = _replay(session, payload.request_id, digest)
            if replay is not None:
                return replay
            actual = session.get(PlanningTask, payload.task_id)
            raise TaskInputError(1203, "任务版本已变化，请重新打开后编辑", 409, {
                "expected": payload.expected_revision,
                "actual": actual.current_revision_id if actual else None,
                "suggestions": ["重新打开任务"],
            }) from None
