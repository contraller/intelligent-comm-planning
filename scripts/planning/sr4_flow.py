"""SR-4 全流程（第 4 周整合）：

    任务条件输入 → 电台部署 → 路由规划 → 频率/功率配置 → 方案优化
    → 在优化后的拓扑上重做路由与频率（闭环）→ 干扰分析 → 结果输出

对应《项目安排》第 4 周「把 SR-4 的整个流程打通」，并在此验证甲方指标
「满节点负荷仿真规划时间 ≤ 5 分钟」（《技术参考》(7)）。跑法：

    python3 -m planning.sr4_flow            # 全部任务
    python3 -m planning.sr4_flow TS-0002    # 指定任务场景
"""
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from datapaths import path as dpath
from terrain import default_terrain, haversine_m
from feasibility import stations_from_nodes
import routing
import frequency as FQ
import radio_params as RP
import plan_check
import multi_objective as MO
import interference as IF
from plan_pipeline import topology_from_deployment, _representative_device

TIME_LIMIT_S = 300.0


def load(rel):
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def rows_from_solution(pb, e, nodes, devices, models):
    """把一个优化解（下标形式的链路）落成链路表，并给新增中继补节点/设备行。"""
    fm = pb.fm
    rows = []
    for k, (a, b, band) in enumerate(e["links"], start=1):
        sa, sb = fm.stations[a], fm.stations[b]
        m = pb.margin_at_max(a, b, band)
        rows.append(dict(link_id="OL-%04d" % k, node_a_id=sa.sid, node_b_id=sb.sid,
                         device_class=band, device_a_id="", device_b_id="",
                         link_margin_db="%.2f" % (m if m is not None else 0.0),
                         distance_m="%.1f" % haversine_m(sa.lon, sa.lat, sb.lon, sb.lat),
                         is_available="true", link_state="",
                         is_backup=str(k > len(pb.base)).lower()))
    nodes_x, devices_x = list(nodes), list(devices)
    have = {n["node_id"] for n in nodes_x}
    seq = len(devices_x)
    for i in e["relays"]:
        st = fm.stations[i]
        if st.sid in have:
            continue
        nodes_x.append(dict(node_id=st.sid, lon=st.lon, lat=st.lat,
                            node_subtype=st.subtype,
                            echelon=E.SUBTYPE_ECHELON.get(st.subtype, ""),
                            device_class=";".join(sorted(st.radio)), _added_relay=True))
        for band in sorted(st.radio):
            rep = _representative_device(st.subtype, band, nodes, devices, models)
            if rep is None:
                continue
            for _k in range(max(1, E.capacity(st.subtype, band))):
                seq += 1
                devices_x.append(dict(rep, device_id="DV-O%04d" % seq, node_id=st.sid,
                                      antenna_height_m=str(st.radio[band]["height"])))
    return rows, nodes_x, devices_x


def run(task_id=None, preset="TERRAIN", strategy="MAX_RELIABILITY",
        constraints=None, pop_size=40, generations=40, verbose=True):
    steps = []
    T = time.time()

    # ── 1 任务条件输入 ──
    t0 = time.time()
    terrain = default_terrain(verbose=False)
    nodes, devices = load("node.csv"), load("device.csv")
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    demands_all = load("comm_demand.csv")
    demands = [d for d in demands_all if task_id is None or d["task_id"] == task_id]
    if not demands:
        raise ValueError("任务 %s 没有通联需求" % task_id)
    pool_rows, jam_rows = load("frequency_resource.csv"), load("interference_source.csv")
    metrics_rows, cand_rows = load("link_metric.csv"), load("candidate_site.csv")
    stations = stations_from_nodes(nodes, devices, models, antennas)
    steps.append(("1 任务条件输入（需求 %d 条）" % len(demands), time.time() - t0))

    # ── 2 电台部署（第 2 周 P1）──
    t0 = time.time()
    fm, sol, links0, nodes1, devices1 = topology_from_deployment(
        stations, terrain, nodes, devices, models, cand_rows)
    steps.append(("2 电台部署（新增 %d 台）" % len(sol.added), time.time() - t0))

    # ── 3 路由 + 频率 + 功率（第 3 周，在部署拓扑上）──
    t0 = time.time()
    st1 = stations + [fm.stations[i] for i, _s in sol.added]
    caps1 = RP.capabilities_from_tables(st1, devices1, models, antennas)
    params1 = RP.plan(st1, RP.topo_from_links(st1, links0), caps1, terrain, preset=preset)
    steps.append(("3 初始功率配置", time.time() - t0))

    # ── 4 方案优化（第 4 周 NSGA-II）──
    t0 = time.time()
    cons = dict(MO.DEFAULT_CONSTRAINTS)
    cons.update(constraints or {})
    pb = MO.Problem(fm, sol, demands, caps1,
                    survivability_threshold=cons["survivability_threshold"])
    opt = MO.optimize(pb, constraints=cons, pop_size=pop_size, generations=generations)
    best = opt["solutions"][0]
    steps.append(("4 多目标优化（评估 %d 次）" % opt["evaluations"], time.time() - t0))

    # ── 5 闭环：在优化后的拓扑上重做路由、频率、功率 ──
    t0 = time.time()
    links, nodes2, devices2 = rows_from_solution(pb, best, nodes1, devices1, models)
    st2 = st1 + [fm.stations[i] for i in best["relays"]]
    g = routing.graph_from_links(links, metrics_rows)[0]
    routes = routing.plan_routes(g, demands, default_strategy=strategy)
    ftasks = FQ.tasks_from_nets(links, nodes2, devices2, models)
    FQ.fill_ranges_by_node(ftasks, links, nodes2, devices2, models)
    freq = FQ.assign(ftasks, FQ.FreqPool(pool_rows))
    freq["link_assignments"] = FQ.expand_to_links(freq, ftasks)
    caps2 = RP.capabilities_from_tables(st2, devices2, models, antennas)
    # 衰落余量沿用优化器的决定（它在这一档求出的功率最小且满足全部硬约束），
    # 挂高策略仍按所选预选配置。否则两处功率对不上。
    params = RP.plan(st2, RP.topo_from_links(st2, links), caps2, terrain, preset=preset,
                     fade_margin_db=best["m_req"])
    chk = plan_check.check(freq_result=freq, freq_tasks=ftasks, param_result=params,
                           route_result=routes, links=links, nodes=nodes2, caps=caps2)
    steps.append(("5 优化后重做路由/频率/功率/校验", time.time() - t0))

    # ── 6 干扰分析 ──
    t0 = time.time()
    plan = dict(stations=st2, links=links, terrain=terrain, frequency=freq,
                freq_tasks=ftasks, params=params)
    sc = IF.scenario_from_plan(plan, jam_rows)
    ana = IF.analyze(sc, area=True, area_cell_m=3000.0)
    cms, unresolved, review = IF.recommend(
        sc, ana, freq_ctx=IF.FreqContext(ftasks, freq["assignments"]), caps=caps2,
        route_ctx=(g, routes), candidate_rows=cand_rows)
    steps.append(("6 干扰分析与抗干扰推荐", time.time() - t0))

    total = time.time() - T
    out = dict(task_id=task_id, steps=steps, total_s=total, within_limit=total <= TIME_LIMIT_S,
               deployment=dict(added=[fm.stations[i].sid for i, _s in sol.added]),
               optimization=dict(feasible=opt["feasible"], infeasible=opt["infeasible"],
                                 best=MO.describe(pb, best, opt["constraints"], rank=1),
                                 tradeoff=[MO.describe(pb, e, opt["constraints"])
                                           for e in opt["tradeoff"]]),
               routes=routes, frequency=freq, params=params, check=chk,
               interference=dict(analysis={k: v for k, v in ana.items() if k != "_states"},
                                 countermeasures=cms, unresolved=unresolved, review=review),
               links=links, nodes=nodes2)
    if verbose:
        _report(out)
    return out


