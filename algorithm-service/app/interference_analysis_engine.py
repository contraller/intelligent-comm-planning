"""只用冻结方案及资源表适配既有干扰算法，不重建当前网络。"""
from copy import copy, deepcopy
import hashlib
import importlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
MEASURE_TYPES = ("FREQ_ADJUST", "CHANNEL_SWITCH", "POWER_OPT", "ROUTE_REBUILD", "NODE_REDEPLOY")
TITLES = {"FREQ_ADJUST": "调整网系频率", "CHANNEL_SWITCH": "切换邻近信道", "POWER_OPT": "调整设备功率",
          "ROUTE_REBUILD": "重建受扰路由", "NODE_REDEPLOY": "迁移受扰节点"}


class AnalysisInputError(ValueError):
    pass


class AnalysisCancelled(RuntimeError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def runtime_path(value=None):
    base = (ROOT / "data/runtime/r2").resolve()
    path = Path(value).resolve() if value is not None else base
    if not path.is_relative_to(base):
        raise AnalysisInputError("干扰工作流运行目录必须在本树 data/runtime/r2 内")
    return path


def _number(value, name, *, positive=False):
    if isinstance(value, bool) or value is None or value == "":
        raise AnalysisInputError("缺少有效参数：" + name)
    try:
        result = float(value)
    except (ValueError, TypeError) as exc:
        raise AnalysisInputError("参数必须为有限数值：" + name) from exc
    if not math.isfinite(result) or positive and result <= 0:
        raise AnalysisInputError("参数范围无效：" + name)
    return result


def _modules():
    for path in (ROOT / "scripts", ROOT / "scripts/planning"):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    return {name: importlib.import_module(name) for name in (
        "interference", "frequency", "radio_params", "routing", "feasibility", "terrain", "devicespec")}


class FrozenInterferenceEngine:
    def __init__(self, *, runtime_root=None, terrain_provider=None, fingerprint_provider=None):
        self.runtime_root = runtime_path(runtime_root)
        self.terrain_provider = terrain_provider
        self.fingerprint_provider = fingerprint_provider

    def fingerprint(self):
        if self.fingerprint_provider is not None:
            return self.fingerprint_provider()
        from .planning_adjustment_service import terrain_fingerprint
        return terrain_fingerprint()

    def probe_plan(self, plan):
        try:
            raw = plan["raw_snapshot"]
            if not raw.get("terrain_fingerprint") or raw["terrain_fingerprint"] != self.fingerprint():
                raise AnalysisInputError("冻结地形指纹缺失或无法与现有 DEM 核对")
            detail = raw["detail"]
            for name in ("nodes", "devices", "links"):
                if not isinstance(detail.get(name), list) or not detail[name]:
                    raise AnalysisInputError("冻结方案缺少 " + name)
            for name in ("params", "frequency", "routes", "optimization"):
                if not isinstance(detail.get(name), dict):
                    raise AnalysisInputError("冻结方案缺少 " + name)
            if not detail["params"].get("params") or not detail["frequency"].get("link_assignments"):
                raise AnalysisInputError("冻结方案缺少设备实际参数或逐链路频点")
            if not detail["frequency"].get("assignments"):
                raise AnalysisInputError("冻结方案缺少网系频点分配")
            for assignment in detail["frequency"]["assignments"]:
                if not assignment.get("task_id"):
                    raise AnalysisInputError("冻结网系频点缺少task_id")
            digest(plan)
            return []
        except (KeyError, TypeError, ValueError) as exc:
            return [str(exc)]

    def validate_source(self, source):
        reasons = self.probe_plan(source["scene"]["plan_snapshot"])
        if reasons:
            raise AnalysisInputError("；".join(reasons))
        for source_row in source["scene"]["interference_sources"]:
            row = source_row["source_row"]
            for key in ("lon", "lat", "tx_power_dbm", "antenna_gain_dbi"):
                _number(row.get(key), row["interference_id"] + "." + key)
            for key in ("center_freq_khz", "bandwidth_khz", "antenna_height_m", "duty_cycle"):
                _number(row.get(key), row["interference_id"] + "." + key, positive=True)
            if (abs(float(row["lon"])) > 180 or abs(float(row["lat"])) > 90
                    or float(row["duty_cycle"]) > 1 or row.get("active") not in ("true", "false")
                    or row.get("pattern_type") not in ("OMNI", "DIRECTIONAL") or not row.get("interference_type")):
                raise AnalysisInputError("干扰源坐标、占空比、状态或类型无效")
            if row["pattern_type"] == "DIRECTIONAL":
                azimuth = _number(row.get("azimuth_deg"), "azimuth_deg")
                if not 0 <= azimuth <= 360:
                    raise AnalysisInputError("定向干扰源缺少有效方位角")

    def _build(self, source):
        self.validate_source(source)
        modules = _modules()
        IF, FQ, RP, routing, feasibility = (modules[k] for k in (
            "interference", "frequency", "radio_params", "routing", "feasibility"))
        scene = source["scene"]
        detail = scene["plan_snapshot"]["raw_snapshot"]["detail"]
        tables = source["resource"]["tables"]
        nodes, devices = deepcopy(detail["nodes"]), deepcopy(detail["devices"])
        links = [deepcopy(row) for row in detail["links"] if str(row.get("is_available", "true")).lower() != "false"]
        if not links:
            raise AnalysisInputError("冻结方案没有可分析链路")
        models, antennas = tables["device_model.csv"], tables["antenna_model.csv"]
        model_by_id = {r["model_id"]: r for r in models}
        antenna_by_id = {r["antenna_id"]: r for r in antennas}
        params = {r["device_id"]: r for r in detail["params"]["params"] if r.get("device_id")}
        filler = modules["devicespec"].SpecFiller(models)
        radios, per_node = {}, {}
        for device in devices:
            did = device["device_id"]
            if did not in params:
                continue
            model, antenna = model_by_id[device["model_id"]], antenna_by_id[device["antenna_id"]]
            device["tx_power_dbm"] = _number(params[did].get("tx_power_dbm"), did + ".tx_power_dbm")
            device["antenna_height_m"] = _number(params[did].get("antenna_height_m"), did + ".antenna_height_m", positive=True)
            radio = feasibility.radio_from_device(device, model, antenna, filler)
            for key in ("gain", "sens", "bw", "fmin", "fmax"):
                _number(radio.get(key), did + "." + key, positive=key in ("bw", "fmin", "fmax"))
            radios[did] = radio
            per_node.setdefault(device["node_id"], {}).setdefault(model["device_class"], radio)
        stations = [feasibility.Station(row["node_id"], row["lon"], row["lat"], row["node_subtype"],
                    per_node[row["node_id"]]) for row in nodes if row["node_id"] in per_node]
        frequency = detail["frequency"]
        assignments = {row["link_id"]: row for row in frequency["link_assignments"]}
        freq_of, net_of, tx_of = {}, {}, {}
        for link in links:
            lid = link["link_id"]
            _number(link.get("link_margin_db"), lid + ".link_margin_db")
            _number(link.get("distance_m"), lid + ".distance_m", positive=True)
            if lid not in assignments:
                raise AnalysisInputError("链路缺少冻结频点：" + lid)
            freq_of[lid] = _number(assignments[lid].get("freq_khz"), lid + ".freq_khz", positive=True)
            net_of[lid] = assignments[lid].get("net_id")
            for side in ("a", "b"):
                did = link.get("device_" + side + "_id")
                if did not in radios:
                    raise AnalysisInputError("链路缺少唯一冻结设备参数：" + lid)
                if not radios[did]["fmin"] <= freq_of[lid] <= radios[did]["fmax"]:
                    raise AnalysisInputError("冻结频点超出设备范围：" + lid)
                tx_of[(lid, link["node_" + side + "_id"])] = radios[did]["tx_dbm"]
        terrain = self.terrain_provider() if self.terrain_provider else modules["terrain"].DemTerrain()
        bbox = tuple(terrain.bbox)
        for row in [*nodes, *(r["source_row"] for r in scene["interference_sources"])]:
            lon, lat = float(row["lon"]), float(row["lat"])
            if not bbox[0] <= lon <= bbox[2] or not bbox[1] <= lat <= bbox[3]:
                raise AnalysisInputError("冻结对象超出已核验地形范围，禁止边缘钳位冒充地形")
        scenario = IF.build_scenario(stations, links, terrain,
            [deepcopy(row["source_row"]) for row in scene["interference_sources"]],
            freq_of=freq_of, net_of=net_of, tx_of=tx_of, device_radios=radios)
        if len(scenario.links) != len(links):
            raise AnalysisInputError("部分冻结链路未能进入算法场景")
        ftasks = FQ.tasks_from_nets(links, nodes, devices, models)
        FQ.fill_ranges_by_node(ftasks, links, nodes, devices, models)
        # 仅准备候选频点，不重新分配已确认方案的现用频点。
        FQ._prepare(ftasks, FQ.FreqPool(tables["frequency_resource.csv"]))
        graph = routing.graph_from_links(links, tables["link_metric.csv"])[0]
        return modules, scenario, ftasks, RP.capabilities_by_device(stations, devices, models, antennas), graph, filler.substitutions

    @staticmethod
    def _impact(IF, scenario, area=None):
        output = IF.analyze(scenario, area=False)
        if area is not None:
            output["affected_area"] = deepcopy(area)
        elif scenario.jammers:
            output["affected_area"] = IF.affected_area(scenario, cell_m=3000.0, bbox=tuple(scenario.terrain.bbox))
        else:
            output["affected_area"] = {"type": "FeatureCollection", "features": [],
                "properties": {"cell_m": 3000.0, "bbox": list(scenario.terrain.bbox)}}
        output.pop("_states", None)
        for row in [*output["affected_nodes"], *output["affected_links"]]:
            row["sinr_after_db"] = row.pop("snr_after_db")
        return output

    @staticmethod
    def _changes(cm, source):
        result = {"type": cm["type"], "target": deepcopy(cm["target"]), "detail": deepcopy(cm["detail"])}
        if cm["type"] == "POWER_OPT":
            links = source["scene"]["plan_snapshot"]["raw_snapshot"]["detail"]["links"]
            target = next(row for row in links if row["link_id"] == cm["target"]["link_id"])
            result["device_changes"] = []
            for change in cm["detail"]["tx_changes"]:
                side = "a" if target["node_a_id"] == change["node_id"] else "b"
                did = target.get("device_" + side + "_id")
                if not did:
                    raise AnalysisInputError("功率措施无法关联唯一物理设备")
                result["device_changes"].append({"device_id": did, "tx_power_dbm": change["to_dbm"]})
        return result

    def analyze(self, source, progress, cancelled):
        def tick(value, phase):
            if cancelled():
                raise AnalysisCancelled("分析已请求取消")
            progress(value, phase)

        tick(10, "核验冻结输入与地形")
        modules, scenario, tasks, caps, graph, substitutions = self._build(source)
        IF = modules["interference"]
        tick(25, "计算受扰对象与影响区域")
        before = self._impact(IF, scenario)
        # recommend 使用既有字段名，展示DTO才区分SNR/SINR。
        recommendation_input = deepcopy(before)
        for row in [*recommendation_input["affected_nodes"], *recommendation_input["affected_links"]]:
            row["snr_after_db"] = row["sinr_after_db"]
        tick(45, "计算五类抗干扰措施")
        detail = source["scene"]["plan_snapshot"]["raw_snapshot"]["detail"]
        candidates = [row for row in source["resource"]["tables"]["candidate_site.csv"]
            if scenario.terrain.bbox[0] <= _number(row.get("lon"), "candidate.lon") <= scenario.terrain.bbox[2]
            and scenario.terrain.bbox[1] <= _number(row.get("lat"), "candidate.lat") <= scenario.terrain.bbox[3]]
        cms, unresolved, review = IF.recommend(scenario, recommendation_input,
            freq_ctx=IF.FreqContext(tasks, detail["frequency"]["assignments"]), caps=caps,
            route_ctx=(graph, detail["routes"]), candidate_rows=candidates)
        measures, previews = [], {}
        for index, cm in enumerate(cms):
            tick(55 + int(35 * index / max(1, len(cms))), "计算措施预览 %s/%s" % (index + 1, len(cms)))
            mid = "CM-" + digest(cm)[:24]
            change = self._changes(cm, source)
            # 共享只读地形，复制可变场景状态；避免为每条措施复制完整DEM网格。
            alternate = copy(scenario)
            alternate.links, alternate.pos, alternate._sig = deepcopy(scenario.links), dict(scenario.pos), dict(scenario._sig)
            if cm["type"] == "POWER_OPT":
                # 旧adopt按节点/频段扩散功率；此处按冻结物理设备精确应用。
                for item in change["device_changes"]:
                    for link in alternate.links:
                        for node_id, device_id in link.device.items():
                            if device_id == item["device_id"]:
                                link.tx[node_id] = item["tx_power_dbm"]
            else:
                IF.adopt(alternate, deepcopy(cm))
            # 影响区取决于干扰源而非受扰网络；各措施没有修改干扰源。
            after = self._impact(IF, alternate, before["affected_area"])
            preview = {"measure_id": mid, "before_configuration": deepcopy({k: detail[k] for k in (
                "nodes", "devices", "links", "params", "frequency", "routes")}),
                "proposed_changes": change, "impact_after": after, "metrics": None,
                "available": True, "unavailable_reasons": []}
            preview_hash = digest(preview)
            previews[mid] = {**preview, "preview_hash": preview_hash}
            measures.append({"measure_id": mid, "type": cm["type"],
                "target_node_id": cm["target"].get("node_id"), "target_link_id": cm["target"].get("link_id"),
                "priority": cm["priority"], "title": TITLES[cm["type"]], "detail": cm.get("note", ""),
                "risk": cm["detail"].get("side_effect", "预评估不等于重算达标；采纳后仍须核验完整方案"),
                "available": True, "unavailable_reasons": [], "change_set": change,
                "preview_hash": preview_hash, "pre_eval": deepcopy(cm.get("pre_eval")), "restores": cm["restores"]})
        tick(95, "冻结结果与措施预览")
        if self.fingerprint() != source["scene"]["plan_snapshot"]["raw_snapshot"]["terrain_fingerprint"]:
            raise AnalysisInputError("计算期间地形来源发生变化，结果未接受")
        output = {**before, "measures": measures, "previews": previews, "unresolved": unresolved,
            "measure_review": review, "parameter_substitutions": [list(row) for row in substitutions],
            "notes": ["算法预测，非实测；未生成的全网指标保持未知",
                      "型号原字段保持缺失；parameter_substitutions明确列出既有SpecFiller用于计算的推定及依据"]}
        digest(output)
        return output
