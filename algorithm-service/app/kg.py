"""SR-6 knowledge service over explicitly constructed sample data."""
from __future__ import annotations

import json
import math
import os
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

from diagnosis.kg_store import ENTITY_TYPES, RELATIONS  # noqa: E402
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
    symptom_ids = payload.get("symptom_ids")
    if not isinstance(symptom_ids, list) or not symptom_ids or not all(
            isinstance(s, str) for s in symptom_ids):
        return _bad("symptom_ids 必须是非空字符串列表")
    from datapaths import path as data_path
    import csv
    with open(data_path("symptom_dict.csv"), encoding="utf-8-sig", newline="") as handle:
        names = {r["symptom_id"]: r["symptom_name"] for r in csv.DictReader(handle)}
    missing = sorted(set(symptom_ids) - names.keys())
    if missing:
        return _bad("未知故障现象编号", data={"unknown_symptom_ids": missing})
    with _LOCK:
        graph, _ = _load()
        found = {}
        for sid in set(symptom_ids):
            eid = graph.get("Symptom", names[sid])
            if eid is None:
                continue
            for tr in graph.incoming(eid, "hasSymptom"):
                fid = tr["head"]
                rec = found.setdefault(fid, {"matched_symptom_ids": [], "evidence": []})
                rec["matched_symptom_ids"].append(sid)
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
        return _ok({"candidates": ranked[:20], "provenance": "CONSTRUCTED",
                    "confidence_note": "命中数仅用于排序，不是经真实案例校准的概率"})


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
