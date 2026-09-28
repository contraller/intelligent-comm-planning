"""路由规划（SR-4.2.2.1）。

在已确定的部署拓扑上，为每条通联需求求主用路由与备用路由。

实现的条目
----------
- a) 三策略自动规划：`SHORTEST_PATH` 最短路径 / `MIN_DELAY` 最小时延 /
     `MAX_RELIABILITY` 最高可靠性
- b) 人工指定路径：`check_manual_path()` 校验逐跳是否成链并回算指标
- c) 可达性校验与备用路由：`plan_one()` 给可达性，`backup_of()` 给备用
- 扩展 1 主路由单点故障风险 → 优先求**节点不相交**备用；求不到再退而求
  **链路不相交**备用，并如实标注是哪一种
- 扩展 2 无可达路径 → `relay_suggestions()` 给出增设中继的候选位置

频段处理
--------
短波与超短波是两张互不相连的网，但双频段节点内部可以换频段。
因此图的顶点是 **(台站, 频段)** 二元组，节点内部的频段转换是一条零跳权重的边。
这样「db 不能和 cdb 相连」就是结构性成立的，不需要额外检查。

时延与可靠性的口径
------------------
- 时延：优先取 `link_metric` 的实测中位数；缺测时按
  `传播时延 + 每跳处理时延` 估算，处理时延常数标**待确认**。
- 可靠性：由链路余量经**对数正态阴影衰落**换算
  `p = 1 − Q(margin/σ)`，σ 默认 8 dB（《技术参考》4)c 给 6–10 dB）。
  这是本项目自拟的口径，需规无对应条文，已记入设计文档。
"""
import heapq
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E

STRATEGIES = ("SHORTEST_PATH", "MIN_DELAY", "MAX_RELIABILITY")

# 每跳处理时延（收发处理 + 转发排队），单位 ms。**待确认**：
# 需规与《技术参考》均未给出，此处取工程经验值，改动只需改这一处。
HOP_PROCESS_MS = {E.HF: 25.0, E.VUHF: 8.0}
# 频段转换时延（双频节点内部把报文从一张网转到另一张网）。**待确认**
BAND_SWITCH_MS = 15.0
# 阴影衰落标准差，用于余量 → 可靠性换算
SHADOW_SIGMA_DB = 8.0
C_M_PER_MS = 299792.458          # 光速，m/ms


def _q(x):
    """标准正态右尾 Q(x)。"""
    return 0.5 * math.erfc(x / math.sqrt(2.0))


def link_reliability(margin_db, sigma_db=SHADOW_SIGMA_DB):
    """由链路余量换算单跳可用度。

    余量为正且远大于 σ 时趋近 1；余量为 0 时为 0.5（一半时间达不到门限）。
    """
    if sigma_db <= 0:
        return 1.0 if margin_db >= 0 else 0.0
    return max(1e-9, min(1.0 - 1e-12, 1.0 - _q(margin_db / sigma_db)))


