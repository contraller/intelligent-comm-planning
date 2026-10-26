"""冻结覆盖的单worker持久缓存；成功结果与终态同文件原子发布。"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import threading
import time
import uuid

from . import frozen_coverage_engine as algorithm


ROOT = Path(__file__).resolve().parents[2]
KIND = "FROZEN_COVERAGE_V1"
ENGINE_VERSION = "V01-5"
ENGINE_VERSIONS = ("V01-1", "V01-2", "V01-3", "V01-4", "V01-5")
SELECTION_ENGINE_VERSIONS = ("V01-3", "V01-4", "V01-5")
ACTIVE = {"PENDING", "RUNNING"}
JOB_ID = re.compile(r"FCJ-[0-9a-f]{32}\Z")


class CoverageServiceError(ValueError):
    def __init__(self, message, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _id(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 160 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise CoverageServiceError("覆盖标识无效")
    return value


def _hash(value):
    try:
        return algorithm._digest(value)
    except algorithm.FrozenCoverageError as exc:
        raise CoverageServiceError(str(exc)) from exc


def _parameters(value):
    try:
        return algorithm._parameters(value)
    except algorithm.FrozenCoverageError as exc:
        raise CoverageServiceError(str(exc)) from exc


def _cache_key(anchor, parameters, selection_id=None, selection_hash=None):
    value = {"anchor": anchor, "parameters": parameters}
    version = anchor.get("engine_version")
    if version in SELECTION_ENGINE_VERSIONS:
        value.update(bandwidth_selection_id=selection_id, bandwidth_selection_hash=selection_hash)
    elif version not in ("V01-1", "V01-2") or selection_id is not None or selection_hash is not None:
        raise CoverageServiceError("覆盖引擎持久版本无法识别", 5002, 503)
    return "FCC-" + _hash(value)


def _atomic(path, value):
    # 不清理失败临时文件，避免删除既有/失败证据；最终名称只通过replace发布。
    temp = path.with_name("FC-TMP-" + uuid.uuid4().hex + ".tmp")
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    with temp.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    for attempt in range(6):
        try:
            temp.replace(path)
            break
        except PermissionError as exc:
            if os.name != "nt" or getattr(exc, "winerror", None) not in (5, 32, 33) or attempt == 5:
                raise
            time.sleep(0.005 * 2 ** attempt)


def _read(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    try:
        if path.is_symlink() or path.stat().st_size > 256 * 1024 * 1024:
            raise ValueError("unsafe cache file")
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
        if not isinstance(value, dict):
            raise ValueError("invalid cache object")
        return value
    except (OSError, ValueError, UnicodeError, RecursionError) as exc:
        raise CoverageServiceError("冻结覆盖文件无法核验，禁止回退或伪造成功", 5002, 503) from exc


def _source_loader(factory, plan_id, task_id, snapshot_id, *, audit_context=None, internal=False):
    from .database import get_session_factory, DatabaseConfigurationError
    from .planning_plan_models import PlanningPlan
    from .resource_dataset_models import ResourceDatasetVersion
    from . import resource_dataset_service as datasets
    from sqlalchemy.exc import SQLAlchemyError

    try:
        with (factory or get_session_factory()).begin() as session:
            context = None
            if not internal and (audit_context is not None or os.environ.get("AUTH_MODE") == "LOCAL_PASSWORD"):
                from .planning_operation_service import _business_context, _require_owner
                context = _business_context(audit_context)
                context._authenticate(session, "planning.execute" if context._writing else "planning.view")
            plan = session.get(PlanningPlan, plan_id)
            if plan is None or plan.task_id != task_id:
                raise CoverageServiceError("冻结规划方案不存在", 2001, 404)
            if not isinstance(plan.result_snapshot, dict) or plan.result_snapshot.get("snapshot_id") != snapshot_id:
                raise CoverageServiceError("规划快照锚点已变化", 1205, 409)
            if context is not None and context._writing:
                _require_owner(session, context, operation="plan.save", request_id=plan.request_id, object_id=plan_id,
                               page_context="planning", task_id=task_id, revision_id=plan.revision_id)
            version = session.get(ResourceDatasetVersion, plan.resource_revision)
            frozen = datasets._decode(version)
            return {"plan_id": plan_id, "task_id": task_id, "snapshot_id": snapshot_id,
                    "input_version": plan.revision_id, "condition_version": plan.condition_version,
                    "resource_revision": plan.resource_revision, "resource_content_hash": frozen["content_hash"],
                    "input_snapshot": deepcopy(plan.input_snapshot), "raw_snapshot": deepcopy(plan.raw_snapshot),
                    "tables": deepcopy(frozen["tables"])}
    except DatabaseConfigurationError as exc:
        raise CoverageServiceError("覆盖数据库未配置", 5001, 503) from exc
    except (datasets.ResourceDatasetError, SQLAlchemyError) as exc:
        raise CoverageServiceError("冻结资源版本不可用，禁止读取current CSV", 5002, 503) from exc


def _default_fingerprint():
    from .planning_adjustment_service import terrain_fingerprint
    return terrain_fingerprint()


def _default_terrain():
    from .planning_adjustment_service import _HEADERS
    algorithm._modules()
    from terrain import DemTerrain
    return DemTerrain(dem_header=str(_HEADERS[0]), lc_header=str(_HEADERS[1]))


class FrozenCoverageService:
    def __init__(self, *, runtime_root, session_factory=None, terrain_provider=None,
                 fingerprint_provider=None, source_loader=None, engine=None):
        self.root = Path(runtime_root).resolve()
        if not self.root.is_relative_to((ROOT / "data/runtime/r2").resolve()):
            raise CoverageServiceError("覆盖目录必须显式位于本树data/runtime/r2", 5001, 503)
        self.source_loader, self.session_factory = source_loader, session_factory
        self.terrain = terrain_provider or _default_terrain
        self.fingerprint = fingerprint_provider or _default_fingerprint
        self.engine = engine or algorithm.compute_frozen_field_coverage
        self._lock = threading.RLock()
        self._owner = None
        self._thread = None
        self._stop = threading.Event()
        self._queue = queue.Queue()
        self._requests, self._caches, self._active, self._cancel_events = {}, {}, {}, {}
        self._storage_fault = None
        from .frozen_coverage_bandwidth_service import FrozenCoverageBandwidthService
        self.bandwidth = FrozenCoverageBandwidthService(self)

    def status(self):
        """只读生命周期快照，不读取运行文件或触发恢复。"""
        with self._lock:
            alive = self._thread is not None and self._thread.is_alive()
            stopped = self._stop.is_set()
            fault = self._storage_fault is not None
            unexpected_exit = self._thread is not None and not alive and not stopped
            state = "failed" if fault or unexpected_exit else "running" if alive and not stopped else "disabled"
            return {"state": state, "worker_alive": alive, "stop_requested": stopped, "storage_fault": fault}

    def _path(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise CoverageServiceError("覆盖作业编号无效")
        path = self.root / (job_id + ".json")
        if path.is_symlink():
            raise CoverageServiceError("覆盖文件路径不安全", 5002, 503)
        return path

    def _job(self, job_id):
        with self._lock:
            return self._read_job(job_id)

    def _read_job(self, job_id):
        path = self._path(job_id)
        if not path.exists():
            raise CoverageServiceError("覆盖作业不存在", 2001, 404)
        job = _read(path)
        if job.get("kind") != KIND or job.get("job_id") != job_id:
            raise CoverageServiceError("覆盖作业身份损坏", 5002, 503)
        try:
            valid = (job["state"] in ACTIVE | {"SUCCESS", "FAILED", "CANCELLED", "INTERRUPTED"}
                and job["request_digest"] == _hash(job["request_body"])
                and job["request_id"] == job["request_body"]["request_id"]
                and job["parameters"] == _parameters(job["request_body"]["parameters"])
                and job["cache_key"] == _cache_key(job["anchor"], job["parameters"],
                    job.get("bandwidth_selection_id"), job.get("bandwidth_selection_hash"))
                and all(job["anchor"][key] == job["request_body"][key] for key in ("plan_id", "task_id", "snapshot_id"))
                and bool(_id(job["actor_id"])))
        except (KeyError, TypeError, CoverageServiceError):
            valid = False
        if not valid:
            raise CoverageServiceError("覆盖请求摘要或冻结锚点损坏", 5002, 503)
        if job["anchor"]["engine_version"] in SELECTION_ENGINE_VERSIONS:
            sid = job.get("bandwidth_selection_id")
            if ("bandwidth_selection_id" not in job or "bandwidth_selection_hash" not in job
                    or sid != job["request_body"].get("bandwidth_selection_id")):
                raise CoverageServiceError("覆盖选择版本元数据损坏", 5002, 503)
            self._job_selection(job)
        if job["state"] == "SUCCESS" and not job["from_cache"]:
            self._result(job)
        return job

    def _write(self, job):
        job["updated_at"] = _now()
        try:
            _atomic(self._path(job["job_id"]), job)
        except (OSError, ValueError) as exc:
            raise CoverageServiceError("覆盖作业未能持久保存，不能视为已接受", 5002, 503) from exc

    def _scan(self):
        requests, caches = {}, {}
        if self.root.exists():
            for path in sorted(self.root.glob("FCJ-*.json")):
                job = self._job(path.stem)
                rid = job["request_id"]
                if rid in requests:
                    raise CoverageServiceError("持久请求号重复，拒绝恢复", 5002, 503)
                requests[rid] = job["job_id"]
                if job["state"] == "SUCCESS" and job.get("result") is not None:
                    self._result(job)
                    caches[job["cache_key"]] = job["job_id"]
        self._requests, self._caches = requests, caches

    def start(self):
        with self._lock:
            if self._thread is not None:
                if self._thread.is_alive() and not self._stop.is_set():
                    return
                raise CoverageServiceError("本服务已关闭，需创建新实例", 5003, 503)
            self.root.mkdir(parents=True, exist_ok=True)
            lock_path = self.root / "frozen-coverage-worker.lock"
            if lock_path.is_symlink():
                raise CoverageServiceError("覆盖目录锁路径不安全", 5002, 503)
            handle = lock_path.open("a+b")
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._owner = handle
                if handle.seek(0, os.SEEK_END) == 0:
                    handle.write(b"\0")
                    handle.flush()
                self._scan()
                self.bandwidth.scan()
                for jid in self._requests.values():
                    job = self._job(jid)
                    if job["state"] in ACTIVE:
                        job.update(state="INTERRUPTED", finished_at=_now(),
                                   error={"code": "INTERRUPTED", "message": "上次运行未完成，不自动重算"})
                        self._write(job)
                self._thread = threading.Thread(target=self._work, name="frozen-coverage", daemon=True)
                self._thread.start()
            except Exception:
                if self._owner is not None:
                    self._release()
                else:
                    handle.close()
                raise

    def _release(self):
        handle, self._owner = self._owner, None
        if handle is None:
            return
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def close(self, timeout=10.0):
        with self._lock:
            self._stop.set()
            for jid in list(self._active.values()):
                self._cancel_events[jid].set()
                job = self._job(jid)
                if job["state"] in ACTIVE:
                    job["cancel_requested"] = True
                    self._write(job)
            thread = self._thread
        if thread is not None:
            thread.join(timeout)
            if thread.is_alive():
                raise CoverageServiceError("覆盖worker尚未退出，目录锁继续持有", 5003, 503)
        with self._lock:
            for jid in self._active.values():
                job = self._job(jid)
                if job["state"] in ACTIVE:
                    job.update(state="CANCELLED", finished_at=_now(), cancel_requested=True)
                    self._write(job)
            self._active.clear()
            self._release()

    def _source(self, plan_id, task_id, snapshot_id, *, audit_context=None, internal=False):
        for value in (plan_id, task_id, snapshot_id):
            _id(value)
        if self.source_loader is not None:
            if not internal and (audit_context is not None or os.environ.get("AUTH_MODE") == "LOCAL_PASSWORD"):
                raise CoverageServiceError("LOCAL覆盖禁止使用测试source loader绕过归属事务", 5001, 503)
            value = self.source_loader(plan_id, task_id, snapshot_id)
        else:
            value = _source_loader(self.session_factory, plan_id, task_id, snapshot_id,
                                   audit_context=audit_context, internal=internal)
        source = deepcopy(value)
        raw, tables = source.get("raw_snapshot"), source.get("tables")
        if (not isinstance(raw, dict) or not isinstance(tables, dict)
                or snapshot_id != "SNP-" + str(raw.get("solution_id"))
                or any(source.get(k) != v for k, v in (("plan_id", plan_id), ("task_id", task_id), ("snapshot_id", snapshot_id)))):
            raise CoverageServiceError("冻结来源没有完整、同一的方案快照", 1205, 409)
        anchor = {key: source[key] for key in ("plan_id", "task_id", "snapshot_id", "input_version",
                                             "condition_version", "resource_revision", "resource_content_hash")}
        anchor.update(plan_input_sha256=_hash(source["input_snapshot"]), raw_snapshot_sha256=_hash(raw),
                      frozen_tables_sha256=_hash(tables), terrain_fingerprint=raw.get("terrain_fingerprint"),
                      engine_version=ENGINE_VERSION)
        return source, anchor

    def _result(self, job):
        result = job.get("result")
        if not isinstance(result, dict) or _hash(result) != job.get("result_sha256"):
            raise CoverageServiceError("持久覆盖结果摘要损坏", 5002, 503)
        provenance, anchor = result.get("provenance", {}), job["anchor"]
        for key in ("raw_snapshot_sha256", "frozen_tables_sha256", "terrain_fingerprint", "engine_version"):
            if provenance.get(key) != anchor[key]:
                raise CoverageServiceError("覆盖结果来源与冻结缓存不一致", 5002, 503)
        if provenance.get("parameters") != job["parameters"] or result.get("solution_id") != anchor["snapshot_id"][4:]:
            raise CoverageServiceError("覆盖结果参数或快照不一致", 5002, 503)
        if anchor["engine_version"] in SELECTION_ENGINE_VERSIONS:
            selection = self._job_selection(job)
            for key in ("bandwidth_selection_id", "bandwidth_selection_hash"):
                if key not in provenance or provenance[key] != job[key]:
                    raise CoverageServiceError("覆盖结果选择版本不一致", 5002, 503)
            if provenance.get("bandwidth_choices") != (selection["choices"] if selection else []):
                raise CoverageServiceError("覆盖结果选值与持久版本不一致", 5002, 503)
        if anchor["engine_version"] == "V01-4":
            try:
                algorithm.validate_v4_result(result)
            except algorithm.FrozenCoverageError as exc:
                raise CoverageServiceError("V4覆盖结果统计或设备契约无法核验", 5002, 503) from exc
        elif anchor["engine_version"] == "V01-5":
            try:
                algorithm.validate_field_result(result)
            except algorithm.FrozenCoverageError as exc:
                raise CoverageServiceError("V5预测场强面契约无法核验", 5002, 503) from exc
        return deepcopy(result)

    def _job_selection(self, job):
        try:
            sid = job["bandwidth_selection_id"]
            selection = self.bandwidth.get(sid, job["anchor"]) if sid is not None else None
            if job["bandwidth_selection_hash"] != (selection["selection_hash"] if selection else None):
                raise CoverageServiceError("选择摘要不一致")
            return selection
        except (KeyError, CoverageServiceError) as exc:
            raise CoverageServiceError("持久覆盖作业的选择版本无法核验", 5002, 503) from exc

    def _cached(self, key):
        jid = self._caches.get(key)
        if not jid:
            return None
        job = self._job(jid)
        if job["state"] != "SUCCESS" or job["cache_key"] != key:
            raise CoverageServiceError("缓存终态无法核验", 5002, 503)
        return self._result(job)

    def _dto(self, job):
        result = deepcopy({key: job[key] for key in ("job_id", "request_id", "state", "progress", "stage", "anchor", "cache_key",
            "parameters", "from_cache", "cancel_requested", "error", "created_at", "updated_at", "finished_at")})
        if job["anchor"]["engine_version"] in SELECTION_ENGINE_VERSIONS:
            result.update({key: job[key] for key in ("bandwidth_selection_id", "bandwidth_selection_hash")})
        return result

    def bandwidth_options(self, plan_id, task_id, snapshot_id, *, audit_context=None):
        source, anchor = self._source(plan_id, task_id, snapshot_id, audit_context=audit_context)
        try:
            devices = algorithm.bandwidth_options(source["raw_snapshot"], source["tables"])
        except algorithm.FrozenCoverageError as exc:
            raise CoverageServiceError(str(exc)) from exc
        return dict(anchor=anchor, devices=devices, current_selection=self.bandwidth.current(anchor))

    def save_bandwidth_selection(self, plan_id, body, actor_id, *, audit_context=None):
        return self.bandwidth.save(plan_id, body, actor_id, audit_context=audit_context)

    def get_bandwidth_selection(self, plan_id, task_id, snapshot_id, selection_id, *, audit_context=None):
        source, anchor = self._source(plan_id, task_id, snapshot_id, audit_context=audit_context)
        return self.bandwidth.get(selection_id, anchor, source=source)

    def submit(self, plan_id, payload, actor_id, *, audit_context=None):
        _id(actor_id)
        body = deepcopy(payload)
        required = {"task_id", "snapshot_id", "request_id", "parameters"}
        if not isinstance(body, dict) or not required <= set(body) or set(body) - required - {"bandwidth_selection_id"}:
            raise CoverageServiceError("覆盖提交字段无效")
        request_id = _id(body["request_id"])
        digest = _hash({"plan_id": plan_id, **body})
        options = _parameters(body["parameters"])
        with self._lock:
            if self._storage_fault:
                raise self._storage_fault
            if self._thread is None or not self._thread.is_alive() or self._stop.is_set():
                raise CoverageServiceError("覆盖worker尚未显式启动", 5003, 503)
            source, anchor = self._source(plan_id, body["task_id"], body["snapshot_id"], audit_context=audit_context)
            if request_id in self._requests:
                job = self._job(self._requests[request_id])
                if job["actor_id"] != actor_id or job["request_digest"] != digest:
                    raise CoverageServiceError("请求号归属或正文冲突", 1204, 409)
                return self._dto(job), 200
            sid = body.get("bandwidth_selection_id")
            if "bandwidth_selection_id" in body and sid is None:
                raise CoverageServiceError("显式选择编号不能为null")
            selection = self.bandwidth.get(sid, anchor, source=source) if sid is not None else None
            selection_hash = selection["selection_hash"] if selection else None
            key = _cache_key(anchor, options, sid, selection_hash)
            if key in self._active:
                raise CoverageServiceError("同一冻结覆盖已有在途计算", 1206, 409)
            if len(self._active) >= 64:
                raise CoverageServiceError("覆盖排队数量已达限额", 1206, 409)
            cached = self._cached(key)
            if self.fingerprint() != anchor["terrain_fingerprint"]:
                raise CoverageServiceError("冻结DEM已变化，不能复用或计算该缓存", 1205, 409)
            stamp, jid = _now(), "FCJ-" + uuid.uuid4().hex
            job = dict(kind=KIND, job_id=jid, request_id=request_id, actor_id=actor_id, request_digest=digest,
                request_body={"plan_id": plan_id, **body}, state="SUCCESS" if cached else "PENDING",
                anchor=anchor, cache_key=key, parameters=options, from_cache=cached is not None,
                bandwidth_selection_id=sid, bandwidth_selection_hash=selection_hash,
                cancel_requested=False, error=None, created_at=stamp, updated_at=stamp,
                finished_at=stamp if cached else None, progress=1.0 if cached else 0.0,
                stage="持久缓存命中" if cached else "排队中", cancellations={}, result=None)
            self._write(job)
            self._requests[request_id] = jid
            if cached is not None:
                return self._dto(job), 200
            self._active[key] = jid
            self._cancel_events[jid] = threading.Event()
            self._queue.put((jid, source))
            return self._dto(job), 202

    def cache(self, plan_id, task_id, snapshot_id, parameters=None, *, bandwidth_selection_id=None,
              engine_version=None, audit_context=None):
        version = ENGINE_VERSION if engine_version is None else engine_version
        if version not in ENGINE_VERSIONS:
            raise CoverageServiceError("覆盖缓存引擎版本无效")
        if version not in SELECTION_ENGINE_VERSIONS and bandwidth_selection_id is not None:
            raise CoverageServiceError("该历史覆盖版本不支持接收带宽选择")
        source, anchor = self._source(plan_id, task_id, snapshot_id, audit_context=audit_context)
        # 历史缓存只能显式读取，不以旧结果满足新引擎计算请求。
        anchor["engine_version"] = version
        options = _parameters(parameters)
        selection = self.bandwidth.get(bandwidth_selection_id, anchor, source=source) if bandwidth_selection_id is not None else None
        selection_hash = selection["selection_hash"] if selection else None
        key = _cache_key(anchor, options, bandwidth_selection_id, selection_hash)
        with self._lock:
            if self._storage_fault:
                raise self._storage_fault
            if self._thread is None:
                self._scan()
            result = self._cached(key)
        if version == "V01-5" and result is not None:
            # 原生逐公里/逐格剖面留在已校验持久文件；GIS只需要显示面。
            # 不把重复的原始采样随每次读取发送到浏览器（全网可达近100MB）。
            for device in result["devices"]:
                for part in device["computations"]:
                    for raw_key in ("cells", "radial_samples", "rings"):
                        part.pop(raw_key, None)
        stale = self.fingerprint() != anchor["terrain_fingerprint"]
        return dict(state="STALE" if stale else "HIT" if result is not None else "MISS", cache_key=key,
                    anchor=anchor, parameters=options, result=None if stale else result,
                    bandwidth_selection_id=bandwidth_selection_id, bandwidth_selection_hash=selection_hash,
                    reason="冻结DEM已变化，原缓存不可用于当前展示" if stale else "" if result is not None else "尚无已发布的冻结覆盖缓存")

    def get_job(self, job_id, *, plan_id, task_id, snapshot_id, actor_id, audit_context=None):
        with self._lock:
            if self._storage_fault:
                raise self._storage_fault
            job = self._job(job_id)
            if job["actor_id"] != _id(actor_id):
                raise CoverageServiceError("不能读取其他账号的覆盖作业", 1103, 403)
            if any(job["anchor"].get(key) != value for key, value in (("plan_id", plan_id), ("task_id", task_id), ("snapshot_id", snapshot_id))):
                raise CoverageServiceError("覆盖作业冻结锚点不匹配", 1205, 409)
            _, anchor = self._source(plan_id, task_id, snapshot_id, audit_context=audit_context)
            expected = {**anchor, "engine_version": job["anchor"]["engine_version"]}
            if job["anchor"] != expected:
                raise CoverageServiceError("覆盖作业来源版本已变化", 1205, 409)
            return self._dto(job)

    def cancel(self, job_id, payload, actor_id, *, audit_context=None):
        body = deepcopy(payload)
        if set(body) != {"plan_id", "task_id", "snapshot_id", "request_id"}:
            raise CoverageServiceError("覆盖取消字段无效")
        rid, digest = _id(body["request_id"]), _hash(body)
        with self._lock:
            if self._owner is None or self._stop.is_set():
                raise CoverageServiceError("覆盖worker未启动或正在关闭", 5003, 503)
            self.get_job(job_id, actor_id=actor_id, audit_context=audit_context,
                         **{k: body[k] for k in ("plan_id", "task_id", "snapshot_id")})
            job = self._job(job_id)
            previous = job["cancellations"].get(rid)
            if previous is not None and previous != digest:
                raise CoverageServiceError("取消号正文冲突", 1204, 409)
            if previous is not None or job["state"] not in ACTIVE:
                return self._dto(job)
            job["cancellations"][rid] = digest
            job["cancel_requested"] = True
            if job["state"] == "PENDING":
                job.update(state="CANCELLED", finished_at=_now(), stage="计算前取消")
            self._write(job)
            self._cancel_events[job_id].set()
            return self._dto(job)

    def _work(self):
        while not self._stop.is_set():
            try:
                jid, source = self._queue.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self._run(jid, source)
            except CoverageServiceError as exc:
                with self._lock:
                    self._storage_fault = exc
                    self._stop.set()
            finally:
                with self._lock:
                    for key, value in list(self._active.items()):
                        if value == jid:
                            self._active.pop(key)
                    self._cancel_events.pop(jid, None)
                self._queue.task_done()

    def _run(self, jid, source):
        def cancelled():
            return self._stop.is_set() or self._cancel_events[jid].is_set()

        def progress(value, stage):
            with self._lock:
                job = self._job(jid)
                if value < 1 and value - job["progress"] >= 0.1:
                    job.update(progress=value, stage=stage)
                    self._write(job)

        try:
            with self._lock:
                job = self._job(jid)
                if job["state"] != "PENDING":
                    return
                job.update(state="RUNNING", stage="核验冻结覆盖输入")
                self._write(job)
            selection = self.bandwidth.get(job["bandwidth_selection_id"], job["anchor"], source=source) if job["bandwidth_selection_id"] else None
            extra = {"bandwidth_selection": selection} if selection else {}
            result = self.engine(source["raw_snapshot"], source["tables"], terrain=self.terrain,
                                 fingerprint=self.fingerprint, params=job["parameters"], cancelled=cancelled, progress=progress, **extra)
            # worker仅核对已受理的不可变锚点；不传入请求上下文或重新取得他人规划。
            _, anchor = self._source(job["anchor"]["plan_id"], job["anchor"]["task_id"], job["anchor"]["snapshot_id"], internal=True)
            with self._lock:
                job = self._job(jid)
                if cancelled():
                    raise algorithm.FrozenCoverageCancelled("已请求取消，未发布结果")
                if anchor != job["anchor"] or self.fingerprint() != anchor["terrain_fingerprint"]:
                    raise CoverageServiceError("计算期间冻结输入或DEM发生变化", 1205, 409)
                job.update(result=result, result_sha256=_hash(result))
                self._result(job)
                job.update(state="SUCCESS", progress=1.0, stage="冻结覆盖已原子发布", finished_at=_now())
                self._write(job)
                self._caches[job["cache_key"]] = jid
                self._active.pop(job["cache_key"], None)
        except Exception as exc:
            with self._lock:
                job = self._job(jid)
                stopped = isinstance(exc, algorithm.FrozenCoverageCancelled) or self._stop.is_set() or job["cancel_requested"]
                job.update(state="CANCELLED" if stopped else "FAILED", finished_at=_now(),
                           error={"code": "CANCELLED" if stopped else str(getattr(exc, "code", "COVERAGE_FAILED")),
                                  "message": str(exc) if isinstance(exc, (algorithm.FrozenCoverageError, algorithm.FrozenCoverageCancelled, CoverageServiceError)) else "覆盖计算或存储失败，结果未发布"},
                           result=None, stage="已取消" if stopped else "计算失败")
                self._write(job)


def create_frozen_coverage_service(*, runtime_root, session_factory=None, terrain_provider=None,
                                   fingerprint_provider=None, source_loader=None, engine=None):
    return FrozenCoverageService(runtime_root=runtime_root, session_factory=session_factory,
        terrain_provider=terrain_provider, fingerprint_provider=fingerprint_provider,
        source_loader=source_loader, engine=engine)
