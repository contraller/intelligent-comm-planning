"""SR-4 全流程（第 4 周整合）：

    任务条件输入 → 电台部署 → 路由规划 → 频率/功率配置 → 方案优化
    → 在优化后的拓扑上重做路由与频率（闭环）→ 干扰分析 → 结果输出

对应《项目安排》第 4 周「把 SR-4 的整个流程打通」，并在此验证甲方指标
「满节点负荷仿真规划时间 ≤ 5 分钟」（《技术参考》(7)）。跑法：

    python3 -m planning.sr4_flow                   # 全部任务
    python3 -m planning.sr4_flow TS-0002           # 指定任务场景
    python3 -m planning.sr4_flow --whatif-expand   # 假设按缺口扩容频率池（待办 #17）
"""
import csv
import copy
import math
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
SURVIVABILITY_SCOPES = ("NETWORK", "TASK")

# 假设扩容（待办 #17）：**不是**可用资源，只回答「按缺口补齐后方案能否无冲突」。
# 第 4 周频率分配报出的缺口（精确最大团）：短波是整个可用频段 3.2–11.8 MHz
# 41 个频点对 43 个两两互扰的网，缺 2 个、位置不限；超短波是 466–507 MHz 段
# 6 个频点对 12 个网，缺 6 个。这里恰好补这么多：短波两个取低端相邻频点的正中
# （3195.7/3391.3、3391.3/3587.0），超短波六个均匀插在该段现有六个频点之间。
# 能否真的增配须合作方确认，确认前**不得写进频率资源表**，只能经本开关临时叠加。
WHATIF_EXTRA_CHANNELS = [(E.HF, 3293.5), (E.HF, 3489.1)] + [
    (E.VUHF, round(465906.2 + k * (506635.4 - 465906.2) / 7.0, 1)) for k in range(1, 7)]


def whatif_rows(channels=WHATIF_EXTRA_CHANNELS):
    """把假设频点落成频率资源表的行，字段口径与 gen_test_data.gen_freq_pool 一致。"""
    rows = []
    for k, (band, fc) in enumerate(channels, start=1):
        hf = band == E.HF
        rows.append(dict(freq_id="FQ-W%03d" % k, device_class=band, center_freq_khz=fc,
                         bandwidth_khz=3 if hf else 25, channel_no="",
                         is_available="true", occupied_by="",
                         reuse_min_distance_m=60000 if hf else 25000,
                         adjacent_guard_khz=3 if hf else 25,
                         note="假设扩容-待合作方确认"))
    return rows


def load(rel):
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _endpoint_device_requests(links, demands, routes):
    """把设备级通联端点映射到已规划主路由的首末链路。"""
    by_link = {link["link_id"]: link for link in links}
    by_demand = {row["demand_id"]: row for row in demands or []}
    requests = []
    for route in (routes or {}).get("routes", []):
        demand = by_demand.get(route["demand_id"])
        primary = route.get("primary")
        if demand is None or not route.get("reachable") or not primary:
            continue
        path = primary.get("link_path") or []
        if not path:
            continue
        for node_key, device_key, link_id in (
                ("src_node_id", "source_device_id", path[0]),
                ("dst_node_id", "target_device_id", path[-1])):
            did = demand.get(device_key)
            if not did:
                continue
            link = by_link.get(link_id)
            if link is not None:
                requests.append((route["demand_id"], link, demand[node_key], did))
    return requests