class RouteGraph:
    """(台站, 频段) 二元组为顶点的路由图。"""

    def __init__(self):
        self.vid = {}            # (sid, band) -> 顶点号
        self.vkey = []           # 顶点号 -> (sid, band)
        self.adj = {}            # 顶点号 -> [(邻顶点, 边信息 dict)]
        self.links = {}          # link_id -> 边信息
        self.bands_of = {}       # sid -> {band}

    def _v(self, sid, band):
        k = (sid, band)
        if k not in self.vid:
            self.vid[k] = len(self.vkey)
            self.vkey.append(k)
            self.adj[self.vid[k]] = []
            self.bands_of.setdefault(sid, set()).add(band)
        return self.vid[k]

    def add_link(self, link_id, a_sid, b_sid, band, margin_db,
                 distance_m, delay_ms=None):
        """加一条无线链路（无向）。"""
        va, vb = self._v(a_sid, band), self._v(b_sid, band)
        if delay_ms is None:
            delay_ms = distance_m / C_M_PER_MS + HOP_PROCESS_MS.get(band, 10.0)
        info = dict(link_id=link_id, a=a_sid, b=b_sid, band=band,
                    margin_db=float(margin_db), distance_m=float(distance_m),
                    delay_ms=float(delay_ms),
                    reliability=link_reliability(float(margin_db)),
                    kind="RADIO")
        self.links[link_id] = info
        self.adj[va].append((vb, info))
        self.adj[vb].append((va, info))

    def seal_band_switches(self):
        """给每个双频段台站补上内部频段转换边。必须在所有链路加完之后调用。"""
        n = 0
        for sid, bands in self.bands_of.items():
            bl = sorted(bands)
            for i in range(len(bl)):
                for j in range(i + 1, len(bl)):
                    va, vb = self.vid[(sid, bl[i])], self.vid[(sid, bl[j])]
                    info = dict(link_id="SW-%s" % sid, a=sid, b=sid,
                                band=None, margin_db=float("inf"),
                                distance_m=0.0, delay_ms=BAND_SWITCH_MS,
                                reliability=1.0, kind="BAND_SWITCH")
                    self.adj[va].append((vb, info))
                    self.adj[vb].append((va, info))
                    n += 1
        return n

    def vertices_of(self, sid):
        return [self.vid[(sid, b)] for b in self.bands_of.get(sid, ())]

    def has_node(self, sid):
        return sid in self.bands_of

    def link_between(self, a_sid, b_sid, band=None):
        for info in self.links.values():
            if {info["a"], info["b"]} == {a_sid, b_sid} and (band is None or info["band"] == band):
                return info
        return None


def _weight(info, strategy):
    if strategy == "SHORTEST_PATH":
        return 0.0 if info["kind"] == "BAND_SWITCH" else 1.0
    if strategy == "MIN_DELAY":
        return info["delay_ms"]
    if strategy == "MAX_RELIABILITY":
        return -math.log(info["reliability"])
    raise ValueError("未知策略：%s（可选 %s）" % (strategy, "/".join(STRATEGIES)))


def _dijkstra(g, src_vs, dst_vs, strategy, banned_nodes=(), banned_links=()):
    """多源多汇 Dijkstra。返回 (顶点路径, 边路径) 或 (None, None)。"""
    banned_nodes = set(banned_nodes)
    banned_links = set(banned_links)
    dst = set(dst_vs)
    dist = {}
    prev = {}
    pq = []
    for v in src_vs:
        if g.vkey[v][0] in banned_nodes:
            continue
        dist[v] = 0.0
        heapq.heappush(pq, (0.0, v))
    while pq:
        d, v = heapq.heappop(pq)
        if d > dist.get(v, float("inf")) + 1e-12:
            continue
        if v in dst:
            path = [v]
            edges = []
            while v in prev:
                v, info = prev[v]
                path.append(v)
                edges.append(info)
            path.reverse()
            edges.reverse()
            return path, edges
        for nb, info in g.adj[v]:
            if g.vkey[nb][0] in banned_nodes:
                continue
            if info["link_id"] in banned_links:
                continue
            nd = d + _weight(info, strategy)
            if nd < dist.get(nb, float("inf")) - 1e-12:
                dist[nb] = nd
                prev[nb] = (v, info)
                heapq.heappush(pq, (nd, nb))
    return None, None


def _summarize(g, vpath, edges):
    """把顶点路径折算成对外的路由结果。"""
    node_path = []
    for v in vpath:
        sid = g.vkey[v][0]
        if not node_path or node_path[-1] != sid:
            node_path.append(sid)
    radio = [e for e in edges if e["kind"] == "RADIO"]
    rel = 1.0
    for e in edges:
        rel *= e["reliability"]
    worst = min((e["margin_db"] for e in radio), default=float("inf"))
    bottleneck = None
    for e in radio:
        if e["margin_db"] == worst:
            bottleneck = e["link_id"]
            break
    return dict(
        node_path=node_path,
        link_path=[e["link_id"] for e in radio],
        hop_count=len(radio),
        band_switches=len(edges) - len(radio),
        total_delay_ms=round(sum(e["delay_ms"] for e in edges), 2),
        min_link_margin_db=round(worst, 2) if radio else None,
        reliability=round(rel, 6),
        bottleneck_link_id=bottleneck,
    )


