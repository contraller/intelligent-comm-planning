"""投影冻结原生结果；缺失值不补零，不在此重算算法合格结论。"""
from __future__ import annotations

import math
from typing import Any


def _number(value: Any, minimum: float = -math.inf, maximum: float = math.inf,
            *, integer: bool = False) -> float | int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(result) or not minimum <= result <= maximum:
        return None
    if integer:
        return int(result) if result.is_integer() and result <= 2**53 - 1 else None
    return result


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _boolean(value: Any) -> bool | None:
    return value if type(value) is bool else None


def _rows(value: Any) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError("原生结果明细应为对象数组")
    return value


def _strings(value: Any, *, unique: bool = False) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or any(_text(item) is None for item in value):
        raise ValueError("原生结果明细应为非空字符串数组")
    if unique and len(set(value)) != len(value):
        raise ValueError("原生结果明细包含重复身份")
    return list(value)


def _parameters(detail: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]] | None:
    params = _rows((detail.get("params") or {}).get("params"))
    if params is None:
        return None
    devices = {row["id"]: row for row in result["devices"]}
    rows = []
    for config in result["configuration"]["devices"]:
        device = devices[config["deviceId"]]
        matches = [row for row in params if row.get("device_id") == device["id"]]
        if not matches:
            matches = [row for row in params if not row.get("device_id")
                       and row.get("node_id") == device["stationId"]
                       and row.get("band") == device["deviceClass"]]
        if len(matches) > 1:
            raise ValueError("原生设备参数身份不唯一")
        if matches:
            rows.append({"deviceId": device["id"],
                         "tiltDeg": _number(matches[0].get("tilt_deg")),
                         "tiltEffective": _boolean(matches[0].get("tilt_effective"))})
    return rows


def _route_quality(detail: dict[str, Any], result: dict[str, Any]) -> list[dict[str, Any]] | None:
    native = _rows((detail.get("routes") or {}).get("routes"))
    if native is None:
        return None
    routes = {row["demand_id"]: row for row in native}
    links = {row["link_id"]: row for row in detail.get("links") or []}
    rows = []
    for route in result["configuration"]["routes"]:
        path = routes[route["demandId"]]["backup" if route["backup"] else "primary"]
        bottleneck = _text(path.get("bottleneck_link_id"))
        if bottleneck is not None and bottleneck not in route["linkIds"]:
            raise ValueError("原生瓶颈链路不属于路由")
        distances = [_number(links.get(link_id, {}).get("distance_m"), 0)
                     for link_id in route["linkIds"]]
        rows.append({
            "routeId": route["id"], "demandId": route["demandId"],
            "hopCount": _number(path.get("hop_count"), 0, integer=True),
            "totalDistanceM": sum(distances) if all(d is not None for d in distances) else None,
            "totalDelayMs": _number(path.get("total_delay_ms"), 0),
            "bottleneckMarginDb": _number(path.get("min_link_margin_db")),
            "reliability": _number(path.get("reliability"), 0, 1),
            # reachable 只说明存在路径，不能替代独立的路由质量合格结论。
            "isFeasible": None, "bottleneckLinkId": bottleneck,
        })
    return rows


