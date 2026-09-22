"""方案评估与通联需求核算（方案 4.7）。

按合作方答复 3：411 条任意点对通联需求**保留**，与层级模型结合；
**同一上级的下级可以横向通联，不需要先上行再下行**。

因此每条需求的路径按**树上路径**算：两端各自上行到最近公共祖先（LCA），再下行。
同父兄弟的 LCA 就是父节点，跳数 2；Ⅲ 之间可直连，跳数 1。
覆盖率不在评估指标内（答复 5+6：以全连通为唯一目标）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E


def ancestors(sol, i, limit=32):
    """从 i 起沿 parent 链向上的节点序列（含自身）。"""
    out, seen = [i], {i}
    cur = i
    for _ in range(limit):
        par = sol.parent_of.get(cur)
        if not par:
            break
        cur = par[0]
        if cur in seen:
            break                       # 环，理论上不应出现
        out.append(cur)
        seen.add(cur)
    return out


def tree_path(sol, a, b):
    """a 与 b 之间的树上路径（节点下标序列）。无公共祖先则返回 None。"""
    if a == b:
        return [a]
    # 直连也算一跳（Ⅲ 之间可直连；父子之间本就直连）
    pa = sol.parent_of.get(a)
    pb = sol.parent_of.get(b)
    if pa and pa[0] == b:
        return [a, b]
    if pb and pb[0] == a:
        return [a, b]
    up_a = ancestors(sol, a)
    up_b = ancestors(sol, b)
    pos_b = {n: k for k, n in enumerate(up_b)}
    for k, n in enumerate(up_a):
        if n in pos_b:
            return up_a[:k + 1] + list(reversed(up_b[:pos_b[n]]))

    # 没有公共祖先 —— 两条链分别终止于**不同的根**。
    # 求解器不给根指派上级，因此 Ⅰ固定站 与 Ⅰ机动站 各自成树；
    # 但图中这两者之间有一条同行链路（Ⅰ固定站──Ⅰ机动站，互为备份），
    # 跨树的路径就从这一跳走。
    ra, rb = up_a[-1], up_b[-1]
    sa, sb = fm_subtype(sol, ra), fm_subtype(sol, rb)
    if sa in E.ROOT_SUBTYPES and sb in E.ROOT_SUBTYPES and ra != rb:
        return up_a + list(reversed(up_b))
    return None


# 路径计算需要知道台站子类型，但 sol 里只有下标。
# 由 demand_report 在调用前注入，避免把 fm 塞进每个函数签名。
_SUBTYPE_OF = {}


def bind_stations(fm):
    _SUBTYPE_OF.clear()
    for i, s in enumerate(fm.stations):
        _SUBTYPE_OF[i] = s.subtype


def fm_subtype(sol, i):
    return _SUBTYPE_OF.get(i, "")


def demand_report(fm, sol, demands, sid_of_index=None):
    """逐条核算通联需求：是否可达、路径跳数、是否走了横向捷径。"""
    bind_stations(fm)
    idx = {s.sid: i for i, s in enumerate(fm.stations)}
    rows, unreachable = [], []
    hop_hist = {}
    lateral = 0
    for d in demands:
        a = idx.get(d["src_node_id"])
        b = idx.get(d["dst_node_id"])
        if a is None or b is None or a not in sol.connected or b not in sol.connected:
            unreachable.append(d["demand_id"])
            continue
        path = tree_path(sol, a, b)
        if path is None:
            unreachable.append(d["demand_id"])
            continue
        hops = len(path) - 1
        hop_hist[hops] = hop_hist.get(hops, 0) + 1
        # 横向捷径：路径最高点不是根，说明没绕到 Ⅰ
        top = max(path, key=lambda i: len(ancestors(sol, i)))
        via_root = any(fm.stations[i].subtype in E.ROOT_SUBTYPES for i in path)
        if not via_root:
            lateral += 1
        rows.append(dict(demand_id=d["demand_id"], hops=hops,
                         via_root=via_root,
                         path=[fm.stations[i].sid for i in path]))
    return dict(total=len(demands), reachable=len(rows),
                unreachable=unreachable, hop_hist=hop_hist,
                lateral=lateral, rows=rows)


def port_usage(fm, sol):
    """各节点各频段的端口占用/容量，找出瓶颈。"""
    out = []
    for (i, band), used in sol.ports.items():
        cap = E.capacity(fm.stations[i].subtype, band)
        if cap:
            out.append((fm.stations[i].sid, fm.stations[i].subtype, band, used, cap))
    out.sort(key=lambda r: -(r[3] / max(1, r[4])))
    full = sum(1 for r in out if r[3] >= r[4])
    return dict(rows=out, full=full, total=len(out))


def single_point_impact(fm, sol, top=5):
    """单点失效影响面：撤掉某节点后有多少节点失联（方案 4.7 指标）。"""
    from deployment import solve_assignment
    act = sorted(sol.active)
    base_bad = len(sol.unconnected)
    scored = []
    # 只测承担中继的节点（有下级的），末端节点失效只影响自己
    children = {}
    for c, (p, _b) in sol.parent_of.items():
        children.setdefault(p, []).append(c)
    for i in sorted(children, key=lambda x: -len(children[x]))[:40]:
        trial = solve_assignment(fm, active=[x for x in act if x != i])
        lost = len(trial.unconnected) - base_bad
        scored.append((lost, fm.stations[i].sid, fm.stations[i].subtype,
                       len(children[i])))
    scored.sort(reverse=True)
    return scored[:top]


def backup_parents(fm, sol):
    """有第二可选上级的节点数 —— 抗毁性的直接度量（SR-4.2.4 d 的前置）。

    「可选」指：正常工况下编成允许、物理可行、且该上级尚有空余端口。
    """
    from deployment import _ports_left
    n = 0
    for c, (par, band) in sol.parent_of.items():
        for j in fm.neighbors(c, band):
            if j != par and j in sol.connected and _ports_left(sol, fm, j, band) > 0:
                n += 1
                break
    return n


def evaluate(fm, sol, demands=None, with_impact=False):
    """汇总一个部署方案的全部指标。"""
    act = sol.active or set(range(len(fm.stations)))
    margins = []
    for c, (p, band) in sol.parent_of.items():
        m = fm.margin_of(c, p, band)
        if m is not None:
            margins.append(m)
    margins.sort()
    ev = dict(
        stations=len(act),
        connected=len(sol.connected),
        unconnected=len(sol.unconnected),
        connectivity=len(sol.connected) / max(1, len(act)),
        added=sol.count,
        lower_bound=sol.lower_bound,
        gap=sol.gap,
        proved_optimal=getattr(sol, "proved_optimal", False),
        links=len(sol.parent_of),
        margin_min=margins[0] if margins else None,
        margin_median=margins[len(margins) // 2] if margins else None,
        ports=port_usage(fm, sol),
        backup=backup_parents(fm, sol),
    )
    if demands:
        ev["demands"] = demand_report(fm, sol, demands)
    if with_impact:
        ev["impact"] = single_point_impact(fm, sol)
    return ev


def format_eval(ev, title="方案评估"):
    L = ["%s" % title,
         "  台站 %d  连通 %d (%.1f%%)  新增电台 %d"
         % (ev["stations"], ev["connected"], 100 * ev["connectivity"], ev["added"])]
    if ev["lower_bound"]:
        L.append("  下界 %d 部  gap %s%s"
                 % (ev["lower_bound"],
                    "—" if ev["gap"] is None else "%.0f%%" % (100 * ev["gap"]),
                    "  已证最优" if ev["proved_optimal"] else ""))
    if ev["margin_min"] is not None:
        L.append("  建链 %d 条  链路余量 最小 %.1f dB / 中位 %.1f dB"
                 % (ev["links"], ev["margin_min"], ev["margin_median"]))
    p = ev["ports"]
    L.append("  端口占用：%d/%d 个(节点,频段)已用满" % (p["full"], p["total"]))
    L.append("  有备份上级的节点 %d / %d（抗毁性度量）"
             % (ev["backup"], ev["links"]))
    if "demands" in ev:
        d = ev["demands"]
        hs = sorted(d["hop_hist"].items())
        L.append("  通联需求 %d 条：可达 %d，不可达 %d"
                 % (d["total"], d["reachable"], len(d["unreachable"])))
        L.append("    跳数分布 " + "  ".join("%d跳=%d" % kv for kv in hs))
        L.append("    走横向捷径（未绕经 Ⅰ）%d 条，占 %.0f%%"
                 % (d["lateral"], 100.0 * d["lateral"] / max(1, d["reachable"])))
    if "impact" in ev and ev["impact"]:
        L.append("  单点失效影响面 Top:")
        for lost, sid, sub, nch in ev["impact"]:
            L.append("    %-10s %-12s 带 %d 个下级 → 失效致 %d 个节点失联"
                     % (sid, sub, nch, lost))
    return "\n".join(L)


if __name__ == "__main__":
    import csv
    from datapaths import path as dpath
    from terrain import default_terrain
    from feasibility import stations_from_nodes, FeasibilityMatrix
    from deployment import solve_assignment

    def load(rel):
        with open(dpath(rel), encoding="utf-8") as f:
            return list(csv.DictReader(f))

    t = default_terrain()
    st = stations_from_nodes(load("node.csv"), load("device.csv"),
                             load("device_model.csv"), load("antenna_model.csv"))
    fm = FeasibilityMatrix(st, t)
    sol = solve_assignment(fm)
    ev = evaluate(fm, sol, demands=load("comm_demand.csv"), with_impact=True)
    print(format_eval(ev, "基线方案（现有 132 台站，未新增部署）"))