def bind_links_to_devices(links, nodes, devices, models, demands=None, routes=None):
    """按网系冻结链路两端的物理电台，同一设备不跨网系复用。"""
    model_band = {row["model_id"]: row["device_class"] for row in models}
    by_station = {}
    for device in devices:
        band = model_band.get(device.get("model_id"))
        if band:
            by_station.setdefault((device["node_id"], band), []).append(device["device_id"])
    for values in by_station.values():
        values.sort()
    net_of = {link_id: task.task_id
              for task in FQ.tasks_from_nets(links, nodes)
              for link_id in task.members}
    needed = {}
    for link in links:
        net_id = net_of.get(link["link_id"])
        if net_id is None:
            continue
        for node_id in (link["node_a_id"], link["node_b_id"]):
            needed.setdefault((node_id, link["device_class"]), set()).add(net_id)
    bindings = {}
    errors = []
    preferred = {}
    for demand_id, link, node_id, did in _endpoint_device_requests(
            links, demands, routes):
        net_id = net_of.get(link["link_id"])
        key = (node_id, link["device_class"])
        if node_id not in (link["node_a_id"], link["node_b_id"]) or net_id is None:
            errors.append("需求 %s 的指定设备不在主路由端点" % demand_id)
            continue
        old = preferred.get((key, net_id))
        if old is not None and old != did:
            errors.append("需求 %s 的网系端点指定了不同设备" % demand_id)
        preferred[(key, net_id)] = did
    for key, nets in sorted(needed.items()):
        available = by_station.get(key, [])
        if len(nets) > len(available):
            errors.append("%s %s 需 %d 台、仅有 %d 台" %
                          (key[0], key[1], len(nets), len(available)))
        used = set()
        for net_id in sorted(nets):
            requested = preferred.get((key, net_id))
            if requested is None:
                continue
            if requested not in available or requested in used:
                errors.append("%s %s 的指定设备 %s 不可绑定网系 %s" %
                              (key[0], key[1], requested, net_id))
                continue
            bindings[(key, net_id)] = requested
            used.add(requested)
        remaining = iter(did for did in available if did not in used)
        for net_id in sorted(nets):
            if (key, net_id) not in bindings and (key, net_id) not in preferred:
                device_id = next(remaining, None)
                if device_id is not None:
                    bindings[(key, net_id)] = device_id
    for link in links:
        net_id = net_of.get(link["link_id"])
        if net_id is None:
            continue
        band = link["device_class"]
        link["device_a_id"] = bindings.get(((link["node_a_id"], band), net_id), "")
        link["device_b_id"] = bindings.get(((link["node_b_id"], band), net_id), "")
    return errors


def endpoint_binding_errors(links, demands, routes):
    errors = []
    for demand_id, link, node_id, did in _endpoint_device_requests(
            links, demands, routes):
        if node_id not in (link["node_a_id"], link["node_b_id"]):
            errors.append("需求 %s 的主路由端点不属于指定台站" % demand_id)
            continue
        side = "a" if link["node_a_id"] == node_id else "b"
        if link.get("device_%s_id" % side) != did:
            errors.append("需求 %s 的主路由端点未使用指定设备 %s" % (demand_id, did))
    return errors


def _fixed_topology_metrics(links, demands, routes, params, constraints):
    """按调整后的可用链路复算连通率、抗毁性及实际辐射功率。"""
    nodes = {d["src_node_id"] for d in demands} | {d["dst_node_id"] for d in demands}
    edges = []
    required_margin = params["fade_margin_db"]
    for link in links:
        if (str(link.get("is_available", "true")).lower() == "false"
                or float(link["link_margin_db"]) < required_margin):
            continue
        a, b = link["node_a_id"], link["node_b_id"]
        nodes.update((a, b))
        edges.append((a, b))
    adjacency = {node: [] for node in nodes}
    for edge_id, (a, b) in enumerate(edges):
        adjacency[a].append((b, edge_id))
        adjacency[b].append((a, edge_id))
    bridges, tin, tout, component = MO._bridges_and_times(sorted(nodes), adjacency)
    connected = lambda d: component.get(d["src_node_id"]) == component.get(d["dst_node_id"])
    mandatory = [d for d in demands if str(d.get("is_mandatory", "false")).lower() == "true"]
    mandatory_ok = [d for d in mandatory if connected(d)]
    connectivity = sum(connected(d) for d in demands) / max(1, len(demands))
    mandatory_connectivity = len(mandatory_ok) / max(1, len(mandatory))
    survivability = 1.0 if not mandatory else mandatory_connectivity
    for _u, v in bridges:
        low, high = tin[v], tout[v]
        separated = sum(
            (low <= tin[d["src_node_id"]] <= high)
            != (low <= tin[d["dst_node_id"]] <= high)
            for d in mandatory_ok if component[d["src_node_id"]] == component[v]
        )
        survivability = min(survivability,
                             (len(mandatory_ok) - separated) / max(1, len(mandatory)))
    routed = [row["primary"] for row in routes["routes"] if row.get("reachable")]
    relay_hops = max((max(0, len(row["node_path"]) - 2) for row in routed), default=0)
    power_w = params["summary"]["total_radiated_w"]
    checks = {
        "mandatory_e2e_connectivity": {
            "value": round(mandatory_connectivity, 4),
            "required": constraints["mandatory_e2e_connectivity"],
            "pass": mandatory_connectivity >= constraints["mandatory_e2e_connectivity"] - 1e-9,
        },
        "survivability": {
            "value": round(survivability, 4),
            "required": constraints["survivability_threshold"],
            "pass": survivability >= constraints["survivability_threshold"] - 1e-9,
        },
        "max_relay_hops": {
            "value": relay_hops, "required": constraints["max_relay_hops"],
            "pass": relay_hops <= constraints["max_relay_hops"],
        },
    }
    objectives = {
        "e2e_connectivity": round(connectivity, 4),
        "survivability": round(survivability, 4),
        "total_radiated_power_w": power_w,
        "total_radiated_power_dbm": round(10 * math.log10(max(power_w, 1e-9) * 1000), 2),
    }
    return objectives, checks, len(edges)


