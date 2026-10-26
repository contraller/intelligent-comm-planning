"""阶段五：方案评估指标与下界（05 方案 4.5）。

启发式必须能自证质量，故输出两个下界：
  LB1（分量合并下界）：必要通联涉及的连通分量共 q 个需并为若干组，单个候选点最多
       直接连接 δ_max 个不同分量，则所需电台数 ≥ ceil((q - g) / (δ_max - 1))。
  LB2（覆盖下界）：单个候选点覆盖格点数上限 c_max，未被固定站覆盖的格点数 n_u，
       则达到覆盖率 θ 所需 ≥ ceil((θ|A| - 已覆盖) / c_max)。

取两者较大值为 LB，报告 gap = (|X| - LB) / LB。
另提供小规模精确校验钩子（|S| ≤ 18 且最优 ≤ 3 时枚举对照）。
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Dict, List, Set

from .feasibility import FeasibilityMatrix
from .deployment import Reach


@dataclass
class Evaluation:
    count: int
    mandatory_satisfied_rate: float
    all_satisfied_rate_weighted: float
    coverage_ratio: float
    blind_cells: int
    blind_area_km2: float
    avg_margin_db: float
    max_hops: int
    lower_bound: int
    gap: float
    metrics: dict = field(default_factory=dict)


def _components(feas: FeasibilityMatrix, allowed: Set[int]) -> Dict[int, int]:
    """在允许顶点集上做并查集，返回 顶点下标 -> 分量编号。"""
    parent = {v: v for v in allowed}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for u in allowed:
        for v in feas.neighbors(u):
            if v in allowed:
                ru, rv = find(u), find(v)
                if ru != rv:
                    parent[ru] = rv
    comp = {v: find(v) for v in allowed}
    # 重映射为 0..k-1
    remap = {}
    out = {}
    for v, c in comp.items():
        if c not in remap:
            remap[c] = len(remap)
        out[v] = remap[c]
    return out


def _shortest_hops(reach, feas, src_idx, dst_idx, allowed: Set[int], cand_idxs: Set[int], hop_limit: int) -> int:
    """返回 src->dst 的最少中继数（≤hop_limit 内），不可达返回 -1。"""
    if src_idx == dst_idx:
        return 0
    if not reach.connected(src_idx, dst_idx, allowed):
        return -1
    # 在已判定可达后做 BFS 求最少中继
    from collections import deque
    best = {src_idx: 0}
    q = deque([src_idx])
    while q:
        u = q.popleft()
        ru = best[u]
        if u == dst_idx:
            return ru
        for v in feas.neighbors(u):
            if v in allowed:
                rv = ru + (1 if v in cand_idxs else 0)
                if rv > hop_limit:
                    continue
                if v not in best or rv < best[v]:
                    best[v] = rv
                    q.append(v)
    return -1


def evaluate_band(feas: FeasibilityMatrix, node_idxs: Set[int], selected_idxs: Set[int],
                  cand_idxs: Set[int], reqs, covers: Dict[str, int],
                  grid_size: int, params, fixed_site_ids: Set[str]) -> Evaluation:
    allowed = node_idxs | selected_idxs
    # 需求满足
    w_mand = params.weights_by_priority[0]
    w_all = params.weights_by_priority[2]
    mand_total = mand_done = 0.0
    all_total = all_done = 0.0
    max_hops = 0
    reach = Reach(feas, node_idxs, cand_idxs, params.hop_limit)
    for r in reqs:
        hops = _shortest_hops(reach, feas, feas.index[r.src_id], feas.index[r.dst_id], allowed, cand_idxs, params.hop_limit)
        done = 1.0 if hops >= 0 else 0.0
        w = w_mand if r.mandatory else w_all
        all_total += w
        all_done += w * done
        if r.mandatory:
            mand_total += w
            mand_done += w * done
            if hops > 0:
                max_hops = max(max_hops, hops)

    union = 0
    for c in selected_idxs:
        union |= covers.get(feas.site_ids[c], 0)
    cov = bin(union).count("1") / grid_size if grid_size else 0.0
    blind = grid_size - bin(union).count("1")

    # 平均余量：selected 关联的可行链路余量均值
    margin_sum = cnt = 0
    for c in selected_idxs:
        for v in feas.neighbors(c):
            if v in allowed:
                margin_sum += feas.margin[c][v]
                cnt += 1
    avg_margin = margin_sum / cnt if cnt else 0.0

    lb = _lower_bounds(feas, node_idxs, selected_idxs, cand_idxs, reqs, covers, grid_size, params, fixed_site_ids)
    gap = (len(selected_idxs) - lb) / lb if lb > 0 else 0.0
    return Evaluation(
        count=len(selected_idxs),
        mandatory_satisfied_rate=mand_done / mand_total if mand_total else 1.0,
        all_satisfied_rate_weighted=all_done / all_total if all_total else 1.0,
        coverage_ratio=cov, blind_cells=blind,
        blind_area_km2=blind * (params._cell_area if hasattr(params, "_cell_area") else 0.0),
        avg_margin_db=avg_margin, max_hops=max_hops,
        lower_bound=lb, gap=gap,
    )


def _lower_bounds(feas, node_idxs, selected_idxs, cand_idxs, reqs, covers, grid_size, params, fixed_site_ids) -> int:
    allowed = node_idxs | selected_idxs
    comps = _components(feas, allowed)
    # LB1：必要通联涉及的分量数 q
    q = set()
    for r in reqs:
        if not r.mandatory:
            continue
        q.add(comps[feas.index[r.src_id]])
        q.add(comps[feas.index[r.dst_id]])
    # δ_max：单个候选点连接的不同分量数
    delta_max = 1
    for c in cand_idxs - selected_idxs:
        touched = {comps[n] for n in feas.neighbors(c) if n in allowed}
        delta_max = max(delta_max, len(touched))
    g = 1  # 目标合并为 1 组
    lb1 = max(0, (len(q) - g)) // max(1, delta_max - 1) if delta_max > 1 else max(0, len(q) - g)
    lb1 = max(lb1, 0)

    # LB2：覆盖下界
    fixed_union = 0
    for sid in fixed_site_ids:
        if sid in feas.index:
            fixed_union |= covers.get(sid, 0)
    c_max = 0
    for c in cand_idxs:
        if c in selected_idxs or True:
            cb = covers.get(feas.site_ids[c], 0)
            c_max = max(c_max, bin(cb).count("1"))
    n_u = grid_size - bin(fixed_union).count("1")
    target = params.theta * grid_size
    lb2 = max(0, int((target - bin(fixed_union).count("1")) / c_max)) if c_max > 0 else 0

    return max(lb1, lb2)


def exact_optimal_if_small(feas: FeasibilityMatrix, cand_idxs: List[int], reqs, covers, grid_size, params, max_cand=18, max_pick=3) -> int:
    """小规模精确校验：枚举所有组合求精确最少电台数（仅用于回归测试）。

    返回精确最优；候选点超过 max_cand 或最优预期超过 max_pick 时返回 -1（跳过）。
    """
    if len(cand_idxs) > max_cand:
        return -1
    node_idxs = set(range(len(feas.site_ids))) - set(cand_idxs)
    reach = Reach(feas, node_idxs, set(cand_idxs), params.hop_limit)
    best = len(cand_idxs) + 1
    found = False
    for p in range(0, min(max_pick, len(cand_idxs)) + 1):
        for combo in itertools.combinations(cand_idxs, p):
            sel = set(combo)
            ok = True
            for r in reqs:
                if not r.mandatory:
                    continue
                if not reach.connected(feas.index[r.src_id], feas.index[r.dst_id], node_idxs | sel):
                    ok = False
                    break
            if ok:
                best = p
                found = True
                break
        if found:
            break
    return best if found else -1