def _report(o):
    print("=" * 78)
    print("SR-4 全流程%s" % ("（任务 %s）" % o["task_id"] if o["task_id"] else "（全部任务）"))
    print("=" * 78)
    print("\n%-40s %8s" % ("阶段", "耗时 s"))
    for name, el in o["steps"]:
        print("%-40s %8.2f" % (name, el))
    print("%-40s %8.2f   [甲方指标 ≤300 s]  %s"
          % ("合计", o["total_s"], "达标 ✓" if o["within_limit"] else "超标 ✗"))

    b = o["optimization"]["best"]
    ob, cc = b["objectives"], b["constraint_check"]
    print("\n▎方案优化（SR-4.2.4）  有可行解：%s" % o["optimization"]["feasible"])
    print("  连通率 %.3f ｜ 抗毁性 %.3f（要求 ≥%.2f）｜ 总辐射 %.0f W（%.1f dBm）｜ 中继跳 %d"
          % (ob["e2e_connectivity"], ob["survivability"], cc["survivability"]["required"],
             ob["total_radiated_power_w"], ob["total_radiated_power_dbm"],
             cc["max_relay_hops"]["value"]))
    print("  追加中继 %d 个、备份链路 %d 条；拓扑链路 %d 条"
          % (len(b["added_relays"]), len(b["added_backup_links"]), b["links_total"]))
    if o["optimization"]["infeasible"]:
        for r in o["optimization"]["infeasible"]["conflicting_constraints"]:
            print("  冲突：%s" % r)

    rs = o["routes"]["routes"]
    ok = [r for r in rs if r["reachable"]]
    print("\n▎路由（优化后拓扑）  可达 %d/%d，有备用 %d 条"
          % (len(ok), len(rs), sum(1 for r in ok if r.get("backup"))))
    f = o["frequency"]
    print("▎频率  对象 %d，冲突 %d 处，缺口 %s"
          % (f["stats"]["links"], len(f["conflicts"]),
             "，".join("%s 缺 %d" % (k, v["shortage"]) for k, v in sorted(f["gap"].items()))))
    s = o["params"]["summary"]
    print("▎参数  %s（衰落余量 %.0f dB，沿用优化结果）：总辐射 %.0f W，最差余量 %.1f dB，未达标 %d"
          % (o["params"]["preset_name"], o["params"]["fade_margin_db"],
             s["total_radiated_w"], s["min_margin_db"], s["failed"]))
    c = o["check"]["summary"]
    print("▎校验  %s：严重 %d / 一般 %d  %s"
          % ("通过" if o["check"]["passed"] else "未通过", c["severe"], c["moderate"],
             dict(c["by_kind"])))
    ia = o["interference"]["analysis"]["summary"]
    cms = o["interference"]["countermeasures"]
    print("▎干扰  受扰链路 %d（严重 %d / 中度 %d / 轻度 %d），措施 %d 条（能恢复 %d），无解 %d"
          % (ia["affected_links"], ia["by_level"]["SEVERE"], ia["by_level"]["MODERATE"],
             ia["by_level"]["MINOR"], len(cms), sum(1 for x in cms if x["restores"]),
             len(o["interference"]["unresolved"])))
    print("=" * 78)


if __name__ == "__main__":
    run(task_id=sys.argv[1] if len(sys.argv) > 1 else None)
