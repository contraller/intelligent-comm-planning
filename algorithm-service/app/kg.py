"""SR-6 knowledge service over explicitly constructed sample data."""
from __future__ import annotations

import json
import math
import os
import re
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from diagnosis.kg_store import ENTITY_TYPES, RELATIONS  # noqa: E402
from diagnosis.sr5 import ALLOWED_OBJECTS, FAULT_TYPES  # noqa: E402
from diagnosis.sr6 import add_diagnostic_steps, add_fault_taxonomy, build_graph  # noqa: E402

STORE_PATH = Path(os.environ.get("SR6_STORE_PATH", ROOT / "data" / "runtime" / "sr6_graph.json"))
_LOCK = threading.RLock()
_GRAPH = None
_STATE = None


def _sync_link_rules(graph, state):
    attrs_by_id = {entity["attrs"]["rule_id"]: entity["attrs"]
                   for entity in graph.entities.values()
                   if entity["type"] == "Metric" and "rule_id" in entity["attrs"]}
    for rule in state.rules:
        attrs = attrs_by_id.get(rule["rule_id"])
        if attrs:
            rule["threshold"] = attrs["threshold"]
            rule["threshold_text"] = attrs["threshold_text"]


def _ok(data):
    return {"code": 0, "message": "success", "data": data}


def _bad(message, code=1001, data=None):
    return {"code": code, "message": message, "data": data}


def _load():
    global _GRAPH, _STATE
    if _GRAPH is None:
        with _LOCK:
            if _GRAPH is None:
                graph, state = build_graph()
                migrated = False
                if STORE_PATH.exists():
                    with STORE_PATH.open(encoding="utf-8") as handle:
                        saved = json.load(handle)
                    graph._restore(saved["snapshot"])
                    graph.version = saved["version"]
                    graph.versions = saved["versions"]
                    graph.pending = saved["pending"]
                    graph.log = saved["log"]
                    revision = saved.get("schema_revision", 1)
                    if revision < 2:
                        add_diagnostic_steps(graph)
                    if revision < 3:
                        add_fault_taxonomy(graph)
                    if revision < 3:
                        graph.version += 1
                        graph.freeze("Migrate ordered diagnostic steps and fault taxonomy")
                        migrated = True
                _sync_link_rules(graph, state)
                _GRAPH, _STATE = graph, state
                if migrated:
                    _save()
    return _GRAPH, _STATE


def _save():
    graph, _ = _load()
    data = {"schema_revision": 3, "snapshot": graph._snapshot(), "version": graph.version,
            "versions": graph.versions, "pending": graph.pending, "log": graph.log}
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STORE_PATH)


def stats():
    with _LOCK:
        graph, state = _load()
        return _ok({"graph": graph.stats(), "link_state": state.summary(),
                    "provenance": "CONSTRUCTED", "sr4_plan_validated": False})


def entity(eid):
    with _LOCK:
        graph, _ = _load()
        item = graph.ent(eid)
        if item is None:
            return _bad("实体不存在", 4001, {"similar": []})
        return _ok({"entity": item, "neighbors": graph.neighbors(eid)})


def search(q, etype=None, limit=20):
    if etype and etype not in ENTITY_TYPES:
        return _bad("未知实体类型")
    if not 1 <= limit <= 100:
        return _bad("limit 应在 1 到 100 之间")
    with _LOCK:
        graph, _ = _load()
        items = graph.search(q, etype, limit)
        return _ok({"total": len(items), "items": items}) if items else _bad(
            "没有匹配的知识", 4001, {"similar": graph.search(q[:2], etype, 5)})


def triples(graph_name=None, relation=None, source=None, entity_name=None, offset=0, limit=100):
    if graph_name not in (None, "device", "network", "fault", "update"):
        return _bad("graph 应为 device、network、fault 或 update")
    if relation is not None and relation not in RELATIONS:
        return _bad("relation 未登记")
    if not 0 <= offset or not 1 <= limit <= 500:
        return _bad("offset 应不小于 0，limit 应在 1 到 500 之间")
    with _LOCK:
        graph, _ = _load()
        return _ok(graph.query_triples(graph_name, relation, source, entity_name, offset, limit))


def quality():
    with _LOCK:
        graph, _ = _load()
        report = graph.quality_report()
        report["note"] = "结构质量通过不代表知识经过真实设备或现场案例验证"
        return _ok(report)


