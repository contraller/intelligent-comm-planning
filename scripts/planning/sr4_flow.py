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
from collections import Counter
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from datapaths import path as dpath
from terrain import DemTerrain, default_terrain, haversine_m
from feasibility import stations_from_nodes
import routing
import frequency as FQ
import radio_params as RP
import plan_check
import multi_objective as MO
import interference as IF
import deployment_inputs as DI
from plan_pipeline import (topology_from_deployment, alternative_parent_solutions,
                           _representative_device)

TIME_LIMIT_S = 300.0
SURVIVABILITY_SCOPES = ("NETWORK", "TASK")


def _runtime_callbacks(start, callback):
    """所有阶段共享期限；长循环的检查点也检查服务层取消请求。"""
    current = [0.1, "任务条件输入"]
    last_update = float("-inf")

    def checkpoint():
        nonlocal last_update
        now = time.monotonic()
        if now >= start + TIME_LIMIT_S:
            raise TimeoutError(
                "规划计算超过%d秒时间预算，尚未获得满足条件的完整规划结果；"
                "本次超时不表示已证明无解，请调整任务或约束后重新提交" % TIME_LIMIT_S)
        if callback and now - last_update >= 0.5:
            last_update = now
            callback(*current)
        return True

    def report(value, stage):
        nonlocal last_update
        current[:] = [value, stage]
        last_update = time.monotonic()
        checkpoint()
        if callback:
            callback(value, stage)

    return checkpoint, report

# 历史临时扩容已进入带来源标记的构造资源池；保留显式传参的假设试验入口。
WHATIF_EXTRA_CHANNELS = ()


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


def _resource_reader(resource_rows):
    if resource_rows is None:
        return load
    # 已冻结的输入缺表时直接失败，禁止夹杂当前磁盘文件。
    def read(name):
        if not isinstance(resource_rows, dict) or name not in resource_rows or not isinstance(resource_rows[name], list):
            raise ValueError("冻结资源缺少输入表：" + name)
        return copy.deepcopy(resource_rows[name])
    return read


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


def bind_links_to_devices(links, nodes, devices, models, demands=None, routes=None, *,
                          pool_rows=None, checkpoint=None):
    """按网系冻结链路两端的物理电台，同一设备不跨网系复用。"""
    model_band = {row["model_id"]: row["device_class"] for row in models}
    by_station = {}
    for device in devices:
        if device.get("availability", "ACTIVE") != "ACTIVE":
            continue
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
    if pool_rows is not None and not errors:
        from actual_search import improve_bindings
        improve_bindings(links, nodes, devices, models, pool_rows,
                         locked={(key[0], key[1], net_id) for key, net_id in preferred}, checkpoint=checkpoint)
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


def _actual_link_margins(stations, links, terrain, frequency, ftasks, params,
                         devices, models, antennas, jam_rows, caps, checkpoint=None):
    """父候选与冻结子方案共用实际频点/物理设备口径，不回退代表频点。"""
    assigned = {row["link_id"]: row.get("freq_khz")
                for row in frequency["link_assignments"]}
    parameter_links = {row["link_id"]: row for row in params["links"]}
    live = [row for row in links if row["link_id"] in parameter_links
            and str(row.get("is_available", "true")).lower() != "false"
            and assigned.get(row["link_id"]) is not None]
    if any(not math.isfinite(float(assigned[row["link_id"]]))
           or float(assigned[row["link_id"]]) <= 0 for row in live):
        raise ValueError("实际分配频点必须为有限正数")
    scenario = IF.scenario_from_plan(dict(stations=stations, links=live, terrain=terrain,
        frequency=frequency, freq_tasks=ftasks, params=params, devices=devices,
        models=models, antennas=antennas), jam_rows, checkpoint=checkpoint)
    if {row.link_id for row in scenario.links} != {row["link_id"] for row in live}:
        raise ValueError("实际频点校验未覆盖全部已绑定物理链路")
    states = {}
    for link in scenario.links:
        state = scenario.link_state(link)
        states[link.link_id] = state
        row = parameter_links[link.link_id]
        row.update(freq_khz=link.f, path_loss_db=round(scenario._signal_pl(link), 2),
            margin_before_interference_db=state["margin_before"], margin_db=state["margin_after"],
            meets=state["margin_after"] >= row["required_margin_db"] - 1e-6)
        # 同频点、同干扰下核验最大功率余量；只改临时场景，不改设备实际配置。
        actual_tx = link.tx
        try:
            link.tx = {sid: caps[did].tx_max for sid, did in link.device.items()}
            row["margin_at_max_power_db"] = scenario.link_state(link)["margin_after"]
        finally:
            link.tx = actual_tx
    for row in params["links"]:
        if row["link_id"] not in states:
            row.update(freq_khz=None, path_loss_db=None, margin_before_interference_db=None,
                margin_db=-999.0, margin_at_max_power_db=None, meets=False)
    for link in links:
        if str(link.get("is_available", "true")).lower() != "false":
            link["link_margin_db"] = states[link["link_id"]]["margin_after"] if link["link_id"] in states else -999.0
    params["failed_links"] = [row for row in params["links"] if not row["meets"]]
    params["summary"].update(failed=len(params["failed_links"]),
        min_margin_db=min((row["margin_db"] for row in params["links"]), default=0.0))
    params["margin_basis"] = "ASSIGNED_FREQUENCY_WITH_INTERFERENCE"
    return scenario


