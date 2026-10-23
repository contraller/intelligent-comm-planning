"""将 SR4 原始方案转换为前端规划结果契约。"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from copy import deepcopy
from typing import Any

from . import planning_w4


_LINK_STATES = {"EXCELLENT", "GOOD", "WARNING", "FAULT"}


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes"}


def _coordinate(row: dict[str, Any]) -> list[float]:
    node_id = str(row.get("node_id") or "未提供编号")
    longitude = _number(row.get("lon"))
    latitude = _number(row.get("lat"))
    if (longitude is None or latitude is None
            or not -180 <= longitude <= 180 or not -90 <= latitude <= 90):
        raise ValueError(f"节点 {node_id} 的经纬度无效")
    return [longitude, latitude]


def _derived_device_id(node_id: str, band: str) -> str:
    digest = hashlib.sha256(f"{node_id}:{band}".encode("utf-8")).hexdigest()[:12]
    return f"PD-{digest}"


def _link_state(row: dict[str, Any]) -> str:
    value = str(row.get("link_state") or "").upper()
    if value in _LINK_STATES:
        return value
    if not _bool(row.get("is_available", True)):
        return "FAULT"
    margin = _number(row.get("link_margin_db"))
    if margin is None or margin < 3:
        return "FAULT"
    if margin < 10:
        return "WARNING"
    if margin < 20:
        return "GOOD"
    return "EXCELLENT"


def _frequency_by_link(detail: dict[str, Any]) -> dict[str, float]:
    result: dict[str, float] = {}
    for row in detail.get("frequency", {}).get("link_assignments", []):
        frequency = _number(row.get("freq_khz"))
        if frequency is None or frequency < 0:
            continue
        members = row.get("member_link_ids") or [row.get("link_id")]
        for link_id in members:
            if link_id:
                result[str(link_id)] = frequency
    return result


def _route_rows(detail: dict[str, Any], demand_ids: set[str],
                link_ids: set[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for route in detail.get("routes", {}).get("routes", []):
        demand_id = str(route.get("demand_id") or "")
        if demand_id not in demand_ids or not route.get("reachable"):
            continue
        for label, backup in (("PRIMARY", False), ("BACKUP", True)):
            path = route.get(label.lower())
            if not isinstance(path, dict):
                continue
            nodes = [str(value) for value in path.get("node_path") or []]
            links = [str(value) for value in path.get("link_path") or []]
            if len(nodes) < 2 or len(links) != len(nodes) - 1:
                continue
            if any(link_id not in link_ids for link_id in links):
                continue
            rows.append({
                "id": f"{demand_id}-{label}",
                "demandId": demand_id,
                "nodeIds": nodes,
                "linkIds": links,
                "backup": backup,
            })
    return rows


def _checks(plan: dict[str, Any], input_data: dict[str, Any],
            route_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    detail = plan["detail"]
    constraint = detail.get("optimization", {}).get("best", {}).get(
        "constraint_check", {}
    )
    connectivity = constraint.get("mandatory_e2e_connectivity", {})
    survivability = constraint.get("survivability", {})
    relay = constraint.get("max_relay_hops", {})
    conflicts = detail.get("frequency", {}).get("conflicts", [])
    demand_ids = {row["id"] for row in input_data["demands"]}
    routed = {row["demandId"] for row in route_rows if not row["backup"]}
    connectivity_passed = bool(connectivity.get("pass")) and demand_ids <= routed
    return [
        {
            "id": "connectivity", "label": "必要通联连通率",
            "passed": connectivity_passed,
            "detail": (f"已生成主路由 {len(routed)}/{len(demand_ids)} 条；"
                       f"算法值 {_number(connectivity.get('value'))}"),
        },
        {
            "id": "survivability", "label": "抗毁性",
            "passed": bool(survivability.get("pass")),
            "detail": (f"算法值 {_number(survivability.get('value'))}，"
                       f"要求 {_number(survivability.get('required'))}"),
        },
        {
            "id": "relay", "label": "中继约束",
            "passed": bool(relay.get("pass")),
            "detail": (f"算法值 {_number(relay.get('value'))}，"
                       f"要求不超过 {_number(relay.get('required'))}"),
        },
        {
            "id": "frequency", "label": "频率冲突",
            "passed": len(conflicts) == 0,
            "detail": f"检测到 {len(conflicts)} 处频率冲突",
        },
    ]


def _outcome(plan: dict[str, Any], checks: list[dict[str, Any]]) -> dict[str, Any]:
    optimization = plan["detail"].get("optimization", {})
    infeasible = optimization.get("infeasible") or {}
    suggestions = [str(value) for value in infeasible.get("suggestions") or []]
    gap = [
        {"objectId": plan["solution_id"], "field": "constraints", "message": str(value)}
        for value in infeasible.get("conflicting_constraints") or []
    ]
    for issue in plan["detail"].get("check", {}).get("issues", []):
        if str(issue.get("severity") or "").upper() != "SEVERE":
            continue
        gap.append({
            "objectId": str((issue.get("link_ids") or [plan["solution_id"]])[0]),
            "field": str(issue.get("kind") or "plan_check"),
            "message": str(issue.get("detail") or "方案校验未通过"),
        })
    passed = (all(row["passed"] is True for row in checks)
              and not gap and bool(plan["detail"].get("check", {}).get("passed", True)))
    return {
        "code": 0 if passed else 3001,
        "message": "规划完成" if passed else "规划完成，但未满足全部硬约束",
        "suggestions": suggestions,
        "gap": gap[:20000],
    }


def adapt_planning_result(plan: dict[str, Any], input_data: dict[str, Any], *, resource_rows=None
                          ) -> tuple[dict[str, Any], dict[str, Any]]:
    """生成可直接通过前端 ``readPlanningJob`` 校验的单方案结果。"""
    detail = plan["detail"]
    raw_nodes = detail.get("nodes") or []
    raw_links = detail.get("links") or []
    frequency_by_link = _frequency_by_link(detail)
    if resource_rows is None:
        model_rows = planning_w4._load("device_model.csv")
        source_devices = detail.get("devices") or planning_w4._load("device.csv")
    else:
        # 冻结作业不能借当前CSV解释型号；显式空设备也不得回退到当前库。
        if (not isinstance(resource_rows, dict)
                or not isinstance(resource_rows.get("device_model.csv"), list)
                or not isinstance(resource_rows.get("device.csv"), list)
                or not isinstance(detail.get("devices"), list)):
            raise ValueError("冻结规划结果缺少设备或型号来源")
        model_rows = deepcopy(resource_rows["device_model.csv"])
        source_devices = deepcopy(detail["devices"])
    models = {row["model_id"]: row for row in model_rows}
    source_by_id = {row["device_id"]: row for row in source_devices}
    source_by_key: dict[tuple[str, str], list[dict[str, str]]] = defaultdict(list)
    for row in source_devices:
        model = models.get(row.get("model_id", ""), {})
        source_by_key[(row.get("node_id", ""), model.get("device_class", ""))].append(row)

    params = detail.get("params", {}).get("params") or []
    param_by_key = {
        (str(row.get("node_id") or ""), str(row.get("band") or "")): row
        for row in params if not row.get("device_id")
    }
    param_by_device = {str(row["device_id"]): row for row in params
                       if row.get("device_id")}
    device_meta: dict[str, dict[str, Any]] = {}
    device_for_key: dict[tuple[str, str], str] = {}

    def ensure_device(node_id: str, band: str, explicit_id: str | None = None) -> str:
        key = (node_id, band)
        source = source_by_id.get(explicit_id or "")
        if source is None:
            source = next(iter(source_by_key.get(key, [])), None)
        device_id = explicit_id or (source or {}).get("device_id") or _derived_device_id(*key)
        if device_id not in device_meta:
            param = param_by_device.get(device_id, param_by_key.get(key, {}))
            model_id = str(param.get("model_id") or (source or {}).get("model_id")
                           or f"MODEL-{band}-UNSPECIFIED")
            model = models.get(model_id, {})
            device_meta[device_id] = {
                "id": device_id,
                "stationId": node_id,
                "modelId": model_id,
                "modelName": str(model.get("model_name") or "未提供型号"),
                "deviceClass": band,
                "availability": None,
                "workFreqKhz": None,
                "txPowerDbm": _number(param.get("tx_power_dbm")
                                      if param.get("tx_power_dbm") is not None
                                      else (source or {}).get("tx_power_dbm")),
                "antennaHeightM": _number(param.get("antenna_height_m")
                                           if param.get("antenna_height_m") is not None
                                           else (source or {}).get("antenna_height_m")),
                "tiltDeg": _number(param.get("tilt_deg") or (source or {}).get("tilt_deg")),
                "azimuthDeg": _number((source or {}).get("azimuth_deg")),
            }
        device_for_key.setdefault(key, device_id)
        return device_id

    for row in source_devices:
        model = models.get(row.get("model_id", ""), {})
        band = model.get("device_class")
        if band:
            ensure_device(row["node_id"], band, row["device_id"])
    for row in params:
        ensure_device(str(row.get("node_id") or ""), str(row.get("band") or ""),
                      str(row.get("device_id") or "") or None)
    for demand in input_data["demands"]:
        if demand.get("endpointMode") != "device":
            continue
        for node_key, device_key in (("sourceId", "sourceDeviceId"),
                                     ("targetId", "targetDeviceId")):
            explicit = demand.get(device_key)
            source = source_by_id.get(explicit or "", {})
            model = models.get(source.get("model_id", ""), {})
            ensure_device(demand[node_key], model.get("device_class", "HF"), explicit)

    links: list[dict[str, Any]] = []
    device_frequencies: dict[str, list[float]] = defaultdict(list)
    for row in raw_links:
        link_id = str(row.get("link_id") or "")
        band = str(row.get("device_class") or "")
        node_a = str(row.get("node_a_id") or "")
        node_b = str(row.get("node_b_id") or "")
        device_a = ensure_device(node_a, band, str(row.get("device_a_id") or "") or None)
        device_b = ensure_device(node_b, band, str(row.get("device_b_id") or "") or None)
        frequency = frequency_by_link.get(link_id, 0.0)
        if frequency > 0:
            device_frequencies[device_a].append(frequency)
            device_frequencies[device_b].append(frequency)
        links.append({
            "id": link_id, "a": node_a, "b": node_b,
            "deviceA": device_a, "deviceB": device_b,
            "state": _link_state(row), "deviceClass": band,
            "frequencyKhz": frequency, "backup": _bool(row.get("is_backup")),
        })
    for device_id, values in device_frequencies.items():
        device_meta[device_id]["workFreqKhz"] = values[0]

    nodes = [{
        "id": str(row.get("node_id") or ""),
        "name": str(row.get("node_name") or row.get("node_id") or "未命名节点"),
        "coordinate": _coordinate(row),
        "status": (str(row.get("status") or "").upper()
                   if str(row.get("status") or "").upper() in {"NORMAL", "FAULT", "OFFLINE"}
                   else None),
        "alert": None,
    } for row in raw_nodes]
    node_meta = {str(row.get("node_id") or ""): row for row in raw_nodes}
    devices_by_node: dict[str, list[str]] = defaultdict(list)
    for device in device_meta.values():
        devices_by_node[device["stationId"]].append(device["id"])

    demand_ids = {row["id"] for row in input_data["demands"]}
    route_rows = _route_rows(detail, demand_ids, {row["id"] for row in links})
    configured_devices = [{
        "deviceId": row["id"], "stationId": row["stationId"],
        "frequencyKhz": row["workFreqKhz"] or 0.0,
        "txPowerDbm": row["txPowerDbm"],
        "antennaHeightM": row["antennaHeightM"],
    } for row in device_meta.values()
        if row["txPowerDbm"] is not None and row["antennaHeightM"] is not None]
    allocated = sorted({value for value in frequency_by_link.values() if value >= 0})
    frequencies = [] if not allocated else [{
        "id": f"ALLOC-{plan['solution_id']}",
        "minKhz": allocated[0], "maxKhz": allocated[-1], "allocatedKhz": allocated,
    }]
    checks = _checks(plan, input_data, route_rows)
    summary = plan.get("summary", {})
    objectives = summary.get("objectives", {})
    route_source = detail.get("routes", {}).get("routes", [])
    delays = [_number(row.get("primary", {}).get("total_delay_ms"))
              for row in route_source if isinstance(row.get("primary"), dict)]
    result = {
        "snapshot_id": f"SNP-{plan['solution_id']}",
        "nodes": nodes,
        "devices": list(device_meta.values()),
        "links": links,
        "coverage": {"contour": None, "raster_png": None},
        "configuration": {
            "deployment": [{
                "stationId": node_id,
                "deviceIds": sorted(devices_by_node.get(node_id, [])),
                "role": str(meta.get("node_role") or meta.get("echelon") or "未提供角色"),
            } for node_id, meta in node_meta.items()],
            "devices": configured_devices,
            "routes": route_rows,
            "frequencies": frequencies,
        },
        "metrics": {
            "connectivityPercent": (_number(objectives.get("e2e_connectivity")) or 0.0) * 100,
            "totalRadiatedPowerW": _number(objectives.get("total_radiated_power_w")),
            "survivabilityPercent": (_number(objectives.get("survivability")) or 0.0) * 100,
            "coveragePercent": None,
            "delayMs": max((value for value in delays if value is not None), default=None),
        },
        "deployment_cost": None,
        "cost_unit": "",
        "checks": checks,
        "notes": ["覆盖计算未包含在本次 SR4 方案结果中。"],
    }
    return result, _outcome(plan, checks)