def query(payload):
    eid = payload.get("entity_id")
    depth = payload.get("depth", 2)
    relations = payload.get("relations")
    if not isinstance(eid, str) or not isinstance(depth, int) or not 0 <= depth <= 5:
        return _bad("entity_id 必填，depth 应在 0 到 5 之间")
    if relations is not None and (not isinstance(relations, list) or len(relations) > 5 or
                                  any(r is not None and r not in RELATIONS for r in relations)):
        return _bad("relations 必须是至多 5 项的已登记关系列表")
    with _LOCK:
        graph, _ = _load()
        if graph.ent(eid) is None:
            return _bad("实体不存在", 4001, {"similar": []})
        if relations is None:
            return _ok(graph.subgraph(eid, depth=depth, max_nodes=200))
        paths = graph.query_path(eid, relations, limit=200)
        return _ok({"paths": [[{"entity": graph.ent(node), "triple_id": tr["tid"] if tr else None,
                                 "source_doc": tr["source"] if tr else None}
                                for node, tr in path] for path in paths]})


def device_knowledge(model_id):
    with _LOCK:
        graph, _ = _load()
        eid = graph.get("DeviceModel", model_id)
        if eid is None:
            return _bad("设备型号不存在", 4001, {"similar": graph.search(model_id, "DeviceModel", 5)})
        return _ok({"model": graph.ent(eid), "neighbors": graph.neighbors(eid),
                    "subgraph": graph.subgraph(eid, depth=2, max_nodes=100)})


def infer(payload):
    symptom_ids = payload.get("symptom_ids") or []
    symptom_names = payload.get("symptom_names") or []
    if (not isinstance(symptom_ids, list) or not all(isinstance(s, str) for s in symptom_ids) or
            not isinstance(symptom_names, list) or
            not all(isinstance(s, str) and s.strip() for s in symptom_names) or
            not symptom_ids and not symptom_names):
        return _bad("symptom_ids 或 symptom_names 至少提供一项，且必须为非空字符串列表")
    from datapaths import path as data_path
    import csv
    with open(data_path("symptom_dict.csv"), encoding="utf-8-sig", newline="") as handle:
        names = {r["symptom_id"]: r["symptom_name"] for r in csv.DictReader(handle)}
    missing = sorted(set(symptom_ids) - names.keys())
    if missing:
        return _bad("未知故障现象编号", data={"unknown_symptom_ids": missing})
    query_names = {names[sid] for sid in symptom_ids}
    query_names.update(name.strip() for name in symptom_names)
    with _LOCK:
        graph, _ = _load()
        found = {}
        for symptom_name in query_names:
            eid = graph.get("Symptom", symptom_name)
            if eid is None:
                continue
            for tr in graph.incoming(eid, "hasSymptom"):
                fid = tr["head"]
                rec = found.setdefault(fid, {"matched_symptom_ids": [], "evidence": []})
                rec["matched_symptom_ids"].append(symptom_name)
                rec["evidence"].append({"triple_id": tr["tid"], "source_doc": tr["source"]})
        ranked = []
        for fid, rec in found.items():
            related = []
            for relation in ("causedBy", "locatedAt", "resolvedBy"):
                for tr in graph.outgoing(fid, relation):
                    related.append({"relation": relation, "entity": graph.ent(tr["tail"]),
                                    "triple_id": tr["tid"], "source_doc": tr["source"]})
            ranked.append({"fault": graph.ent(fid), **rec, "related": related,
                           "match_count": len(rec["matched_symptom_ids"])})
        ranked.sort(key=lambda r: (-r["match_count"], r["fault"]["name"]))
        if not ranked:
            return _bad("没有匹配的故障知识", 4001, {"similar": []})
        provenance = ("MIXED_UNVERIFIED" if any(
            "CONSTRUCTED" not in evidence["source_doc"] for row in ranked
            for evidence in row["evidence"]) else "CONSTRUCTED")
        return _ok({"candidates": ranked[:20], "provenance": provenance,
                    "confidence_note": "命中数仅用于排序，不是经真实案例校准的概率"})


def _next_manual_case_id(graph):
    used = {entity["name"] for entity in graph.of_type("Fault")}
    for change in graph.pending:
        for op in change.get("ops", []):
            if op.get("op") == "add_triple" and op.get("head_type") == "Fault":
                used.add(str(op.get("head", "")))
    number = 1
    while "FC-U%04d" % number in used:
        number += 1
    return "FC-U%04d" % number


def _text(payload, key, required=True, max_length=500):
    value = str(payload.get(key) or "").strip()
    if required and not value:
        raise ValueError(f"{key} 必填")
    if len(value) > max_length:
        raise ValueError(f"{key} 长度不得超过 {max_length}")
    return value


