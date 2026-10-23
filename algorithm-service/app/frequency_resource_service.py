"""只维护已有规划频点的停用状态，沿用统一资源原子提交及回执。"""
import math

from . import resource_dataset_service as datasets
from .frequency_resource_schemas import (
    FrequencyDisableChange, FrequencyDisableValidation, FrequencyResourceQuery,
)


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
