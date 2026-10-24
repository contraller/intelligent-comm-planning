"""不可变接收带宽选择；复用覆盖父服务的锁、来源和原子文件底座。"""
from copy import deepcopy
import json
import os
import re
import uuid

from pydantic import ValidationError

from . import frozen_coverage_engine as algorithm
from . import frozen_coverage_service as storage
from .frozen_coverage_bandwidth_schemas import BandwidthSelectionInput


KIND = "FROZEN_COVERAGE_BANDWIDTH_V1"
MAX_RECORD_BYTES = 512 * 1024
SELECTION_ID = re.compile(r"FBS-[0-9a-f]{32}\Z")
DTO_KEYS = ("selection_id", "selection_hash", "source_anchor", "choices", "version_no", "created_at")


def source_anchor(anchor):
    return {key: deepcopy(anchor[key]) for key in algorithm.SELECTION_ANCHOR_KEYS}


def selection_id(value):
    if not isinstance(value, str) or not SELECTION_ID.fullmatch(value):
        raise storage.CoverageServiceError("接收带宽选择编号无效")
    return value


def _invalid():
    raise storage.CoverageServiceError("持久接收带宽选择无法核验", 5002, 503)


class FrozenCoverageBandwidthService:
    def __init__(self, parent):
        self.parent = parent
        self.root = parent.root / "bandwidth-selections"

    def _path(self, sid):
        path = self.root / (selection_id(sid) + ".json")
        if self.root.is_symlink() or self.root.exists() and not self.root.is_dir() or path.is_symlink():
            _invalid()
        return path

    def _record(self, sid):
        path = self._path(sid)
        if not path.exists():
            raise storage.CoverageServiceError("接收带宽选择版本不存在", 2001, 404)
        try:
            if path.stat().st_size > MAX_RECORD_BYTES:
                _invalid()
        except OSError as exc:
            raise storage.CoverageServiceError("接收带宽选择文件无法读取", 5002, 503) from exc
        record = storage._read(path)
        try:
            payload = {key: value for key, value in record.items() if key != "record_sha256"}
            body = record["request_body"]
            original = BandwidthSelectionInput.model_validate({key: value for key, value in body.items() if key != "plan_id"})
            choices = record["choices"]
            checked = BandwidthSelectionInput.model_validate({**original.model_dump(), "choices": choices})
            normalized = sorted(({"device_id": row.device_id, "rx_bandwidth_khz": float(row.rx_bandwidth_khz)}
                                 for row in checked.choices), key=lambda row: row["device_id"])
            requested = sorted(({"device_id": row.device_id, "rx_bandwidth_khz": float(row.rx_bandwidth_khz)}
                                 for row in original.choices), key=lambda row: row["device_id"])
            anchor = record["source_anchor"]
            valid = (record["kind"] == KIND and type(record["schema_version"]) is int and record["schema_version"] == 1
                and record["selection_id"] == sid and record["record_sha256"] == storage._hash(payload)
                and isinstance(anchor, dict) and set(anchor) == set(algorithm.SELECTION_ANCHOR_KEYS)
                and all(isinstance(anchor[key], str) and re.fullmatch(r"[0-9a-f]{64}", anchor[key])
                        for key in ("resource_content_hash", "plan_input_sha256", "raw_snapshot_sha256",
                                    "frozen_tables_sha256", "terrain_fingerprint"))
                and anchor["plan_id"] == body["plan_id"] and anchor["task_id"] == body["task_id"]
                and anchor["snapshot_id"] == body["snapshot_id"]
                and record["request_id"] == body["request_id"]
                and record["request_digest"] == storage._hash(body)
                and bool(storage._id(record["actor_id"])) and isinstance(record["created_at"], str)
                and type(record["version_no"]) is int and record["version_no"] > 0
                and choices == normalized == requested and len({row["device_id"] for row in choices}) == len(choices)
                and record["selection_hash"] == storage._hash(dict(schema_version=1, source_anchor=anchor, choices=choices)))
        except (KeyError, TypeError, ValueError, OverflowError):
            valid = False
        if not valid:
            _invalid()
        return record

    @staticmethod
    def _dto(record):
        return deepcopy({key: record[key] for key in DTO_KEYS})

    def scan(self):
        with self.parent._lock:
            if self.root.is_symlink() or self.root.exists() and not self.root.is_dir():
                _invalid()
            requests, versions, latest = {}, set(), {}
            for path in sorted(self.root.glob("FBS-*.json")):
                if not SELECTION_ID.fullmatch(path.stem):
                    _invalid()
                record = self._record(path.stem)
                rid = record["request_id"]
                source = storage._hash(record["source_anchor"])
                version = (source, record["version_no"])
                if rid in requests or version in versions:
                    _invalid()
                requests[rid] = record
                versions.add(version)
                if source not in latest or record["version_no"] > latest[source]["version_no"]:
                    latest[source] = record
            return requests, latest

    def current(self, anchor):
        _, latest = self.scan()
        record = latest.get(storage._hash(source_anchor(anchor)))
        return self._dto(record) if record else None

    def get(self, sid, anchor, *, source=None):
        with self.parent._lock:
            record = self._record(sid)
            if record["source_anchor"] != source_anchor(anchor):
                raise storage.CoverageServiceError("接收带宽选择与冻结方案来源不一致", 1205, 409)
            result = self._dto(record)
            if source is not None:
                try:
                    algorithm._selection_choices(source["raw_snapshot"], source["tables"], result)
                except algorithm.FrozenCoverageError as exc:
                    raise storage.CoverageServiceError("持久选值无法由冻结型号核验", 5002, 503) from exc
            return result

    def save(self, plan_id, body, actor_id, *, audit_context=None):
        original = deepcopy(body)
        try:
            BandwidthSelectionInput.model_validate(original)
        except ValidationError as exc:
            raise storage.CoverageServiceError("接收带宽选择请求无效") from exc
        plan_id, actor_id = storage._id(plan_id), storage._id(actor_id)
        if audit_context is not None or os.environ.get("AUTH_MODE") == "LOCAL_PASSWORD":
            from .planning_operation_service import _business_context
            context = _business_context(audit_context)
            if not context._writing or context.actor.account_id != actor_id:
                raise storage.CoverageServiceError("选择保存需要同一账号的可信写上下文", 1104, 403)
        request_body = {"plan_id": plan_id, **original}
        if len(json.dumps(original, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")) > 128 * 1024:
            raise storage.CoverageServiceError("接收带宽选择请求超过128KiB限额")
        digest = storage._hash(request_body)
        with self.parent._lock:
            if self.parent._storage_fault:
                raise self.parent._storage_fault
            if (self.parent._owner is None or self.parent._thread is None
                    or not self.parent._thread.is_alive() or self.parent._stop.is_set()):
                raise storage.CoverageServiceError("覆盖worker尚未显式持锁启动", 5003, 503)
            source, anchor = self.parent._source(plan_id, original["task_id"], original["snapshot_id"],
                                                 audit_context=audit_context)
            try:
                choices = algorithm.validate_bandwidth_choices(source["raw_snapshot"], source["tables"], original["choices"])
            except algorithm.FrozenCoverageError as exc:
                raise storage.CoverageServiceError(str(exc)) from exc
            requests, latest = self.scan()
            existing = requests.get(original["request_id"])
            if existing:
                if existing["actor_id"] != actor_id or existing["request_digest"] != digest:
                    raise storage.CoverageServiceError("选择请求号归属或正文冲突", 1204, 409)
                if existing["source_anchor"] != source_anchor(anchor):
                    raise storage.CoverageServiceError("选择请求来源已变化", 1205, 409)
                return self._dto(existing), 200
            frozen = source_anchor(anchor)
            previous = latest.get(storage._hash(frozen))
            record = dict(kind=KIND, schema_version=1, selection_id="FBS-" + uuid.uuid4().hex,
                source_anchor=frozen, choices=choices,
                selection_hash=storage._hash(dict(schema_version=1, source_anchor=frozen, choices=choices)),
                version_no=previous["version_no"] + 1 if previous else 1, created_at=storage._now(),
                actor_id=actor_id, request_id=original["request_id"], request_body=request_body, request_digest=digest)
            record["record_sha256"] = storage._hash(record)
            if len(json.dumps(record, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")) > MAX_RECORD_BYTES:
                raise storage.CoverageServiceError("接收带宽选择持久记录超过512KiB限额")
            path = self._path(record["selection_id"])
            if path.exists():
                _invalid()
            try:
                self.root.mkdir(parents=True, exist_ok=True)
                storage._atomic(path, record)
            except (OSError, ValueError) as exc:
                raise storage.CoverageServiceError("接收带宽选择未能原子保存", 5002, 503) from exc
            return self._dto(record), 201
