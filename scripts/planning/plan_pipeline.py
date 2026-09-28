"""第 3 周全流程串跑：路由 → 频率 → 参数 → 方案校验。

对应《项目安排》第 3 周「最终形成比较完整的网络资源配置方案」，
以及 SR-4.2 c) 的方案冲突校验。跑法：

    python3 -m planning.plan_pipeline
"""
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from datapaths import path as dpath
from terrain import default_terrain
from feasibility import stations_from_nodes, FeasibilityMatrix
from deployment import solve_assignment
import metrics as M
import routing
import frequency
import radio_params as RP
import plan_check


def load(rel):
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _representative_device(subtype, band, nodes, devices, models):
    """现网同类型站在该频段最常用的 (型号, 天线, 功率, 挂高)。新增中继照此配发。"""
    from collections import Counter
    sub = {n["node_id"]: n.get("node_subtype") for n in nodes}
    mband = {m["model_id"]: m["device_class"] for m in models}
    pool = [d for d in devices
            if mband.get(d["model_id"]) == band and sub.get(d["node_id"]) == subtype]
    if not pool:
        pool = [d for d in devices if mband.get(d["model_id"]) == band]
    if not pool:
        return None
    key, _n = Counter((d["model_id"], d["antenna_id"]) for d in pool).most_common(1)[0]
    return next(d for d in pool if (d["model_id"], d["antenna_id"]) == key)


def topology_from_deployment(stations, terrain, nodes=None, devices=None,
                             models=None, candidate_rows=None, verbose=False):
    """第 3 周的输入 = 第 2 周部署规划的**完整输出**，不是 link.csv 全集。

    **为什么不能直接用 link.csv**：那张表是「物理上可通的候选链路集合」，
    单个节点挂的链路数远超编成定额（实测 ND-0003 一个 Ⅱ固定站挂 14 条超短波，
    定额 4）。拿它做频率分配会把频点需求放大一个量级，做容量校验必然全线报警。

    **为什么必须走 P1 而不是只在现网上分配上级**：2026-09-29 修正频率口径后，
    现网台站自己已不能全连通（按真实频率评估），必须由 P1 在候选位置补中继。
    修正前频率评估乐观、现网自己就全通，这个简化才没暴露。

    返回 (fm, sol, links, nodes_ext, devices_ext)。
    新增中继站补出对应的节点行与设备行（按现网同类型站最常用的型号配发），
    下游频率、参数模块才能照常处理它们。
    """
    from terrain import haversine_m
    from deployment import p1_solve
    import echelon as _E

    if candidate_rows:
        fm, sol = p1_solve(list(stations), candidate_rows, terrain, refine=True)
    else:
        fm = FeasibilityMatrix(stations, terrain, candidate_pairs=False)
        sol = solve_assignment(fm, set(range(len(fm.stations))), set())

    used = dict(sol.ports)
    edges = [(c, p, b, False) for c, (p, b) in sol.parent_of.items()]
    # 备份父链路：只在两端端口都还有余量时才建，保证不越编成定额
    for child, (parent, band) in sorted(sol.parent_of.items()):
        ca = _E.capacity(fm.stations[child].subtype, band)
        if used.get((child, band), 0) >= ca:
            continue
        best = None
        for j in fm.neighbors(child, band):
            if j == parent or j not in sol.connected:
                continue
            cb = _E.capacity(fm.stations[j].subtype, band)
            if used.get((j, band), 0) >= cb:
                continue
            m = fm.margin_of(child, j, band)
            if m is not None and (best is None or m > best[1]):
                best = (j, m)
        if best:
            j = best[0]
            used[(child, band)] = used.get((child, band), 0) + 1
            used[(j, band)] = used.get((j, band), 0) + 1
            edges.append((child, j, band, True))

    rows = []
    for k, (i, j, band, is_bk) in enumerate(edges, start=1):
        sa, sb = fm.stations[i], fm.stations[j]
        m = fm.margin_of(i, j, band)
        rows.append(dict(link_id="PL-%04d" % k,
                         node_a_id=sa.sid, node_b_id=sb.sid,
                         device_class=band, device_a_id="", device_b_id="",
                         link_margin_db="%.2f" % (m if m is not None else 0.0),
                         distance_m="%.1f" % haversine_m(sa.lon, sa.lat, sb.lon, sb.lat),
                         is_available="true", link_state="",
                         is_backup=str(is_bk).lower()))

    nodes_ext = list(nodes or [])
    devices_ext = list(devices or [])
    if nodes is not None and devices is not None and models is not None:
        seq = len(devices_ext)
        for idx, subtype in sol.added:
            st = fm.stations[idx]
            nodes_ext.append(dict(node_id=st.sid, lon=st.lon, lat=st.lat,
                                  node_subtype=subtype,
                                  echelon=_E.SUBTYPE_ECHELON.get(subtype, ""),
                                  device_class=";".join(sorted(st.radio)),
                                  _added_relay=True))
            for band in sorted(st.radio):
                rep = _representative_device(subtype, band, nodes, devices, models)
                if rep is None:
                    continue
                for _k in range(max(1, _E.capacity(subtype, band))):
                    seq += 1
                    devices_ext.append(dict(rep, device_id="DV-R%04d" % seq,
                                            node_id=st.sid,
                                            antenna_height_m=str(st.radio[band]["height"])))
    return fm, sol, rows, nodes_ext, devices_ext


