"""数据接入层（阶段六依赖项）。

把仓库中真实（合成生成的）场景表转换为规划算法能消费的扁平结构。
真实数据来自 `data/synthetic/`（节点 / 候选点 / 通联需求 / 拓扑链路），
地形来自 `data/raw/dem`（真实太行山 30m DEM，由 scripts/terrain.py 自动加载）。

【契约 / 输出结构】（与上层 deployment_service 解耦，接口不变）
    {
      "bbox": [lon0, lat0, lon1, lat1],
      "nodes":      [{"node_id","lon","lat","device_class"}],          # 既有通信节点（必被服务）
      "candidates": [{"site_id","lon","lat"}],                         # 候选部署点（可加装电台）
      "demands":    [{"demand_id","src_id","dst_id","band","mandatory"}],# 通联需求
      "device_model_id": "<本次规划使用的电台型号>",
      "existing_links": [...]   # 已有拓扑链路（可选，供后续必通边约束）
    }

真实数据文件不存在时（如离线冒烟环境），自动回退到确定性合成生成器，保证接口层仍可跑通。
"""
from __future__ import annotations

import csv
import math
import os
import random
from typing import Dict, List, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
DATA_ROOT = os.path.join(_ROOT, "data")  # /workspace/data

# 真实场景表（由 scripts/gen_test_data.py 生成，结构见 data/schemas/*_template.csv）
SYN_NODES = os.path.join(DATA_ROOT, "synthetic", "nodes", "nodes_v1.csv")
SYN_CANDS = os.path.join(DATA_ROOT, "synthetic", "nodes", "candidate_sites_v1.csv")
SYN_TASKS = os.path.join(DATA_ROOT, "synthetic", "tasks", "task_links_v1.csv")
SYN_SCENARIOS = os.path.join(DATA_ROOT, "synthetic", "tasks", "task_scenarios_v1.csv")
SYN_TOPO = os.path.join(DATA_ROOT, "synthetic", "topology", "topology_links_v1.csv")

# 实测规划区（TS-0001）：与 scripts/terrain.py 的 BBOX 一致（2026-09-16 西移后）
DEFAULT_BBOX = (114.0465, 36.9110, 115.4045, 37.9890)


