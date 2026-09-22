"""部署规划编排器：把阶段一~五串成完整流水线（05 方案第 4 节）。

HTTP 接口层（algorithm-service/app/deployment.py）将调用本模块的 plan_deployment，
并负责从 data_loader 读取真实节点/候选点/需求，再把结果适配为接口契约。

本模块与数据来源解耦：只接收 Site 列表与 Requirement 列表，便于纯标准库下自包含测试，
也便于接入真实数据后直接复用。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from .feasibility import compute_feasibility
from .viewshed import CoverageGrid, compute_coverage, blind_zones
from .deployment import Requirement, DeploymentParams, generate_schemes
from .metrics import evaluate_band


@dataclass
class BandPlan:
    band: str
    scheme_selected: List[str]          # 该频段被选中的候选点 site_id
    evaluation: dict = field(default_factory=dict)


@dataclass
class DeploymentPlan:
    schemes: List[dict]                 # generate_schemes 的原始结果
    evaluations: List[dict] = field(default_factory=list)
    blind_zones: dict = field(default_factory=dict)
    covers_by_band: Dict[str, dict] = field(default_factory=dict)   # band -> {site_id: 覆盖位图}
    progress_stages: tuple = ("feasibility", "viewshed", "solve", "evaluate")


def plan_deployment(sites: List, requirements: List[Requirement], terrain, grid: CoverageGrid,
                    params: DeploymentParams, coverage_method: str = "radial") -> DeploymentPlan:
    """端到端规划：返回多方案 + 每方案评估 + 盲区。"""
    # 阶段一：链路可行性矩阵（分频段）
    mats = compute_feasibility(sites, terrain, params.m_min, hour=12)

    per_band: Dict[str, dict] = {}
    for band, feas in mats.items():
        band_sites = [s for s in sites if s.band == band]
        node_idxs = {feas.index[s.site_id] for s in band_sites if s.kind != "candidate"}
        cand_idxs = {feas.index[s.site_id] for s in band_sites if s.kind == "candidate"}
        cand_sites = [s for s in band_sites if s.kind == "candidate"]
        # 阶段二：覆盖位图（候选点）
        covers = compute_coverage(cand_sites, terrain, grid, params.m_min,
                                 method=coverage_method, max_range_m=200000.0)
        covers_map = {s.site_id: covers[i] for i, s in enumerate(cand_sites)}
        band_reqs = [r for r in requirements if r.band == band]
        per_band[band] = dict(feas=feas, node_idxs=node_idxs, cand_idxs=cand_idxs,
                              reqs=band_reqs, covers=covers_map)

    # 阶段三/四：多方案
    schemes = generate_schemes(per_band, params, grid.size)

    # 阶段五：评估每方案
    evaluations = []
    blind = blind_zones(union_over_all_selected(schemes, per_band), grid) if schemes else {}
    for sch in schemes:
        ev = _evaluate_scheme(sch, per_band, params, grid)
        evaluations.append(ev)

    covers_by_band = {b: d["covers"] for b, d in per_band.items()}
    return DeploymentPlan(schemes=[_sch_to_dict(s) for s in schemes],
                          evaluations=evaluations, blind_zones=blind,
                          covers_by_band=covers_by_band)


def union_over_all_selected(schemes, per_band) -> int:
    u = 0
    for sch in schemes:
        for band, d in per_band.items():
            feas = d["feas"]
            for sid in sch.selected:
                if sid in feas.index and d["covers"].get(sid, 0):
                    u |= d["covers"][sid]
    return u


def _evaluate_scheme(sch, per_band, params, grid):
    ev_out = {"plan": sch.metrics.get("plan"), "count": sch.metrics.get("count")}
    mand_rates, covs, gaps = [], [], []
    for band, d in per_band.items():
        feas = d["feas"]
        sel_idxs = {feas.index[sid] for sid in sch.selected if sid in feas.index}
        node_idxs = d["node_idxs"]
        cand_idxs = d["cand_idxs"]
        fixed = {s.site_id for s in []}  # 真实数据中固定站由 kind='fixed' 标记，此处由调用方补充
        # 固定站覆盖并入（若有 covers）
        ev = evaluate_band(feas, node_idxs, sel_idxs, cand_idxs, d["reqs"],
                           d["covers"], grid.size, params, fixed_site_ids=fixed)
        mand_rates.append(ev.mandatory_satisfied_rate)
        covs.append(ev.coverage_ratio)
        gaps.append(ev.gap)
    ev_out["mandatory_satisfied_rate"] = sum(mand_rates) / len(mand_rates) if mand_rates else 1.0
    ev_out["coverage_ratio"] = max(covs) if covs else 0.0
    ev_out["max_gap"] = max(gaps) if gaps else 0.0
    return ev_out


def _sch_to_dict(sch) -> dict:
    return {
        "plan": sch.metrics.get("plan"),
        "selected": sch.selected,
        "coverage_ratio": sch.coverage_ratio,
        "blind_cells": sch.blind_cells,
        "feasible": sch.feasible,
        "suggestions": sch.suggestions,
    }
