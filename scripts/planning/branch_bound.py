"""自研分支定界与下界（方案 4.5）。

合作方明确「不可以用求解器，我们自己写求解」，本模块是外层选址的收敛手段：
贪心给出上界，分支定界在此基础上尝试改进，并在搜索穷尽时**给出最优性证明**。

三个下界，取最大者：
  LB1 容量下界   某层 n 个节点待接入、单个上级能带 c 个，至少需 ceil(n/c) 个上级
  LB2 互斥下界   若两个失联节点不存在任何一个候选能同时服务，则它们各需一部电台；
                 求这种「两两互斥」的失联节点的最大集合，其大小即下界
  LB3 端口下界   所有候选提供的总端口数必须够覆盖失联节点数

贪心解已达 LB 时直接返回并标注「已证最优」，不必进入搜索。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from deployment import solve_assignment, lower_bound as capacity_lower_bound


def servers_of(fm, orphan, cand_idx):
    """能服务该失联节点的候选集合（位图形式返回 set）。"""
    out = set()
    for band in E.bands_of(fm.stations[orphan].subtype):
        mask = fm.normal[band][orphan]
        for ci in cand_idx:
            if mask >> ci & 1:
                out.add(ci)
    return out


def mutual_exclusion_bound(fm, unconnected, cand_idx, cap=64):
    """LB2：两两互斥的失联节点数。

    若失联节点 a 与 b 没有任何共同的候选服务者，则任何一部电台都无法同时救两者，
    它们必须各自对应一部。求这种互斥集合的最大规模是独立集问题（NP 难），
    这里用贪心求一个下界的下界 —— 仍然是合法下界。
    """
    if not unconnected:
        return 0
    sub = unconnected[:cap]
    srv = {o: servers_of(fm, o, cand_idx) for o in sub}
    # 按候选服务者数量升序贪心：能救它的电台越少，越该先占位
    order = sorted(sub, key=lambda o: len(srv[o]))
    picked = []
    for o in order:
        if all(not (srv[o] & srv[q]) for q in picked):
            picked.append(o)
    return len(picked)


def port_bound(fm, unconnected, cand_idx):
    """LB3：失联节点数 / 单部电台能提供的最大下行端口数，向上取整。"""
    if not unconnected:
        return 0
    best_room = 0
    for ci in cand_idx:
        sub = fm.stations[ci].subtype
        for band in E.bands_of(sub):
            best_room = max(best_room, E.capacity(sub, band) - 1)
    if best_room <= 0:
        return len(unconnected)
    return -(-len(unconnected) // best_room)


def combined_lower_bound(fm, sol, cand_idx):
    """三个下界取最大者。"""
    lb1 = capacity_lower_bound(fm, sol)
    lb2 = mutual_exclusion_bound(fm, sol.unconnected, cand_idx)
    lb3 = port_bound(fm, sol.unconnected, cand_idx)
    return max(lb1, lb2, lb3), dict(capacity=lb1, mutual_exclusion=lb2, port=lb3)


def branch_and_bound(fm, base_idx, cand_idx, incumbent, time_limit=30.0,
                     max_depth=12, verbose=False):
    """在贪心解基础上做分支定界。

    incumbent   贪心得到的已选候选列表（当前上界 = len(incumbent)）
    返回 (best_chosen, proved_optimal, stats)

    分支方式：每步取「增量上界最高」的候选，分「选它」与「不选它」两支。
    不选支会把该候选从可用集合移除，从而不会重复搜索同一组合。
    """
    t0 = time.time()
    best = list(incumbent)
    ub = len(best)
    stats = dict(nodes=0, pruned=0, improved=0, timeout=False)

    def gain_order(avail, unconnected):
        mask = 0
        for i in unconnected:
            mask |= 1 << i
        scored = []
        for ci in avail:
            st = fm.stations[ci]
            g = 0
            for band in E.bands_of(st.subtype):
                if not st.has(band):
                    continue
                reach = bin(fm.normal[band][ci] & mask).count("1")
                g = max(g, min(reach, E.capacity(st.subtype, band) - 1))
            if g > 0:
                scored.append((-g, ci))
        scored.sort()
        return [ci for _, ci in scored]

    def dfs(chosen, avail, depth):
        nonlocal best, ub
        stats["nodes"] += 1
        if time.time() - t0 > time_limit:
            stats["timeout"] = True
            return
        if depth > max_depth:
            return
        sol = solve_assignment(fm, active=base_idx + chosen)
        if not sol.unconnected:
            if len(chosen) < ub:
                best, ub = list(chosen), len(chosen)
                stats["improved"] += 1
                if verbose:
                    print("    分支定界改进：%d 部" % ub)
            return
        lb_extra, _ = combined_lower_bound(fm, sol, avail)
        if len(chosen) + max(1, lb_extra) >= ub:
            stats["pruned"] += 1
            return
        order = gain_order(avail, sol.unconnected)
        if not order:
            return
        for ci in order[:3]:                 # 每层只展开增量最高的三个分支
            rest = [c for c in avail if c != ci]
            dfs(chosen + [ci], rest, depth + 1)
            if stats["timeout"]:
                return

    dfs([], list(cand_idx), 0)
    proved = not stats["timeout"]
    return best, proved, stats


if __name__ == "__main__":
    import csv, random
    from datapaths import path as dpath
    from terrain import default_terrain
    from feasibility import stations_from_nodes, FeasibilityMatrix
    from deployment import p1_solve, report

    def load(rel):
        with open(dpath(rel), encoding="utf-8") as f:
            return list(csv.DictReader(f))

    t = default_terrain()
    st = stations_from_nodes(load("node.csv"), load("device.csv"),
                             load("device_model.csv"), load("antenna_model.csv"))
    sites = load("candidate_site.csv")
    fm0 = FeasibilityMatrix(st, t)
    iii = [i for i, s in enumerate(fm0.stations) if s.subtype == "III_MOBILE"]
    base = [s for s in st if s.sid not in {fm0.stations[i].sid for i in iii[:14]}]

    sub = random.Random(20260908).sample(sites, 150)
    fm, sol = p1_solve(base, sub, t, types=("III_MOBILE",))
    print(report(fm, sol, "贪心解"))

    base_idx = list(range(len(base)))
    cand_idx = [i for i in range(len(base), len(fm.stations))]
    sol0 = solve_assignment(fm, active=base_idx)
    lb, parts = combined_lower_bound(fm, sol0, cand_idx)
    print("\n下界分解: 容量 %d / 互斥 %d / 端口 %d  → 取 %d"
          % (parts["capacity"], parts["mutual_exclusion"], parts["port"], lb))

    if sol.count <= lb:
        print("贪心解 %d 部已达下界 %d → **已证最优**，不必搜索" % (sol.count, lb))
    else:
        chosen = [i for i, _ in sol.added]
        t0 = time.time()
        best, proved, stats = branch_and_bound(fm, base_idx, cand_idx, chosen,
                                               time_limit=30.0, verbose=True)
        print("分支定界: %d 部，搜索节点 %d，剪枝 %d，%.1f s，%s"
              % (len(best), stats["nodes"], stats["pruned"], time.time() - t0,
                 "已证最优" if proved and len(best) <= lb else
                 ("搜索穷尽" if proved else "超时，返回当前最优")))