def _read_csv(path: str) -> List[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _real_data_present() -> bool:
    return (os.path.exists(SYN_NODES) and os.path.exists(SYN_CANDS)
            and os.path.exists(SYN_TASKS) and os.path.exists(SYN_SCENARIOS))


def _to_f(row: dict, key: str, default: float = 0.0) -> float:
    v = row.get(key)
    if v in (None, ""):
        return default
    try:
        return float(v)
    except ValueError:
        return default


def _parse_bbox(area_str: Optional[str]) -> List[float]:
    """'lon0;lat0;lon1;lat1' -> [lon0, lat0, lon1, lat1]；缺省回 DEFAULT_BBOX。"""
    if not area_str:
        return list(DEFAULT_BBOX)
    parts = [p.strip() for p in str(area_str).split(";") if p.strip()]
    if len(parts) == 4:
        try:
            return [float(p) for p in parts]
        except ValueError:
            pass
    return list(DEFAULT_BBOX)


def _in_bbox(lon: float, lat: float, bbox: List[float]) -> bool:
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _dedup_candidates(cands: List[dict], spacing_m: float, cap: Optional[int]) -> List[dict]:
    """按评分降序、最小站间距去重，截取到 cap。

    候选点原始即已按 3000m 间距去重，此处用更大间距进一步降低密度，
    使部署求解（覆盖位图 + Steiner 森林 + 多方案）在真实数据规模下保持可响应。
    高分优先，保证留存的是质量最好的候选。
    """
    sel: List[dict] = []
    for c in sorted(cands, key=lambda x: -x.get("score", 0.0)):
        lon, lat = c["lon"], c["lat"]
        if any(_haversine_m(lon, lat, s["lon"], s["lat"]) < spacing_m for s in sel):
            continue
        sel.append(c)
        if cap is not None and len(sel) >= cap:
            break
    return sel


def _load_scenario_from_csv(size: str = "full") -> Dict:
    """读取真实（合成生成）场景表，构造规划所需数据。

    size='demo' 时对各表做规模上限裁剪（用于快速测试 / 演示），
    size='full' 时使用全部真实数据。
    """
    # 规划区 bbox 取自任务场景 TS-0001（若存在）
    scenarios = _read_csv(SYN_SCENARIOS)
    bbox = DEFAULT_BBOX
    if scenarios:
        bbox = _parse_bbox(scenarios[0].get("area_bbox"))

    cap_nodes = 60 if size == "demo" else None
    # 候选点：间距去重（5000m→约 334 个；demo 用 8000m→约 150 个），高分优先
    cand_spacing = 8000.0 if size == "demo" else 5000.0
    cap_cands = 150 if size == "demo" else 400
    cap_demands = 80 if size == "demo" else None

    # 节点（FIXED_STATION + TASK 均为通联端点）
    nodes: List[dict] = []
    for i, row in enumerate(_read_csv(SYN_NODES)):
        if cap_nodes is not None and len(nodes) >= cap_nodes:
            break
        nodes.append({
            "node_id": row["node_id"],
            "lon": _to_f(row, "lon"),
            "lat": _to_f(row, "lat"),
            "device_class": (row.get("device_class") or "VUHF").strip().upper(),
        })

    node_ids = {n["node_id"] for n in nodes}

    # 候选部署点：仅 is_deployable==true 且在规划区内，按评分/间距去重降密度
    raw_cands: List[dict] = []
    for row in _read_csv(SYN_CANDS):
        if row.get("is_deployable") != "true":
            continue
        lon, lat = _to_f(row, "lon"), _to_f(row, "lat")
        if not _in_bbox(lon, lat, bbox):
            continue
        raw_cands.append({
            "site_id": row["site_id"],
            "lon": lon,
            "lat": lat,
            "score": _to_f(row, "score"),
        })
    candidates = _dedup_candidates(raw_cands, cand_spacing, cap_cands)

    # 通联需求：band 取 preferred_class（HF/VUHF），两端节点必须存在
    demands: List[dict] = []
    for row in _read_csv(SYN_TASKS):
        src = row.get("src_node_id")
        dst = row.get("dst_node_id")
        band = (row.get("preferred_class") or "VUHF").strip().upper()
        if band not in ("HF", "VUHF"):
            band = "VUHF"
        if src not in node_ids or dst not in node_ids:
            continue
        if cap_demands is not None and len(demands) >= cap_demands:
            break
        demands.append({
            "demand_id": row["demand_id"],
            "src_id": src,
            "dst_id": dst,
            "band": band,
            "mandatory": str(row.get("is_mandatory", "false")).lower() == "true",
        })

    # 已有拓扑链路（可选，供后续必通边约束；当前求解未强制使用）
    existing_links: List[dict] = []
    if os.path.exists(SYN_TOPO):
        for row in _read_csv(SYN_TOPO):
            existing_links.append({
                "link_id": row.get("link_id"),
                "node_a": row.get("node_a_id"),
                "node_b": row.get("node_b_id"),
                "device_class": (row.get("device_class") or "VUHF").strip().upper(),
                "link_margin_db": _to_f(row, "link_margin_db"),
                "is_available": row.get("is_available") == "true",
            })

    return {
        "bbox": list(bbox),
        "nodes": nodes,
        "candidates": candidates,
        "demands": demands,
        "existing_links": existing_links,
        "synthetic": False,
    }


# ---------------------------------------------------------------------------
# 离线回退：确定性合成生成器（无真实数据环境 / 压测用）
# ---------------------------------------------------------------------------
_SIZE_PRESETS = {
    "demo": dict(n_nodes=60, n_candidates=40, n_demands=80),
    "full": dict(n_nodes=156, n_candidates=120, n_demands=411),
}


def _jittered_grid(bbox, n, seed, jitter_frac=0.35):
    lon0, lat0, lon1, lat1 = bbox
    midlat = (lat0 + lat1) / 2.0
    r = random.Random(seed)
    span_lat_km = (lat1 - lat0) * 111320.0
    span_lon_km = (lon1 - lon0) * 111320.0 * math.cos(math.radians(midlat))
    target = 10000.0
    cols = max(1, int(round(span_lon_km / target)))
    rows = max(1, int(round(span_lat_km / target)))
    pts = []
    for ri in range(rows):
        for ci in range(cols):
            if len(pts) >= n:
                break
            base_lon = lon0 + (ci + 0.5) * (lon1 - lon0) / cols
            base_lat = lat0 + (ri + 0.5) * (lat1 - lat0) / rows
            jlon = (r.random() - 0.5) * (lon1 - lon0) / cols * 2 * jitter_frac
            jlat = (r.random() - 0.5) * (lat1 - lat0) / rows * 2 * jitter_frac
            pts.append((base_lon + jlon, base_lat + jlat))
        if len(pts) >= n:
            break
    while len(pts) < n:
        pts.append((r.uniform(lon0, lon1), r.uniform(lat0, lat1)))
    return pts[:n]


def generate_synthetic(size: str = "demo", seed: int = 20260908,
                       bbox=DEFAULT_BBOX) -> Dict:
    preset = _SIZE_PRESETS.get(size, _SIZE_PRESETS["demo"])
    n_nodes, n_cand, n_dem = preset["n_nodes"], preset["n_candidates"], preset["n_demands"]
    r = random.Random(seed)
    node_pts = _jittered_grid(bbox, n_nodes, seed)
    cand_pts = _jittered_grid(bbox, n_cand, seed + 7)
    nodes = [{"node_id": f"ND-{i:04d}", "lon": round(lon, 6), "lat": round(lat, 6),
              "device_class": ("HF" if i % 3 != 0 else "VUHF")}
             for i, (lon, lat) in enumerate(node_pts)]
    candidates = [{"site_id": f"CP-{i:04d}", "lon": round(lon, 6), "lat": round(lat, 6)}
                  for i, (lon, lat) in enumerate(cand_pts)]
    by_class = {"HF": [], "VUHF": []}
    for nd in nodes:
        by_class[nd["device_class"]].append(nd)
    demands = []
    di = 0
    attempts = 0
    while di < n_dem and attempts < n_dem * 20:
        attempts += 1
        cls = r.choice(["HF", "VUHF"])
        pool = by_class[cls]
        if len(pool) < 2:
            continue
        a, b = r.sample(pool, 2)
        dlat = (a["lat"] - b["lat"]) * 111320.0
        dlon = (a["lon"] - b["lon"]) * 111320.0 * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
        if math.hypot(dlat, dlon) < 8000 and r.random() < 0.5:
            continue
        demands.append({
            "demand_id": f"CD-{di:04d}", "src_id": a["node_id"], "dst_id": b["node_id"],
            "band": cls, "mandatory": r.random() < 0.7,
        })
        di += 1
    return {
        "bbox": list(bbox), "nodes": nodes, "candidates": candidates,
        "demands": demands, "existing_links": [], "device_model_id": "DM-0001",
        "synthetic": True,
    }


def build_scenario(device_model_id: str,
                   existing_node_ids: Optional[List[str]] = None,
                   comm_demand_ids: Optional[List[str]] = None,
                   candidate_task_id: Optional[str] = None,
                   size: str = "demo",
                   seed: int = 20260908) -> Dict:
    """构造一次规划所需的数据场景。

    优先读取仓库真实场景表；缺失时回退到合成生成器。两种来源都返回同一结构，
    上层 deployment_service 无需感知数据来源。
    """
    if _real_data_present():
        scenario = _load_scenario_from_csv(size=size)
    else:
        scenario = generate_synthetic(size=size, seed=seed)

    if existing_node_ids is not None:
        wanted = set(existing_node_ids)
        scenario["nodes"] = [n for n in scenario["nodes"] if n["node_id"] in wanted]
        node_ids = {n["node_id"] for n in scenario["nodes"]}
        scenario["demands"] = [d for d in scenario["demands"]
                               if d["src_id"] in node_ids and d["dst_id"] in node_ids]
    if comm_demand_ids is not None:
        wanted = set(comm_demand_ids)
        scenario["demands"] = [d for d in scenario["demands"] if d["demand_id"] in wanted]

    scenario["device_model_id"] = device_model_id
    return scenario
