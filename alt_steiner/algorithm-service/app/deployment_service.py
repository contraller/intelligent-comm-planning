"""部署规划服务粘合层（阶段六核心业务逻辑）。

把 data_loader 的场景 → 规划领域模型（Site / Requirement）→ plan_deployment →
接口契约响应（solutions / blind_zones）。同时负责：
  - 频段解析（由 device_model_id 决定本次规划频段，短波/超短波分开算）；
  - 进度回调（供 HTTP 异步任务上报 progress / stage）；
  - 无可行解分支（code=3001 + suggestions）；
  - 盲区 → GeoJSON 多边形（SR-4.2.1 扩展流 1）。

纯标准库 + 仅依赖 scripts/planning（已通过测试）。真实数据接入见 data_loader.py。
"""
from __future__ import annotations

import math
import os
import sys
import time
from typing import Callable, Dict, List, Optional

# 让 planning 包与 terrain/propagation 扁平模块可被导入
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
if os.path.join(_ROOT, "scripts") not in sys.path:
    sys.path.insert(0, os.path.join(_ROOT, "scripts"))

from planning.model import Site, RadioProfile                     # noqa: E402
from planning.radio_db import (                                    # noqa: E402
    load_default_radio_db, profile_for_device, default_profile_for_band,
)
from planning.deployment import Requirement, DeploymentParams       # noqa: E402
from planning.viewshed import CoverageGrid                            # noqa: E402
from planning.solve import plan_deployment                          # noqa: E402
from data_loader import build_scenario                              # noqa: E402

ProgressCb = Callable[[float, str], None]
DEFAULT_CELL_M = 2000.0   # 规划覆盖栅格步长（约 60×60 格 @120km）


def _terrain():
    from terrain import default_terrain
    return default_terrain(verbose=False)


def resolve_band(device_db: Dict, model_id: str) -> str:
    """由 device_model_id 解析频段（HF / VUHF）。"""
    dev = device_db.get(model_id)
    if not dev:
        return "HF"
    cls = (dev.get("device_class") or "VUHF").strip().upper()
    return "HF" if cls.startswith("H") else "VUHF"


def _build_sites_and_reqs(scenario: Dict, device_db: Dict, antenna_db: Dict,
                          band: str):
    """场景 → (sites, requirements, node_lookup, candidate_profile)。"""
    model_id = scenario["device_model_id"]
    cand_profile = profile_for_device(device_db, antenna_db, model_id) \
        or default_profile_for_band(band)

    sites: List[Site] = []
    node_lookup: Dict[str, Site] = {}
    for nd in scenario["nodes"]:
        if nd.get("device_class", band) != band:
            continue  # 仅本次频段节点参与
        prof = default_profile_for_band(band)
        s = Site(nd["node_id"], float(nd["lon"]), float(nd["lat"]),
                 band, prof, kind="fixed")
        sites.append(s)
        node_lookup[nd["node_id"]] = s

    cand_lookup: Dict[str, Site] = {}
    for cp in scenario["candidates"]:
        s = Site(cp["site_id"], float(cp["lon"]), float(cp["lat"]),
                 band, cand_profile, kind="candidate")
        sites.append(s)
        cand_lookup[cp["site_id"]] = s

    requirements: List[Requirement] = []
    for d in scenario["demands"]:
        if d.get("band") != band:
            continue
        if d["src_id"] not in node_lookup or d["dst_id"] not in node_lookup:
            continue
        requirements.append(Requirement(
            d["demand_id"], d["src_id"], d["dst_id"], band,
            mandatory=bool(d.get("mandatory", False)),
        ))
    return sites, requirements, node_lookup, cand_lookup, cand_profile


def _grid_of(bbox, cell_m=DEFAULT_CELL_M):
    return CoverageGrid.from_bbox(bbox, cell_m=cell_m)