def _frozen_uplinks(detail):
    """仅消费真实冻结上行；旧III借道快照不能靠备份标记猜补。"""
    nodes = {row["node_id"]: row for row in detail["nodes"]}
    links = [row for row in detail["links"]
             if str(row.get("is_available", "true")).lower() != "false"]
    uplinks = detail["optimization"].get("uplinks")
    if uplinks is None:
        if any(E.is_peer_pair(nodes[row["node_a_id"]].get("node_subtype"),
                              nodes[row["node_b_id"]].get("node_subtype")) for row in links):
            raise ValueError("父方案缺少已冻结的主上行关系，请重新规划后调整")
        return {}
    if not isinstance(uplinks, dict):
        raise ValueError("冻结主上行关系必须为节点映射")
    edges = {frozenset((row["node_a_id"], row["node_b_id"])) for row in links}
    for child, parent in uplinks.items():
        if (not isinstance(child, str) or not isinstance(parent, str) or child == parent
                or child not in nodes or parent not in nodes
                or frozenset((child, parent)) not in edges):
            raise ValueError("冻结主上行关系未精确关联拓扑节点和物理链路")
    for child in uplinks:
        seen, current = set(), child
        while current in uplinks:
            if current in seen:
                raise ValueError("冻结主上行关系包含环路")
            seen.add(current)
            current = uplinks[current]
    return dict(uplinks)


def _check_candidate(pb, solution, stations, nodes, devices, models, antennas,
                     terrain, demands, opt_demands, strategy, preset, pool_rows,
                     metrics_rows, constraints, *, interference_rows=None,
                     channel_preference=None, optimize_bindings=False, search_checkpoint=None,
                     channel_admissible=None, radio_anchor=None):
    """用实际设备、频点和链路余量复核优化器给出的拓扑。"""
    fm = pb.fm
    links, nodes2, devices2 = rows_from_solution(pb, solution, nodes, devices, models)
    st2 = stations + [fm.stations[i] for i in solution["relays"]]
    graph = routing.graph_from_links(links, metrics_rows)[0]
    routes = routing.plan_routes(graph, demands, default_strategy=strategy)
    if radio_anchor is None:
        binding_errors = bind_links_to_devices(
            links, nodes2, devices2, models, demands=demands, routes=routes,
            pool_rows=pool_rows if optimize_bindings else None, checkpoint=search_checkpoint)
    else:
        # 仅允许删边候选继承已核验绑定；换父/加边必须重新规划，不可借此绕过校验。
        key = lambda row: (frozenset((row["node_a_id"], row["node_b_id"])), row["device_class"])
        previous = {key(row): row for row in radio_anchor["links"]}
        if not Counter(key(row) for row in links) <= Counter(key(row) for row in radio_anchor["links"]):
            raise ValueError("保留射频配置只允许已核验拓扑的删边子集")
        for row in links:
            old = previous[key(row)]
            device_of = {old["node_a_id"]: old["device_a_id"], old["node_b_id"]: old["device_b_id"]}
            for side in ("a", "b"):
                row["device_%s_id" % side] = device_of[row["node_%s_id" % side]]
        binding_errors = []
        routes = radio_anchor["routes"]
    ftasks = FQ.tasks_from_nets(links, nodes2, devices2, models)
    FQ.fill_ranges_by_node(ftasks, links, nodes2, devices2, models)
    original_channels = ({row["task_id"]: row for row in radio_anchor["frequency"]["assignments"]}
                         if radio_anchor is not None else {})
    locks = [{"link_id": task.task_id, "freq_khz": original_channels[task.task_id]["freq_khz"]}
             for task in ftasks if original_channels.get(task.task_id, {}).get("freq_khz") is not None]
    frequency_args = {"channel_preference": channel_preference}
    if channel_admissible is not None:
        frequency_args["channel_admissible"] = channel_admissible
    freq = FQ.assign(ftasks, FQ.FreqPool(pool_rows), manual=locks or None, **frequency_args)
    if radio_anchor is not None:
        for row in freq["assignments"]:
            row["manual"] = original_channels[row["task_id"]]["manual"]
        freq["assignment_basis"] = "VERIFIED_PRUNING_SUBSET"
    freq["link_assignments"] = FQ.expand_to_links(freq, ftasks)
    caps = RP.capabilities_by_device(st2, devices2, models, antennas)
    params = RP.plan_bound_devices(st2, links, devices2, models, antennas,
                                   terrain, preset=preset,
                                   fade_margin_db=solution["m_req"],
                                   frequency_by_link={row["link_id"]: row["freq_khz"] for row in freq["link_assignments"]},
                                   interference_rows=[] if interference_rows is None else interference_rows,
                                   checkpoint=getattr(fm, "checkpoint", None))
    binding_errors.extend(params["manual_errors"])
    scenario = _actual_link_margins(st2, links, terrain, freq, ftasks, params,
        devices2, models, antennas, [] if interference_rows is None else interference_rows, caps,
        checkpoint=getattr(fm, "checkpoint", None))
    fixed_paths = [dict(demand_id=row["demand_id"],
                        node_path=route["primary"]["node_path"])
                   for row in demands for route in routes["routes"]
                   if route["demand_id"] == row["demand_id"] and route.get("reachable")
                   and (row.get("source_device_id") or row.get("target_device_id"))]
    # 原拓扑保留审计；最终主路由只能使用实际达到本候选余量门槛的边。
    route_links = [row for row in links
                   if float(row["link_margin_db"]) >= params["fade_margin_db"]]
    graph = routing.graph_from_links(route_links, metrics_rows)[0]
    routes = routing.plan_routes(graph, demands, default_strategy=strategy,
                                 manual_paths=fixed_paths)
    binding_errors.extend(endpoint_binding_errors(links, demands, routes))
    uplinks = {fm.stations[c].sid: fm.stations[p].sid for c, p in solution["uplinks"].items()}
    _frozen_uplinks(dict(nodes=nodes2, links=links, optimization={"uplinks": uplinks}))
    chk = plan_check.check(freq_result=freq, freq_tasks=ftasks, param_result=params,
                           route_result=routes, links=links, nodes=nodes2, caps=caps,
                           devices=devices2, models=models,
                           uplinks=uplinks)
    objectives, checks, usable = _fixed_topology_metrics(
        links, opt_demands, routes, params, constraints)
    score = _candidate_score(objectives, checks, chk, binding_errors, constraints)
    return dict(score=score, stations=st2, links=links, nodes=nodes2, devices=devices2,
                graph=graph, routes=routes, binding_errors=binding_errors,
                ftasks=ftasks, frequency=freq, caps=caps, params=params, check=chk,
                objectives=objectives, constraint_check=checks, usable_count=usable,
                uplinks=uplinks, scenario=scenario)


