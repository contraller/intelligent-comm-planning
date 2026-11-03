#!/usr/bin/env python3
"""从只读导出的资源和冻结网络生成例程文件；不连接服务、不改数据库。"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import re
from typing import Any
from uuid import UUID, uuid5


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "演示资料/系统例程导入数据"
NAMESPACE = UUID("06bcd026-1c9f-4475-ab56-d3e9a751138b")
TASK_HEADERS = [
    "task_id", "task_name", "area_bbox", "start_time", "duration_h", "description",
    "station_ids", "preset_id", "frequency_id", "max_slope_deg", "min_elevation_m",
    "max_elevation_m", "allowed_landcover", "road_max_distance_m", "min_site_spacing_m",
    "los_required_node_ids", "grid_step_m", "forced_include_json", "forced_exclude_polygons_json",
    "hf_min_khz", "hf_max_khz", "hf_exclude_freq_ids", "vuhf_min_khz", "vuhf_max_khz",
    "vuhf_exclude_freq_ids", "deployment_solve_json",
]
LINK_HEADERS = [
    "demand_id", "task_id", "src_node_id", "dst_node_id", "priority", "is_mandatory",
    "data_volume_mb", "required_rate_kbps", "max_delay_ms", "min_reliability", "service_type",
    "preferred_class", "endpoint_mode", "src_device_id", "dst_device_id", "strategy", "need_backup",
]
FAULT_HEADERS = [
    "scenario_key", "scenario_name", "description", "object_type", "object_id", "fault_type",
    "symptom_ids", "occur_time", "interference_id",
]
EXAMPLE_BBOX = [113.37497663855423, 36.461013295002346, 114.72474558374593, 37.53898670499157]
ORIGIN_NOTE = "人工构造例程，非生产、非实测。仅用于学习导入、状态切换和结果查看，不表示真实设备采集或执行。"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"输入须为JSON对象：{path.name}")
    return value


def resource_data(value: dict[str, Any], override: str | None = None) -> tuple[str, dict[str, Any]]:
    for key in ("data", "resource"):
        if key in value and isinstance(value[key], dict) and "tables" not in value and "snapshot" not in value:
            value = value[key]
    declared = value.get("revision") or value.get("resource_revision")
    if override and declared and override != declared:
        raise ValueError("指定资源版本与输入文件声明不符，不能改写版本冒充同版资料")
    revision = override or declared
    if not isinstance(revision, str) or not re.fullmatch(r"resource-[0-9a-f]{16}", revision):
        raise ValueError("资源输入须声明合法revision，或显式提供同版--resource-revision")
    snapshot = value.get("snapshot", value)
    if isinstance(snapshot, str):
        snapshot = json.loads(snapshot)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("tables"), dict):
        raise ValueError("资源输入缺少snapshot.tables或tables")
    tables = snapshot["tables"]
    for table, id_field in (("node.csv", "node_id"), ("device.csv", "device_id"), ("device_model.csv", "model_id")):
        rows = tables.get(table)
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) or not row.get(id_field) for row in rows):
            raise ValueError(f"资源表缺失、为空或编号无效：{table}")
        if len({row[id_field] for row in rows}) != len(rows):
            raise ValueError(f"资源表编号重复：{table}")
    if not 1 <= len(tables["device.csv"]) <= 1000:
        raise ValueError("当前导入接口每批支持1至1000台设备；本生成器不截断全量资料")
    nodes = {row["node_id"] for row in tables["node.csv"]}
    models = {row["model_id"] for row in tables["device_model.csv"]}
    for row in tables["device.csv"]:
        if row.get("node_id") not in nodes or row.get("model_id") not in models:
            raise ValueError(f"设备所属节点或型号不存在：{row['device_id']}")
    return revision, tables


def network_data(value: dict[str, Any]) -> dict[str, Any]:
    for key in ("data", "network"):
        if key in value and isinstance(value[key], dict) and "identity" not in value:
            value = value[key]
    required = ("nodes", "devices", "links", "identity")
    if any(key not in value for key in required) or not isinstance(value["identity"], dict):
        raise ValueError("冻结网络输入须为含identity/nodes/devices/links的GisNetwork")
    for table in ("nodes", "devices", "links"):
        rows = value[table]
        if not isinstance(rows, list) or any(not isinstance(row, dict) or not row.get("id") for row in rows):
            raise ValueError(f"冻结网络{table}结构无效")
        if len({row["id"] for row in rows}) != len(rows):
            raise ValueError(f"冻结网络{table}编号重复")
    for key in ("plan_id", "task_id", "snapshot_id", "resource_revision"):
        if not value["identity"].get(key):
            raise ValueError(f"冻结网络缺少{key}")
    device_ids = {row["id"] for row in value["devices"]}
    node_ids = {row["id"] for row in value["nodes"]}
    if any(row.get("station_id") not in node_ids or row.get("device_class") not in ("HF", "VUHF") for row in value["devices"]):
        raise ValueError("冻结设备归属或频段类别无效")
    if any(row.get("device_a") not in device_ids or row.get("device_b") not in device_ids for row in value["links"]):
        raise ValueError("冻结链路端点设备缺失")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def write_csv(path: Path, headers: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=headers, lineterminator="\r\n", extrasaction="raise")
    writer.writeheader()
    writer.writerows(rows)
    # 与现用Papa.unparse模板保持一致：末尾空行会干扰含分号单元格的分隔符猜测。
    path.write_text(stream.getvalue().removesuffix("\r\n"), encoding="utf-8", newline="")


def sample_statuses(devices: list[dict[str, str]], stamp: datetime, batch: int) -> list[dict[str, Any]]:
    # 状态由下列公开规则构造，不读取台账状态、不模拟真实采集。
    states = {0: "FAULT", 1: "FAULT", 2: "FAULT", 3: "OFFLINE", 4: "OFFLINE", 5: None}
    if batch == 2:
        states = {1: "FAULT", 4: "OFFLINE", 6: "FAULT", 7: None}
    observed_at = stamp.isoformat(timespec="seconds").replace("+00:00", "Z")
    rows = []
    for index, device in enumerate(sorted(devices, key=lambda row: row["device_id"])):
        state = states.get(index, "NORMAL")
        rows.append({
            "device_id": device["device_id"], "node_id": device["node_id"], "model_id": device["model_id"],
            "observed_at": observed_at if state else None, "status": state,
            "alert": None if state is None else state != "NORMAL",
            "unknown_reasons": [] if state else ["构造例程：本批未提供该设备的状态、告警及观测时间"],
        })
    return rows


def make_status_payload(revision: str, devices: list[dict[str, str]], stamp: datetime, batch: int) -> dict[str, Any]:
    value = {
        "schema_version": "device-status-snapshot-a1", "context": "ledger", "base_revision": revision,
        "data_origin": "SYNTHETIC_INTEGRATION", "source_label": f"例程设备状态 · 第{batch}批 · 构造演示",
        "provenance_note": ORIGIN_NOTE + ("本批为初始混合状态。" if batch == 1 else "本批展示恢复、新故障和未知变化，不表示真实维修。"),
        "records": sample_statuses(devices, stamp, batch),
    }
    digest = hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {"request_id": str(uuid5(NAMESPACE, digest)), **value}


def status_counts(payload: dict[str, Any]) -> dict[str, int]:
    result = {"NORMAL": 0, "FAULT": 0, "OFFLINE": 0, "UNKNOWN": 0}
    for row in payload["records"]:
        result[row["status"] or "UNKNOWN"] += 1
    return result


def planning_files(output: Path, revision: str, tables: dict[str, Any], prefix: str, bbox: list[float], stations: list[str] | None) -> dict[str, Any]:
    nodes = {row["node_id"] for row in tables["node.csv"]}
    if stations is None:
        preferred = [node for node in ("ND-0001", "ND-0002", "ND-0003") if node in nodes]
        stations = preferred if len(preferred) >= 2 else sorted(nodes)[:3]
    if len(stations) < 2 or len(set(stations)) != len(stations) or any(node not in nodes for node in stations):
        raise ValueError("规划例程须选至少两个不同的真实资源节点")
    task_id = prefix + "-PLAN"
    task = dict.fromkeys(TASK_HEADERS, "")
    task.update({"task_id": task_id, "task_name": "例程通信规划任务", "area_bbox": ";".join(map(str, bbox)),
                 "description": ORIGIN_NOTE + "必要通联100%、抗毁90%、中继不超过2跳的检查口径保持；不保证新输入一定达标。",
                 "station_ids": ";".join(stations), "preset_id": "balanced", "frequency_id": "available-hf"})
    demand = dict.fromkeys(LINK_HEADERS, "")
    demand.update({"demand_id": prefix + "-D01", "task_id": task_id, "src_node_id": stations[0], "dst_node_id": stations[1],
                   "priority": "P1", "is_mandatory": "true", "data_volume_mb": 10, "required_rate_kbps": 64,
                   "max_delay_ms": 100, "min_reliability": 0.95, "service_type": "数据", "endpoint_mode": "station",
                   "strategy": "MAX_RELIABILITY", "need_backup": "true"})
    target = output / "01_规划任务"
    write_csv(target / "01_task_scenarios.csv", TASK_HEADERS, [task])
    write_csv(target / "02_task_links.csv", LINK_HEADERS, [demand])
    info = {"数据用途": "配套两个CSV同时导入网络规划，应用草稿后另行保存和计算", "来源": ORIGIN_NOTE,
            "适用资源版本": revision, "任务文件编号": task_id, "参与节点": stations,
            "范围WGS84": bbox, "任务条数": 1, "通联需求条数": 1,
            "说明": "没有执行规划；文件通过格式或引用验证不等于规划达标。重新规划后的故障例程须核对新方案对象。"}
    write_json(target / "00_适用资源.json", info)
    return info


def fault_files(output: Path, network: dict[str, Any] | None, prefix: str, resource_ids: set[str]) -> dict[str, Any]:
    target = output / "03_故障场景"
    rows: list[dict[str, Any]] = []
    reasons: list[str] = []
    if network is None:
        reasons.append("尚未提供已保存冻结网络，未生成任何可导入故障行；不得复用旧方案对象编号。")
    else:
        hf = sorted((row for row in network["devices"] if row["device_class"] == "HF" and row["id"] in resource_ids), key=lambda row: row["id"])
        vuhf = sorted((row for row in network["devices"] if row["device_class"] == "VUHF" and row["id"] in resource_ids), key=lambda row: row["id"])
        links = sorted((row for row in network["links"] if row.get("device_class") == "VUHF"), key=lambda row: row["id"])
        definitions = [
            ("HF-POWER", "例程短波设备功放故障", "DEVICE", hf[0]["id"] if hf else None, "HW_FAILURE", "SY-0001;SY-0002", "驻波比告警与功率读数接近零"),
            ("VUHF-LINK", "例程超短波链路中断", "LINK", links[0]["id"] if links else None, "LINK_DOWN", "SY-0005;SY-0007", "对端完全失联与握手超时"),
            ("VUHF-CONFIG", "例程超短波频率配置不一致", "DEVICE", vuhf[0]["id"] if vuhf else None, "SW_CONFIG", "SY-0012", "人工构造频率配置与对端不一致现象"),
        ]
        for code, name, kind, object_id, fault_type, symptoms, description in definitions:
            if object_id is None:
                reasons.append(f"未生成{name}：该冻结网络无可核对的对应类别对象。")
                continue
            rows.append({"scenario_key": prefix + "-" + code, "scenario_name": name,
                         "description": ORIGIN_NOTE + description + "；保留证据缺项及人工复核提示，不保证识别结果。",
                         "object_type": kind, "object_id": object_id, "fault_type": fault_type, "symptom_ids": symptoms,
                         "occur_time": "", "interference_id": ""})
    if rows:
        write_csv(target / "故障场景_三类例程.csv", FAULT_HEADERS, rows)
    info = {"来源": ORIGIN_NOTE, "适用冻结方案": network["identity"] if network else None,
            "场景条数": len(rows), "完整三类例程": len(rows) == 3,
            "对象": [{"场景": row["scenario_name"], "类别": row["object_type"], "编号": row["object_id"], "现象": row["symptom_ids"]} for row in rows],
            "条件说明": reasons,
            "导入约束": "导入时必须选择本清单中的方案；重新规划或更换方案后，须按新冻结网络重新生成，不凭编号相同推定可通用。"}
    write_json(target / "00_适用方案.json", info)
    return info


def status_files(target: Path, revision: str, devices: list[dict[str, str]], stamp: datetime,
                 network: dict[str, Any] | None, usage: str) -> dict[str, Any]:
    payloads = [make_status_payload(revision, devices, stamp + timedelta(minutes=(batch - 1) * 5), batch) for batch in (1, 2)]
    for batch, payload in enumerate(payloads, 1):
        write_json(target / f"设备状态_第{batch}批_{'初始状态' if batch == 1 else '状态变化'}.json", payload)
    resource_ids = {row["device_id"] for row in devices}
    uncovered = sorted({row["id"] for row in network["devices"]} - resource_ids) if network else []
    changes = [{"设备": first["device_id"], "第1批": first["status"], "第2批": second["status"]}
               for first, second in zip(payloads[0]["records"], payloads[1]["records"]) if first["status"] != second["status"]]
    network_counts = []
    if network and network["identity"]["resource_revision"] == revision:
        for payload in payloads:
            lookup = {row["device_id"]: row["status"] for row in payload["records"]}
            counts = {"NORMAL": 0, "FAULT": 0, "OFFLINE": 0, "UNKNOWN": 0}
            for row in network["devices"]:
                counts[lookup.get(row["id"]) or "UNKNOWN"] += 1
            network_counts.append(counts)
    info = {"用途": usage, "来源": ORIGIN_NOTE, "适用资源版本": revision, "每批全量设备数": len(resource_ids),
            "预期统计": [{"文件": f"设备状态_第{batch}批_{'初始状态' if batch == 1 else '状态变化'}.json", "状态统计": status_counts(payload), "请求编号": payload["request_id"]}
                       for batch, payload in enumerate(payloads, 1)],
            "预期变化": changes, "配对方案": network["identity"] if network else None,
            "方案资源版本相同": network["identity"]["resource_revision"] == revision if network else None,
            "方案中不在当前资源台账的设备": uncovered, "方案设备面板各批预期统计": network_counts,
            "使用说明": "先校验并导入第1批，再在已导入批次中选择；导入第2批后手动选择或启用跟随最新。相同文件重复导入为同一请求，不创建新批次。",
            "边界": "只使用真实台账编号构造状态，不包含方案新增但尚未入台账的设备；未覆盖成员继续显示未知。资源版本变化后应重新生成，不能只改base_revision。"}
    write_json(target / "00_状态数据说明.json", info)
    return info


def build(resource: dict[str, Any], network: dict[str, Any] | None, output: Path, *, revision_override: str | None = None,
          prefix: str = "EXAMPLE-20261103", stamp: datetime | None = None, bbox: list[float] | None = None,
          stations: list[str] | None = None, fresh_resource: dict[str, Any] | None = None) -> dict[str, Any]:
    revision, tables = resource_data(resource, revision_override)
    network = network_data(network) if network is not None else None
    fresh_revision, fresh_tables = resource_data(fresh_resource) if fresh_resource is not None else (None, None)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]{0,49}", prefix):
        raise ValueError("例程编号前缀须为字母开头的1至50位字母、数字或连字符")
    bbox = bbox or EXAMPLE_BBOX
    if len(bbox) != 4 or not all(isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(item) for item in bbox):
        raise ValueError("范围须为四个有限经纬度数值")
    if not (-180 <= bbox[0] < bbox[2] <= 180 and -90 <= bbox[1] < bbox[3] <= 90):
        raise ValueError("经纬度范围无效")
    stamp = stamp or datetime.now(timezone.utc).replace(hour=1, minute=0, second=0, microsecond=0)
    if stamp.tzinfo is None:
        raise ValueError("构造观测时间必须包含时区")
    stamp = stamp.astimezone(timezone.utc)
    node_ids = {row["node_id"] for row in tables["node.csv"]}
    node_coords = {}
    for row in tables["node.csv"]:
        if row.get("lon") and row.get("lat"):
            node_coords[row["node_id"]] = [float(row["lon"]), float(row["lat"])]
    if network:
        node_coords.update({row["id"]: row["coordinate"] for row in network["nodes"] if isinstance(row.get("coordinate"), list) and len(row["coordinate"]) == 2})
    # 如输入可提供位置，先拒绝范围外参与节点，避免生成看似合法的错误例程。
    preferred = [node for node in ("ND-0001", "ND-0002", "ND-0003") if node in node_ids]
    chosen = stations if stations is not None else preferred if len(preferred) >= 2 else sorted(node_ids)[:3]
    if fresh_tables is not None:
        fresh_nodes = {row["node_id"]: row for row in fresh_tables["node.csv"]}
        for node in chosen:
            if node not in fresh_nodes:
                raise ValueError(f"规划例程参与节点{node}不在新解压便携包资源中，不能宣称一套任务通用")
            row = fresh_nodes[node]
            if row.get("lon") and row.get("lat") and not (bbox[0] <= float(row["lon"]) <= bbox[2] and bbox[1] <= float(row["lat"]) <= bbox[3]):
                raise ValueError(f"新解压便携包参与节点{node}在例程范围外")
    for node in chosen:
        coord = node_coords.get(node)
        if coord and not (bbox[0] <= coord[0] <= bbox[2] and bbox[1] <= coord[1] <= bbox[3]):
            raise ValueError(f"参与节点{node}在例程范围外，请使用--area-bbox指定实际范围")
    if network is None and (output / "03_故障场景/故障场景_三类例程.csv").exists():
        raise ValueError("目标已有配对故障文件；请提供--network或另选输出目录，避免留下过期故障对象")
    planning = planning_files(output, revision, tables, prefix, bbox, chosen)
    resource_ids = {row["device_id"] for row in tables["device.csv"]}
    target = output / "02_设备状态"
    status_info = status_files(target / "当前实例用", revision, tables["device.csv"], stamp, network, "现用桌面实例")
    variants = [{"目录": "当前实例用", "适用资源版本": revision}]
    fresh_info = None
    if fresh_tables is not None:
        fresh_info = status_files(target / "新解压便携包用", fresh_revision, fresh_tables["device.csv"], stamp, None, "首次解压、尚未修改资源的便携包")
        variants.append({"目录": "新解压便携包用", "适用资源版本": fresh_revision})
    write_json(target / "00_先核对资源版本.json", {
        "选择规则": "按页面当前资源版本选择对应子目录，两个目录不得混用。资源修改后原文件可能不再适用，应重新生成，不可只改base_revision。",
        "版本目录": variants, "来源": ORIGIN_NOTE,
        "新包故障说明": "全新便携包不保证已有本例程绑定的已保存方案，需先完成规划，再用新方案中的实际对象重建故障场景。",
    })
    faults = fault_files(output, network, prefix, resource_ids)
    return {"output": str(output), "resource_revision": revision, "planning": planning,
            "status": status_info, "fresh_status": fresh_info, "faults": faults}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resource", type=Path, required=True, help="只读导出的同版资源JSON，包含revision和snapshot.tables")
    parser.add_argument("--network", type=Path, help="可选：实际保存方案的GisNetwork JSON")
    parser.add_argument("--fresh-resource", type=Path, help="可选：全新便携包的只读资源JSON，另生成独立版本的状态文件")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--resource-revision", help="仅在资源JSON未声明revision时使用；不得与声明冲突")
    parser.add_argument("--prefix", default="EXAMPLE-20261103")
    parser.add_argument("--observed-at", help="构造观测时间，含时区RFC3339；默认当日01:00 UTC，第2批晚5分钟")
    parser.add_argument("--area-bbox", help="WGS84 lon0,lat0,lon1,lat1；默认沿用已验证首次使用范围")
    parser.add_argument("--station-ids", help="参与节点，以逗号分隔，至少两个；默认优先ND-0001/2/3")
    args = parser.parse_args()
    stamp = datetime.fromisoformat(args.observed_at.replace("Z", "+00:00")) if args.observed_at else None
    bbox = [float(part) for part in args.area_bbox.split(",")] if args.area_bbox else None
    stations = args.station_ids.split(",") if args.station_ids else None
    result = build(load_json(args.resource), load_json(args.network) if args.network else None, args.output.resolve(),
                   revision_override=args.resource_revision, prefix=args.prefix, stamp=stamp, bbox=bbox, stations=stations,
                   fresh_resource=load_json(args.fresh_resource) if args.fresh_resource else None)
    print(json.dumps({"output": result["output"], "resource_revision": result["resource_revision"],
                      "devices_per_batch": result["status"]["每批全量设备数"],
                      "expected_counts": [row["状态统计"] for row in result["status"]["预期统计"]],
                      "fault_scenarios": result["faults"]["场景条数"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
