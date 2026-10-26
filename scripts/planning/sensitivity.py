"""传播模型绝对量偏差的敏感性分析（待办 #14 的处理）。

P.368 未与官方曲线定标、P.533 电离层参数为假定值、P.372 未含大气噪声——
这三条在拿到官方曲线或实测数据之前关不掉。能做的是回答：
**假如模型整体偏差 ±3 / ±6 dB，规划结论会变多少？**

做法：给全部链路预算统一加偏差（`propagation.LOSS_BIAS_DB`），
重跑第 2 周部署规划（P1 最少电台数），比较可行链路数、需新增电台数与连通率。
偏差对所有链路一视同仁，是最坏情形的粗估——真实误差分频段、分距离，
短波与超短波各自的偏差方向也可能相反。

跑法：
    python3 scripts/planning/sensitivity.py
"""
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import propagation
import echelon as E
from datapaths import path as dpath
from terrain import default_terrain
from feasibility import stations_from_nodes
from deployment import p1_solve

OFFSETS_DB = (-6.0, -3.0, 0.0, 3.0, 6.0)


def orphan_split(fm, sol, base_n):
    """把失联节点分成两类，二者含义完全不同，不能合在一起报「不可达」：

    - no_candidate：候选池里**没有任何**位置能与它建合法链路——换哪里都够不着，
      只能放宽门限、换设备或扩大候选范围；
    - chain_needed：有候选能够到它，但那个候选自己接不上去。P1 外层贪心每步只看
      单个候选的增益，这类要两级中继串起来才生效的情形它看不到，会停在这里。
      这是**算法局限**，不等于物理上不可达。
    """
    no_cand, chain = 0, 0
    for i in sol.unconnected:
        st = fm.stations[i]
        reach = any(j >= base_n for band in E.BANDS if st.has(band)
                    for j in fm.neighbors(i, band))
        if reach:
            chain += 1
        else:
            no_cand += 1
    return no_cand, chain


def load(rel):
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def run(offsets=OFFSETS_DB, verbose=True):
    terrain = default_terrain(verbose=False)
    nodes, devices = load("node.csv"), load("device.csv")
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    sites = load("candidate_site.csv")
    st = stations_from_nodes(nodes, devices, models, antennas)
    rows = []
    try:
        for off in offsets:
            propagation.LOSS_BIAS_DB = off
            t0 = time.time()
            fm, sol = p1_solve(st, sites, terrain, refine=False)
            base_n = len(st)
            links = {b: 0 for b in E.BANDS}
            for i in range(base_n):
                for b in E.BANDS:
                    links[b] += sum(1 for j in fm.neighbors(i, b) if j < base_n and j > i)
            act = sol.active or set(range(len(fm.stations)))
            no_cand, chain = orphan_split(fm, sol, base_n)
            rows.append(dict(offset_db=off, added=sol.count,
                             connectivity=round(len(sol.connected) / max(1, len(act)), 4),
                             unconnected=len(sol.unconnected),
                             unconnected_no_candidate=no_cand,
                             unconnected_chain_needed=chain,
                             legal_links_hf=links[E.HF], legal_links_vuhf=links[E.VUHF],
                             seconds=round(time.time() - t0, 1)))
            if verbose:
                r = rows[-1]
                print("  偏差 %+5.1f dB  可行且合法链路 HF %4d / VUHF %4d  新增电台 %2d  "
                      "连通率 %.3f  失联 %d（候选够不着 %d / 需两级中继 %d）  (%.0f s)"
                      % (off, r["legal_links_hf"], r["legal_links_vuhf"], r["added"],
                         r["connectivity"], r["unconnected"], no_cand, chain, r["seconds"]))
    finally:
        propagation.LOSS_BIAS_DB = 0.0
    return rows


if __name__ == "__main__":
    print("=" * 78)
    print("传播模型绝对量偏差敏感性（第 2 周部署规划 P1）")
    print("正值 = 真实损耗比模型大（模型偏乐观）")
    print("=" * 78)
    run()
    print("=" * 78)
