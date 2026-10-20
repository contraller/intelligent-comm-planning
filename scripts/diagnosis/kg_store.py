"""知识图谱存储（SR-6 公共底座）。

设备、网络态势、故障三类图谱共用一套本体与存储（数据字典 3.5）：
实体按「类型 + 名称」唯一，三元组 = (头实体, 关系, 尾实体, 权重, 来源)。

《技术参考》(1) 建议 Neo4j + Cypher；本项目受国产化部署约束只用标准库，
这里用内存索引实现同等能力的子集：
- 实体检索（精确 / 模糊，SR-6.1 扩展流 1）
- 一跳邻居、多跳路径遍历（Cypher 多跳查询的对应物）
- 结构化子图查询：起点 + 关系序列（`query_path`）
- 增量更新：提交 → 审核 → 发布为新版本，可回滚（SR-6 扩展流 2）
- 操作日志（SR-6 主事件流 5）

规模：第一版口径 500–2000 条三元组（数据字典 3.5），全内存。
《技术参考》「3–5 跳 <200 ms」的参考指标仍须在目标部署环境实测。
"""
import copy
import csv
import json
import math
import os
import time

# 统一本体（数据字典 3.5，两处须同步）。比原表多出的 WorkMode / Case / ObjectType 与
# instanceOf 等六个关系已于 2026-09-29 补登，含义为拟定，待第 5 周图谱构建时确认。
ENTITY_TYPES = {
    # 设备域
    "Device", "DeviceModel", "Component", "Interface", "Antenna", "Function",
    "Parameter", "Manufacturer", "WorkMode",
    # 态势域
    "Node", "Link", "Metric", "LinkState", "NetworkRole", "NetRule",
    # 故障域
    "Fault", "FaultType", "Symptom", "Cause", "DiagnosisStep", "Solution",
    "Tool", "Spare", "Case", "ObjectType",
}
RELATIONS = {
    # 设备域
    "hasComponent", "hasInterface", "hasAntenna", "hasFunction", "hasParameter",
    "producedBy", "supportsMode", "constrainedBy", "instanceOf", "installedAt",
    # 态势域
    "connects", "measuredBy", "indicates", "evaluatedAs", "followsRule", "hasRole",
    "transitionsTo",
    # 故障域
    "hasSymptom", "causedBy", "locatedAt", "diagnosedBy", "resolvedBy",
    "affects", "propagatesTo", "requiresTool", "requiresSpare", "occursOn",
    "recordedIn",
}

# 关系两端的本体约束。集合中保留需求资料允许的扩展类型；增量审核先检查这些
# 约束，防止把诸如“设备 hasSymptom 参数”一类语义错误发布进正式版本。
RELATION_SIGNATURES = {
    "hasComponent": ({"Device", "DeviceModel"}, {"Component"}),
    "hasInterface": ({"Device", "DeviceModel"}, {"Interface"}),
    "hasAntenna": ({"Device", "DeviceModel"}, {"Antenna"}),
    "hasFunction": ({"Device", "DeviceModel"}, {"Function"}),
    "hasParameter": ({"Device", "DeviceModel", "Link"}, {"Parameter"}),
    "producedBy": ({"DeviceModel"}, {"Manufacturer"}),
    "supportsMode": ({"Device", "DeviceModel"}, {"WorkMode"}),
    "constrainedBy": ({"Device", "DeviceModel", "Function", "Link", "Fault"}, {"Parameter"}),
    "instanceOf": ({"Device", "Fault"}, {"DeviceModel", "FaultType"}),
    "installedAt": ({"Device"}, {"Node"}),
    "connects": ({"Link"}, {"Node"}),
    "measuredBy": ({"Link"}, {"Metric"}),
    "indicates": ({"Metric", "NetRule"}, {"LinkState"}),
    "evaluatedAs": ({"Link"}, {"LinkState"}),
    "followsRule": ({"Link", "Metric"}, {"NetRule"}),
    "hasRole": ({"Node"}, {"NetworkRole"}),
    "transitionsTo": ({"LinkState"}, {"LinkState"}),
    "hasSymptom": ({"Fault", "FaultType"}, {"Symptom"}),
    "causedBy": ({"Fault", "Symptom"}, {"Cause"}),
    "locatedAt": ({"Fault", "Cause"}, {"Component", "Device", "Node", "Link"}),
    "diagnosedBy": ({"Fault", "Symptom"}, {"DiagnosisStep"}),
    "resolvedBy": ({"Fault", "Cause"}, {"Solution"}),
    "affects": ({"Fault"}, {"Device", "Node", "Link", "Function"}),
    "propagatesTo": ({"Fault", "Node", "Link"}, {"Fault", "Node", "Link"}),
    "requiresTool": ({"Fault", "Solution", "DiagnosisStep"}, {"Tool"}),
    "requiresSpare": ({"Fault", "Solution"}, {"Spare"}),
    "occursOn": ({"Fault"}, {"ObjectType"}),
    "recordedIn": ({"Fault"}, {"Case"}),
}


