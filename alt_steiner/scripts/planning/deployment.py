"""阶段三/四：部署求解（05 方案 4.4 / 4.6）。

P1（最少电台数）：在辅助图上用「顶点权重 Steiner 森林」思路连接待连通分量对，
再按覆盖率阈值贪心补点，最后冗余消除 + 1-交换局部搜索。
P2（给定数量求最优位置）：加权目标贪心 + Teitz-Bart 交换局部搜索。

两频段独立求解（HF / VUHF 不互联），结果合并。
无 ILP 求解器（纯标准库约束），全部为启发式 + 下界（下界见 metrics.py）。

性能说明：连通性查询是求解的主要瓶颈（P2 贪心/Teitz-Bart 要对 186 条需求反复
查询可达性）。本模块用 Reach 把「节点先缩为连通分量、候选点作桥」的小图上的
0-1 BFS 预计算代替逐需求的整图 BFS，使每次 _objective 的连通性判断从 O(需求×图)
降到 O(小图重建 + 需求)，可支撑 ~224 站点 / 186 需求的真实规模（≤5 分钟）。
"""
from __future__ import annotations

import heapq
from collections import deque, OrderedDict
from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple

from .feasibility import FeasibilityMatrix


@dataclass
class Requirement:
    req_id: str
    src_id: str
    dst_id: str
    band: str
    mandatory: bool = True
    weight: float = 1.0


@dataclass
class DeploymentParams:
    m_min: float = 6.0
    hop_limit: int = 2
    theta: float = 0.9
    alpha: float = 1.0
    beta: float = 1.0
    weights_by_priority: Tuple[float, float, float] = (5.0, 3.0, 1.0)
    forced_sites: Set[str] = field(default_factory=set)
    forbidden_sites: Set[str] = field(default_factory=set)


@dataclass
class DeploymentResult:
    selected: List[str]
    satisfied: Dict[str, bool]
    coverage_ratio: float
    blind_cells: int
    feasible: bool
    suggestions: List[str]
    metrics: dict = field(default_factory=dict)


# —— 降维可达性（性能核心） ——

class _ReachResult:
    """某允许候选集下的「≤hop_limit 中继」簇间可达性查询结果。"""

    __slots__ = ("builder", "reach")

    def __init__(self, builder: "Reach", reach: List[Set[int]]):
        self.builder = builder
        self.reach = reach          # reach[clusterA] = {可达的 clusterB 集合}

    def connected_node(self, a: int, b: int) -> bool:
        bld = self.builder
        if a in bld.node_idxs and b in bld.node_idxs:
            ca, cb = bld.cluster_of[a], bld.cluster_of[b]
            return cb in self.reach[ca]
        return False