def _candidate_signature(solution, radio_anchor=None):
    """同拓扑不同射频锚点必须分别核验，不能把未锚定失败当成锚定结果。"""
    anchor = None
    if radio_anchor is not None:
        anchor = (tuple(sorted((row["task_id"], row.get("freq_khz"))
                               for row in radio_anchor["frequency"]["assignments"])),
                  tuple(sorted((row["node_a_id"], row["node_b_id"], row["device_class"],
                                row["device_a_id"], row["device_b_id"]) for row in radio_anchor["links"])),
                  tuple(sorted((row["demand_id"], tuple(row["primary"]["node_path"]))
                               for row in radio_anchor["routes"]["routes"] if row.get("reachable"))))
    return (tuple(sorted((min(a, b), max(a, b), band) for a, b, band in solution["links"])),
            solution["m_req"], tuple(sorted(solution["uplinks"].items())), anchor)


def _candidate_score(objectives, checks, check_result, binding_errors, constraints):
    """完整校验优先；无可行解时按硬约束缺口和冲突数排序。"""
    feasible = (all(row["pass"] for row in checks.values())
                and check_result["passed"] and not binding_errors)
    return (int(not feasible),
            max(0.0, constraints["mandatory_e2e_connectivity"]
                - checks["mandatory_e2e_connectivity"]["value"]),
            max(0.0, constraints["survivability_threshold"]
                - checks["survivability"]["value"]),
            max(0, checks["max_relay_hops"]["value"]
                - constraints["max_relay_hops"]),
            check_result["summary"]["severe"] + len(binding_errors),
            check_result["summary"]["moderate"],
            -objectives["e2e_connectivity"], objectives["total_radiated_power_w"])


def constrained_frequency_rows(rows, frequency_constraints=None):
    """两类独立派生可用池，原始冻结行不改写；空集合不回退。"""
    filters = {row["device_class"]: row for row in (frequency_constraints or {}).get("filters", [])}
    ids = set()
    for band in (E.HF, E.VUHF):
        selected = filters.get(band, {})
        pool = FQ.FreqPool(rows, device_class=band,
            freq_range_khz=selected.get("range_khz"),
            exclude_freq_ids=selected.get("exclude_freq_ids", []))
        ids.update(row["freq_id"] for row in pool.channels)
    return [copy.deepcopy(row) for row in rows if row["freq_id"] in ids]


def _frozen_frequency_locks(detail, tasks, pool_rows, change):
    FQ._prepare(tasks, FQ.FreqPool(pool_rows))
    parent = {row["task_id"]: row for row in detail["frequency"]["assignments"]}
    if len(parent) != len(detail["frequency"]["assignments"]):
        raise ValueError("冻结网系频点编号重复")
    locks = []
    for task in tasks:
        if task.task_id not in parent:
            raise ValueError("父方案缺少网系实际频点：" + task.task_id)
        frequency = float(parent[task.task_id]["freq_khz"])
        if change["type"] in ("FREQ_ADJUST", "CHANNEL_SWITCH") and task.task_id == change["target"]["net_id"]:
            frequency = float(change["detail"]["to_freq_khz"])
        if not any(abs(row["freq_khz"] - frequency) < 1e-6 for row in task.allowed):
            raise ValueError("冻结/采纳频点不在任务条件与型号共同可用池：" + task.task_id)
        locks.append({"link_id": task.task_id, "freq_khz": frequency})
    return locks


def _apply_frozen_routes(routes, graph_links, metrics_rows, change):
    """按精确物理链路重算主备路径指标，而非复制预览指标。"""
    by_demand = {row["demand_id"]: row for row in routes["routes"]}
    banned = set(change["detail"]["banned_links"])
    for requested in change["detail"]["rerouted"]:
        actual = by_demand[requested["demand_id"]]
        for key in ("primary", "backup"):
            path = requested.get(key)
            if path is None:
                actual[key] = None
                continue
            ids = set(path["link_path"])
            if ids & banned:
                raise ValueError("采纳路径包含排除链路")
            graph = routing.graph_from_links([row for row in graph_links if row["link_id"] in ids], metrics_rows)[0]
            calculated, errors = routing.check_manual_path(graph, path["node_path"])
            if errors or calculated["link_path"] != path["link_path"]:
                raise ValueError("采纳路径未精确关联冻结物理链路")
            actual[key] = calculated
        actual["reachable"] = actual["primary"] is not None
        actual["backup_type"] = requested.get("backup_type", "NONE")
        actual["single_point_risks"] = routing.single_point_risks(
            routing.graph_from_links([row for row in graph_links if row["link_id"] not in banned], metrics_rows)[0],
            actual["primary"]["node_path"][0], actual["primary"]["node_path"][-1], actual["primary"]) if actual["primary"] else []


