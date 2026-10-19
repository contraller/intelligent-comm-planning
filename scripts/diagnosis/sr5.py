"""SR-5 fault diagnosis over the project's explicitly synthetic data."""
from __future__ import annotations

import ast
import csv
import json
from collections import defaultdict

from datapaths import path as data_path
from diagnosis.kg_store import KnowledgeGraph

FAULT_TYPES = {"HW_FAILURE", "LINK_DOWN", "SW_CONFIG", "EMI"}
ALLOWED_OBJECTS = {
    "HW_FAILURE": {"DEVICE", "NODE"},
    "LINK_DOWN": {"LINK"},
    "SW_CONFIG": {"DEVICE", "NODE"},
    "EMI": {"LINK", "NODE"},
}


class FaultInputError(ValueError):
    def __init__(self, message, code=1001, detail=None):
        super().__init__(message)
        self.code = code
        self.detail = detail


def _csv(name):
    with open(data_path(name), encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _json(name):
    with open(data_path(name), encoding="utf-8-sig") as handle:
        return json.load(handle)


def _eval_condition(node, observation):
    """Evaluate the documented rule subset; None means an input is missing."""
    if isinstance(node, ast.Expression):
        return _eval_condition(node.body, observation)
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int, float, bool)):
        return node.value
    if isinstance(node, ast.Name) and node.id in {
        "device_selftest", "snr_db", "ber", "packet_loss_rate", "delay_ms",
        "throughput_kbps", "tx_power_dbm", "symptom_ids"
    }:
        return observation.get(node.id)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "has_symptom" and not node.keywords and len(node.args) == 1:
        value = _eval_condition(node.args[0], observation)
        if not isinstance(value, str):
            raise ValueError("has_symptom requires a symptom ID")
        return value in observation["symptom_ids"]
    if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
        values = [_eval_condition(v, observation) for v in node.values]
        if isinstance(node.op, ast.And):
            return False if False in values else (None if None in values else True)
        return True if True in values else (None if None in values else False)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        value = _eval_condition(node.operand, observation)
        return None if value is None else not value
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
        left = _eval_condition(node.left, observation)
        right = _eval_condition(node.comparators[0], observation)
        if left is None or right is None:
            return None
        op = node.ops[0]
        operations = {
            ast.Eq: lambda a, b: a == b, ast.NotEq: lambda a, b: a != b,
            ast.Lt: lambda a, b: a < b, ast.LtE: lambda a, b: a <= b,
            ast.Gt: lambda a, b: a > b, ast.GtE: lambda a, b: a >= b,
            ast.In: lambda a, b: a in b,
        }
        for kind, fn in operations.items():
            if isinstance(op, kind):
                return fn(left, right)
    raise ValueError("Unsupported fault rule expression")


