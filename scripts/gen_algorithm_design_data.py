#!/usr/bin/env python3
"""Generate algorithm-design helper datasets.

This script derives four v1 datasets from the existing synthetic node,
task, frequency, topology and fault-case tables:

    python scripts/gen_algorithm_design_data.py
"""
import csv
import heapq
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terrain import BBOX, SyntheticTerrain, haversine_m


ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
DATA = os.path.join(ROOT, "data")
SEED = 20260911
RNG = random.Random(SEED)
TERRAIN = SyntheticTerrain()


def data_path(*parts):
    return os.path.join(DATA, *parts)


def read_csv(*parts):
    with open(data_path(*parts), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv(parts, rows, fields):
    path = data_path(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    print("%-54s %5d rows" % ("/".join(parts), len(rows)))


def write_json(parts, obj):
    path = data_path(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    print("%-54s %5d items" % ("/".join(parts), len(obj)))


def nearest_distance_m(lon, lat, nodes):
    return min(haversine_m(lon, lat, float(n["lon"]), float(n["lat"])) for n in nodes)


def gen_candidate_sites(nodes):
    lon0, lat0, lon1, lat1 = BBOX
    roles = ["RELAY", "MOBILE_STATION", "TEMP_FIXED_STATION"]
    out = []
    for idx in range(1, 121):
        lon = RNG.uniform(lon0 + 0.02, lon1 - 0.02)
        lat = RNG.uniform(lat0 + 0.02, lat1 - 0.02)
        elev = TERRAIN.elevation(lon, lat)
        slope = TERRAIN.slope_deg(lon, lat)
        landcover = TERRAIN.landcover(lon, lat)
        road_distance_m = RNG.uniform(80, 4800)
        existing_distance_m = nearest_distance_m(lon, lat, nodes)

        forbidden_land = landcover in {"水域", "山地岩石"}
        deployable = (not forbidden_land) and slope <= 18.0 and road_distance_m <= 3500
        score = 100.0
        score -= min(slope, 35.0) * 1.6
        score -= min(road_distance_m, 5000.0) / 90.0
        score += min(elev, 1800.0) / 55.0
        score += min(existing_distance_m, 20000.0) / 1200.0
        if forbidden_land:
            score -= 30.0
        score = max(0.0, min(100.0, score))

        if score >= 75:
            level = "A"
        elif score >= 60:
            level = "B"
        elif score >= 45:
            level = "C"
        else:
            level = "D"

        reason = ""
        if not deployable:
            reasons = []
            if forbidden_land:
                reasons.append("地物类型不适宜")
            if slope > 18.0:
                reasons.append("坡度超过阈值")
            if road_distance_m > 3500:
                reasons.append("道路距离超过阈值")
            reason = ";".join(reasons)

        out.append(dict(
            site_id="CS-%04d" % idx,
            lon=round(lon, 6),
            lat=round(lat, 6),
            elevation_m=round(elev, 1),
            slope_deg=round(slope, 2),
            landcover_type=landcover,
            nearest_road_distance_m=round(road_distance_m, 1),
            nearest_node_distance_m=round(existing_distance_m, 1),
            candidate_role=roles[idx % len(roles)],
            is_deployable=str(deployable).lower(),
            recommendation_level=level,
            score=round(score, 2),
            reject_reason=reason,
            source="SYNTHETIC_TERRAIN",
            remark="第2周候选部署点筛选输入"))
    return out


def build_graph(links):
    graph = {}
    link_by_pair = {}
    for lk in links:
        if lk["is_available"] != "true":
            continue
        a, b = lk["node_a_id"], lk["node_b_id"]
        dist = float(lk["distance_m"])
        margin = float(lk["link_margin_db"])
        penalty = dist * (1.0 + max(0.0, 20.0 - margin) / 20.0)
        graph.setdefault(a, []).append((b, penalty, lk))
        graph.setdefault(b, []).append((a, penalty, lk))
        link_by_pair[frozenset((a, b))] = lk
    return graph, link_by_pair


def shortest_route(graph, src, dst, banned=None):
    banned = banned or set()
    heap = [(0.0, src, [], [])]
    seen = set()
    while heap:
        cost, node, path, lks = heapq.heappop(heap)
        if node == dst:
            return cost, path + [node], lks
        if node in seen:
            continue
        seen.add(node)
        for nb, w, lk in graph.get(node, []):
            if nb in seen or lk["link_id"] in banned:
                continue
            heapq.heappush(heap, (cost + w, nb, path + [node], lks + [lk]))
    return None


def route_record(demand, kind, result):
    if result is None:
        return None
    cost, nodes, links = result
    margins = [float(x["link_margin_db"]) for x in links]
    distances = [float(x["distance_m"]) for x in links]
    reliability = 1.0
    for m in margins:
        reliability *= 0.995 if m >= 30 else 0.985 if m >= 15 else 0.95
    return dict(
        route_id="%s-%s" % (demand["demand_id"], kind),
        demand_id=demand["demand_id"],
        task_id=demand["task_id"],
        route_type=kind,
        node_path=nodes,
        link_path=[x["link_id"] for x in links],
        hop_count=len(links),
        total_distance_m=round(sum(distances), 1),
        bottleneck_margin_db=round(min(margins), 2) if margins else 999.0,
        estimated_reliability=round(reliability, 4),
        route_cost=round(cost, 2),
        is_feasible=bool(links),
        note="derived from topology_links_v1.csv")


def gen_routes(demands, links):
    graph, _ = build_graph(links)
    out = []
    selected = sorted(
        demands,
        key=lambda d: (d["is_mandatory"] != "true", d["task_id"], d["demand_id"])
    )[:80]
    for dem in selected:
        primary = shortest_route(graph, dem["src_node_id"], dem["dst_node_id"])
        pr = route_record(dem, "PRIMARY", primary)
        if pr:
            out.append(pr)
            banned = set(pr["link_path"])
            backup = shortest_route(graph, dem["src_node_id"], dem["dst_node_id"], banned)
            br = route_record(dem, "BACKUP", backup)
            if br:
                out.append(br)
    return out


def gen_frequency_conflicts(links):
    by_class = {}
    for lk in links:
        if lk["is_available"] == "true":
            by_class.setdefault(lk["device_class"], []).append(lk)
    conflicts = []
    cid = 0
    for cls, items in by_class.items():
        # Keep the constraint table compact but useful for graph coloring.
        for i, a in enumerate(items):
            if len(conflicts) >= 600:
                break
            anodes = {a["node_a_id"], a["node_b_id"]}
            for b in items[i + 1:]:
                if len(conflicts) >= 600:
                    break
                bnodes = {b["node_a_id"], b["node_b_id"]}
                shared = anodes & bnodes
                center_gap = abs(float(a["freq_khz"]) - float(b["freq_khz"]))
                close = min(
                    haversine_m(float(a.get("node_a_lon", 0) or 0), 0, float(a.get("node_a_lon", 0) or 0), 0)
                    if False else 999999,
                    999999,
                )
                same_or_adjacent = center_gap <= max(float(a["bandwidth_khz"]), float(b["bandwidth_khz"]))
                if shared or (same_or_adjacent and abs(float(a["distance_m"]) - float(b["distance_m"])) < 5000):
                    cid += 1
                    if shared:
                        reason = "SHARED_NODE"
                        min_sep = 0
                    else:
                        reason = "ADJACENT_CHANNEL_NEAR_PATH"
                        min_sep = 30000 if cls == "VUHF" else 60000
                    conflicts.append(dict(
                        conflict_id="CF-%04d" % cid,
                        link_id_a=a["link_id"],
                        link_id_b=b["link_id"],
                        device_class=cls,
                        conflict_type=reason,
                        min_frequency_separation_khz=max(float(a["bandwidth_khz"]), float(b["bandwidth_khz"])),
                        min_spatial_separation_m=min_sep,
                        hard_constraint="true" if shared else "false",
                        reason="共享节点不可同频复用" if shared else "近距离相邻信道需保护间隔",
                        source="DERIVED_TOPOLOGY"))
    return conflicts


def gen_fault_rules(cases):
    rules = []
    seen = set()
    ordered = sorted(cases, key=lambda r: (r["fault_type"], r["device_class"], r["fault_subtype"], r["case_id"]))
    for row in ordered:
        symptom_ids = row.get("symptom_ids", "")
        if not symptom_ids:
            continue
        key = (row["fault_type"], row["device_class"], row["fault_subtype"], symptom_ids)
        if key in seen:
            continue
        seen.add(key)
        rid = "RULE-%04d" % (len(rules) + 1)
        conditions = []
        for sy in symptom_ids.split(";"):
            conditions.append("has_symptom('%s')" % sy)
        if row.get("device_selftest"):
            conditions.append("device_selftest == '%s'" % row["device_selftest"])
        condition_expr = " and ".join(conditions)
        rules.append(dict(
            rule_id=rid,
            fault_type=row["fault_type"],
            device_class=row["device_class"],
            object_type=row["object_type"],
            condition_expression=condition_expr,
            fault_subtype=row["fault_subtype"],
            fault_component=row["fault_component"],
            root_cause=row["root_cause"],
            action_suggestion=row["solution"],
            confidence=0.85 if row["source_doc"] == "CONSTRUCTED" else 0.75,
            priority=1 if row["fault_type"] in {"LINK_DOWN", "HW_FAILURE"} else 2,
            source_case_id=row["case_id"],
            source=row["source_doc"]))
        if len(rules) >= 80:
            break
    return rules


def main():
    nodes = read_csv("synthetic", "nodes", "nodes_v1.csv")
    demands = read_csv("synthetic", "tasks", "task_links_v1.csv")
    links = read_csv("synthetic", "topology", "topology_links_v1.csv")
    cases = read_csv("fault", "cases", "fault_cases_v1.csv")

    candidate_sites = gen_candidate_sites(nodes)
    routes = gen_routes(demands, links)
    conflicts = gen_frequency_conflicts(links)
    rules = gen_fault_rules(cases)

    write_csv(
        ("synthetic", "nodes", "candidate_sites_v1.csv"),
        candidate_sites,
        ["site_id", "lon", "lat", "elevation_m", "slope_deg", "landcover_type",
         "nearest_road_distance_m", "nearest_node_distance_m", "candidate_role",
         "is_deployable", "recommendation_level", "score", "reject_reason",
         "source", "remark"])
    write_json(("synthetic", "topology", "routes_v1.json"), routes)
    write_csv(
        ("synthetic", "topology", "frequency_conflicts_v1.csv"),
        conflicts,
        ["conflict_id", "link_id_a", "link_id_b", "device_class", "conflict_type",
         "min_frequency_separation_khz", "min_spatial_separation_m", "hard_constraint",
         "reason", "source"])
    write_csv(
        ("fault", "rules", "fault_rules_v1.csv"),
        rules,
        ["rule_id", "fault_type", "device_class", "object_type", "condition_expression",
         "fault_subtype", "fault_component", "root_cause", "action_suggestion",
         "confidence", "priority", "source_case_id", "source"])

    deployable = sum(1 for s in candidate_sites if s["is_deployable"] == "true")
    primary = sum(1 for r in routes if r["route_type"] == "PRIMARY")
    backup = sum(1 for r in routes if r["route_type"] == "BACKUP")
    hard = sum(1 for c in conflicts if c["hard_constraint"] == "true")
    print("\nsummary")
    print("  candidate_sites deployable: %d/%d" % (deployable, len(candidate_sites)))
    print("  routes primary/backup: %d/%d" % (primary, backup))
    print("  frequency_conflicts hard/total: %d/%d" % (hard, len(conflicts)))
    print("  fault_rules: %d" % len(rules))


if __name__ == "__main__":
    main()
