"""冻结规划覆盖 sidecar；不读 current CSV、不选默认地形、不写缓存。"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
ENGINE_VERSION = "V01-4"
SELECTION_ANCHOR_KEYS = ("plan_id", "task_id", "snapshot_id", "input_version", "condition_version",
                         "resource_revision", "resource_content_hash", "plan_input_sha256",
                         "raw_snapshot_sha256", "frozen_tables_sha256", "terrain_fingerprint")
MAX_DEVICES = 1024
MAX_COMPUTATIONS = 4096
MAX_RAY_STEPS = 10_000_000
MAX_CELLS = 250_000
DEFAULTS = {"radius_m": 60000.0, "cell_m": 1000.0, "az_step_deg": 2.0,
            "margin_min_db": 6.0, "rx_height_m": 2.0, "hour": 12.0,
            "hf_max_km": 900, "ring_vertices": 72}
RANGES = {"radius_m": (250, 120000), "cell_m": (250, 5000),
          "az_step_deg": (1, 45), "margin_min_db": (-100, 100),
          "rx_height_m": (0, 300), "hour": (0, 24),
          "hf_max_km": (1, 900), "ring_vertices": (24, 360)}


class FrozenCoverageError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class FrozenCoverageCancelled(RuntimeError):
    pass


class _UnknownRadio(ValueError):
    pass


def _fail(message: str, code: str = "COVERAGE_INPUT") -> None:
    raise FrozenCoverageError(code, message)


def _json(value: Any, code: str = "COVERAGE_INPUT") -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, OverflowError, RecursionError) as exc:
        raise FrozenCoverageError(code, "覆盖数据必须为有限数值的JSON结构") from exc


def _digest(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _number(value: Any, field: str, *, lo: float | None = None,
            hi: float | None = None, code: str = "COVERAGE_INPUT") -> float:
    if value is None or isinstance(value, bool) or value == "":
        _fail("缺少有效数值：" + field, code)
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError) as exc:
        raise FrozenCoverageError(code, "非法数值：" + field) from exc
    if not math.isfinite(result) or lo is not None and result < lo or hi is not None and result > hi:
        _fail("数值超出范围：" + field, code)
    return result


def _identity(value: Any, field: str) -> str:
    if (not isinstance(value, str) or not value.strip() or len(value) > 160
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        _fail("缺少冻结编号：" + field)
    return value


def _index(rows: Any, key: str, field: str) -> dict[str, dict]:
    if not isinstance(rows, list):
        _fail("冻结数据必须为行列表：" + field)
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            _fail("冻结行结构无效：" + field)
        identity = _identity(row.get(key), field + "." + key)
        if identity in result:
            _fail("冻结编号重复：" + field + "." + identity)
        result[identity] = row
    return result


def _parameters(value: dict | None) -> dict:
    if value is not None and not isinstance(value, dict):
        _fail("params必须为对象")
    if value and any(not isinstance(key, str) for key in value):
        _fail("覆盖选项名称必须为字符串")
    if value and set(value) - set(DEFAULTS):
        _fail("未知覆盖选项：" + ",".join(sorted(set(value) - set(DEFAULTS))))
    result = dict(DEFAULTS)
    for key, raw in (value or {}).items():
        result[key] = _number(raw, key, lo=RANGES[key][0], hi=RANGES[key][1])
    if result["hour"] >= 24 or result["cell_m"] > result["radius_m"]:
        _fail("时刻或覆盖栅格与半径不相容")
    for key in ("hf_max_km", "ring_vertices"):
        if not float(result[key]).is_integer():
            _fail("选项必须为整数：" + key)
        result[key] = int(result[key])
    if result["ring_vertices"] % 4 or not math.isclose(360 / result["az_step_deg"], round(360 / result["az_step_deg"])):
        _fail("环采样点须为4倍数，方位角步长须整除360")
    return result


def _modules():
    for path in (ROOT / "scripts", ROOT / "scripts/planning"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    return importlib.import_module("viewshed"), importlib.import_module("feasibility")


def _bbox(value: Any, field: str) -> tuple[float, ...]:
    if not isinstance(value, (tuple, list)) or len(value) != 4:
        _fail("地形范围缺失：" + field, "COVERAGE_TERRAIN")
    result = tuple(_number(item, field, code="COVERAGE_TERRAIN") for item in value)
    if not (-180 <= result[0] < result[2] <= 180 and -90 <= result[1] < result[3] <= 90):
        _fail("地形范围无效：" + field, "COVERAGE_TERRAIN")
    return result


class _CheckedTerrain:
    def __init__(self, source: Any, check: Callable[[], None]):
        self.source, self.check = source, check
        if getattr(source, "name", None) != "DEM":
            _fail("仅允许显式核验的DEM，不允许合成或默认回退地形", "COVERAGE_TERRAIN")
        self.bbox = _bbox(getattr(source, "bbox", None), "DEM.bbox")
        for key in ("_dem", "_lc"):
            raster = getattr(source, key, None)
            if not callable(getattr(raster, "sample", None)) or not isinstance(getattr(raster, "meta", None), dict):
                _fail("地形缺少可核验原生栅格：" + key, "COVERAGE_TERRAIN")
            if raster.meta.get("crs") != "EPSG:4326":
                _fail("覆盖算法仅接受EPSG:4326核验栅格", "COVERAGE_TERRAIN")
            _bbox(raster.meta.get("bbox"), key + ".bbox")
        if self.bbox != tuple(source._dem.meta["bbox"]):
            _fail("DEM对象范围与原生栅格不一致", "COVERAGE_TERRAIN")
        if not callable(getattr(source, "landcover", None)):
            _fail("缺少核验地物查询", "COVERAGE_TERRAIN")

    def _sample(self, raster: Any, lon: float, lat: float):
        self.check()
        west, south, east, north = raster.meta["bbox"]
        if not west <= lon < east or not south < lat <= north:
            _fail("采样超出已核验栅格，禁止边缘钳位", "COVERAGE_TERRAIN")
        value = raster.sample(lon, lat)
        try:
            known = value is not None and not isinstance(value, bool) and math.isfinite(float(value))
        except (ValueError, TypeError, OverflowError):
            known = False
        if not known:
            _fail("核验栅格采样未知或nodata，禁止补零", "COVERAGE_TERRAIN")
        return value

    def elevation(self, lon, lat):
        return float(self._sample(self.source._dem, lon, lat))

    def landcover(self, lon, lat):
        self._sample(self.source._lc, lon, lat)
        value = self.source.landcover(lon, lat)
        if value not in ("林地", "草地", "耕地", "建成区", "裸地", "水域"):
            _fail("地物类别未知，禁止隐式传播缺省", "COVERAGE_TERRAIN")
        return value

    def profile(self, lon1, lat1, lon2, lat2, n=64):
        # 与既有DEM.profile同一线性采样，同时逐点执行取消和nodata检查。
        p1, p2 = math.radians(lat1), math.radians(lat2)
        a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
        distance = 2 * 6371008.8 * math.asin(math.sqrt(min(1, a)))
        return [(distance * i / n, self.elevation(lon1 + (lon2 - lon1) * i / n,
                                                 lat1 + (lat2 - lat1) * i / n)) for i in range(n + 1)]


class _CheckedRadio(dict):
    def __init__(self, values: dict, check: Callable[[], None]):
        super().__init__(values)
        self.check = check

    def __getitem__(self, key):
        self.check()
        return super().__getitem__(key)


def _bandwidth_values(value, device_id):
    if value in (None, ""):
        return None
    if isinstance(value, str) and ";" in value:
        values = []
        for part in value.split(";"):
            token = part.strip()
            if not re.fullmatch(r"\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", token):
                _fail("非法带宽选项集：" + device_id + ".bandwidth_khz")
            values.append(_number(token, device_id + ".bandwidth_khz", lo=1e-9, hi=1e9))
        return sorted(set(values))
    return [_number(value, device_id + ".bandwidth_khz", lo=1e-9, hi=1e9)]


def _bandwidth_provenance(model):
    fields = ("origin", "source_id", "source_sha256", "source_note", "original_khz")
    if model is None or not any("bandwidth_" + key in model for key in fields):
        return None
    result = {key: model.get("bandwidth_" + key) for key in fields}
    if (not all(isinstance(value, str) for value in result.values())
            or result["origin"] != "SYNTHETIC_COVERAGE_ASSUMPTION"
            or result["source_id"] != "R5-HF-RX-3KHZ-V1"
            or not re.fullmatch(r"[0-9a-f]{64}", result["source_sha256"])
            or not result["source_note"].strip() or result["original_khz"] != ""
            or model.get("device_class") != "HF" or ";" in str(model.get("bandwidth_khz"))
            or _bandwidth_values(model.get("bandwidth_khz"), model.get("model_id", "")) != [3.0]):
        _fail("冻结型号接收带宽构造来源无效")
    return result


def bandwidth_options(raw: dict, tables: dict) -> list[dict]:
    """仅从冻结来源读取结构化选项，不加载DEM或调用覆盖算法。"""
    _digest((raw, tables))
    if not isinstance(raw, dict) or not isinstance(raw.get("detail"), dict) or not isinstance(tables, dict):
        _fail("缺少冻结带宽来源")
    detail = raw["detail"]
    devices = _index(detail.get("devices"), "device_id", "devices")
    nodes = _index(detail.get("nodes"), "node_id", "nodes")
    models = _index(tables.get("device_model.csv"), "model_id", "device_model.csv")
    if len(devices) > MAX_DEVICES:
        _fail("冻结设备数量超过限额", "COVERAGE_LIMIT")
    frequencies = _frequencies(detail, devices, nodes, models)
    rows = []
    for did, device in sorted(devices.items()):
        for key in ("node_id", "model_id", "antenna_id"):
            _identity(device.get(key), did + "." + key)
        if device["node_id"] not in nodes:
            _fail("设备引用方案外节点：" + did)
        model = models.get(device["model_id"])
        raw_value = (model or {}).get("bandwidth_khz")
        values = _bandwidth_values(raw_value, did)
        if not frequencies[did]:
            state, code, reason = "NO_ASSIGNED_FREQUENCY", "NO_ASSIGNED_FREQUENCY", "冻结设备没有分配工作频率"
        elif values is None:
            state, code, reason = "UNKNOWN", "RX_BANDWIDTH_UNKNOWN", "冻结型号接收带宽未知"
        elif isinstance(raw_value, str) and ";" in raw_value:
            state, code, reason = "SELECTION_REQUIRED", "RX_BANDWIDTH_SELECTION_REQUIRED", "需要显式冻结接收带宽选值"
        else:
            state, code, reason = "SINGLE_VALUE", None, ""
        rows.append(dict(device_id=did, node_id=device["node_id"], model_id=device["model_id"],
                         band=(model or {}).get("device_class"), model_bandwidth_khz=deepcopy(raw_value),
                         options_khz=values, state=state, reason_code=code, reason=reason,
                         bandwidth_provenance=_bandwidth_provenance(model)))
    return rows


def validate_bandwidth_choices(raw, tables, choices):
    if not isinstance(choices, list) or len(choices) > MAX_DEVICES:
        _fail("接收带宽选择须为限额内列表")
    options = {row["device_id"]: row for row in bandwidth_options(raw, tables)}
    normalized, seen = [], set()
    for choice in choices:
        if not isinstance(choice, dict) or set(choice) != {"device_id", "rx_bandwidth_khz"}:
            _fail("接收带宽选择字段无效")
        did = _identity(choice["device_id"], "device_id")
        if did in seen or did not in options:
            _fail("接收带宽引用重复或方案外设备：" + did)
        seen.add(did)
        value = choice["rx_bandwidth_khz"]
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            _fail("接收带宽必须为JSON数值：" + did)
        value = _number(value, did + ".rx_bandwidth_khz", lo=1e-9, hi=1e9)
        if options[did]["options_khz"] is None or value not in options[did]["options_khz"]:
            _fail("选值无法匹配冻结型号接收带宽：" + did)
        normalized.append({"device_id": did, "rx_bandwidth_khz": value})
    return sorted(normalized, key=lambda row: row["device_id"])


def _selection_choices(raw, tables, selection):
    if selection is None:
        return []
    if not isinstance(selection, dict):
        _fail("接收带宽选择版本无效")
    anchor = selection.get("source_anchor")
    if (not isinstance(anchor, dict) or set(anchor) != set(SELECTION_ANCHOR_KEYS)
            or anchor["snapshot_id"] != "SNP-" + str(raw.get("solution_id"))
            or anchor["raw_snapshot_sha256"] != _digest(raw)
            or anchor["frozen_tables_sha256"] != _digest(tables)
            or anchor["terrain_fingerprint"] != raw.get("terrain_fingerprint")):
        _fail("接收带宽选择与冻结来源不一致")
    sid = selection.get("selection_id")
    if not isinstance(sid, str) or not re.fullmatch(r"FBS-[0-9a-f]{32}", sid):
        _fail("接收带宽选择编号无效")
    choices = validate_bandwidth_choices(raw, tables, selection.get("choices"))
    digest = _digest(dict(schema_version=1, source_anchor=anchor, choices=choices))
    if digest != selection.get("selection_hash"):
        _fail("接收带宽选择摘要不一致")
    return choices


def _bandwidth_info(model, device_id, selected):
    raw = (model or {}).get("bandwidth_khz")
    values = _bandwidth_values(raw, device_id)
    if selected is not None:
        if values is None or selected not in values:
            _fail("选值无法匹配冻结型号接收带宽：" + device_id)
        # 枚举沿前端合同保留；选值来自持久选择版本，不是compute原文或设备生效参数。
        return dict(value_khz=selected, source="EXPLICIT_COMPUTE_PARAMETER")
    if values is None:
        return dict(value_khz=None, source="UNKNOWN")
    if isinstance(raw, str) and ";" in raw:
        return dict(value_khz=None, source="UNSELECTED")
    return dict(value_khz=values[0], source="FROZEN_MODEL_SINGLE_VALUE")


def _radio(device: dict, plan: dict | None, model: dict | None, antenna: dict | None,
           *, assigned_frequencies=(), rx_bandwidth=None) -> dict:
    missing = []
    if model is None or antenna is None or plan is None:
        missing.append("对应冻结型号、天线或逐设备计划参数")
    model, antenna, plan = model or {}, antenna or {}, plan or {}
    if model.get("device_class") not in ("HF", "VUHF"):
        if model.get("device_class") not in (None, ""):
            _fail("冻结型号频段无效：" + device["device_id"])
        missing.append("冻结型号频段")
    if "band" in plan and plan["band"] not in ("HF", "VUHF"):
        _fail("计划参数频段无效：" + device["device_id"])
    for key, expected in (("node_id", device["node_id"]), ("model_id", device["model_id"]),
                          ("antenna_id", device["antenna_id"]), ("band", model.get("device_class"))):
        if key in plan and expected is not None and plan[key] != expected:
            _fail("计划参数与冻结设备归属不一致：" + device["device_id"] + "." + key)
    fields = {"tx_dbm": (plan, "tx_power_dbm", -100, 100),
              "height": (plan, "antenna_height_m", 0, 1000),
              "gain": (antenna, "gain_dbi", -100, 100),
              "sens": (model, "rx_sensitivity_dbm", -300, 100),
              "fmin": (model, "freq_min_khz", 1e-9, 1e9),
              "fmax": (model, "freq_max_khz", 1e-9, 1e9)}
    values = {}
    for key, (row, field, lo, hi) in fields.items():
        raw = row.get(field)
        if raw in (None, ""):
            missing.append(field)
            continue
        values[key] = _number(raw, device["device_id"] + "." + field, lo=lo, hi=hi)
    if not antenna.get("pattern_type"):
        missing.append("pattern_type")
    elif not isinstance(antenna["pattern_type"], str):
        _fail("冻结天线方向图类别无效：" + device["device_id"])
    if "fmin" in values and "fmax" in values and values["fmin"] > values["fmax"]:
        _fail("冻结型号频率范围倒置：" + device["device_id"])
    if "fmin" in values and "fmax" in values:
        for frequency in assigned_frequencies:
            if not values["fmin"] <= frequency <= values["fmax"]:
                _fail("冻结计划频率超出本设备型号范围：" + device["device_id"])
    if rx_bandwidth is None and isinstance(model.get("bandwidth_khz"), str) and ";" in model["bandwidth_khz"]:
        missing.append("bandwidth_khz为型号支持选项集，计划未冻结本次选定带宽")
    elif rx_bandwidth is None:
        missing.append("bandwidth_khz")
    if missing:
        raise _UnknownRadio("必要冻结参数未知：" + ",".join(missing))
    values["pattern"] = antenna["pattern_type"]
    values["bw"] = rx_bandwidth
    return values


def _summary(devices):
    result = dict(total=len(devices), eligible=0, complete=0, unavailable=0, skipped=0)
    for device in devices:
        key = {"COMPLETE": "complete", "UNAVAILABLE": "unavailable", "SKIPPED": "skipped"}.get(device.get("status"))
        if key is None:
            _fail("覆盖设备状态无效", "COVERAGE_RESULT")
        result[key] += 1
    result["eligible"] = result["complete"] + result["unavailable"]
    return result


def _overall(summary):
    if not summary["eligible"]:
        return "NOT_APPLICABLE"
    if summary["complete"] == summary["eligible"]:
        return "COMPLETE"
    return "PARTIAL" if summary["complete"] else "UNAVAILABLE"


def validate_v4_result(result):
    """V4 的统计和来源随结果一起核验，历史结果不走本分支。"""
    if type(result.get("schema_version")) is not int or result["schema_version"] != 2:
        _fail("V4覆盖结果结构版本无效", "COVERAGE_RESULT")
    devices = _index(result.get("devices"), "device_id", "result.devices")
    summary = _summary(list(devices.values()))
    saved = result.get("summary")
    if (not isinstance(saved, dict) or set(saved) != set(summary)
            or any(type(value) is not int or value < 0 for value in saved.values())
            or saved != summary or result.get("status") != _overall(summary)):
        _fail("V4覆盖统计或总体状态不一致", "COVERAGE_RESULT")
    for device in devices.values():
        for key, identity in (("frozen_model", "model_id"), ("frozen_antenna", "antenna_id"),
                              ("planned_parameters", "device_id")):
            value = device.get(key)
            if key not in device or value is not None and (
                    not isinstance(value, dict) or value.get(identity) != device.get(identity)):
                _fail("V4覆盖冻结对象身份不一致", "COVERAGE_RESULT")
        if ("bandwidth_provenance" not in device
                or device["bandwidth_provenance"] != _bandwidth_provenance(device["frozen_model"])):
            _fail("V4覆盖带宽来源不一致", "COVERAGE_RESULT")
        bandwidth = device.get("rx_bandwidth")
        if not isinstance(bandwidth, dict) or set(bandwidth) != {"value_khz", "source"}:
            _fail("V4覆盖接收带宽结构无效", "COVERAGE_RESULT")
        source, value = bandwidth["source"], bandwidth["value_khz"]
        if source in ("EXPLICIT_COMPUTE_PARAMETER", "FROZEN_MODEL_SINGLE_VALUE"):
            _number(value, "rx_bandwidth", lo=1e-9, hi=1e9, code="COVERAGE_RESULT")
        elif source not in ("UNKNOWN", "UNSELECTED") or value is not None:
            _fail("V4覆盖接收带宽来源无效", "COVERAGE_RESULT")
        state, code = device["status"], device.get("reason_code")
        if not isinstance(device.get("reasons"), list) or not all(isinstance(row, str) for row in device["reasons"]):
            _fail("V4覆盖设备原因无效", "COVERAGE_RESULT")
        if state == "COMPLETE":
            if (code is not None or "reason_code" not in device or device["reasons"]
                    or not isinstance(device.get("radio_parameters"), dict) or not device.get("computations")):
                _fail("V4覆盖完成设备缺少结果", "COVERAGE_RESULT")
        elif (device.get("radio_parameters") is not None or device.get("computations") != []
                or not device["reasons"] or (code != "NO_ASSIGNED_FREQUENCY" if state == "SKIPPED" else
                    code not in ("RX_BANDWIDTH_UNKNOWN", "RX_BANDWIDTH_SELECTION_REQUIRED", "FROZEN_PARAMETERS_UNKNOWN"))):
            _fail("V4覆盖未计算设备状态无效", "COVERAGE_RESULT")


def _frequencies(detail: dict, devices: dict, nodes: dict, models: dict) -> dict:
    links = _index(detail.get("links"), "link_id", "detail.links")
    frequency = detail.get("frequency")
    if not isinstance(frequency, dict):
        _fail("缺少冻结频率结构")
    assigned = _index(frequency.get("link_assignments"), "link_id", "frequency.link_assignments")
    if set(assigned) - set(links):
        _fail("冻结频率引用方案外链路")
    for lid, row in assigned.items():
        _number(row.get("freq_khz"), lid + ".freq_khz", lo=1e-9)
    result: dict[str, dict[float, list[str]]] = {did: {} for did in devices}
    for lid, link in links.items():
        available = link.get("is_available", "true")
        inactive = available is False or available == "false"
        if not inactive and available is not True and available != "true":
            _fail("冻结链路可用性未知：" + lid)
        for side in ("a", "b"):
            did, nid = link.get("device_" + side + "_id"), link.get("node_" + side + "_id")
            if did not in devices or nid not in nodes or devices[did].get("node_id") != nid:
                _fail("冻结链路设备与节点不对应：" + lid)
            band = models.get(devices[did].get("model_id"), {}).get("device_class")
            if band in ("HF", "VUHF") and link.get("device_class") != band:
                _fail("冻结链路频段与设备型号不一致：" + did)
        if inactive:
            continue
        if lid not in assigned:
            _fail("活动链路缺少冻结分配频率：" + lid)
        freq = _number(assigned[lid].get("freq_khz"), lid + ".freq_khz", lo=1e-9)
        for side in ("a", "b"):
            did, nid = link.get("device_" + side + "_id"), link.get("node_" + side + "_id")
            if did not in devices or nid not in nodes or devices[did]["node_id"] != nid:
                _fail("冻结链路设备与节点不对应：" + lid)
            result[did].setdefault(freq, []).append(lid)
    return result


def _circle(lon: float, lat: float, radius_m: float, count: int, check) -> list:
    output = []
    phi, lam, delta = math.radians(lat), math.radians(lon), radius_m / 6371008.8
    for index in range(count):
        check()
        bearing = -2 * math.pi * index / count
        p = math.asin(max(-1, min(1, math.sin(phi) * math.cos(delta) + math.cos(phi) * math.sin(delta) * math.cos(bearing))))
        l = lam + math.atan2(math.sin(bearing) * math.sin(delta) * math.cos(phi), math.cos(delta) - math.sin(phi) * math.sin(p))
        output.append([((math.degrees(l) + 180) % 360) - 180, math.degrees(p)])
    return output + [output[0][:]]


def _rings(native: Any, item: dict, options: dict, check) -> dict:
    rings, features = [], []
    for index, row in enumerate(native.rings):
        check()
        if not isinstance(row, (tuple, list)) or len(row) != 3 or not isinstance(row[2], str):
            _fail("HF原生环带结构无效", "COVERAGE_RESULT")
        inner, outer = (_number(row[i], "HF.ring", lo=0, code="COVERAGE_RESULT") for i in (0, 1))
        if inner > outer:
            _fail("HF原生环带内外径倒置", "COVERAGE_RESULT")
        covered = outer > inner and "静区" not in row[2]
        ring = {"inner_m": inner, "outer_m": outer, "note": row[2], "is_coverage": covered}
        rings.append(ring)
        if outer <= inner:
            continue
        shell = _circle(item["lon"], item["lat"], outer, options["ring_vertices"], check)
        coordinates = [shell]
        if inner > 0:
            coordinates.append(list(reversed(_circle(item["lon"], item["lat"], inner, options["ring_vertices"], check))))
        crosses = any(abs(a[0] - b[0]) > 180 for polygon in coordinates for a, b in zip(polygon, polygon[1:]))
        properties = {"device_id": item["device_id"], "node_id": item["node_id"], "ring_index": index, **ring}
        if crosses:
            properties["display_unavailable_reason"] = "跨日期变更线环带仅保留原生半径，未伪造连续Polygon"
        features.append({"type": "Feature", "geometry": None if crosses else {"type": "Polygon", "coordinates": coordinates},
                         "properties": properties})
    return {"shape": "RINGS", "cells": [], "rings": rings,
            "geojson": {"type": "FeatureCollection", "features": features}}


def _cells(native: Any, item: dict, options: dict, terrain: _CheckedTerrain, check, remaining: int) -> dict:
    if len(native.cells) > remaining:
        _fail("覆盖输出cells超过限额", "COVERAGE_LIMIT")
    cells, features = [], []
    lon_step = options["cell_m"] / (111320 * max(0.2, math.cos(math.radians(item["lat"]))))
    lat_step = options["cell_m"] / 111320
    for (gx, gy), margin in sorted(native.cells.items()):
        check()
        if isinstance(gx, bool) or isinstance(gy, bool) or not isinstance(gx, int) or not isinstance(gy, int):
            _fail("原生覆盖cell索引无效", "COVERAGE_RESULT")
        margin = _number(margin, "cell.margin_db", code="COVERAGE_RESULT")
        lon, lat = item["lon"] + gx * lon_step, item["lat"] + gy * lat_step
        west, south, east, north = terrain.bbox
        # 原生射线在DEM内，量化后的格中心偶有越界；保留原生索引但不绘制区外点。
        visible = west <= lon < east and south < lat <= north
        cells.append({"gx": gx, "gy": gy, "margin_db": margin, "displayable": visible})
        if visible:
            features.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
                             "properties": {"device_id": item["device_id"], "node_id": item["node_id"],
                                            "gx": gx, "gy": gy, "margin_db": margin, "is_coverage": True}})
    return {"shape": "CELLS", "origin": [item["lon"], item["lat"]], "cell_m": options["cell_m"],
            "radius_m": options["radius_m"], "cells": cells, "rings": [],
            "geojson": {"type": "FeatureCollection", "features": features}}


def compute_frozen_coverage(raw_snapshot: dict, frozen_tables: dict, *,
                            terrain: Callable[[], Any], fingerprint: Callable[[], str | None],
                            params: dict | None = None, cancelled: Callable[[], bool] | None = None,
                            progress: Callable[[float, str], None] | None = None,
                            bandwidth_selection: dict | None = None,
                            _field_surface: bool = False, _terrain_surface: bool = False) -> dict:
    """计算冻结物理设备覆盖。调用方负责权限、任务、原子缓存与终态。"""
    def check():
        if cancelled is not None and cancelled():
            raise FrozenCoverageCancelled("冻结覆盖已请求取消，未返回可发布缓存")

    def tick(value, stage):
        check()
        if progress is not None:
            progress(value, stage)
        check()

    check()
    # 进度/指纹等外部回调可改变调用方对象；所有后续断言和计算共用发起副本。
    raw, tables, options = deepcopy(raw_snapshot), deepcopy(frozen_tables), _parameters(deepcopy(params))
    selection = deepcopy(bandwidth_selection)
    raw_hash, tables_hash = _digest(raw), _digest(tables)
    if not isinstance(raw, dict) or not isinstance(tables, dict) or not isinstance(raw.get("detail"), dict):
        _fail("缺少冻结快照与资源表")
    choices = _selection_choices(raw, tables, selection)
    selected = {row["device_id"]: row["rx_bandwidth_khz"] for row in choices}
    solution_id = _identity(raw.get("solution_id"), "solution_id")
    expected = raw.get("terrain_fingerprint")
    if not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        _fail("冻结DEM指纹缺失或无效", "COVERAGE_TERRAIN")
    if not callable(terrain) or not callable(fingerprint):
        _fail("必须显式提供DEM工厂和指纹核验函数", "COVERAGE_TERRAIN")

    def verify():
        check()
        try:
            actual = fingerprint()
        except (OSError, ValueError, TypeError) as exc:
            raise FrozenCoverageError("COVERAGE_TERRAIN", "DEM指纹无法核验，结果未接受") from exc
        check()
        if actual != expected:
            _fail("冻结DEM与当前核验来源不一致，覆盖结果未接受", "COVERAGE_TERRAIN_CHANGED")

    tick(0, "核验冻结输入")
    verify()
    try:
        checked = _CheckedTerrain(terrain(), check)
    except FrozenCoverageError:
        raise
    except (OSError, KeyError, TypeError, ValueError) as exc:
        raise FrozenCoverageError("COVERAGE_TERRAIN", "核验DEM加载失败，未使用默认地形") from exc
    verify()
    detail = raw["detail"]
    nodes = _index(detail.get("nodes"), "node_id", "detail.nodes")
    devices = _index(detail.get("devices"), "device_id", "detail.devices")
    if not nodes or not devices:
        _fail("冻结方案没有已部署节点或设备")
    if len(devices) > MAX_DEVICES:
        _fail("冻结设备数量超过限额", "COVERAGE_LIMIT")
    for did, device in devices.items():
        for key in ("node_id", "model_id", "antenna_id"):
            _identity(device.get(key), did + "." + key)
        if device["node_id"] not in nodes:
            _fail("设备引用方案外节点：" + did)
    plans = _index(detail.get("params", {}).get("params") if isinstance(detail.get("params"), dict) else None,
                   "device_id", "detail.params.params")
    if set(plans) - set(devices):
        _fail("冻结计划参数引用方案外设备")
    models = _index(tables.get("device_model.csv"), "model_id", "device_model.csv")
    antennas = _index(tables.get("antenna_model.csv"), "antenna_id", "antenna_model.csv")
    frequencies = _frequencies(detail, devices, nodes, models)
    computations = sum(len(value) for value in frequencies.values())
    if computations > MAX_COMPUTATIONS:
        _fail("设备频率组合超过限额", "COVERAGE_LIMIT")
    for node in nodes.values():
        lon = _number(node.get("lon"), node["node_id"] + ".lon", lo=-180, hi=180)
        lat = _number(node.get("lat"), node["node_id"] + ".lat", lo=-85, hi=85)
        checked.elevation(lon, lat)
        checked.landcover(lon, lat)
    ray_steps = 0
    for device in devices.values():
        if models.get(device.get("model_id"), {}).get("device_class") == "VUHF":
            ray_steps += len(frequencies[device["device_id"]]) * int(360 / options["az_step_deg"]) * int(options["radius_m"] / options["cell_m"])
    if ray_steps > MAX_RAY_STEPS:
        _fail("覆盖射线步预算超过限额", "COVERAGE_LIMIT")
    viewshed, feasibility = _modules()
    output, cell_count, done = [], 0, 0
    for did, device in sorted(devices.items()):
        tick(0.05 + 0.9 * len(output) / len(devices), "计算冻结设备 " + did)
        nid = _identity(device.get("node_id"), did + ".node_id")
        if nid not in nodes:
            _fail("设备引用方案外节点：" + did)
        model_id = _identity(device.get("model_id"), did + ".model_id")
        antenna_id = _identity(device.get("antenna_id"), did + ".antenna_id")
        model, antenna, plan = models.get(model_id), antennas.get(antenna_id), plans.get(did)
        node = nodes[nid]
        item = {"device_id": did, "node_id": nid, "model_id": model_id, "antenna_id": antenna_id,
                "lon": float(node["lon"]), "lat": float(node["lat"]), "band": (model or {}).get("device_class"),
                "status": "UNAVAILABLE", "reason_code": None, "reasons": [], "planned_parameters": deepcopy(plan),
                "frozen_model": deepcopy(model), "frozen_antenna": deepcopy(antenna),
                "radio_parameters": None, "computations": [],
                "bandwidth_provenance": _bandwidth_provenance(model)}
        item["rx_bandwidth"] = _bandwidth_info(model, did, selected.get(did))
        if (model or {}).get("device_class") in ("HF", "VUHF"):
            assigned_links = {lid for group in frequencies[did].values() for lid in group}
            for link in detail["links"]:
                if link["link_id"] in assigned_links and link.get("device_class") != model["device_class"]:
                    _fail("冻结链路频段与设备型号不一致：" + did)
        unknown = None
        try:
            radio = _radio(device, plan, model, antenna, assigned_frequencies=frequencies[did],
                           rx_bandwidth=item["rx_bandwidth"]["value_khz"])
        except _UnknownRadio as exc:
            unknown = str(exc)
        # 缺失参数可不适用，但已给的非法数值和归属错误不能被跳过。
        if not frequencies[did]:
            item.update(status="SKIPPED", reason_code="NO_ASSIGNED_FREQUENCY")
            item["reasons"].append("无活动冻结链路分配频率，禁止代入代表频率")
            output.append(item)
            continue
        if unknown is not None:
            item["reasons"].append(unknown)
            item["reason_code"] = {"UNKNOWN": "RX_BANDWIDTH_UNKNOWN",
                "UNSELECTED": "RX_BANDWIDTH_SELECTION_REQUIRED"}.get(item["rx_bandwidth"]["source"], "FROZEN_PARAMETERS_UNKNOWN")
            output.append(item)
            continue
        if _field_surface and ((item["band"] == "HF" and any(not 1600 <= f <= 30000 for f in frequencies[did]))
                or (item["band"] == "VUHF" and any(not 30000 <= f <= 6000000 for f in frequencies[did]))):
            item.update(status="UNAVAILABLE", reason_code="FROZEN_PARAMETERS_UNKNOWN",
                        reasons=["冻结工作频率超出当前传播模型适用范围，未生成外推场强"], radio_parameters=None)
            output.append(item)
            continue
        item["radio_parameters"] = dict(radio)
        station = feasibility.Station(nid, node["lon"], node["lat"], node.get("node_subtype"),
                                      {item["band"]: _CheckedRadio(radio, check)})
        for freq, link_ids in sorted(frequencies[did].items()):
            check()
            if not radio["fmin"] <= freq <= radio["fmax"]:
                _fail("冻结计划频率超出本设备型号范围：" + did)
            try:
                if _field_surface:
                    if _terrain_surface:
                        from . import coverage_terrain_surface as surface
                    else:
                        from . import coverage_field_surface as surface
                    field_item = dict(item, frequency=freq)
                    if item["band"] == "VUHF":
                        result = surface.vuhf_surface(checked, field_item, options, check, MAX_CELLS - cell_count)
                        cell_count += len(result["cells"])
                    else:
                        if _terrain_surface:
                            result = surface.hf_surface(checked, field_item, options, check, _circle,
                                                        limit=MAX_CELLS - cell_count)
                            cell_count += len(result["cells"])
                        else:
                            result = surface.hf_surface(checked, field_item, options, check, _circle)
                elif item["band"] == "VUHF":
                    native = viewshed.vuhf_coverage(checked, station, radius_m=options["radius_m"],
                        cell_m=options["cell_m"], az_step=options["az_step_deg"], margin_min=options["margin_min_db"],
                        freq_khz=freq, rx_height_m=options["rx_height_m"])
                    result = _cells(native, item, options, checked, check, MAX_CELLS - cell_count)
                    cell_count += len(result["cells"])
                else:
                    native = viewshed.hf_coverage_rings(checked, station, freq_khz=freq, hour=options["hour"],
                        margin_min=options["margin_min_db"], max_km=options["hf_max_km"])
                    result = _rings(native, item, options, check)
            except FrozenCoverageError:
                raise
            except (ArithmeticError, AttributeError, KeyError, TypeError, ValueError) as exc:
                raise FrozenCoverageError("COVERAGE_RESULT", "原生覆盖计算未产生可接受结果：" + did) from exc
            check()
            for feature in result["geojson"]["features"]:
                feature["properties"]["freq_khz"] = freq
            item["computations"].append({"freq_khz": freq, "link_ids": sorted(link_ids), **result})
            done += 1
        if item["computations"]:
            item["status"] = "COMPLETE"
        output.append(item)
    tick(0.98, "核对DEM来源与覆盖JSON")
    verify()
    summary = _summary(output)
    result = {"schema_version": 2, "solution_id": solution_id,
              "status": _overall(summary), "summary": summary,
              "devices": output, "provenance": {"raw_snapshot_sha256": raw_hash, "frozen_tables_sha256": tables_hash,
                  "terrain_fingerprint": expected, "dem_bbox": list(checked.bbox), "parameters": options,
                  "terrain_metadata": {"dem": deepcopy(checked.source._dem.meta), "landcover": deepcopy(checked.source._lc.meta)},
                  "engine_version": ENGINE_VERSION,
                  "bandwidth_selection_id": selection["selection_id"] if selection else None,
                  "bandwidth_selection_hash": selection["selection_hash"] if selection else None,
                  "bandwidth_choices": choices,
                  "algorithms": ["viewshed.vuhf_coverage", "viewshed.hf_coverage_rings"],
                  "receiver_assumptions": {"gain_dbi": 0, "vuhf_height_m": options["rx_height_m"],
                      "bandwidth_and_sensitivity": "explicit frozen receive selection or unique frozen model value; sensitivity from frozen model",
                      "service": {"HF": "话音", "VUHF": "数据"}},
                  "hf_ionosphere": {"assumed": True, "verification": "典型电离层参数，待实测订正，非实测来源",
                      **viewshed.P533.ionosphere(options["hour"]), "sunspot_r12": viewshed.P533.SUNSPOT_R12},
                  "units": {"margin_db": "dB", "frequency": "kHz", "ring_radius": "m"},
                  "sampling": {"vuhf": "native radial cells; GeoJSON is quantized cell centers, not a continuous boundary",
                               "hf": "spherical sampled annuli with holes; skip zones are not coverage",
                               "computed_device_frequencies": done, "native_cell_count": cell_count},
                  "limitations": ["算法预测，不是实测场强；margin_db是链路预算余量，不是dBuV/m",
                      "接收带宽选择仅为本次覆盖接收假设，不表示设备已生效或父方案原计算使用此值，不回写父路由指标",
                      "无current CSV、默认地形、代表频率或未知参数代入",
                      "现有函数以标量天线增益计算，未建模方向图/方位/下倾角",
                      "HF沿用冻结站点地物和指定hour的既有传播假设，不代表远域DEM实测或实时电离层",
                      "hf_max_km仅限制地波距离搜索，原生天波环半径保留，不构造全域覆盖率"]}}
    validate_v4_result(result)
    if _field_surface:
        if _terrain_surface:
            from . import coverage_terrain_surface as surface
        else:
            from . import coverage_field_surface as surface
        result["provenance"].update(engine_version=surface.VERSION, field_strength=surface.metadata(),
            algorithms=["propagation.vuhf_path_loss/P1812", "propagation.hf_ground_wave_loss/P368", "prop.p533.path_loss"],
            sampling={"vuhf":"DEM内逐格中心地形剖面与接收预算；仅染色达标格面，不插值跨越盲区",
                      "hf":"1km距离预算分带；静区不染色；不按固定倍数设定天波外缘",
                      "computed_device_frequencies":done, "native_cell_count":cell_count},
            limitations=["预测场强dBuV/m由路径损耗、冻结功率与增益求得，非余量改名、非实测",
                "VUHF格面代表中心采样，边界精度受网格限制；DEM外与nodata不补造",
                "HF为距离环带模型，站点地物与假设电离层不代表远域逐方向地形",
                "P.368绝对定标与P.533电离层仍待实测订正，不能作为实测准确率证明",
                "分级为现有接收门限余量10/20dB显示规则，非新增验收门限",
                "接收带宽选择仅用于覆盖，不回写父方案；无活动链路设备不绘制",
                "方向图、方位与倾角资料未纳入；联合优化及其验收尚待完成"])
        result["provenance"]["units"]["field_strength"] = "dBuV/m"
        if _terrain_surface:
            result["provenance"]["algorithms"].append("propagation.knife_edge_loss_db/P526_SINGLE_EDGE_APPROXIMATION")
            result["provenance"]["sampling"]["hf"] = "局地网格距离预算与16段DEM剖面遮挡近似；径向天波预算仅供解释，不绘制远域假地形"
            result["provenance"]["limitations"][2] = "HF地波按局地DEM单刃遮挡近似，天波仅修正收发端低仰角遮挡；只绘制DEM及radius_m内格面，远域预算非精细地形预测"
        if _terrain_surface:
            validate_terrain_result(result)
        else:
            validate_field_result(result)
    _json(result, "COVERAGE_RESULT")
    tick(1, "冻结覆盖计算完成，待调用方原子发布")
    verify()
    return result


def compute_frozen_field_coverage(*args, **kwargs):
    """V5新计算入口；旧V4计算与冻结缓存保持原有语义。"""
    return compute_frozen_coverage(*args, **kwargs, _field_surface=True)


def compute_frozen_terrain_coverage(*args, **kwargs):
    """V6局地地形预览；独立版本，旧V4/V5结果不重标或改写。"""
    return compute_frozen_coverage(*args, **kwargs, _field_surface=True, _terrain_surface=True)


def validate_field_result(result):
    """V5严格检查预算场强，不允许把历史余量或采样点当作新覆盖面。"""
    if result.get("provenance", {}).get("engine_version") == "V01-6":
        from . import coverage_terrain_surface as surface
    else:
        from . import coverage_field_surface as surface
    validate_v4_result(result)
    provenance = result.get("provenance", {})
    if (provenance.get("engine_version") != surface.VERSION
            or provenance.get("field_strength") != surface.metadata()
            or provenance.get("units", {}).get("field_strength") != "dBuV/m"):
        _fail("V5预测场强来源或单位无效", "COVERAGE_RESULT")
    for device in result["devices"]:
        for part in device["computations"]:
            freq = _number(part.get("freq_khz"), "field.freq", lo=1e-9)
            for feature in part.get("geojson", {}).get("features", []):
                props = feature.get("properties", {})
                if props.get("device_id") != device["device_id"] or props.get("node_id") != device["node_id"] or props.get("freq_khz") != freq:
                    _fail("V5场强面设备或频率不一致", "COVERAGE_RESULT")
                for key in ("rx_power_dbm", "path_loss_db", "margin_db", "field_strength_dbuvm", "required_field_dbuvm"):
                    _number(props.get(key), "field."+key, code="COVERAGE_RESULT")
                rx, field = props["rx_power_dbm"], props["field_strength_dbuvm"]
                expected_rx = device["radio_parameters"]["tx_dbm"] + device["radio_parameters"]["gain"] - props["path_loss_db"]
                expected_class = "STRONG" if props["margin_db"] >= 20 else "MEDIUM" if props["margin_db"] >= 10 else "WEAK"
                if (not math.isclose(rx, expected_rx, abs_tol=1e-7)
                        or not math.isclose(field, surface.field_strength(rx, freq), abs_tol=1e-7)
                        or not math.isclose(field-props["required_field_dbuvm"], props["margin_db"], abs_tol=1e-7)
                        or props.get("strength_class") != expected_class
                        or type(props.get("is_coverage")) is not bool
                        or props["is_coverage"] != (props["margin_db"] >= provenance["parameters"]["margin_min_db"])):
                    _fail("V5场强预算或分级不一致", "COVERAGE_RESULT")
                geometry = feature.get("geometry")
                if geometry is not None and geometry.get("type") != "Polygon":
                    _fail("V5覆盖必须为计算格面或环带", "COVERAGE_RESULT")


def validate_terrain_result(result):
    """校验V6完整持久结果；服务裁减后的GIS投影不进入本函数。"""
    from .coverage_field_surface import signal_values

    def invalid(message):
        _fail(message, "COVERAGE_RESULT")

    def number(value, field, **bounds):
        if type(value) not in (int, float):
            invalid("地形预览数值类型无效：" + field)
        return _number(value, field, code="COVERAGE_RESULT", **bounds)

    def point(value):
        if not isinstance(value, list) or len(value) != 2:
            invalid("地形预览坐标必须为二维数值")
        return (number(value[0], "longitude", lo=-180, hi=180),
                number(value[1], "latitude", lo=-90, hi=90))

    def close_point(left, right):
        return all(math.isclose(a, b, rel_tol=0, abs_tol=1e-10) for a, b in zip(left, right))

    def grid_key(row):
        if not isinstance(row, dict) or any(type(row.get(key)) is not int for key in ("gx", "gy")):
            invalid("地形预览格索引必须为整数")
        return row["gx"], row["gy"]

    def distance_m(origin, lon, lat):
        p0, p1 = math.radians(origin[1]), math.radians(lat)
        a = (math.sin((p1-p0)/2) ** 2
             + math.cos(p0) * math.cos(p1) * math.sin(math.radians(lon-origin[0])/2) ** 2)
        return 2 * 6371008.8 * math.asin(math.sqrt(min(1, a)))

    try:
        if not isinstance(result, dict) or result.get("provenance", {}).get("engine_version") != "V01-6":
            invalid("地形预览版本无效")
        # 仅回读持久缓存时也须装载预算依赖，不依赖本进程此前已运行过计算。
        _modules()
        validate_field_result(result)
        provenance = result["provenance"]
        west, south, east, north = _bbox(provenance["dem_bbox"], "result.dem_bbox")
        parameters = provenance["parameters"]
        cell = number(parameters["cell_m"], "cell_m", lo=RANGES["cell_m"][0], hi=RANGES["cell_m"][1])
        maximum = number(parameters["radius_m"], "radius_m", lo=cell, hi=RANGES["radius_m"][1])
        minimum = number(parameters["margin_min_db"], "margin_min_db", lo=-100, hi=100)
        total = 0
        for device in result["devices"]:
            if not device["computations"]:
                continue
            origin = (number(device["lon"], "device.lon", lo=-180, hi=180),
                      number(device["lat"], "device.lat", lo=-85, hi=85))
            dx, dy = cell / (111320 * math.cos(math.radians(origin[1]))), cell / 111320
            band = device["band"]
            if band not in ("HF", "VUHF"):
                invalid("地形预览频段无效")
            radius = min(maximum, number(parameters["hf_max_km"], "hf_max_km", lo=1, hi=900) * 1000) if band == "HF" else maximum
            for part in device["computations"]:
                if (part.get("shape") != "CELLS" or not close_point(point(part["origin"]), origin)
                        or number(part["cell_m"], "part.cell_m") != cell
                        or number(part["radius_m"], "part.radius_m") != radius):
                    invalid("地形预览格网与冻结参数不一致")
                raw_cells = part.get("cells")
                collection = part["geojson"]
                if (not isinstance(raw_cells, list) or not isinstance(collection, dict)
                        or collection.get("type") != "FeatureCollection"
                        or not isinstance(collection.get("features"), list)):
                    invalid("地形预览缺少完整原始格网或格面集合")
                total += len(raw_cells)
                if total > MAX_CELLS:
                    invalid("地形预览原始格网超过采样限额")
                if type(part.get("evaluated_samples")) is not int or part["evaluated_samples"] != len(raw_cells):
                    invalid("地形预览采样计数不一致")
                indexed, covered = {}, set()
                for row in raw_cells:
                    key = grid_key(row)
                    if key in indexed:
                        invalid("地形预览存在重复原始格")
                    lon, lat = origin[0] + key[0] * dx, origin[1] + key[1] * dy
                    if (distance_m(origin, lon, lat) > radius + 1e-6
                            or not (west <= lon-dx/2 and lon+dx/2 < east
                                    and south < lat-dy/2 and lat+dy/2 <= north)):
                        invalid("地形预览格心超出半径或完整格面越出核验DEM")
                    expected = signal_values(device["radio_parameters"], number(row["path_loss_db"], "path_loss_db"),
                                             part["freq_khz"], "话音" if band == "HF" else "数据", minimum)
                    for field, value in expected.items():
                        if type(value) is bool:
                            valid = type(row.get(field)) is bool and row[field] == value
                        elif isinstance(value, str):
                            valid = row.get(field) == value
                        else:
                            valid = math.isclose(number(row.get(field), field), value, rel_tol=0, abs_tol=1e-7)
                        if not valid:
                            invalid("地形预览原始格预算不一致：" + field)
                    if type(row.get("los")) is not bool:
                        invalid("地形预览视距标识无效")
                    number(row["clearance_m"], "clearance_m")
                    if band == "HF":
                        number(row["terrain_loss_db"], "terrain_loss_db", lo=0)
                        if row.get("propagation_mode") not in ("GROUND", "SKYWAVE"):
                            invalid("地形预览传播方式无效")
                    indexed[key] = row
                    if row["is_coverage"]:
                        covered.add(key)
                painted = set()
                for feature in collection["features"]:
                    props, geometry = feature["properties"], feature["geometry"]
                    key = grid_key(props)
                    if feature.get("type") != "Feature" or key in painted or key not in covered:
                        invalid("地形预览格面重复、无对应原始格或未达接收门限")
                    row = indexed[key]
                    if (props.get("surface_kind") != "TERRAIN_CELL"
                            or set(props) != set(row) | {"device_id", "node_id", "freq_khz", "surface_kind"}
                            or any(type(props[field]) is not type(value) or props[field] != value
                                   for field, value in row.items())):
                        invalid("地形预览格面字段与原始格不一致")
                    if not isinstance(geometry, dict) or geometry.get("type") != "Polygon":
                        invalid("地形预览必须为Polygon格面")
                    coordinates = geometry.get("coordinates")
                    if not isinstance(coordinates, list) or len(coordinates) != 1:
                        invalid("地形预览格面必须为单个无孔矩形")
                    ring = coordinates[0]
                    if not isinstance(ring, list) or len(ring) != 5 or ring[0] != ring[-1]:
                        invalid("地形预览矩形必须包含四角并显式闭合")
                    points = [point(value) for value in ring]
                    lon, lat = origin[0] + key[0] * dx, origin[1] + key[1] * dy
                    expected_corners = ((lon-dx/2, lat-dy/2), (lon+dx/2, lat-dy/2),
                                        (lon+dx/2, lat+dy/2), (lon-dx/2, lat+dy/2))
                    start = next((i for i, value in enumerate(expected_corners) if close_point(points[0], value)), None)
                    if start is None:
                        invalid("地形预览矩形与对应格位置不一致")
                    step = 1 if close_point(points[1], expected_corners[(start+1) % 4]) else -1
                    if not all(close_point(value, expected_corners[(start+step*i) % 4]) for i, value in enumerate(points[:4])):
                        invalid("地形预览矩形退化、自交或与对应格尺寸不一致")
                    if any(not (west <= lon <= east and south <= lat <= north) for lon, lat in points):
                        invalid("地形预览越出核验DEM")
                    painted.add(key)
                if painted != covered:
                    invalid("地形预览缺少已达接收门限的格面")
    except FrozenCoverageError as exc:
        if exc.code == "COVERAGE_RESULT":
            raise
        raise FrozenCoverageError("COVERAGE_RESULT", "地形预览完整结果无法核验") from exc
    except (ArithmeticError, AttributeError, IndexError, KeyError, TypeError, ValueError) as exc:
        raise FrozenCoverageError("COVERAGE_RESULT", "地形预览完整结果结构无效") from exc