def run(strategy="MAX_RELIABILITY", preset="TERRAIN", granularity="NET",
        topology="DEPLOYMENT", verbose=True):
    steps = []
    t0 = time.time()
    terrain = default_terrain(verbose=False)
    nodes, devices = load("node.csv"), load("device.csv")
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    links, demands = load("link.csv"), load("comm_demand.csv")
    metrics = load("link_metric.csv")
    pool_rows = load("frequency_resource.csv")
    stations = stations_from_nodes(nodes, devices, models, antennas)
    steps.append(("加载数据与地形", time.time() - t0))

    if topology == "DEPLOYMENT":
        t0 = time.time()
        fm, sol, links, nodes, devices = topology_from_deployment(
            stations, terrain, nodes, devices, models, load("candidate_site.csv"))
        stations = stations + [fm.stations[i] for i, _s in sol.added]
        steps.append(("第 2 周部署规划（新增 %d 台，%d 条链路）"
                      % (len(sol.added), len(links)), time.time() - t0))

    # ── 路由规划 ──
    t0 = time.time()
    g, skipped = routing.graph_from_links(links, metrics)
    routes = routing.plan_routes(g, demands, default_strategy=strategy)
    steps.append(("路由规划（%d 条需求）" % len(demands), time.time() - t0))

    # ── 频率分配 ──
    t0 = time.time()
    builder = frequency.tasks_from_nets if granularity == "NET" else frequency.tasks_from_links
    ftasks = builder(links, nodes, devices, models)
    if topology == "DEPLOYMENT":
        frequency.fill_ranges_by_node(ftasks, links, nodes, devices, models)
    pool = frequency.FreqPool(pool_rows)
    freq = frequency.assign(ftasks, pool)
    steps.append(("频率分配（%s 粒度）" % granularity, time.time() - t0))

    # ── 电台参数 ──
    t0 = time.time()
    caps = RP.capabilities_from_tables(stations, devices, models, antennas)
    topo = RP.topo_from_links(stations, links)
    presets = [RP.plan(stations, topo, caps, terrain, preset=p)
               for p in ("TERRAIN", "MISSION", "INTERFERENCE")]
    chosen = next(p for p in presets if p["preset"] == preset)
    steps.append(("电台参数（3 套预选配置）", time.time() - t0))

    # ── 方案校验 ──
    t0 = time.time()
    chk = plan_check.check(freq_result=freq, freq_tasks=ftasks,
                           param_result=chosen, route_result=routes,
                           links=links, nodes=nodes, caps=caps)
    steps.append(("方案校验", time.time() - t0))

    if verbose:
        _report(steps, g, skipped, routes, freq, ftasks, presets, chosen, chk, pool)
    return dict(routes=routes, frequency=freq, params=chosen,
                presets=presets, check=chk, steps=steps,
                # 下游（多目标优化、干扰分析）要用的中间结果
                stations=stations, links=links, nodes=nodes, devices=devices,
                freq_tasks=ftasks, graph=g, caps=caps, terrain=terrain)


