"""频率资源分配（SR-4.2.2.2）。

把「给每条链路选一个频点」化归为**带约束的图着色**：链路是顶点，
互相干扰的链路之间连边，可用频点是颜色。

实现的条目
----------
- a) 基于频率复用规则自动分配，最小化同频与邻频干扰
- b) 按频段、频点范围、排除列表设置可用频率资源池（`FreqPool`）
- c) 人工调整频点后自动重新校验（`assign()` 的 `manual` 参数 + `check_conflicts()`）
- 扩展 1 资源不足时给出缺口统计 `gap` 与扩容建议
- 扩展 2/3 多套方案保存与对比（`compare_plans()`）

算法
----
《技术参考》(2)/3)a 建议「Dsatur 贪心生成初始解 + 遗传算法全局优化」。
本实现做了 **Dsatur + 冲突导向的局部改进**，没有做 GA，理由是实测规模下
Dsatur 之后已无冲突（见 `_self_test` 与规模测试），GA 没有可优化的空间。
若将来规模上去、Dsatur 留下冲突，再补 GA，接口不用改。

干扰判据
--------
- **同频**（CO_CHANNEL）：两条链路用同一频点，且空间间隔 < 复用最小距离
- **邻频**（ADJACENT_CHANNEL）：频率间隔 < 保护间隔，且空间间隔 < 复用距离的
  `ADJ_DISTANCE_RATIO` 倍（邻频的耦合比同频弱，判据相应放宽）

空间间隔取**两条链路四个端点之间的最小距离**——最保守的口径，
因为只要有一对端点挨得近就可能互扰。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from terrain import haversine_m

# 邻频判据的距离折扣：邻频耦合弱于同频，只有更近才算冲突。**待确认**
ADJ_DISTANCE_RATIO = 0.5
# 缺省复用距离与保护间隔（频率池未给出时兜底），与 gen_test_data 一致
DEFAULT_REUSE_M = {E.HF: 60000.0, E.VUHF: 25000.0}
DEFAULT_GUARD_KHZ = {E.HF: 3.0, E.VUHF: 25.0}


class FreqPool:
    """可用频率资源池（SR-4.2.2.2 b）。"""

    def __init__(self, rows, device_class=None, freq_range_khz=None,
                 exclude_freq_ids=()):
        self.channels = []
        ex = set(exclude_freq_ids or ())
        for r in rows:
            if str(r.get("is_available", "true")).lower() != "true":
                continue
            if r["freq_id"] in ex:
                continue
            if device_class and r["device_class"] != device_class:
                continue
            f = float(r["center_freq_khz"])
            if freq_range_khz and not (freq_range_khz[0] <= f <= freq_range_khz[1]):
                continue
            self.channels.append(dict(
                freq_id=r["freq_id"], band=r["device_class"], freq_khz=f,
                bandwidth_khz=float(r.get("bandwidth_khz") or 0.0),
                channel_no=r.get("channel_no"),
                reuse_min_distance_m=float(r.get("reuse_min_distance_m")
                                           or DEFAULT_REUSE_M.get(r["device_class"], 25000.0)),
                adjacent_guard_khz=float(r.get("adjacent_guard_khz")
                                         or DEFAULT_GUARD_KHZ.get(r["device_class"], 25.0)),
            ))
        self.channels.sort(key=lambda c: (c["band"], c["freq_khz"]))
        self.by_band = {}
        for c in self.channels:
            self.by_band.setdefault(c["band"], []).append(c)

    def of_band(self, band):
        return self.by_band.get(band, [])

    def __len__(self):
        return len(self.channels)


class FreqTask:
    """一个待分配频率的对象：可以是**一条链路**，也可以是**一个网系**。

    `pts` 是该对象涉及的全部台站坐标——链路是两个端点，网系是上级站加全部下级。
    空间间隔按两个对象的点集之间的最小距离算，最保守。
    """

    __slots__ = ("task_id", "band", "members", "pts",
                 "allowed", "freq_min_khz", "freq_max_khz", "label")

    def __init__(self, task_id, band, members, pts,
                 freq_min_khz=None, freq_max_khz=None, label=None):
        self.task_id = task_id
        self.band = band
        self.members = list(members)      # 归属本对象的 link_id 列表
        self.pts = list(pts)
        self.freq_min_khz = freq_min_khz
        self.freq_max_khz = freq_max_khz
        self.label = label or task_id
        self.allowed = []                 # 由 _prepare 填

    # 兼容旧字段名：单链路时 link_id 即 task_id
    @property
    def link_id(self):
        return self.task_id

    def in_range(self, f):
        if self.freq_min_khz is not None and f < self.freq_min_khz:
            return False
        if self.freq_max_khz is not None and f > self.freq_max_khz:
            return False
        return True


def _sep_m(t1, t2):
    """两个对象的空间间隔：两个点集之间的最小距离。"""
    best = float("inf")
    for p in t1.pts:
        for q in t2.pts:
            d = haversine_m(p[0], p[1], q[0], q[1])
            if d < best:
                best = d
                if best == 0.0:
                    return 0.0
    return best


def build_interference(tasks, pool):
    """建干扰图。返回 (邻接表, 间隔表)。

    只有**同频段**的链路之间才可能互扰（两张网互不相连）。
    """
    n = len(tasks)
    adj = [set() for _ in range(n)]
    sep = {}
    reuse = {}
    for band, chans in pool.by_band.items():
        reuse[band] = max((c["reuse_min_distance_m"] for c in chans),
                          default=DEFAULT_REUSE_M.get(band, 25000.0))
    for i in range(n):
        for j in range(i + 1, n):
            if tasks[i].band != tasks[j].band:
                continue
            d = _sep_m(tasks[i], tasks[j])
            r = reuse.get(tasks[i].band, 25000.0)
            if d < r:
                adj[i].add(j)
                adj[j].add(i)
                sep[(i, j)] = d
    return adj, sep


def _prepare(tasks, pool):
    for t in tasks:
        t.allowed = [c for c in pool.of_band(t.band) if t.in_range(c["freq_khz"])]


def _guard_ok(t, chan, other_chan, d, reuse_m):
    """邻频判据：频率间隔够大，或者距离够远。"""
    df = abs(chan["freq_khz"] - other_chan["freq_khz"])
    guard = max(chan["adjacent_guard_khz"], other_chan["adjacent_guard_khz"])
    if df >= guard:
        return True
    return d >= reuse_m * ADJ_DISTANCE_RATIO


def dsatur(tasks, adj, sep, fixed=None):
    """Dsatur 贪心着色。fixed 为人工指定 {下标: 频点 dict}。

    饱和度 = 邻居已用的不同频点数；饱和度高的先着色，平手比邻居数。
    """
    n = len(tasks)
    color = dict(fixed or {})
    order_done = set(color)
    neigh_colors = [set() for _ in range(n)]
    for i, c in color.items():
        for j in adj[i]:
            neigh_colors[j].add(c["freq_khz"])
    unresolved = []
    while len(order_done) < n:
        best, best_key = None, None
        for i in range(n):
            if i in order_done:
                continue
            key = (len(neigh_colors[i]), len(adj[i]))
            if best is None or key > best_key:
                best, best_key = i, key
        t = tasks[best]
        pick = None
        for chan in t.allowed:
            ok = True
            for j in adj[best]:
                cj = color.get(j)
                if cj is None:
                    continue
                d = sep.get((min(best, j), max(best, j)), float("inf"))
                if cj["freq_khz"] == chan["freq_khz"]:
                    ok = False
                    break
                if not _guard_ok(t, chan, cj, d, chan["reuse_min_distance_m"]):
                    ok = False
                    break
            if ok:
                pick = chan
                break
        if pick is None:
            # 没有无冲突的频点：选一个冲突最少的，如实记为未解决
            best_chan, best_bad = None, None
            for chan in t.allowed:
                bad = 0
                for j in adj[best]:
                    cj = color.get(j)
                    if cj is None:
                        continue
                    d = sep.get((min(best, j), max(best, j)), float("inf"))
                    if cj["freq_khz"] == chan["freq_khz"]:
                        bad += 2
                    elif not _guard_ok(t, chan, cj, d, chan["reuse_min_distance_m"]):
                        bad += 1
                if best_bad is None or bad < best_bad:
                    best_chan, best_bad = chan, bad
            pick = best_chan
            if pick is not None:
                unresolved.append(best)
        if pick is None:
            order_done.add(best)          # 该链路没有任何可用频点
            continue
        color[best] = pick
        for j in adj[best]:
            neigh_colors[j].add(pick["freq_khz"])
        order_done.add(best)
    return color, unresolved


def local_repair(tasks, adj, sep, color, fixed=None, rounds=6):
    """冲突导向的局部改进：逐个把冲突链路换到冲突更少的频点。"""
    fixed = set(fixed or ())
    for _ in range(rounds):
        conflicts = check_conflicts(tasks, adj, sep, color)
        if not conflicts:
            break
        hot = set()
        for c in conflicts:
            hot.update(c["_idx"])
        moved = 0
        for i in sorted(hot):
            if i in fixed:
                continue
            cur = color.get(i)
            best_chan, best_bad = cur, _bad_count(tasks, adj, sep, color, i, cur)
            for chan in tasks[i].allowed:
                bad = _bad_count(tasks, adj, sep, color, i, chan)
                if bad < best_bad:
                    best_chan, best_bad = chan, bad
            if best_chan is not cur and best_chan is not None:
                color[i] = best_chan
                moved += 1
        if not moved:
            break
    return color


def _bad_count(tasks, adj, sep, color, i, chan):
    if chan is None:
        return 1 << 30
    bad = 0
    for j in adj[i]:
        cj = color.get(j)
        if cj is None or j == i:
            continue
        d = sep.get((min(i, j), max(i, j)), float("inf"))
        if cj["freq_khz"] == chan["freq_khz"]:
            bad += 2
        elif not _guard_ok(tasks[i], chan, cj, d, chan["reuse_min_distance_m"]):
            bad += 1
    return bad


def check_conflicts(tasks, adj, sep, color):
    """校验冲突（SR-4.2.2.2 c：人工调整后重新校验，走的也是这个函数）。"""
    out = []
    seen = set()
    for i in range(len(tasks)):
        ci = color.get(i)
        if ci is None:
            continue
        for j in adj[i]:
            if j <= i:
                continue
            cj = color.get(j)
            if cj is None:
                continue
            key = (i, j)
            if key in seen:
                continue
            d = sep.get((i, j), float("inf"))
            r = ci["reuse_min_distance_m"]
            if ci["freq_khz"] == cj["freq_khz"]:
                seen.add(key)
                out.append(dict(type="CO_CHANNEL",
                                link_ids=[tasks[i].link_id, tasks[j].link_id],
                                freq_khz=ci["freq_khz"], distance_m=round(d, 1),
                                required_distance_m=r, severity="SEVERE",
                                _idx=(i, j)))
            elif not _guard_ok(tasks[i], ci, cj, d, r):
                seen.add(key)
                out.append(dict(type="ADJACENT_CHANNEL",
                                link_ids=[tasks[i].link_id, tasks[j].link_id],
                                freq_khz=[ci["freq_khz"], cj["freq_khz"]],
                                separation_khz=round(abs(ci["freq_khz"] - cj["freq_khz"]), 3),
                                distance_m=round(d, 1),
                                required_distance_m=round(r * ADJ_DISTANCE_RATIO, 1),
                                severity="MODERATE", _idx=(i, j)))
    return out


def clique_lower_bound(adj, tasks, band=None, cap=400):
    """贪心求一个大团，作为「至少需要几个频点」的下界。"""
    idx = [i for i in range(len(tasks)) if band is None or tasks[i].band == band]
    idx.sort(key=lambda i: -len(adj[i]))
    clique = []
    for i in idx[:cap]:
        if all(j in adj[i] for j in clique):
            clique.append(i)
    return len(clique)


def _max_clique(cand, adj, budget=200000):
    """候选点集合内的最大团。点数不大时精确求解，超预算退化为当前最好解。

    返回 (团, 是否精确)。
    """
    cand = sorted(cand, key=lambda v: -len(adj[v]))
    best = []
    steps = [0]

    def bk(r, p):
        steps[0] += 1
        if steps[0] > budget:
            return
        if len(r) + len(p) <= len(best):
            return
        if not p:
            if len(r) > len(best):
                best[:] = r
            return
        for v in list(p):
            if len(r) + len(p) <= len(best):
                return
            bk(r + [v], [u for u in p if u in adj[v]])
            p.remove(v)

    bk([], cand)
    return best, steps[0] <= budget


def sub_band_gaps(tasks, adj):
    """按**候选频点集合**分组求缺口 —— 比按整个频段求下界紧得多。

    一组对象如果只能用某个频点子集 S（候选集合 ⊆ S），它们内部的最大团
    超过 |S| 就说明这一段频点数学上不够，冲突不可避免。

    第 4 周型号铺开后实测：25 个超短波网只能用 450–512 MHz 那 6 个频点，
    内部最大团 14，缺 8 个——而按整个超短波频段算的下界是 22 ≤ 44，
    报的是「缺 0」。这就是为什么必须按候选集合分组。
    """
    groups = {}
    for i, t in enumerate(tasks):
        key = (t.band, frozenset(c["freq_khz"] for c in t.allowed))
        groups.setdefault(key, set()).add(i)
    out = []
    for (band, S), _members in groups.items():
        if not S:
            continue
        inside = [i for i, t in enumerate(tasks)
                  if t.band == band and t.allowed
                  and {c["freq_khz"] for c in t.allowed} <= S]
        if len(inside) <= len(S):
            continue
        clique, exact = _max_clique(inside, adj)
        if len(clique) > len(S):
            out.append(dict(
                band=band,
                freq_range_khz=[min(S), max(S)],
                available_channels=len(S),
                objects_confined=len(inside),
                required_channels=len(clique),
                shortage=len(clique) - len(S),
                exact=exact,
                clique_task_ids=[tasks[i].task_id for i in clique]))
    out.sort(key=lambda g: -g["shortage"])
    return out


def assign(tasks, pool, manual=None):
    """主入口。manual 为 [{link_id, freq_khz}]。

    返回 assignments / conflicts / gap / conflict_free。
    """
    _prepare(tasks, pool)
    adj, sep = build_interference(tasks, pool)
    idx_of = {t.link_id: i for i, t in enumerate(tasks)}
    fixed = {}
    manual_errors = []
    for m in (manual or []):
        i = idx_of.get(m["link_id"])
        if i is None:
            manual_errors.append("链路 %s 不在本次分配范围内" % m["link_id"])
            continue
        chan = None
        for c in tasks[i].allowed:
            if abs(c["freq_khz"] - float(m["freq_khz"])) < 1e-6:
                chan = c
                break
        if chan is None:
            manual_errors.append("链路 %s 指定的 %.1f kHz 不在其可用频点内"
                                 % (m["link_id"], float(m["freq_khz"])))
            continue
        fixed[i] = chan
    color, unresolved = dsatur(tasks, adj, sep, fixed)
    color = local_repair(tasks, adj, sep, color, fixed=set(fixed))
    conflicts = check_conflicts(tasks, adj, sep, color)

    # 复用分组：同一频点的链路归一组，便于前端着色
    groups = {}
    for i, c in color.items():
        groups.setdefault(c["freq_khz"], []).append(i)
    gid = {f: k for k, f in enumerate(sorted(groups), start=1)}

    assignments = []
    for i, t in enumerate(tasks):
        c = color.get(i)
        assignments.append(dict(
            link_id=t.task_id, task_id=t.task_id, label=t.label,
            member_link_ids=list(t.members), band=t.band,
            freq_id=c["freq_id"] if c else None,
            freq_khz=c["freq_khz"] if c else None,
            bandwidth_khz=c["bandwidth_khz"] if c else None,
            reuse_group=gid.get(c["freq_khz"]) if c else None,
            manual=i in fixed,
            no_channel=len(t.allowed) == 0,
        ))

    gap = {}
    subs = sub_band_gaps(tasks, adj)
    for band in sorted({t.band for t in tasks}):
        need = clique_lower_bound(adj, tasks, band)
        avail = len(pool.of_band(band))
        # 嵌套/重叠的子频段不能累加（同一批网会被数两次），只累加互不相交的
        sub_short, taken = 0, []
        for g_ in (x for x in subs if x["band"] == band):
            lo_, hi_ = g_["freq_range_khz"]
            if any(not (hi_ < a or lo_ > b) for a, b in taken):
                continue
            taken.append((lo_, hi_))
            sub_short += g_["shortage"]
        gap[band] = dict(required_channels=need, available_channels=avail,
                         shortage=max(max(0, need - avail), sub_short),
                         sub_bands=[g for g in subs if g["band"] == band])
    total_short = sum(g["shortage"] for g in gap.values())
    out = dict(assignments=assignments, conflicts=[
        {k: v for k, v in c.items() if k != "_idx"} for c in conflicts],
        gap=gap, conflict_free=not conflicts,
        unassigned=[tasks[i].link_id for i in range(len(tasks)) if color.get(i) is None],
        manual_errors=manual_errors,
        stats=dict(links=len(tasks), interference_edges=sum(len(a) for a in adj) // 2,
                   channels_used=len(groups), dsatur_unresolved=len(unresolved)))
    if total_short or not out["conflict_free"]:
        out["expansion_advice"] = _advice(gap, conflicts)
    return out


def _advice(gap, conflicts):
    """扩容建议（SR-4.2.2.2 扩展 1）。只讲有依据的话。"""
    tips = []
    for band, g in gap.items():
        for sb in g.get("sub_bands", []):
            tips.append("%s 的 %.0f–%.0f kHz 段只有 %d 个频点，但有 %d 个网两两互扰且只能用这一段，"
                        "至少还差 %d 个：可在此段扩充频点，或把相关站换装频段更宽的型号"
                        % (band, sb["freq_range_khz"][0], sb["freq_range_khz"][1],
                           sb["available_channels"], sb["required_channels"], sb["shortage"]))
        if g["shortage"] > 0 and not g.get("sub_bands"):
            tips.append("%s 频段至少还差 %d 个频点（干扰图里有 %d 条链路两两互扰，"
                        "可用频点只有 %d 个）" % (band, g["shortage"],
                                            g["required_channels"], g["available_channels"]))
    co = sum(1 for c in conflicts if c["type"] == "CO_CHANNEL")
    adjn = len(conflicts) - co
    if co:
        tips.append("仍有 %d 处同频冲突，可考虑：放宽复用距离、增加频点、"
                    "或对相关链路降功率以减小互扰范围" % co)
    if adjn:
        tips.append("仍有 %d 处邻频冲突，可考虑缩小保护间隔或改用更窄带宽的信道" % adjn)
    return tips


def compare_plans(plans):
    """多套频率方案对比（SR-4.2.2.2 扩展 3）。"""
    rows = []
    for name, p in plans:
        rows.append(dict(
            name=name,
            conflict_free=p["conflict_free"],
            conflicts=len(p["conflicts"]),
            co_channel=sum(1 for c in p["conflicts"] if c["type"] == "CO_CHANNEL"),
            channels_used=p["stats"]["channels_used"],
            unassigned=len(p["unassigned"]),
        ))
    return rows


# ---------------------------------------------------------------- 建任务入口

def _link_ranges(devices, models):
    mrng = {m["model_id"]: (float(m["freq_min_khz"]), float(m["freq_max_khz"]))
            for m in (models or [])}
    return {d["device_id"]: mrng[d["device_model_id"]]
            for d in (devices or []) if d.get("device_model_id") in mrng}


def _range_of(l, rng):
    """一条链路的可用频率上下限 = 两端设备频段范围的交集。

    第 2 周踩过的坑：只看一端会选出另一端够不着的频点。
    """
    ra, rb = rng.get(l.get("device_a_id")), rng.get(l.get("device_b_id"))
    if ra and rb:
        return max(ra[0], rb[0]), min(ra[1], rb[1])
    if ra or rb:
        return (ra or rb)
    return (None, None)


def tasks_from_links(links, nodes, devices=None, models=None, only_available=True):
    """粒度 = 链路：每条链路单独占一个频点。"""
    pos = {n["node_id"]: (float(n["lon"]), float(n["lat"])) for n in nodes}
    rng = _link_ranges(devices, models)
    out = []
    for l in links:
        if only_available and str(l.get("is_available", "true")).lower() == "false":
            continue
        a, b = l["node_a_id"], l["node_b_id"]
        if a not in pos or b not in pos:
            continue
        lo, hi = _range_of(l, rng)
        out.append(FreqTask(l["link_id"], l["device_class"], [l["link_id"]],
                            [pos[a], pos[b]], lo, hi,
                            label="%s—%s" % (a, b)))
    return out


def tasks_from_nets(links, nodes, devices=None, models=None, only_available=True):
    """粒度 = 网系：**一个上级站 + 它在该频段的全部下级 = 一个网，共用一个频点**。

    这是短波/超短波实际的组网方式——「网」的定义就是同频工作的一组台站，
    上级站不可能对每个下级各开一个频点。按链路分配会把频点需求放大一个量级：
    实测同一份数据，按链路要 ≥169 个短波频点（只有 41 个，数学上无解），
    按网系只要 62 个网、且远距离的网可以复用。

    上下级由编成层级判定（层级数小的一端为上级）。
    """
    pos = {n["node_id"]: (float(n["lon"]), float(n["lat"])) for n in nodes}
    sub = {n["node_id"]: n.get("node_subtype", "") for n in nodes}
    rng = _link_ranges(devices, models)
    order = {"I": 0, "II": 1, "III": 2, "IV": 3}

    def lvl(sid):
        return order.get(E.SUBTYPE_ECHELON.get(sub.get(sid, ""), ""), 9)

    nets = {}
    for l in links:
        if only_available and str(l.get("is_available", "true")).lower() == "false":
            continue
        a, b = l["node_a_id"], l["node_b_id"]
        if a not in pos or b not in pos:
            continue
        parent = a if lvl(a) <= lvl(b) else b
        key = (parent, l["device_class"])
        lo, hi = _range_of(l, rng)
        rec = nets.setdefault(key, dict(members=[], pts={pos[parent]}, lo=lo, hi=hi))
        rec["members"].append(l["link_id"])
        rec["pts"].add(pos[a])
        rec["pts"].add(pos[b])
        # 全网共用一个频点，可用范围取全网的交集
        if lo is not None:
            rec["lo"] = lo if rec["lo"] is None else max(rec["lo"], lo)
        if hi is not None:
            rec["hi"] = hi if rec["hi"] is None else min(rec["hi"], hi)
    out = []
    for (parent, band), rec in sorted(nets.items()):
        out.append(FreqTask("NET-%s-%s" % (parent, band), band, rec["members"],
                            sorted(rec["pts"]), rec["lo"], rec["hi"],
                            label="%s 的 %s 网（%d 条链路）"
                                  % (parent, band, len(rec["members"]))))
    return out


def expand_to_links(result, tasks):
    """把网系粒度的结果摊开到每条链路，供前端与链路表使用。"""
    by_task = {a["link_id"]: a for a in result["assignments"]}
    rows = []
    for t in tasks:
        a = by_task.get(t.task_id)
        if a is None:
            continue
        for lid in t.members:
            rows.append(dict(a, link_id=lid, net_id=t.task_id))
    return rows


def _self_test():
    import csv
    import time
    from datapaths import path as dpath

    def load(rel):
        with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    print("=" * 74)
    print("频率资源分配自检（真实数据）")
    print("=" * 74)
    links, nodes = load("link.csv"), load("node.csv")
    devices, models = load("device.csv"), load("device_model.csv")
    pool_rows = load("frequency_resource.csv")
    pool = FreqPool(pool_rows)
    print("\n可用频点 %d 个：%s"
          % (len(pool), "，".join("%s %d" % (b, len(v))
                                 for b, v in sorted(pool.by_band.items()))))

    print("\n[1] 两种分配粒度的对比 —— 这是本模块最要紧的一个口径")
    runs = {}
    for name, builder in (("按链路", tasks_from_links), ("按网系", tasks_from_nets)):
        tasks = builder(links, nodes, devices, models)
        t0 = time.time()
        res = assign(tasks, pool)
        el = time.time() - t0
        runs[name] = (tasks, res)
        co = sum(1 for c in res["conflicts"] if c["type"] == "CO_CHANNEL")
        adjn = len(res["conflicts"]) - co
        print("    %-5s 对象 %3d 个  干扰边 %6d  用频点 %2d  冲突 %4d（同频%4d 邻频%3d）"
              "  无冲突=%-5s  %.2fs"
              % (name, len(tasks), res["stats"]["interference_edges"],
                 res["stats"]["channels_used"], len(res["conflicts"]), co, adjn,
                 res["conflict_free"], el))
        for band, g in sorted(res["gap"].items()):
            print("          %s 需要 ≥%3d 个频点，可用 %2d，缺 %3d"
                  % (band, g["required_channels"], g["available_channels"], g["shortage"]))
    print("    结论：短波复用距离 60 km、规划区只有 120×120 km，按链路分配时")
    print("          几乎每条短波链路都与其它链路互扰，频点需求被放大一个量级。")
    print("          「网」的定义本就是同频工作的一组台站，按网系分配才是实际口径。")

    tasks, res = runs["按网系"]

    print("\n[2] 分配出的频点都在全网设备频段范围内")
    idx = {t.task_id: t for t in tasks}
    bad = sum(1 for a in res["assignments"]
              if a["freq_khz"] is not None and not idx[a["task_id"]].in_range(a["freq_khz"]))
    print("    越界条数 %d  %s" % (bad, "✓" if bad == 0 else "✗"))

    print("\n[3] 摊开到链路：每条链路都拿到了频点")
    rows = expand_to_links(res, tasks)
    miss = sum(1 for r in rows if r["freq_khz"] is None)
    print("    覆盖链路 %d 条，没频点的 %d 条  %s"
          % (len(rows), miss, "✓" if miss == 0 else "✗"))

    print("\n[4] 人工指定频点后重新校验（SR-4.2.2.2 c）")
    victim = next(a for a in res["assignments"] if a["freq_khz"] is not None)
    vt = idx[victim["task_id"]]
    other = next(c for c in pool.of_band(vt.band)
                 if c["freq_khz"] != victim["freq_khz"] and vt.in_range(c["freq_khz"]))
    res2 = assign(tasks, pool, manual=[dict(link_id=vt.task_id, freq_khz=other["freq_khz"])])
    got = next(a for a in res2["assignments"] if a["task_id"] == vt.task_id)
    print("    %s：%.1f → 指定 %.1f kHz，实得 %.1f，manual=%s"
          % (vt.task_id, victim["freq_khz"], other["freq_khz"],
             got["freq_khz"], got["manual"]))
    print("    重新校验冲突 %d 处" % len(res2["conflicts"]))

    print("\n[5] 人工指定一个非法频点，应当被拒绝并说明原因")
    res3 = assign(tasks, pool, manual=[dict(link_id=vt.task_id, freq_khz=1.0)])
    print("    %s" % (res3["manual_errors"][0] if res3["manual_errors"] else "居然没报错 ✗"))

    print("\n[6] 资源不足：把池子砍到 3 个频点，看缺口与扩容建议（扩展 1）")
    tiny = FreqPool(pool_rows)
    tiny.channels = tiny.channels[:3]
    tiny.by_band = {}
    for c in tiny.channels:
        tiny.by_band.setdefault(c["band"], []).append(c)
    res4 = assign(tasks, tiny)
    print("    冲突 %d 处，未分配 %d 个网" % (len(res4["conflicts"]), len(res4["unassigned"])))
    for tip in res4.get("expansion_advice", [])[:3]:
        print("    · %s" % tip)

    print("\n[7] 多方案对比（扩展 3）")
    for row in compare_plans([("按网系", res), ("人工干预", res2),
                              ("池子砍到3个", res4), ("按链路", runs["按链路"][1])]):
        print("    %-12s 无冲突=%-5s 冲突%5d 同频%5d 用频点%3d 未分配%4d"
              % (row["name"], row["conflict_free"], row["conflicts"],
                 row["co_channel"], row["channels_used"], row["unassigned"]))
    print("=" * 74)


if __name__ == "__main__":
    _self_test()


def fill_ranges_by_node(tasks, links, nodes, devices, models):
    """规划拓扑没有 device_a_id/device_b_id 时，按**节点**推可用频率范围。

    取该节点在该频段第一台设备的型号频段范围，再对网内全部成员求交集。
    """
    mrng = {m["model_id"]: (float(m["freq_min_khz"]), float(m["freq_max_khz"]))
            for m in models}
    mband = {m["model_id"]: m["device_class"] for m in models}
    node_rng = {}
    for d in devices:
        r = mrng.get(d["model_id"])
        if not r:
            continue
        key = (d["node_id"], mband[d["model_id"]])
        node_rng.setdefault(key, r)
    by_id = {l["link_id"]: l for l in links}
    for t in tasks:
        lo = hi = None
        for lid in t.members:
            l = by_id.get(lid)
            if not l:
                continue
            for sid in (l["node_a_id"], l["node_b_id"]):
                r = node_rng.get((sid, t.band))
                if not r:
                    continue
                lo = r[0] if lo is None else max(lo, r[0])
                hi = r[1] if hi is None else min(hi, r[1])
        t.freq_min_khz, t.freq_max_khz = lo, hi
