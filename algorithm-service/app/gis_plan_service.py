"""只读取指定方案，不调用算法或用当前资源修补历史网络。"""
from copy import deepcopy
import json
import math
import re

from pydantic import ValidationError

from . import frontend_integration, resource_dataset_service as datasets
from .database import get_session_factory
from .gis_plan_schemas import NetworkProjection
from .planning_plan_models import PlanningPlan
from .resource_dataset_models import ResourceDatasetVersion


class GisPlanError(ValueError):
    def __init__(self, message, code=1203, status=409):
        super().__init__(message)
        self.code, self.status = code, status


def _rows(value, field):
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise GisPlanError("方案冻结资料结构无效：" + field)
    return value


def _unique(rows, field):
    result = {row["id"]: row for row in rows}
    if len(result) != len(rows):
        raise GisPlanError("方案冻结资料编号重复：" + field)
    return result


def _frequency(value):
    # 既有结果用数值0表达未分配频点；投影为未知，不显示为合法工作频率。
    return None if type(value) in (float, int) and value == 0 else value


def _check_references(network):
    nodes = _unique(network["nodes"], "nodes")
    devices = _unique(network["devices"], "devices")
    links = _unique(network["links"], "links")
    demands = _unique(network["demands"], "demands")
    _unique(network["routes"], "routes")
    _unique(network["interferences"], "interferences")
    if any(row["station_id"] not in nodes for row in devices.values()):
        raise GisPlanError("冻结设备所属节点不存在")
    for link in links.values():
        if link["a"] == link["b"]:
            raise GisPlanError("冻结链路不能连接同一节点")
        for side in ("a", "b"):
            device = devices.get(link["device_" + side])
            if (link[side] not in nodes or device is None
                    or device["station_id"] != link[side]
                    or device["device_class"] != link["device_class"]):
                raise GisPlanError("冻结链路端点或设备绑定不一致")
    for demand in demands.values():
        for prefix in ("source", "target"):
            node_id, device_id = demand[prefix + "_id"], demand[prefix + "_device_id"]
            if node_id not in nodes or device_id is not None and (
                device_id not in devices or devices[device_id]["station_id"] != node_id
            ):
                raise GisPlanError("冻结需求端点或设备不一致")
    route_kinds = set()
    for route in network["routes"]:
        demand = demands.get(route["demand_id"])
        path, edge_path = route["node_ids"], route["link_ids"]
        kind = (route["demand_id"], route["backup"])
        if (demand is None or kind in route_kinds or len(path) != len(edge_path) + 1
                or path[0] != demand["source_id"] or path[-1] != demand["target_id"]
                or not set(path) <= nodes.keys() or not set(edge_path) <= links.keys()):
            raise GisPlanError("冻结业务路径引用或起止端点不一致")
        route_kinds.add(kind)
        for a, b, edge_id in zip(path, path[1:], edge_path):
            edge = links[edge_id]
            if {a, b} != {edge["a"], edge["b"]}:
                raise GisPlanError("冻结路径节点顺序与链路不一致")


def _frozen_rows(tables, name, id_field):
    if tables is None:
        return None
    if not isinstance(tables, dict):
        raise GisPlanError("方案关联的冻结资源表结构无效")
    if name not in tables:
        return None
    rows = _rows(tables[name], name)
    if any(any(not isinstance(key, str) or not isinstance(value, str)
               for key, value in row.items()) for row in rows):
        raise GisPlanError("方案关联的冻结CSV字段类型无效：" + name)
    ids = [row.get(id_field) for row in rows]
    if any(not isinstance(value, str) or not value or len(value) > 120
           or re.search(r"\s|[\x00-\x1f\x7f]", value) for value in ids) or len(set(ids)) != len(ids):
        raise GisPlanError("方案关联的冻结CSV编号无效或重复：" + name)
    return rows


def _source_number(row, field, optional=False):
    value = row.get(field)
    if optional and value in (None, ""):
        return None
    if not isinstance(value, str) or not value or value != value.strip():
        raise GisPlanError("冻结干扰源数值缺失或无效：" + field)
    try:
        result = float(value)
    except (ValueError, OverflowError) as exc:
        raise GisPlanError("冻结干扰源数值无效：" + field) from exc
    if not math.isfinite(result):
        raise GisPlanError("冻结干扰源数值必须有限：" + field)
    return result