class Reach:
    """把「节点连通分量 + 候选点桥」的小图上的可达性预计算出来，供海量连通查询复用。

    给定频段的可行性矩阵与节点/候选下标集合，可对任意允许候选集快速回答
    「两节点是否在 ≤hop_limit 个中继(候选)内连通」。节点分量只算一次（与允许集无关）。
    """

    def __init__(self, feas: FeasibilityMatrix, node_idxs: Set[int],
                 cand_idxs: Set[int], hop_limit: int):
        self.feas = feas
        self.n = len(feas.site_ids)
        self.adj = [feas.neighbors(i) for i in range(self.n)]   # 缓存邻居列表
        self.node_idxs = frozenset(node_idxs)
        self.cand_idxs = frozenset(cand_idxs)
        self.hop_limit = hop_limit
        self._cache: "OrderedDict[int, _ReachResult]" = OrderedDict()
        self._cap = 256

        # 1) 节点分量（仅节点间边，与候选点无关，只算一次）
        self.cluster_of = [-1] * self.n
        self._precompute_node_clusters()
        # 2) 每个候选点连接的簇 / 候选邻居（静态）
        self.cand_cluster_edges: Dict[int, frozenset] = {}
        self.cand_cand_edges: Dict[int, frozenset] = {}
        self._precompute_cand_edges()

    def _precompute_node_clusters(self):
        cid = 0
        for u in self.node_idxs:
            if self.cluster_of[u] != -1:
                continue
            stack = [u]
            self.cluster_of[u] = cid
            while stack:
                x = stack.pop()
                for v in self.adj[x]:
                    if v in self.node_idxs and self.cluster_of[v] == -1:
                        self.cluster_of[v] = cid
                        stack.append(v)
            cid += 1
        self.nclusters = cid

    def _precompute_cand_edges(self):
        for c in self.cand_idxs:
            cl = set()
            cc = set()
            for v in self.adj[c]:
                if v in self.node_idxs:
                    cl.add(self.cluster_of[v])
                elif v in self.cand_idxs:
                    cc.add(v)
            self.cand_cluster_edges[c] = frozenset(cl)
            self.cand_cand_edges[c] = frozenset(cc)

    def _oneoff_connected(self, src_cand: int, a: int, b: int, allowed_cands) -> bool:
        """候选点作为端点的兜底连通判断（低频）。"""
        # 小图 0-1 BFS，从 src_cand 出发，候选步代价 1
        ncl = self.nclusters
        cand_list = [c for c in allowed_cands if c in self.cand_idxs]
        cand_pos = {c: i for i, c in enumerate(cand_list)}
        V = ncl + len(cand_list)
        adj_v = [[] for _ in range(V)]
        for i, c in enumerate(cand_list):
            cv = ncl + i
            for cl in self.cand_cluster_edges[c]:
                adj_v[cv].append((cl, False))   # 候选→节点：离开候选，代价 0
                adj_v[cl].append((cv, True))    # 节点→候选：进入候选，代价 1
            for d in self.cand_cand_edges[c]:
                if d in cand_pos:
                    dv = ncl + cand_pos[d]
                    adj_v[cv].append((dv, True))    # 候选→候选：进入新候选，代价 1
                    adj_v[dv].append((cv, True))
        src_v = ncl + cand_pos[src_cand]
        dist = [10 ** 9] * V
        dist[src_v] = 0
        dq = deque([src_v])
        while dq:
            u = dq.popleft()
            du = dist[u]
            for (v, cost) in adj_v[u]:
                nd = du + (1 if cost else 0)
                if nd <= self.hop_limit and nd < dist[v]:
                    dist[v] = nd
                    if cost:
                        dq.append(v)
                    else:
                        dq.appendleft(v)
        # 目标
        if a in self.node_idxs and b in self.node_idxs:
            return self.cluster_of[b] != -1 and dist[self.cluster_of[b]] <= self.hop_limit
        if b in self.node_idxs:
            b, a = a, b
        # 目标也是候选点
        if a in self.node_idxs:
            return dist[self.cluster_of[a]] <= self.hop_limit
        # a,b 均候选
        if b in cand_pos:
            return dist[ncl + cand_pos[b]] <= self.hop_limit
        return False

    def build(self, allowed_cands) -> _ReachResult:
        allowed_cands = frozenset(allowed_cands) & self.cand_idxs
        key = hash(allowed_cands)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        ncl = self.nclusters
        cand_list = [c for c in allowed_cands]
        cand_pos = {c: i for i, c in enumerate(cand_list)}
        V = ncl + len(cand_list)
        adj_v = [[] for _ in range(V)]
        for i, c in enumerate(cand_list):
            cv = ncl + i
            for cl in self.cand_cluster_edges[c]:
                adj_v[cv].append((cl, False))   # 候选→节点：离开候选，代价 0
                adj_v[cl].append((cv, True))    # 节点→候选：进入候选，代价 1
            for d in self.cand_cand_edges[c]:
                if d in cand_pos:
                    dv = ncl + cand_pos[d]
                    adj_v[cv].append((dv, True))    # 候选→候选：进入新候选，代价 1
                    adj_v[dv].append((cv, True))
        reach = [None] * ncl
        for src in range(ncl):
            dist = [10 ** 9] * V
            dist[src] = 0
            dq = deque([src])
            while dq:
                u = dq.popleft()
                du = dist[u]
                for (v, cost) in adj_v[u]:
                    nd = du + (1 if cost else 0)
                    if nd <= self.hop_limit and nd < dist[v]:
                        dist[v] = nd
                        if cost:
                            dq.append(v)
                        else:
                            dq.appendleft(v)
            rs = set()
            for cl in range(ncl):
                if dist[cl] <= self.hop_limit:
                    rs.add(cl)
            reach[src] = rs
        result = _ReachResult(self, reach)
        self._cache[key] = result
        if len(self._cache) > self._cap:
            self._cache.popitem(last=False)
        return result

    def connected(self, a: int, b: int, allowed_cands) -> bool:
        """a,b 是否在允许候选集下 ≤hop_limit 中继内连通。"""
        if a in self.node_idxs and b in self.node_idxs:
            return self.build(allowed_cands).connected_node(a, b)
        # 端点含候选点：以该候选点为源做一次性 0-1 BFS（低频兜底）
        src_cand = a if a in self.cand_idxs else (b if b in self.cand_idxs else None)
        if src_cand is None:
            return False
        return self._oneoff_connected(src_cand, a, b, frozenset(allowed_cands) & self.cand_idxs)