def _frequency(frequency: dict[str, Any], result: dict[str, Any], plan_id: str
               ) -> tuple[list[dict[str, Any]] | None, list[dict[str, Any]] | None]:
    links = {row["id"]: row for row in result["links"]}
    configured = {row["deviceId"] for row in result["configuration"]["devices"]}
    valid_links = {key for key, row in links.items()
                   if row["deviceA"] in configured and row["deviceB"] in configured}
    native = _rows(frequency.get("link_assignments"))
    groups: dict[str, list[str]] = {}
    for row in (_rows(frequency.get("assignments")) or []) + (native or []):
        members = _strings(row.get("member_link_ids"), unique=True)
        if members is None:
            members = [row["link_id"]] if row.get("link_id") in links else []
        for key in (row.get("task_id"), row.get("net_id"), row.get("link_id")):
            if _text(key) and key not in links:
                groups[key] = list(dict.fromkeys(groups.get(key, []) + members))

    assignments: dict[str, dict[str, Any]] = {}
    for row in native or []:
        value = _number(row.get("freq_khz"), 0)
        if value is None or value == 0:
            continue
        members = ([row["link_id"]] if row.get("link_id") in links else
                   groups.get(row.get("link_id"), []))
        if not members:
            raise ValueError("原生频率分配缺少冻结链路关联")
        for link_id in members:
            if link_id not in valid_links or links[link_id]["frequencyKhz"] != value:
                raise ValueError("原生频率分配与冻结链路或设备不一致")
            group = next((group["id"] for group in result["configuration"]["frequencies"]
                          if value in group["allocatedKhz"]), None)
            item = {
                "id": f"FA-{plan_id}-{link_id}", "linkId": link_id,
                "resourceGroupId": group, "freqId": _text(row.get("freq_id")),
                "reuseGroup": _number(row.get("reuse_group"), 0, integer=True),
                "frequencyKhz": value,
                "bandwidthKhz": _number(row.get("bandwidth_khz"), 0),
            }
            if item["bandwidthKhz"] == 0:
                item["bandwidthKhz"] = None
            if link_id in assignments and assignments[link_id] != item:
                raise ValueError("同一冻结链路存在矛盾频率分配")
            assignments[link_id] = item

    native_conflicts = _rows(frequency.get("conflicts"))
    conflicts = []
    for index, row in enumerate(native_conflicts or [], start=1):
        identities = _strings(row.get("link_ids"), unique=True)
        kind = _text(row.get("type")) or _text(row.get("kind"))
        if identities is None or kind is None:
            raise ValueError("原生频率冲突缺少类别或链路引用")
        members = []
        for identity in identities:
            resolved = [identity] if identity in links else groups.get(identity)
            if resolved is None or not resolved or any(key not in valid_links for key in resolved):
                raise ValueError("原生频率冲突不能关联冻结链路")
            members.extend(resolved)
        value = _number(row.get("freq_khz"), 0)
        conflicts.append({
            "id": f"FC-{plan_id}-{index}", "type": kind,
            "linkIds": list(dict.fromkeys(members)),
            # 邻频冲突包含两个频点，既有标量字段不能无损承载。
            "frequencyKhz": value if value != 0 else None,
            "distanceM": _number(row.get("distance_m"), 0),
            "requiredDistanceM": _number(row.get("required_distance_m"), 0),
            "severity": _text(row.get("severity")),
        })
    return (list(assignments.values()) if native is not None else None,
            conflicts if native_conflicts is not None else None)


def _frequency_gap(value: Any) -> dict[str, int | None] | None:
    if value is None or value == {}:
        return None
    if not isinstance(value, dict) or any(not isinstance(row, dict) for row in value.values()):
        raise ValueError("原生频率缺口应按频段提供")
    result = {}
    # 各频段互不重叠；子频段已计入原生 shortage，不能再次累加。
    for target, source in (("requiredChannels", "required_channels"),
                           ("availableChannels", "available_channels"),
                           ("shortage", "shortage")):
        numbers = [_number(row.get(source), 0, integer=True) for row in value.values()]
        result[target] = sum(numbers) if all(number is not None for number in numbers) else None
    return result