def _source_interferences(tables):
    rows = _frozen_rows(tables, "interference_source.csv", "interference_id")
    if rows is None:
        return [], "该方案未保留同版本干扰源资料，未使用当前资源替代。"
    result = []
    for row in rows:
        if row.get("active") not in ("true", "false"):
            raise GisPlanError("冻结干扰源启用标识无效")
        result.append({
            "id": row["interference_id"], "name": row.get("name"),
            "coordinate": [_source_number(row, "lon"), _source_number(row, "lat")],
            "elevationM": _source_number(row, "elevation_m", True),
            "antennaHeightM": _source_number(row, "antenna_height_m"),
            "centerFreqKhz": _source_number(row, "center_freq_khz"),
            "bandwidthKhz": _source_number(row, "bandwidth_khz"),
            "txPowerDbm": _source_number(row, "tx_power_dbm"),
            "antennaGainDbi": _source_number(row, "antenna_gain_dbi", True),
            "interferenceType": row.get("interference_type"),
            "patternType": row.get("pattern_type") or None,
            "azimuthDeg": _source_number(row, "azimuth_deg", True),
            "dutyCycle": _source_number(row, "duty_cycle", True),
            "active": row["active"] == "true", "origin": row.get("origin") or "SOURCE",
        })
    return result, ""


def _node_classifications(tables):
    rows = _frozen_rows(tables, "node.csv", "node_id")
    result = {}
    for row in rows or []:
        mobility = row.get("mobility") or None
        if mobility not in (None, "FIXED", "VEHICLE", "MANPACK"):
            raise GisPlanError("冻结节点机动类型无效")
        result[row["node_id"]] = {"mobility": mobility,
                                  "node_role": row.get("node_role") or None,
                                  "node_subtype": row.get("node_subtype") or None}
    return result


def _project(result, input_data, identity, frozen_tables=None):
    if not isinstance(result, dict) or not isinstance(input_data, dict):
        raise GisPlanError("方案缺少冻结结果或任务输入")
    configuration = result.get("configuration")
    if configuration is not None and not isinstance(configuration, dict):
        raise GisPlanError("方案冻结配置结构无效")
    route_data = (configuration or {}).get("routes")
    paths_present = route_data is not None
    classifications = _node_classifications(frozen_tables)
    interferences, interferences_notice = _source_interferences(frozen_tables)
    projected = {
        "identity": identity,
        "nodes": [{"id": row.get("id"), "name": row.get("name"),
                   "coordinate": row.get("coordinate"), "status": row.get("status"),
                   "alert": row.get("alert"),
                   **{field: row.get(field) if row.get(field) is not None else classifications.get(row.get("id"), {}).get(field)
                      for field in ("mobility", "node_role", "node_subtype")}}
                  for row in _rows(result.get("nodes"), "nodes")],
        "devices": [{"id": row.get("id"), "station_id": row.get("stationId"),
                     "model_id": row.get("modelId"), "device_class": row.get("deviceClass"),
                     "frequency_khz": _frequency(row.get("workFreqKhz")),
                     "tx_power_dbm": row.get("txPowerDbm"),
                     "antenna_height_m": row.get("antennaHeightM")}
                    for row in _rows(result.get("devices"), "devices")],
        "links": [{"id": row.get("id"), "a": row.get("a"), "b": row.get("b"),
                   "device_a": row.get("deviceA"), "device_b": row.get("deviceB"),
                   "device_class": row.get("deviceClass"),
                   "frequency_khz": _frequency(row.get("frequencyKhz")),
                   "backup": row.get("backup"), "planned_state": row.get("state")}
                  for row in _rows(result.get("links"), "links")],
        "demands": [{"id": row.get("id"), "source_id": row.get("sourceId"),
                     "target_id": row.get("targetId"), "source_device_id": row.get("sourceDeviceId"),
                     "target_device_id": row.get("targetDeviceId"), "service": row.get("service"),
                     "mandatory": row.get("mandatory"), "required_rate_kbps": row.get("requiredRateKbps"),
                     "min_reliability": row.get("minReliability")}
                    for row in _rows(input_data.get("demands"), "demands")],
        "routes": [{"id": row.get("id"), "demand_id": row.get("demandId"),
                    "node_ids": row.get("nodeIds"), "link_ids": row.get("linkIds"),
                    "backup": row.get("backup")}
                   for row in _rows(route_data, "routes")] if paths_present else [],
        "paths_state": "ready" if paths_present and route_data else "missing",
        "paths_message": "" if paths_present and route_data else "该冻结结果未提供完整业务路径，不代表已计算零影响或零需求。",
        "interferences": interferences, "interferences_notice": interferences_notice,
    }
    try:
        network = NetworkProjection.model_validate(projected).model_dump(mode="json")
    except ValidationError as exc:
        raise GisPlanError("冻结方案字段无效，不能安全展示") from exc
    _check_references(network)
    return network


