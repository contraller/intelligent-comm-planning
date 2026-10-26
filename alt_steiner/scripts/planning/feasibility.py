"""阶段一：预计算链路可行性矩阵（05 方案 4.2）。

把「昂贵且需反复查询」的链路预算一次性算完，后续组合搜索只做位运算。

- 短波(HF)与超短波(VUHF)是两张互不连通的子网，分别建矩阵。
- 可行性用 Python 大整数位图存储：feasible[i] 的第 j 位 = 站点 i 与站点 j 链路可行。
  位运算由 C 实现，比 list/set 快一个数量级以上，且无需第三方包。
- 同时保留 margin[i][j] 用于后续排序与方案评估。

注：节点×节点链路设计文档 4.2 称「已在 link.csv 中，直接复用」，此处为自包含
直接计算（规模仅约 3 万对，代价可忽略），后续可改为读 link.csv 覆盖。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List

from .model import Site, link_margin


@dataclass
class FeasibilityMatrix:
    """单一频段内的全点对可行性结构。"""

    band: str
    site_ids: List[str]                          # 该频段所有站点（节点+候选点）
    index: Dict[str, int] = field(default_factory=dict)
    feasible: List[int] = field(default_factory=list)    # 位图，每行一个大整数
    margin: List[List[float]] = field(default_factory=list)
    m_min: float = 6.0

    def __post_init__(self):
        if not self.index and self.site_ids:
            self.index = {sid: i for i, sid in enumerate(self.site_ids)}

    def is_link(self, i: int, j: int) -> bool:
        return bool((self.feasible[i] >> j) & 1)

    def neighbors(self, i: int) -> List[int]:
        """返回站点 i 所有可达站点下标（位图遍历）。"""
        bits = self.feasible[i]
        out = []
        while bits:
            lsb = bits & -bits
            out.append(lsb.bit_length() - 1)
            bits ^= lsb
        return out

    def feasibility_count(self, i: int) -> int:
        return bin(self.feasible[i]).count("1")


def _build_band(sites: List[Site], terrain, m_min: float, hour: int) -> FeasibilityMatrix:
    """对单一频段站点集合计算可行性矩阵。"""
    n = len(sites)
    margin = [[0.0] * n for _ in range(n)]
    feasible = [0] * n
    for i in range(n):
        for j in range(i + 1, n):
            m = link_margin(terrain, sites[i], sites[j], hour)
            margin[i][j] = margin[j][i] = m
            if m >= m_min:
                feasible[i] |= (1 << j)
                feasible[j] |= (1 << i)
    return FeasibilityMatrix(
        band=sites[0].band if sites else "",
        site_ids=[s.site_id for s in sites],
        feasible=feasible,
        margin=margin,
        m_min=m_min,
    )


def compute_feasibility(sites: List[Site], terrain,
                        m_min: float = 6.0, hour: int = 12,
                        bands: tuple = ("HF", "VUHF")) -> Dict[str, FeasibilityMatrix]:
    """按频段拆分站点，分别建可行性矩阵。

    返回 {band: FeasibilityMatrix}。两频段互不连通，分别规划（05 方案 3.2）。
    """
    by_band: Dict[str, List[Site]] = {b: [] for b in bands}
    for s in sites:
        key = s.band.upper() if s.band.upper() in by_band else None
        if key is None:
            # 未知频段归并到最近匹配（VUHF 兜底）
            key = "VUHF" if not s.band.upper().startswith("H") else "HF"
        by_band[key].append(s)

    result = {}
    for b, slist in by_band.items():
        if slist:
            result[b] = _build_band(slist, terrain, m_min, hour)
    return result


def feasibility_summary(matrices: Dict[str, FeasibilityMatrix]) -> dict:
    out = {}
    for b, m in matrices.items():
        out[b] = {
            "band": b,
            "site_count": len(m.site_ids),
            "avg_degree": sum(m.feasibility_count(i) for i in range(len(m.site_ids))) / max(1, len(m.site_ids)),
            "m_min": m.m_min,
        }
    return out