def _report(steps, g, skipped, routes, freq, ftasks, presets, chosen, chk, pool):
    print("=" * 78)
    print("第 3 周全流程：路由 → 频率 → 参数 → 校验")
    print("=" * 78)
    print("\n%-34s %8s" % ("阶段", "耗时 s"))
    for name, el in steps:
        print("%-34s %8.2f" % (name, el))
    print("%-34s %8.2f   [甲方指标 ≤300]  %s"
          % ("合计", sum(e for _n, e in steps),
             "达标 ✓" if sum(e for _n, e in steps) <= 300 else "超标 ✗"))

    rs = routes["routes"]
    ok = [r for r in rs if r["reachable"]]
    with_bk = [r for r in ok if r.get("backup")]
    nd = sum(1 for r in ok if r.get("backup_type") == "NODE_DISJOINT")
    print("\n▎路由规划（SR-4.2.2.1）")
    print("  图：顶点 %d，链路 %d，不可用链路跳过 %d 条" % (len(g.vkey), len(g.links), skipped))
    print("  需求 %d 条：可达 %d（%.1f%%），不可达 %d"
          % (len(rs), len(ok), 100.0 * len(ok) / max(1, len(rs)),
             len(routes["unreachable_demand_ids"])))
    print("  有备用路由 %d 条（节点不相交 %d / 链路不相交 %d）"
          % (len(with_bk), nd, len(with_bk) - nd))
    risky = [r for r in ok if r.get("single_point_risks")]
    print("  无备用且主路由含单点故障的需求：%d 条" % len(risky))
    if ok:
        hops = sorted(r["primary"]["hop_count"] for r in ok)
        rel = sorted(r["primary"]["reliability"] for r in ok)
        dly = sorted(r["primary"]["total_delay_ms"] for r in ok)
        print("  跳数 中位 %d 最大 %d ｜ 可靠性 中位 %.4f 最低 %.4f ｜ 时延 中位 %.0f ms 最大 %.0f ms"
              % (hops[len(hops) // 2], hops[-1], rel[len(rel) // 2], rel[0],
                 dly[len(dly) // 2], dly[-1]))

    print("\n▎频率分配（SR-4.2.2.2）")
    st = freq["stats"]
    co = sum(1 for c in freq["conflicts"] if c["type"] == "CO_CHANNEL")
    print("  对象 %d 个（%d 条链路），可用频点 %d，用掉 %d"
          % (st["links"], sum(len(t.members) for t in ftasks), len(pool), st["channels_used"]))
    print("  冲突 %d 处（同频 %d / 邻频 %d），无冲突：%s"
          % (len(freq["conflicts"]), co, len(freq["conflicts"]) - co,
             "是 ✓" if freq["conflict_free"] else "否"))
    for band, gp in sorted(freq["gap"].items()):
        print("  %s 频点缺口：需要 ≥%d，可用 %d，缺 %d"
              % (band, gp["required_channels"], gp["available_channels"], gp["shortage"]))

    print("\n▎电台参数（SR-4.2.3）")
    rows = RP.compare_plans(presets)
    best = RP.recommend(rows)
    for row in rows:
        print("  %-12s 门限 %4.1f dB  总辐射 %8.1f W  最差余量 %6.1f dB  未达标 %3d%s"
              % (row["name"], row["fade_margin_db"], row["total_radiated_w"],
                 row["min_margin_db"], row["failed"],
                 "  ←推荐" if row is best else ""))
    print("  本次采用：%s" % chosen["preset_name"])

    print("\n▎方案校验（SR-4.2 c）")
    print(plan_check.format_report(chk))
    print("=" * 78)


if __name__ == "__main__":
    run()
