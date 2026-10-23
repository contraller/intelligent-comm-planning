"""首个前端任务保存闭环所需的只读联调契约。"""
from __future__ import annotations

import csv
import hashlib
import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from . import resource_dataset_service as resource_dataset
from .resource_read_filter import filter_device_items, sort_device_items
from .resource_export_schemas import ResourceDeviceFilter


REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_FILES = {
    "nodes": REPO_ROOT / "data/synthetic/nodes/nodes_v1.csv",
    "devices": REPO_ROOT / "data/synthetic/nodes/devices_v1.csv",
    "models": REPO_ROOT / "data/synthetic/nodes/device_models_v1.csv",
    "antennas": REPO_ROOT / "data/synthetic/nodes/antenna_models_v1.csv",
    "frequencies": REPO_ROOT / "data/synthetic/frequency/frequency_resources_v1.csv",
    "interferences": REPO_ROOT / "data/synthetic/interference/interference_sources_v1.csv",
}

SESSION_ID = "frontend-integration-session"
CSRF_TOKEN = "frontend-integration-csrf"


def integration_enabled() -> bool:
    """固定联调身份必须显式开启，避免被误当作正式认证。"""
    return os.environ.get("FRONTEND_INTEGRATION_DEMO") == "1"


def session_identity() -> dict[str, Any]:
    return {
        "session_id": SESSION_ID,
        "account_id": "integration-planner",
        "username": "integration-planner",
        "display_name": "前端联调规划员",
        "role_id": "integration-planner-role",
        "role_name": "前端联调规划员",
        "permissions": [
            "planning.view",
            "planning.execute",
            "planning.save",
            "planning.confirm",
            "resources.view",
            "situation.view",
        ],
        # 权限变化同步更新会话代次，旧页面须重新读取身份。
        "identity_revision": "integration-identity-v2",
        "session_generation": "integration-session-v2",
    }


def csrf_challenge() -> dict[str, str]:
    return {"csrf_token": CSRF_TOKEN, "session_id": SESSION_ID}


def _rows(name: str) -> list[dict[str, str]]:
    if resource_dataset.database_mode():
        from copy import deepcopy
        return deepcopy(resource_dataset.current()["tables"][resource_dataset.PRIMARY_NAMES[name]])
    with DATA_FILES[name].open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def _optional_number(value: str | None) -> float | None:
    text = str(value or "").strip()
    return float(text) if text else None


def _number(value: str | None, default: float = 0.0) -> float:
    result = _optional_number(value)
    return default if result is None else result


def _boolean(value: str | None) -> bool:
    return str(value or "").strip().lower() == "true"


def _status(value: str | None) -> str | None:
    # 导入的显式 UNKNOWN 与空状态都不构造告警或正常结论。
    return None if value in (None, "", "UNKNOWN") else value


def _envelope(data: Any, code: int = 0, message: str = "success") -> dict[str, Any]:
    return {"code": code, "message": message, "data": data}


def resource_revision() -> str:
    if resource_dataset.database_mode():
        return resource_dataset.current()["revision"]
    digest = hashlib.sha256()
    for path in DATA_FILES.values():
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return f"resource-{digest.hexdigest()[:16]}"


def task_reference_catalog() -> dict[str, Any]:
    """为任务预检读取与资源接口相同的节点、设备及型号来源。"""
    nodes = _rows("nodes")
    models = {row["model_id"]: row["device_class"] for row in _rows("models")}
    devices = {row["device_id"]: {
        "node_id": row["node_id"],
        "device_class": models.get(row["model_id"]),
        "availability": row.get("availability", "ACTIVE"),
    } for row in _rows("devices")}
    return {"node_ids": {row["node_id"] for row in nodes}, "devices": devices}


def _updated_at() -> str:
    if resource_dataset.database_mode():
        return resource_dataset.current()["source_updated_at"]
    timestamp = max(path.stat().st_mtime for path in DATA_FILES.values())
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def _bounds(nodes: Iterable[dict[str, str]]) -> list[float]:
    points = [(float(row["lon"]), float(row["lat"])) for row in nodes]
    longitudes, latitudes = zip(*points)
    return [min(longitudes), min(latitudes), max(longitudes), max(latitudes)]


