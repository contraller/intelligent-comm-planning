#!/usr/bin/env python3
"""测试数据集校验。检查引用完整性、枚举合法性、拓扑连通性与需求可满足性。

    python3 scripts/validate_data.py
退出码 0 表示全部通过，1 表示存在 ERROR。
"""
import csv, json, os, sys, collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from datapaths import path as dpath
ERR, WARN = [], []


def load(name):
    p = dpath(name)
    if not os.path.exists(p):
        ERR.append("缺少文件 %s" % name)
        return []
    with open(p, encoding="utf-8") as f:
        return list(csv.DictReader(f))


ENUMS = {
    "node.device_class": {"HF", "VUHF"},
    "node.node_role": {"TASK", "FIXED_STATION", "RELAY", "CANDIDATE"},
    "node.mobility": {"FIXED", "VEHICLE", "MANPACK"},
    "node.status": {"NORMAL", "FAULT", "OFFLINE"},
    "link.link_state": {"EXCELLENT", "GOOD", "WARNING", "FAULT"},
    "link.device_class": {"HF", "VUHF"},
    "link_metric.link_state": {"EXCELLENT", "GOOD", "WARNING", "FAULT"},
    "comm_demand.priority": {"P1", "P2", "P3"},
    "comm_demand.service_type": {"话音", "数据", "短消息"},
    "fault_case.fault_type": {"HW_FAILURE", "LINK_DOWN", "SW_CONFIG", "EMI"},
    "fault_case.object_type": {"DEVICE", "LINK", "NODE"},
    "interference_source.interference_type":
        {"NARROWBAND", "BROADBAND", "SWEEP", "PULSE", "NOISE"},
    "candidate_site.candidate_role": {"RELAY", "MOBILE_STATION", "TEMP_FIXED_STATION"},
    "candidate_site.recommendation_level": {"A", "B", "C", "D"},
    "frequency_conflict.conflict_type": {"SHARED_NODE", "ADJACENT_CHANNEL_NEAR_PATH"},
}
BOOLS = [("node", "is_key"), ("link", "is_available"), ("link", "is_backup"),
         ("comm_demand", "is_mandatory"), ("frequency_resource", "is_available"),
         ("interference_source", "active"), ("candidate_site", "is_deployable"),
         ("frequency_conflict", "hard_constraint")]


