"""只维护已有规划频点的停用状态，沿用统一资源原子提交及回执。"""
import math
from copy import deepcopy
from datetime import timezone

from pydantic import ValidationError
from sqlalchemy import func, select

from . import resource_dataset_service as datasets
from .frequency_resource_schemas import (
    FrequencyDisableChange, FrequencyDisableValidation, FrequencyResourceQuery,
    FrequencyHistoryQuery, FrequencyOperationQuery, FrequencyPageQuery, FrequencyStoredReceipt,
)
from .resource_dataset_models import ResourceDatasetOperation


def _invalid():
    raise datasets.ResourceDatasetError("规划频点快照字段无效，禁止降级或补零", 5002, 503)


def _number(row, field, minimum=0, *, positive=False, optional=True):
    raw = row.get(field)
    if raw == "" and optional:
        return None
    if not isinstance(raw, str) or not raw.strip():
        _invalid()
    try:
        value = float(raw)
    except ValueError:
        _invalid()
    if not math.isfinite(value) or value < minimum or positive and value == 0:
        _invalid()
    return value


def _text(row, field):
    raw = row.get(field)
    if not isinstance(raw, str):
        _invalid()
    return raw or None


def _item(row):
    frequency_id = row.get("freq_id")
    if not isinstance(frequency_id, str) or not frequency_id or len(frequency_id) > 120 or any(
        char.isspace() or ord(char) < 32 or ord(char) == 127 for char in frequency_id
    ):
        _invalid()
    if row.get("device_class") not in ("HF", "VUHF") or row.get("is_available") not in ("true", "false"):
        _invalid()
    channel = _number(row, "channel_no")
    if channel is not None and not channel.is_integer():
        _invalid()
    return {
        "freq_id": frequency_id, "device_class": row["device_class"],
        "center_freq_khz": _number(row, "center_freq_khz", positive=True, optional=False),
        "bandwidth_khz": _number(row, "bandwidth_khz", positive=True),
        "channel_no": int(channel) if channel is not None else None,
        "is_available": row["is_available"] == "true",
        "occupied_by": _text(row, "occupied_by"),
        "reuse_min_distance_m": _number(row, "reuse_min_distance_m"),
        "adjacent_guard_khz": _number(row, "adjacent_guard_khz"),
        "note": _text(row, "note"),
    }


def _current(revision):
    if not datasets.database_mode():
        raise datasets.ResourceDatasetError("频点维护仅支持已初始化的数据库模式", 5003, 503)
    snapshot = datasets.current()
    if snapshot["revision"] != revision:
        raise datasets.ResourceDatasetError("资源版本已变化，请刷新后重新选择频点", 1205, 409)
    return snapshot


def _selected(snapshot, ids):
    index = {row["freq_id"]: row for row in snapshot["tables"]["frequency_resource.csv"]}
    if any(frequency_id not in index for frequency_id in ids):
        raise datasets.ResourceDatasetError("选中规划频点不存在，整批未保存", 1002, 404)
    rows = [index[frequency_id] for frequency_id in sorted(ids)]
    items = [_item(row) for row in rows]
    return rows, items


def _metadata(snapshot):
    return {
        "revision": snapshot["revision"], "base_revision": snapshot["revision"],
        "data_origin": snapshot["data_origin"], "source": snapshot["source"],
        "content_hash": snapshot["content_hash"],
    }


def load(request: FrequencyResourceQuery):
    snapshot = _current(request.revision)
    items = [_item(row) for row in sorted(
        snapshot["tables"]["frequency_resource.csv"], key=lambda row: row["freq_id"]
    )]
    return {**_metadata(snapshot), "items": items}


def query(request: FrequencyPageQuery):
    snapshot = _current(request.revision)
    values = [_item(row) for row in snapshot["tables"]["frequency_resource.csv"]]
    values = [item for item in values
        if (request.device_class is None or item["device_class"] == request.device_class)
        and (request.availability is None or item["is_available"] == (request.availability == "AVAILABLE"))
        and (request.min_khz is None or item["center_freq_khz"] >= request.min_khz)
        and (request.max_khz is None or item["center_freq_khz"] <= request.max_khz)
        and (not request.search or request.search in item["freq_id"] or request.search in (item["note"] or ""))]
    values.sort(key=lambda item: item["freq_id"])
    first = (request.page - 1) * request.page_size
    return {**_metadata(snapshot), "page": request.page, "page_size": request.page_size,
        "total": len(values), "items": values[first:first + request.page_size]}