def _node_item(row: dict[str, str], nodes: list[dict[str, str]],
               devices: list[dict[str, str]]) -> dict[str, Any]:
    node_id = row["node_id"]
    return {
        **row,
        "lon": float(row["lon"]),
        "lat": float(row["lat"]),
        "elevation_m": _optional_number(row.get("elevation_m")),
        "relay_capable": _boolean(row.get("relay_capable")),
        "is_key": _boolean(row.get("is_key")),
        "status": _status(row.get("status")),
        "alert": None if _status(row.get("status")) is None else row["status"] != "NORMAL",
        "origin": row.get("origin", "SOURCE"),
        "child_count": sum(1 for item in nodes if node_id in item.get("parent_node_id", "").split(";")),
        "device_count": sum(1 for item in devices if item.get("node_id") == node_id),
    }


def _device_item(row: dict[str, str], nodes: list[dict[str, str]],
                 models: list[dict[str, str]], antennas: list[dict[str, str]]) -> dict[str, Any]:
    node = next(item for item in nodes if item["node_id"] == row["node_id"])
    model = next(item for item in models if item["model_id"] == row["model_id"])
    antenna = next(item for item in antennas if item["antenna_id"] == row["antenna_id"])
    return {
        **row,
        "node_name": node["node_name"],
        "node_lon": float(node["lon"]),
        "node_lat": float(node["lat"]),
        "model_name": model["model_name"],
        "antenna_name": antenna["antenna_name"],
        "device_class": model["device_class"],
        "status": _status(row.get("status")),
        "region": node.get("region"),
        "mobility": node.get("mobility") or None,
        "node_role": node.get("node_role") or None,
        "relay_capable": None if not node.get("relay_capable") else _boolean(node["relay_capable"]),
        "freq_min_khz": _optional_number(model.get("freq_min_khz")),
        "freq_max_khz": _optional_number(model.get("freq_max_khz")),
        "antenna_height_m": _optional_number(row.get("antenna_height_m")),
        "tx_power_dbm": _optional_number(row.get("tx_power_dbm")),
        "work_freq_khz": _optional_number(row.get("work_freq_khz")),
        "tilt_deg": _optional_number(row.get("tilt_deg")),
        "azimuth_deg": _optional_number(row.get("azimuth_deg")),
        "alert": None if _status(row.get("status")) is None else row["status"] != "NORMAL",
        "origin": row.get("origin", "SOURCE"),
        "availability": row.get("availability", "ACTIVE"),
    }


def _interference_item(row: dict[str, str]) -> dict[str, Any]:
    return {
        **row,
        "interference_name": row["name"],
        "lon": float(row["lon"]),
        "lat": float(row["lat"]),
        "elevation_m": _optional_number(row.get("elevation_m")),
        "antenna_height_m": _number(row.get("antenna_height_m")),
        "center_freq_khz": _number(row.get("center_freq_khz")),
        "bandwidth_khz": _number(row.get("bandwidth_khz")),
        "tx_power_dbm": _number(row.get("tx_power_dbm")),
        "antenna_gain_dbi": _optional_number(row.get("antenna_gain_dbi")),
        "azimuth_deg": _optional_number(row.get("azimuth_deg")),
        "duty_cycle": _optional_number(row.get("duty_cycle")),
        "active": _boolean(row.get("active")),
        "origin": row.get("origin", "SOURCE"),
    }


def resource_context() -> dict[str, Any]:
    nodes, devices, models = _rows("nodes"), _rows("devices"), _rows("models")
    # 地形版本独立于资源表版本，供前端核对已打包的 DEM 底图。
    try:
        terrain_meta = json.loads((REPO_ROOT / "data/raw/dem/dem_current.json").read_text(
            encoding="utf-8"))
        terrain = {
            "source_sha256": terrain_meta["source_sha256"],
            "bbox": terrain_meta["bbox"],
            "source": terrain_meta["source"],
        }
    except (OSError, ValueError, KeyError, TypeError):
        terrain = None
    classes = Counter(next(model["device_class"] for model in models
                           if model["model_id"] == device["model_id"])
                      for device in devices)
    device_alerts = sum(_status(device.get("status")) not in (None, "NORMAL") for device in devices)
    nodes_by_id = {node["node_id"]: node for node in nodes}
    classes_by_model = {model["model_id"]: model["device_class"] for model in models}
    deployments = {kind: {mode: 0 for mode in ("FIXED", "VEHICLE", "MANPACK", "UNKNOWN")} for kind in ("HF", "VUHF")}
    for device in devices:
        kind = classes_by_model[device["model_id"]]
        mode = nodes_by_id[device["node_id"]].get("mobility", "UNKNOWN")
        deployments[kind][mode if mode in ("FIXED", "VEHICLE", "MANPACK") else "UNKNOWN"] += 1
    return _envelope({
        "revision": resource_revision(),
        "bounds": _bounds(nodes),
        "updated_at": _updated_at(),
        "source": "项目现有节点、设备及频率资源数据",
        "terrain": terrain,
        "stats": {
            "nodes": len(nodes),
            "devices": len(devices),
            "models": len(models),
            "interferences": len(_rows("interferences")),
            "hf": classes["HF"],
            "vuhf": classes["VUHF"],
            "deployments": deployments,
            "alerts": device_alerts,
            "unknown_alerts": sum(_status(device.get("status")) is None for device in devices),
            "active": sum(row.get("availability", "ACTIVE") == "ACTIVE" for row in devices),
            "off_shelf": sum(row.get("availability", "ACTIVE") == "OFF_SHELF" for row in devices),
            "unknown_availability": 0,
        },
    })


