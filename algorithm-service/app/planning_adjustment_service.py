"""父方案原始拓扑快照与地形来源校验。"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import planning_w4
from .interference_analysis_engine import FrozenInterferenceEngine, _number, digest
from .planning_job_schemas import PlanningAdjustmentInput


_ROOT = Path(__file__).resolve().parents[2]
_HEADERS = (
    _ROOT / "data" / "raw" / "dem" / "dem_current.json",
    _ROOT / "data" / "raw" / "landcover" / "landcover_taihang.json",
)


@lru_cache(maxsize=4)
def _hash_terrain_files(files: tuple[tuple[str, int, int], ...]) -> str:
    digest = hashlib.sha256()
    for name, _, _ in files:
        path = Path(name)
        digest.update(path.name.encode("utf-8"))
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
    return digest.hexdigest()


def terrain_fingerprint() -> str | None:
    """将当前 DEM 和地物栅格内容一并纳入父方案来源标识。"""
    files: list[Path] = []
    for header in _HEADERS:
        if not header.is_file():
            return None
        metadata = json.loads(header.read_text(encoding="utf-8"))
        data_path = (header.parent / metadata["data_file"]).resolve()
        if not data_path.is_relative_to(header.parent.resolve()) or not data_path.is_file():
            return None
        files.extend((header, data_path))
    identity = tuple((str(path), path.stat().st_size, path.stat().st_mtime_ns)
                     for path in files)
    return _hash_terrain_files(identity)


def capture_raw_snapshot(result_snapshot: dict[str, Any]) -> dict[str, Any] | None:
    """从作业对应的算法方案提取冻结数据；缺失时允许旧方案照常保存。"""
    snapshot_id = result_snapshot.get("snapshot_id")
    if not isinstance(snapshot_id, str) or not snapshot_id.startswith("SNP-PL-"):
        return None
    solution_id = snapshot_id[4:]
    response = planning_w4.get_plan(solution_id)
    raw = response.get("data") if response.get("code") == 0 else None
    if not isinstance(raw, dict) or raw.get("solution_id") != solution_id:
        return None
    if not isinstance(raw.get("summary"), dict) or not isinstance(raw.get("detail"), dict):
        return None
    return {
        "solution_id": solution_id,
        "summary": raw["summary"],
        "detail": raw["detail"],
        "terrain_fingerprint": terrain_fingerprint(),
    }


def complete_topology(snapshot: dict[str, Any] | None) -> bool:
    if not isinstance(snapshot, dict):
        return False
    detail = snapshot.get("detail")
    if not (isinstance(detail, dict)
            and all(isinstance(detail.get(key), list) and detail[key]
                    for key in ("nodes", "devices", "links"))
            and isinstance(snapshot.get("terrain_fingerprint"), str)):
        return False
    devices = {row.get("device_id"): row for row in detail["devices"]}
    return all(
        str(link.get("is_available", "true")).lower() == "false" or all(
            (device := devices.get(link.get(f"device_{side}_id"))) is not None
            and device.get("node_id") == link.get(f"node_{side}_id")
            for side in ("a", "b"))
        for link in detail["links"])


class AdjustmentError(ValueError):
    def __init__(self, code: int, message: str, status: int,
                 data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.data = data


def prepare_parent(plan: Any, revision: Any, adjustment: Any
                   ) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """校验父方案的冻结身份及人工输入引用，不改变父方案。"""
    if plan is None or plan.task_id != revision.task_id:
        raise AdjustmentError(2001, "父方案不存在", 404)
    if adjustment.source_plan_id != plan.plan_id:
        raise AdjustmentError(1001, "人工调整来源与父方案编号不一致", 422)
    if adjustment.source_snapshot_id != plan.result_snapshot.get("snapshot_id"):
        raise AdjustmentError(1203, "父方案快照编号不一致", 409)
    if plan.condition_version != revision.condition_version or {
            key: value for key, value in plan.input_snapshot.items()
            if key not in {"name", "description"}
    } != {
            key: value for key, value in revision.input_snapshot.items()
            if key not in {"name", "description"}
    }:
        raise AdjustmentError(1203, "任务条件与父方案冻结输入不一致", 409)
    if plan.resource_revision != revision.resource_revision:
        raise AdjustmentError(1205, "父方案使用的资源版本已变化", 409)

    snapshot = plan.raw_snapshot
    if not complete_topology(snapshot):
        snapshot = capture_raw_snapshot(plan.result_snapshot)
    if not complete_topology(snapshot):
        raise AdjustmentError(1203, "父方案缺少完整设备绑定，请重新运行并保存基础方案", 409)
    current_terrain = terrain_fingerprint()
    if current_terrain is None or snapshot["terrain_fingerprint"] != current_terrain:
        raise AdjustmentError(1205, "地形数据版本已变化，请重新生成基础方案", 409)

    detail = snapshot["detail"]
    node_ids = {row["node_id"] for row in detail["nodes"]}
    links = {
        frozenset((row["node_a_id"], row["node_b_id"]))
        for row in detail["links"] if str(row.get("is_available", "true")).lower() != "false"
    }
    demands = {row["id"]: row for row in revision.input_snapshot["demands"]}
    for path in adjustment.manual_paths:
        demand = demands.get(path.demand_id)
        if demand is None or (path.node_path[0], path.node_path[-1]) != (
                demand["sourceId"], demand["targetId"]):
            raise AdjustmentError(1001, f"人工路径的通联需求无效：{path.demand_id}", 422)
        if any(node_id not in node_ids for node_id in path.node_path):
            raise AdjustmentError(1001, f"人工路径包含父拓扑之外的节点：{path.demand_id}", 422)
        if any(frozenset((a, b)) not in links
               for a, b in zip(path.node_path, path.node_path[1:])):
            raise AdjustmentError(1001, f"人工路径包含父拓扑中不存在的链路：{path.demand_id}", 422)

    devices = {row["id"]: row for row in plan.result_snapshot.get("devices", [])}
    raw_device_ids = {row.get("device_id") for row in detail["devices"]}
    refs = []
    for override in adjustment.manual_override:
        device = devices.get(override.device_id)
        if device is None or override.device_id not in raw_device_ids:
            raise AdjustmentError(1001, f"人工调整设备不属于父拓扑：{override.device_id}", 422)
        refs.append({"device_id": override.device_id,
                     "node_id": device["stationId"], "band": device["deviceClass"]})
    return snapshot, refs


def prepare_interference_parent(plan: Any, revision: Any, source: dict[str, Any],
                                change: dict[str, Any], origin: dict[str, Any], *,
                                runtime_root=None, engine=None):
    """仅转换已受理数据库来源；调用者先核验Run/Adoption，禁止当前资源回退。"""
    def reject(message):
        raise AdjustmentError(1203, message, 409)
    scene = source["scene"]
    frozen = scene["plan_snapshot"]
    if (digest(source) != origin["source_hash"] or digest(change) != origin["change_hash"]
            or plan is None or plan.task_id != scene["task_id"] or plan.plan_id != scene["plan_id"]
            or f"V{plan.version_no}" != scene["plan_version"] or plan.source != "SR4"
            or plan.raw_snapshot != frozen["raw_snapshot"] or plan.input_snapshot != frozen["input_snapshot"]
            or revision.revision_id != frozen["input_version"] or revision.task_id != plan.task_id
            or revision.condition_version != frozen["condition_version"]
            or revision.resource_revision != scene["resource_revision"]):
        reject("采纳来源与冻结父方案/任务/变化摘要不一致")
    if (not complete_topology(plan.raw_snapshot)
            or plan.result_snapshot.get("snapshot_id") != "SNP-" + plan.raw_snapshot["solution_id"]):
        reject("采纳父方案没有完整冻结拓扑或真实快照编号")
    header = PlanningAdjustmentInput(schema_version=1, source_plan_id=plan.plan_id,
        source_snapshot_id=plan.result_snapshot["snapshot_id"], manual_override=[], manual_paths=[])
    snapshot, _ = prepare_parent(plan, revision, header)
    engine = engine or FrozenInterferenceEngine(runtime_root=runtime_root)
    modules, scenario, tasks, caps, _graph, substitutions = engine._build(source)
    detail = snapshot["detail"]
    for key, identity in (("nodes", "node_id"), ("devices", "device_id"), ("links", "link_id")):
        ids = [row[identity] for row in detail[key]]
        if len(ids) != len(set(ids)):
            reject("父方案对象编号不唯一：" + key)
    by_link = {row["link_id"]: row for row in detail["links"]}
    by_node = {row["node_id"]: row for row in detail["nodes"]}
    by_device = {row["device_id"]: row for row in detail["devices"]}
    params = {row["device_id"]: row for row in detail["params"]["params"]}
    if len(params) != len(detail["params"]["params"]) or not set(caps).issubset(params):
        reject("父方案实际设备参数缺失或重复")
    overrides = {did: {"device_id": did,
        "tx_power_dbm": _number(params[did].get("tx_power_dbm"), did + ".tx_power_dbm"),
        "antenna_height_m": _number(params[did].get("antenna_height_m"), did + ".antenna_height_m", positive=True)}
        for did in caps}
    target, values, kind = change["target"], change["detail"], change["type"]
    link = by_link.get(target.get("link_id"))
    paths = []
    if kind in ("FREQ_ADJUST", "CHANNEL_SWITCH"):
        if link is None:
            reject("频率措施未关联冻结链路")
        task = next((row for row in tasks if link["link_id"] in row.members), None)
        if (task is None or target.get("net_id") != task.task_id
                or set(values.get("links_in_net", [])) != set(task.members)
                or len(values.get("links_in_net", [])) != len(task.members)):
            reject("频率措施没有精确绑定完整冻结网系")
        frequency = _number(values.get("to_freq_khz"), "to_freq_khz", positive=True)
        if not any(abs(row["freq_khz"] - frequency) < 1e-6 for row in task.allowed):
            reject("采纳频率不属于冻结型号与资源的共同可用候选")
    elif kind == "POWER_OPT":
        if link is None:
            reject("功率措施未关联冻结链路")
        expected = {}
        for item in values["tx_changes"]:
            if item["node_id"] not in (link["node_a_id"], link["node_b_id"]):
                reject("功率措施节点不属于目标链路")
            side = "a" if item["node_id"] == link["node_a_id"] else "b"
            did = link["device_" + side + "_id"]
            if did in expected or did not in caps or item["band"] != caps[did].band:
                reject("功率措施设备归属不唯一")
            power = _number(item.get("to_dbm"), "to_dbm")
            if min(abs(power - level) for level in caps[did].levels) > 0.051:
                reject("采纳功率不属于冻结型号档位")
            expected[did] = power
        if not expected:
            reject("功率措施没有可应用的物理设备变化")
        actual = change.get("device_changes", [])
        if len(actual) != len(expected) or {r["device_id"]: r["tx_power_dbm"] for r in actual} != expected:
            reject("功率变化未精确映射到物理设备")
        for did, power in expected.items():
            overrides[did]["tx_power_dbm"] = power
    elif kind == "NODE_REDEPLOY":
        if target.get("node_id") not in by_node:
            reject("迁移节点不属于冻结方案")
        sites = [row for row in source["resource"]["tables"]["candidate_site.csv"]
                 if row["site_id"] == values.get("to_site_id")]
        if len(sites) != 1 or str(sites[0].get("is_deployable", "")).lower() != "true":
            reject("候选站址不存在、不唯一或不可部署")
        lon, lat = _number(values.get("to_lon"), "to_lon"), _number(values.get("to_lat"), "to_lat")
        if abs(lon - float(sites[0]["lon"])) > 1e-9 or abs(lat - float(sites[0]["lat"])) > 1e-9:
            reject("迁移坐标与冻结候选站址不一致")
        west, south, east, north = scenario.terrain.bbox
        if not west <= lon <= east or not south <= lat <= north:
            reject("迁移目标超出已核验DEM")
        node = by_node[target["node_id"]]
        if modules["terrain"].haversine_m(float(node["lon"]), float(node["lat"]), lon, lat) > 15000 + 1e-6:
            reject("迁移目标超出既有算法15km候选范围")
    elif kind == "ROUTE_REBUILD":
        if link is None or not values.get("rerouted"):
            reject("路由措施没有冻结目标或可应用路径")
        banned = values.get("banned_links", [])
        if len(set(banned)) != len(banned) or not set(banned).issubset(by_link):
            reject("路由排除链路不属于冻结拓扑")
        for route in values["rerouted"]:
            primary = route["primary"]
            for path in (primary, route.get("backup")):
                if path is None:
                    continue
                nodes, lids = path["node_path"], path["link_path"]
                if (len(lids) != len(nodes) - 1 or len(nodes) != len(set(nodes))
                        or set(lids) & set(banned) or len(lids) != len(set(lids))):
                    reject("采纳主备路径包含重复、排除链路或逐跳关系无效")
                for a, b, lid in zip(nodes, nodes[1:], lids):
                    edge = by_link.get(lid)
                    if (edge is None or {a, b} != {edge["node_a_id"], edge["node_b_id"]}
                            or str(edge.get("is_available", "true")).lower() == "false"):
                        reject("采纳主备路径没有精确关联可用物理链路")
            paths.append({"demand_id": route["demand_id"], "node_path": list(primary["node_path"])})
    else:
        reject("不支持的干扰措施类型")
    adjusted = PlanningAdjustmentInput.model_validate({**header.model_dump(),
        "manual_override": list(overrides.values()), "manual_paths": paths,
        "interference_origin": origin, "interference": {
            "scene_id": scene["scene_id"], "scene_version_id": scene["version_id"],
            "scene_snapshot_hash": scene["snapshot_hash"], "resource_content_hash": scene["resource_content_hash"],
            "terrain_fingerprint": snapshot["terrain_fingerprint"], "data_origin": scene["data_origin"],
            "change_set": deepcopy(change), "sources": [deepcopy(row["source_row"]) for row in scene["interference_sources"]],
            "parameter_substitutions": [list(row) for row in substitutions]}})
    # 继续复用既有人工路径引用校验；原手工契约及其错误语义不变。
    prepare_parent(plan, revision, adjusted)
    refs = [{"device_id": did, "node_id": by_device[did]["node_id"], "band": cap.band}
            for did, cap in caps.items()]
    return deepcopy(snapshot), refs, adjusted


def verify_adjusted_result(adjustment: dict[str, Any], result: dict[str, Any], *, raw_detail=None) -> None:
    """防止作业成功却遗漏单台设备覆写或人工主路由。"""
    configuration = result["configuration"]
    devices = {row["deviceId"]: row for row in configuration["devices"]}
    for override in adjustment["manual_override"]:
        device = devices.get(override["device_id"])
        if device is None or any(
                device.get(field) != override[key]
                for key, field in (("tx_power_dbm", "txPowerDbm"),
                                   ("antenna_height_m", "antennaHeightM"))
                if key in override):
            raise ValueError("人工设备参数未准确写入结果：%s" % override["device_id"])
    primary = {row["demandId"]: row["nodeIds"]
               for row in configuration["routes"] if not row["backup"]}
    for path in adjustment["manual_paths"]:
        if primary.get(path["demand_id"]) != path["node_path"]:
            raise ValueError("人工主路径未准确写入结果：%s" % path["demand_id"])
    if adjustment.get("interference") is not None:
        from .interference_replan_service import InterferenceReplanService
        effect = (raw_detail or {}).get("interference", {}).get("effect", {})
        frozen = adjustment["interference"]
        if (effect.get("origin") != adjustment["interference_origin"]
                or effect.get("sources") != frozen["sources"]
                or effect.get("terrain_fingerprint") != frozen["terrain_fingerprint"]
                or effect.get("change_set") != frozen["change_set"]
                or not InterferenceReplanService.applied(frozen["change_set"], raw_detail or {})):
            raise ValueError("干扰重算未回显真实冻结来源或五类实际变化")