def _covered_from_map(site_id: str, covers_map: Dict[str, int], grid: CoverageGrid,
                      demands: List[Requirement], node_lookup: Dict) -> List[str]:
    """用预计算覆盖位图判断本站覆盖了哪些需求（端点落在本站覆盖格点）。"""
    cov = covers_map.get(site_id, 0)
    covered = set()
    for r in demands:
        sa = node_lookup.get(r.src_id)
        db = node_lookup.get(r.dst_id)
        for n in (sa, db):
            if n is None:
                continue
            ci = grid.index(n.lon, n.lat)
            if ci is not None and (cov >> ci) & 1:
                covered.add(r.req_id)
    return sorted(covered)


def _blind_zones_to_geojson(blind: Dict, grid: CoverageGrid,
                            demands: List[Requirement],
                            node_lookup: Dict) -> List[Dict]:
    """盲区格点 → 4-连通簇 → 每簇一个包围盒多边形（GeoJSON）。"""
    blind_idx = blind.get("blind_idx", [])
    if not blind_idx:
        return []
    nlon, nlat = grid.nlon, grid.nlat
    blind_set = set(blind_idx)
    visited = set()
    clusters = []
    for start in blind_idx:
        if start in visited:
            continue
        # BFS 4-连通
        stack = [start]
        comp = []
        visited.add(start)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            row, col = divmod(cur, nlon)
            for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                nr, nc = row + dr, col + dc
                if 0 <= nr < nlat and 0 <= nc < nlon:
                    nxt = nr * nlon + nc
                    if nxt in blind_set and nxt not in visited:
                        visited.add(nxt)
                        stack.append(nxt)
        clusters.append(comp)

    out = []
    cell_area_km2 = grid.cell_area_m2 / 1e6
    # 受影响需求：端点落在盲区格点
    blind_cells_set = blind_set
    aff = set()
    for r in demands:
        for nid in (r.src_id, r.dst_id):
            n = node_lookup.get(nid)
            if n is None:
                continue
            ci = grid.index(n.lon, n.lat)
            if ci is not None and ci in blind_cells_set:
                aff.add(r.req_id)
    for comp in clusters:
        rows = [c // nlon for c in comp]
        cols = [c % nlon for c in comp]
        rmin, rmax = min(rows), max(rows)
        cmin, cmax = min(cols), max(cols)
        # 包围盒（向外扩半格）
        lon_a = grid.lon0 + (cmin) * (grid._dlon())
        lat_a = grid.lat0 + (rmin) * (grid.cell_m / 111320.0)
        lon_b = grid.lon0 + (cmax + 1) * (grid._dlon())
        lat_b = grid.lat0 + (rmax + 1) * (grid.cell_m / 111320.0)
        poly = {
            "type": "Polygon",
            "coordinates": [[
                [round(lon_a, 6), round(lat_a, 6)],
                [round(lon_b, 6), round(lat_a, 6)],
                [round(lon_b, 6), round(lat_b, 6)],
                [round(lon_a, 6), round(lat_b, 6)],
                [round(lon_a, 6), round(lat_a, 6)],
            ]],
        }
        area = len(comp) * cell_area_km2
        out.append({
            "geometry": poly,
            "area_km2": round(area, 3),
            "affected_demand_ids": sorted(aff),
            "suggestion": "该区域覆盖不足，建议增设 1 部中继电台或提升天线挂高",
        })
    # 仅返回面积较大的前若干盲区，避免几何过多
    out.sort(key=lambda z: z["area_km2"], reverse=True)
    return out[:25]


def run_plan(request_body: Dict, progress: Optional[ProgressCb] = None) -> Dict:
    """执行一次部署规划，返回接口契约的 data 体（含 solutions / blind_zones）。

    无可行解时，返回体中带 'infeasible'=True 与 'suggestions'，由上层映射为 code=3001。
    """
    def prog(p, msg):
        if progress:
            progress(p, msg)

    model_id = (request_body.get("device_model_id") or "").strip()
    if not model_id:
        raise ValueError("缺少必填参数 device_model_id")

    coverage_target = request_body.get("coverage_target") or {}
    theta = float(coverage_target.get("required_coverage_ratio", 0.9))
    m_min = float(coverage_target.get("min_link_margin_db", 6.0))
    mode = request_body.get("mode", "MIN_COUNT")
    fixed_count = request_body.get("fixed_count")
    solution_count = int(request_body.get("solution_count", 3))

    prog(0.05, "正在加载节点与候选点数据")
    device_db, antenna_db = load_default_radio_db()
    scenario = build_scenario(
        model_id,
        existing_node_ids=request_body.get("existing_node_ids"),
        comm_demand_ids=request_body.get("comm_demand_ids"),
        candidate_task_id=request_body.get("candidate_task_id"),
        size=request_body.get("size", "demo"),
    )
    band = resolve_band(device_db, model_id)

    sites, requirements, node_lookup, cand_lookup, cand_profile = \
        _build_sites_and_reqs(scenario, device_db, antenna_db, band)
    if not requirements:
        raise ValueError(f"频段 {band} 下无可用通联需求（请检查设备型号与需求表）")
    total_demands = len(requirements)

    grid = _grid_of(scenario["bbox"])
    params = DeploymentParams(hop_limit=2, theta=theta, m_min=m_min)

    prog(0.15, f"数据就绪（节点 {len(node_lookup)} / 候选 {len(cand_lookup)} / 需求 {total_demands}），"
                f"开始计算链路可行性矩阵与覆盖位图")
    terrain = _terrain()
    t0 = time.time()
    plan = plan_deployment(sites, requirements, terrain, grid, params,
                          coverage_method="radial")
    dt = time.time() - t0
    prog(0.9, f"求解完成（{dt:.1f}s），正在生成方案与盲区")

    # 映射方案（覆盖位图直接复用 plan.covers_by_band，避免重复计算）
    band_covers = plan.covers_by_band.get(band, {})
    solutions = []
    any_feasible = False
    all_suggestions = []
    for idx, sch in enumerate(plan.schemes):
        selected = sch.get("selected", [])
        deployments = []
        for sid in selected:
            s = cand_lookup.get(sid)
            if s is None:
                continue
            covers = _covered_from_map(sid, band_covers, grid, requirements, node_lookup)
            deployments.append({
                "site_id": sid,
                "lon": round(s.lon, 6),
                "lat": round(s.lat, 6),
                "node_id_assigned": None,
                "device_model_id": model_id,
                "covers_demand_ids": covers,
            })
        ev = plan.evaluations[idx] if idx < len(plan.evaluations) else {}
        feasible = bool(sch.get("feasible", True))
        if feasible:
            any_feasible = True
        all_suggestions.extend(sch.get("suggestions", []))
        solutions.append({
            "solution_id": f"PL-{idx + 1:04d}",
            "radio_count": len(selected),
            "deployments": deployments,
            "metrics": {
                "coverage_ratio": round(ev.get("coverage_ratio", 0.0), 4),
                "satisfied_demand_count": int(round(ev.get("mandatory_satisfied_rate", 0.0) * total_demands)),
                "total_demand_count": total_demands,
                "deploy_cost": len(selected),
                "max_gap": round(ev.get("max_gap", 0.0), 4),
            },
            "feasible": feasible,
        })

    blind_geo = _blind_zones_to_geojson(plan.blind_zones, grid, requirements,
                                       node_lookup)

    prog(1.0, "完成")
    return {
        "solutions": solutions,
        "blind_zones": blind_geo,
        "blind_summary": {
            "blind_cells": plan.blind_zones.get("blind_cells", 0),
            "blind_ratio": round(plan.blind_zones.get("blind_ratio", 0.0), 4),
            "blind_area_km2": round(plan.blind_zones.get("blind_area_m2", 0.0) / 1e6, 3),
        },
        "band": band,
        "compute_sec": round(dt, 2),
        "infeasible": (not any_feasible),
        "suggestions": sorted(set(all_suggestions)) if all_suggestions else (
            ["约束过严，建议放宽中继跳数上限或增加候选点数量"] if not any_feasible else []),
    }