def _assert_revision(revision: str) -> None:
    current = resource_revision()
    if revision != current:
        raise ValueError(f"资源版本已变化：期望 {revision}，当前 {current}")


def resource_map(revision: str, bbox: list[float], zoom: float,
                 show_nodes: bool, show_interferences: bool) -> dict[str, Any]:
    _assert_revision(revision)
    if len(bbox) != 4 or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ValueError("bbox 必须是有效的 [minLon,minLat,maxLon,maxLat]")

    def inside(lon: float, lat: float) -> bool:
        return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]

    points: list[dict[str, Any]] = []
    if show_nodes:
        for row in _rows("nodes"):
            lon, lat = float(row["lon"]), float(row["lat"])
            if inside(lon, lat):
                points.append({
                    "kind": "node", "id": row["node_id"], "name": row["node_name"],
                    "lon": lon, "lat": lat, "status": _status(row.get("status")),
                    "alert": None if _status(row.get("status")) is None else row["status"] != "NORMAL",
                })
    if show_interferences:
        for row in _rows("interferences"):
            lon, lat = float(row["lon"]), float(row["lat"])
            if inside(lon, lat):
                points.append({
                    "kind": "interference", "id": row["interference_id"], "name": row["name"],
                    "lon": lon, "lat": lat, "active": _boolean(row.get("active")),
                })
    return _envelope({
        "revision": revision,
        "bbox": bbox,
        "zoom": zoom,
        "points": points,
        "clusters": [],
        "total_nodes": sum(item["kind"] == "node" for item in points),
        "total_interferences": sum(item["kind"] == "interference" for item in points),
    })


def resource_object(kind: str, object_id: str, revision: str) -> dict[str, Any]:
    _assert_revision(revision)
    nodes, devices = _rows("nodes"), _rows("devices")
    if kind == "node":
        row = next((item for item in nodes if item["node_id"] == object_id), None)
        item = _node_item(row, nodes, devices) if row else None
    elif kind == "device":
        row = next((item for item in devices if item["device_id"] == object_id), None)
        item = _device_item(row, nodes, _rows("models"), _rows("antennas")) if row else None
    else:
        row = next((item for item in _rows("interferences")
                    if item["interference_id"] == object_id), None)
        item = _interference_item(row) if row else None
    if item is None:
        raise KeyError(object_id)
    return _envelope({"revision": revision, "item": item})