def plan_one(g, src_sid, dst_sid, strategy="MAX_RELIABILITY",
             banned_nodes=(), banned_links=()):
    """单条需求的主用路由。不可达返回 None。"""
    if not g.has_node(src_sid) or not g.has_node(dst_sid):
        return None
    if src_sid == dst_sid:
        return dict(node_path=[src_sid], link_path=[], hop_count=0,
                    band_switches=0, total_delay_ms=0.0,
                    min_link_margin_db=None, reliability=1.0,
                    bottleneck_link_id=None)
    vpath, edges = _dijkstra(g, g.vertices_of(src_sid), g.vertices_of(dst_sid),
                             strategy, banned_nodes, banned_links)
    if vpath is None:
        return None
    return _summarize(g, vpath, edges)


def backup_of(g, src_sid, dst_sid, primary, strategy="MAX_RELIABILITY"):
    """备用路由。

    先求**节点不相交**（避开主路由所有中间节点）——这才真正规避单点故障；
    求不到再求**链路不相交**（只避开主路由用过的链路）。
    返回 (备用结果, 类型)，类型取 NODE_DISJOINT / LINK_DISJOINT / NONE。
    """
    mids = set(primary["node_path"][1:-1])
    if mids:
        r = plan_one(g, src_sid, dst_sid, strategy, banned_nodes=mids)
        if r:
            return r, "NODE_DISJOINT"
    r = plan_one(g, src_sid, dst_sid, strategy,
                 banned_links=set(primary["link_path"]))
    if r:
        return r, "LINK_DISJOINT"
    return None, "NONE"


def single_point_risks(g, src_sid, dst_sid, primary, strategy="MAX_RELIABILITY"):
    """逐个试掉主路由的中间节点，找出「一掉就断」的单点。"""
    risks = []
    for sid in primary["node_path"][1:-1]:
        if plan_one(g, src_sid, dst_sid, strategy, banned_nodes={sid}) is None:
            risks.append(sid)
    return risks


def check_manual_path(g, node_path, strategy="MAX_RELIABILITY"):
    """校验人工指定路径（SR-4.2.2.1 b）。

    返回 (结果 or None, 错误说明列表)。逐跳检查是否真有链路可走。
    """
    errs = []
    if len(node_path) < 2:
        return None, ["路径至少要有两个节点"]
    for sid in node_path:
        if not g.has_node(sid):
            errs.append("节点 %s 不在当前拓扑中" % sid)
    if errs:
        return None, errs
    edges = []
    for a, b in zip(node_path, node_path[1:]):
        info = g.link_between(a, b)
        if info is None:
            errs.append("%s → %s 之间没有可用链路" % (a, b))
        else:
            edges.append(info)
    if errs:
        return None, errs
    # 频段切换：相邻两跳频段不同则中间那个节点必须是双频段
    for i in range(1, len(edges)):
        if edges[i]["band"] != edges[i - 1]["band"]:
            mid = node_path[i]
            if len(g.bands_of.get(mid, ())) < 2:
                errs.append("%s 不是双频段节点，无法在此从 %s 转到 %s"
                            % (mid, edges[i - 1]["band"], edges[i]["band"]))
    if errs:
        return None, errs
    vpath = []
    for i, sid in enumerate(node_path):
        band = edges[i]["band"] if i < len(edges) else edges[-1]["band"]
        vpath.append(g.vid[(sid, band)])
    res = _summarize(g, vpath, edges)
    res["manual"] = True
    return res, []


