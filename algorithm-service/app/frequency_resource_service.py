"""规划构造频点维护，沿用统一资源原子提交、不可变版本及回执。"""
import math
from copy import deepcopy
from datetime import timezone

from pydantic import ValidationError
from sqlalchemy import func, select

from . import resource_dataset_service as datasets
from .frequency_resource_schemas import (
    FrequencyDisableChange, FrequencyDisableValidation, FrequencyResourceQuery,
    FrequencyHistoryQuery, FrequencyOperationQuery, FrequencyPageQuery, FrequencyStoredReceipt,
    FrequencyChangesChange, FrequencyChangesValidation,
)
from .resource_dataset_models import ResourceDatasetOperation, ResourceDatasetVersion

OPERATIONS = {"resource-frequency-disable": "FREQUENCY_DISABLE", "resource-frequency-changes": "FREQUENCY_CHANGES"}
CONSTRUCTED_NOTE = "[人工构造规划频点；非正式频率授权] "


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
        if row is None or row.actor_id != actor_id or not isinstance(row.receipt, dict) or row.receipt.get("object_id") not in OPERATIONS:
            raise datasets.ResourceDatasetError("频点操作回执不存在", 1002, 404)
        return {"operation": OPERATIONS[row.receipt["object_id"]], "request_id": row.request_id,
            "created_at": _operation_stamp(row), "receipt": _operation_receipt(row)}