def resource_page(kind: str, revision: str, page: int, page_size: int,
                  search: str = "", node_id: str | None = None,
                  parent_id: str | None = None, availability: str | None = None,
                  device_filter: ResourceDeviceFilter | None = None,
                  sort: str = "id", order: str = "asc") -> dict[str, Any]:
    """返回前端资源树需要的稳定分页，不在读取时改写源数据。"""
    _assert_revision(revision)
    if page < 1 or page_size not in {5, 10, 20, 50}:
        raise ValueError("资源分页参数无效")
    nodes, devices = _rows("nodes"), _rows("devices")
    if kind == "node":
        rows = nodes
        if parent_id is not None:
            rows = [row for row in rows if (row.get("parent_node_id") or "") == parent_id]
        items = [_node_item(row, nodes, devices) for row in rows]
        names = lambda item: (item["node_id"], item["node_name"])
    elif kind == "device":
        rows = devices if node_id is None else [row for row in devices if row["node_id"] == node_id]
        if availability is not None:
            if availability not in {"ACTIVE", "OFF_SHELF", "UNKNOWN"}:
                raise ValueError("上下架筛选无效")
            rows = [row for row in rows if row.get("availability", "ACTIVE") == availability]
        models, antennas = _rows("models"), _rows("antennas")
        items = [_device_item(row, nodes, models, antennas) for row in rows]
        items = filter_device_items(items, device_filter or ResourceDeviceFilter(search=search))
        names = lambda item: (item["device_id"], item["model_name"], item["node_name"])
    else:
        items = [_interference_item(row) for row in _rows("interferences")]
        names = lambda item: (item["interference_id"], item["interference_name"])
    term = search.strip().lower()
    if term and kind != "device":
        items = [item for item in items if any(term in str(value).lower() for value in names(item))]
    id_field = {"node": "node_id", "device": "device_id", "interference": "interference_id"}[kind]
    if kind == "device":
        items = sort_device_items(items, sort, order)
    else:
        items.sort(key=lambda item: item[id_field])
    total = len(items)
    start = (page - 1) * page_size
    return _envelope({
        "revision": revision,
        "items": items[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


def resource_dictionary(kind: str, ids: str | None, revision: str) -> dict[str, Any]:
    _assert_revision(revision)
    wanted = set(str(ids or "").split(",")) if ids else None
    rows = _rows("models" if kind == "model" else "antennas")
    id_field = "model_id" if kind == "model" else "antenna_id"
    if wanted is not None:
        rows = [row for row in rows if row[id_field] in wanted]
    items: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = dict(row)
        if kind == "model":
            for field in ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm"):
                item[field] = _number(row.get(field))
        items.append(item)
    return _envelope({"revision": revision, "items": items})


def planning_frequency_catalog() -> dict[str, Any]:
    resources = _rows("frequencies")
    rows = [row for row in resources if _boolean(row.get("is_available"))]
    groups: dict[str, list[float]] = {}
    for row in rows:
        groups.setdefault(row["device_class"], []).append(float(row["center_freq_khz"]))
    items = [{
        "id": f"available-{device_class.lower()}",
        "label": f"{device_class} 可用频率资源",
        "min_khz": min(values),
        "max_khz": max(values),
    } for device_class, values in sorted(groups.items())]
    # 规划页同时展示禁用频点和构造扩容来源，不把测试资源冒充正式获批资源。
    frequency_resources = [{
        "freq_id": row["freq_id"],
        "device_class": row["device_class"],
        "center_freq_khz": _number(row.get("center_freq_khz")),
        # 人工频点可未提供带宽/保护参数；缺值不能投影为零带宽。
        "bandwidth_khz": _optional_number(row.get("bandwidth_khz")),
        "channel_no": int(row["channel_no"]) if str(row.get("channel_no") or "").strip() else None,
        "is_available": _boolean(row.get("is_available")),
        "occupied_by": row.get("occupied_by") or None,
        "reuse_min_distance_m": _optional_number(row.get("reuse_min_distance_m")),
        "adjacent_guard_khz": _optional_number(row.get("adjacent_guard_khz")),
        "note": row.get("note") or None,
    } for row in resources]
    return _envelope({"revision": f"catalog-{resource_revision()}", "items": items,
                      "frequency_resources": frequency_resources})


def planning_preset_catalog() -> dict[str, Any]:
    nodes = _rows("nodes")
    selected = [node["node_id"] for node in nodes[:3]]
    bbox = _bounds(nodes)
    frequency_id = "available-hf"
    definitions = [
        ("balanced", "均衡规划"),
        ("reliable", "高可靠规划"),
        ("economical", "经济规划"),
    ]
    items = []
    for preset_id, label in definitions:
        items.append({
            "id": preset_id,
            "label": label,
            "description": "使用项目节点与构造测试频率资源",
            "defaults": {
                "name": f"{label}任务",
                "description": "前端与算法服务首个任务保存联调",
                "bbox": bbox,
                "stationIds": selected,
                "presetId": preset_id,
                "frequencyId": frequency_id,
                "startTime": None,
                "durationH": None,
                "constraints": {
                    "connectivityPercent": 100,
                    "maxRelayHops": 2,
                    "survivabilityPercent": 90,
                },
                "demands": [{
                    "id": "DEMAND-01",
                    "sourceId": selected[0],
                    "targetId": selected[1],
                    "endpointMode": "station",
                    "sourceDeviceId": None,
                    "targetDeviceId": None,
                    "preferredClass": None,
                    "service": "数据",
                    "priority": "P1",
                    "mandatory": True,
                    "dataVolumeMb": 10,
                    "requiredRateKbps": 64,
                    "maxDelayMs": 100,
                    "minReliability": 0.95,
                }],
            },
        })
    return _envelope({"revision": f"catalog-{resource_revision()}", "items": items})
