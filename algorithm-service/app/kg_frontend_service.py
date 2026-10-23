"""新版 SR6 页面适配；只有审核发布后的数据库快照可检索。"""
from __future__ import annotations

import copy
import json
import math
from datetime import datetime, timezone

from sqlalchemy import func, select

from . import kg, kg_workflow_service as workflow
from .database import get_session_factory
from .kg_frontend_schemas import KnowledgeMutation, KnowledgePage, KnowledgeEntityInput
from .kg_models import KgAudit, KgChange, KgSubmission, KgVersion
from .integration_identity_service import CATALOG, IdentityError

CATEGORIES = {"device": "设备知识", "network": "网络态势知识", "fault": "故障运维知识"}
DEVICE_TYPES = {"Device", "DeviceModel", "Component", "Interface", "Antenna", "Function", "Parameter", "Manufacturer", "WorkMode"}
NETWORK_TYPES = {"Node", "Link", "Metric", "LinkState", "NetworkRole", "NetRule"}


def _fail(message, code=1001, status=422):
    raise workflow.KgWorkflowError(message, code, status)


def _time(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat()


def _version(value):
    if not isinstance(value, str) or not value.startswith("KGV-") or not value[4:].isdigit():
        _fail("知识版本编号无效")
    return int(value[4:])


def identity_snapshot(identity):
    return {"id": identity["account_id"], "name": identity["display_name"],
            "roleId": identity["role_id"], "roleName": identity["role_name"],
            "role": "EDITOR" if "knowledge.edit" in identity["permissions"] else "REVIEWER"}


def _category(entity):
    return CATEGORIES.get(entity.get("graph")) or ("设备知识" if entity["type"] in DEVICE_TYPES else "网络态势知识" if entity["type"] in NETWORK_TYPES else "故障运维知识")


def _entity(entity):
    attrs = entity.get("attrs", {})
    ui = attrs.get("_frontend", {})
    row = {"id": entity["eid"], "name": entity["name"], "category": _category(entity),
           "type": entity["type"], "description": ui.get("description", ""),
           "keywords": ui.get("keywords", []), "source": ui.get("source") or attrs.get("source_doc", "来源未提供"),
           "attributes": ui.get("attributes", [{"name": key, "value": str(value), "unit": None} for key, value in attrs.items() if not key.startswith("_")]),
           "modelIds": ui.get("modelIds", [entity["name"]] if entity["type"] == "DeviceModel" else [])}
    for key in ("principleFlow", "networkRule"):
        if key in ui:
            row[key] = copy.deepcopy(ui[key])
    return row


def _relation(row):
    return {"id": row["tid"], "head": row["head"], "tail": row["tail"], "type": row["relation"],
            "weight": row.get("display_weight", row["weight"]), "source": row["source"]}


def snapshot(version_id):
    raw = workflow.version_snapshot(kg.STORE_PATH, _version(version_id))
    snap = raw["snapshot"]
    return {"entities": [_entity(e) for e in snap["entities"].values()],
            "relations": [_relation(r) for r in snap["triples"].values()]}


def _summary(row):
    meta = row.frontend_metadata or {}
    return {"id": f"KGV-{row.version}", "number": row.version,
            "parentId": f"KGV-{row.parent_version}" if row.parent_version else None,
            "restoredFromVersionId": f"KGV-{row.restored_from}" if row.restored_from else None,
            "kind": "ROLLBACK" if row.restored_from else "PUBLISH" if meta.get("changeId") else "BASELINE",
            "actorId": (meta.get("actor") or {}).get("id", "legacy"),
            "time": _time(row.created_at), "summary": row.note, "changeId": meta.get("changeId")}


def metadata():
    state = workflow.workspace(kg.STORE_PATH)
    vid = f"KGV-{state['current_version']}"
    snap = snapshot(vid)
    from diagnosis.kg_store import ENTITY_TYPES, RELATIONS
    with get_session_factory()() as session:
        current = session.get(KgVersion, state["current_version"])
        identities = []
        for change in session.scalars(select(KgChange)):
            value = (change.frontend_content or {}).get("identity")
            if value:
                identities.append({**value, "key": "change:" + change.change_id})
        for entry in session.scalars(select(KgAudit)):
            if entry.identity_snapshot:
                identities.append({**entry.identity_snapshot, "key": f"audit:{entry.id}"})
        summary = _summary(current)
    return {"workspace": {"revision": f"KG-{state['revision']}", "currentVersionId": vid, "current": summary,
                "counts": {c: sum(e["category"] == c for e in snap["entities"]) for c in CATEGORIES.values()}, "identitySnapshots": identities},
            "actors": [{"id": key, "name": row[0], "role": row[1]} for key, row in CATALOG.items() if row[1] != "PLANNER"],
            "types": [{"id": t, "name": t, "category": "设备知识" if t in DEVICE_TYPES else "网络态势知识" if t in NETWORK_TYPES else "故障运维知识"} for t in sorted(ENTITY_TYPES)],
            "relationTypes": [{"id": r, "name": r} for r in sorted(RELATIONS)],
            "models": [{"id": e["name"], "name": e["name"]} for e in snap["entities"] if e["type"] == "DeviceModel"],
            "error": None, "capabilities": {"reset": False}, "dataOrigin": "SAMPLE"}


def version_detail(version_id):
    with get_session_factory()() as session:
        row = session.get(KgVersion, _version(version_id))
        if row is None:
            _fail("知识版本不存在", 4001, 404)
        summary = _summary(row)
    return {**summary, **snapshot(version_id)}


def _content(row):
    content = row.frontend_content or {}
    if content.get("draft"):
        return copy.deepcopy(content["draft"])
    # 旧变更用同一增量操作投影，不伪装为另一个版本的全文。
    graph, _ = workflow.load_graph(kg.STORE_PATH)
    raw = workflow.version_snapshot(kg.STORE_PATH, row.base_version)["snapshot"]
    graph._restore(raw)
    graph.pending = [{"change_id": row.change_id, "status": "PENDING", "ops": copy.deepcopy(row.ops), "note": row.note}]
    graph.review(row.change_id, True, "preview-only")
    entities = [_entity(e) for e in graph.entities.values() if e["eid"] not in raw["entities"] or e != raw["entities"][e["eid"]]]
    relations = [_relation(r) for r in graph.triples.values() if r["tid"] not in raw["triples"] or r != raw["triples"][r["tid"]]]
    return {"summary": row.note, "baseVersionId": f"KGV-{row.base_version}",
            "entities": entities, "relations": relations}


def change_detail(change_id):
    with get_session_factory()() as session:
        row = session.get(KgChange, change_id)
        if row is None:
            _fail("知识变更不存在", 4001, 404)
        content = _content(row)
        submissions = []
        for s in session.scalars(select(KgSubmission).where(KgSubmission.change_id == change_id).order_by(KgSubmission.number)):
            review = (s.frontend_content or {}).get("review")
            submissions.append({"number": s.number, "revision": s.revision, "actorId": row.submitter,
                "time": _time(s.submitted_at), "content": copy.deepcopy((s.frontend_content or {}).get("draft", content)),
                "outcome": s.outcome, "review": {"actorId": s.reviewer, "time": _time(review["time"] if review else s.submitted_at), "opinion": s.opinion or ""} if s.reviewer else None})
        versions = session.scalars(select(KgVersion).where(KgVersion.version > row.base_version)).all()
        published = next((v for v in versions if (v.frontend_metadata or {}).get("changeId") == change_id), None)
        return {"id": row.change_id, "authorId": row.submitter, "state": row.state, "revision": row.revision,
                "content": content, "createdAt": _time(row.created_at), "updatedAt": _time(row.updated_at),
                "submissions": submissions, "publishedVersionId": f"KGV-{published.version}" if published else None}


def history(kind, page: KnowledgePage):
    model = {"changes": KgChange, "versions": KgVersion, "logs": KgAudit}[kind]
    with get_session_factory()() as session:
        stmt = select(model)
        if kind == "changes" and page.state:
            stmt = stmt.where(KgChange.state == page.state)
        total = session.scalar(select(func.count()).select_from(stmt.subquery()))
        order = KgChange.created_at.desc() if kind == "changes" else KgVersion.version.desc() if kind == "versions" else KgAudit.id.desc()
        rows = session.scalars(stmt.order_by(order).offset((page.pageNum - 1) * page.pageSize).limit(page.pageSize)).all()
        if kind == "versions":
            items = [_summary(row) for row in rows]
        elif kind == "logs":
            items = [{"id": f"KGA-{r.id}", "actorId": r.actor, "action": r.action, "time": _time(r.created_at),
                "objectId": r.change_id or f"KGV-{r.version}", "before": "", "after": r.detail,
                "versionId": f"KGV-{r.version}", "opinion": r.detail} for r in rows]
        else:
            items = []
            for row in rows:
                full = change_detail(row.change_id)
                content = full.pop("content")
                full.pop("submissions")
                items.append({**full, "summary": content["summary"], "baseVersionId": content["baseVersionId"]})
    return {"items": items, "total": total, "pageNum": page.pageNum, "pageSize": page.pageSize}


def browse(kind, query):
    vid = query.get("versionId")
    snap = snapshot(vid)
    raw_cats = query.get("categories", ",".join(CATEGORIES.values()))
    cats = raw_cats.split(",") if raw_cats else []
    if any(c not in CATEGORIES.values() for c in cats):
        _fail("图谱分类无效")
    term = query.get("search", "").strip().casefold()
    if len(term) > 120 or any(ord(c) < 32 for c in term):
        _fail("检索词无效")
    selected = [e for e in snap["entities"] if e["category"] in cats and (not query.get("type") or e["type"] == query["type"])]
    matches = [e for e in selected if term in json.dumps(e, ensure_ascii=False).casefold()]
    summary = lambda e: {k: e[k] for k in ("id", "name", "category", "type")}
    if kind == "search":
        page = KnowledgePage.model_validate({k: query[k] for k in ("pageNum", "pageSize") if k in query})
        return {"versionId": vid, "items": [summary(e) for e in matches[(page.pageNum - 1)*page.pageSize:page.pageNum*page.pageSize]],
                "total": len(matches), "pageNum": page.pageNum, "pageSize": page.pageSize,
                "similar": [], "code": 0 if matches else 4001}
    by_id = {e["id"]: e for e in snap["entities"]}
    if kind == "entity":
        eid = query.get("entityId")
        if eid not in by_id:
            _fail("实体不在所选版本中", 4001, 404)
        edges = [r for r in snap["relations"] if eid in (r["head"], r["tail"])]
        neighbors = {r["tail"] if r["head"] == eid else r["head"] for r in edges} - {eid}
        return {"versionId": vid, "entity": by_id[eid], "neighbors": [by_id[i] for i in sorted(neighbors)], "relations": edges}
    if kind == "device":
        model = query.get("modelId")
        models = [e for e in snap["entities"] if e["type"] == "DeviceModel" and e["name"] == model]
        if not models:
            _fail("设备型号不在所选知识版本中", 4001, 404)
        ids = {e["id"] for e in models}
        ids.update(r["tail"] for r in snap["relations"] if r["head"] in ids)
        return {"versionId": vid, "modelId": model, "items": [browse("entity", {"versionId": vid, "entityId": e["id"]}) for e in matches if e["id"] in ids or model in e["modelIds"]]}
    rows = selected if not term or matches else []
    if query.get("focusId"):
        root = query["focusId"]
        expanded = json.loads(query.get("expandedIds", "[]"))
        if root not in by_id or by_id[root]["category"] not in cats or not isinstance(expanded, list) or len(expanded) > 100 or any(e not in by_id for e in expanded):
            _fail("聚焦或展开实体无效")
        ids = {root}
        for eid in expanded:
            if eid in ids:
                for r in snap["relations"]:
                    if eid in (r["head"], r["tail"]):
                        ids.update(i for i in (r["head"], r["tail"]) if by_id[i]["category"] in cats)
        rows = [by_id[i] for i in sorted(ids)]
    all_ids = {e["id"] for e in rows}
    edges = [r for r in snap["relations"] if r["head"] in all_ids and r["tail"] in all_ids]
    matched = {e["id"] for e in matches} if term else set()
    rows.sort(key=lambda e: (e["id"] not in matched, e["id"]))
    visible = rows[:100]
    ids = {e["id"] for e in visible}
    return {"versionId": vid, "entities": [summary(e) for e in visible],
            "relations": [r for r in edges if r["head"] in ids and r["tail"] in ids][:200],
            "totalNodes": len(rows), "totalEdges": len(edges), "matchedIds": sorted(matched & ids)}


def _draft_ops(draft):
    if not isinstance(draft, dict) or set(draft) != {"baseVersionId", "summary", "entities", "relations"}:
        _fail("知识草稿结构无效")
    if not isinstance(draft["summary"], str) or not 1 <= len(draft["summary"].strip()) <= 500:
        _fail("变更说明需为 1 至 500 字")
    base = snapshot(draft["baseVersionId"])
    raw = workflow.version_snapshot(kg.STORE_PATH, _version(draft["baseVersionId"]))["snapshot"]
    entities = {e["id"]: e for e in base["entities"]}
    relations = {r["id"]: r for r in base["relations"]}
    if not isinstance(draft["entities"], list) or not isinstance(draft["relations"], list) or len(draft["entities"]) + len(draft["relations"]) > 100:
        _fail("一次最多修改 100 个实体或关系")
    ops, seen = [], set()
    for e in draft["entities"]:
        e = KnowledgeEntityInput.model_validate(e).model_dump(mode="json", by_alias=True, exclude_unset=True)
        if e.get("principleFlow") is not None and e["category"] != "设备知识":
            _fail("仅设备知识可以设置工作原理")
        if e.get("networkRule") is not None and (e["category"] != "网络态势知识" or e["type"] != "NetRule" or len({c["state"] for c in e["networkRule"]["criteria"]}) != 4):
            _fail("状态规则说明必须属于组网规则并含四个不同状态")
        if not isinstance(e, dict) or not all(isinstance(e.get(k), str) and e[k].strip() for k in ("id", "name", "type", "source")) or e["id"] in seen:
            _fail("实体字段缺失或身份重复")
        seen.add(e["id"])
        if e.get("category") not in CATEGORIES.values() or not isinstance(e.get("attributes"), list) or not isinstance(e.get("keywords"), list) or not isinstance(e.get("modelIds"), list):
            _fail("实体分类、属性或关键词无效")
        old = entities.get(e["id"])
        if old == e:
            continue
        entities[e["id"]] = e
        ui = {k: copy.deepcopy(e[k]) for k in ("description", "keywords", "source", "attributes", "modelIds", "principleFlow", "networkRule") if k in e}
        op = {"op": "edit_entity" if old else "upsert_entity", "entity_type": e["type"], "name": e["name"],
              "source": e["source"], "graph": next(k for k,v in CATEGORIES.items() if v == e["category"]), "attrs": {"_frontend": ui}}
        if old:
            op["entity_id"] = e["id"]
        ops.append(op)
    seen = set()
    for r in draft["relations"]:
        if not isinstance(r, dict) or not all(isinstance(r.get(k), str) and r[k].strip() for k in ("id", "head", "tail", "type", "source")) or r["id"] in seen:
            _fail("关系字段缺失或身份重复")
        seen.add(r["id"])
        weight = r.get("weight")
        if r["head"] not in entities or r["tail"] not in entities or r["head"] == r["tail"] or weight is not None and (isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or not 0 <= weight <= 1):
            _fail("关系端点或权重无效")
        if relations.get(r["id"]) == r:
            continue
        a, b = entities[r["head"]], entities[r["tail"]]
        op = {"op": "replace_triple" if r["id"] in relations else "add_triple", "head_type": a["type"], "head": a["name"],
              "tail_type": b["type"], "tail": b["name"], "relation": r["type"], "source": r["source"],
              "weight": 1.0 if weight is None else weight, "display_weight": weight}
        if r["id"] in relations:
            op["triple_id"] = r["id"]
        ops.append(op)
    if not ops:
        _fail("没有可保存的知识变更")
    return ops


def mutate(action, request: KnowledgeMutation, identity):
    if request.actorId != identity["account_id"]:
        raise IdentityError("操作者与当前联调会话不一致")
    actor = identity_snapshot(identity)
    payload = {"request_id": request.requestId, "actor": request.actorId,
               "base_revision": int(request.baseRevision[3:]), "_identity": actor,
               "revision": request.revision, "opinion": request.opinion,
               "submission": request.submission, "approved": request.approved}
    if action == "save":
        if request.draft is None:
            _fail("缺少知识草稿")
        ops = _draft_ops(request.draft)
        payload.update(ops=ops, note=request.draft["summary"], base_version=_version(request.draft["baseVersionId"]),
                       _frontend_content={"draft": copy.deepcopy(request.draft), "identity": actor})
        result = workflow.save_draft(kg.STORE_PATH, payload, request.changeId)
    elif action == "rollback":
        if not request.reason.strip():
            _fail("回滚必须填写原因")
        payload.update(reason=request.reason, current_version=workflow.workspace(kg.STORE_PATH)["current_version"])
        result = workflow.rollback(kg.STORE_PATH, _version(request.versionId), payload)
    else:
        if not request.changeId or request.revision is None:
            _fail("缺少变更编号或修订")
        result = workflow.transition(kg.STORE_PATH, request.changeId, payload, action.upper())
    current = f"KGV-{result['version']}"
    eid = result.get("change_id") or current
    return {"objectId": eid, "entityId": eid, "changed": True,
            "revision": f"KG-{result['workspace_revision']}", "currentVersionId": current,
            **({"change": change_detail(eid)} if result.get("change_id") else {})}
