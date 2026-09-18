"""移动电台部署规划 P1 求解（SR-4.2.1.2 a/b，方案 4.4）。

目标：**最少电台数，使所有节点连通到根**。覆盖率不参与优化
（合作方答复 5+6：「覆盖指的是联通就行，覆盖率不需要计算，以全连通为唯一目标」）。

── 求解结构 ──────────────────────────────────────────────
外层：选址（离散，贪心 + 局部搜索）
内层：每一层的「谁挂谁」= 带容量的二部图匹配，由 flow.assign_parents 精确求解

内层为什么是精确的：一层的指派是标准 b-匹配，最大流给出最优解，
不存在启发式误判可行性的风险。启发式只出现在外层「往哪儿加电台」。

── 层序（自底向上）──────────────────────────────────────
  Ⅳ            → Ⅲ                      cdb
  Ⅲ            → Ⅱ机动站 / Ⅱ机动节点站   cdb
  Ⅲ(剩余)      → 已接入的 Ⅲ（借道中继）  db     ← 合作方口头补充
  Ⅱ机动站/节点站 → Ⅱ固定站                db
  Ⅱ固定站      → Ⅰ                       db
  a车 / b车     → Ⅰ机动站                 db
  背负式        → a车 / b车                db

端口占用：节点 u 在频段 b 上 = (u 自己的上行占 1) + (挂在 u 下面的下级数) <= cap(u,b)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from feasibility import FeasibilityMatrix
from flow import assign_parents

# (下级子类型集合, 上级子类型集合, 频段, 说明)
LAYER_PLAN = [
    (("IV_MOBILE",), ("III_MOBILE",), E.VUHF, "Ⅳ 接入 Ⅲ"),
    (("III_MOBILE",), ("II_MOBILE", "II_NODE"), E.VUHF, "Ⅲ 上行 Ⅱ"),
    (("II_MOBILE", "II_NODE"), ("II_FIXED",), E.HF, "Ⅱ行3 上行 Ⅱ固定站"),
    (("II_FIXED",), ("I_FIXED", "I_MOBILE"), E.HF, "Ⅱ固定站 上行 Ⅰ"),
    (("VEHICLE_A", "VEHICLE_B"), ("I_MOBILE",), E.HF, "机动车 上行 Ⅰ机动站"),
    (("MANPACK",), ("VEHICLE_A", "VEHICLE_B"), E.HF, "背负式 上行 机动车"),
]

# Ⅲ 层内借道中继：上一步没配上 Ⅱ 的 Ⅲ，可挂已接入的 Ⅲ（用空闲的 db 端口）
PEER_RELAY = ("III_MOBILE", E.HF)


class Solution:
    def __init__(self):
        self.parent_of = {}       # child_idx -> (parent_idx, band)
        self.connected = set()    # 已连通到根的台站下标
        self.unconnected = []
        self.ports = {}           # (idx, band) -> 已占用端口数
        self.added = []           # 新增部署 [(station_idx, subtype)]
        self.layer_log = []
        self.active = set()       # 参与本次求解的台站下标（失效节点不在其中）
        self.lower_bound = 0      # 容量下界：至少需要新增几部电台
        self.gap = None           # (实得 - 下界) / 下界

    @property
    def count(self):
        return len(self.added)


def _ports_left(sol, fm, idx, band):
    cap = E.capacity(fm.stations[idx].subtype, band)
    return cap - sol.ports.get((idx, band), 0)


def _take(sol, idx, band, k=1):
    sol.ports[(idx, band)] = sol.ports.get((idx, band), 0) + k


# 每个子类型的上行频段，由 LAYER_PLAN 反推
UPLINK_BAND = {}
for _cs, _ps, _b, _ in LAYER_PLAN:
    for _s in _cs:
        UPLINK_BAND[_s] = _b


def solve_assignment(fm, active=None, damaged=False):
    """对给定台站集合跑一遍分层指派，返回 Solution。

    active 为 None 时取全部台站；否则只有这些下标参与（用于试探性部署）。

    **端口记账**：每个非根节点在建链之前先**预留 1 个上行端口**。
    否则会出现这种错误——先跑 Ⅳ→Ⅲ 这一层时 Ⅲ 的 4 个 cdb 口全空，
    贪心把 4 个 Ⅳ 都挂上去，等轮到 Ⅲ 自己上行时已无端口可用，
    而代码若只检查上级余量、不检查下级余量，就会错误地判为配上了。
    """
    sol = Solution()
    n = len(fm.stations)
    act = set(range(n)) if active is None else set(active)
    sol.active = act
    by_sub = {}
    for i in act:
        by_sub.setdefault(fm.stations[i].subtype, []).append(i)

    # 根天然连通
    for sub in E.ROOT_SUBTYPES:
        sol.connected.update(by_sub.get(sub, []))

    # 预留上行端口：非根节点各占自己上行频段的 1 个端口
    for i in act:
        b = UPLINK_BAND.get(fm.stations[i].subtype)
        if b and fm.stations[i].subtype not in E.ROOT_SUBTYPES:
            _take(sol, i, b)

    def run_layer(children, parents, band, label):
        children = [c for c in children if c not in sol.parent_of]
        if not children or not parents:
            if children:
                sol.layer_log.append((label, len(children), 0, len(children)))
            return {}, children
        pset = set(parents)
        cand, prefer = {}, {}
        for c in children:
            opts = []
            for p in fm.neighbors(c, band, damaged=damaged):
                if p not in act or p not in pset:
                    continue
                opts.append(p)
                m = fm.margin_of(c, p, band)
                prefer[(c, p)] = -(m or 0.0)        # 余量大者优先
            if opts:
                cand[c] = opts
        left = {p: _ports_left(sol, fm, p, band) for p in parents}
        asg, un = assign_parents(children, parents, cand, left, prefer)
        for c, p in asg.items():
            sol.parent_of[c] = (p, band)
            _take(sol, p, band)      # 上级挂一个下级占 1 个端口；下级的上行端口已预留
        sol.layer_log.append((label, len(children), len(asg), len(un)))
        return asg, un

    for child_subs, parent_subs, band, label in LAYER_PLAN:
        children = [i for s in child_subs for i in by_sub.get(s, [])]
        parents = [i for s in parent_subs for i in by_sub.get(s, [])]
        asg, un = run_layer(children, parents, band, label)

        # Ⅲ 层：没配上 Ⅱ 的，尝试借道已配上的 Ⅲ（改用 db 端口），迭代到不动点
        if child_subs == ("III_MOBILE",) and un:
            sub, pband = PEER_RELAY
            for c in un:                     # 上行频段由 cdb 改为 db，预留随之转移
                _take(sol, c, band, -1)
                _take(sol, c, pband, 1)
            changed = True
            while changed and un:
                changed = False
                placed = [i for i in by_sub.get(sub, []) if i in sol.parent_of]
                if not placed:
                    break
                a2, un2 = run_layer(un, placed, pband, "Ⅲ 借道邻近 Ⅲ 中继")
                if a2:
                    changed = True
                un = un2

    # 沿 parent 链能到根的才算连通
    memo = {}

    def reaches_root(i, seen=None):
        if i in sol.connected:
            return True
        if i in memo:
            return memo[i]
        seen = seen or set()
        if i in seen:
            return False
        seen.add(i)
        par = sol.parent_of.get(i)
        r = reaches_root(par[0], seen) if par else False
        memo[i] = r
        if r:
            sol.connected.add(i)
        return r

    for i in act:
        reaches_root(i)
    sol.unconnected = sorted(i for i in act if i not in sol.connected)
    return sol


def diagnose(fm, sol):
    """无解诊断（方案 4.4）。

    四类原因分开报，因为**建议完全不同**：
      物理不可达   → 放宽余量门限 / 提高天线高度 / 加中继
      层级不允许   → 启用作战损伤工况 / 调整编成归属（放宽余量门限对它无效）
      端口已用尽   → 增设同级节点分担，而不是挪位置
      无合法上级   → 该层上级全部失效，必须新增该类型电台
    """
    out = []
    act = sol.active or set(range(len(fm.stations)))
    for i in sol.unconnected:
        s_ = fm.stations[i]
        reasons = []
        for band in E.bands_of(s_.subtype):
            live = [j for j in fm.neighbors(i, band) if j in act]
            live_phys = [j for j in fm.neighbors(i, band, damaged=True) if j in act]
            blocked = len(live_phys) - len(live)
            if not live_phys:
                reasons.append("%s 物理不可达（在役对端中无余量达标者）" % band)
            elif not live:
                reasons.append("%s 层级不允许（物理能通 %d 个在役对端，全被编成规则挡住）"
                               % (band, blocked))
            else:
                full = sum(1 for j in live if _ports_left(sol, fm, j, band) <= 0)
                if full == len(live):
                    kinds = sorted({fm.stations[j].subtype for j in live})
                    reasons.append("%s 上级端口已用尽（%d 个在役合法上级全满，类型 %s）"
                                   % (band, len(live), "/".join(kinds)))
                else:
                    reasons.append("%s 有 %d 个可用上级却未接入——需核查求解过程"
                                   % (band, len(live) - full))
        if not reasons:
            reasons = ["该层无任何在役合法上级，须新增对应类型电台"]
        out.append(dict(station=s_.sid, subtype=s_.subtype, reasons=reasons))
    return out


def report(fm, sol, title="部署求解"):
    lines = ["%s：台站 %d，连通 %d，失联 %d，新增电台 %d"
             % (title, len(sol.active or fm.stations), len(sol.connected),
                len(sol.unconnected), sol.count)]
    for label, ch, ok, un in sol.layer_log:
        lines.append("   %-22s 待接入 %3d  配上 %3d  未配 %3d" % (label, ch, ok, un))
    if sol.lower_bound or sol.added:
        g = "—" if sol.gap is None else ("%.0f%%" % (100 * sol.gap))
        lines.append("   容量下界 %d 部，实得 %d 部，gap %s%s"
                     % (sol.lower_bound, sol.count, g,
                        "  （达到下界，本场景最优）" if sol.gap == 0 else ""))
    if sol.added:
        lines.append("   新增部署：")
        for idx, sub in sol.added:
            st = fm.stations[idx]
            lines.append("     %-10s %-12s %.4f, %.4f" % (st.sid, sub, st.lon, st.lat))
    if sol.unconnected:
        lines.append("   失联节点诊断：")
        for d in diagnose(fm, sol)[:8]:
            lines.append("     %-10s %-12s %s" % (d["station"], d["subtype"],
                                                  "；".join(d["reasons"])))
    return "\n".join(lines)


# ────────────────────── 外层：选址 ──────────────────────
def candidate_stations(rows, subtype, id_prefix="CS"):
    """把候选点表变成某一类型的待部署台站。

    同一个候选位置放不同类型的电台，射频参数不同（功率 400/125/20 W 相差 26 dB），
    因此按 (位置, 类型) 成对生成，而不是按位置。
    """
    from feasibility import Station
    out = []
    for r in rows:
        radio = {}
        for band in E.bands_of(subtype):
            radio[band] = dict(
                tx_dbm=E.SUBTYPE_POWER.get((subtype, band), 47.0),
                gain=-2.0 if band == E.HF else 0.0,     # 鞭状天线，保守取值
                height=6.0 if E.SUBTYPE_MOBILITY[subtype] == "VEHICLE" else 2.5,
                sens=-110.0 if band == E.HF else -116.0,
                bw=3.0 if band == E.HF else 25.0,
                pattern="OMNI", fmin=1600.0 if band == E.HF else 30000.0,
                fmax=29999.0 if band == E.HF else 88000.0)
        out.append(Station("%s-%s-%s" % (id_prefix, subtype[:3], r["site_id"]),
                           float(r["lon"]), float(r["lat"]), subtype, radio,
                           is_candidate=True))
    return out


def p1_solve(base_stations, candidate_rows, terrain, types=E.DEPLOYABLE_TYPES,
             margin_min=None, max_add=30, verbose=False):
    """P1：最少电台数，使所有节点连通到根。

    外层贪心：每轮试开设每个候选，取「新连通节点数」最大者；平局时取代价低的类型。
    内层每次都重跑分层 b-匹配 —— 可行性判定是精确的，启发式只在「往哪儿加」。
    """
    from feasibility import FeasibilityMatrix
    kw = {} if margin_min is None else dict(margin_min=margin_min)

    # 只有 Ⅲ 机动站带超短波，是 Ⅳ 接入的唯一手段；其余三类只能补 db 侧
    pool = []
    for sub in types:
        pool.extend(candidate_stations(candidate_rows, sub))
    if verbose:
        print("  候选 (位置 × 类型) 共 %d 个" % len(pool))

    all_st = list(base_stations) + pool
    fm = FeasibilityMatrix(all_st, terrain, verbose=verbose, **kw)
    base_idx = list(range(len(base_stations)))
    cand_idx = list(range(len(base_stations), len(all_st)))

    chosen = []
    sol = solve_assignment(fm, active=base_idx)
    lb = lower_bound(fm, sol)          # 下界必须在**部署前**的失联集合上算
    if verbose:
        print("  未部署时失联 %d 个，容量下界 %d 部" % (len(sol.unconnected), lb))
    while sol.unconnected and len(chosen) < max_add:
        best = None
        for ci in cand_idx:
            if ci in chosen:
                continue
            trial = solve_assignment(fm, active=base_idx + chosen + [ci])
            gain = len(sol.unconnected) - len(trial.unconnected)
            if gain <= 0:
                continue
            cost = E.DEPLOY_COST[fm.stations[ci].subtype]
            key = (-gain, cost)
            if best is None or key < best[0]:
                best = (key, ci, trial)
        if best is None:
            break                       # 再加也无增益 → 无可行解，交给 diagnose
        _, ci, trial = best
        chosen.append(ci)
        sol = trial
        if verbose:
            st = fm.stations[ci]
            print("    + %-12s %s  → 失联 %d"
                  % (st.subtype, st.sid, len(sol.unconnected)))

    # 冗余消除：逐个试着撤掉，仍全连通则永久撤
    for ci in list(chosen):
        rest = [x for x in chosen if x != ci]
        t2 = solve_assignment(fm, active=base_idx + rest)
        if len(t2.unconnected) <= len(sol.unconnected):
            chosen = rest
            sol = t2

    sol.added = [(ci, fm.stations[ci].subtype) for ci in chosen]
    sol.lower_bound = lb
    sol.gap = None if lb == 0 else (sol.count - lb) / float(lb)
    return fm, sol


def lower_bound(fm, sol):
    """下界（方案 4.5 下界 1）：按容量给出必须新增的电台数下限。

    某层有 n 个节点待接入，单个上级在该频段能带 c 个下级（容量减去自己的上行），
    则至少需要 ceil(n / c) 个上级。
    """
    need = 0
    act = sol.active or set(range(len(fm.stations)))
    for child_subs, parent_subs, band, _ in LAYER_PLAN:
        orphans = [i for i in sol.unconnected
                   if fm.stations[i].subtype in child_subs]
        if not orphans:
            continue
        psub = parent_subs[0]
        c = E.capacity(psub, band) - (1 if psub not in E.ROOT_SUBTYPES else 0)
        if c > 0:
            need += -(-len(orphans) // c)        # ceil
    return need


if __name__ == "__main__":
    import csv, time
    from datapaths import path as dpath
    from terrain import default_terrain
    from feasibility import stations_from_nodes

    def load(rel):
        with open(dpath(rel), encoding="utf-8") as f:
            return list(csv.DictReader(f))

    t = default_terrain()
    st = stations_from_nodes(load("node.csv"), load("device.csv"),
                             load("device_model.csv"), load("antenna_model.csv"))
    t0 = time.time()
    fm = FeasibilityMatrix(st, t, verbose=True)
    print("  建矩阵 %.2f s" % (time.time() - t0))

    t1 = time.time()
    sol = solve_assignment(fm)
    print("\n" + report(fm, sol, "正常工况（仅用现有节点，未新增部署）"))
    print("  求解 %.2f s" % (time.time() - t1))
