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


def topology_from_deployment(stations, terrain, verbose=False):
    """用第 2 周的部署结果当拓扑，而不是 link.csv 全集。

    **为什么不能直接用 link.csv**：那张表是「物理上可通的候选链路集合」，
    500 条里每个节点挂了远超编成定额的链路数（实测 ND-0003 一个 Ⅱ固定站
    就挂了 14 条超短波链路，定额只有 4）。候选集不是已建成的网——
    拿它做频率分配会把频点需求放大一个量级，做容量校验必然全线报警。

    已建成的网 = 部署求解出的父子链路 + 容量还有余量时补上的备份父链路。
    """
    fm = FeasibilityMatrix(stations, terrain, candidate_pairs=False)
    sol = solve_assignment(fm, set(range(len(fm.stations))), set())
    used = dict(sol.ports)
    edges = []
    for child, (parent, band) in sol.parent_of.items():
        edges.append((child, parent, band, False))
    # 备份父链路：只在两端端口都还有余量时才建，保证不越编成定额
    import echelon as _E
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
        from terrain import haversine_m
        rows.append(dict(link_id="PL-%04d" % k,
                         node_a_id=sa.sid, node_b_id=sb.sid,
                         device_class=band,
                         device_a_id="", device_b_id="",
                         link_margin_db="%.2f" % (m if m is not None else 0.0),
                         distance_m="%.1f" % haversine_m(sa.lon, sa.lat, sb.lon, sb.lat),
                         is_available="true",
                         link_state="", is_backup=str(is_bk).lower()))
    return fm, sol, rows


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
        fm, sol, links = topology_from_deployment(stations, terrain)
        steps.append(("重建第 2 周规划拓扑（%d 条链路）" % len(links), time.time() - t0))

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
                presets=presets, check=chk, steps=steps)


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