# —— 连通性 / 最短路（顶点权重 Steiner 森林的核心） ——

def _shortest_relay_path(feas: FeasibilityMatrix, src_idx: int, dst_idx: int,
                         node_idxs: Set[int], cand_idxs: Set[int],
                         selected_idxs: Set[int], hop_limit: int):
    """顶点权重最短路：候选点权重 1（已选为 0），节点权重 0。

    返回路径上「中间候选点」的下标列表（不含两端节点）；不可达返回 None。
    受 hop_limit 约束（路径候选中继数 ≤ hop_limit）。
    """
    start = (src_idx, 0)
    best = {}
    parent = {}
    pq = [(0, 0, src_idx)]            # (cost, relays, vertex)
    adj = [feas.neighbors(i) for i in range(len(feas.site_ids))]
    while pq:
        cost, rel, u = heapq.heappop(pq)
        if (u, rel) in best:
            continue
        best[(u, rel)] = cost
        if u == dst_idx:
            path = []
            cur = (u, rel)
            while cur != start:
                pu, prel = parent[cur]
                if pu in cand_idxs and pu != src_idx:
                    path.append(pu)
                cur = (pu, prel)
            path.reverse()
            return path
        for v in adj[u]:
            w = 1 if (v in cand_idxs and v not in selected_idxs) else 0
            nrel = rel + w
            if nrel > hop_limit:
                continue
            nc = cost + w
            if (v, nrel) not in best:
                parent[(v, nrel)] = (u, rel)
                heapq.heappush(pq, (nc, nrel, v))
    return None


# —— P1 ——

def _coverage_union(feas: FeasibilityMatrix, selected: Set[int],
                    covers: Dict[str, int]) -> int:
    u = 0
    for c in selected:
        u |= covers.get(feas.site_ids[c], 0)
    return u


def _mandatory_all_satisfied(reach: Reach, feas, node_idxs, selected, reqs,
                             hop_limit, cand_idxs) -> bool:
    allowed = selected & cand_idxs
    rg = reach.build(allowed)
    for r in reqs:
        if not r.mandatory:
            continue
        si = feas.index[r.src_id]
        di = feas.index[r.dst_id]
        if not rg.connected_node(si, di):
            return False
    return True


def _eliminate_redundant(reach: Reach, feas, node_idxs, selected: Set[int], reqs, covers,
                         grid_size, params, forced_idxs: Set[int],
                         cand_idxs: Set[int]) -> Set[int]:
    """逐个尝试移除已选候选点；若移除后必要需求仍满足且覆盖率仍达标则永久移除。"""
    selected = set(selected)
    cov_theta = params.theta
    changed = True
    while changed:
        changed = False
        for c in list(selected):
            if c in forced_idxs:
                continue
            trial = selected - {c}
            if not _mandatory_all_satisfied(reach, feas, node_idxs, trial, reqs,
                                           params.hop_limit, cand_idxs):
                continue
            if cov_theta > 0:
                union = _coverage_union(feas, trial, covers)
                if bin(union).count("1") / grid_size < cov_theta:
                    continue
            selected.discard(c)
            changed = True
    return selected