def network(plan_id, task_id, snapshot_id=None, *, factory=None):
    factory = factory or get_session_factory()
    with factory() as session:
        plan = session.get(PlanningPlan, plan_id)
        if plan is None or plan.task_id != task_id:
            raise GisPlanError("规划方案不存在或不属于该任务", 2001, 404)
        result, input_data = deepcopy(plan.result_snapshot), deepcopy(plan.input_snapshot)
        if not isinstance(result, dict) or not result.get("snapshot_id"):
            raise GisPlanError("方案未提供冻结快照标识")
        if snapshot_id is not None and snapshot_id != result["snapshot_id"]:
            raise GisPlanError("所选快照与方案不一致，请重新打开方案")
        identity = {"plan_id": plan.plan_id, "task_id": plan.task_id,
                    "snapshot_id": result["snapshot_id"], "input_version": plan.revision_id,
                    "condition_version": plan.condition_version, "resource_revision": plan.resource_revision,
                    "state": plan.state, "source_changed": plan.resource_revision != frontend_integration.resource_revision(),
                    "data_origin": "SYNTHETIC_INTEGRATION", "source": plan.source}
        # 旧方案可能早于资源版本留存；缺失保持可查看，存在但损坏的同版资料明确拒绝。
        version = session.get(ResourceDatasetVersion, plan.resource_revision)
        frozen_tables = None
        if version is not None:
            try:
                frozen_tables = datasets._decode(version)["tables"]
            except datasets.ResourceDatasetError as exc:
                raise GisPlanError("方案关联的同版本资源快照校验失败，未使用当前资源替代") from exc
    return _project(result, input_data, identity, frozen_tables)


def link_detail(plan_id, task_id, snapshot_id, link_id, *, factory=None):
    data = network(plan_id, task_id, snapshot_id, factory=factory)
    link = next((row for row in data["links"] if row["id"] == link_id), None)
    if link is None:
        raise GisPlanError("方案中不存在指定链路", 1002, 404)
    routes = [row for row in data["routes"] if link_id in row["link_ids"]]
    devices = {row["id"]: row for row in data["devices"]}
    return {"identity": data["identity"], "link": link,
            "endpoint_devices": [devices[link["device_a"]], devices[link["device_b"]]],
            "demand_ids": sorted({row["demand_id"] for row in routes}),
            "route_ids": [row["id"] for row in routes],
            "observation": {"state": "missing", "message": "未提供本方案链路的实测观测；计划等级不是实测结论。", "samples": []}}


def surface(plan_id, task_id, snapshot_id, *, factory=None):
    factory = factory or get_session_factory()
    data = network(plan_id, task_id, snapshot_id, factory=factory)
    notice = "该方案的 DEM 版本无法与当前地形核对，未显示地形底图。"
    terrain = None
    with factory() as session:
        plan = session.get(PlanningPlan, plan_id)
        if plan is None or plan.task_id != task_id or (plan.result_snapshot or {}).get("snapshot_id") != snapshot_id:
            raise GisPlanError("冻结方案已不可用，请重新打开方案")
        raw = deepcopy(plan.raw_snapshot)
        coverage = deepcopy((plan.result_snapshot or {}).get("coverage"))
    coverage_notice = "该冻结方案未提供覆盖栅格或轮廓。"
    if coverage is not None:
        if not isinstance(coverage, dict) or set(coverage) != {"contour", "raster_png"}:
            raise GisPlanError("冻结覆盖资料结构无效")
        if coverage["contour"] is None and coverage["raster_png"] is None:
            coverage = None
        else:
            coverage_notice = ""
    # 地形属于同一冻结来源；不因当前资源换版而给历史网络套用另一份DEM。
    from . import planning_adjustment_service
    try:
        fingerprint = raw.get("terrain_fingerprint") if isinstance(raw, dict) else None
        if fingerprint and fingerprint == planning_adjustment_service.terrain_fingerprint():
            meta = json.loads((frontend_integration.REPO_ROOT / "data/raw/dem/dem_current.json").read_text(encoding="utf-8"))
            sha, bounds, source = meta.get("source_sha256"), meta.get("bbox"), meta.get("source")
            valid_bounds = (isinstance(bounds, list) and len(bounds) == 4
                            and all(type(v) in (int, float) and math.isfinite(v) for v in bounds)
                            and -180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90)
            if (not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha)
                    or not isinstance(source, str) or not source.strip() or not valid_bounds):
                raise ValueError("DEM元数据无效")
            terrain = {"sourceSha256": sha, "bounds": bounds, "source": source}
            notice = ""
    except (OSError, ValueError, KeyError, TypeError):
        notice = "当前 DEM 元数据缺失或无效，未显示地形底图。"
    return {"identity": data["identity"], "terrain": terrain, "terrain_notice": notice,
            "coverage": coverage, "coverage_notice": coverage_notice}


def paths(plan_id, task_id, snapshot_id, demand_id=None, *, factory=None):
    data = network(plan_id, task_id, snapshot_id, factory=factory)
    demands = [row for row in data["demands"] if demand_id is None or row["id"] == demand_id]
    if demand_id is not None and not demands:
        raise GisPlanError("方案中不存在指定通联需求", 1002, 404)
    return {"identity": data["identity"], "demands": demands,
            "routes": [row for row in data["routes"] if demand_id is None or row["demand_id"] == demand_id],
            "paths_state": data["paths_state"], "paths_message": data["paths_message"]}
