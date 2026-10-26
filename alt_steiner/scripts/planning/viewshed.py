"""阶段二：覆盖位图与盲区（05 方案 4.3）。

规划区按 Δ≈1 km 栅格化，对每个站点（固定站 + 候选点）计算其覆盖的格点集合，存为位图。
全部站点覆盖位图取并集后，未置位的格点即为盲区（满足 SR-4.2.1 扩展流 1）。

提供两种实现：
  - compute_coverage_exact：逐格点做链路预算，绝对正确，作为对照与小规模测试用。
  - compute_coverage_radial：R3 变体径向视域，沿射线增量跟踪地平线角，仅对通视格点
    调用链路预算，避免逐点重算整条剖面，用于生产规模（05 方案 4.3，预计 4–6 秒）。

两者在 LOS 判定上等价；exact 对每格点都算链路预算，radial 通过「升起角 > 当前最大角」
剪枝掉遮挡格点，显著降低调用次数。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List

from terrain import haversine_m
from .model import Site, link_margin

_R_EARTH = 6371008.8
_K = 4.0 / 3.0


@dataclass
class CoverageGrid:
    """规划区栅格（经度方向步长按中纬近似，足够覆盖计算）。"""

    lon0: float
    lat0: float
    lon1: float
    lat1: float
    nlon: int
    nlat: int
    cell_m: float

    @staticmethod
    def from_bbox(bbox, cell_m: float = 1000.0) -> "CoverageGrid":
        lon0, lat0, lon1, lat1 = bbox
        dlat = cell_m / 111320.0
        nlat = max(1, int((lat1 - lat0) / dlat) + 1)
        midlat = (lat0 + lat1) / 2.0
        dlon = cell_m / (111320.0 * math.cos(math.radians(midlat)))
        nlon = max(1, int((lon1 - lon0) / dlon) + 1)
        return CoverageGrid(lon0, lat0, lon1, lat1, nlon, nlat, cell_m)

    @property
    def size(self) -> int:
        return self.nlon * self.nlat

    @property
    def cell_area_m2(self) -> float:
        return self.cell_m * self.cell_m

    def _dlon(self) -> float:
        midlat = (self.lat0 + self.lat1) / 2.0
        return self.cell_m / (111320.0 * math.cos(math.radians(midlat)))

    def index(self, lon: float, lat: float):
        dlon = self._dlon()
        dlat = self.cell_m / 111320.0
        col = int((lon - self.lon0) / dlon)
        row = int((lat - self.lat0) / dlat)
        if 0 <= col < self.nlon and 0 <= row < self.nlat:
            return row * self.nlon + col
        return None

    def cell_lonlat(self, idx: int):
        row = idx // self.nlon
        col = idx % self.nlon
        dlon = self._dlon()
        dlat = self.cell_m / 111320.0
        return (self.lon0 + (col + 0.5) * dlon, self.lat0 + (row + 0.5) * dlat)


def compute_coverage_exact(sites: List[Site], terrain, grid: CoverageGrid,
                           m_min: float = 6.0, hour: int = 12,
                           max_range_m: Optional[float] = None) -> List[int]:
    """逐格点链路预算，返回每站点的覆盖位图。正确但代价高，用于对照/小网格。

    max_range_m 给定时，超出该作用距离的格点直接跳过（与径向法对齐）。
    """
    covers = [0] * len(sites)
    probe = None
    for si, site in enumerate(sites):
        if probe is None:
            probe = Site(site_id=site.site_id + "#probe", lon=site.lon, lat=site.lat,
                        band=site.band, profile=site.profile, kind="probe")
        for ci in range(grid.size):
            lon, lat = grid.cell_lonlat(ci)
            if max_range_m is not None and haversine_m(site.lon, site.lat, lon, lat) > max_range_m:
                continue
            probe.lon, probe.lat = lon, lat
            if link_margin(terrain, site, probe, hour) >= m_min:
                covers[si] |= (1 << ci)
    return covers


def compute_coverage_radial(sites: List[Site], terrain, grid: CoverageGrid,
                           m_min: float = 6.0, hour: int = 12,
                           max_range_m: float = 120000.0,
                           d_theta_deg: float = 2.0,
                           d_r_m: float = 250.0) -> List[int]:
    """R3 变体径向视域：沿射线增量地平线角剪枝，仅对通视格点算链路预算。

    关键正确性约束：每格点只评估一次（done 位图缓存），且余量在『格点中心』计算，
    因此径向覆盖必为精确覆盖的子集；HF（地波/NVIS 不看 LOS）不做通视剪枝，
    仅 VUHF 才按升起角剪枝。
    """
    covers = [0] * len(sites)
    n_theta = max(1, int(360.0 / d_theta_deg))
    probe = None
    for si, site in enumerate(sites):
        s_elev = terrain.elevation(site.lon, site.lat)
        is_hf = site.band.upper().startswith("H")
        done = 0                                     # 已评估格点位图（每格点只算一次）
        if probe is None:
            probe = Site(site_id=site.site_id + "#probe", lon=site.lon, lat=site.lat,
                        band=site.band, profile=site.profile, kind="probe")
        for ti in range(n_theta):
            theta = math.radians(ti * d_theta_deg)
            cos_t, sin_t = math.cos(theta), math.sin(theta)
            max_ang = -1e18
            r = d_r_m
            while r <= max_range_m:
                dlat = (r * cos_t) / 111320.0
                dlon = (r * sin_t) / (111320.0 * math.cos(math.radians(site.lat)))
                lon, lat = site.lon + dlon, site.lat + dlat
                ci = grid.index(lon, lat)
                if ci is None:
                    r += d_r_m
                    continue
                if (done >> ci) & 1:                  # 该格点已被某射线评估过
                    r += d_r_m
                    continue
                done |= (1 << ci)
                if haversine_m(site.lon, site.lat, lon, lat) > max_range_m:
                    r += d_r_m
                    continue
                ground = terrain.elevation(lon, lat)
                bulge = r * r / (2.0 * _R_EARTH * _K)
                ang = math.atan2(ground + bulge - s_elev, r)
                visible = is_hf or (ang > max_ang)    # HF 不看 LOS
                if ang > max_ang:
                    max_ang = ang
                if visible:
                    clon, clat = grid.cell_lonlat(ci)  # 在格点中心评估余量
                    probe.lon, probe.lat = clon, clat
                    if link_margin(terrain, site, probe, hour) >= m_min:
                        covers[si] |= (1 << ci)
                r += d_r_m
    return covers


def compute_coverage(sites: List[Site], terrain, grid: CoverageGrid,
                    m_min: float = 6.0, hour: int = 12,
                    method: str = "radial",
                    max_range_m: Optional[float] = None) -> List[int]:
    if method == "exact":
        return compute_coverage_exact(sites, terrain, grid, m_min, hour, max_range_m)
    return compute_coverage_radial(sites, terrain, grid, m_min, hour,
                                   max_range_m=max_range_m or 120000.0)


def union_coverage(covers: List[int]) -> int:
    u = 0
    for c in covers:
        u |= c
    return u


def blind_zones(union: int, grid: CoverageGrid) -> dict:
    """由覆盖并集位图求盲区统计与未覆盖格点下标。"""
    total = grid.size
    covered = bin(union).count("1")
    blind_cells = total - covered
    return {
        "total_cells": total,
        "covered_cells": covered,
        "blind_cells": blind_cells,
        "blind_area_m2": blind_cells * grid.cell_area_m2,
        "blind_ratio": blind_cells / total if total else 0.0,
        "blind_idx": [i for i in range(total) if not (union >> i) & 1],
    }
