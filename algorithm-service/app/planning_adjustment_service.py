"""父方案原始拓扑快照与地形来源校验。"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import planning_w4


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


def verify_adjusted_result(adjustment: dict[str, Any], result: dict[str, Any]) -> None:
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
