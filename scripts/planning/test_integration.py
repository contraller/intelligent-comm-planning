"""端到端集成测试：plan_deployment 完整流水线（可行性→覆盖→P1/P2→评估）。

运行：python3 scripts/planning/test_integration.py
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

from terrain import default_terrain
from planning.model import Site
from planning.radio_db import default_profile_for_band
from planning.viewshed import CoverageGrid
from planning.deployment import Requirement, DeploymentParams
from planning.solve import plan_deployment

BBOX = (114.0465, 36.5815, 115.8532, 38.0187)
LAT = (BBOX[1] + BBOX[3]) / 2
A_LON = 114.2465
GAP = 0.905
CLONS = [114.4465, 114.6465, 114.8465]


def _hf_sites():
    prof = default_profile_for_band("HF")
    A = Site("HF_FA", A_LON, LAT, "HF", prof, kind="fixed")
    B = Site("HF_FB", A_LON + GAP, LAT, "HF", prof, kind="fixed")
    cands = [Site(f"HF_C{i}", lon, LAT, "HF", prof, kind="candidate")
             for i, lon in enumerate(CLONS)]
    return [A, B] + cands


def test_end_to_end():
    terrain = default_terrain(verbose=False)
    sites = _hf_sites()
    grid = CoverageGrid.from_bbox(BBOX, cell_m=2000.0)
    reqs = [Requirement("R1", "HF_FA", "HF_FB", "HF", mandatory=True)]
    params = DeploymentParams(hop_limit=2, theta=0.9)
    plan = plan_deployment(sites, reqs, terrain, grid, params, coverage_method="radial")

    assert len(plan.schemes) == 3, "应生成 3 种方案"
    assert len(plan.evaluations) == 3
    # 方案1（最经济）必要需求应满足
    ev0 = plan.evaluations[0]
    assert ev0["mandatory_satisfied_rate"] == 1.0, "方案1 必要需求应满足"
    # 多方案电台数应单调不减（最经济 ≤ 覆盖优先 ≤ 保障优先）
    counts = [e["count"] for e in plan.evaluations]
    assert counts[0] <= counts[1] <= counts[2], f"方案电台数应非减，实际 {counts}"
    # 盲区统计
    assert "blind_cells" in plan.blind_zones
    print(f"  [OK] 端到端：方案数={len(plan.schemes)} 电台数={counts} "
          f"方案1满足率={ev0['mandatory_satisfied_rate']} 盲区={plan.blind_zones['blind_cells']}格")


def main():
    print("=== 端到端集成测试 ===")
    test_end_to_end()
    print("=== 全部通过 ===")


if __name__ == "__main__":
    main()