def solve_p1_band(reach: Reach, feas: FeasibilityMatrix, node_idxs: Set[int], cand_idxs: Set[int],
                  reqs: List[Requirement], covers: Dict[str, int],
                  grid_size: int, params: DeploymentParams) -> Tuple[Set[int], int]:
    forced_idxs = {feas.index[s] for s in params.forced_sites if s in feas.index}
    forbidden_idxs = {feas.index[s] for s in params.forbidden_sites if s in feas.index}
    cand_pool = [c for c in cand_idxs if c not in forbidden_idxs]

    selected: Set[int] = set(forced_idxs)
    # 迭代：为每条未满足的必要需求补最短中继路径
    progress = True
    while progress:
        progress = False
        for r in reqs:
            if not r.mandatory:
                continue
            si, di = feas.index[r.src_id], feas.index[r.dst_id]
            if reach.connected(si, di, selected):
                continue
            path = _shortest_relay_path(feas, si, di, node_idxs, set(cand_pool),
                                       selected, params.hop_limit)
            if path:
                selected |= set(path)
                progress = True

    # 覆盖率贪心补点
    union = _coverage_union(feas, selected, covers)
    cov = bin(union).count("1") / grid_size if grid_size else 1.0
    while cov < params.theta:
        best_c, best_gain = None, -1
        for c in cand_pool:
            if c in selected:
                continue
            cb = covers.get(feas.site_ids[c], 0)
            gain = bin(cb & ~union).count("1")
            if gain > best_gain:
                best_gain, best_c = gain, c
        if best_c is None or best_gain <= 0:
            break
        selected.add(best_c)
        union |= covers[feas.site_ids[best_c]]
        cov = bin(union).count("1") / grid_size

    selected = _eliminate_redundant(reach, feas, node_idxs, selected, reqs, covers,
                                    grid_size, params, forced_idxs, cand_idxs)
    return selected, union


# —— P2 ——

def _objective(reach: Reach, feas, node_idxs, selected: Set[int], reqs, covers,
               grid_size, params, cand_idxs) -> float:
    rg = reach.build(selected & cand_idxs)
    sat = 0.0
    for r in reqs:
        si, di = feas.index[r.src_id], feas.index[r.dst_id]
        w = r.weight * (params.weights_by_priority[0] if r.mandatory else params.weights_by_priority[2])
        if rg.connected_node(si, di):
            sat += w
    union = _coverage_union(feas, selected, covers)
    cov = bin(union).count("1") / grid_size if grid_size else 0.0
    return params.alpha * sat + params.beta * cov


def solve_p2_band(reach: Reach, feas: FeasibilityMatrix, node_idxs: Set[int], cand_idxs: Set[int],
                  reqs: List[Requirement], covers: Dict[str, int],
                  grid_size: int, params: DeploymentParams, p: int) -> Set[int]:
    forced_idxs = {feas.index[s] for s in params.forced_sites if s in feas.index}
    forbidden_idxs = {feas.index[s] for s in params.forbidden_sites if s in feas.index}
    cand_pool = [c for c in cand_idxs if c not in forbidden_idxs]

    selected: Set[int] = set(forced_idxs)
    # 先保证必要通联连通（与 P1 同机制），避免目标函数的非子模项导致贪心停滞
    progress = True
    while progress:
        progress = False
        for r in reqs:
            if not r.mandatory:
                continue
            si, di = feas.index[r.src_id], feas.index[r.dst_id]
            if reach.connected(si, di, selected):
                continue
            path = _shortest_relay_path(feas, si, di, node_idxs, set(cand_pool), selected, params.hop_limit)
            if path:
                selected |= set(path)
                progress = True
    # 贪心：每轮选边际目标最大的候选点（补足到 p 并优化覆盖/满足率）
    while len(selected) < p:
        best_c, best_delta = None, -1e9
        base = _objective(reach, feas, node_idxs, selected, reqs, covers, grid_size, params, cand_idxs)
        for c in cand_pool:
            if c in selected:
                continue
            delta = (_objective(reach, feas, node_idxs, selected | {c}, reqs, covers, grid_size, params, cand_idxs)
                     - base)
            if delta > best_delta:
                best_delta, best_c = delta, c
        if best_c is None or best_delta <= 0:
            break
        selected.add(best_c)

    # Teitz-Bart 交换局部搜索（first-improvement）
    improved = True
    while improved:
        improved = False
        for s in list(selected):
            if s in forced_idxs:
                continue
            for u in cand_pool:
                if u in selected:
                    continue
                trial = (selected - {s}) | {u}
                if _objective(reach, feas, node_idxs, trial, reqs, covers, grid_size, params, cand_idxs) > \
                   _objective(reach, feas, node_idxs, selected, reqs, covers, grid_size, params, cand_idxs) + 1e-9:
                    selected = trial
                    improved = True
                    break
    return selected