def relay_suggestions(g, src_sid, dst_sid, stations, fm, candidates,
                      strategy="MAX_RELIABILITY", top=3):
    """无可达路径时，给出增设中继的建议（SR-4.2.2.1 扩展 2）。

    做法：先用连通分量把两端分开，再在候选位置里找**同时能连上两侧**的点，
    按「两侧余量的较小值」排序。找不到就如实说找不到，不编造。

    stations / fm 用第 2 周的可行性矩阵，candidates 为候选台站下标集合。
    """
    reach_src = _component(g, src_sid)
    reach_dst = _component(g, dst_sid)
    if reach_dst & reach_src:
        return []                       # 本来就连通，不该走到这
    idx_of = {s.sid: i for i, s in enumerate(fm.stations)}
    src_side = [idx_of[s] for s in reach_src if s in idx_of]
    dst_side = [idx_of[s] for s in reach_dst if s in idx_of]
    out = []
    for ci in candidates:
        best_s = best_d = None
        for band in (E.HF, E.VUHF):
            if not fm.stations[ci].has(band):
                continue
            for side, keep in ((src_side, "s"), (dst_side, "d")):
                for i in side:
                    if not fm.stations[i].has(band):
                        continue
                    m = fm.margin_of(ci, i, band)
                    if m is None:
                        continue
                    if keep == "s" and (best_s is None or m > best_s[0]):
                        best_s = (m, fm.stations[i].sid, band)
                    if keep == "d" and (best_d is None or m > best_d[0]):
                        best_d = (m, fm.stations[i].sid, band)
        if best_s and best_d:
            out.append(dict(site_id=fm.stations[ci].sid,
                            lon=fm.stations[ci].lon, lat=fm.stations[ci].lat,
                            to_src=dict(node_id=best_s[1], band=best_s[2],
                                        margin_db=round(best_s[0], 2)),
                            to_dst=dict(node_id=best_d[1], band=best_d[2],
                                        margin_db=round(best_d[0], 2)),
                            min_margin_db=round(min(best_s[0], best_d[0]), 2)))
    out.sort(key=lambda r: -r["min_margin_db"])
    return out[:top]


def _component(g, sid):
    """从某节点出发能走到的所有台站 ID。"""
    seen = set()
    stack = list(g.vertices_of(sid))
    vis = set(stack)
    while stack:
        v = stack.pop()
        seen.add(g.vkey[v][0])
        for nb, _info in g.adj[v]:
            if nb not in vis:
                vis.add(nb)
                stack.append(nb)
    return seen


def plan_routes(g, demands, default_strategy="MAX_RELIABILITY",
                manual_paths=None, need_backup=True):
    """批量规划。demands 为 comm_demand.csv 的行。"""
    manual = {m["demand_id"]: m["node_path"] for m in (manual_paths or [])}
    routes, unreachable = [], []
    for d in demands:
        did = d["demand_id"]
        src, dst = d["src_node_id"], d["dst_node_id"]
        strategy = d.get("strategy") or default_strategy
        rec = dict(demand_id=did, strategy=strategy)
        if did in manual:
            pr, errs = check_manual_path(g, manual[did], strategy)
            rec["manual_errors"] = errs
        else:
            pr, errs = plan_one(g, src, dst, strategy), []
        if pr is None:
            rec.update(reachable=False, primary=None, backup=None,
                       backup_type="NONE")
            unreachable.append(did)
            routes.append(rec)
            continue
        rec.update(reachable=True, primary=pr)
        if need_backup and pr["hop_count"] > 0:
            bk, bt = backup_of(g, src, dst, pr, strategy)
            rec.update(backup=bk, backup_type=bt)
            rec["single_point_risks"] = single_point_risks(g, src, dst, pr, strategy) \
                if bt == "NONE" else []
        else:
            rec.update(backup=None, backup_type="NONE", single_point_risks=[])
        routes.append(rec)
    return dict(routes=routes, unreachable_demand_ids=unreachable)


# ---------------------------------------------------------------- 建图入口

