"""已发布现象目录与诊断冻结映射；不修改引擎单例或源词典。"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy

from sqlalchemy import select

from . import kg, kg_workflow_service
from .kg_models import KgVersion


def catalog_from_snapshots(snapshot, baseline, original, knowledge_version):
    """SY别名固定指向初始实体；新增现象使用实体编号，不由名称生成ID。"""
    entities = snapshot["entities"]
    initial = {(row["type"], row["name"]): eid for eid, row in baseline["entities"].items()}
    symptoms, entity_ids, legacy_entities = {}, {}, set()
    for sid, label in original.items():
        eid = initial.get(("Symptom", label))
        row = entities.get(eid)
        symptoms[sid] = row["name"] if row and row["type"] == "Symptom" else label
        if eid:
            entity_ids[sid] = eid
            legacy_entities.add(eid)
    for eid, row in sorted(entities.items()):
        if row["type"] == "Symptom" and eid not in legacy_entities:
            sid = f"KGV-{knowledge_version}:{eid}"
            symptoms[sid] = row["name"]
            entity_ids[sid] = eid
    return symptoms, entity_ids


def _checksum(value):
    content = {key: value[key] for key in ("schema_version", "knowledge_version", "baseline_version", "symptoms", "entity_ids")}
    return hashlib.sha256(json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def capture(session, original):
    state = kg_workflow_service._bootstrap(session, kg.STORE_PATH)
    row = session.get(KgVersion, state.current_version)
    baseline = session.scalar(select(KgVersion).order_by(KgVersion.version).limit(1))
    if row is None or baseline is None:
        raise ValueError("已发布知识快照不可用")
    symptoms, entity_ids = catalog_from_snapshots(row.snapshot, baseline.snapshot, original, row.version)
    value = {"schema_version": 1, "knowledge_version": row.version, "baseline_version": baseline.version,
             "symptoms": symptoms, "entity_ids": entity_ids}
    value["catalog_sha256"] = _checksum(value)
    return value


def checked(value):
    if (not isinstance(value, dict) or value.get("schema_version") != 1
            or type(value.get("knowledge_version")) is not int or value["knowledge_version"] < 1
            or type(value.get("baseline_version")) is not int or value["baseline_version"] < 1
            or not isinstance(value.get("symptoms"), dict) or not isinstance(value.get("entity_ids"), dict)
            or not all(isinstance(key, str) and key and isinstance(label, str) and label.strip()
                       for key, label in value["symptoms"].items())
            or not all(sid in value["symptoms"] and isinstance(eid, str) and eid
                       for sid, eid in value["entity_ids"].items())
            or value.get("catalog_sha256") != _checksum(value)):
        raise ValueError("冻结现象目录结构或校验值无效")
    return value


def graph_for_catalog(session, value):
    from diagnosis.kg_store import KnowledgeGraph

    value = checked(value)
    row = session.get(KgVersion, value["knowledge_version"])
    if row is None:
        raise ValueError("本次诊断绑定的已发布知识版本不存在")
    for sid, eid in value["entity_ids"].items():
        entity = row.snapshot["entities"].get(eid)
        if (entity and (entity["type"] != "Symptom" or entity["name"] != value["symptoms"][sid])
                or sid.startswith("KGV-") and (sid != f"KGV-{row.version}:{eid}" or entity is None)):
            raise ValueError("冻结现象目录与知识版本不一致")
    graph = KnowledgeGraph("sr5_published_frozen")
    graph._restore(deepcopy(row.snapshot))
    graph.version = row.version
    return graph


def feedback_labels(catalog, original, current_graph):
    """反馈沿实体身份关联；已移除的现象报冲突，不按同名实体重新绑定。"""
    if catalog is None:
        # 历史结果没有目录快照；仅保留原SY编号的旧词典兼容路径。
        return dict(original)
    value = checked(catalog)
    labels = {}
    for sid, label in value["symptoms"].items():
        if sid.startswith("KGV-") and current_graph.version != value["knowledge_version"]:
            # 回滚后E编号可复用；跨发布版不把旧新增现象悄悄接到同号新实体。
            continue
        eid = value["entity_ids"].get(sid)
        if eid is None:
            labels[sid] = label
            continue
        entity = current_graph.ent(eid)
        if entity and entity["type"] == "Symptom":
            labels[sid] = entity["name"]
    return labels