def _candidate_screening(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("原生候选筛选应为对象")
    source = _text(value.get("source"))
    if source is None:
        return None
    native = _rows(value.get("candidates"))
    candidates = []
    identities = set()
    for row in native or []:
        identity = _text(row.get("site_id"))
        if identity is None or identity in identities:
            raise ValueError("原生候选点身份缺失或重复")
        identities.add(identity)
        lon, lat = _number(row.get("lon"), -180, 180), _number(row.get("lat"), -90, 90)
        candidates.append({
            "siteId": identity, "coordinate": [lon, lat] if lon is not None and lat is not None else None,
            "elevationM": _number(row.get("elevation_m")),
            "slopeDeg": _number(row.get("slope_deg"), 0, 90),
            "landcoverType": _text(row.get("landcover_type")),
            "nearestRoadDistanceM": _number(row.get("nearest_road_distance_m"), 0),
            "nearestNodeDistanceM": _number(row.get("nearest_node_distance_m"), 0),
            "visibleNodeCount": _number(row.get("visible_node_count"), 0, integer=True),
            "candidateRole": _text(row.get("candidate_role")),
            "isDeployable": _boolean(row.get("is_deployable")),
            "recommendationLevel": _text(row.get("recommendation_level")),
            "score": _number(row.get("score")), "rejectReason": _text(row.get("reject_reason")),
        })
    stats = value.get("rejected_stats")
    if stats is not None and (not isinstance(stats, dict) or any(_text(key) is None for key in stats)):
        raise ValueError("原生候选筛除统计无效")
    projected = {
        "sourceLabel": source,
        "candidateCount": _number(value.get("scanned_count"), 0, integer=True),
        "deployableCount": _number(value.get("accepted_count"), 0, integer=True),
        "candidates": candidates if native is not None else None,
        "rejectedStats": {key: _number(count, 0, integer=True) for key, count in stats.items()}
        if stats is not None else None,
        "unavailableReasons": _unavailable_reasons(value.get("unavailable_reasons")),
    }
    if "data_sources" in value:
        projected["dataSources"] = _strings(value["data_sources"])
    return projected


def _unavailable_reasons(value: Any) -> list[str] | None:
    native = _rows(value)
    if native is None:
        return None
    result = []
    for row in native:
        site, field, reason = (_text(row.get(key)) for key in ("site_id", "field", "reason"))
        if site is None or field is None or reason is None:
            raise ValueError("原生候选不可计算原因缺少点位、字段或原因")
        result.append(f"{site}/{field}：{reason}")
    return result


def _deployment_summary(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("原生部署求解应为对象")
    result = {target: _number(value.get(source), 0, integer=True) for target, source in (
        ("requestedCount", "requested_count"), ("actualCount", "actual_count"),
        ("requestedSolutionCount", "requested_solution_count"),
        ("returnedSolutionCount", "returned_solution_count"))}
    result.update({
        "mode": value.get("mode") if value.get("mode") in {"MIN_COUNT", "FIXED_COUNT"} else None,
        "countSatisfied": _boolean(value.get("count_satisfied")),
        "shortfallReasons": _shortfall_reasons(value),
        "forcedSiteIds": _strings(value.get("forced_site_ids"), unique=True),
        "lowerBound": _number(value.get("lower_bound"), 0, integer=True),
        "provedOptimal": _boolean(value.get("proved_optimal")),
    })
    return result


def _shortfall_reasons(value: dict[str, Any]) -> list[str] | None:
    reasons = _strings(value.get("shortfall_reasons"))
    issues = _rows(value.get("constraint_issues"))
    if reasons is None and not issues:
        return None
    result = list(dict.fromkeys(reasons or []))
    for row in issues or []:
        field, reason = _text(row.get("field")), _text(row.get("reason"))
        site = row.get("site_id")
        if field is None or reason is None or site is not None and _text(site) is None:
            raise ValueError("原生部署约束问题缺少合法字段、站点或原因")
        # 未声明站点的约束保留字段级原因，不能补造站点或扩大为全局结论。
        label = f"{field}/{site}" if site is not None else field
        message = f"{label}：{reason}"
        if message not in result:
            result.append(message)
    return result


def project_result_details(plan: dict[str, Any], input_data: dict[str, Any],
                           result: dict[str, Any]) -> dict[str, Any]:
    """只读取当前原生方案及已输出的冻结身份，不读取当前资源或修改快照。"""
    detail = plan["detail"]
    frequency = detail.get("frequency") or {}
    assignments, conflicts = _frequency(frequency, result, plan["solution_id"])
    demand_ids = {row["id"] for row in input_data["demands"]}
    unreachable = _strings((detail.get("routes") or {}).get("unreachable_demand_ids"), unique=True)
    projected = {
        "schemaVersion": 1, "assetVersion": f"sr4-native-v1:{plan['solution_id']}",
        "deviceParameters": _parameters(detail, result),
        "routeQuality": _route_quality(detail, result),
        "frequencyAssignments": assignments, "frequencyConflicts": conflicts,
        "frequencyGap": _frequency_gap(frequency.get("gap")),
        "conflictFree": _boolean(frequency.get("conflict_free")),
        "unreachableDemandIds": [key for key in unreachable if key in demand_ids]
        if unreachable is not None else None,
    }
    optimization = detail.get("optimization") or {}
    if "candidate_filter" in optimization:
        projected["candidateScreening"] = _candidate_screening(optimization["candidate_filter"])
    if "deployment_solve" in optimization:
        projected["deploymentSummary"] = _deployment_summary(optimization["deployment_solve"])
    return projected
