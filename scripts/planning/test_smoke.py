"""规划包冒烟测试：在无真实 DEM 环境下用合成地形跑通阶段一/二。

两种运行方式均可：
  1) 脚本：python3 scripts/planning/test_smoke.py        （从 /workspace 执行）
  2) pytest：python3 -m pytest scripts/planning/test_smoke.py -q
"""
import math
import os
import sys
import time

import pytest  # noqa: F401

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))  # scripts/

from terrain import default_terrain
from planning.model import Site, RadioProfile
from planning.radio_db import (
    load_default_radio_db, profile_for_device, default_profile_for_band,
)
from planning.feasibility import compute_feasibility, feasibility_summary
from planning.viewshed import (
    CoverageGrid, compute_coverage_exact,
    compute_coverage_radial, union_coverage, blind_zones,
)

# 合成地形覆盖范围（与 terrain.BBOX_DATA 一致）
BBOX = (114.0465, 36.5815, 115.8532, 38.0187)


def _make_sites(n_fixed, n_task, n_cand, band, seed_off=0.0):
    sites = []
    lon0, lat0, lon1, lat1 = BBOX
    span_lon = lon1 - lon0
    span_lat = lat1 - lat0
    k = 0

    def coord(i):
        # 确定性散布，避免随机
        t = (i * 0.137 + seed_off) % 1.0
        u = (i * 0.311 + seed_off) % 1.0
        return lon0 + span_lon * (0.15 + 0.7 * t), lat0 + span_lat * (0.15 + 0.7 * u)

    prof = default_profile_for_band(band)
    for i in range(n_fixed):
        lon, lat = coord(k); k += 1
        sites.append(Site(f"{band}_F{i}", lon, lat, band, prof, kind="fixed"))
    for i in range(n_task):
        lon, lat = coord(k); k += 1
        sites.append(Site(f"{band}_T{i}", lon, lat, band, prof, kind="task"))
    for i in range(n_cand):
        lon, lat = coord(k); k += 1
        sites.append(Site(f"{band}_C{i}", lon, lat, band, prof, kind="candidate"))
    return sites


def _build_feas_data():
    """构建冒烟测试共用的地形/站点/可行性矩阵（同时被 fixture 与 main 复用）。"""
    terrain = default_terrain(verbose=False)
    sites = _make_sites(2, 3, 3, "HF", seed_off=0.0) + \
            _make_sites(2, 3, 3, "VUHF", seed_off=0.5)
    mats = compute_feasibility(sites, terrain, m_min=6.0, hour=12)

    assert "HF" in mats and "VUHF" in mats, "应分两个频段建矩阵"
    assert mats["HF"].site_ids and mats["VUHF"].site_ids
    # 位图对称性检查
    hf = mats["HF"]
    for i in range(len(hf.site_ids)):
        for j in hf.neighbors(i):
            assert hf.is_link(j, i), "可行性位图必须对称"
    # 自环不应存在（i 与自身不计）
    for i in range(len(hf.site_ids)):
        assert not hf.is_link(i, i), "不应与自身连通"
    return mats, sites, terrain


@pytest.fixture(scope="module")
def feas_data():
    return _build_feas_data()


def test_radio_db():
    dev_db, ant_db = load_default_radio_db()
    assert len(dev_db) == 16, f"device 应有 16 行，实际 {len(dev_db)}"
    assert len(ant_db) >= 16, "antenna 至少 16 行"
    p = profile_for_device(dev_db, ant_db, "DM-0001")
    assert p is not None and p.band == "HF", "DM-0001 应为 HF"
    assert abs(p.tx_power_dbm - 43.01) < 1e-6, "DM-0001 发射功率应为 43.01 dBm"
    assert p.antenna_pattern in ("NVIS", "OMNI")
    print("  [OK] radio_db：device 16/HF DM-0001 tx=43.01 接入正确")


def test_feasibility(feas_data):
    mats, sites, terrain = feas_data
    hf = mats["HF"]
    dt = 0.0  # 矩阵已在 fixture 中构建，这里仅做结构断言与汇报
    assert "HF" in mats and "VUHF" in mats, "应分两个频段建矩阵"
    assert len(hf.site_ids) > 0
    print(f"  [OK] feasibility：HF {len(mats['HF'].site_ids)} 点 / "
          f"VUHF {len(mats['VUHF'].site_ids)} 点")
    print(f"       摘要: {feasibility_summary(mats)}")


def test_viewshed(feas_data):
    mats, sites, terrain = feas_data
    # 仅用候选点做覆盖（与方案 4.3 一致：候选点覆盖位图）
    cands = [s for s in sites if s.kind == "candidate"]
    grid = CoverageGrid.from_bbox(BBOX, cell_m=2000.0)  # 测试用 2km 网格，加速
    print(f"  [信息] CoverageGrid 规模 {grid.nlon}x{grid.nlat} = {grid.size} 格点")

    t0 = time.time()
    cov_exact = compute_coverage_exact(cands, terrain, grid, m_min=6.0, max_range_m=200000.0)
    dt_exact = time.time() - t0
    t0 = time.time()
    cov_radial = compute_coverage_radial(cands, terrain, grid, m_min=6.0, max_range_m=200000.0)
    dt_radial = time.time() - t0

    u_exact = union_coverage(cov_exact)
    u_radial = union_coverage(cov_radial)
    n_exact = bin(u_exact).count("1")
    n_radial = bin(u_radial).count("1")
    # 径向应为精确的子集（径向只沿射线采样，可能漏掉射线间的格点）
    assert (u_radial & u_exact) == u_radial, "径向覆盖必须是精确覆盖的子集"
    assert n_radial >= 0.6 * n_exact, f"径向覆盖不应显著少于精确（{n_radial}/{n_exact}）"

    bz = blind_zones(u_exact, grid)
    print(f"  [OK] viewshed：exact {dt_exact*1000:.1f} ms / radial {dt_radial*1000:.1f} ms")
    print(f"       覆盖格点 exact={n_exact} radial={n_radial}，盲区 {bz['blind_cells']} "
          f"格（{bz['blind_ratio']*100:.1f}%），盲区面积 {bz['blind_area_m2']/1e6:.1f} km²")


def main():
    print("=== 规划包冒烟测试（合成地形）===")
    test_radio_db()
    data = _build_feas_data()
    test_feasibility(data)
    test_viewshed(data)
    print("=== 全部通过 ===")


if __name__ == "__main__":
    main()