def entity_key(etype, name):
    return "%s::%s" % (etype, name)


class KnowledgeGraph:
    """带版本的内存知识图谱。"""

    def __init__(self, name="kg"):
        self.name = name
        self.entities = {}        # eid -> dict(eid, type, name, graph, attrs)
        self.by_key = {}          # "type::name" -> eid
        self.triples = {}         # tid -> dict(tid, head, relation, tail, weight, source, graph)
        self.out = {}             # eid -> [tid]
        self.inn = {}             # eid -> [tid]
        self.seq_e = 0
        self.seq_t = 0
        self.version = 1
        self.versions = []        # [(version, time, note, snapshot)]
        self.pending = []         # 待审核的增量更新
        self.log = []             # 操作日志

    # ─────────────────────────── 写入 ───────────────────────────
    def add_entity(self, etype, name, graph="", attrs=None):
        if etype not in ENTITY_TYPES:
            raise ValueError("未登记的实体类型 %s" % etype)
        name = str(name).strip()
        k = entity_key(etype, name)
        eid = self.by_key.get(k)
        if eid is None:
            self.seq_e += 1
            eid = "E-%05d" % self.seq_e
            self.entities[eid] = dict(eid=eid, type=etype, name=name, graph=graph,
                                      attrs=dict(attrs or {}))
            self.by_key[k] = eid
            self.out[eid] = []
            self.inn[eid] = []
        elif attrs:
            self.entities[eid]["attrs"].update(attrs)
        return eid

    def add_triple(self, head, relation, tail, weight=1.0, source="", graph="",
                   head_type=None, tail_type=None, merge="max"):
        """head/tail 可以是 eid，也可以是 (类型, 名称)。同一 (头, 关系, 尾) 只存一条，
        重复写入按 merge 合并权重（max / sum / replace），来源累加。"""
        if relation not in RELATIONS:
            raise ValueError("未登记的关系 %s" % relation)
        h = head if head in self.entities else self.add_entity(head_type or head[0],
                                                                head[1] if head_type is None else head,
                                                                graph)
        t = tail if tail in self.entities else self.add_entity(tail_type or tail[0],
                                                                tail[1] if tail_type is None else tail,
                                                                graph)
        for tid in self.out[h]:
            tr = self.triples[tid]
            if tr["relation"] == relation and tr["tail"] == t:
                if merge == "sum":
                    tr["weight"] = round(tr["weight"] + weight, 6)
                elif merge == "replace":
                    tr["weight"] = weight
                else:
                    tr["weight"] = max(tr["weight"], weight)
                if source and source not in tr["source"].split(";"):
                    tr["source"] = (tr["source"] + ";" + source).strip(";")
                return tid
        self.seq_t += 1
        tid = "KG-%05d" % self.seq_t
        self.triples[tid] = dict(tid=tid, head=h, relation=relation, tail=t,
                                 weight=round(float(weight), 6), source=source, graph=graph)
        self.out[h].append(tid)
        self.inn[t].append(tid)
        return tid

    def remove_triple(self, tid):
        tr = self.triples.pop(tid, None)
        if tr is None:
            return False
        self.out[tr["head"]].remove(tid)
        self.inn[tr["tail"]].remove(tid)
        return True

    # ─────────────────────────── 读取 ───────────────────────────
    def get(self, etype, name):
        return self.by_key.get(entity_key(etype, name))

    def ent(self, eid):
        return self.entities.get(eid)

    def outgoing(self, eid, relation=None):
        for tid in self.out.get(eid, ()):
            tr = self.triples[tid]
            if relation is None or tr["relation"] == relation:
                yield tr

    def incoming(self, eid, relation=None):
        for tid in self.inn.get(eid, ()):
            tr = self.triples[tid]
            if relation is None or tr["relation"] == relation:
                yield tr

    def of_type(self, etype, graph=None):
        return [e for e in self.entities.values()
                if e["type"] == etype and (graph is None or e["graph"] == graph)]

    def neighbors(self, eid):
        """一跳邻居（SR-6.1 c 关联浏览）。"""
        out = []
        for tr in self.outgoing(eid):
            out.append(dict(direction="out", relation=tr["relation"], triple_id=tr["tid"],
                            weight=tr["weight"], entity=self._brief(tr["tail"])))
        for tr in self.incoming(eid):
            out.append(dict(direction="in", relation=tr["relation"], triple_id=tr["tid"],
                            weight=tr["weight"], entity=self._brief(tr["head"])))
        return out

    def _brief(self, eid):
        e = self.entities[eid]
        return dict(eid=eid, type=e["type"], name=e["name"], graph=e["graph"])

    def search(self, q, etype=None, limit=20):
        """模糊检索：子串命中优先，其次按字符二元组相似度（SR-6.1 扩展流 1）。"""
        q = (q or "").strip().lower()
        if not q:
            return []
        qg = _bigrams(q)
        scored = []
        for e in self.entities.values():
            if etype and e["type"] != etype:
                continue
            nm = e["name"].lower()
            if q == nm:
                s = 2.0
            elif q in nm:
                s = 1.0 + len(q) / max(1, len(nm))
            else:
                g = _bigrams(nm)
                inter = len(qg & g)
                s = inter / max(1, len(qg | g)) if inter else 0.0
            if s > 0.15:
                scored.append((s, e["eid"]))
        scored.sort(key=lambda x: (-x[0], x[1]))
        return [dict(self._brief(eid), score=round(s, 3)) for s, eid in scored[:limit]]

    def query_path(self, start, relations, direction="out", limit=200):
        """结构化路径查询：从 start 出发沿给定关系序列走，返回全部路径。

        相当于 Cypher 的 `(a)-[:r1]->()-[:r2]->(b)`；relations 里的某一项为 None
        表示该跳任意关系。
        """
        paths = [[(start, None)]]
        for rel in relations:
            nxt = []
            for p in paths:
                cur = p[-1][0]
                it = self.outgoing(cur, rel) if direction == "out" else self.incoming(cur, rel)
                for tr in it:
                    other = tr["tail"] if direction == "out" else tr["head"]
                    if any(other == x[0] for x in p):
                        continue
                    nxt.append(p + [(other, tr)])
                    if len(nxt) >= limit:
                        break
            paths = nxt
            if not paths:
                break
        return paths

    def subgraph(self, eid, depth=2, max_nodes=200):
        """以 eid 为中心的 k 跳子图（前端力导向图展示的数据源）。"""
        seen = {eid: 0}
        frontier = [eid]
        edges = {}
        for d in range(depth):
            nxt = []
            for x in frontier:
                for tid in self.out.get(x, []) + self.inn.get(x, []):
                    tr = self.triples[tid]
                    edges[tid] = tr
                    for y in (tr["head"], tr["tail"]):
                        if y not in seen and len(seen) < max_nodes:
                            seen[y] = d + 1
                            nxt.append(y)
            frontier = nxt
        nodes = [dict(self._brief(x), hop=h) for x, h in seen.items()]
        links = [dict(triple_id=t, source=tr["head"], target=tr["tail"],
                      relation=tr["relation"], weight=tr["weight"])
                 for t, tr in edges.items() if tr["head"] in seen and tr["tail"] in seen]
        return dict(nodes=nodes, links=links)

    def stats(self):
        by_graph, by_rel, by_type = {}, {}, {}
        for tr in self.triples.values():
            by_graph[tr["graph"]] = by_graph.get(tr["graph"], 0) + 1
            by_rel[tr["relation"]] = by_rel.get(tr["relation"], 0) + 1
        for e in self.entities.values():
            by_type[e["type"]] = by_type.get(e["type"], 0) + 1
        return dict(version=self.version, entities=len(self.entities),
                    triples=len(self.triples), by_graph=by_graph,
                    by_relation=by_rel, by_entity_type=by_type,
                    pending=len(self.pending))

    def query_triples(self, graph=None, relation=None, source=None, entity=None,
                      offset=0, limit=100):
        """按图域、关系、来源或实体检索可溯源三元组。"""
        source_q = (source or "").strip().lower()
        entity_q = (entity or "").strip().lower()
        rows = []
        for tid in sorted(self.triples):
            tr = self.triples[tid]
            head, tail = self.entities[tr["head"]], self.entities[tr["tail"]]
            if graph and tr["graph"] != graph:
                continue
            if relation and tr["relation"] != relation:
                continue
            if source_q and source_q not in tr["source"].lower():
                continue
            if entity_q and entity_q not in head["name"].lower() and entity_q not in tail["name"].lower():
                continue
            rows.append({"triple_id": tid, "graph": tr["graph"],
                         "head": head["name"], "head_type": head["type"],
                         "relation": tr["relation"], "tail": tail["name"],
                         "tail_type": tail["type"], "weight": tr["weight"],
                         "source_doc": tr["source"]})
        return {"total": len(rows), "offset": offset, "limit": limit,
                "items": rows[offset:offset + limit]}

    def quality_report(self, max_examples=20):
        """检查结构完整性、来源、关系签名和故障案例必需知识。"""
        errors, warnings = [], []

        def issue(bucket, code, message, item_id):
            bucket.append({"code": code, "message": message, "item_id": item_id})

        semantic = set()
        for tid, tr in self.triples.items():
            head, tail = self.entities.get(tr["head"]), self.entities.get(tr["tail"])
            if head is None or tail is None:
                issue(errors, "DANGLING_ENDPOINT", "三元组端点实体不存在", tid)
                continue
            key = (tr["head"], tr["relation"], tr["tail"])
            if key in semantic:
                issue(errors, "DUPLICATE_TRIPLE", "存在重复语义三元组", tid)
            semantic.add(key)
            if tr["relation"] not in RELATIONS:
                issue(errors, "UNKNOWN_RELATION", "关系未登记", tid)
            signature = RELATION_SIGNATURES.get(tr["relation"])
            if signature and (head["type"] not in signature[0] or tail["type"] not in signature[1]):
                issue(errors, "RELATION_SIGNATURE", "%s -> %s 不符合关系 %s 的类型约束" %
                      (head["type"], tail["type"], tr["relation"]), tid)
            if not str(tr.get("source", "")).strip():
                issue(errors, "MISSING_SOURCE", "三元组缺少来源", tid)
            weight = tr.get("weight")
            if not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight < 0:
                issue(errors, "INVALID_WEIGHT", "三元组权重无效", tid)

        orphan_ids = [eid for eid in self.entities if not self.out.get(eid) and not self.inn.get(eid)]
        for eid in orphan_ids[:max_examples]:
            issue(warnings, "ORPHAN_ENTITY", "实体没有任何关联", eid)

        required = {"hasSymptom", "causedBy", "diagnosedBy", "resolvedBy",
                    "instanceOf", "occursOn", "recordedIn"}
        incomplete = []
        for fault in self.of_type("Fault"):
            relations = {tr["relation"] for tr in self.outgoing(fault["eid"])}
            missing = sorted(required - relations)
            if missing:
                incomplete.append({"entity_id": fault["eid"], "name": fault["name"],
                                   "missing_relations": missing})
        if incomplete:
            warnings.append({"code": "INCOMPLETE_FAULT_CASE",
                             "message": "%d 个故障案例缺少必需关系" % len(incomplete),
                             "examples": incomplete[:max_examples]})

        constructed = sum("CONSTRUCTED" in tr.get("source", "") for tr in self.triples.values())
        checks = {"dangling_endpoints": sum(x["code"] == "DANGLING_ENDPOINT" for x in errors),
                  "duplicate_triples": sum(x["code"] == "DUPLICATE_TRIPLE" for x in errors),
                  "missing_sources": sum(x["code"] == "MISSING_SOURCE" for x in errors),
                  "relation_signature_errors": sum(x["code"] == "RELATION_SIGNATURE" for x in errors),
                  "orphan_entities": len(orphan_ids),
                  "incomplete_fault_cases": len(incomplete)}
        return {"status": "FAIL" if errors else "WARNING" if warnings else "PASS",
                "version": self.version, "checks": checks,
                "provenance": {"constructed_triples": constructed,
                               "other_source_triples": len(self.triples) - constructed,
                               "field_validated": False},
                "errors": errors[:max_examples], "warnings": warnings[:max_examples]}

    # ─────────────────────── 增量更新、审核、版本 ───────────────────────
    def _snapshot(self):
        return dict(entities=copy.deepcopy(self.entities), triples=copy.deepcopy(self.triples),
                    seq_e=self.seq_e, seq_t=self.seq_t)

    def _restore(self, snap):
        self.entities = copy.deepcopy(snap["entities"])
        self.triples = copy.deepcopy(snap["triples"])
        self.seq_e, self.seq_t = snap["seq_e"], snap["seq_t"]
        self.by_key = {entity_key(e["type"], e["name"]): eid for eid, e in self.entities.items()}
        self.out = {eid: [] for eid in self.entities}
        self.inn = {eid: [] for eid in self.entities}
        for tid in sorted(self.triples):
            tr = self.triples[tid]
            self.out[tr["head"]].append(tid)
            self.inn[tr["tail"]].append(tid)

    def freeze(self, note="初始构建"):
        """把当前状态存为一个可回滚的版本。"""
        self.versions.append(dict(version=self.version, at=time.time(), note=note,
                                  stats=dict(entities=len(self.entities),
                                             triples=len(self.triples)),
                                  snapshot=self._snapshot()))
        self._log("FREEZE", "版本 %d：%s" % (self.version, note))

    def submit_update(self, ops, submitter="", note=""):
        """提交增量更新，进入待审核队列（SR-6 扩展流 2：审核后正式发布）。

        ops: [{op: add_triple, head_type, head, relation, tail_type, tail, weight, source}
              | {op: remove_triple, triple_id}
              | {op: set_weight, triple_id, weight}
              | {op: set_link_rule, rule_id, threshold_value, source}
              | {op: upsert_entity, entity_type, name, attrs, source}]
        """
        errs = []
        for k, o in enumerate(ops):
            if o.get("op") == "add_triple":
                if o.get("relation") not in RELATIONS:
                    errs.append("第 %d 项关系 %s 未登记" % (k, o.get("relation")))
                for f in ("head_type", "tail_type"):
                    if o.get(f) not in ENTITY_TYPES:
                        errs.append("第 %d 项 %s=%s 未登记" % (k, f, o.get(f)))
                signature = RELATION_SIGNATURES.get(o.get("relation"))
                if signature and (o.get("head_type") not in signature[0] or
                                  o.get("tail_type") not in signature[1]):
                    errs.append("第 %d 项 %s -> %s 不符合关系 %s 的类型约束" %
                                (k, o.get("head_type"), o.get("tail_type"), o.get("relation")))
                if not o.get("source"):
                    errs.append("第 %d 项缺少知识来源 source（SR-6.3 扩展流 2 要求可溯源）" % k)
                if not str(o.get("head", "")).strip() or not str(o.get("tail", "")).strip():
                    errs.append("第 %d 项头实体和尾实体名称不能为空" % k)
                try:
                    if not math.isfinite(float(o.get("weight", 1.0))) or float(o.get("weight", 1.0)) < 0:
                        raise ValueError
                except (ValueError, TypeError):
                    errs.append("第 %d 项权重必须是非负有限数" % k)
            elif o.get("op") in ("remove_triple", "set_weight"):
                if o.get("triple_id") not in self.triples:
                    errs.append("第 %d 项三元组 %s 不存在" % (k, o.get("triple_id")))
                if o["op"] == "set_weight":
                    try:
                        if not math.isfinite(float(o.get("weight"))) or float(o["weight"]) < 0:
                            raise ValueError
                    except (ValueError, TypeError):
                        errs.append("第 %d 项权重必须是非负有限数" % k)
            elif o.get("op") == "set_link_rule":
                rules = [e for e in self.entities.values()
                         if e["type"] == "Metric" and e["attrs"].get("rule_id") == o.get("rule_id")]
                if len(rules) != 1:
                    errs.append("第 %d 项链路状态规则不存在" % k)
                if not o.get("source"):
                    errs.append("第 %d 项缺少门限变更来源 source" % k)
                try:
                    value = float(o.get("threshold_value"))
                    metric = rules[0]["attrs"]["metric"] if rules else None
                    if not math.isfinite(value) or metric in ("ber", "packet_loss_rate", "delay_ms", "throughput_kbps") and value < 0 or metric == "packet_loss_rate" and value > 1:
                        raise ValueError
                except (ValueError, TypeError):
                    errs.append("第 %d 项门限值无效" % k)
            elif o.get("op") == "upsert_entity":
                if o.get("entity_type") not in ENTITY_TYPES or not str(o.get("name", "")).strip():
                    errs.append("第 %d 项实体类型或名称无效" % k)
                if not str(o.get("source", "")).strip():
                    errs.append("第 %d 项缺少实体来源 source" % k)
                attrs = o.get("attrs", {})
                if not isinstance(attrs, dict) or len(attrs) > 30 or any(
                        not isinstance(key, str) or not key or len(key) > 80 or
                        not isinstance(value, (str, int, float, bool, list, dict, type(None)))
                        for key, value in attrs.items()):
                    errs.append("第 %d 项实体属性格式无效" % k)
                if isinstance(attrs, dict) and {"rule_id", "threshold", "threshold_text"} & attrs.keys():
                    errs.append("第 %d 项链路数值门限只能通过 set_link_rule 修改" % k)
            else:
                errs.append("第 %d 项操作 %s 不支持" % (k, o.get("op")))
        if errs:
            return None, errs
        cid = "CR-%04d" % (len(self.pending) + len(self.log) + 1)
        self.pending.append(dict(change_id=cid, ops=list(ops), submitter=submitter,
                                 note=note, at=time.time(), status="PENDING"))
        self._log("SUBMIT", "%s 提交 %d 项变更：%s" % (cid, len(ops), note))
        return cid, []

    def review(self, change_id, approve=True, reviewer=""):
        """审核：通过则应用并发布新版本，驳回则丢弃。"""
        ch = next((c for c in self.pending if c["change_id"] == change_id), None)
        if ch is None or ch["status"] != "PENDING":
            return None
        if not approve:
            ch["status"] = "REJECTED"
            self._log("REJECT", "%s 被 %s 驳回" % (change_id, reviewer))
            return dict(change_id=change_id, status="REJECTED", version=self.version)
        before = self._snapshot()
        versions_before, log_before = copy.deepcopy(self.versions), copy.deepcopy(self.log)
        try:
            if not self.versions:
                self.freeze("审核前自动存档")
            applied = []
            for o in ch["ops"]:
                if o["op"] == "add_triple":
                    tid = self.add_triple((o["head_type"], o["head"]), o["relation"],
                                          (o["tail_type"], o["tail"]),
                                          weight=float(o.get("weight", 1.0)),
                                          source=o["source"], graph=o.get("graph", "update"))
                    applied.append(tid)
                elif o["op"] == "remove_triple":
                    self.remove_triple(o["triple_id"])
                    applied.append(o["triple_id"])
                elif o["op"] == "set_weight":
                    self.triples[o["triple_id"]]["weight"] = float(o["weight"])
                    applied.append(o["triple_id"])
                elif o["op"] == "set_link_rule":
                    from diagnosis.link_state_kg import _fmt, _val
                    rule = next(e for e in self.entities.values()
                                if e["type"] == "Metric" and e["attrs"].get("rule_id") == o["rule_id"])
                    attrs = rule["attrs"]
                    attrs["threshold"] = _val(attrs["metric"], o["threshold_value"])
                    attrs["threshold_text"] = _fmt(attrs["metric"], attrs["threshold"])
                    attrs["review_source"] = o["source"]
                    applied.append(o["rule_id"])
                elif o["op"] == "upsert_entity":
                    attrs = copy.deepcopy(o.get("attrs", {}))
                    attrs["source_doc"] = o["source"]
                    eid = self.add_entity(o["entity_type"], o["name"],
                                          graph=o.get("graph", "update"), attrs=attrs)
                    applied.append(eid)
        except Exception:
            self._restore(before)
            self.versions, self.log = versions_before, log_before
            raise
        ch["status"] = "APPROVED"
        self.version += 1
        self.freeze("发布 %s（%s）" % (change_id, ch["note"]))
        self._log("APPROVE", "%s 由 %s 审核通过，发布为版本 %d" % (change_id, reviewer, self.version))
        return dict(change_id=change_id, status="APPROVED", version=self.version,
                    applied=applied)

    def rollback(self, version):
        """回滚到指定版本（SR-6 扩展流 2）。回滚本身也形成一个新版本，历史不丢。"""
        v = next((x for x in self.versions if x["version"] == version), None)
        if v is None:
            return None
        self._restore(v["snapshot"])
        old = self.version
        self.version += 1
        self.freeze("由版本 %d 回滚到版本 %d 的内容" % (old, version))
        self._log("ROLLBACK", "回滚到版本 %d 的内容，新版本号 %d" % (version, self.version))
        return dict(version=self.version, restored_from=version,
                    entities=len(self.entities), triples=len(self.triples))

    def version_list(self):
        return [dict(version=v["version"], at=v["at"], note=v["note"], **v["stats"])
                for v in self.versions]

    def _log(self, op, text):
        self.log.append(dict(at=time.time(), op=op, text=text, version=self.version))

    # ─────────────────────────── 持久化 ───────────────────────────
    def to_rows(self, graph=None):
        """导出为数据字典 3.5 的三元组表行。"""
        rows = []
        for tid in sorted(self.triples):
            tr = self.triples[tid]
            if graph is not None and tr["graph"] != graph:
                continue
            h, t = self.entities[tr["head"]], self.entities[tr["tail"]]
            rows.append(dict(triple_id=tid, head=h["name"], head_type=h["type"],
                             relation=tr["relation"], tail=t["name"], tail_type=t["type"],
                             weight=tr["weight"], source_doc=tr["source"]))
        return rows

    def write_csv(self, path, graph=None):
        rows = self.to_rows(graph)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["triple_id", "head", "head_type", "relation",
                                              "tail", "tail_type", "weight", "source_doc"])
            w.writeheader()
            w.writerows(rows)
        return len(rows)

    def load_csv(self, path, graph=""):
        with open(path, encoding="utf-8-sig", newline="") as f:
            n = 0
            for r in csv.DictReader(f):
                self.add_triple((r["head_type"], r["head"]), r["relation"],
                                (r["tail_type"], r["tail"]),
                                weight=float(r.get("weight") or 1.0),
                                source=r.get("source_doc", ""), graph=graph)
                n += 1
        return n

    def dump_json(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(dict(name=self.name, version=self.version, entities=self.entities,
                           triples=self.triples, seq_e=self.seq_e, seq_t=self.seq_t,
                           log=self.log[-500:]), f, ensure_ascii=False)


def _bigrams(s):
    s = s.replace(" ", "")
    if len(s) < 2:
        return {s}
    return {s[i:i + 2] for i in range(len(s) - 1)}