def submit_fault_case(payload):
    """把一条人工故障案例展开成完整三元组变更，审核后发布到运行图谱。"""
    payload = payload or {}
    try:
        fault_type = _text(payload, "fault_type", max_length=40)
        object_type = _text(payload, "object_type", max_length=40)
        device_class = _text(payload, "device_class", required=False, max_length=20)
        root_cause = _text(payload, "root_cause")
        component = _text(payload, "fault_component", required=False)
        solution = _text(payload, "solution")
        source_doc = _text(payload, "source_doc")
        submitter = _text(payload, "submitter", max_length=100)
        note = _text(payload, "note", required=False)
        symptoms = payload.get("symptoms")
        steps = payload.get("diagnosis_steps")
        if fault_type not in FAULT_TYPES:
            raise ValueError("fault_type 不在已登记故障类型中")
        if object_type not in ALLOWED_OBJECTS[fault_type]:
            raise ValueError(f"{fault_type} 不适用于对象类型 {object_type}")
        if device_class not in ("", "HF", "VUHF"):
            raise ValueError("device_class 应为 HF、VUHF 或留空")
        if (not isinstance(symptoms, list) or not 1 <= len(symptoms) <= 20 or
                not all(isinstance(item, str) and item.strip() for item in symptoms)):
            raise ValueError("symptoms 必须是 1 到 20 项非空现象名称")
        if (not isinstance(steps, list) or not 1 <= len(steps) <= 20 or
                not all(isinstance(item, str) and item.strip() for item in steps)):
            raise ValueError("diagnosis_steps 必须是 1 到 20 项非空步骤")
        symptoms = list(dict.fromkeys(item.strip() for item in symptoms))
        steps = list(dict.fromkeys(item.strip() for item in steps))
    except ValueError as exc:
        return _bad(str(exc))

    with _LOCK:
        graph, _ = _load()
        case_id = str(payload.get("case_id") or "").strip().upper() or _next_manual_case_id(graph)
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9_-]{2,39}", case_id):
            return _bad("case_id 仅允许 3 到 40 位大写字母、数字、下划线或连字符")
        duplicate_pending = any(change.get("status") == "PENDING" and any(
            op.get("op") == "add_triple" and op.get("head_type") == "Fault" and
            op.get("head") == case_id for op in change.get("ops", [])) for change in graph.pending)
        if graph.get("Fault", case_id) is not None or duplicate_pending:
            return _bad("case_id 已存在或正在等待审核")

        source = (source_doc if "MANUAL_UNVERIFIED" in source_doc
                  else source_doc + " [MANUAL_UNVERIFIED]")
        common = {"op": "add_triple", "head_type": "Fault", "head": case_id,
                  "source": source, "graph": "fault"}
        ops = [
            {**common, "relation": "instanceOf", "tail_type": "FaultType", "tail": fault_type},
            {**common, "relation": "occursOn", "tail_type": "ObjectType", "tail": object_type},
            {**common, "relation": "recordedIn", "tail_type": "Case", "tail": case_id},
            {**common, "relation": "causedBy", "tail_type": "Cause", "tail": root_cause},
            {**common, "relation": "resolvedBy", "tail_type": "Solution", "tail": solution},
        ]
        if component:
            ops.append({**common, "relation": "locatedAt", "tail_type": "Component",
                        "tail": component})
        if device_class:
            ops.append({**common, "relation": "constrainedBy", "tail_type": "Parameter",
                        "tail": "device_class=" + device_class})
        ops.extend({**common, "relation": "hasSymptom", "tail_type": "Symptom", "tail": value}
                   for value in symptoms)
        ops.extend({**common, "relation": "diagnosedBy", "tail_type": "DiagnosisStep",
                    "tail": "%02d:%s" % (index, value)}
                   for index, value in enumerate(steps, 1))
        change_id, errors = graph.submit_update(
            ops, submitter, note or f"人工故障案例 {case_id}")
        if errors:
            return _bad("故障案例变更校验未通过", data={"errors": errors})
        _save()
        return _ok({"case_id": case_id, "change_id": change_id, "status": "PENDING",
                    "triple_count": len(ops), "version": graph.version,
                    "next_step": f"POST /api/v1/kg/updates/{change_id}/review"})


