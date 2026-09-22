"""规模测试（方案第 5 章「规模」项，甲方指标 ≤5 分钟 / 失效重规划 ≤3 分钟）。

按软需 SR-4.2 f 的上限口径实测：短波节点 ≥50、超短波节点 ≥100、
规划区 ≤120 km × 120 km，候选位置全量、四种可部署类型全开。
"""
import csv
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from datapaths import path as dpath
from terrain import default_terrain
from feasibility import stations_from_nodes, FeasibilityMatrix
from deployment import (p1_solve, p2_solve, multi_plan, solve_assignment,
                        replan_incremental)
from metrics import evaluate


def load(rel):
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main():
    print("=" * 72)
    print("规模测试  —— 甲方指标：满负荷规划 ≤300 s，20% 节点失效重规划 ≤180 s")
    print("=" * 72)
    steps = []

    t0 = time.time()
    terrain = default_terrain(verbose=False)
    nodes, devices = load("node.csv"), load("device.csv")
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    sites, demands = load("candidate_site.csv"), load("comm_demand.csv")
    st = stations_from_nodes(nodes, devices, models, antennas)
    steps.append(("加载数据与地形", time.time() - t0))

    hf = sum(1 for n in nodes if "HF" in n["device_class"].split(";"))
    vu = sum(1 for n in nodes if "VUHF" in n["device_class"].split(";"))
    print("\n规模：节点 %d（持短波 %d / 持超短波 %d）  设备 %d 台  "
          "候选位置 %d × 类型 %d = %d 个候选  通联需求 %d 条"
          % (len(nodes), hf, vu, len(devices), len(sites),
             len(E.DEPLOYABLE_TYPES), len(sites) * len(E.DEPLOYABLE_TYPES),
             len(demands)))
    print("软需 SR-4.2 f 下限：短波 ≥50 %s   超短波 ≥100 %s"
          % ("✓" if hf >= 50 else "✗", "✓" if vu >= 100 else "✗"))

    # 制造一个真需要部署的场景：撤走一半 Ⅲ 机动站
    fm0 = FeasibilityMatrix(st, terrain)
    iii = [i for i, s in enumerate(fm0.stations) if s.subtype == "III_MOBILE"]
    dead = {fm0.stations[i].sid for i in iii[:len(iii) // 2]}
    base = [s for s in st if s.sid not in dead]
    print("场景：撤走 %d 个 Ⅲ 机动站，基线台站 %d 个" % (len(dead), len(base)))

    t0 = time.time()
    fm, p1 = p1_solve(base, sites, terrain, refine=True)
    steps.append(("P1 全量求解（含建矩阵、惰性贪心、分支定界）", time.time() - t0))

    base_idx = list(range(len(base)))
    cand_idx = list(range(len(base), len(fm.stations)))

    t0 = time.time()
    plans = multi_plan(fm, base_idx, cand_idx, p1)
    steps.append(("多方案生成（3 套）", time.time() - t0))

    t0 = time.time()
    evs = [evaluate(fm, pl["sol"], demands=demands) for pl in plans]
    steps.append(("方案评估 + %d 条需求路径核算 × 3" % len(demands),
                  time.time() - t0))

    total = sum(d for _, d in steps)
    print("\n%-46s %8s" % ("阶段", "耗时 s"))
    for name, d in steps:
        print("%-46s %8.1f" % (name, d))
    print("%-46s %8.1f   [指标 ≤300]  %s"
          % ("合计（满负荷规划）", total, "达标 ✓" if total <= 300 else "超标 ✗"))

    print("\n方案对比：")
    for pl, ev in zip(plans, evs):
        d = ev["demands"]
        print("  %-14s 电台 %d  连通 %.0f%%  需求 %d/%d  最差余量 %.0f dB  "
              "有备份上级 %d"
              % (pl["name"], ev["added"], 100 * ev["connectivity"],
                 d["reachable"], d["total"], ev["margin_min"] or 0, ev["backup"]))

    # 20% 节点失效重规划
    import random
    print("\n20%% 节点失效增量重规划（3 组随机种子）：")
    sol_full = solve_assignment(fm, active=base_idx + [i for i, _ in p1.added])
    worst = 0.0
    for seed in (1, 7, 42):
        rng = random.Random(seed)
        act = sorted(sol_full.active)
        failed = rng.sample(act, int(len(act) * 0.2))
        t0 = time.time()
        new = replan_incremental(fm, sol_full, failed)
        el = time.time() - t0
        worst = max(worst, el)
        print("  seed=%-3d 失效 %d  受影响 %d  重规划后失联 %d  耗时 %.2f s"
              % (seed, len(failed), len(new.affected), len(new.unconnected), el))
    print("  最慢 %.2f s   [指标 ≤180]  %s"
          % (worst, "达标 ✓" if worst <= 180 else "超标 ✗"))
    print("=" * 72)


if __name__ == "__main__":
    main()