# —— 多方案编排（05 方案 4.7） ——

def generate_schemes(per_band_data: Dict[str, dict], params: DeploymentParams,
                     grid_size: int) -> List[DeploymentResult]:
    """per_band_data: band -> dict(feas, node_idxs, cand_idxs, reqs, covers)。

    方案1=P1最经济；方案2=P2(p_min+1)覆盖优先；方案3=P2(p_min+2)保障优先。
    """
    schemes: List[DeploymentResult] = []

    # P1（各频段合计最少电台）
    p1_selected: List[str] = []
    p1_satisfied: Dict[str, bool] = {}
    p1_union = 0
    p1_feasible = True
    p1_suggestions: List[str] = []
    p1_total = 0
    for band, d in per_band_data.items():
        feas, node_idxs, cand_idxs, reqs, covers = (
            d["feas"], d["node_idxs"], d["cand_idxs"], d["reqs"], d["covers"])
        reach = Reach(feas, node_idxs, cand_idxs, params.hop_limit)
        sel, union = solve_p1_band(reach, feas, node_idxs, cand_idxs, reqs, covers, grid_size, params)
        p1_total += len(sel)
        p1_union |= union
        p1_selected.extend(feas.site_ids[c] for c in sel)
        rg = reach.build(sel & cand_idxs)
        for r in reqs:
            key = f"{band}:{r.req_id}"
            p1_satisfied[key] = rg.connected_node(feas.index[r.src_id], feas.index[r.dst_id])
        if not _mandatory_all_satisfied(reach, feas, node_idxs, sel, reqs, params.hop_limit, cand_idxs):
            p1_feasible = False
            p1_suggestions.append(f"{band} 频段候选点不足或余量门限过高，必要通联无法全满足")
    cov_ratio = bin(p1_union).count("1") / grid_size if grid_size else 0.0
    schemes.append(DeploymentResult(
        selected=p1_selected, satisfied=p1_satisfied, coverage_ratio=cov_ratio,
        blind_cells=grid_size - bin(p1_union).count("1"),
        feasible=p1_feasible, suggestions=p1_suggestions,
        metrics={"plan": "P1-最经济", "count": p1_total}))

    # P2 覆盖优先 / 保障优先
    for offset, name in [(1, "P2-覆盖优先"), (2, "P2-保障优先")]:
        sel_all: List[str] = []
        total = 0
        union = 0
        satisfied: Dict[str, bool] = {}
        for band, d in per_band_data.items():
            feas, node_idxs, cand_idxs, reqs, covers = (
                d["feas"], d["node_idxs"], d["cand_idxs"], d["reqs"], d["covers"])
            reach = Reach(feas, node_idxs, cand_idxs, params.hop_limit)
            p = p1_total + offset
            sel = solve_p2_band(reach, feas, node_idxs, cand_idxs, reqs, covers, grid_size, params, p)
            total += len(sel)
            union |= _coverage_union(feas, sel, covers)
            sel_all.extend(feas.site_ids[c] for c in sel)
            rg = reach.build(sel & cand_idxs)
            for r in reqs:
                satisfied[f"{band}:{r.req_id}"] = rg.connected_node(feas.index[r.src_id], feas.index[r.dst_id])
        cov = bin(union).count("1") / grid_size if grid_size else 0.0
        schemes.append(DeploymentResult(
            selected=sel_all, satisfied=satisfied, coverage_ratio=cov,
            blind_cells=grid_size - bin(union).count("1"), feasible=True,
            suggestions=[], metrics={"plan": name, "count": total}))

    return schemes