def run_from_parent(parent_snapshot, adjustment, device_refs, task_id, demand_rows,
                    preset="TERRAIN", strategy="MAX_RELIABILITY", constraints=None,
                    interference_rows=None, progress=None, resource_rows=None):
    """固定父方案拓扑，重算人工调整后的下游规划结果。"""
    started = time.time()
    monotonic_start = time.monotonic()
    parent_checkpoint, progress = _runtime_callbacks(monotonic_start, progress)

    parent_checkpoint()
    read = _resource_reader(resource_rows)
    detail = parent_snapshot["detail"]
    nodes = copy.deepcopy(detail["nodes"])
    devices = copy.deepcopy(detail["devices"])
    links = copy.deepcopy(detail["links"])
    uplinks = _frozen_uplinks(detail)
    binding = adjustment.get("interference")
    change = binding["change_set"] if binding else None
    if binding and (resource_rows is None or interference_rows != binding["sources"]
                    or parent_snapshot["terrain_fingerprint"] != binding["terrain_fingerprint"]):
        raise ValueError("干扰重算缺少精确冻结资源、场景或地形来源")
    inactive = {row["device_id"] for row in read("device.csv") if row.get("availability", "ACTIVE") != "ACTIVE"}
    if any(row["device_id"] in inactive or row.get("availability", "ACTIVE") != "ACTIVE" for row in devices):
        raise ValueError("父方案包含已下架设备，固定拓扑不能静默替换设备")
    terrain = DemTerrain() if binding else default_terrain(verbose=False)
    if change and change["type"] == "NODE_REDEPLOY":
        node = next(row for row in nodes if row["node_id"] == change["target"]["node_id"])
        node.update(lon=change["detail"]["to_lon"], lat=change["detail"]["to_lat"])
        positions = {row["node_id"]: (float(row["lon"]), float(row["lat"])) for row in nodes}
        for link in links:
            if node["node_id"] in (link["node_a_id"], link["node_b_id"]):
                link["distance_m"] = haversine_m(*positions[link["node_a_id"]], *positions[link["node_b_id"]])
    if binding:
        for row in [*nodes, *interference_rows]:
            west, south, east, north = terrain.bbox
            if not west <= float(row["lon"]) <= east or not south <= float(row["lat"]) <= north:
                raise ValueError("冻结/迁移对象超出已核验DEM范围")
    models, antennas = read("device_model.csv"), read("antenna_model.csv")
    pool_rows, metrics_rows = read("frequency_resource.csv"), read("link_metric.csv")
    frequency_constraints = (resource_rows or {}).get("frequency_constraints")
    pool_rows = constrained_frequency_rows(pool_rows, frequency_constraints)
    jam_rows = (read("interference_source.csv") if interference_rows is None
                else [dict(row) for row in interference_rows])
    cand_rows = read("candidate_site.csv")
    original_demands = read("comm_demand.csv")
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
    ftasks = FQ.tasks_from_nets(links, nodes, devices, models)
    FQ.fill_ranges_by_node(ftasks, links, nodes, devices, models)
    locks = _frozen_frequency_locks(detail, ftasks, pool_rows, change) if binding else None
    frequency = FQ.assign(ftasks, FQ.FreqPool(pool_rows), manual=locks)
    frequency["link_assignments"] = FQ.expand_to_links(frequency, ftasks)
    frequency["constraints"] = copy.deepcopy(frequency_constraints)
    parent_best = detail["optimization"]["best"]
    params = RP.plan_bound_devices(
        stations, links, devices, models, antennas, terrain,
        preset=preset, fade_margin_db=parent_best["fade_margin_db"],
        manual_override=adjustment["manual_override"],
        frequency_by_link={row["link_id"]: row["freq_khz"] for row in frequency["link_assignments"]},
        interference_rows=jam_rows, checkpoint=parent_checkpoint)
    if params["manual_errors"]:
        raise ValueError("人工设备参数无效：" + "；".join(params["manual_errors"]))
    actual_margins = {row["link_id"]: row["margin_db"] for row in params["links"]}
    for link in links:
        margin = actual_margins.get(link["link_id"])
        if margin is not None:
            link["link_margin_db"] = margin
    if progress:
        progress(0.45, "电台参数与链路余量已重算")

    route_links = [row for row in links if not change or change["type"] != "ROUTE_REBUILD"
                   or row["link_id"] not in change["detail"]["banned_links"]]
    graph = routing.graph_from_links(route_links, metrics_rows)[0]
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
    scenario = _actual_link_margins(stations, links, terrain, frequency, ftasks, params,
        devices, models, antennas, jam_rows, caps, checkpoint=parent_checkpoint)
    graph = routing.graph_from_links(route_links, metrics_rows)[0]
    routes = routing.plan_routes(graph, demand_rows, default_strategy=strategy,
                                 manual_paths=adjustment["manual_paths"])
    if change and change["type"] == "ROUTE_REBUILD":
        _apply_frozen_routes(routes, route_links, metrics_rows, change)
    if endpoint_binding_errors(links, demand_rows, routes):
        raise ValueError("重算路由端点与精确物理设备绑定不一致")
    check = plan_check.check(freq_result=frequency, freq_tasks=ftasks,
                            param_result=params, route_result=routes,
                            links=links, nodes=nodes, caps=caps,
                            devices=devices, models=models, uplinks=uplinks)
    if progress:
        progress(0.75, "路由、频率及方案校验已重算")

    required = dict(MO.DEFAULT_CONSTRAINTS)
    required.update(constraints or {})
    objectives, constraint_check, usable_count = _fixed_topology_metrics(
        links, all_demands, routes, params, required
    )
    optimization = copy.deepcopy(detail["optimization"])
    optimization["uplinks"] = uplinks
    optimization["best"]["objectives"] = objectives
    optimization["best"]["constraint_check"] = constraint_check
    optimization["best"]["links_usable"] = usable_count
    optimization["tradeoff"] = []
    optimization["feasible"] = (all(item["pass"] for item in constraint_check.values())
                                and check["passed"])
    # 子方案只重算当前固定拓扑，父方案备选从未逐套重算，不能继承其成功计数。
    parent_checkpoint()
    child_deployment = optimization.get("deployment_solve")
    if isinstance(child_deployment, dict):
        child_deployment["solutions"] = []
        child_deployment["returned_solution_count"] = 0
        child_deployment["proved_optimal"] = False
        child_deployment["shortfall_reasons"] = [
            "固定父方案重算未逐套验证父方案候选，父候选解及返回计数已失效",
        ]
        if not optimization["feasible"]:
            child_deployment["shortfall_reasons"].append("子方案实际重算未通过完整校验")
    parent_checkpoint()
    if optimization["feasible"]:
        optimization["infeasible"] = None
    else:
        optimization["infeasible"] = {
            "conflicting_constraints": [key for key, item in constraint_check.items()
                                        if not item["pass"]],
            "suggestions": ["调整人工设备参数或主路径后重新计算"],
        }
    analysis = IF.analyze(scenario, area=not bool(binding), area_cell_m=3000.0)
    if binding:
        analysis["affected_area"] = (IF.affected_area(scenario, cell_m=3000.0, bbox=terrain.bbox)
            if scenario.jammers else {"type": "FeatureCollection", "features": [],
                "properties": {"cell_m": 3000.0, "bbox": list(terrain.bbox)}})
    measures, unresolved, review = IF.recommend(
        scenario, analysis, freq_ctx=IF.FreqContext(ftasks, frequency["assignments"]),
        caps=caps, route_ctx=(graph, routes), candidate_rows=cand_rows,
    )
    if progress:
        progress(0.95, "干扰分析已重算")
    elapsed = time.time() - started
    parent_checkpoint()
    return dict(
        task_id=task_id, steps=[("固定父方案拓扑并重算", elapsed)],
        total_s=elapsed, within_limit=elapsed <= TIME_LIMIT_S,
        optimization=optimization, routes=routes, frequency=frequency,
        params=params, check=check,
        interference=dict(analysis={key: value for key, value in analysis.items()
                                    if key != "_states"},
                          countermeasures=measures, unresolved=unresolved, review=review,
                          **({"effect": {"origin": copy.deepcopy(adjustment["interference_origin"]),
                              "change_set": copy.deepcopy(change), "sources": copy.deepcopy(jam_rows),
                              "terrain_fingerprint": binding["terrain_fingerprint"],
                              "parameter_substitutions": copy.deepcopy(binding["parameter_substitutions"]),
                              "frequency_constraints": copy.deepcopy(frequency_constraints)}} if binding else {})),
        links=links, nodes=nodes, devices=devices,
    )


