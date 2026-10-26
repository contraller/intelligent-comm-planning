"""只读 ResourceDataset 历史链，无第二资源库或恢复写操作。"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import timezone
import math

from sqlalchemy import inspect
from sqlalchemy.exc import ArgumentError, SQLAlchemyError
from .database import DatabaseConfigurationError, get_session_factory
from . import resource_dataset_service as datasets
from .resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion, ResourceDatasetOperation
from .device_trace_schemas import SCHEMA


class DeviceTraceError(ValueError):
    def __init__(self, message, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


@contextmanager
def session_scope():
    if not datasets.database_mode():
        raise DeviceTraceError("追溯要求数据库资源模式", 5003, 503)
    try:
        with get_session_factory()() as session:
            inspector = inspect(session.connection())
            if any(not inspector.has_table(model.__tablename__) for model in (ResourceDatasetCurrent, ResourceDatasetVersion, ResourceDatasetOperation)):
                raise DeviceTraceError("资源历史表尚未迁移", 5003, 503)
            yield session
    except (DatabaseConfigurationError, ArgumentError) as exc:
        raise DeviceTraceError("数据库配置无效", 5001, 503) from exc
    except SQLAlchemyError as exc:
        raise DeviceTraceError("资源历史读取失败", 5002, 503) from exc


def _version(session, revision):
    row = session.get(ResourceDatasetVersion, revision)
    if row is None:
        raise DeviceTraceError("资源历史版本不存在", 1002, 404)
    return row, datasets._decode(row)


def _device(snapshot, device_id):
    return next((deepcopy(row) for row in snapshot["tables"]["device.csv"] if row["device_id"] == device_id), None)


def _diff(before, after):
    left, right = before or {}, after or {}
    return [{"field": key, "before": left.get(key), "after": right.get(key),
        "known": left.get(key) not in (None, "") and right.get(key) not in (None, "")}
        for key in sorted(set(left) | set(right)) if left.get(key) != right.get(key)]


def _lineage(session, revision, device_id):
    anchor_row, anchor = _version(session, revision)
    if _device(anchor, device_id) is None:
        raise DeviceTraceError("设备不在指定资源版本中", 1002, 404)
    row, snapshot = anchor_row, anchor
    seen, results, versions = set(), [], {}
    while True:
        if row.revision in seen or len(seen) >= 10000:
            raise DeviceTraceError("资源历史链损坏或超出读取上限", 5002, 503)
        seen.add(row.revision)
        versions[row.revision] = snapshot
        after = _device(snapshot, device_id)
        change = snapshot.get("change")
        if change is None:
            if after is not None:
                results.append({"request_id": None, "device_id": device_id, "kind": "RETAINED_BASELINE", "base_revision": None,
                    "revision": row.revision, "created_at": row.created_at.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                    "actor_id": None, "changed": False, "changed_fields": [], "data_origin": snapshot["data_origin"],
                    "before": None, "after": after, "diffs": [], "source_files": snapshot["source_files"]})
            break
        if not isinstance(change, dict) or any(not isinstance(change.get(key), str) or not change[key] for key in ("parent_revision", "request_id", "actor_id")):
            raise DeviceTraceError("资源历史来源损坏", 5002, 503)
        operation = session.get(ResourceDatasetOperation, change["request_id"])
        if (operation is None or operation.base_revision != change["parent_revision"] or operation.revision != row.revision
                or operation.actor_id != change["actor_id"] or operation.receipt.get("revision") != row.revision
                or operation.receipt.get("changed") is not True):
            raise DeviceTraceError("资源历史回执不符", 5002, 503)
        parent_row, parent = _version(session, change["parent_revision"])
        before = _device(parent, device_id)
        diffs = _diff(before, after)
        if diffs:
            results.append({"request_id": operation.request_id, "device_id": device_id, "kind": "RESOURCE_CHANGE",
                "base_revision": operation.base_revision, "revision": operation.revision,
                "created_at": operation.created_at.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
                "actor_id": operation.actor_id, "changed": True, "changed_fields": [item["field"] for item in diffs],
                "data_origin": snapshot["data_origin"], "before": before, "after": after, "diffs": diffs, "source_files": snapshot["source_files"]})
        row, snapshot = parent_row, parent
    return results, versions


def history(device_id, revision, page=1, page_size=20):
    with session_scope() as session:
        items, _ = _lineage(session, revision, device_id)
        summaries = [{key: value for key, value in row.items() if key not in ("before", "after", "diffs", "source_files")} for row in items]
        return {"schema_version": SCHEMA, "items": summaries[(page - 1) * page_size:page * page_size],
            "total": len(summaries), "page": page, "page_size": page_size}


def detail(device_id, revision, request_id):
    with session_scope() as session:
        items, _ = _lineage(session, revision, device_id)
        result = next((item for item in items if item["request_id"] == request_id), None)
        if result is None:
            raise DeviceTraceError("该设备没有此维护历史", 1002, 404)
        return {"schema_version": SCHEMA, **result}


def _number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def restore_preview(device_id, request):
    with session_scope() as session:
        pointer = session.get(ResourceDatasetCurrent, datasets.SCOPE)
        if pointer is None:
            raise DeviceTraceError("资源未初始化", 5003, 503)
        if pointer.revision != request.base_revision:
            raise DeviceTraceError("资源版本已变化", 1205, 409)
        items, versions = _lineage(session, request.base_revision, device_id)
        source = versions.get(request.source_revision)
        if source is None:
            raise DeviceTraceError("候选不属于当前资源留存历史", 1002, 404)
        if request.source_request_id is not None and not any(item["request_id"] == request.source_request_id and item["revision"] == request.source_revision for item in items):
            raise DeviceTraceError("恢复来源操作与设备不符", 1203, 409)
        old = _device(source, device_id)
        current = _device(versions[request.base_revision], device_id)
        if old is None:
            raise DeviceTraceError("历史版本没有该设备", 1002, 404)
        if old["model_id"] != current["model_id"] or current.get("availability", "ACTIVE") != "ACTIVE":
            raise DeviceTraceError("跨型号或下架设备不可生成恢复候选", 1203, 409)
        model = next(row for row in versions[request.base_revision]["tables"]["device_model.csv"] if row["model_id"] == current["model_id"])
        patch, changes, warnings = {}, [], []
        for field in ("tx_power_dbm", "work_freq_khz", "antenna_height_m"):
            value = _number(old.get(field))
            if value is None:
                warnings.append(field + " 历史值未知，不纳入候选")
                continue
            if (field == "tx_power_dbm" and value > float(model["tx_power_max_dbm"])
                    or field == "work_freq_khz" and not float(model["freq_min_khz"]) <= value <= float(model["freq_max_khz"])
                    or field == "antenna_height_m" and value < 0):
                warnings.append(field + " 不符合当前型号约束，不纳入候选")
                continue
            if value != _number(current.get(field)):
                patch[field] = value
                changes.append({"field": field, "before": _number(current.get(field)), "after": value, "known": True})
        if not patch:
            warnings.append("没有已知且可恢复的参数差异")
        return {"schema_version": SCHEMA, "device_id": device_id, "base_revision": request.base_revision,
            "source_revision": request.source_revision, "source_request_id": request.source_request_id,
            "model_id": current["model_id"], "compatible": bool(patch), "changes": changes, "patch": patch,
            "blocked_fields": ["availability", "status", "alert", "current_work_mode", "ports", "observed_at"],
            "warnings": ["仅恢复候选，尚未保存；须由统一资源底座重新校验", *warnings]}