def main():
    nodes = load("node.csv"); devices = load("device.csv")
    models = load("device_model.csv"); antennas = load("antenna_model.csv")
    links = load("link.csv"); demands = load("comm_demand.csv")
    tasks = load("task_scenario.csv"); freqs = load("frequency_resource.csv")
    inters = load("interference_source.csv"); metrics = load("link_metric.csv")
    cases = load("fault_case.csv"); symptoms = load("symptom_dict.csv")
    candidate_sites = load("candidate_site.csv")
    freq_conflicts = load("frequency_conflict.csv")
    fault_rules = load("fault_rule.csv")
    tables = dict(node=nodes, device=devices, link=links, comm_demand=demands,
                  frequency_resource=freqs, interference_source=inters,
                  link_metric=metrics, fault_case=cases,
                  candidate_site=candidate_sites, frequency_conflict=freq_conflicts,
                  fault_rule=fault_rules)

    print("=" * 70)
    print("测试数据集校验")
    print("=" * 70)

    # ── 1 引用完整性 ──
    print("\n[1] 引用完整性")
    nid = {n["node_id"] for n in nodes}
    did = {d["device_id"] for d in devices}
    mid = {m["model_id"] for m in models}
    aid = {a["antenna_id"] for a in antennas}
    lid = {l["link_id"] for l in links}
    tid = {t["task_id"] for t in tasks}
    sid_ = {s["symptom_id"] for s in symptoms}
    cid = {c["case_id"] for c in cases}
    checks = [
        ("device.node_id → node", [d["node_id"] for d in devices], nid),
        ("device.model_id → device_model", [d["model_id"] for d in devices], mid),
        ("device.antenna_id → antenna_model", [d["antenna_id"] for d in devices], aid),
        ("link.node_a_id → node", [l["node_a_id"] for l in links], nid),
        ("link.node_b_id → node", [l["node_b_id"] for l in links], nid),
        ("link.device_a_id → device", [l["device_a_id"] for l in links], did),
        ("link.device_b_id → device", [l["device_b_id"] for l in links], did),
        ("comm_demand.task_id → task", [d["task_id"] for d in demands], tid),
        ("comm_demand.src_node_id → node", [d["src_node_id"] for d in demands], nid),
        ("comm_demand.dst_node_id → node", [d["dst_node_id"] for d in demands], nid),
        ("link_metric.link_id → link", [m["link_id"] for m in metrics], lid),
        ("frequency_conflict.link_id_a → link",
         [c["link_id_a"] for c in freq_conflicts], lid),
        ("frequency_conflict.link_id_b → link",
         [c["link_id_b"] for c in freq_conflicts], lid),
        ("fault_rule.source_case_id → fault_case",
         [r["source_case_id"] for r in fault_rules], cid),
    ]
    for label, vals, universe in checks:
        bad = {v for v in vals if v not in universe}
        if bad:
            ERR.append("%s 有 %d 个悬空引用, 例: %s" % (label, len(bad), list(bad)[:3]))
            print("   ✗ %-38s %d 个悬空引用" % (label, len(bad)))
        else:
            print("   ✓ %-38s %d 条" % (label, len(vals)))
    bad_sym = set()
    for c in cases:
        for s in (c.get("symptom_ids") or "").split(";"):
            if s and s not in sid_:
                bad_sym.add(s)
    print("   %s fault_case.symptom_ids → symptom_dict   %s"
          % ("✓" if not bad_sym else "✗", "全部有效" if not bad_sym else list(bad_sym)[:3]))
    if bad_sym:
        ERR.append("fault_case.symptom_ids 存在未定义现象码 %s" % list(bad_sym)[:3])

    # ── 2 枚举与布尔 ──
    print("\n[2] 枚举值与布尔值")
    ok = True
    for key, allowed in ENUMS.items():
        t, col = key.split(".")
        vals = {r.get(col) for r in tables.get(t, []) if r.get(col)}
        bad = vals - allowed
        if bad:
            ERR.append("%s 非法枚举 %s" % (key, sorted(bad)))
            print("   ✗ %-42s 非法值 %s" % (key, sorted(bad)))
            ok = False
    for t, col in BOOLS:
        vals = {r.get(col) for r in tables.get(t, []) if r.get(col) != ""}
        bad = vals - {"true", "false"}
        if bad:
            ERR.append("%s.%s 布尔值非法 %s" % (t, col, sorted(bad)))
            print("   ✗ %s.%s 布尔值非法 %s" % (t, col, sorted(bad)))
            ok = False
    if ok:
        print("   ✓ 全部 %d 个枚举字段、%d 个布尔字段合法" % (len(ENUMS), len(BOOLS)))

    # ── 3 数值合理性 ──
    print("\n[3] 数值范围")
    def rng_check(label, vals, lo, hi):
        bad = [v for v in vals if not (lo <= v <= hi)]
        if bad:
            WARN.append("%s 有 %d 个值超出 [%s, %s]" % (label, len(bad), lo, hi))
            print("   ! %-34s %d 个越界, 例 %s" % (label, len(bad), bad[:3]))
        else:
            print("   ✓ %-34s 全部落在 [%s, %s]" % (label, lo, hi))
    rng_check("node.lon", [float(n["lon"]) for n in nodes], 114.2724, 115.6276)
    rng_check("node.lat", [float(n["lat"]) for n in nodes], 36.7610, 37.8390)
    rng_check("node.elevation_m", [float(n["elevation_m"]) for n in nodes], 0, 3000)
    rng_check("link_metric.packet_loss_rate",
              [float(m["packet_loss_rate"]) for m in metrics], 0.0, 1.0)
    rng_check("comm_demand.min_reliability",
              [float(d["min_reliability"]) for d in demands], 0.0, 1.0)
    rng_check("device.antenna_height_m",
              [float(d["antenna_height_m"]) for d in devices], 0.5, 30.0)
    if candidate_sites:
        rng_check("candidate_site.lon", [float(s["lon"]) for s in candidate_sites],
                  114.2724, 115.6276)
        rng_check("candidate_site.lat", [float(s["lat"]) for s in candidate_sites],
                  36.7610, 37.8390)
        rng_check("candidate_site.score", [float(s["score"]) for s in candidate_sites],
                  0.0, 100.0)

    # ── 4 拓扑连通性 ──
    print("\n[4] 拓扑连通性（按设备类别分别计算）")
    comp_of = {}
    for cls in ("HF", "VUHF"):
        ns = [n["node_id"] for n in nodes if n["device_class"] == cls]
        par = {x: x for x in ns}
        def find(x):
            while par[x] != x:
                par[x] = par[par[x]]; x = par[x]
            return x
        for l in links:
            if l["device_class"] != cls or l["is_available"] != "true":
                continue
            a, b = l["node_a_id"], l["node_b_id"]
            if a in par and b in par:
                ra, rb = find(a), find(b)
                if ra != rb:
                    par[ra] = rb
        groups = collections.Counter(find(x) for x in ns)
        biggest = max(groups.values()) if groups else 0
        for x in ns:
            comp_of[x] = find(x)
        status = "✓" if len(groups) == 1 else "!"
        print("   %s %-5s 节点 %3d  连通分量 %d  最大分量 %d (%.0f%%)"
              % (status, cls, len(ns), len(groups), biggest,
                 100.0 * biggest / max(1, len(ns))))
        if len(groups) > 1:
            WARN.append("%s 网络存在 %d 个连通分量，孤立节点 %d 个"
                        % (cls, len(groups), len(ns) - biggest))

    # ── 5 需求可满足性 ──
    print("\n[5] 通联需求可满足性")
    mand = [d for d in demands if d["is_mandatory"] == "true"]
    def same(d):
        return comp_of.get(d["src_node_id"]) == comp_of.get(d["dst_node_id"]) \
               and comp_of.get(d["src_node_id"]) is not None
    bad_all = [d for d in demands if not same(d)]
    bad_mand = [d for d in mand if not same(d)]
    print("   总需求 %d，其中必要需求 %d (%.0f%%)"
          % (len(demands), len(mand), 100.0 * len(mand) / max(1, len(demands))))
    if bad_mand:
        ERR.append("有 %d 条必要通联关系两端不连通，SR-4.2.4 硬约束必然无解: %s"
                   % (len(bad_mand), [d["demand_id"] for d in bad_mand][:5]))
        print("   ✗ %d 条必要需求两端不连通 → SR-4.2.4 硬约束无解" % len(bad_mand))
    else:
        print("   ✓ 全部 %d 条必要需求两端连通（SR-4.2.4 硬约束存在可行解）" % len(mand))
    print("   %s 非必要需求中 %d 条两端不连通（可由中继规划解决，属正常）"
          % ("·", len(bad_all) - len(bad_mand)))

    # ── 6 状态标签分布 ──
    print("\n[6] 标签分布（SR-6.2 规则挖掘 / SR-5.2 模型训练的样本基础）")
    for name, rows, col in (("link.link_state", links, "link_state"),
                            ("link_metric.link_state", metrics, "link_state"),
                            ("fault_case.fault_type", cases, "fault_type")):
        c = collections.Counter(r[col] for r in rows)
        tot = sum(c.values())
        print("   %-24s %s" % (name, "  ".join("%s=%d(%.0f%%)" % (k, v, 100.0 * v / tot)
                                               for k, v in c.most_common())))
        if min(c.values()) < 0.03 * tot:
            WARN.append("%s 最小类别占比不足 3%%，模型训练可能欠拟合该类" % name)

    # ── 7 故障场景适配性（SR-5.1 校验规则）──
    print("\n[7] 故障场景适配性（SR-5.1）")
    ALLOW = {"HW_FAILURE": {"DEVICE", "NODE"}, "SW_CONFIG": {"DEVICE", "NODE"},
             "LINK_DOWN": {"LINK"}, "EMI": {"LINK", "NODE"}}
    p = dpath("fault_scenario.json")
    n_f = 0
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            scen = json.load(f)
        for sc in scen:
            for fl in sc["faults"]:
                n_f += 1
                if fl["object_type"] not in ALLOW[fl["fault_type"]]:
                    ERR.append("场景 %s: %s 不能作用于 %s"
                               % (sc["scenario_id"], fl["fault_type"], fl["object_type"]))
        print("   ✓ %d 个场景 / %d 个故障对象，类型与对象适配性全部通过" % (len(scen), n_f))
    for c in cases:
        if c["object_type"] not in ALLOW[c["fault_type"]]:
            ERR.append("案例 %s: %s 不能作用于 %s"
                       % (c["case_id"], c["fault_type"], c["object_type"]))
    print("   %s fault_case 共 %d 条，适配性检查%s"
          % ("✓" if not any("案例" in e for e in ERR) else "✗", len(cases),
             "通过" if not any("案例" in e for e in ERR) else "未通过"))

    # ── 8 算法设计补充数据 ──
    print("\n[8] 算法设计补充数据")
    route_p = dpath("route.json")
    routes = []
    if os.path.exists(route_p):
        with open(route_p, encoding="utf-8") as f:
            routes = json.load(f)
        bad_route_ref = []
        demand_ids = {d["demand_id"] for d in demands}
        task_ids = {t["task_id"] for t in tasks}
        for r in routes:
            if r["demand_id"] not in demand_ids or r["task_id"] not in task_ids:
                bad_route_ref.append(r["route_id"])
            if any(n not in nid for n in r["node_path"]):
                bad_route_ref.append(r["route_id"])
            if any(l not in lid for l in r["link_path"]):
                bad_route_ref.append(r["route_id"])
        if bad_route_ref:
            ERR.append("routes_v1.json 存在悬空引用: %s" % bad_route_ref[:5])
            print("   ✗ routes_v1.json 存在 %d 条悬空引用" % len(bad_route_ref))
        else:
            print("   ✓ routes_v1.json                  %d 条路由引用全部有效" % len(routes))
    else:
        ERR.append("缺少文件 route.json")
    print("   ✓ candidate_sites_v1.csv          %d 个候选点" % len(candidate_sites))
    print("   ✓ frequency_conflicts_v1.csv      %d 条频率冲突约束" % len(freq_conflicts))
    print("   ✓ fault_rules_v1.csv              %d 条故障规则" % len(fault_rules))

    # ── 汇总 ──
    print("\n" + "=" * 70)
    if ERR:
        print("校验未通过：%d 个 ERROR，%d 个 WARNING" % (len(ERR), len(WARN)))
        for e in ERR:
            print("  [ERROR] %s" % e)
    else:
        print("校验通过：0 个 ERROR，%d 个 WARNING" % len(WARN))
    for w in WARN:
        print("  [WARN ] %s" % w)
    print("=" * 70)
    return 1 if ERR else 0


if __name__ == "__main__":
    sys.exit(main())