class FaultEngine:
    def __init__(self):
        self.cases = {r["case_id"]: r for r in _csv("fault_case.csv")}
        self.rules = _csv("fault_rule.csv")
        self.symptoms = {r["symptom_id"]: r["symptom_name"] for r in _csv("symptom_dict.csv")}
        self.nodes = {r["node_id"]: r for r in _csv("node.csv")}
        self.devices = {r["device_id"]: r for r in _csv("device.csv")}
        self.models = {r["model_id"]: r for r in _csv("device_model.csv")}
        self.links = {r["link_id"]: r for r in _csv("link.csv")}
        self.demands = {r["demand_id"]: r for r in _csv("comm_demand.csv")}
        self.graph = self._build_graph()
        self.default_scenarios = _json("fault_scenario.json")
        for rule in self.rules:
            rule["_tree"] = ast.parse(rule["condition_expression"], mode="eval")
            rule["_symptoms"] = {node.args[0].value for node in ast.walk(rule["_tree"])
                                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                                 and node.func.id == "has_symptom" and len(node.args) == 1
                                 and isinstance(node.args[0], ast.Constant)}
            _eval_condition(rule["_tree"], {"symptom_ids": set(), "device_selftest": ""})

    def _build_graph(self):
        graph = KnowledgeGraph("synthetic_fault_cases")
        for case in self.cases.values():
            cid = case["case_id"]
            fault = ("Fault", cid)
            source = "fault_cases_v1.csv#%s [CONSTRUCTED]" % cid
            for sid in filter(None, case["symptom_ids"].split(";")):
                if sid in self.symptoms:
                    graph.add_triple(fault, "hasSymptom", ("Symptom", self.symptoms[sid]),
                                     source=source, graph="fault")
            cause = case["root_cause"].strip()
            component = case["fault_component"].strip()
            solution = case["solution"].strip()
            if cause:
                graph.add_triple(fault, "causedBy", ("Cause", cause), source=source, graph="fault")
            if component:
                graph.add_triple(fault, "locatedAt", ("Component", component), source=source, graph="fault")
            if solution:
                graph.add_triple(fault, "resolvedBy", ("Solution", solution), source=source, graph="fault")
            for index, step in enumerate(filter(None, case["diagnosis_steps"].split(";")), 1):
                graph.add_triple(fault, "diagnosedBy", ("DiagnosisStep", f"{index:02d}:{step.strip()}"),
                                 source=source, graph="fault")
        graph.freeze("Derived from constructed cases; not field-validated")
        return graph

    def write_graph_csv(self, path):
        return self.graph.write_csv(str(path), graph="fault")

    def validate(self, scenario, require_fault_type=True):
        faults = scenario.get("faults")
        if not scenario.get("scenario_name") or not isinstance(faults, list) or not faults:
            raise FaultInputError("scenario_name 和至少一条 faults 为必填")
        for index, fault in enumerate(faults):
            if not isinstance(fault, dict):
                raise FaultInputError("faults[%d] 应为对象" % index)
            kind, obj = fault.get("fault_type"), fault.get("object_type")
            if require_fault_type and (not isinstance(kind, str) or kind not in FAULT_TYPES):
                raise FaultInputError("未知故障类型 %r" % kind, code=1003, detail={"index": index})
            if not require_fault_type and kind is not None:
                raise FaultInputError("观测诊断输入不应包含 fault_type", detail={"index": index})
            if not isinstance(obj, str) or obj not in {"NODE", "DEVICE", "LINK"}:
                raise FaultInputError("未知故障对象类型 %r" % obj, code=1003, detail={"index": index})
            if require_fault_type and obj not in ALLOWED_OBJECTS[kind]:
                raise FaultInputError("故障类型 %s 不适用于 %s" % (kind, obj), 3003,
                                      {"index": index, "fault_type": kind, "object_type": obj})
            entities = {"NODE": self.nodes, "DEVICE": self.devices, "LINK": self.links}[obj]
            if fault.get("object_id") not in entities:
                raise FaultInputError("故障对象 %r 不存在" % fault.get("object_id"), 1002,
                                      {"index": index})
            symptoms = fault.get("symptom_ids") or []
            if not isinstance(symptoms, list) or not all(isinstance(s, str) for s in symptoms):
                raise FaultInputError("faults[%d].symptom_ids 应为字符串列表" % index)
            symptom_names = fault.get("symptom_names") or []
            if (not isinstance(symptom_names, list) or
                    not all(isinstance(s, str) and s.strip() for s in symptom_names)):
                raise FaultInputError("faults[%d].symptom_names 应为非空字符串列表" % index)
            if not isinstance(fault.get("params") or {}, dict):
                raise FaultInputError("faults[%d].params 应为对象" % index)
            bad = set(symptoms) - self.symptoms.keys()
            if bad:
                raise FaultInputError("未知故障现象 %s" % sorted(bad), 1002, {"index": index})
        return {"valid": True, "fault_count": len(faults)}

    def _context(self, fault):
        obj, oid = fault["object_type"], fault["object_id"]
        if obj == "DEVICE":
            dev = self.devices[oid]
            node_id = dev["node_id"]
            band = self.models.get(dev["model_id"], {}).get("device_class")
        elif obj == "LINK":
            node_id = self.links[oid]["node_a_id"]
            band = self.links[oid]["device_class"]
        else:
            node_id = oid
            raw_band = self.nodes[oid].get("device_class", "")
            band = raw_band if ";" not in raw_band else None
        return node_id, band

    def _rule_branch(self, fault, band):
        observed = set(fault.get("symptom_ids") or [])
        params = fault.get("params") or {}
        observation = {**params, "symptom_ids": observed}
        hits = []
        for rule in self.rules:
            if rule["object_type"] != fault["object_type"] or (band and rule["device_class"] != band):
                continue
            if not rule["_symptoms"] or not observed.intersection(rule["_symptoms"]):
                continue
            result = _eval_condition(rule["_tree"], observation)
            if result is False:
                continue
            confidence = float(rule["confidence"]) * (1.0 if result is True else 0.65)
            hits.append((confidence, int(rule["priority"]), rule, result is True))
        if not hits:
            return {"source": "RULE", "fault_type": None, "confidence": None,
                    "disabled_reason": "没有匹配当前现象与对象的规则", "evidence": {}}
        hits.sort(key=lambda item: (item[0], item[1]), reverse=True)
        confidence, _priority, top, exact = hits[0]
        return {"source": "RULE", "fault_type": top["fault_type"],
                "confidence": round(confidence, 3),
                "root_cause": top["root_cause"], "fault_component": top["fault_component"],
                "action": top["action_suggestion"],
                "evidence": {"rule_ids": [item[2]["rule_id"] for item in hits[:5]],
                             "match_kind": "EXACT" if exact else "PARTIAL_MISSING_INPUT",
                             "source_case_ids": [item[2]["source_case_id"] for item in hits[:5]],
                             "source": "CONSTRUCTED"}}

    def _kg_branch(self, fault, band, graph=None):
        graph = graph if graph is not None else self.graph
        observed = set(fault.get("symptom_ids") or [])
        observed_names = {self.symptoms[sid] for sid in observed if sid in self.symptoms}
        observed_names.update(str(name).strip() for name in fault.get("symptom_names") or [])
        by_case = defaultdict(set)
        evidence = defaultdict(set)
        for symptom_name in observed_names:
            eid = graph.get("Symptom", symptom_name)
            if not eid:
                continue
            for triple in graph.incoming(eid, "hasSymptom"):
                cid = graph.ent(triple["head"])["name"]
                if graph.ent(triple["head"])["type"] == "Fault":
                    by_case[cid].add(symptom_name)
                    evidence[cid].add(triple["tid"])
        candidates = []
        for cid, matches in by_case.items():
            fault_eid = graph.get("Fault", cid)
            case = self.cases.get(cid)
            type_edges = list(graph.outgoing(fault_eid, "instanceOf")) if fault_eid else []
            object_edges = list(graph.outgoing(fault_eid, "occursOn")) if fault_eid else []
            fault_type = (graph.ent(type_edges[0]["tail"])["name"] if type_edges else
                          case.get("fault_type") if case else None)
            object_type = (graph.ent(object_edges[0]["tail"])["name"] if object_edges else
                           case.get("object_type") if case else None)
            if not fault_type or object_type != fault["object_type"]:
                continue
            if case and band and case["device_class"] != band:
                continue
            if not case and band:
                constraints = [graph.ent(edge["tail"])["name"]
                               for edge in graph.outgoing(fault_eid, "constrainedBy")]
                case_bands = {value.split("=", 1)[1] for value in constraints
                              if value.startswith("device_class=")}
                if case_bands and band not in case_bands:
                    continue
            overlap = len(matches) / max(len(observed_names), 1)
            score = 0.45 + 0.45 * overlap
            candidates.append((score, len(matches), cid, fault_type))
        if not candidates:
            return {"source": "KG", "fault_type": None, "confidence": None,
                    "disabled_reason": "合成案例图谱无匹配路径", "evidence": {}}
        candidates.sort(key=lambda item: (-item[0], -item[1], item[2]))
        score, _n, cid, fault_type = candidates[0]
        equally_supported = [candidate for candidate in candidates
                             if candidate[0] == score and candidate[1] == _n]
        fault_eid = graph.get("Fault", cid)
        path_ids = set(evidence[cid])
        related = {}
        for relation in ("causedBy", "locatedAt", "resolvedBy"):
            triples = list(graph.outgoing(fault_eid, relation))
            path_ids.update(t["tid"] for t in triples)
            related[relation] = graph.ent(triples[0]["tail"])["name"] if triples else None
        step_triples = list(graph.outgoing(fault_eid, "diagnosedBy"))
        path_ids.update(t["tid"] for t in step_triples)
        steps = sorted(graph.ent(t["tail"])["name"] for t in step_triples)
        ranking = []
        for candidate_score, match_count, candidate_id, candidate_type in candidates[:10]:
            tids = sorted(evidence[candidate_id])
            ranking.append({"case_id": candidate_id, "fault_type": candidate_type,
                            "score": round(candidate_score, 3),
                            "matched_symptom_count": match_count,
                            "triple_ids": tids,
                            "source_docs": sorted({graph.triples[tid]["source"] for tid in tids})})
        return {"source": "KG", "fault_type": fault_type,
                "confidence": round(score, 3), "root_cause": related["causedBy"],
                "fault_component": related["locatedAt"], "action": related["resolvedBy"],
                "steps": [step.split(":", 1)[1] for step in steps],
                "evidence": {"case_id": cid, "triple_ids": sorted(path_ids),
                             "equally_supported_cases": [item[2] for item in equally_supported[:10]],
                             "candidate_rankings": ranking,
                             "source_docs": sorted({graph.triples[tid]["source"] for tid in path_ids}),
                             "source_doc": sorted({graph.triples[tid]["source"] for tid in path_ids})[0]}}

    def diagnose(self, scenario, weights=None, threshold=0.6, graph=None,
                 require_fault_type=True):
        self.validate(scenario, require_fault_type=require_fault_type)
        weights = weights or {"RULE": 0.35, "KG": 0.35, "ML": 0.30}
        if any(k not in {"RULE", "KG", "ML"} for k in weights) or any(not isinstance(v, (int, float)) or v < 0 for v in weights.values()) or sum(weights.values()) <= 0:
            raise FaultInputError("fusion_weights 必须为非负数且总和大于零")
        if not isinstance(threshold, (int, float)) or not 0 <= threshold <= 1:
            raise FaultInputError("confidence_threshold 应在 0 到 1 之间")
        results = []
        for fault in scenario["faults"]:
            node_id, band = self._context(fault)
            rule, kg = self._rule_branch(fault, band), self._kg_branch(fault, band, graph)
            ml = {"source": "ML", "fault_type": None, "confidence": None,
                  "disabled_reason": "现有 240 条案例均为 CONSTRUCTED，尚无经独立验证的 ML 模型", "evidence": {}}
            active = [b for b in (rule, kg) if b["confidence"] is not None and weights.get(b["source"], 0) > 0]
            denominator = sum(weights[b["source"]] for b in active)
            scores = defaultdict(float)
            for branch in active:
                scores[branch["fault_type"]] += weights[branch["source"]] * branch["confidence"] / denominator
            ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
            winning = ranked[0][0] if ranked else None
            explanation = next((b for b in (kg, rule) if b["fault_type"] == winning), {})
            confidence = ranked[0][1] if ranked else 0.0
            ambiguous = len(kg.get("evidence", {}).get("equally_supported_cases", [])) > 1
            partial_rule = rule.get("evidence", {}).get("match_kind") == "PARTIAL_MISSING_INPUT"
            branch_disagreement = len({b["fault_type"] for b in active}) > 1
            results.append({"fault_object": {"object_type": fault["object_type"],
                                             "object_id": fault["object_id"], "node_id": node_id},
                            "fault_component": explanation.get("fault_component"),
                            "fused": {"fault_type": winning, "confidence": round(confidence, 3),
                                      "root_cause": explanation.get("root_cause"),
                                      "need_manual_review": (not ranked or confidence < threshold or len(active) < 2
                                                             or ambiguous or partial_rule or branch_disagreement)},
                            "branches": [rule, kg, ml],
                            "candidates": [{"fault_type": key, "confidence": round(value, 3)}
                                           for key, value in ranked]})
        source_docs = [source for item in results
                       for branch in item["branches"] if branch["source"] == "KG"
                       for source in branch.get("evidence", {}).get("source_docs", [])]
        data_source = ("MIXED_UNVERIFIED" if any("CONSTRUCTED" not in source for source in source_docs)
                       else "CONSTRUCTED")
        return {"scenario_id": scenario.get("scenario_id"), "fusion_mode": "TWO_WAY_DEGRADED",
                "data_source": data_source, "input_snapshot": {
                    "scenario_name": scenario.get("scenario_name"),
                    "faults": [dict(item) for item in scenario["faults"]]}, "results": results}

    def _routes(self, network_solution=None):
        if network_solution is None:
            rows = _json("route.json")
            grouped = defaultdict(dict)
            for row in rows:
                grouped[row["demand_id"]][row["route_type"].lower()] = row
            return list(grouped.values()), self.links, "SYNTHETIC_BASELINE"
        detail = network_solution["detail"]
        routes = detail["routes"]
        return routes["routes"], {r["link_id"]: r for r in detail["links"]}, network_solution["solution_id"]

    def impact(self, scenario, diagnosis, network_solution=None, consider_backup=True):
        self.validate(scenario)
        routes, links, solution_id = self._routes(network_solution)
        down_nodes, down_links, degraded_links = set(), set(), set()
        direct = defaultdict(set)
        for fault in scenario["faults"]:
            obj, oid = fault["object_type"], fault["object_id"]
            if fault["fault_type"] == "EMI":
                if obj == "LINK":
                    degraded_links.add(oid)
                    if oid in links:
                        direct[oid].update((links[oid]["node_a_id"], links[oid]["node_b_id"]))
                else:
                    degraded_links.update(lid for lid, link in links.items()
                                          if oid in (link["node_a_id"], link["node_b_id"]))
                    direct[oid].add(oid)
                continue
            if obj == "NODE":
                down_nodes.add(oid)
                direct[oid].add(oid)
            elif obj == "DEVICE":
                node_id = self.devices[oid]["node_id"]
                matched = {lid for lid, link in links.items()
                           if oid in (link.get("device_a_id"), link.get("device_b_id"))}
                if matched:
                    down_links.update(matched)
                else:
                    down_nodes.add(node_id)
                direct[oid].add(node_id)
            else:
                down_links.add(oid)
                if oid in links:
                    direct[oid].update((links[oid]["node_a_id"], links[oid]["node_b_id"]))
        down_links.update(lid for lid, link in links.items()
                          if link["node_a_id"] in down_nodes or link["node_b_id"] in down_nodes)
        affected_nodes = {}
        for fault in scenario["faults"]:
            for nid in direct[fault["object_id"]]:
                row = self.nodes.get(nid, {})
                is_emi = fault["fault_type"] == "EMI"
                affected_nodes[nid] = {"node_id": nid, "affect_type": "DIRECT",
                                       "level": "MODERATE" if is_emi else "SEVERE",
                                       "state": "DEGRADED" if is_emi else "INTERRUPTED", "node_role": row.get("node_role"),
                                       "region": row.get("region"), "reason": "故障对象或关联链路直接受影响"}
        affected_demands, lost_rate = [], 0.0
        for route in routes:
            primary = route.get("primary")
            backup = route.get("backup")
            did = route.get("demand_id") or (primary or {}).get("demand_id")
            if not primary:
                continue
            hit = bool(set(primary.get("link_path") or ()) & down_links or
                       set(primary.get("node_path") or ()) & down_nodes)
            soft_hit = bool(set(primary.get("link_path") or ()) & degraded_links)
            if not hit and not soft_hit:
                continue
            backup_ok = bool(consider_backup and backup and
                             not (set(backup.get("link_path") or ()) & down_links or
                                  set(backup.get("node_path") or ()) & down_nodes))
            state = "DEGRADED" if backup_ok or soft_hit and not hit else "INTERRUPTED"
            demand = self.demands.get(did, {})
            if state == "INTERRUPTED":
                lost_rate += float(demand.get("required_rate_kbps") or 0)
            affected_demands.append({"demand_id": did, "state": state,
                                     "is_mandatory": demand.get("is_mandatory") == "true"})
            for nid in (primary["node_path"][0], primary["node_path"][-1]):
                if nid not in affected_nodes:
                    row = self.nodes.get(nid, {})
                    affected_nodes[nid] = {"node_id": nid, "affect_type": "INDIRECT",
                                           "level": ("SEVERE" if state == "INTERRUPTED" else
                                                     "MODERATE" if demand.get("is_mandatory") == "true" else "MINOR"),
                                           "state": state, "node_role": row.get("node_role"),
                                           "region": row.get("region"),
                                           "reason": ("主路由受干扰，链路性能下降" if soft_hit and not hit else
                                                      "主路由受损，%s" % ("已启用备用路由" if backup_ok else "无可用备用路由"))}
                elif state == "INTERRUPTED" and affected_nodes[nid]["level"] != "SEVERE":
                    affected_nodes[nid]["level"] = "SEVERE"
                    affected_nodes[nid]["state"] = state
        affected_links = []
        for lid in sorted(down_links | degraded_links):
            link = links[lid]
            is_down = lid in down_links
            is_backbone = link.get("is_backup") != "true"
            affected_links.append({"link_id": lid, "state": "INTERRUPTED" if is_down else "DEGRADED",
                                   "level": "SEVERE" if is_down else "MODERATE" if is_backbone else "MINOR",
                                   "related_fault_object_id": next((f["object_id"] for f in scenario["faults"]
                                                                    if f["object_id"] == lid or
                                                                    f["object_id"] in direct and
                                                                    (link["node_a_id"] in direct[f["object_id"]] or
                                                                     link["node_b_id"] in direct[f["object_id"]])), None),
                                   "is_backbone": is_backbone,
                                   "reason": "故障对象导致链路不可用"})
        features = []
        for nid, rec in affected_nodes.items():
            node = self.nodes.get(nid)
            if node:
                features.append({"type": "Feature", "properties": {"node_id": nid, "level": rec["level"],
                                                                   "state": rec["state"]},
                                 "geometry": {"type": "Point", "coordinates": [float(node["lon"]), float(node["lat"])]}})
        nodes_list = sorted(affected_nodes.values(), key=lambda row: row["node_id"])
        return {"scenario_id": scenario["scenario_id"], "network_solution_id": solution_id,
                "planning_check_passed": (network_solution.get("summary", {}).get("check_passed")
                                          if network_solution else None),
                "impact_scope": {"type": "FeatureCollection", "features": features,
                                 "note": "受影响对象位置，不代表电波覆盖边界"},
                "affected_nodes": nodes_list, "affected_links": affected_links,
                "affected_demands": affected_demands,
                "summary": {"affected_node_count": len(nodes_list),
                            "direct_count": sum(r["affect_type"] == "DIRECT" for r in nodes_list),
                            "indirect_count": sum(r["affect_type"] == "INDIRECT" for r in nodes_list),
                            "interrupted_node_count": sum(r["state"] == "INTERRUPTED" for r in nodes_list),
                            "degraded_node_count": sum(r["state"] == "DEGRADED" for r in nodes_list),
                            "affected_link_count": len(affected_links),
                            "total_bandwidth_loss_kbps": round(lost_rate, 2),
                            "affected_mandatory_demand_ids": [r["demand_id"] for r in affected_demands
                                                              if r["is_mandatory"]]}}

    def suggestions(self, diagnosis, impact=None):
        suggestions = []
        for result in diagnosis["results"]:
            if result["fused"]["need_manual_review"]:
                suggestions.append({"priority": len(suggestions) + 1,
                                    "action": "核对故障现象、设备自检码及链路指标后人工确认根因",
                                    "fault_object_id": result["fault_object"]["object_id"],
                                    "steps": [], "required_spares": [], "required_tools": [],
                                    "estimated_time_min": None, "kg_source_triple_ids": [],
                                    "similar_cases": [], "source": "MANUAL_REVIEW",
                                    "verification_required": True})
            primary = next((b for b in result["branches"] if b["source"] == "KG" and b["confidence"] is not None), None)
            if primary is None:
                primary = next((b for b in result["branches"] if b["source"] == "RULE" and b["confidence"] is not None), None)
            if primary is None:
                continue
            case = self.cases.get(primary["evidence"].get("case_id") or
                                  (primary["evidence"].get("source_case_ids") or [None])[0])
            suggestions.append({"priority": len(suggestions) + 1, "action": primary.get("action"),
                                "fault_object_id": result["fault_object"]["object_id"],
                                "steps": (primary["steps"] if primary["source"] == "KG" else
                                          case["diagnosis_steps"].split(";") if case else []),
                                "required_spares": [], "required_tools": [],
                                "estimated_time_min": float(case["repair_time_min"]) if case and case["repair_time_min"] else None,
                                "kg_source_triple_ids": primary["evidence"].get("triple_ids", []),
                                "similar_cases": [{"case_id": case["case_id"], "solution": case["solution"],
                                                   "source": "CONSTRUCTED"}] if case else [],
                                "source": "CONSTRUCTED",
                                "verification_required": result["fused"]["need_manual_review"]})
        if impact and any(r["state"] == "DEGRADED" for r in impact["affected_demands"]):
            suggestions.insert(0, {"priority": 1, "action": "启用可用备用路由并核查业务恢复",
                                   "steps": [], "required_spares": [], "required_tools": [],
                                   "estimated_time_min": None, "kg_source_triple_ids": [],
                                   "similar_cases": [], "source": "ROUTE_ANALYSIS"})
        for idx, row in enumerate(suggestions, 1):
            row["priority"] = idx
        return {"suggestions": suggestions, "data_source": "CONSTRUCTED"}
