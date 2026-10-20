"""绑定数据库输入版本并提交真实 SR4 异步作业。"""
from __future__ import annotations

import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from . import frontend_integration, planning_result_adapter, planning_w3, planning_w4
from .database import get_session_factory
from .planning_job_models import PlanningJob
from .planning_plan_models import PlanningPlan
from .planning_job_schemas import PlanningJobSubmitRequest
from .task_input_models import PlanningTask, PlanningTaskRevision


class PlanningJobError(ValueError):
    """可直接映射为接口错误的规划作业异常。"""

    def __init__(self, code: int, message: str, status: int,
                 data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


_SUBMIT_LOCK = threading.RLock()
_PRESET_MAP = {
    "balanced": "TERRAIN",
    "reliable": "MISSION",
    "economical": "INTERFERENCE",
}
_PHASES = (
    ("任务与资源加载", 0.15),
    ("电台部署", 0.30),
    ("路由与频率规划", 0.55),
    ("多目标优化", 0.80),
    ("干扰分析与方案校验", 1.00),
)


def _digest(payload: PlanningJobSubmitRequest) -> str:
    body = payload.model_dump(mode="json", exclude_none=False)
    raw = json.dumps(body, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _phases(progress: float) -> list[dict[str, str]]:
    result = []
    for name, threshold in _PHASES:
        if progress >= threshold:
            state = "done"
        elif not any(item["state"] == "running" for item in result):
            state = "running"
        else:
            state = "waiting"
        result.append({"name": name, "state": state})
    return result


def _dto(job: PlanningJob, revision: PlanningTaskRevision) -> dict[str, Any]:
    progress = max(0.0, min(1.0, float(job.progress)))
    return {
        "job_id": job.job_id,
        "task_id": job.task_id,
        "revision": revision.revision_id,
        "input_version": revision.revision_id,
        "condition_version": revision.condition_version,
        "resource_revision": revision.resource_revision,
        "input": revision.input_snapshot,
        "parent_plan_id": job.parent_plan_id,
        "status": job.status,
        "progress": progress,
        "phases": _phases(progress),
        "result": None,
        "outcome": None,
        "error": job.error,
        "expired": False,
        "source_changed": revision.resource_revision != frontend_integration.resource_revision(),
        "saved_plan_id": None,
    }


def _validate_supported_input(input_data: dict[str, Any]) -> None:
    unsupported = [key for key in (
        "frequencyConstraints", "deploymentSolve", "deploymentConstraints"
    ) if input_data.get(key) is not None]
    if unsupported:
        raise PlanningJobError(
            1001,
            "当前 SR4 提交尚不支持以下高级条件：" + "、".join(unsupported),
            422,
            [{"objectId": "task", "field": key, "message": "该条件尚未接入 SR4"}
             for key in unsupported],
        )


def _validate_resources(input_data: dict[str, Any], revision: str) -> None:
    for node_id in input_data["stationIds"]:
        try:
            frontend_integration.resource_object("node", node_id, revision)
        except KeyError as exc:
            raise PlanningJobError(1002, f"参与节点不存在：{node_id}", 404) from exc
    preset_id = input_data["presetId"]
    if preset_id not in _PRESET_MAP:
        raise PlanningJobError(1003, f"规划预设不存在：{preset_id}", 422)
    frequencies = frontend_integration.planning_frequency_catalog()["data"]["items"]
    if input_data["frequencyId"] not in {row["id"] for row in frequencies}:
        raise PlanningJobError(1002, "频率资源不存在或已变化", 409)


def _algorithm_payload(payload: PlanningJobSubmitRequest,
                       revision: PlanningTaskRevision) -> dict[str, Any]:
    input_data = revision.input_snapshot
    _validate_supported_input(input_data)
    _validate_resources(input_data, revision.resource_revision)
    existing_demands = {row["demand_id"]: row
                        for row in planning_w4._load("comm_demand.csv")}
    conflicting_ids = [row["id"] for row in input_data["demands"]
                       if row["id"] in existing_demands
                       and existing_demands[row["id"]]["task_id"] != payload.task_id]
    if conflicting_ids:
        raise PlanningJobError(
            1001, "通联需求编号与其他任务冲突：" + "、".join(conflicting_ids), 422
        )
    strategies = {row.get("routeStrategy") for row in input_data["demands"]
                  if row.get("routeStrategy") is not None}
    if len(strategies) > 1:
        raise PlanningJobError(1001, "同一次 SR4 运行只能使用一种路由策略", 422)
    demands = []
    for row in input_data["demands"]:
        demands.append({
            "demand_id": row["id"],
            "task_id": payload.task_id,
            "src_node_id": row["sourceId"],
            "dst_node_id": row["targetId"],
            "priority": row["priority"],
            "is_mandatory": "true" if row["mandatory"] else "false",
            "data_volume_mb": row.get("dataVolumeMb") or 0,
            "required_rate_kbps": row["requiredRateKbps"],
            "max_delay_ms": row["maxDelayMs"],
            "min_reliability": row["minReliability"],
            "service_type": row["service"],
            "preferred_class": row.get("preferredClass") or "",
        })
    constraints = input_data["constraints"]
    return {
        "task_id": payload.task_id,
        "preset": _PRESET_MAP[input_data["presetId"]],
        "strategy": next(iter(strategies), "MAX_RELIABILITY"),
        "hard_constraints": {
            "mandatory_e2e_connectivity": constraints["connectivityPercent"] / 100,
            "survivability_threshold": constraints["survivabilityPercent"] / 100,
            "max_relay_hops": constraints["maxRelayHops"],
        },
        "survivability_scope": "NETWORK",
        "demand_rows": demands,
    }


def _update_job(factory: sessionmaker[Session], job_id: str,
                state: dict[str, Any]) -> None:
    with factory() as session, session.begin():
        job = session.get(PlanningJob, job_id)
        if job is None:
            return
        job.status = str(state.get("status", job.status))
        job.progress = float(state.get("progress", job.progress))
        job.stage = str(state.get("stage", job.stage))
        job.error = state.get("error")
        job.updated_at = datetime.now(timezone.utc)


def _existing_by_request(session: Session, request_id: str, digest: str
                         ) -> tuple[PlanningJob, PlanningTaskRevision] | None:
    job = session.scalar(select(PlanningJob).where(
        PlanningJob.request_id == request_id))
    if job is None:
        return None
    if job.request_digest != digest:
        raise PlanningJobError(1204, "同一请求编号对应不同内容", 409)
    revision = session.get(PlanningTaskRevision, job.revision_id)
    if revision is None:
        raise PlanningJobError(5001, "规划作业引用的输入版本不存在", 500)
    return job, revision


def _reserve(factory: sessionmaker[Session], payload: PlanningJobSubmitRequest,
             digest: str) -> tuple[
                 PlanningJob, PlanningTaskRevision, bool, dict[str, Any] | None
             ]:
    with _SUBMIT_LOCK, factory() as session, session.begin():
        replay = _existing_by_request(session, payload.request_id, digest)
        if replay is not None:
            return replay[0], replay[1], False, None
        task = session.get(PlanningTask, payload.task_id)
        if task is None:
            raise PlanningJobError(1002, "规划任务不存在，请先保存任务", 404)
        if task.current_revision_id != payload.expected_revision:
            raise PlanningJobError(1203, "任务版本已变化，请重新打开后提交", 409, {
                "expected": payload.expected_revision,
                "actual": task.current_revision_id,
                "suggestions": ["重新打开任务"],
            })
        if payload.input_version != payload.expected_revision:
            raise PlanningJobError(1203, "输入版本与当前任务版本不一致", 409)
        revision = session.get(PlanningTaskRevision, payload.input_version)
        if revision is None or revision.task_id != payload.task_id:
            raise PlanningJobError(1002, "任务输入版本不存在", 404)
        if revision.condition_version != payload.condition_version:
            raise PlanningJobError(1203, "任务条件版本不一致", 409)
        if revision.resource_revision != payload.resource_revision:
            raise PlanningJobError(1203, "请求资源版本与保存版本不一致", 409)
        current_resource = frontend_integration.resource_revision()
        if payload.resource_revision != current_resource:
            raise PlanningJobError(1205, "资源版本已经变化，请重新保存任务", 409, {
                "expected": payload.resource_revision,
                "actual": current_resource,
                "suggestions": ["刷新资源并重新保存任务"],
            })
        if payload.parent_plan_id is not None or payload.adjustment is not None:
            raise PlanningJobError(1001, "父方案与人工调整将在后续接口接入", 422)
        algorithm_payload = _algorithm_payload(payload, revision)
        active = session.scalar(select(PlanningJob).where(
            PlanningJob.task_id == payload.task_id,
            PlanningJob.status.in_(("PENDING", "RUNNING")),
        ))
        if active is not None:
            raise PlanningJobError(2002, "该任务已有计算作业", 409, {
                "job_id": active.job_id,
                "status": active.status,
                "progress": active.progress,
                "stage": active.stage,
            })
        now = datetime.now(timezone.utc)
        job = PlanningJob(
            job_id="tsk-" + uuid.uuid4().hex[:12],
            request_id=payload.request_id,
            request_digest=digest,
            task_id=payload.task_id,
            revision_id=revision.revision_id,
            condition_version=revision.condition_version,
            resource_revision=revision.resource_revision,
            context=payload.context,
            parent_plan_id=payload.parent_plan_id,
            adjustment=payload.adjustment,
            status="PENDING",
            progress=0.0,
            stage="排队中",
            error=None,
            created_at=now,
            updated_at=now,
        )
        session.add(job)
        session.flush()
        return job, revision, True, algorithm_payload


def submit_planning_job(payload: PlanningJobSubmitRequest,
                        factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    factory = factory or get_session_factory()
    digest = _digest(payload)
    try:
        job, revision, created, algorithm_payload = _reserve(factory, payload, digest)
    except IntegrityError:
        with factory() as session:
            replay = _existing_by_request(session, payload.request_id, digest)
            if replay is None:
                raise
            return _dto(replay[0], replay[1])
    if not created:
        return _dto(job, revision)
    try:
        response = planning_w4.submit_sr4(
            algorithm_payload or {},
            job_id=job.job_id,
            on_update=lambda state: _update_job(factory, job.job_id, state),
        )
        if response.get("code") != 0 or response.get("data", {}).get("task_id") != job.job_id:
            raise RuntimeError(response.get("message") or "SR4 作业启动失败")
    except Exception as exc:
        _update_job(factory, job.job_id, {
            "status": "FAILED", "progress": 1.0,
            "stage": "启动失败", "error": f"{type(exc).__name__}: {exc}",
        })
        if isinstance(exc, PlanningJobError):
            raise
        raise PlanningJobError(5001, "SR4 作业启动失败", 500) from exc
    with factory() as session:
        current = session.get(PlanningJob, job.job_id)
        current_revision = session.get(PlanningTaskRevision, job.revision_id)
        if current is None or current_revision is None:
            raise PlanningJobError(5001, "规划作业持久化失败", 500)
        return _dto(current, current_revision)


def query_planning_job(job_id: str, task_id: str | None,
                       factory: sessionmaker[Session] | None = None
                       ) -> dict[str, Any] | None:
    """查询版本化 SR4 作业；非数据库作业返回 ``None`` 供旧接口回退。"""
    factory = factory or get_session_factory()
    with factory() as session, session.begin():
        job = session.get(PlanningJob, job_id)
        if job is None:
            return None
        if task_id is not None and job.task_id != task_id:
            raise PlanningJobError(2001, "规划作业不存在", 404)
        revision = session.get(PlanningTaskRevision, job.revision_id)
        if revision is None:
            raise PlanningJobError(5001, "规划作业引用的输入版本不存在", 500)

        runtime = planning_w3.get_task_record(job_id)
        if runtime:
            job.status = str(runtime.get("status", job.status))
            job.progress = float(runtime.get("progress", job.progress))
            job.stage = str(runtime.get("stage", job.stage))
            job.error = runtime.get("error")
            job.updated_at = datetime.now(timezone.utc)
        elif job.status in {"PENDING", "RUNNING"}:
            # 线程任务不能跨服务进程恢复，避免重启后永久显示“计算中”。
            job.status = "FAILED"
            job.progress = 1.0
            job.stage = "运行任务已丢失"
            job.error = "服务重启后运行中的 SR4 作业无法恢复，请重新提交"
            job.updated_at = datetime.now(timezone.utc)
        data = _dto(job, revision)
        data["saved_plan_id"] = session.scalar(select(PlanningPlan.plan_id).where(
            PlanningPlan.job_id == job_id
        ))
        request_id = job.request_id
        status = job.status

    if status == "SUCCESS":
        result_ref = (runtime or {}).get("result") or {}
        solution_id = result_ref.get("solution_id")
        if not solution_id:
            raise PlanningJobError(5001, "SR4 作业完成但未返回方案编号", 500)
        plan_response = planning_w4.get_plan(str(solution_id))
        plan = plan_response.get("data") if plan_response.get("code") == 0 else None
        if not isinstance(plan, dict):
            raise PlanningJobError(5001, "SR4 作业对应的方案文件不存在", 500)
        try:
            result, outcome = planning_result_adapter.adapt_planning_result(
                plan, data["input"]
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise PlanningJobError(
                5001, "SR4 方案结果不符合前端数据契约", 500
            ) from exc
        data["result"] = result
        data["outcome"] = outcome
        return {
            "code": outcome["code"],
            "message": outcome["message"],
            "data": data,
            "request_id": request_id,
        }
    if status in {"PENDING", "RUNNING"}:
        return {
            "code": 2002,
            "message": "计算中",
            "data": data,
            "request_id": request_id,
        }
    return {
        "code": 0,
        "message": "计算已取消" if status == "CANCELLED" else "计算失败",
        "data": data,
        "request_id": request_id,
    }