def graph_from_links(links, metrics=None):
    """由 `link.csv` 建图。metrics 为 `link_metric.csv`，用于取实测时延中位数。"""
    delay = {}
    if metrics:
        by_link = {}
        for m in metrics:
            try:
                by_link.setdefault(m["link_id"], []).append(float(m["delay_ms"]))
            except (KeyError, ValueError):
                continue
        for lid, vals in by_link.items():
            vals.sort()
            delay[lid] = vals[len(vals) // 2]
    g = RouteGraph()
    skipped = 0
    for l in links:
        if str(l.get("is_available", "true")).lower() == "false":
            skipped += 1
            continue
        g.add_link(l["link_id"], l["node_a_id"], l["node_b_id"],
                   l["device_class"], float(l["link_margin_db"]),
                   float(l["distance_m"]), delay.get(l["link_id"]))
    g.seal_band_switches()
    return g, skipped


def graph_from_solution(fm, sol):
    """由第 2 周的部署求解结果建图（父子链路即拓扑）。"""
    g = RouteGraph()
    for child, (parent, band) in sol.parent_of.items():
        sa, sb = fm.stations[child], fm.stations[parent]
        m = fm.margin_of(child, parent, band)
        d = _haversine(sa, sb)
        g.add_link("LK-%s-%s" % (sa.sid, sb.sid), sa.sid, sb.sid, band,
                   m if m is not None else 0.0, d)
    g.seal_band_switches()
    return g


def _haversine(sa, sb):
    from terrain import haversine_m
    return haversine_m(sa.lon, sa.lat, sb.lon, sb.lat)


def _self_test():
    print("=" * 70)
    print("路由规划自检")
    print("=" * 70)

    # 手搭一个小网：A-B-C 走超短波，C 处换频段，C-D-E 走短波，另有旁路 B-F-D
    g = RouteGraph()
    g.add_link("L1", "A", "B", E.VUHF, 25.0, 20000.0)
    g.add_link("L2", "B", "C", E.VUHF, 18.0, 25000.0)
    g.add_link("L3", "C", "D", E.HF, 12.0, 60000.0)
    g.add_link("L4", "D", "E", E.HF, 30.0, 40000.0)
    g.add_link("L5", "B", "F", E.VUHF, 9.0, 35000.0)
    g.add_link("L6", "F", "D", E.VUHF, 9.0, 35000.0)
    g.add_link("L7", "D", "F", E.HF, 8.0, 35000.0)
    g.add_link("L8", "A", "F", E.VUHF, 14.0, 45000.0)
    g.add_link("L9", "F", "E", E.VUHF, 11.0, 50000.0)
    n = g.seal_band_switches()
    print("\n[1] 建图：顶点 %d，链路 %d，频段转换边 %d"
          % (len(g.vkey), len(g.links), n))
    print("    双频段节点：%s"
          % ", ".join(sorted(s for s, b in g.bands_of.items() if len(b) > 1)))

    print("\n[2] 三个策略给出的 A→E 路由")
    for st in STRATEGIES:
        r = plan_one(g, "A", "E", st)
        print("    %-16s %s  跳数%d 换频段%d 时延%.1fms 最差余量%.1fdB 可靠性%.4f"
              % (st, "→".join(r["node_path"]), r["hop_count"],
                 r["band_switches"], r["total_delay_ms"],
                 r["min_link_margin_db"], r["reliability"]))

    print("\n[3] 余量 → 可靠性（对数正态阴影，σ=%.0f dB）" % SHADOW_SIGMA_DB)
    for m in (0, 3, 6, 10, 20, 30):
        print("    余量 %2d dB → 单跳可用度 %.4f" % (m, link_reliability(m)))

    print("\n[4] 备用路由与单点故障")
    pr = plan_one(g, "A", "E", "MAX_RELIABILITY")
    bk, bt = backup_of(g, "A", "E", pr)
    print("    主用 %s" % "→".join(pr["node_path"]))
    print("    备用 %s（%s）" % ("→".join(bk["node_path"]) if bk else "无", bt))
    print("    主用路径上的单点故障节点：%s"
          % (single_point_risks(g, "A", "E", pr) or "无"))

    print("\n[5] 人工指定路径校验")
    for path in (["A", "B", "C", "D", "E"], ["A", "C", "E"], ["A", "B", "F", "D", "E"]):
        r, errs = check_manual_path(g, path)
        print("    %-22s %s" % ("→".join(path),
                                "通过，跳数 %d" % r["hop_count"] if r else "；".join(errs)))

    print("\n[6] 频段隔离：短波顶点与超短波顶点只能在双频节点内部相连")
    bad = [(g.vkey[v], g.vkey[nb]) for v in range(len(g.vkey))
           for nb, info in g.adj[v]
           if info["kind"] == "RADIO" and g.vkey[v][1] != g.vkey[nb][1]]
    print("    跨频段的无线链路条数：%d  %s" % (len(bad), "✓" if not bad else "✗"))

    print("\n[7] 不可达：把 E 单独摘出去")
    g2 = RouteGraph()
    g2.add_link("L1", "A", "B", E.VUHF, 25.0, 20000.0)
    g2.add_link("L9", "X", "E", E.VUHF, 25.0, 20000.0)
    g2.seal_band_switches()
    print("    A→E：%s" % ("不可达 ✓" if plan_one(g2, "A", "E") is None else "居然可达 ✗"))
    print("=" * 70)


if __name__ == "__main__":
    _self_test()