def query_operations(request: FrequencyHistoryQuery, actor_id: str):
    _operation_mode()
    statement = select(ResourceDatasetOperation).where(ResourceDatasetOperation.actor_id == actor_id,
        ResourceDatasetOperation.receipt["object_id"].as_string().in_(OPERATIONS))
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
            items.append({"operation": OPERATIONS[receipt["object_id"]], "request_id": row.request_id,
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


def _reject(message):
    raise datasets.ResourceDatasetError(message, 1001, 422)


def _capability(snapshot, item):
    intervals = []
    for model in snapshot["tables"]["device_model.csv"]:
        if model.get("device_class") != item["device_class"]:
            continue
        low, high = _number(model, "freq_min_khz", positive=True), _number(model, "freq_max_khz", positive=True)
        if low is None or high is None:
            continue
        if low > high:
            _invalid()
        intervals.append((low, high))
    merged = []
    for low, high in sorted(intervals):
        if merged and low <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(high, merged[-1][1]))
        else:
            merged.append((low, high))
    # 未知带宽只验证已知中心频率，不推断其占用为零或已获得频率许可。
    half = item["bandwidth_khz"] / 2 if item["bandwidth_khz"] is not None else 0
    if not any(low <= item["center_freq_khz"] - half and item["center_freq_khz"] + half <= high for low, high in merged):
        _reject("频率或已知带宽超出当前同类别型号可验证频率能力并集")


def _enable_proofs(revision, ids):
    requested, added_ids, disabled_ids, visited = set(ids), set(), set(), set()
    if not requested:
        return set()
    # 只接受当前版本祖先链的原子回执，不扫描旁支或用备注充当启用证明。
    with datasets.get_session_factory()() as session:
        while True:
            if revision in visited:
                _invalid()
            visited.add(revision)
            child = session.get(ResourceDatasetVersion, revision)
            if child is None:
                _invalid()
            child_data = datasets._decode(child)
            change = child_data.get("change")
            if change is None:
                break
            if not isinstance(change, dict) or not all(isinstance(change.get(key), str) for key in ("parent_revision", "request_id", "actor_id")):
                _invalid()
            parent_row = session.get(ResourceDatasetVersion, change["parent_revision"])
            if parent_row is None:
                _invalid()
            parent = datasets._decode(parent_row)
            operation = session.get(ResourceDatasetOperation, change["request_id"])
            if operation is None or operation.actor_id != change["actor_id"] or operation.revision != revision or operation.base_revision != parent["revision"]:
                _invalid()
            if isinstance(operation.receipt, dict) and operation.receipt.get("object_id") in OPERATIONS:
                receipt = _operation_receipt(operation)
                before = {row["freq_id"]: row for row in parent["tables"]["frequency_resource.csv"]}
                after = {row["freq_id"]: row for row in child_data["tables"]["frequency_resource.csv"]}
                for item in receipt["items"]:
                    key = item["freq_id"]
                    if key not in requested or key not in receipt["updated"]:
                        continue
                    if key not in after or _item(after[key]) != item:
                        _invalid()
                    added = receipt["object_id"] == "resource-frequency-changes" and key not in before and item["is_available"] is False and item["occupied_by"] is None
                    disabled = receipt["object_id"] == "resource-frequency-disable" and key in before and _item(before[key])["is_available"] is True and item["is_available"] is False
                    if added:
                        added_ids.add(key)
                    if disabled:
                        disabled_ids.add(key)
            revision = parent["revision"]
    original = {row["freq_id"]: row for row in child_data["tables"]["frequency_resource.csv"]}
    return {key for key in requested if key in added_ids and key not in original
        or key in disabled_ids and key in original and _item(original[key])["is_available"]}


def _constructed_note(note):
    result = note if note is None or note.startswith(CONSTRUCTED_NOTE) else CONSTRUCTED_NOTE + note
    if result is not None and len(result) > 2000:
        _reject("构造备注含来源标识不得超过2000字符")
    return result


def _change_items(snapshot, revision, actions):
    rows = {row["freq_id"]: row for row in snapshot["tables"]["frequency_resource.csv"]}
    enabling = [action.freq_id for action in actions if action.kind == "ENABLE" and action.freq_id in rows and not _item(rows[action.freq_id])["is_available"]]
    proofs = _enable_proofs(revision, enabling)
    result, updated, unchanged = [], [], []
    for action in sorted(actions, key=lambda value: value.freq_id):
        key = action.freq_id
        if action.kind == "ADD":
            if key in rows:
                _reject("新增频点编号已存在，整批未保存")
            before = None
            after = {"freq_id": key, **action.item.model_dump(), "is_available": False, "occupied_by": None}
            after["note"] = _constructed_note(after["note"])
        else:
            if key not in rows:
                raise datasets.ResourceDatasetError("维护频点不存在，整批未保存", 1002, 404)
            before = _item(rows[key]); after = deepcopy(before)
            if action.kind == "PATCH":
                after.update(action.fields.model_dump(exclude_unset=True))
                if after != before:
                    after["note"] = _constructed_note(after["note"])
            elif not before["is_available"]:
                if key not in proofs:
                    _reject("频点缺少系统停用或系统新增的祖先证明，禁止启用来源预留禁用点")
                after["is_available"] = True
        if action.kind != "ENABLE" or after != before:
            _capability(snapshot, after)
        (updated if after != before else unchanged).append(key)
        result.append({"kind": action.kind, "freq_id": key, "before": before, "after": after})
    return result, updated, unchanged


def validate_changes(request: FrequencyChangesValidation):
    snapshot = _current(request.revision)
    items, updated, unchanged = _change_items(snapshot, request.revision, request.changes)
    return {**{key: value for key, value in _metadata(snapshot).items() if key != "content_hash"},
        "selected_ids": [item["freq_id"] for item in items], "would_change": updated, "unchanged": unchanged, "items": items,
        "impact": {"resource_revision_will_change": bool(updated), "historical_resources_preserved": True,
            "saved_plans_require_recompute": bool(updated), "link_impact": "UNKNOWN"}}


def commit_changes(request: FrequencyChangesChange, actor_id: str):
    def apply(snapshot):
        items, updated, unchanged = _change_items(snapshot, request.base_revision, request.changes)
        rows = {row["freq_id"]: row for row in snapshot["tables"]["frequency_resource.csv"]}
        for item in items:
            if item["freq_id"] not in updated:
                continue
            values = {key: "" if value is None else str(value).lower() if isinstance(value, bool) else str(value) for key, value in item["after"].items()}
            if item["kind"] == "ADD":
                snapshot["tables"]["frequency_resource.csv"].append(values)
            else:
                rows[item["freq_id"]].update({key: value for key, value in values.items() if item["after"][key] != item["before"][key]})
        return bool(updated), {"object_id": "resource-frequency-changes", "request_id": request.request_id,
            "base_revision": request.base_revision, "selected_ids": [item["freq_id"] for item in items],
            "affected_ids": updated, "updated": updated, "unchanged": unchanged,
            "items": [item["after"] for item in items], "data_origin": datasets.ORIGIN, "source": datasets.SOURCE, "warnings": []}

    canonical = {**request.model_dump(exclude_unset=True), "operation": "frequency-resource-changes-v1"}
    canonical["changes"] = sorted(canonical["changes"], key=lambda value: value["freq_id"])
    return datasets.commit_device_change(request.base_revision, request.request_id,
        datasets.content_hash(canonical), actor_id, apply)