def _operation_receipt(row):
    try:
        receipt = FrequencyStoredReceipt.model_validate(row.receipt)
    except ValidationError as error:
        raise datasets.ResourceDatasetError("频点操作回执损坏，禁止推断成功", 5002, 503) from error
    if (receipt.request_id != row.request_id or receipt.base_revision != row.base_revision
        or receipt.revision != row.revision or receipt.source != datasets.SOURCE):
        raise datasets.ResourceDatasetError("频点操作归属或来源损坏", 5002, 503)
    return deepcopy(row.receipt)


def _operation_stamp(row):
    # 底座按 UTC 写入；SQLite 回读没有时区时恢复其既有 UTC 语义。
    stamp = row.created_at
    if stamp is None:
        raise datasets.ResourceDatasetError("频点操作时间缺失", 5002, 503)
    return stamp.replace(tzinfo=timezone.utc).isoformat() if stamp.tzinfo is None else stamp.isoformat()


def _operation_mode():
    if not datasets.database_mode():
        raise datasets.ResourceDatasetError("频点回执只支持数据库模式", 5003, 503)


def get_operation(request: FrequencyOperationQuery, actor_id: str):
    _operation_mode()
    with datasets.get_session_factory()() as session:
        row = session.get(ResourceDatasetOperation, request.request_id)
        if row is None or row.actor_id != actor_id or not isinstance(row.receipt, dict) or row.receipt.get("object_id") != "resource-frequency-disable":
            raise datasets.ResourceDatasetError("频点操作回执不存在", 1002, 404)
        return {"operation": "FREQUENCY_DISABLE", "request_id": row.request_id,
            "created_at": _operation_stamp(row), "receipt": _operation_receipt(row)}


def query_operations(request: FrequencyHistoryQuery, actor_id: str):
    _operation_mode()
    statement = select(ResourceDatasetOperation).where(ResourceDatasetOperation.actor_id == actor_id,
        ResourceDatasetOperation.receipt["object_id"].as_string() == "resource-frequency-disable")
    if request.search:
        # SQLite LIKE 默认忽略 ASCII 大小写；instr 保持与前端一致的字面子串语义。
        statement = statement.where(func.instr(ResourceDatasetOperation.request_id, request.search) > 0)
    with datasets.get_session_factory()() as session:
        total = session.scalar(select(func.count()).select_from(statement.subquery()))
        rows = session.scalars(statement.order_by(ResourceDatasetOperation.created_at.desc(),
            ResourceDatasetOperation.request_id.asc()).offset((request.page - 1) * request.page_size).limit(request.page_size))
        items = []
        for row in rows:
            receipt = _operation_receipt(row)
            items.append({"operation": "FREQUENCY_DISABLE", "request_id": row.request_id,
                "created_at": _operation_stamp(row), "base_revision": row.base_revision, "revision": row.revision,
                "changed": receipt["changed"], "selected_count": len(receipt["selected_ids"]),
                "updated_count": len(receipt["updated"]), "unchanged_count": len(receipt["unchanged"])})
    return {"page": request.page, "page_size": request.page_size, "total": total, "items": items}


def validate_disable(request: FrequencyDisableValidation):
    snapshot = _current(request.revision)
    _, items = _selected(snapshot, request.ids)
    updated = [row["freq_id"] for row in items if row["is_available"]]
    unchanged = [row["freq_id"] for row in items if not row["is_available"]]
    return {
        **_metadata(snapshot), "selected_ids": sorted(request.ids),
        "would_disable": updated, "unchanged": unchanged, "items": items,
        "impact": {"resource_revision_will_change": bool(updated),
            "historical_resources_preserved": True, "saved_plans_require_recompute": bool(updated),
            "link_impact": "UNKNOWN"},
    }


def disable(request: FrequencyDisableChange, actor_id: str):
    def apply(snapshot):
        # 在底座取得同版本写锁后重新核验全部选中项，避免预检与保存之间的覆盖。
        rows, items = _selected(snapshot, request.ids)
        updated = [item["freq_id"] for item in items if item["is_available"]]
        unchanged = [item["freq_id"] for item in items if not item["is_available"]]
        for row in rows:
            if row["is_available"] == "true":
                row["is_available"] = "false"
        return bool(updated), {
            "object_id": "resource-frequency-disable", "request_id": request.request_id,
            "base_revision": request.base_revision, "selected_ids": sorted(request.ids),
            "affected_ids": updated, "updated": updated, "unchanged": unchanged,
            "items": [_item(row) for row in rows], "data_origin": datasets.ORIGIN,
            "source": datasets.SOURCE, "warnings": [],
        }

    canonical = {**request.model_dump(), "ids": sorted(request.ids), "operation": "frequency-resource-disable"}
    return datasets.commit_device_change(request.base_revision, request.request_id,
        datasets.content_hash(canonical), actor_id, apply)