def rows_from_solution(pb, e, nodes, devices, models):
    """把一个优化解（下标形式的链路）落成链路表，并给新增中继补节点/设备行。"""
    fm = pb.fm
    rows = []
    primary = {frozenset((a, b)) for a, b in e["uplinks"].items()}
    base = {(min(a, b), max(a, b), band) for a, b, band in pb.base}
    for k, (a, b, band) in enumerate(e["links"], start=1):
        sa, sb = fm.stations[a], fm.stations[b]
        m = pb.margin_at_max(a, b, band)
        rows.append(dict(link_id="OL-%04d" % k, node_a_id=sa.sid, node_b_id=sb.sid,
                         device_class=band, device_a_id="", device_b_id="",
                         link_margin_db="%.2f" % (m if m is not None else 0.0),
                         distance_m="%.1f" % haversine_m(sa.lon, sa.lat, sb.lon, sb.lat),
                         is_available="true", link_state="",
                         is_backup=str((min(a, b), max(a, b), band) not in base
                                       and frozenset((a, b)) not in primary).lower()))
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
        progress=None, demand_rows=None, resource_rows=None):
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
    monotonic_start = time.monotonic()
    deployment_checkpoint, progress = _runtime_callbacks(monotonic_start, progress)
    deployment_checkpoint()
    read = _resource_reader(resource_rows)

    # ── 1 任务条件输入 ──
    t0 = time.time()
    terrain = default_terrain(verbose=False)
    nodes, devices = read("node.csv"), read("device.csv")
    # 冻结表保留完整审计输入；实际装配、绑定与代表型号选择均只用在架设备。
    devices = [row for row in devices if row.get("availability", "ACTIVE") == "ACTIVE"]
    models, antennas = read("device_model.csv"), read("antenna_model.csv")
    demands_all = read("comm_demand.csv")
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
    active_ids = {row["device_id"] for row in devices}
    active_nodes = {row["node_id"] for row in devices}
    for demand in demands:
        if any(demand[key] not in active_nodes for key in ("src_node_id", "dst_node_id")):
            raise ValueError("通联端点没有在架设备，不能自动虚构替代设备")
        if any(demand.get(key) and demand[key] not in active_ids for key in ("source_device_id", "target_device_id")):
            raise ValueError("指定通联设备不存在或已下架")
    pool_rows, jam_rows = read("frequency_resource.csv"), read("interference_source.csv")
    if interference_rows is not None:
        jam_rows = [dict(row) for row in interference_rows]
    pool_rows = pool_rows + extra_freq_rows
    frequency_constraints = (resource_rows or {}).get("frequency_constraints")
    pool_rows = constrained_frequency_rows(pool_rows, frequency_constraints)
    metrics_rows, cand_rows = read("link_metric.csv"), read("candidate_site.csv")
    stations = stations_from_nodes(nodes, devices, models, antennas)
    planning_input = copy.deepcopy((resource_rows or {}).get("planning_input"))

    cand_rows, candidate_filter = DI.prepare_candidates(
        cand_rows, planning_input, terrain, nodes, stations, checkpoint=deployment_checkpoint)
    solve_options = (planning_input or {}).get("deploymentSolve") or {}
    requested_solutions = solve_options.get("solutionCount", 1)
    problem_options = ({"candidate_relays": 0} if solve_options.get("mode") == "FIXED_COUNT" else {})
    steps.append(("1 任务条件输入（需求 %d 条）" % len(demands), time.time() - t0))
    if progress:
        progress(0.15, "任务与资源已加载")

    # ── 2 电台部署（第 2 周 P1）──
    t0 = time.time()
    fm, sol, links0, nodes1, devices1 = topology_from_deployment(
        stations, terrain, nodes, devices, models, cand_rows, deployment_options=planning_input,
        checkpoint=deployment_checkpoint)
    steps.append(("2 电台部署（新增 %d 台）" % len(sol.added), time.time() - t0))
    if progress:
        progress(0.30, "电台部署完成")

    # ── 3 路由 + 频率 + 功率（第 3 周，在部署拓扑上）──
    t0 = time.time()
    st1 = stations + [fm.stations[i] for i, _s in sol.added]
    caps1 = RP.capabilities_from_tables(st1, devices1, models, antennas)
    params1 = RP.plan(st1, RP.topo_from_links(st1, links0), caps1, terrain, preset=preset,
                      checkpoint=deployment_checkpoint)
    steps.append(("3 初始功率配置", time.time() - t0))
    if progress:
        progress(0.40, "初始参数配置完成")

    # ── 4 方案优化（第 4 周 NSGA-II）──
    t0 = time.time()
    cons = dict(MO.DEFAULT_CONSTRAINTS)
    cons.update(constraints or {})
    opt_demands = demands if (task_id is None or survivability_scope == "TASK") else demands_all
    pb = MO.Problem(fm, sol, opt_demands, caps1,
                    survivability_threshold=cons["survivability_threshold"], **problem_options)
    opt = MO.optimize(pb, constraints=cons, pop_size=pop_size, generations=generations,
                      checkpoint=deployment_checkpoint)
    steps.append(("4 多目标优化（评估 %d 次）" % opt["evaluations"], time.time() - t0))
    if progress:
        progress(0.70, "多目标优化完成")

    # ── 5 闭环：实际频率与设备校验优先于优化器的近似排序 ──
    t0 = time.time()
    selected = None
    seen_topologies = set()
    checked = 0
    verified, check_cost = [], 0.0
    from actual_search import (ChannelSearch, bandwidth_audit, backup_solutions, failure_context,
                               physical_parent_solutions)
    search = ChannelSearch(models, antennas, terrain, jam_rows,
        deadline=monotonic_start + TIME_LIMIT_S - 30,
        progress=(lambda: progress(0.72, "实际频点与物理备份搜索")) if progress else None)

    def checked_candidate(problem, solution, preference=None, optimize_bindings=False,
                          channel_admissible=None, radio_anchor=None):
        nonlocal checked, check_cost
        if not search.begin_check(check_cost, allow_initial=selected is None):
            return None
        checked = search.complete_checks
        started = time.monotonic()
        result = _check_candidate(problem, solution, st1, nodes1, devices1, models, antennas,
            terrain, demands, opt_demands, strategy, preset, pool_rows, metrics_rows, cons,
            interference_rows=jam_rows, channel_preference=preference,
            optimize_bindings=optimize_bindings, search_checkpoint=search.checkpoint,
            channel_admissible=channel_admissible, radio_anchor=radio_anchor)
        sites = DI.selected_sites(result["nodes"], nodes, cand_rows, checkpoint=deployment_checkpoint)
        issues = DI.final_issues(sites, planning_input, cand_rows, nodes=result["nodes"],
            params=result["params"], terrain=terrain, checkpoint=deployment_checkpoint)
        result["deployment_issues"] = issues
        if issues:
            result["score"] = (result["score"][0] + len(issues),) + result["score"][1:]
        check_cost = max(0.25, time.monotonic() - started)
        return result

    def consider(problem, optimization, limit, candidates=None, ceiling=24, radio_anchor=None):
        nonlocal selected, pb, opt, checked, check_cost
        if candidates is None:
            candidates = [optimization["solutions"][0]] + optimization.get("candidates", [])
        for solution in candidates[:limit]:
            if selected is not None and (checked >= ceiling or not search.checkpoint()
                    or time.monotonic() + check_cost >= search.deadline):
                break
            signature = _candidate_signature(solution, radio_anchor)
            if signature in seen_topologies:
                continue
            seen_topologies.add(signature)
            result = checked_candidate(problem, solution, radio_anchor=radio_anchor)
            if result is None:
                break
            if radio_anchor is None and checked < ceiling and search.checkpoint():
                preference = search.preferences(result, pool_rows, opt_demands)
                if preference and search.checkpoint() and time.monotonic() + check_cost < search.deadline:
                    refined = checked_candidate(problem, solution, preference, True,
                                                channel_admissible=search.physical_guard(result))
                    if refined is not None and refined["score"] < result["score"]:
                        result = refined
            verified.append((problem, optimization, solution, result))
            if selected is None or result["score"] < selected["score"]:
                selected = dict(result, solution=solution)
                pb, opt = problem, optimization
            if (result["score"][0] == 0 and result["objectives"]["e2e_connectivity"] == 1.0
                    and (requested_solutions == 1 or len(DI.verified_solutions(
                        verified, selected, nodes, cand_rows, requested_solutions,
                        checkpoint=deployment_checkpoint)) >= requested_solutions)):
                return True
        return False

    found = consider(pb, opt, 6)
    frontier = sorted(verified, key=lambda row: row[3]["score"])[:4]
    for _round in range(3):
        if found or checked >= 20 or not search.checkpoint():
            break
        expanded = []
        for problem, optimization, solution, result in frontier:
            proposals = backup_solutions(problem, solution, result, opt_demands, models, pool_rows,
                                         max_variants=4, checkpoint=search.checkpoint)
            for proposal in proposals:
                before = len(verified)
                found = consider(problem, optimization, 1, candidates=[proposal])
                expanded.extend(verified[before:])
                if found or checked >= 20 or not search.checkpoint():
                    break
            if found or checked >= 20 or not search.checkpoint():
                break
        if not expanded:
            break
        # 保留新一层候选，即使单步暂未改善最坏割；全局终选仍只接受实际更优解。
        frontier = sorted(expanded, key=lambda row: row[3]["score"])[:4]
    if not found and checked < 24 and search.checkpoint() and time.monotonic() + max(10, 3 * check_cost) < search.deadline:
        important = {fm.stations[i].sid for demand in opt_demands
                     for i in (pb.idx.get(demand["src_node_id"]),
                               pb.idx.get(demand["dst_node_id"])) if i is not None
                     and str(demand.get("is_mandatory", "false")).lower() == "true"}
        parent_context = failure_context(selected["links"], opt_demands, selected["params"]["fade_margin_db"])
        hot_nets = {task_id for row in selected["frequency"]["conflicts"] for task_id in row["link_ids"]}
        hot_nets.update(task_id for band in selected["frequency"]["gap"].values()
                        for sub_band in band["sub_bands"] for task_id in sub_band["clique_task_ids"])
        parent_context["hot_nodes"] = {station.sid for station in fm.stations
                                       if any("NET-%s-%s" % (station.sid, band) in hot_nets for band in station.radio)}
        for alt in alternative_parent_solutions(
                fm, sol, max_variants=4, important_nodes=important,
                failure_context=parent_context):
            if checked >= 24 or not search.checkpoint() or time.monotonic() + max(10, 3 * check_cost) >= search.deadline:
                break
            alt_pb = MO.Problem(fm, alt, opt_demands, caps1,
                                survivability_threshold=cons["survivability_threshold"], **problem_options)
            alt_opt = MO.optimize(alt_pb, constraints=cons,
                                  pop_size=max(12, min(pop_size // 2, 20)),
                                  generations=max(8, min(generations // 2, 16)),
                                  checkpoint=deployment_checkpoint)
            if consider(alt_pb, alt_opt, 3):
                break

    # 为最终实际失效修复预留独立名额，仍受同一单调时钟截止时间约束。
    frontier = sorted(verified, key=lambda row: row[3]["score"])[:1]
    for _round in range(4):
        if (selected["score"][0] == 0 and not selected["params"]["failed_links"]) or checked >= 40 or not search.checkpoint():
            break
        expanded = []
        for problem, optimization, solution, result in frontier:
            proposals = backup_solutions(problem, solution, result, opt_demands, models, pool_rows,
                                         max_variants=1, checkpoint=search.checkpoint)
            proposals += physical_parent_solutions(search, problem, solution, result, opt_demands, models, pool_rows)
            # 每层留预算给组合后的下一次修复，不在第一层耗尽全部终选名额。
            for proposal in proposals[:2]:
                before = len(verified)
                previous_edges = Counter((frozenset((row["node_a_id"], row["node_b_id"])), row["device_class"])
                                         for row in result["links"])
                proposal_edges = Counter((frozenset((problem.sid[a], problem.sid[b])), band)
                                         for a, b, band in proposal["links"])
                is_prune = proposal_edges <= previous_edges
                consider(problem, optimization, 1, candidates=[proposal], ceiling=40,
                         radio_anchor=result if is_prune else None)
                expanded.extend(verified[before:])
                if (selected["score"][0] == 0 and not selected["params"]["failed_links"]) or checked >= 40 or not search.checkpoint():
                    break
            if (selected["score"][0] == 0 and not selected["params"]["failed_links"]) or checked >= 40 or not search.checkpoint():
                break
        if not expanded:
            break
        frontier = sorted(expanded, key=lambda row: row[3]["score"])[:1]

    best = selected["solution"]
    links, nodes2, devices2 = selected["links"], selected["nodes"], selected["devices"]
    st2, g, routes = selected["stations"], selected["graph"], selected["routes"]
    binding_errors = selected["binding_errors"]
    ftasks, freq, caps2 = selected["ftasks"], selected["frequency"], selected["caps"]
    freq["constraints"] = copy.deepcopy(frequency_constraints)
    params, chk = selected["params"], selected["check"]
    steps.append(("5 候选拓扑闭环校验（%d 套）" % checked, time.time() - t0))
    if progress:
        progress(0.85, "路由、频率与方案校验完成")

    # ── 6 干扰分析 ──
    t0 = time.time()
    sc = selected["scenario"]
    ana = IF.analyze(sc, area=True, area_cell_m=3000.0)
    cms, unresolved, review = IF.recommend(
        sc, ana, freq_ctx=IF.FreqContext(ftasks, freq["assignments"]), caps=caps2,
        route_ctx=(g, routes), candidate_rows=cand_rows)
    steps.append(("6 干扰分析与抗干扰推荐", time.time() - t0))
    if progress:
        progress(0.95, "干扰分析完成，正在保存方案")

    total = time.time() - T
    objectives = selected["objectives"]
    constraint_check = selected["constraint_check"]
    usable_count = selected["usable_count"]
    described = MO.describe(pb, best, opt["constraints"], rank=1)
    described["objectives"] = objectives
    described["constraint_check"] = constraint_check
    described["links_usable"] = usable_count
    actual_context = failure_context(links, opt_demands, params["fade_margin_db"])
    described["bridges"] = len(actual_context["bridges"])
    described["worst_single_failure"] = ({"link": list(actual_context["cuts"][0]["edge"])}
                                          if actual_context["cuts"] else None)
    task_objectives, task_checks, _task_usable = _fixed_topology_metrics(links, demands, routes, params, cons)
    failed_constraints = [key for key, row in constraint_check.items()
                          if not row["pass"]]
    if not chk["passed"]:
        failed_constraints.append("plan_check")
    if binding_errors:
        failed_constraints.append("device_binding")
    deployment_issues = selected.get("deployment_issues", [])
    if deployment_issues:
        failed_constraints.append("deployment_input")
    feasible = not failed_constraints
    selected_sites = DI.selected_sites(nodes2, nodes, cand_rows, checkpoint=deployment_checkpoint)
    alternatives = DI.verified_solutions(verified, selected, nodes, cand_rows, requested_solutions,
                                        checkpoint=deployment_checkpoint)
    deployment_solve = DI.solve_detail(planning_input, selected_sites, sol, deployment_issues, alternatives,
        forced_site_ids=[row["site_id"] for row in cand_rows if row.get("forced")], checkpoint=deployment_checkpoint)
    out = dict(task_id=task_id, steps=steps, total_s=total, within_limit=total <= TIME_LIMIT_S,
               deployment=dict(added=[fm.stations[i].sid for i, _s in sol.added]),
               optimization=dict(feasible=feasible, uplinks=copy.deepcopy(selected["uplinks"]),
                                 planning_input={"schema_version": 1,
                                     "bbox": copy.deepcopy((planning_input or {}).get("bbox")),
                                     "station_ids": list((planning_input or {}).get("stationIds", [])),
                                     "deployment_constraints": copy.deepcopy((planning_input or {}).get("deploymentConstraints")),
                                     "deployment_solve": copy.deepcopy((planning_input or {}).get("deploymentSolve"))},
                                 candidate_filter=candidate_filter, deployment_solve=deployment_solve,
                                 actual_search={"evaluations": search.evaluations,
                                                "budget_exhausted": search.exhausted,
                                                "checked_candidates": checked,
                                                "check_limit_reached": checked >= 40,
                                                "repair_changes": copy.deepcopy(best.get("repair_changes", [])),
                                                "radio_bandwidth": bandwidth_audit(sc, devices2, models),
                                                "planned_devices": [{"device_id": row["device_id"],
                                                    "node_id": row["node_id"], "source_model_id": row["model_id"],
                                                    "deployment_state": "PLANNED",
                                                    "source_policy": "EXISTING_P1_MO_DEVICE_TEMPLATE"}
                                                    for row in devices2 if row["node_id"] in {
                                                        node["node_id"] for node in nodes2 if node.get("_added_relay")}]},
                                 infeasible=(None if feasible else {
                                     "conflicting_constraints": failed_constraints,
                                     "suggestions": binding_errors or
                                         ["调整设备或链路后重新计算"],
                                 }),
                                 survivability_scope=("TASK" if task_id and survivability_scope == "TASK"
                                                      else "NETWORK"),
                                 task_view=({"demands": len(demands), "mandatory": sum(
                                     str(row.get("is_mandatory", "false")).lower() == "true" for row in demands),
                                     "connectivity": task_objectives["e2e_connectivity"],
                                     "mandatory_connectivity": task_checks["mandatory_e2e_connectivity"]["value"],
                                     "survivability": task_objectives["survivability"],
                                     "note": "实际频点任务视角，仅供参考；硬约束仍按全网必要需求"} if task_id else None),
                                 best=described,
                                 tradeoff=[dict(MO.describe(pb, e, opt["constraints"]),
                                                evaluation_basis="REPRESENTATIVE_FREQUENCY_PRESELECTION")
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
    deployment_checkpoint()
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
