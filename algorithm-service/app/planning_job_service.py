"""绑定数据库输入版本并提交真实 SR4 异步作业。"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from . import (frontend_integration, planning_adjustment_service,
               planning_result_adapter, planning_w3, planning_w4)
from . import resource_dataset_service as resource_dataset
from . import task_input_service
from .database import get_session_factory
from .planning_job_models import PlanningJob, PlanningJobCancellation
from .planning_plan_models import PlanningPlan
from .planning_job_schemas import PlanningJobCancelRequest, PlanningJobSubmitRequest
from .task_input_models import PlanningTask, PlanningTaskRevision
from .task_input_schemas import TaskListQuery


class PlanningJobError(ValueError):
    """可直接映射为接口错误的规划作业异常。"""

    def __init__(self, code: int, message: str, status: int,
                 data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


_SUBMIT_LOCK = threading.RLock()
# 本进程已派发但尚未确认终态的子作业，禁止被启动恢复入口接管。
_INTERFERENCE_DISPATCHES: set[str] = set()
_FINAL_STATES = {"SUCCESS", "FAILED", "CANCELLED"}
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


def list_planning_jobs(query: TaskListQuery,
                       factory: sessionmaker[Session] | None = None) -> dict[str, Any]:
    """按冻结输入版本读取已持久化的规划作业摘要。"""
    factory = factory or get_session_factory()
    base = select(PlanningJob, PlanningTaskRevision).join(
        PlanningTaskRevision,
        PlanningJob.revision_id == PlanningTaskRevision.revision_id,
    ).where(PlanningJob.context == "planning")
    term = query.search.strip()
    if term:
        escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        base = base.where(or_(
            PlanningJob.job_id.ilike(pattern, escape="\\"),
            PlanningJob.task_id.ilike(pattern, escape="\\"),
            PlanningTaskRevision.input_snapshot["name"].as_string().ilike(
                pattern, escape="\\"),
        ))
    with factory() as session:
        total = session.scalar(select(func.count()).select_from(base.subquery())) or 0
        rows = session.execute(base.order_by(
            PlanningJob.created_at.desc(), PlanningJob.job_id.desc(),
        ).offset((query.page - 1) * query.page_size).limit(query.page_size)).all()
        items = []
        for job, revision in rows:
            created_at = job.created_at
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
            items.append({
                "job_id": job.job_id, "task_id": job.task_id,
                "name": revision.input_snapshot["name"],
                "created_at": created_at.isoformat(), "status": job.status,
            })
    return {"items": items, "total": total, "page": query.page,
            "page_size": query.page_size, "data_origin": "SYNTHETIC_INTEGRATION"}


def _digest(payload: PlanningJobSubmitRequest | PlanningJobCancelRequest) -> str:
    body = payload.model_dump(mode="json", exclude_none=False)
    # 可选干扰字段缺省时保持既有手工请求摘要，升级不能破坏旧幂等键。
    if body.get("adjustment") is not None:
        for key in ("interference_origin", "interference"):
            if body["adjustment"].get(key) is None:
                body["adjustment"].pop(key, None)
    raw = json.dumps(body, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _local_context(*, actor_id, local_owner, audit_context):
    if type(local_owner) is not bool:
        raise PlanningJobError(5001, "规划幂等主体范围接线无效", 503)
    if audit_context is None:
        if local_owner:
            raise PlanningJobError(5001, "LOCAL规划缺少真实业务上下文接线", 503)
        return None
    try:
        from .local_business_context import LocalBusinessContext
    except ImportError as exc:
        raise PlanningJobError(5001, "LOCAL规划业务上下文尚未集成", 503) from exc
    if type(audit_context) is not LocalBusinessContext:
        raise PlanningJobError(5001, "LOCAL规划业务上下文与账号接线不一致", 503)
    try:
        account_id = audit_context.actor.account_id
    except AttributeError as exc:
        raise PlanningJobError(5001, "LOCAL规划业务上下文不完整", 503) from exc
    if actor_id is not None and actor_id != account_id:
        raise PlanningJobError(5001, "LOCAL规划业务上下文与账号接线不一致", 503)
    return audit_context


def _context_call(function, *args, **kwargs):
    from .system_management_schemas import SystemManagementError
    try:
        return function(*args, **kwargs)
    except SystemManagementError as exc:
        raise PlanningJobError(exc.code, str(exc), exc.status, exc.data) from exc


def _owner_digest(body_digest: str, *, operation: str, audit_context=None) -> str:
    if audit_context is None:
        return body_digest
    return _context_call(audit_context.digest, body_digest, operation=operation)


def _cancel_digest(job_id: str, payload: PlanningJobCancelRequest, *, audit_context=None) -> str:
    body_digest = hashlib.sha256(f"{job_id}:{_digest(payload)}".encode("utf-8")).hexdigest()
    return _owner_digest(body_digest, operation="planning.cancel", audit_context=audit_context)


def _prepare_context(audit_context, session):
    if audit_context is not None:
        return _context_call(audit_context.prepare, session, "planning.execute")
    return None


def _require_owner(audit_context, session, operation, request_id, object_id):
    if audit_context is not None:
        _context_call(audit_context.require_owner, session, operation=operation,
            request_id=request_id, object_id=object_id)


def _append_owner(audit_context, session, prepared, operation, request_id, job):
    if audit_context is not None:
        unchanged = operation == "planning.cancel" and job.status in _FINAL_STATES
        _context_call(audit_context.append_owner, session, prepared, operation=operation,
            request_id=request_id, object_id=job.job_id,
            changed=not unchanged, summary="作业已处于终态，取消回执已保存" if unchanged else None,
            changes={"context": "planning", "task_id": job.task_id,
                     "revision_id": job.revision_id, "input_version": job.revision_id,
                     "resource_revision": job.resource_revision, "job_status": job.status})


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
    data = {
        "job_id": job.job_id,
        "task_id": job.task_id,
        "revision": revision.revision_id,
        "input_version": revision.revision_id,
        "condition_version": revision.condition_version,
        "resource_revision": revision.resource_revision,
        "input": revision.input_snapshot,
        "parent_plan_id": job.parent_plan_id,
        "status": job.status,
        "stopping": job.status in {"FAILED", "CANCELLED"} and planning_w3.task_worker_active(job.job_id),
        "progress": progress,
        "phases": _phases(progress),
        "result": None,
        "outcome": None,
        "error": job.error,
        "expired": False,
        "source_changed": revision.resource_revision != frontend_integration.resource_revision(),
        "saved_plan_id": None,
    }
    if job.adjustment is not None:
        data["adjustment"] = job.adjustment
    return data


def _validate_supported_input(input_data: dict[str, Any]) -> None:
    from .task_input_schemas import DeploymentConstraints, DeploymentSolve
    from pydantic import ValidationError

    for key, model in (("deploymentSolve", DeploymentSolve),
                       ("deploymentConstraints", DeploymentConstraints)):
        if input_data.get(key) is not None:
            try:
                model.model_validate(input_data[key])
            except ValidationError as exc:
                raise PlanningJobError(1001, f"部署条件无效：{key}", 422,
                    [{"objectId": "task", "field": key, "message": str(exc)}]) from exc


def _validate_resources(input_data: dict[str, Any], revision: str) -> None:
    for node_id in input_data["stationIds"]:
        try:
            frontend_integration.resource_object("node", node_id, revision)
        except KeyError as exc:
            raise PlanningJobError(1002, f"参与节点不存在：{node_id}", 404) from exc
    issues = task_input_service.availability_issues(input_data)
    if issues:
        raise PlanningJobError(1001, "任务引用了不可用设备", 422, issues)
    preset_id = input_data["presetId"]
    if preset_id not in _PRESET_MAP:
        raise PlanningJobError(1003, f"规划预设不存在：{preset_id}", 422)
    frequencies = frontend_integration.planning_frequency_catalog()["data"]["items"]
    if input_data["frequencyId"] not in {row["id"] for row in frequencies}:
        raise PlanningJobError(1002, "频率资源不存在或已变化", 409)


def _algorithm_payload(payload: PlanningJobSubmitRequest,
                       revision: PlanningTaskRevision, *, frozen_rows=None) -> dict[str, Any]:
    input_data = revision.input_snapshot
    _validate_supported_input(input_data)
    if frozen_rows is None:
        _validate_resources(input_data, revision.resource_revision)
    # 在提交线程中冻结输入，工作线程不得再查询“当前”资源或回退文件。
    if frozen_rows is None:
        frozen_rows = (resource_dataset.algorithm_tables(revision.resource_revision)
                       if resource_dataset.database_mode() else None)
    csv_compatibility = frozen_rows is None
    if frozen_rows is None:
        # CSV兼容入口同样冻结整套表；工作线程不能混入后续磁盘变更。
        frozen_rows = {name: planning_w4._load(name) for name in (
            "node.csv", "device.csv", "device_model.csv", "antenna_model.csv",
            "comm_demand.csv", "frequency_resource.csv", "interference_source.csv",
            "link_metric.csv", "candidate_site.csv")}
    frequency_constraints = input_data.get("frequencyConstraints")
    if frequency_constraints is not None:
        from .task_input_schemas import FrequencyConstraints
        frequency_constraints = FrequencyConstraints.model_validate(frequency_constraints).model_dump(mode="json")
        if csv_compatibility:
            raise PlanningJobError(1001, "高级频率条件要求数据库冻结资源，不能回退CSV", 422)
        by_id = {row["freq_id"]: row for row in frozen_rows["frequency_resource.csv"]}
        for index, entry in enumerate(frequency_constraints["filters"]):
            for freq_id in entry["excludeFreqIds"]:
                field = f"input.frequencyConstraints.filters[{index}].excludeFreqIds"
                if freq_id not in by_id:
                    raise PlanningJobError(1002, "排除频点不存在于冻结资源", 404,
                        [{"objectId": freq_id, "field": field, "message": "未知频点编号"}])
                if by_id[freq_id]["device_class"] != entry["deviceClass"]:
                    raise PlanningJobError(1001, "排除频点类别与筛选类别不一致", 422,
                        [{"objectId": freq_id, "field": field, "message": "频段类别不一致"}])
    existing_demands = {row["demand_id"]: row
                        for row in (frozen_rows["comm_demand.csv"] if frozen_rows is not None
                                    else planning_w4._load("comm_demand.csv"))}
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
            "source_device_id": row.get("sourceDeviceId") or "",
            "target_device_id": row.get("targetDeviceId") or "",
        })
    constraints = input_data["constraints"]
    algorithm_payload = {
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
    if frozen_rows is not None:
        algorithm_payload["resource_rows"] = deepcopy(frozen_rows)
        algorithm_payload["resource_rows"]["planning_input"] = {
            "schema_version": 1,
            "bbox": deepcopy(input_data["bbox"]),
            "stationIds": list(input_data["stationIds"]),
            "deploymentConstraints": deepcopy(input_data.get("deploymentConstraints")),
            "deploymentSolve": deepcopy(input_data.get("deploymentSolve")),
        }
        # W4既有转交完整资源容器；此内部元数据不替换任何CSV原表。
        algorithm_payload["resource_rows"]["frequency_constraints"] = (None if frequency_constraints is None else {
            "filters": [{"device_class": row["deviceClass"], "range_khz": row["rangeKhz"],
                         "exclude_freq_ids": list(row["excludeFreqIds"])} for row in frequency_constraints["filters"]]})
        algorithm_payload["resource_revision"] = revision.resource_revision
    return algorithm_payload


def _update_job(factory: sessionmaker[Session], job_id: str,
                state: dict[str, Any]) -> None:
    with _SUBMIT_LOCK, factory() as session, session.begin():
        job = session.scalar(select(PlanningJob).where(
            PlanningJob.job_id == job_id).with_for_update())
        if job is None:
            return
        if job.status in _FINAL_STATES:
            if state.get("status") == job.status:
                _finish_cancellations(session, job)
            return
        _apply_runtime_state(job, state)
        _finish_cancellations(session, job)


def _finish_cancellations(session, job):
    if job.status in _FINAL_STATES:
        for receipt in session.scalars(select(PlanningJobCancellation).where(
                PlanningJobCancellation.job_id == job.job_id,
                PlanningJobCancellation.outcome_status == "CANCEL_REQUESTED")):
            receipt.outcome_status = job.status


def _apply_runtime_state(job: PlanningJob, state: dict[str, Any]) -> None:
    """只让未完成作业接受运行时回调，终态不可被晚到消息改写。"""
    if job.status in _FINAL_STATES:
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
             digest: str, *, audit_context=None) -> tuple[
                 PlanningJob, PlanningTaskRevision, bool, dict[str, Any] | None
             ]:
    with _SUBMIT_LOCK, factory() as session, session.begin():
        if session.get_bind().dialect.name == "sqlite":
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        prepared = _prepare_context(audit_context, session)
        replay = _existing_by_request(session, payload.request_id, digest)
        if replay is not None:
            _require_owner(audit_context, session, "planning.submit", payload.request_id, replay[0].job_id)
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
        if (payload.parent_plan_id is None) != (payload.adjustment is None):
            raise PlanningJobError(1001, "父方案编号与人工调整必须同时提供", 422)
        # 超时和取消先反馈终态，协作退出中的线程仍占用同一任务的计算槽。
        # 在资源快照准备前检查，重复点击不能反复触发昂贵的输入准备。
        active = session.scalar(select(PlanningJob).where(
            PlanningJob.task_id == payload.task_id,
            or_(PlanningJob.status.in_(("PENDING", "RUNNING")),
                PlanningJob.job_id.in_(planning_w3.active_worker_ids())),
        ))
        if active is not None:
            stopping = active.status in _FINAL_STATES
            raise PlanningJobError(2002, "上一规划计算正在停止，请稍后重试" if stopping else "该任务已有计算作业", 409, {
                "job_id": active.job_id,
                "status": active.status,
                "progress": active.progress,
                "stage": "后台计算正在停止" if stopping else active.stage,
                "stopping": stopping,
            })
        algorithm_payload = _algorithm_payload(payload, revision)
        if payload.parent_plan_id is not None and payload.adjustment is not None:
            parent = session.get(PlanningPlan, payload.parent_plan_id)
            try:
                snapshot, device_refs = planning_adjustment_service.prepare_parent(
                    parent, revision, payload.adjustment
                )
            except planning_adjustment_service.AdjustmentError as exc:
                raise PlanningJobError(exc.code, str(exc), exc.status, exc.data) from exc
            algorithm_payload["parent_snapshot"] = snapshot
            algorithm_payload["manual_device_refs"] = device_refs
            algorithm_payload["adjustment"] = payload.adjustment.model_dump(
                mode="json", exclude_unset=True
            )
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
            adjustment=(payload.adjustment.model_dump(mode="json", exclude_unset=True)
                        if payload.adjustment is not None else None),
            status="PENDING",
            progress=0.0,
            stage="排队中",
            error=None,
            created_at=now,
            updated_at=now,
        )
        session.add(job)
        session.flush()
        _append_owner(audit_context, session, prepared, "planning.submit", payload.request_id, job)
        return job, revision, True, algorithm_payload


def submit_planning_job(payload: PlanningJobSubmitRequest,
                        factory: sessionmaker[Session] | None = None, *,
                        actor_id: str | None = None, local_owner: bool = False,
                        audit_context=None) -> dict[str, Any]:
    context = _local_context(actor_id=actor_id, local_owner=local_owner, audit_context=audit_context)
    if payload.adjustment is not None and payload.adjustment.interference_origin is not None:
        raise PlanningJobError(1001, "干扰绑定仅允许已受理工作台的服务端专用入口", 422)
    digest = _owner_digest(_digest(payload), operation="planning.submit", audit_context=context)
    factory = factory or get_session_factory()
    try:
        job, revision, created, algorithm_payload = _reserve(factory, payload, digest, audit_context=context)
    except IntegrityError:
        with factory() as session, session.begin():
            _prepare_context(context, session)
            replay = _existing_by_request(session, payload.request_id, digest)
            if replay is None:
                raise
            _require_owner(context, session, "planning.submit", payload.request_id, replay[0].job_id)
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


def validate_interference_runtime(factory, runtime_root=None):
    """检查真实解析目录和数据库位置，不能仅信任启动环境变量。"""
    from pathlib import Path
    from .interference_analysis_engine import runtime_path
    root = runtime_path(runtime_root)
    base = runtime_path()
    with factory() as session:
        bind = session.get_bind()
        database = Path(bind.url.database or "").resolve()
        if (bind.dialect.name != "sqlite" or database != base.parent / "r2.sqlite"
                and not database.is_relative_to(base.parent / "tmp")):
            raise PlanningJobError(5001, "干扰重算仅允许本树r2或tmp测试库", 503)
    if any(not Path(path).resolve().is_relative_to(root)
           for path in (planning_w3.TASK_DIR, planning_w4.PLAN_DIR)):
        raise PlanningJobError(5001, "算法任务/方案实际目录不在本树指定r2根内", 503)
    return root


def _update_interference_job(factory, job_id, state):
    """只有算法回调到达检查点才确认取消，保留普通手工作业行为。"""
    with _SUBMIT_LOCK, factory() as session, session.begin():
        job = session.get(PlanningJob, job_id)
        if job is None:
            return
        if job.status in _FINAL_STATES:
            _INTERFERENCE_DISPATCHES.discard(job_id)
            if state.get("status") == job.status:
                for receipt in session.scalars(select(PlanningJobCancellation).where(
                        PlanningJobCancellation.job_id == job_id,
                        PlanningJobCancellation.outcome_status == "CANCEL_REQUESTED")):
                    receipt.outcome_status = job.status
            return
        if state.get("status") not in _FINAL_STATES and state.get("progress", 0) >= .95:
            expected = job.adjustment["interference"]["terrain_fingerprint"]
            if planning_adjustment_service.terrain_fingerprint() != expected:
                raise ValueError("干扰重算期间DEM来源变化，结果未接受")
        if state.get("status") in _FINAL_STATES:
            for receipt in session.scalars(select(PlanningJobCancellation).where(
                    PlanningJobCancellation.job_id == job_id,
                    PlanningJobCancellation.outcome_status == "CANCEL_REQUESTED")):
                receipt.outcome_status = state["status"]
        _apply_runtime_state(job, state)
        if job.status in _FINAL_STATES:
            _INTERFERENCE_DISPATCHES.discard(job_id)


def submit_interference_replan(request: dict[str, Any], factory=None, *, runtime_root=None) -> str:
    """服务端专用派发：已受理Adoption、子作业和关联在同一数据库中核验。"""
    from .interference_analysis_engine import digest as canonical_digest
    from .interference_replan_service import InterferenceReplanService
    from .interference_workbench_service import InterferenceWorkbenchService
    from .interference_workbench_models import InterferenceWorkbenchAdoption
    from .resource_dataset_models import ResourceDatasetVersion
    factory = factory or get_session_factory()
    root = validate_interference_runtime(factory, runtime_root)
    algorithm_payload = None
    with _SUBMIT_LOCK, factory() as session, session.begin():
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        adoption = session.get(InterferenceWorkbenchAdoption, request["adoption_id"])
        if adoption is None:
            raise PlanningJobError(2001, "没有已受理的干扰采纳", 404)
        run = InterferenceWorkbenchService._run(session, adoption.run_id, adoption.task_id)
        origin = InterferenceReplanService.origin(adoption)
        if (request["planning_request_id"] != adoption.planning_request_id
                or request["task_id"] != adoption.task_id or request["actor_id"] != adoption.actor_id
                or request["interference_origin"] != origin or request["source"] != run.source_snapshot
                or request["change_set"] != adoption.change_set
                or canonical_digest(adoption.change_set) != adoption.change_hash
                or adoption.source_hash != run.source_hash or run.state != "SUCCESS"):
            raise PlanningJobError(1203, "干扰重算绑定与已受理来源不一致", 409)
        measure = next((row for row in run.result_snapshot["measures"]
                        if row["measure_id"] == adoption.measure_id), None)
        if measure is None or measure["change_set"] != adoption.change_set or not measure["available"]:
            raise PlanningJobError(1203, "采纳措施不是该冻结分析的可用项", 409)
        job_digest = canonical_digest({"operation": "INTERFERENCE_REPLAN", "origin": origin,
            "task_id": adoption.task_id, "planning_request_id": adoption.planning_request_id})
        replay = _existing_by_request(session, adoption.planning_request_id, job_digest)
        if replay is not None:
            job = replay[0]
            if job.adjustment.get("interference_origin") != origin:
                raise PlanningJobError(5002, "已有子作业来源校验失败", 503)
        else:
            if adoption.state not in ("PENDING", "RUNNING", "CANCEL_REQUESTED"):
                raise PlanningJobError(2002, "终态采纳不能重新派发作业", 409)
            source = run.source_snapshot
            scene = source["scene"]
            frozen = scene["plan_snapshot"]
            resource = session.get(ResourceDatasetVersion, run.resource_revision)
            if resource_dataset._decode(resource) != source["resource"]:
                raise PlanningJobError(5002, "不可变资源与运行冻结内容不一致", 503)
            revision = session.get(PlanningTaskRevision, frozen["input_version"])
            parent = session.get(PlanningPlan, run.plan_id)
            if revision is None:
                raise PlanningJobError(5002, "冻结输入版本缺失", 503)
            try:
                snapshot, refs, adjustment = planning_adjustment_service.prepare_interference_parent(
                    parent, revision, source, adoption.change_set, origin, runtime_root=root)
            except planning_adjustment_service.AdjustmentError as exc:
                raise PlanningJobError(exc.code, str(exc), exc.status, exc.data) from exc
            payload = PlanningJobSubmitRequest(context="planning", request_id=adoption.planning_request_id,
                task_id=adoption.task_id, expected_revision=revision.revision_id, input_version=revision.revision_id,
                condition_version=revision.condition_version, resource_revision=revision.resource_revision,
                parent_plan_id=run.plan_id, adjustment=adjustment)
            algorithm_payload = _algorithm_payload(payload, revision, frozen_rows=deepcopy(source["resource"]["tables"]))
            algorithm_payload.update(parent_snapshot=snapshot, manual_device_refs=refs,
                adjustment=adjustment.model_dump(mode="json", exclude_unset=True),
                interference_rows=deepcopy(adjustment.interference.sources))
            active = session.scalar(select(PlanningJob.job_id).where(PlanningJob.task_id == adoption.task_id,
                PlanningJob.status.in_(("PENDING", "RUNNING"))))
            if active is not None:
                raise PlanningJobError(2002, "该任务已有其他活动规划作业", 409)
            stamp = datetime.now(timezone.utc)
            job = PlanningJob(job_id="tsk-" + uuid.uuid4().hex[:12], request_id=adoption.planning_request_id,
                request_digest=job_digest, task_id=adoption.task_id, revision_id=revision.revision_id,
                condition_version=revision.condition_version, resource_revision=run.resource_revision,
                context="planning", parent_plan_id=run.plan_id, adjustment=algorithm_payload["adjustment"],
                status="PENDING", progress=0, stage="冻结干扰重算已受理", created_at=stamp, updated_at=stamp)
            session.add(job)
            session.flush()
        if adoption.planning_job_id not in (None, job.job_id):
            raise PlanningJobError(5002, "采纳已经关联其他子作业", 503)
        if adoption.planning_job_id is None:
            adoption.planning_job_id = job.job_id
            adoption.adoption_version += 1
            adoption.updated_at = datetime.now(timezone.utc)
        job_id = job.job_id
        if algorithm_payload is not None:
            _INTERFERENCE_DISPATCHES.add(job_id)
    if algorithm_payload is not None:
        try:
            response = planning_w4.submit_sr4(algorithm_payload, job_id=job_id,
                on_update=lambda state: _update_interference_job(factory, job_id, state))
            if response.get("code") != 0 or response.get("data", {}).get("task_id") != job_id:
                raise ValueError(response.get("message") or "冻结SR4派发失败")
        except Exception as exc:
            _update_interference_job(factory, job_id, {"status": "FAILED", "progress": 1,
                "stage": "冻结重算启动失败", "error": str(exc)})
    return job_id


def recover_interrupted_interference_jobs(factory=None, *, runtime_root=None,
                                         exclusive_runtime=False) -> list[str]:
    """仅供独占启动、派发前调用；调用方须已确认旧服务进程退出。

    任务JSON中的取消标志不是算法检查点确认。未持久化终态的旧作业
    统一记为中断失败，保留原文件和稳定请求号，不重派、不伪称已取消。
    """
    if exclusive_runtime is not True:
        raise PlanningJobError(1001, "启动恢复必须显式确认独占算法运行目录", 422)
    factory = factory or get_session_factory()
    validate_interference_runtime(factory, runtime_root)
    with _SUBMIT_LOCK, factory() as session, session.begin():
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        jobs = [job for job in session.scalars(select(PlanningJob).where(
            PlanningJob.status.in_(("PENDING", "RUNNING"))).order_by(PlanningJob.job_id))
            if (job.adjustment or {}).get("interference_origin")]
        if any(job.job_id in _INTERFERENCE_DISPATCHES for job in jobs):
            raise PlanningJobError(2002, "本进程已有活动干扰子作业，不能执行启动恢复", 409)
        for job in jobs:
            _apply_runtime_state(job, {"status": "FAILED", "progress": 1,
                "stage": "服务中断，结果未接受",
                "error": "旧进程未持久化算法终态确认；不重派，不将取消请求视为检查点确认"})
            for receipt in session.scalars(select(PlanningJobCancellation).where(
                    PlanningJobCancellation.job_id == job.job_id,
                    PlanningJobCancellation.outcome_status == "CANCEL_REQUESTED")):
                receipt.outcome_status = "FAILED"
        return [job.job_id for job in jobs]


def request_interference_cancellation(job_id, payload, factory=None, *, actor_id=None,
                                      runtime_root=None, local_owner=False, audit_context=None):
    context = _local_context(actor_id=actor_id, local_owner=local_owner, audit_context=audit_context)
    raw = {"job_id": job_id, "body": payload.model_dump(), "actor_id": actor_id}
    from .interference_analysis_engine import digest
    if context is not None:
        request_digest = _cancel_digest(job_id, payload, audit_context=context)
    else:
        # 内部采纳/shutdown保留既有origin actor摘要，与公共LOCAL请求域分离。
        request_digest = digest(raw)
    factory = factory or get_session_factory()
    validate_interference_runtime(factory, runtime_root)
    with _SUBMIT_LOCK, factory() as session, session.begin():
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        prepared = _prepare_context(context, session)
        job = session.get(PlanningJob, job_id)
        if job is None or job.task_id != payload.task_id:
            raise PlanningJobError(2001, "规划作业不存在", 404)
        if not (job.adjustment or {}).get("interference_origin") or job.revision_id != payload.expected_revision:
            raise PlanningJobError(1203, "不是指定冻结干扰作业版本", 409)
        receipt = session.get(PlanningJobCancellation, payload.request_id)
        if receipt is not None and receipt.request_digest != request_digest:
            raise PlanningJobError(1204, "取消请求编号对应其他内容", 409)
        if receipt is not None:
            _require_owner(context, session, "planning.cancel", payload.request_id, receipt.job_id)
        else:
            session.add(PlanningJobCancellation(request_id=payload.request_id, request_digest=request_digest,
                job_id=job_id, task_id=job.task_id, revision_id=job.revision_id,
                outcome_status=job.status if job.status in _FINAL_STATES else "CANCEL_REQUESTED",
                created_at=datetime.now(timezone.utc)))
            session.flush()
            _append_owner(context, session, prepared, "planning.cancel", payload.request_id, job)
        cancel_runtime = job.status not in _FINAL_STATES
        if cancel_runtime:
            job.stage = "取消已请求，等待算法检查点"
    if cancel_runtime:
        planning_w3.cancel_task(job_id)


def stop_frozen_planning_jobs(factory=None, *, runtime_root=None, timeout=5.0) -> bool:
    """停止派发后用于lifespan；只等数据库检查点确认，不把请求写入当停机。"""
    factory = factory or get_session_factory()
    validate_interference_runtime(factory, runtime_root)
    deadline = time.monotonic() + max(0, timeout)
    with factory() as session:
        jobs = [job for job in session.scalars(select(PlanningJob).where(
            PlanningJob.status.in_(("PENDING", "RUNNING")))) if (job.adjustment or {}).get("interference_origin")]
    for job in jobs:
        origin = job.adjustment["interference_origin"]
        request_interference_cancellation(job.job_id, PlanningJobCancelRequest(context="planning",
            request_id="interference-shutdown-" + origin["adoption_id"], task_id=job.task_id,
            expected_revision=job.revision_id), factory, actor_id=origin["actor_id"], runtime_root=runtime_root)
    while jobs:
        with factory() as session:
            active = session.scalar(select(PlanningJob.job_id).where(
                PlanningJob.job_id.in_([job.job_id for job in jobs]), PlanningJob.status.in_(("PENDING", "RUNNING"))))
        if active is None:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(min(.05, max(0, deadline - time.monotonic())))
    return True


def cancel_planning_job(job_id: str, payload: PlanningJobCancelRequest,
                        factory: sessionmaker[Session] | None = None, *,
                        actor_id: str | None = None, local_owner: bool = False, audit_context=None
                        ) -> dict[str, Any]:
    """按作业冻结版本取消计算，并保存请求编号供重试识别。"""
    context = _local_context(actor_id=actor_id, local_owner=local_owner, audit_context=audit_context)
    digest = _cancel_digest(job_id, payload, audit_context=context)
    factory = factory or get_session_factory()
    with factory() as session, session.begin():
        _prepare_context(context, session)
        source_job = session.get(PlanningJob, job_id)
        interference_job = source_job is not None and bool((source_job.adjustment or {}).get("interference_origin"))
    if interference_job:
        request_interference_cancellation(job_id, payload, factory,
            actor_id=context.actor.account_id if context is not None else None,
            local_owner=context is not None, audit_context=context)
        result = query_planning_job(job_id, payload.task_id, factory)
        result.update(code=0, request_id=payload.request_id)
        return result
    cancel_after_commit = False
    with _SUBMIT_LOCK, factory() as session, session.begin():
        if session.get_bind().dialect.name == "sqlite":
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        prepared = _prepare_context(context, session)
        receipt = session.get(PlanningJobCancellation, payload.request_id)
        if receipt is not None:
            if receipt.request_digest != digest:
                raise PlanningJobError(1204, "同一请求编号对应不同内容", 409)
            _require_owner(context, session, "planning.cancel", payload.request_id, receipt.job_id)
        else:
            job = session.scalar(select(PlanningJob).where(
                PlanningJob.job_id == job_id).with_for_update())
            if job is None or job.task_id != payload.task_id:
                raise PlanningJobError(2001, "规划作业不存在", 404)
            # 跨进程竞争时，等待行锁后再次读取已提交的幂等回执。
            receipt = session.get(PlanningJobCancellation, payload.request_id)
            if receipt is not None:
                if receipt.request_digest != digest:
                    raise PlanningJobError(1204, "同一请求编号对应不同内容", 409)
                _require_owner(context, session, "planning.cancel", payload.request_id, receipt.job_id)
            else:
                if job.revision_id != payload.expected_revision:
                    raise PlanningJobError(1203, "作业输入版本不一致", 409, {
                        "expected": payload.expected_revision,
                        "actual": job.revision_id,
                    })
                if job.status not in _FINAL_STATES:
                    runtime = planning_w3.get_task_record(job_id)
                    if context is None:
                        if runtime.get("status") not in _FINAL_STATES:
                            runtime = planning_w3.cancel_task(job_id)
                        _apply_runtime_state(job, runtime)
                    elif (runtime or {}).get("status") in ("SUCCESS", "FAILED"):
                        _apply_runtime_state(job, runtime)
                    else:
                        job.stage = "取消已受理，等待算法检查点"
                receipt = PlanningJobCancellation(
                    request_id=payload.request_id,
                    request_digest=digest,
                    job_id=job_id,
                    task_id=job.task_id,
                    revision_id=job.revision_id,
                    outcome_status="CANCEL_REQUESTED" if context is not None and job.status not in _FINAL_STATES else job.status,
                    created_at=datetime.now(timezone.utc),
                )
                session.add(receipt)
                session.flush()
                _append_owner(context, session, prepared, "planning.cancel", payload.request_id, job)
        cancel_after_commit = context is not None and receipt.outcome_status == "CANCEL_REQUESTED"
    if cancel_after_commit:
        try:
            planning_w3.cancel_task(job_id)
        except Exception as exc:
            raise PlanningJobError(5001, "取消已受理，运行时请求待重试", 503) from exc
    result = query_planning_job(job_id, payload.task_id, factory)
    if result is None:
        raise PlanningJobError(5001, "取消作业后无法读取作业", 500)
    # 取消调用本身成功时始终返回 0，完成作业的约束结果仍保留在 data.outcome。
    result["code"] = 0
    result["request_id"] = payload.request_id
    return result


def query_planning_job(job_id: str, task_id: str | None,
                       factory: sessionmaker[Session] | None = None
                       ) -> dict[str, Any] | None:
    """查询版本化 SR4 作业；非数据库作业返回 ``None`` 供旧接口回退。"""
    factory = factory or get_session_factory()
    with _SUBMIT_LOCK, factory() as session, session.begin():
        job = session.scalar(select(PlanningJob).where(
            PlanningJob.job_id == job_id).with_for_update())
        if job is None:
            return None
        if task_id is not None and job.task_id != task_id:
            raise PlanningJobError(2001, "规划作业不存在", 404)
        revision = session.get(PlanningTaskRevision, job.revision_id)
        if revision is None:
            raise PlanningJobError(5001, "规划作业引用的输入版本不存在", 500)

        runtime = planning_w3.get_task_record(job_id)
        if runtime:
            waiting_checkpoint = session.scalar(
                select(PlanningJobCancellation.request_id).where(PlanningJobCancellation.job_id == job_id,
                    PlanningJobCancellation.outcome_status == "CANCEL_REQUESTED")) is not None
            if not (waiting_checkpoint and runtime.get("status") == "CANCELLED"):
                _apply_runtime_state(job, runtime)
        elif job.status in {"PENDING", "RUNNING"}:
            # 线程任务不能跨服务进程恢复，避免重启后永久显示“计算中”。
            job.status = "FAILED"
            job.progress = 1.0
            job.stage = "运行任务已丢失"
            job.error = "服务重启后运行中的 SR4 作业无法恢复，请重新提交"
            job.updated_at = datetime.now(timezone.utc)
        _finish_cancellations(session, job)
        data = _dto(job, revision)
        data["saved_plan_id"] = session.scalar(select(PlanningPlan.plan_id).where(
            PlanningPlan.job_id == job_id
        ))
        request_id = job.request_id
        status = job.status
        saved = session.scalar(select(PlanningPlan).where(PlanningPlan.job_id == job_id))
        saved_data = ((deepcopy(saved.result_snapshot), deepcopy(saved.outcome_snapshot))
                      if saved is not None and saved.adjustment and saved.adjustment.get("interference_origin")
                      else None)
        frozen_result_tables = None
        if status == "SUCCESS":
            from .resource_dataset_models import ResourceDatasetVersion
            try:
                frozen_result_tables = resource_dataset._decode(
                    session.get(ResourceDatasetVersion, job.resource_revision))["tables"]
            except resource_dataset.ResourceDatasetError as exc:
                raise PlanningJobError(exc.code,
                    f"SR4作业冻结资源不可读（{job.resource_revision}）：{exc}", exc.status) from exc

    if status == "SUCCESS":
        if saved_data is not None:
            data["result"], data["outcome"] = saved_data
            return {"code": data["outcome"]["code"], "message": data["outcome"]["message"],
                    "data": data, "request_id": request_id}
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
                plan, data["input"], resource_rows=frozen_result_tables)
            if data.get("adjustment") is not None:
                planning_adjustment_service.verify_adjusted_result(
                    data["adjustment"], result, raw_detail=plan.get("detail"))
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