def run_from_parent(parent_snapshot, adjustment, device_refs, task_id, demand_rows,
                    preset="TERRAIN", strategy="MAX_RELIABILITY", constraints=None,
                    interference_rows=None, progress=None):
    """固定父方案拓扑，重算人工调整后的下游规划结果。"""
    started = time.time()
    detail = parent_snapshot["detail"]
    nodes = copy.deepcopy(detail["nodes"])
    devices = copy.deepcopy(detail["devices"])
    links = copy.deepcopy(detail["links"])
    terrain = default_terrain(verbose=False)
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    pool_rows, metrics_rows = load("frequency_resource.csv"), load("link_metric.csv")
    jam_rows = (load("interference_source.csv") if interference_rows is None
                else [dict(row) for row in interference_rows])
    cand_rows = load("candidate_site.csv")
    original_demands = load("comm_demand.csv")
    replacements = {row["demand_id"]: dict(row) for row in demand_rows}
    demand_ids = {row["demand_id"] for row in original_demands}
    all_demands = [replacements.get(row["demand_id"], row) for row in original_demands]
    all_demands.extend(row for demand_id, row in replacements.items()
                       if demand_id not in demand_ids)
    if progress:
        progress(0.20, "父方案拓扑已加载")

    stations = stations_from_nodes(nodes, devices, models, antennas)
    caps = RP.capabilities_by_device(stations, devices, models, antennas)
    permitted = {row["device_id"] for row in device_refs}
    if any(row["device_id"] not in permitted for row in adjustment["manual_override"]):
        raise ValueError("人工调整包含父方案之外的物理设备")
    parent_best = detail["optimization"]["best"]
    params = RP.plan_bound_devices(
        stations, links, devices, models, antennas, terrain,
        preset=preset, fade_margin_db=parent_best["fade_margin_db"],
        manual_override=adjustment["manual_override"])
    if params["manual_errors"]:
        raise ValueError("人工设备参数无效：" + "；".join(params["manual_errors"]))
    actual_margins = {row["link_id"]: row["margin_db"] for row in params["links"]}
    for link in links:
        margin = actual_margins.get(link["link_id"])
        if margin is not None:
            link["link_margin_db"] = margin
    if progress:
        progress(0.45, "电台参数与链路余量已重算")

    graph = routing.graph_from_links(links, metrics_rows)[0]
    routes = routing.plan_routes(graph, demand_rows, default_strategy=strategy,
                                 manual_paths=adjustment["manual_paths"])
    invalid_paths = [row for row in routes["routes"] if row.get("manual_errors")]
    if invalid_paths:
        raise ValueError("人工路径不可用：" + "；".join(
            str(error) for row in invalid_paths for error in row["manual_errors"]
        ))
    device_path_errors = endpoint_binding_errors(links, demand_rows, routes)
    if device_path_errors:
        raise ValueError("；".join(device_path_errors))
    ftasks = FQ.tasks_from_nets(links, nodes, devices, models)
    FQ.fill_ranges_by_node(ftasks, links, nodes, devices, models)
    frequency = FQ.assign(ftasks, FQ.FreqPool(pool_rows))
    frequency["link_assignments"] = FQ.expand_to_links(frequency, ftasks)
    check = plan_check.check(freq_result=frequency, freq_tasks=ftasks,
                            param_result=params, route_result=routes,
                            links=links, nodes=nodes, caps=caps,
                            devices=devices, models=models)
    if progress:
        progress(0.75, "路由、频率及方案校验已重算")

    required = dict(MO.DEFAULT_CONSTRAINTS)
    required.update(constraints or {})
    objectives, constraint_check, usable_count = _fixed_topology_metrics(
        links, all_demands, routes, params, required
    )
    optimization = copy.deepcopy(detail["optimization"])
    optimization["best"]["objectives"] = objectives
    optimization["best"]["constraint_check"] = constraint_check
    optimization["best"]["links_usable"] = usable_count
    optimization["tradeoff"] = []
    optimization["feasible"] = (all(item["pass"] for item in constraint_check.values())
                                and check["passed"])
    if optimization["feasible"]:
        optimization["infeasible"] = None
    else:
        optimization["infeasible"] = {
            "conflicting_constraints": [key for key, item in constraint_check.items()
                                        if not item["pass"]],
            "suggestions": ["调整人工设备参数或主路径后重新计算"],
        }
    scenario = IF.scenario_from_plan(dict(
        stations=stations, links=links, terrain=terrain,
        frequency=frequency, freq_tasks=ftasks, params=params,
        devices=devices, models=models, antennas=antennas,
    ), jam_rows)
    analysis = IF.analyze(scenario, area=True, area_cell_m=3000.0)
    measures, unresolved, review = IF.recommend(
        scenario, analysis, freq_ctx=IF.FreqContext(ftasks, frequency["assignments"]),
        caps=caps, route_ctx=(graph, routes), candidate_rows=cand_rows,
    )
    if progress:
        progress(0.95, "干扰分析已重算")
    elapsed = time.time() - started
    return dict(
        task_id=task_id, steps=[("固定父方案拓扑并重算", elapsed)],
        total_s=elapsed, within_limit=elapsed <= TIME_LIMIT_S,
        optimization=optimization, routes=routes, frequency=frequency,
        params=params, check=check,
        interference=dict(analysis={key: value for key, value in analysis.items()
                                    if key != "_states"},
                          countermeasures=measures, unresolved=unresolved, review=review),
        links=links, nodes=nodes, devices=devices,
    )


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
        constraints=None, pop_size=40, generations=40, verbose=True,
        survivability_scope="NETWORK", extra_freq_rows=None, interference_rows=None,
        progress=None, demand_rows=None):
    """survivability_scope：抗毁性约束按全网（NETWORK，默认）还是按本任务（TASK）评估。

    默认按全网（待办 #20 的处理）：网络是各任务共用的，抗毁性是网络的属性；
    指定任务时另给出任务视角的连通率与抗毁性作参考。

    extra_freq_rows：临时叠加到频率资源池的行（如 `whatif_rows()`），不写回数据文件。
    结果里 `frequency_pool_extra` 记下叠加了哪些，避免把假设当成现有资源的结论。
    """
    if survivability_scope not in SURVIVABILITY_SCOPES:
        raise ValueError("survivability_scope 只能取 %s，收到 %r"
                         % (" / ".join(SURVIVABILITY_SCOPES), survivability_scope))
    extra_freq_rows = list(extra_freq_rows or [])
    steps = []
    T = time.time()

    # ── 1 任务条件输入 ──
    t0 = time.time()
    terrain = default_terrain(verbose=False)
    nodes, devices = load("node.csv"), load("device.csv")
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    demands_all = load("comm_demand.csv")
    if demand_rows is not None:
        replacements = {row["demand_id"]: dict(row) for row in demand_rows}
        original_ids = {row["demand_id"] for row in demands_all}
        demands_all = [replacements.get(row["demand_id"], row) for row in demands_all]
        # 数据库新建任务可使用自定义需求编号，不能只替换 CSV 中的既有需求。
        demands_all.extend(row for demand_id, row in replacements.items()
                           if demand_id not in original_ids)
    demands = [d for d in demands_all if task_id is None or d["task_id"] == task_id]
    if not demands:
        raise ValueError("任务 %s 没有通联需求" % task_id)
    pool_rows, jam_rows = load("frequency_resource.csv"), load("interference_source.csv")
    if interference_rows is not None:
        jam_rows = [dict(row) for row in interference_rows]
    pool_rows = pool_rows + extra_freq_rows
    metrics_rows, cand_rows = load("link_metric.csv"), load("candidate_site.csv")
    stations = stations_from_nodes(nodes, devices, models, antennas)
    steps.append(("1 任务条件输入（需求 %d 条）" % len(demands), time.time() - t0))
    if progress:
        progress(0.15, "任务与资源已加载")

    # ── 2 电台部署（第 2 周 P1）──
    t0 = time.time()
    fm, sol, links0, nodes1, devices1 = topology_from_deployment(
        stations, terrain, nodes, devices, models, cand_rows)
    steps.append(("2 电台部署（新增 %d 台）" % len(sol.added), time.time() - t0))
    if progress:
        progress(0.30, "电台部署完成")

    # ── 3 路由 + 频率 + 功率（第 3 周，在部署拓扑上）──
    t0 = time.time()
    st1 = stations + [fm.stations[i] for i, _s in sol.added]
    caps1 = RP.capabilities_from_tables(st1, devices1, models, antennas)
    params1 = RP.plan(st1, RP.topo_from_links(st1, links0), caps1, terrain, preset=preset)
    steps.append(("3 初始功率配置", time.time() - t0))
    if progress:
        progress(0.40, "初始参数配置完成")

    # ── 4 方案优化（第 4 周 NSGA-II）──
    t0 = time.time()
    cons = dict(MO.DEFAULT_CONSTRAINTS)
    cons.update(constraints or {})
    opt_demands = demands if (task_id is None or survivability_scope == "TASK") else demands_all
    pb = MO.Problem(fm, sol, opt_demands, caps1,
                    survivability_threshold=cons["survivability_threshold"])
    opt = MO.optimize(pb, constraints=cons, pop_size=pop_size, generations=generations)
    best = opt["solutions"][0]
    steps.append(("4 多目标优化（评估 %d 次）" % opt["evaluations"], time.time() - t0))
    if progress:
        progress(0.70, "多目标优化完成")

    # ── 5 闭环：在优化后的拓扑上重做路由、频率、功率 ──
    t0 = time.time()
    links, nodes2, devices2 = rows_from_solution(pb, best, nodes1, devices1, models)
    st2 = st1 + [fm.stations[i] for i in best["relays"]]
    g = routing.graph_from_links(links, metrics_rows)[0]
    routes = routing.plan_routes(g, demands, default_strategy=strategy)
    binding_errors = bind_links_to_devices(
        links, nodes2, devices2, models, demands=demands, routes=routes)
    ftasks = FQ.tasks_from_nets(links, nodes2, devices2, models)
    FQ.fill_ranges_by_node(ftasks, links, nodes2, devices2, models)
    freq = FQ.assign(ftasks, FQ.FreqPool(pool_rows))
    freq["link_assignments"] = FQ.expand_to_links(freq, ftasks)
    caps2 = RP.capabilities_by_device(st2, devices2, models, antennas)
    params = RP.plan_bound_devices(st2, links, devices2, models, antennas,
                                   terrain, preset=preset,
                                   fade_margin_db=best["m_req"])
    binding_errors.extend(params["manual_errors"])
    margins = {row["link_id"]: row["margin_db"] for row in params["links"]}
    for link in links:
        if link["link_id"] in margins:
            link["link_margin_db"] = margins[link["link_id"]]
    # 设备端点需求保持首次求出的物理端点，其他需求按实际余量重新选路。
    fixed_paths = [dict(demand_id=row["demand_id"],
                        node_path=route["primary"]["node_path"])
                   for row in demands for route in routes["routes"]
                   if route["demand_id"] == row["demand_id"] and route.get("reachable")
                   and (row.get("source_device_id") or row.get("target_device_id"))]
    g = routing.graph_from_links(links, metrics_rows)[0]
    routes = routing.plan_routes(g, demands, default_strategy=strategy,
                                 manual_paths=fixed_paths)
    binding_errors.extend(endpoint_binding_errors(links, demands, routes))
    chk = plan_check.check(freq_result=freq, freq_tasks=ftasks, param_result=params,
                           route_result=routes, links=links, nodes=nodes2, caps=caps2,
                           devices=devices2, models=models,
                           uplinks={fm.stations[c].sid: fm.stations[p].sid
                                    for c, p in best["uplinks"].items()})
    steps.append(("5 优化后重做路由/频率/功率/校验", time.time() - t0))
    if progress:
        progress(0.85, "路由、频率与方案校验完成")

    # ── 6 干扰分析 ──
    t0 = time.time()
    plan = dict(stations=st2, links=links, terrain=terrain, frequency=freq,
                freq_tasks=ftasks, params=params, devices=devices2,
                models=models, antennas=antennas)
    sc = IF.scenario_from_plan(plan, jam_rows)
    ana = IF.analyze(sc, area=True, area_cell_m=3000.0)
    cms, unresolved, review = IF.recommend(
        sc, ana, freq_ctx=IF.FreqContext(ftasks, freq["assignments"]), caps=caps2,
        route_ctx=(g, routes), candidate_rows=cand_rows)
    steps.append(("6 干扰分析与抗干扰推荐", time.time() - t0))
    if progress:
        progress(0.95, "干扰分析完成，正在保存方案")

    total = time.time() - T
    objectives, constraint_check, usable_count = _fixed_topology_metrics(
        links, opt_demands, routes, params, cons)
    described = MO.describe(pb, best, opt["constraints"], rank=1)
    described["objectives"] = objectives
    described["constraint_check"] = constraint_check
    described["links_usable"] = usable_count
    failed_constraints = [key for key, row in constraint_check.items()
                          if not row["pass"]]
    if not chk["passed"]:
        failed_constraints.append("plan_check")
    if binding_errors:
        failed_constraints.append("device_binding")
    feasible = not failed_constraints
    out = dict(task_id=task_id, steps=steps, total_s=total, within_limit=total <= TIME_LIMIT_S,
               deployment=dict(added=[fm.stations[i].sid for i, _s in sol.added]),
               optimization=dict(feasible=feasible,
                                 infeasible=(None if feasible else {
                                     "conflicting_constraints": failed_constraints,
                                     "suggestions": binding_errors or
                                         ["调整设备或链路后重新计算"],
                                 }),
                                 survivability_scope=("TASK" if task_id and survivability_scope == "TASK"
                                                      else "NETWORK"),
                                 task_view=(MO.subset_view(pb, best, [d["demand_id"] for d in demands])
                                            if task_id else None),
                                 best=described,
                                 tradeoff=[MO.describe(pb, e, opt["constraints"])
                                           for e in opt["tradeoff"]]),
               routes=routes, frequency=freq, params=params, check=chk,
               frequency_pool_extra=[dict(freq_id=r["freq_id"], band=r["device_class"],
                                          freq_khz=float(r["center_freq_khz"]), note=r.get("note", ""))
                                     for r in extra_freq_rows],
               interference=dict(analysis={k: v for k, v in ana.items() if k != "_states"},
                                 countermeasures=cms, unresolved=unresolved, review=review),
               links=links, nodes=nodes2, devices=devices2)
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
    tv = o["optimization"].get("task_view")
    if tv:
        print("  任务视角（参考）：必要通联 %d 条，连通率 %.3f，抗毁性 %.3f"
              % (tv["mandatory"], tv["mandatory_connectivity"], tv["survivability"]))
    if o["optimization"]["infeasible"]:
        for r in o["optimization"]["infeasible"]["conflicting_constraints"]:
            print("  冲突：%s" % r)

    rs = o["routes"]["routes"]
    ok = [r for r in rs if r["reachable"]]
    print("\n▎路由（优化后拓扑）  可达 %d/%d，有备用 %d 条"
          % (len(ok), len(rs), sum(1 for r in ok if r.get("backup"))))
    f = o["frequency"]
    ext = o.get("frequency_pool_extra") or []
    if ext:
        print("▎频率池  **含假设扩容 %d 个频点（待合作方确认，不是现有资源）**" % len(ext))
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
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    run(task_id=args[0] if args else None,
        extra_freq_rows=whatif_rows() if "--whatif-expand" in sys.argv else None)
