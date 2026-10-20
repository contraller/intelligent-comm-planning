"""SR-5 service: scenarios, asynchronous diagnosis, impact and reports."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import sys
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .database import get_session_factory
from .fault_scenario_models import FaultScenario, FaultScenarioVersion
from .fault_submission_models import FaultTaskSubmission
from .planning_w3 import _spawn, get_task_record, CODE_OK, CODE_TASK_NOT_FOUND
from .fault_plan_source import FaultPlanSourceError, load_plan_source

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from diagnosis.sr5 import ALLOWED_OBJECTS, FAULT_TYPES, FaultEngine, FaultInputError  # noqa: E402

_ENGINE: FaultEngine | None = None
_SCENARIOS: dict[str, dict[str, Any]] | None = None
_SLOCK = threading.RLock()
_SUBMISSION_LOCK = threading.RLock()
STORE_PATH = Path(os.environ.get("SR5_STORE_PATH", ROOT / "data" / "runtime" / "fault_scenarios.json"))
REPORT_DIR = Path(os.environ.get("SR5_REPORT_DIR", ROOT / "data" / "runtime" / "reports"))


def _engine() -> FaultEngine:
    global _ENGINE
    if _ENGINE is None:
        with _SLOCK:
            if _ENGINE is None:
                _ENGINE = FaultEngine()
    return _ENGINE


def _scenarios() -> dict[str, dict[str, Any]]:
    global _SCENARIOS
    if _SCENARIOS is None:
        with _SLOCK:
            if _SCENARIOS is None:
                if STORE_PATH.exists():
                    with STORE_PATH.open(encoding="utf-8") as handle:
                        seeds = {s["scenario_id"]: s for s in json.load(handle)}
                else:
                    seeds = {s["scenario_id"]: s for s in _engine().default_scenarios}
                _SCENARIOS = seeds
    return _SCENARIOS


def _save_scenarios() -> None:
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(list(_scenarios().values()), ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STORE_PATH)


def _ok(data):
    return {"code": CODE_OK, "message": "success", "data": data}


def _bad(exc: FaultInputError):
    return {"code": exc.code, "message": str(exc), "data": exc.detail}


def _submission_digest(payload):
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _request_key(payload):
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 120:
        raise FaultPlanSourceError(1001, "正式分析须提供长度不超过 120 的 request_id", 422)
    if payload.get("callback_url") not in (None, ""):
        raise FaultPlanSourceError(1001, "callback_url 尚未支持，请轮询任务", 422)
    return request_id, _submission_digest(payload)


def _matching_submission(session, request_id, digest, kind):
    row = session.get(FaultTaskSubmission, request_id)
    if row is not None and (row.request_digest != digest or row.kind != kind):
        raise FaultPlanSourceError(1204, "同一请求编号对应不同内容", 409)
    return row


def _replay_submission(payload, kind):
    request_id, digest = _request_key(payload)
    with get_session_factory()() as session:
        row = _matching_submission(session, request_id, digest, kind)
    if row is None:
        return None
    return _ok({"task_id": row.algorithm_task_id, "estimated_sec": 5,
                "request_id": request_id, "replayed": True})


def _reserve_submission(payload, kind, task_id, plan_id, scenario_id,
                        version_id, diagnose_task_id=None):
    request_id, digest = _request_key(payload)
    with _SUBMISSION_LOCK:
        try:
            with get_session_factory().begin() as session:
                row = _matching_submission(session, request_id, digest, kind)
                if row is not None:
                    return row.algorithm_task_id, False
                algorithm_task_id = "tsk-" + uuid.uuid4().hex[:12]
                session.add(FaultTaskSubmission(
                    request_id=request_id, request_digest=digest, kind=kind,
                    algorithm_task_id=algorithm_task_id, task_id=task_id,
                    plan_id=plan_id, scenario_id=scenario_id,
                    scenario_version_id=version_id,
                    diagnose_task_id=diagnose_task_id,
                    submitted_at=datetime.now(timezone.utc)))
            return algorithm_task_id, True
        except IntegrityError:
            with get_session_factory()() as session:
                row = _matching_submission(session, request_id, digest, kind)
                if row is None:
                    raise
                return row.algorithm_task_id, False


def _spawn_formal(kind, payload, work, *, task_id, plan_id, scenario_id,
                  version_id, diagnose_task_id=None):
    algorithm_task_id, created = _reserve_submission(
        payload, kind, task_id, plan_id, scenario_id, version_id, diagnose_task_id)
    if created:
        result = _spawn(kind, payload, work, task_id=algorithm_task_id)
    else:
        result = _ok({"task_id": algorithm_task_id, "estimated_sec": 5})
    if result["code"] == CODE_OK:
        result["data"].update(request_id=payload["request_id"], replayed=not created)
    return result


def _formal_source(payload):
    if payload.get("context") != "planning":
        raise FaultPlanSourceError(1001, "正式场景须显式设置 context=planning", 422)
    return load_plan_source(payload.get("task_id"), payload.get("plan_id"))


def _formal_scenario_mode(payload):
    context = payload.get("context") if isinstance(payload, dict) else None
    if context not in (None, "demo", "planning"):
        raise FaultPlanSourceError(1001, "context 只能为 planning 或 demo", 422)
    if context != "planning" and isinstance(payload, dict) and any(
        payload.get(key) is not None for key in ("task_id", "plan_id")
    ):
        raise FaultPlanSourceError(1001, "正式场景须显式设置 context=planning", 422)
    return context == "planning"


def _formal_scenario_query(context, task_id):
    if context not in (None, "demo", "planning") or (context != "planning" and task_id is not None):
        raise FaultPlanSourceError(1001, "正式场景查询须显式设置 context=planning", 422)
    return context == "planning"


def _formal_snapshot(payload, source):
    snapshot = {"scenario_name": payload.get("scenario_name"),
                "faults": payload.get("faults")}
    if "description" in payload:
        snapshot["description"] = payload["description"]
    _engine().for_network(source["network"]).validate(snapshot)
    return deepcopy(snapshot)


def _version_dto(scenario, version):
    return {"scenario_id": scenario.scenario_id, "task_id": scenario.task_id,
            "archived": scenario.archived, "version_id": version.version_id,
            "version_no": version.version_no, "plan_id": version.plan_id,
            "plan_revision": version.plan_revision,
            "resource_revision": version.resource_revision,
            "saved_at": version.saved_at.isoformat(), **deepcopy(version.snapshot)}


def _formal_record(session, scenario_id, task_id):
    if not isinstance(task_id, str) or not task_id:
        raise FaultPlanSourceError(1001, "task_id 必填", 422)
    scenario = session.get(FaultScenario, scenario_id)
    if scenario is None or scenario.task_id != task_id:
        raise FaultPlanSourceError(1002, "故障场景不存在或不属于该任务", 404)
    return scenario


def _latest_version(session, scenario_id):
    return session.scalars(
        select(FaultScenarioVersion).where(FaultScenarioVersion.scenario_id == scenario_id)
        .order_by(FaultScenarioVersion.version_no.desc()).limit(1)
    ).one()


def _new_version(session, scenario, source, snapshot, version_no):
    meta = source["meta"]
    version = FaultScenarioVersion(
        version_id="FSV-" + uuid.uuid4().hex[:16].upper(),
        scenario_id=scenario.scenario_id, version_no=version_no,
        plan_id=meta["plan_id"], plan_revision=meta["revision"],
        resource_revision=meta["resource_revision"], snapshot=snapshot,
        saved_at=datetime.now(timezone.utc))
    session.add(version)
    return version


def validate_scenario(payload):
    try:
        if _formal_scenario_mode(payload):
            source = _formal_source(payload)
            snapshot = _formal_snapshot(payload, source)
            return _ok({"valid": True, "fault_count": len(snapshot["faults"]),
                        "plan_id": source["meta"]["plan_id"]})
        return _ok(_engine().validate(payload or {}))
    except FaultInputError as exc:
        return _bad(exc)


def list_scenarios(context=None, task_id=None, include_archived=False):
    if _formal_scenario_query(context, task_id):
        if not isinstance(task_id, str) or not task_id:
            raise FaultPlanSourceError(1001, "task_id 必填", 422)
        with get_session_factory()() as session:
            scenarios = session.scalars(select(FaultScenario).where(
                FaultScenario.task_id == task_id).order_by(FaultScenario.created_at)).all()
            items = [_version_dto(row, _latest_version(session, row.scenario_id))
                     for row in scenarios if include_archived or not row.archived]
        return _ok({"total": len(items), "items": items})
    with _SLOCK:
        rows = sorted(_scenarios().values(), key=lambda s: s["scenario_id"])
        return _ok({"total": len(rows), "items": rows})


def get_scenario(sid, context=None, task_id=None, version_id=None):
    if _formal_scenario_query(context, task_id):
        with get_session_factory()() as session:
            scenario = _formal_record(session, sid, task_id)
            version = session.get(FaultScenarioVersion, version_id) if version_id else _latest_version(session, sid)
            if version is None or version.scenario_id != sid:
                raise FaultPlanSourceError(1002, "场景版本不存在", 404)
            return _ok(_version_dto(scenario, version))
    with _SLOCK:
        row = _scenarios().get(sid)
        return _ok(row) if row else {"code": 1002, "message": "故障场景不存在", "data": None}


def create_scenario(payload):
    if _formal_scenario_mode(payload):
        source = _formal_source(payload)
        try:
            snapshot = _formal_snapshot(payload, source)
        except FaultInputError as exc:
            return _bad(exc)
        now = datetime.now(timezone.utc)
        with get_session_factory().begin() as session:
            scenario = FaultScenario(scenario_id="FS-" + uuid.uuid4().hex[:16].upper(),
                                     task_id=source["meta"]["task_id"], archived=False,
                                     created_at=now, updated_at=now)
            session.add(scenario)
            version = _new_version(session, scenario, source, snapshot, 1)
            data = _version_dto(scenario, version)
        return _ok(data)
    try:
        _engine().validate(payload or {})
    except FaultInputError as exc:
        return _bad(exc)
    with _SLOCK:
        sid = "FS-" + uuid.uuid4().hex[:10].upper()
        row = dict(payload, scenario_id=sid, create_time=datetime.now(timezone.utc).isoformat())
        _scenarios()[sid] = row
        _save_scenarios()
        return _ok(row)


def update_scenario(sid, payload):
    if _formal_scenario_mode(payload):
        source = _formal_source(payload)
        try:
            snapshot = _formal_snapshot(payload, source)
        except FaultInputError as exc:
            return _bad(exc)
        with get_session_factory().begin() as session:
            scenario = _formal_record(session, sid, source["meta"]["task_id"])
            if scenario.archived:
                raise FaultPlanSourceError(1203, "已归档场景不能修改，请先恢复", 409)
            version = _new_version(session, scenario, source, snapshot,
                                   _latest_version(session, sid).version_no + 1)
            scenario.updated_at = version.saved_at
            data = _version_dto(scenario, version)
        return _ok(data)
    with _SLOCK:
        if sid not in _scenarios():
            return {"code": 1002, "message": "故障场景不存在", "data": None}
        try:
            _engine().validate(payload or {})
        except FaultInputError as exc:
            return _bad(exc)
        row = dict(payload, scenario_id=sid, create_time=_scenarios()[sid].get("create_time"),
                   update_time=datetime.now(timezone.utc).isoformat())
        _scenarios()[sid] = row
        _save_scenarios()
        return _ok(row)


def archive_scenario(sid, payload):
    if not isinstance(payload.get("archived"), bool):
        raise FaultPlanSourceError(1001, "archived 必须为布尔值", 422)
    with get_session_factory().begin() as session:
        scenario = _formal_record(session, sid, payload.get("task_id"))
        scenario.archived = payload["archived"]
        scenario.updated_at = datetime.now(timezone.utc)
        data = _version_dto(scenario, _latest_version(session, sid))
    return _ok(data)


def delete_scenario(sid, context=None, task_id=None):
    if _formal_scenario_query(context, task_id):
        data = archive_scenario(sid, {"task_id": task_id, "archived": True})["data"]
        return _ok({"scenario_id": sid, "archived": True,
                    "version_id": data["version_id"]})
    with _SLOCK:
        if sid not in _scenarios():
            return {"code": 1002, "message": "故障场景不存在", "data": None}
        del _scenarios()[sid]
        _save_scenarios()
        return _ok({"scenario_id": sid, "deleted": True})


def import_scenarios(payload):
    """Accept a JSON array or CSV text; reject the entire batch on any bad row."""
    if _formal_scenario_mode(payload):
        source = _formal_source(payload)
        scenarios = payload.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios:
            return _bad(FaultInputError("scenarios 必须是非空列表"))
        try:
            snapshots = [_formal_snapshot(row, source) for row in scenarios]
        except (AttributeError, FaultInputError) as exc:
            return _bad(exc if isinstance(exc, FaultInputError) else FaultInputError("场景行必须是对象"))
        now = datetime.now(timezone.utc)
        with get_session_factory().begin() as session:
            rows = []
            for snapshot in snapshots:
                scenario = FaultScenario(scenario_id="FS-" + uuid.uuid4().hex[:16].upper(),
                                         task_id=source["meta"]["task_id"], archived=False,
                                         created_at=now, updated_at=now)
                session.add(scenario)
                version = _new_version(session, scenario, source, snapshot, 1)
                rows.append(_version_dto(scenario, version))
        return _ok({"imported": len(rows), "items": rows})
    if isinstance(payload, dict) and payload.get("format") == "CSV":
        try:
            rows = list(csv.DictReader(io.StringIO(payload["content"])))
            scenarios = [dict(scenario_name=r["scenario_name"], faults=json.loads(r["faults"]))
                         for r in rows]
        except (KeyError, ValueError, TypeError) as exc:
            return _bad(FaultInputError("CSV 格式错误：%s" % exc))
    else:
        scenarios = payload.get("scenarios") if isinstance(payload, dict) else payload
    if not isinstance(scenarios, list) or not scenarios:
        return _bad(FaultInputError("scenarios 必须是非空列表"))
    try:
        for scenario in scenarios:
            _engine().validate(scenario)
    except FaultInputError as exc:
        return _bad(exc)
    with _SLOCK:
        added = []
        for scenario in scenarios:
            sid = "FS-" + uuid.uuid4().hex[:10].upper()
            row = dict(scenario, scenario_id=sid,
                       create_time=datetime.now(timezone.utc).isoformat())
            _scenarios()[sid] = row
            added.append(sid)
        _save_scenarios()
    return _ok({"imported": len(added), "scenario_ids": added})


def import_scenarios_file(filename, contents, *, context=None, task_id=None, plan_id=None):
    """CSV/XLSX rows contain scenario_name and JSON-encoded faults columns."""
    suffix = Path(filename or "").suffix.lower()
    try:
        if suffix == ".csv":
            rows = list(csv.DictReader(io.StringIO(contents.decode("utf-8-sig"))))
        elif suffix == ".xlsx":
            from openpyxl import load_workbook
            book = load_workbook(io.BytesIO(contents), read_only=True, data_only=True)
            values = book.active.iter_rows(values_only=True)
            header = next(values)
            rows = [dict(zip(header, row)) for row in values]
            book.close()
        else:
            return _bad(FaultInputError("仅支持 CSV/XLSX 场景文件"))
        scenarios = [{"scenario_name": row["scenario_name"],
                      "faults": json.loads(row["faults"])} for row in rows]
    except (KeyError, ValueError, TypeError, UnicodeError, StopIteration) as exc:
        return _bad(FaultInputError("导入文件格式错误：%s" % exc))
    return import_scenarios({"context": context, "task_id": task_id,
                             "plan_id": plan_id, "scenarios": scenarios})


def _diagnosis(tid):
    task = get_task_record(tid)
    if task.get("kind") not in {"FAULT_DIAGNOSE", "FAULT_DIAGNOSE_OBSERVATION"} or task.get("status") != "SUCCESS":
        return None
    return task["result"]


def submit_diagnosis_feedback(task_id, payload):
    """把人工确认结论送入 SR-6 待审核队列，审核发布后才参与后续推理。"""
    diagnosis = _diagnosis(task_id)
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    payload = payload or {}
    reviewer = str(payload.get("reviewer") or "").strip()
    index = payload.get("result_index", 0)
    if not reviewer or not isinstance(index, int) or not 0 <= index < len(diagnosis["results"]):
        return _bad(FaultInputError("reviewer 必填，result_index 必须指向有效诊断结果"))
    result = diagnosis["results"][index]
    observations = diagnosis.get("input_snapshot", {}).get("faults", [])
    if index >= len(observations):
        return _bad(FaultInputError("该任务由旧版本生成，缺少反馈所需的输入快照，请重新诊断"))
    observation = observations[index]
    fault_type = payload.get("confirmed_fault_type") or result["fused"].get("fault_type")
    object_type = result["fault_object"]["object_type"]
    if fault_type not in FAULT_TYPES or object_type not in ALLOWED_OBJECTS[fault_type]:
        return _bad(FaultInputError("确认的故障类型与对象类型不适配", 3003))
    symptom_ids = observation.get("symptom_ids") or []
    if not symptom_ids:
        return _bad(FaultInputError("至少需要一个已观察现象才能沉淀为可复用案例"))

    kg_branch = next((row for row in result["branches"] if row["source"] == "KG"), {})
    rule_branch = next((row for row in result["branches"] if row["source"] == "RULE"), {})
    root_cause = str(payload.get("root_cause") or result["fused"].get("root_cause") or "").strip()
    component = str(payload.get("fault_component") or result.get("fault_component") or "").strip()
    solution = str(payload.get("solution") or kg_branch.get("action") or rule_branch.get("action") or "").strip()
    steps = payload.get("diagnosis_steps")
    if steps is None:
        steps = kg_branch.get("steps") or []
    if not root_cause or not solution or not isinstance(steps, list) or not all(
            isinstance(step, str) and step.strip() for step in steps):
        return _bad(FaultInputError("root_cause、solution 必填，diagnosis_steps 必须是字符串列表"))

    case_id = "DF-%s-%02d" % (task_id.removeprefix("tsk-").upper(), index + 1)
    source = "diagnosis_feedback#%s by %s [UNAUTHENTICATED_REVIEW]" % (case_id, reviewer)
    ops = [
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "instanceOf", "tail_type": "FaultType", "tail": fault_type, "source": source},
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "occursOn", "tail_type": "ObjectType", "tail": object_type, "source": source},
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "recordedIn", "tail_type": "Case", "tail": case_id, "source": source},
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "causedBy", "tail_type": "Cause", "tail": root_cause, "source": source},
        {"op": "add_triple", "head_type": "Fault", "head": case_id,
         "relation": "resolvedBy", "tail_type": "Solution", "tail": solution, "source": source},
    ]
    if component:
        ops.append({"op": "add_triple", "head_type": "Fault", "head": case_id,
                    "relation": "locatedAt", "tail_type": "Component", "tail": component,
                    "source": source})
    for symptom_id in symptom_ids:
        ops.append({"op": "add_triple", "head_type": "Fault", "head": case_id,
                    "relation": "hasSymptom", "tail_type": "Symptom",
                    "tail": _engine().symptoms[symptom_id], "source": source})
    for step_index, step in enumerate(steps, 1):
        ops.append({"op": "add_triple", "head_type": "Fault", "head": case_id,
                    "relation": "diagnosedBy", "tail_type": "DiagnosisStep",
                    "tail": "%02d:%s" % (step_index, step.strip()), "source": source})

    from . import kg
    with kg._LOCK:
        graph, _ = kg._load()
        duplicate_pending = any(change["status"] == "PENDING" and any(
            op.get("op") == "add_triple" and op.get("head_type") == "Fault" and
            op.get("head") == case_id for op in change["ops"]) for change in graph.pending)
        if graph.get("Fault", case_id) is not None or duplicate_pending:
            return _bad(FaultInputError("该诊断结果已经提交知识反馈，请勿重复提交"))
        submitted = kg.submit({"ops": ops, "submitter": reviewer,
                               "note": "SR-5 人工确认诊断反馈 %s" % case_id})
    if submitted["code"] == CODE_OK:
        submitted["data"].update({"case_id": case_id, "diagnose_task_id": task_id,
                                  "requires_kg_review": True,
                                  "provenance": "UNAUTHENTICATED_REVIEW"})
    return submitted


def _impact(tid):
    task = get_task_record(tid)
    if task.get("kind") != "FAULT_IMPACT" or task.get("status") != "SUCCESS":
        return None
    return task["result"]


def submit_diagnosis(payload):
    payload = payload or {}
    if payload.get("context") not in (None, "planning", "demo"):
        return _bad(FaultInputError("context 只能为 planning 或 demo"))
    if payload.get("context") != "planning" and any(
        key in payload for key in ("task_id", "plan_id")
    ):
        return _bad(FaultInputError("正式方案诊断须显式设置 context=planning"))
    if payload.get("context") == "planning" and payload.get("network_solution_id"):
        return _bad(FaultInputError("正式诊断应使用 plan_id，不接受旧方案编号"))
    if payload.get("context") == "planning" and not payload.get("plan_id"):
        raise FaultPlanSourceError(1001, "正式诊断必须指定 plan_id", 422)
    sid = payload.get("scenario_id")
    formal = payload.get("context") == "planning"
    if formal:
        replay = _replay_submission(payload, "FAULT_DIAGNOSE")
        if replay is not None:
            return replay
    source = load_plan_source(payload.get("task_id"), payload.get("plan_id")) if formal else None
    if formal:
        version_id = payload.get("scenario_version_id")
        if not isinstance(version_id, str) or not version_id:
            raise FaultPlanSourceError(1001, "正式诊断必须指定 scenario_version_id", 422)
        with get_session_factory()() as session:
            record = _formal_record(session, sid, source["meta"]["task_id"])
            if record.archived:
                raise FaultPlanSourceError(1203, "已归档场景不能提交新诊断", 409)
            version = session.get(FaultScenarioVersion, version_id)
            if version is None or version.scenario_id != sid:
                raise FaultPlanSourceError(1002, "场景版本不存在或不属于该场景", 404)
            if (version.plan_id != source["meta"]["plan_id"]
                    or version.plan_revision != source["meta"]["revision"]
                    or version.resource_revision != source["meta"]["resource_revision"]):
                raise FaultPlanSourceError(1203, "场景版本绑定的规划方案已变化，请保存新版本", 409)
            scenario = {"scenario_id": sid, **deepcopy(version.snapshot)}
            version_no = version.version_no
    else:
        with _SLOCK:
            stored = _scenarios().get(sid)
            scenario = deepcopy(stored) if stored is not None else None
        if scenario is None:
            return {"code": 1002, "message": "故障场景不存在", "data": None}
    network = source["network"] if source else None
    try:
        _diagnose_live(scenario, payload, network=network)
    except FaultInputError as exc:
        return _bad(exc)
    if not formal and payload.get("network_solution_id") and _solution(payload["network_solution_id"]) is None:
        return {"code": 1002, "message": "规划方案不存在", "data": None}

    def work(_payload, tick):
        tick(0.4, "规则与图谱推理")
        out = _diagnose_live(scenario, payload, network=network)
        if source:
            meta = source["meta"]
            out.update(context="planning", network_solution_id=meta["plan_id"],
                       network_task_id=meta["task_id"], network_revision=meta["revision"],
                       network_resource_revision=meta["resource_revision"],
                       scenario_version_id=version_id, scenario_version_no=version_no)
        else:
            out["network_solution_id"] = payload.get("network_solution_id") or "SYNTHETIC_BASELINE"
        return out
    if formal:
        return _spawn_formal("FAULT_DIAGNOSE", payload, work,
                             task_id=source["meta"]["task_id"],
                             plan_id=source["meta"]["plan_id"],
                             scenario_id=sid, version_id=version_id)
    return _spawn("FAULT_DIAGNOSE", payload, work)


def _diagnose_live(scenario, payload, require_fault_type=True, network=None):
    from . import kg
    with kg._LOCK:
        graph, _ = kg._load()
        engine = _engine().for_network(network) if network is not None else _engine()
        return engine.diagnose(scenario, payload.get("fusion_weights"),
                               payload.get("confidence_threshold", 0.6), graph=graph,
                               require_fault_type=require_fault_type)


def submit_observation_diagnosis(payload):
    payload = payload or {}
    scenario = {"scenario_name": payload.get("scenario_name") or "观测诊断",
                "faults": payload.get("faults"), "scenario_id": None}
    try:
        _diagnose_live(scenario, payload, require_fault_type=False)
    except FaultInputError as exc:
        return _bad(exc)

    def work(_payload, tick):
        tick(0.4, "根据观测现象推理")
        return _diagnose_live(scenario, payload, require_fault_type=False)

    return _spawn("FAULT_DIAGNOSE_OBSERVATION", payload, work)


def _solution(sid):
    from .planning_w4 import get_plan
    result = get_plan(sid)
    return result["data"] if result["code"] == CODE_OK else None


def submit_impact(payload):
    payload = payload or {}
    if payload.get("context") == "planning" or (
            payload.get("context") is None and payload.get("task_id") and payload.get("plan_id")):
        replay = _replay_submission(payload, "FAULT_IMPACT")
        if replay is not None:
            return replay
    diagnosis = _diagnosis(payload.get("diagnose_task_id"))
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    formal = diagnosis.get("context") == "planning"
    if formal:
        if payload.get("context") not in (None, "planning"):
            return _bad(FaultInputError("正式诊断的影响分析不能切换到演示模式"))
        if (payload.get("task_id") != diagnosis["network_task_id"]
                or payload.get("plan_id") != diagnosis["network_solution_id"]):
            return _bad(FaultInputError("影响分析的任务和方案须与诊断结果一致"))
        source = load_plan_source(payload["task_id"], payload["plan_id"],
                                  require_current=False)
        if source["meta"]["revision"] != diagnosis["network_revision"]:
            return _bad(FaultInputError("诊断来源方案版本已经变化"))
        version_id = diagnosis.get("scenario_version_id")
        if not version_id:
            raise FaultPlanSourceError(1203, "原诊断缺少场景版本，请重新提交诊断", 409)
        scenario = {"scenario_id": diagnosis["scenario_id"],
                    **deepcopy(diagnosis["input_snapshot"])}
        solution = source["solution"]
        try:
            _engine().for_network(source["network"]).validate(scenario)
        except FaultInputError as exc:
            return _bad(exc)

        def work(_payload, tick):
            tick(0.4, "沿冻结方案的主备路由计算影响")
            out = _engine().for_network(source["network"]).impact(
                scenario, diagnosis, solution, payload.get("consider_backup_route", True))
            out.update(context="planning", network_task_id=source["meta"]["task_id"],
                       network_revision=source["meta"]["revision"],
                       diagnose_task_id=payload["diagnose_task_id"],
                       scenario_version_id=version_id)
            return out
        return _spawn_formal("FAULT_IMPACT", payload, work,
                             task_id=source["meta"]["task_id"],
                             plan_id=source["meta"]["plan_id"],
                             scenario_id=diagnosis["scenario_id"],
                             version_id=version_id,
                             diagnose_task_id=payload["diagnose_task_id"])

    if payload.get("context") == "planning" or any(
        key in payload for key in ("task_id", "plan_id")
    ):
        return _bad(FaultInputError("正式影响分析须引用正式诊断任务"))

    sid = payload.get("network_solution_id") or diagnosis.get("network_solution_id")
    solution = None if sid == "SYNTHETIC_BASELINE" else _solution(sid)
    if sid != "SYNTHETIC_BASELINE" and solution is None:
        return {"code": 1002, "message": "规划方案不存在", "data": None}
    if solution and solution.get("kind") != "SR4_FLOW":
        return _bad(FaultInputError("影响分析需要 SR4_FLOW 方案"))
    scenario = _scenarios().get(diagnosis["scenario_id"])
    if scenario is None:
        return {"code": 1002, "message": "诊断场景已删除", "data": None}
    if solution:
        plan_links = {r["link_id"] for r in solution["detail"]["links"]}
        unknown = [f["object_id"] for f in scenario["faults"]
                   if f["object_type"] == "LINK" and f["object_id"] not in plan_links]
        if unknown:
            return {"code": 1002, "message": "故障链路不在所选规划方案中：%s" % unknown, "data": None}

    def work(_payload, tick):
        tick(0.4, "沿主备路由计算影响")
        return _engine().impact(scenario, diagnosis, solution,
                                payload.get("consider_backup_route", True))
    return _spawn("FAULT_IMPACT", payload, work)


def get_impact_nodes(task_id, node_role=None, region=None):
    impact = _impact(task_id)
    if impact is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "影响任务不存在或尚未完成", "data": None}
    rows = [row for row in impact["affected_nodes"]
            if (node_role is None or row.get("node_role") == node_role)
            and (region is None or row.get("region") == region)]
    return _ok({"total": len(rows), "items": rows,
                "filters": {"node_role": node_role, "region": region}})


def get_suggestions(diagnose_task_id, impact_task_id=None):
    diagnosis = _diagnosis(diagnose_task_id)
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    impact = _impact(impact_task_id) if impact_task_id else None
    if impact_task_id and impact is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "影响分析任务不存在或尚未完成", "data": None}
    if impact and impact["scenario_id"] != diagnosis["scenario_id"]:
        return _bad(FaultInputError("诊断结果与影响分析结果不属于同一场景"))
    if diagnosis.get("context") == "planning" and impact and (
            impact.get("context") != "planning" or
            impact.get("network_solution_id") != diagnosis.get("network_solution_id")):
        return _bad(FaultInputError("诊断与影响分析的方案来源不一致"))
    return _ok(_engine().suggestions(diagnosis, impact))


def _submission_by_task(session, algorithm_task_id, task_id, kind):
    row = session.scalars(select(FaultTaskSubmission).where(
        FaultTaskSubmission.algorithm_task_id == algorithm_task_id)).one_or_none()
    if row is None or row.task_id != task_id or row.kind != kind:
        raise FaultPlanSourceError(2001, "正式分析任务不存在或不属于该规划任务", 404)
    return row


def _analysis_state(record, phase):
    if not record:
        return "FAILED", 0.0, "%s运行记录不可用，请使用新 request_id 重新提交" % phase
    status = record.get("status")
    if status not in {"PENDING", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"}:
        return "FAILED", 0.0, "%s任务状态无效" % phase
    return status, max(0.0, min(1.0, float(record.get("progress") or 0))), record.get("error")


def get_analysis_view(diagnose_task_id, task_id, impact_task_id=None):
    if not isinstance(task_id, str) or not task_id:
        raise FaultPlanSourceError(1001, "task_id 必填", 422)
    with get_session_factory()() as session:
        diagnosis_receipt = _submission_by_task(session, diagnose_task_id, task_id,
                                                "FAULT_DIAGNOSE")
        impact_receipt = None
        if impact_task_id is not None:
            impact_receipt = _submission_by_task(session, impact_task_id, task_id,
                                                 "FAULT_IMPACT")
            if (impact_receipt.diagnose_task_id != diagnose_task_id
                    or impact_receipt.plan_id != diagnosis_receipt.plan_id
                    or impact_receipt.scenario_version_id != diagnosis_receipt.scenario_version_id):
                raise FaultPlanSourceError(1204, "影响任务与诊断任务不属于同一分析", 409)
        version = session.get(FaultScenarioVersion, diagnosis_receipt.scenario_version_id)
        if version is None:
            raise FaultPlanSourceError(1203, "诊断场景版本已不可用", 409)
        scenario = {"scenario_id": diagnosis_receipt.scenario_id,
                    "version_id": version.version_id, "version_no": version.version_no,
                    **deepcopy(version.snapshot)}
        source = {"task_id": task_id, "plan_id": diagnosis_receipt.plan_id,
                  "plan_revision": version.plan_revision,
                  "resource_revision": version.resource_revision}

    diagnosis_task = get_task_record(diagnose_task_id)
    diagnosis_state, diagnosis_progress, diagnosis_error = _analysis_state(
        diagnosis_task, "诊断")
    if diagnosis_task and diagnosis_task.get("kind") != "FAULT_DIAGNOSE":
        raise FaultPlanSourceError(1203, "诊断任务类型不匹配", 409)
    impact_task = get_task_record(impact_task_id) if impact_receipt else None
    impact_state, impact_progress, impact_error = (
        _analysis_state(impact_task, "影响") if impact_receipt else (None, 0.0, None))
    if impact_task and impact_task.get("kind") != "FAULT_IMPACT":
        raise FaultPlanSourceError(1203, "影响任务类型不匹配", 409)

    diagnosis_ready = diagnosis_state == "SUCCESS"
    impact_ready = impact_state == "SUCCESS"
    if not diagnosis_ready:
        state = diagnosis_state
        progress = diagnosis_progress * 0.5
        error = diagnosis_error
    elif impact_receipt is None:
        state, progress, error = "DIAGNOSIS_READY", 0.5, None
    else:
        state = impact_state
        progress = 0.5 + impact_progress * 0.5
        error = impact_error

    diagnosis = deepcopy(diagnosis_task.get("result")) if diagnosis_ready else None
    impact = deepcopy(impact_task.get("result")) if impact_ready else None
    if diagnosis_ready and (
            diagnosis.get("network_solution_id") != source["plan_id"]
            or diagnosis.get("scenario_version_id") != version.version_id):
        raise FaultPlanSourceError(1203, "诊断结果与提交回执不一致", 409)
    if impact_ready and (
            impact.get("diagnose_task_id") != diagnose_task_id
            or impact.get("scenario_version_id") != version.version_id):
        raise FaultPlanSourceError(1203, "影响结果与诊断结果不一致", 409)
    suggestions = _engine().suggestions(diagnosis, impact) if diagnosis_ready else None
    report_ready = diagnosis_ready and impact_ready
    report = _report_content(diagnosis, impact, suggestions) if report_ready else None
    if report is not None:
        report["generated_at"] = datetime.fromtimestamp(
            impact_task["finished_at"], timezone.utc).isoformat()
    phases = [
        {"name": "故障诊断", "status": diagnosis_state,
         "progress": diagnosis_progress},
        {"name": "影响分析", "status": impact_state or "WAITING",
         "progress": impact_progress},
    ]
    return _ok({"task_id": task_id, "plan_id": source["plan_id"],
                "diagnose_task_id": diagnose_task_id,
                "impact_task_id": impact_task_id,
                "request_id": diagnosis_receipt.request_id,
                "impact_request_id": impact_receipt.request_id if impact_receipt else None,
                "state": state, "progress": round(progress, 3), "phases": phases,
                "diagnosis_ready": diagnosis_ready, "impact_ready": impact_ready,
                "report_ready": report_ready, "error": error,
                "source": source, "scenario": scenario,
                "diagnosis": diagnosis, "impact": impact,
                "suggestions": suggestions, "report": report})


def _report_content(diagnosis, impact, suggestions):
    if diagnosis.get("context") == "planning":
        scenario = {"scenario_id": diagnosis["scenario_id"],
                    **deepcopy(diagnosis["input_snapshot"])}
    else:
        scenario = _scenarios().get(diagnosis["scenario_id"])
    return {"scenario_id": diagnosis["scenario_id"], "data_source": "CONSTRUCTED",
            "scenario": scenario,
            "diagnosis": diagnosis, "impact": impact, "suggestions": suggestions,
            "generated_at": datetime.now(timezone.utc).isoformat()}


def _report_docx(content, path):
    from docx import Document
    doc = Document()
    doc.add_heading("故障诊断报告", 0)
    doc.add_paragraph("数据性质：CONSTRUCTED 合成测试数据；结果不能作为真实设备诊断准确率证明。")
    doc.add_paragraph("场景：" + content["scenario_id"])
    if content["scenario"]:
        doc.add_paragraph("场景名称：" + content["scenario"]["scenario_name"])
        for fault in content["scenario"]["faults"]:
            doc.add_paragraph("故障输入：%s %s；现象：%s；发生时间：%s" %
                              (fault["object_type"], fault["object_id"],
                               ", ".join(fault.get("symptom_ids") or []), fault.get("occur_time", "未知")))
    for item in content["diagnosis"]["results"]:
        doc.add_heading(item["fault_object"]["object_id"], level=1)
        fused = item["fused"]
        doc.add_paragraph("类型：%s；根因：%s；融合得分：%.3f；人工研判：%s" %
                          (fused["fault_type"], fused["root_cause"], fused["confidence"],
                           "是" if fused["need_manual_review"] else "否"))
        for branch in item["branches"]:
            doc.add_paragraph("%s：%s；依据：%s" %
                              (branch["source"], branch["confidence"], branch["evidence"]))
    if content["impact"]:
        doc.add_heading("影响范围", level=1)
        doc.add_paragraph(json.dumps(content["impact"]["summary"], ensure_ascii=False))
    doc.add_heading("处置建议", level=1)
    for row in content["suggestions"]["suggestions"]:
        doc.add_paragraph("%s. %s（来源：%s）" % (row["priority"], row["action"], row["source"]))
    doc.save(path)


def _report_pdf(content, path):
    from html import escape
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    style = ParagraphStyle("Chinese", fontName="STSong-Light", fontSize=10, leading=17)
    heading = ParagraphStyle("Heading", parent=style, fontSize=16, leading=24)
    story = [Paragraph("故障诊断报告", heading), Spacer(1, 12),
             Paragraph("数据性质：CONSTRUCTED 合成测试数据，结果须人工研判。", style),
             Paragraph("场景：%s" % escape(content["scenario_id"]), style)]
    if content["scenario"]:
        story.append(Paragraph("场景名称：%s" % escape(content["scenario"]["scenario_name"]), style))
        for fault in content["scenario"]["faults"]:
            story.append(Paragraph("故障输入：%s %s；现象：%s；发生时间：%s" %
                                   (escape(fault["object_type"]), escape(fault["object_id"]),
                                    escape(", ".join(fault.get("symptom_ids") or [])),
                                    escape(str(fault.get("occur_time", "未知")))), style))
    for item in content["diagnosis"]["results"]:
        fused = item["fused"]
        story.append(Spacer(1, 8))
        story.append(Paragraph("对象：%s" % escape(item["fault_object"]["object_id"]), style))
        story.append(Paragraph("类型：%s；根因：%s；融合得分：%.3f" %
                               (escape(str(fused["fault_type"])),
                                escape(str(fused["root_cause"])), fused["confidence"]), style))
        for branch in item["branches"]:
            story.append(Paragraph("%s：%s；依据：%s" %
                                   (branch["source"], branch["confidence"],
                                    escape(str(branch["evidence"]))), style))
    if content["impact"]:
        story.append(Paragraph("影响统计：%s" % escape(str(content["impact"]["summary"])), style))
    for row in content["suggestions"]["suggestions"]:
        story.append(Paragraph("建议 %s：%s" %
                               (row["priority"], escape(str(row["action"]))), style))
    SimpleDocTemplate(str(path), pagesize=A4).build(story)


def create_report(payload):
    payload = payload or {}
    diagnosis = _diagnosis(payload.get("diagnose_task_id"))
    if diagnosis is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "诊断任务不存在或尚未完成", "data": None}
    impact = _impact(payload.get("impact_task_id")) if payload.get("impact_task_id") else None
    if payload.get("impact_task_id") and impact is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "影响分析任务不存在或尚未完成", "data": None}
    if impact and impact["scenario_id"] != diagnosis["scenario_id"]:
        return _bad(FaultInputError("诊断结果与影响分析结果不属于同一场景"))
    if diagnosis.get("context") == "planning" and impact and (
            impact.get("context") != "planning" or
            impact.get("network_solution_id") != diagnosis.get("network_solution_id")):
        return _bad(FaultInputError("诊断与影响分析的方案来源不一致"))
    fmt = (payload.get("format") or "json").lower()
    if fmt not in {"json", "docx", "pdf"}:
        return _bad(FaultInputError("报告格式仅支持 json / docx / pdf"))
    content = _report_content(diagnosis, impact, _engine().suggestions(diagnosis, impact))
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    filename = "report_%s_%s.%s" % (diagnosis["scenario_id"], uuid.uuid4().hex[:8], fmt)
    path = REPORT_DIR / filename
    if fmt == "json":
        path.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
    elif fmt == "docx":
        _report_docx(content, path)
    else:
        _report_pdf(content, path)
    return _ok({"report_url": "/api/v1/files/%s" % filename, "format": fmt,
                "data_source": "CONSTRUCTED"})


def report_path(filename):
    if Path(filename).name != filename or not filename.startswith("report_"):
        return None
    path = REPORT_DIR / filename
    return path if path.is_file() else None


def export_impact(tid, fmt):
    impact = _impact(tid)
    if impact is None:
        return None
    if fmt == "xlsx":
        from openpyxl import Workbook
        buf = io.BytesIO()
        book = Workbook()
        sheet = book.active
        sheet.title = "受影响节点"
        sheet.append(["节点", "影响类型", "程度", "状态", "原因"])
        for row in impact["affected_nodes"]:
            sheet.append([row["node_id"], row["affect_type"], row["level"], row["state"], row["reason"]])
        sheet = book.create_sheet("受影响链路")
        sheet.append(["链路", "状态", "程度", "原因"])
        for row in impact["affected_links"]:
            sheet.append([row["link_id"], row["state"], row["level"], row["reason"]])
        book.save(buf)
        return buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if fmt == "png":
        from PIL import Image, ImageDraw
        image = Image.new("RGB", (900, 640), "white")
        draw = ImageDraw.Draw(image)
        features = impact["impact_scope"]["features"]
        coords = [f["geometry"]["coordinates"] for f in features]
        if coords:
            xs, ys = [p[0] for p in coords], [p[1] for p in coords]
            x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
            for feature in features:
                x, y = feature["geometry"]["coordinates"]
                px = 50 + (x - x0) / max(x1 - x0, 0.01) * 800
                py = 590 - (y - y0) / max(y1 - y0, 0.01) * 540
                color = "#c83832" if feature["properties"]["state"] == "INTERRUPTED" else "#e6aa39"
                draw.ellipse((px - 5, py - 5, px + 5, py + 5), fill=color)
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        return buf.getvalue(), "image/png"
    return None