def fault_cases(include_pending=True):
    """列出已发布案例及其来源，供知识维护界面回显。"""
    with _LOCK:
        graph, _ = _load()
        items = []
        for fault in sorted(graph.of_type("Fault"), key=lambda item: item["name"]):
            edges = list(graph.outgoing(fault["eid"]))
            grouped = {}
            for edge in edges:
                grouped.setdefault(edge["relation"], []).append(
                    (graph.ent(edge["tail"])["name"], edge["tid"], edge["source"]))
            first = lambda relation: grouped.get(relation, [(None, None, None)])[0][0]
            constraints = [row[0] for row in grouped.get("constrainedBy", [])]
            items.append({"case_id": fault["name"], "status": "PUBLISHED",
                          "fault_type": first("instanceOf"), "object_type": first("occursOn"),
                          "device_class": next((x.split("=", 1)[1] for x in constraints
                                                if x.startswith("device_class=")), None),
                          "symptoms": [row[0] for row in grouped.get("hasSymptom", [])],
                          "root_cause": first("causedBy"), "fault_component": first("locatedAt"),
                          "solution": first("resolvedBy"),
                          "diagnosis_steps": [row[0].split(":", 1)[-1]
                                              for row in sorted(grouped.get("diagnosedBy", []))],
                          "triple_ids": sorted(edge["tid"] for edge in edges),
                          "source_docs": sorted({edge["source"] for edge in edges})})
        pending_items = []
        if include_pending:
            for change in graph.pending:
                if change.get("status") != "PENDING":
                    continue
                fault_ops = [op for op in change.get("ops", [])
                             if op.get("op") == "add_triple" and op.get("head_type") == "Fault"]
                if fault_ops:
                    pending_items.append({"case_id": fault_ops[0].get("head"),
                                          "change_id": change["change_id"],
                                          "submitter": change.get("submitter"),
                                          "note": change.get("note"),
                                          "triple_count": len(fault_ops), "status": "PENDING"})
        return _ok({"total": len(items), "items": items,
                    "pending_total": len(pending_items), "pending_items": pending_items})


def evaluate_link_state(payload):
    rows = payload.get("metrics")
    if not isinstance(rows, list) or not rows or len(rows) > 200:
        return _bad("metrics 必须是 1 到 200 条观测")
    with _LOCK:
        _, state = _load()
        results = []
        for row in rows:
            if not isinstance(row, dict) or row.get("band") not in (None, "HF", "VUHF"):
                return _bad("观测项无效或 band 不支持")
            if row.get("band") is None and row.get("link_id") not in state.band_of:
                return _bad("未知链路须提供 band=HF 或 VUHF")
            for field in ("snr_db", "ber", "packet_loss_rate", "delay_ms", "throughput_kbps"):
                if row.get(field) in (None, ""):
                    continue
                try:
                    value = float(row[field])
                except (TypeError, ValueError, OverflowError):
                    return _bad(f"{field} 必须是有效数值")
                if not math.isfinite(value) or (field in ("ber", "delay_ms", "throughput_kbps") and value < 0) or (field == "packet_loss_rate" and not 0 <= value <= 1):
                    return _bad(f"{field} 超出有效范围")
            try:
                result = state.evaluate(row, band=row.get("band"))
            except (TypeError, ValueError, OverflowError):
                return _bad("链路指标必须是有效数值")
            if result is None:
                return _bad("至少提供一项可用链路指标")
            result["next_state_probability"] = state.predict_next(result["band"], result["link_state"])
            result["provenance"] = "CONSTRUCTED"
            results.append(result)
        return _ok({"results": results, "calibrated_on_real_data": False})


def submit(payload):
    ops = payload.get("ops")
    if not isinstance(ops, list) or not 1 <= len(ops) <= 100 or any(
            not isinstance(op, dict) for op in ops):
        return _bad("ops 必须是 1 到 100 项变更对象")
    with _LOCK:
        graph, _ = _load()
        cid, errors = graph.submit_update(ops, payload.get("submitter", ""), payload.get("note", ""))
        if errors:
            return _bad("变更校验未通过", data={"errors": errors})
        _save()
        return _ok({"change_id": cid, "status": "PENDING", "version": graph.version})


def pending():
    with _LOCK:
        graph, _ = _load()
        return _ok({"items": graph.pending})


def review(change_id, payload):
    if not isinstance(payload.get("approve"), bool) or not payload.get("reviewer"):
        return _bad("approve 和 reviewer 必填")
    with _LOCK:
        graph, _ = _load()
        try:
            result = graph.review(change_id, payload["approve"], payload["reviewer"])
        except (TypeError, ValueError, KeyError) as exc:
            return _bad(f"变更无法应用: {exc}")
        if result is None:
            return _bad("待审核变更不存在", 4001)
        if result["status"] == "APPROVED":
            _sync_link_rules(graph, _STATE)
        _save()
        return _ok(result)


def versions():
    with _LOCK:
        graph, _ = _load()
        return _ok({"items": graph.version_list()})


def audit(limit=50):
    if not 1 <= limit <= 200:
        return _bad("limit 应在 1 到 200 之间")
    with _LOCK:
        graph, _ = _load()
        return _ok({"items": graph.log[-limit:]})


def rollback(version, payload):
    if not payload.get("reviewer"):
        return _bad("reviewer 必填")
    with _LOCK:
        graph, _ = _load()
        result = graph.rollback(version)
        if result is None:
            return _bad("版本不存在", 4001)
        _sync_link_rules(graph, _STATE)
        graph._log("ROLLBACK_REVIEWER", "回滚操作人：%s" % payload["reviewer"])
        _save()
        return _ok(result)
