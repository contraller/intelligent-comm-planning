"""部署求解单元测试：用小算例验证 P1/P2（合成地形，HF 地波只看距离，确定性）。

运行：python3 scripts/planning/test_deployment.py
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))

from terrain import default_terrain
from planning.model import Site
from planning.radio_db import default_profile_for_band
from planning.feasibility import compute_feasibility
from planning.deployment import (
    Requirement, DeploymentParams, Reach, solve_p1_band, solve_p2_band, generate_schemes,
)
from planning.metrics import evaluate_band, exact_optimal_if_small

BBOX = (114.0465, 36.5815, 115.8532, 38.0187)
# 沿纬线布置：节点 A、B 相距约 80 km（HF 地波不可直连），
# 候选点 c1..c3 间距约 18–27 km（均可连），验证 P1 需选中继才能连通 A-B。
_LAT = (BBOX[1] + BBOX[3]) / 2
_A_LON = 114.2465
_NODE_GAP = 0.905          # ≈ 80 km
_CAND_LONS = [114.4465, 114.6465, 114.8465]   # 位于 A、B 之间


def _hf_sites():
    prof = default_profile_for_band("HF")
    A = Site("HF_FA", _A_LON, _LAT, "HF", prof, kind="fixed")
    B = Site("HF_FB", _A_LON + _NODE_GAP, _LAT, "HF", prof, kind="fixed")
    cands = [Site(f"HF_C{i}", lon, _LAT, "HF", prof, kind="candidate")
             for i, lon in enumerate(_CAND_LONS)]
    return [A, B] + cands


def test_p1_connects_via_relay():
    terrain = default_terrain(verbose=False)
    sites = _hf_sites()
    mats = compute_feasibility(sites, terrain, m_min=6.0, hour=12)
    feas = mats["HF"]
    # 直连 A-B 应不可行（80 km 地波余量不足）；A 与候选、候选间应可行
    assert not feas.is_link(0, 1), "A-B 直连应不可行（80km）"
    assert feas.is_link(0, 2), "A-c1 应可行"
    assert feas.is_link(4, 1), "c3-B 应可行"

    node_idxs = {0, 1}
    cand_idxs = {2, 3, 4}
    reqs = [Requirement("R1", "HF_FA", "HF_FB", "HF", mandatory=True, weight=5.0)]
    params = DeploymentParams(hop_limit=2, theta=0.0)   # 关闭覆盖，仅测连通
    reach = Reach(feas, node_idxs, cand_idxs, params.hop_limit)
    selected, union = solve_p1_band(reach, feas, node_idxs, cand_idxs, reqs, {}, 1, params)

    assert selected, "P1 必须选中至少一个中继候选点"
    # 验证选中的候选点确实把 A、B 连通
    assert reach.connected(0, 1, selected), "P1 后应 A-B 连通"
    print(f"  [OK] P1：选中中继 {[feas.site_ids[c] for c in selected]}，A-B 已连通")


def test_p2_count():
    terrain = default_terrain(verbose=False)
    sites = _hf_sites()
    feas = compute_feasibility(sites, terrain, m_min=6.0)["HF"]
    node_idxs, cand_idxs = {0, 1}, {2, 3, 4}
    reqs = [Requirement("R1", "HF_FA", "HF_FB", "HF", mandatory=True, weight=5.0)]
    params = DeploymentParams(hop_limit=2, theta=0.0)
    reach = Reach(feas, node_idxs, cand_idxs, params.hop_limit)
    sel = solve_p2_band(reach, feas, node_idxs, cand_idxs, reqs, {}, 1, params, p=2)
    assert len(sel) == 2, f"P2 应恰好选 2 个点，实际 {len(sel)}"
    print(f"  [OK] P2：定数 2 选中 {[feas.site_ids[c] for c in sel]}")


def test_generate_schemes():
    terrain = default_terrain(verbose=False)
    sites = _hf_sites()
    feas = compute_feasibility(sites, terrain, m_min=6.0)["HF"]
    per_band = {
        "HF": dict(feas=feas, node_idxs={0, 1}, cand_idxs={2, 3, 4},
                   reqs=[Requirement("R1", "HF_FA", "HF_FB", "HF", mandatory=True)],
                   covers={}),
    }
    params = DeploymentParams(hop_limit=2, theta=0.0)
    schemes = generate_schemes(per_band, params, grid_size=1)
    assert len(schemes) == 3, f"应生成 3 种方案，实际 {len(schemes)}"
    assert schemes[0].feasible, "方案1（最经济）应可行"
    print(f"  [OK] 多方案：{[(s.metrics['plan'], s.metrics['count']) for s in schemes]}")


def test_metrics():
    terrain = default_terrain(verbose=False)
    sites = _hf_sites()
    feas = compute_feasibility(sites, terrain, m_min=6.0)["HF"]
    node_idxs, cand_idxs = {0, 1}, {2, 3, 4}
    reqs = [Requirement("R1", "HF_FA", "HF_FB", "HF", mandatory=True)]
    params = DeploymentParams(hop_limit=2, theta=0.0)
    reach = Reach(feas, node_idxs, cand_idxs, params.hop_limit)
    selected, _ = solve_p1_band(reach, feas, node_idxs, cand_idxs, reqs, {}, 1, params)
    ev = evaluate_band(feas, node_idxs, selected, cand_idxs, reqs, {}, 1, params,
                       fixed_site_ids={"HF_FA", "HF_FB"})
    assert ev.mandatory_satisfied_rate == 1.0, "必要需求应满足率 1.0"
    exact = exact_optimal_if_small(feas, [2, 3, 4], reqs, {}, 1, params)
    assert exact == len(selected), f"精确最优 {exact} 应等于启发式 {len(selected)}"
    print(f"  [OK] metrics：满足率 {ev.mandatory_satisfied_rate} LB={ev.lower_bound} "
          f"gap={ev.gap:.2f} 精确最优={exact}")


def main():
    print("=== 部署求解单元测试 ===")
    test_p1_connects_via_relay()
    test_p2_count()
    test_generate_schemes()
    test_metrics()
    print("=== 全部通过 ===")


if __name__ == "__main__":
    main()
