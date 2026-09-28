"""多目标优化组网（SR-4.2.4）—— 自研 NSGA-II，纯标准库。

合作方答复 1：「不可以用求解器，我们自己写求解。」本模块按此实现，
不依赖任何 ILP / MILP / 进化计算库。

实现的条目
----------
- a) 端到端连通率最大化；**必要通联的连通率 = 1 作硬约束**
- b) 直连不足时自动配置中继；**中继跳数 ≤ 2**（硬约束，口径见下）
- c) 全网总辐射功率最小化
- d) 抗毁性最大化；**任一单条链路断开时关键通联连通率 ≥ 90%**（硬约束）
- e) 多目标求解输出非支配解集，按各目标量化指标排序
- 扩展 1 无可行解时指明冲突的硬约束，并按实际能达到的最好值给放宽建议
- 扩展 2 人工锁定部分链路 / 中继站位置后重新求解
- 扩展 3 多方案横向对比（`compare()`），导出由服务层完成

决策变量
--------
在第 2 周部署结果（树形编成 + P1 已补的中继）之上，决定：
1. **备份链路**：每个节点可以再挂一条到「另一个合法上级」的链路（编成允许、物理可行、
   两端端口都有余量）。每个节点取余量最好的前两个候选，共几百个比特。
2. **追加中继**：从候选位置里按「能给多少现网节点当备份上级」挑出前 K 个，
   选中即部署：上行接到最好的合法上级，并用剩余端口给附近节点当备份上级。
3. **衰落余量档位**：6 / 8 / 10 / 12 dB。门限越高链路越稳，但要求功率越大，
   到顶仍达不到的链路视为不可用。

目标与约束的算法
----------------
- **功率**：沿用第 3 周电台参数的闭式解——余量对功率 1:1、链路预算取两端较小值，
  每台设备取它全部链路所需功率的最大值再向上取档。
- **抗毁性**：只有**桥**断开才会改变连通性，非桥断了图照样连通。所以每次评估只做
  一遍 Tarjan 求桥，再用 DFS 进出时间戳判断每条必要通联是否跨过这座桥——
  不必对每条链路各重算一次连通分量。
- **中继跳数**：本项目口径 = 通联路径上**连续经过的新增中继站数**（待确认，
  需规未定义）。追加中继只接现网节点，结构上保证 ≤ 1；P1 已补的中继也计入检查。

约束处理用 Deb 的约束支配：可行解支配不可行解；都不可行时违约量小的占优。
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E

MARGIN_LEVELS = (6.0, 8.0, 10.0, 12.0)
DEFAULT_CONSTRAINTS = dict(mandatory_e2e_connectivity=1.0,
                           survivability_threshold=0.90,
                           max_relay_hops=2)
OBJECTIVES = ("MAX_CONNECTIVITY", "MIN_TOTAL_POWER", "MAX_SURVIVABILITY")


# ─────────────────────────── 问题实例 ───────────────────────────

class Problem:
    """把第 2/3 周的结果整理成优化问题：基础拓扑、候选备份、候选中继。"""

    def __init__(self, fm, sol, demands, caps, candidate_relays=32,
                 backups_per_node=2, locked_links=(), locked_relays=(), seed=20260908,
                 survivability_threshold=DEFAULT_CONSTRAINTS["survivability_threshold"]):
        self.fm = fm
        self.sol = sol
        self.rng = random.Random(seed)
        n = len(fm.stations)
        self.sid = [s.sid for s in fm.stations]
        self.idx = {s: i for i, s in enumerate(self.sid)}
        self.base_relays = {i for i, _s in sol.added}

        # 设备最大功率与当前功率（候选/新增中继没有设备表，取其射频模板的功率）
        self.tx_max, self.tx_now, self.levels = {}, {}, {}
        for i, st in enumerate(fm.stations):
            for band, r in st.radio.items():
                c = (caps or {}).get((st.sid, band))
                self.tx_now[(i, band)] = r["tx_dbm"]
                self.tx_max[(i, band)] = c.tx_max if c else r["tx_dbm"]
                self.levels[(i, band)] = c.levels if c else [r["tx_dbm"]]

        # 基础拓扑：树形父子链路
        self.base = []                           # (a, b, band)
        for child, (parent, band) in sol.parent_of.items():
            self.base.append((child, parent, band))
        self.ports_base = dict(sol.ports)
        # 两个 Ⅰ 之间的同行链路（见 plan_pipeline.root_links）
        from plan_pipeline import root_links
        for a, b, band in root_links(fm, sol):
            self.base.append((a, b, band))
            for k in ((a, band), (b, band)):
                self.ports_base[k] = self.ports_base.get(k, 0) + 1

        # 候选备份链路：每个已连通节点，在它持有的**每个频段**里取余量最好的
        # 前 backups_per_node 个合法对端（编成允许、物理可行、不是已有链路）。
        #
        # 必须按「每个频段」找，不能只看上行频段：Ⅲ 的上行走超短波，但它那个
        # 短波口本就是留给「右支接入与 Ⅲ──Ⅲ 中继」的（合作方答复 2(b)
        # 「Ⅲ-Ⅲ 可以中继转发」）。跨子树的 Ⅲ──Ⅲ 横向链路是抗毁性的天然来源；
        # 第一版只在上行频段里找，把它们全漏了，抗毁性卡在 0.646。
        existing = {(min(a, b), max(a, b), band) for a, b, band in self.base}
        self.backups = []
        seen = set()
        for child in sorted(sol.connected):
            if child not in sol.parent_of:
                continue
            for band in sorted(fm.stations[child].radio):
                cands = []
                for j in fm.neighbors(child, band):
                    if j not in sol.connected:
                        continue
                    key = (min(child, j), max(child, j), band)
                    if key in existing:
                        continue
                    m = fm.margin_of(child, j, band)
                    if m is not None:
                        cands.append((m, j))
                cands.sort(reverse=True)
                for m, j in cands[:backups_per_node]:
                    key = (min(child, j), max(child, j), band)
                    if key in seen:
                        continue
                    seen.add(key)
                    self.backups.append((child, j, band))

        # 候选中继。两路来源合并：
        #  (1) **瓶颈导向**：先在基础拓扑上求桥，找出「一断就切掉大量必要通联」的桥，
        #      对每座这样的桥，在候选池里找**一头连进桥下子树、一头连出子树、
        #      两端端口都空闲**的位置——这类中继能直接消掉这座桥；
        #  (2) **覆盖导向**：按能与多少现网节点合法相连排序，补足名额。
        #
        # 第一版只有 (2)，抗毁性卡在 0.8958；三档加大搜索力度都收敛到同一个值、
        # 同一处最坏单点，一度像是结构上限。逐项核对端口后发现候选池里其实有
        # 30 个位置能跨过这座桥，只是 (2) 的排序把它们排在了后面。
        def legal_links(i):
            out = []
            st = fm.stations[i]
            for band in st.radio:
                for j in fm.neighbors(i, band):
                    if j not in sol.connected or fm.stations[j].is_candidate:
                        continue
                    m = fm.margin_of(i, j, band)
                    if m is not None:
                        out.append((m, j, band))
            out.sort(reverse=True)
            return out

        def port_free(i, band, ports):
            return ports.get((i, band), 0) < E.capacity(fm.stations[i].subtype, band)

        cand_idx = [i for i, st in enumerate(fm.stations)
                    if st.is_candidate and i not in self.base_relays]
        cache = {}

        def links_of(i):
            if i not in cache:
                cache[i] = legal_links(i)
            return cache[i]

        picked, used_sites = [], set()

        def site_of(i):
            return self.sid[i].split("-")[-1]

        def add(i, why):
            if site_of(i) in used_sites or len(picked) >= candidate_relays:
                return False
            if not links_of(i):
                return False
            used_sites.add(site_of(i))
            picked.append(dict(idx=i, links=links_of(i), why=why))
            return True

        # (1) 瓶颈导向
        base_adj = {}
        for eid, (a, b, band) in enumerate(self.base):
            base_adj.setdefault(a, []).append((b, eid))
            base_adj.setdefault(b, []).append((a, eid))
        nodes0 = sorted(set(base_adj) | {d for x in demands
                                        for d in (self.idx.get(x["src_node_id"]),
                                                  self.idx.get(x["dst_node_id"]))
                                        if d is not None})
        for v in nodes0:
            base_adj.setdefault(v, [])
        br, tin0, tout0, comp0 = _bridges_and_times(nodes0, base_adj)
        mand0 = [(self.idx[x["src_node_id"]], self.idx[x["dst_node_id"]]) for x in demands
                 if str(x.get("is_mandatory", "")).lower() == "true"
                 and x["src_node_id"] in self.idx and x["dst_node_id"] in self.idx]
        crit = []
        for u, v in br:
            lo, hi = tin0[v], tout0[v]
            cut = sum(1 for a, b in mand0 if (lo <= tin0[a] <= hi) != (lo <= tin0[b] <= hi))
            if cut:
                sub = {x for x in tin0 if lo <= tin0[x] <= hi and comp0.get(x) == comp0.get(v)}
                crit.append((cut, v, sub))
        crit.sort(key=lambda t: -t[0])
        # 按门限算每座桥最多允许切断几条必要通联；超标的桥才算关键桥
        allow = int(math.floor((1.0 - survivability_threshold) * max(1, len(mand0)) + 1e-9))
        crit = [t for t in crit if t[0] > allow]
        self.critical_bridges = [(c, self.sid[v]) for c, v, _s in crit]
        self.bridge_cut_allowed = allow
        per_bridge = 2
        for cut, v, sub in crit:
            if len(picked) >= candidate_relays * 3 // 4:
                break
            ranked = []
            for i in cand_idx:
                ins = [(m, j, b) for m, j, b in links_of(i)
                       if j in sub and port_free(j, b, self.ports_base)]
                outs = [(m, j, b) for m, j, b in links_of(i)
                        if j not in sub and port_free(j, b, self.ports_base)]
                if ins and outs:
                    ranked.append((min(ins[0][0], outs[0][0]), i))
            ranked.sort(reverse=True)
            k = 0
            for _m, i in ranked:
                if add(i, "BRIDGE:%s(切断%d条必要通联)" % (self.sid[v], cut)):
                    k += 1
                if k >= per_bridge:
                    break

        # (2) 覆盖导向补足
        rest = sorted(cand_idx, key=lambda i: (-len(links_of(i)), self.sid[i]))
        for i in rest:
            if len(picked) >= candidate_relays:
                break
            add(i, "COVERAGE")
        self.relay_cands = picked

        # 人工锁定（扩展 2）
        self.lock_backup = set()
        for lid in locked_links or ():
            for k, (a, b, band) in enumerate(self.backups):
                if lid in ("%s|%s|%s" % (self.sid[a], self.sid[b], band),
                           "%s|%s|%s" % (self.sid[b], self.sid[a], band)):
                    self.lock_backup.add(k)
        self.lock_relay = set()
        for site in locked_relays or ():
            for k, rc in enumerate(self.relay_cands):
                if self.sid[rc["idx"]].endswith(site):
                    self.lock_relay.add(k)

        # 需求：全部 / 必要
        self.demands = [(self.idx[d["src_node_id"]], self.idx[d["dst_node_id"]],
                         str(d.get("is_mandatory", "")).lower() == "true", d["demand_id"])
                        for d in demands
                        if d["src_node_id"] in self.idx and d["dst_node_id"] in self.idx]
        self.mandatory = [d for d in self.demands if d[2]]

    # —— 基因长度 ——
    @property
    def n_bits(self):
        return len(self.backups) + len(self.relay_cands)

    def margin_at_max(self, a, b, band):
        """两端都开到最大功率时的链路余量：余量对 min(tx) 是 1:1 的。"""
        m = self.fm.margin_of(a, b, band)
        if m is None:
            return None
        now = min(self.tx_now[(a, band)], self.tx_now[(b, band)])
        mx = min(self.tx_max[(a, band)], self.tx_max[(b, band)])
        return m + (mx - now)


# ─────────────────────────── 评估 ───────────────────────────

def decode(pb, genome):
    """基因 → 具体拓扑（含端口修复：超编成定额的备份链路按余量从低到高剔除）。"""
    bits, lvl = genome
    nb = len(pb.backups)
    links = list(pb.base)
    ports = dict(pb.ports_base)
    relays = []

    def cap(i, band):
        return E.capacity(pb.fm.stations[i].subtype, band)

    def take(i, band):
        ports[(i, band)] = ports.get((i, band), 0) + 1

    def free(i, band):
        return ports.get((i, band), 0) < cap(i, band)

    # 先放中继：按余量从高到低逐条接入合法对端，受两端端口约束；
    # 一条都接不上就不部署
    for k, rc in enumerate(pb.relay_cands):
        if not bits[nb + k]:
            continue
        i = rc["idx"]
        got = 0
        for m, j, band in rc["links"]:
            if free(i, band) and free(j, band):
                take(i, band)
                take(j, band)
                links.append((i, j, band))
                got += 1
        if got:
            relays.append(i)
    # 再放备份链路，按余量从高到低，放不下的丢弃
    chosen = [k for k in range(nb) if bits[k]]
    chosen.sort(key=lambda k: -(pb.fm.margin_of(*pb.backups[k]) or -1e9))
    for k in chosen:
        a, b, band = pb.backups[k]
        if free(a, band) and free(b, band):
            take(a, band)
            take(b, band)
            links.append((a, b, band))
    return links, relays, MARGIN_LEVELS[lvl]


def _usable(pb, links, m_req):
    out = []
    for a, b, band in links:
        m = pb.margin_at_max(a, b, band)
        if m is not None and m >= m_req:
            out.append((a, b, band, m))
    return out


def _total_power_w(pb, usable, m_req):
    want = {}
    for a, b, band, m_max in usable:
        tx_ref = min(pb.tx_max[(a, band)], pb.tx_max[(b, band)])
        p_req = tx_ref - (m_max - m_req)
        for k in ((a, band), (b, band)):
            want[k] = max(want.get(k, -1e9), p_req)
    total = 0.0
    for k, w in want.items():
        lv = pb.levels.get(k) or [pb.tx_max[k]]
        tx = next((x for x in sorted(lv) if x >= w - 1e-9), max(lv))
        total += 10.0 ** ((tx - 30.0) / 10.0)
    return total, len(want)


def _bridges_and_times(nodes, adj):
    """Tarjan 求桥，同时给出 DFS 进出时间戳（判断「在子树里」用）。迭代实现。"""
    tin, low, tout = {}, {}, {}
    bridges = []
    comp = {}
    t = 0
    for root in nodes:
        if root in tin:
            continue
        stack = [(root, -1, iter(adj[root]))]
        tin[root] = low[root] = t
        comp[root] = root
        t += 1
        while stack:
            v, pe, it = stack[-1]
            advanced = False
            for (w, eid) in it:
                if eid == pe:
                    continue
                if w in tin:
                    low[v] = min(low[v], tin[w])
                else:
                    tin[w] = low[w] = t
                    comp[w] = root
                    t += 1
                    stack.append((w, eid, iter(adj[w])))
                    advanced = True
                    break
            if not advanced:
                stack.pop()
                tout[v] = t
                t += 1
                if stack:
                    u = stack[-1][0]
                    low[u] = min(low[u], low[v])
                    if low[v] > tin[u]:
                        bridges.append((u, v))       # v 是桥下方的子树根
    return bridges, tin, tout, comp


def evaluate(pb, genome):
    links, relays, m_req = decode(pb, genome)
    usable = _usable(pb, links, m_req)
    nodes = set()
    adj = {}
    for eid, (a, b, band, _m) in enumerate(usable):
        nodes.update((a, b))
        adj.setdefault(a, []).append((b, eid))
        adj.setdefault(b, []).append((a, eid))
    for d in pb.demands:
        nodes.update((d[0], d[1]))
        adj.setdefault(d[0], [])
        adj.setdefault(d[1], [])
    bridges, tin, tout, comp = _bridges_and_times(sorted(nodes), adj)

    def conn(x, y):
        return comp.get(x) is not None and comp.get(x) == comp.get(y)

    all_ok = sum(1 for s, t, _m, _d in pb.demands if conn(s, t))
    man_ok = sum(1 for s, t, _m, _d in pb.mandatory if conn(s, t))
    connectivity = all_ok / max(1, len(pb.demands))
    mandatory_conn = man_ok / max(1, len(pb.mandatory))

    # 抗毁性：对每座桥，统计跨桥（一端在子树里、一端不在）的必要通联
    worst, worst_bridge = 1.0, None
    base_man = [(s, t) for s, t, _m, _d in pb.mandatory if conn(s, t)]
    for u, v in bridges:
        lo, hi = tin[v], tout[v]
        cut = 0
        for s, t in base_man:
            if comp.get(s) != comp.get(v):
                continue
            ins = lo <= tin[s] <= hi
            int_ = lo <= tin[t] <= hi
            if ins != int_:
                cut += 1
        frac = (man_ok - cut) / max(1, len(pb.mandatory))
        if frac < worst:
            worst, worst_bridge = frac, (u, v)
    survivability = worst if pb.mandatory else 1.0

    power_w, n_dev = _total_power_w(pb, usable, m_req)
    hops = _max_relay_chain(pb, usable, set(relays) | pb.base_relays)

    return dict(genome=genome, links=links, usable=usable, relays=relays, m_req=m_req,
                connectivity=connectivity, mandatory_connectivity=mandatory_conn,
                survivability=survivability, worst_bridge=worst_bridge,
                total_power_w=power_w, devices_on=n_dev, relay_hops=hops,
                bridges=len(bridges))


def _max_relay_chain(pb, usable, relays):
    """中继站之间直接相连形成的最长链（按节点数）。"""
    if not relays:
        return 0
    adj = {r: set() for r in relays}
    for a, b, _band, _m in usable:
        if a in relays and b in relays:
            adj[a].add(b)
            adj[b].add(a)
    best = 0
    for r in relays:
        seen = {r: 1}
        stack = [r]
        while stack:
            v = stack.pop()
            for w in adj[v]:
                if w not in seen:
                    seen[w] = seen[v] + 1
                    stack.append(w)
        best = max(best, max(seen.values()))
    return best


def violation(ev, cons):
    v = 0.0
    v += max(0.0, cons["mandatory_e2e_connectivity"] - ev["mandatory_connectivity"]) * 10
    v += max(0.0, cons["survivability_threshold"] - ev["survivability"])
    v += max(0, ev["relay_hops"] - cons["max_relay_hops"])
    return v


def _objs(ev):
    """统一成「越小越好」：(−连通率, 功率, −抗毁性)。"""
    return (-ev["connectivity"], ev["total_power_w"], -ev["survivability"])


def _dominates(a, b, cons):
    va, vb = a["_v"], b["_v"]
    if va == 0 and vb > 0:
        return True
    if va > 0 and vb == 0:
        return False
    if va > 0 and vb > 0:
        return va < vb
    oa, ob = _objs(a), _objs(b)
    return all(x <= y + 1e-12 for x, y in zip(oa, ob)) and any(x < y - 1e-12 for x, y in zip(oa, ob))


def _fronts(pop, cons):
    S = [[] for _ in pop]
    n = [0] * len(pop)
    fronts = [[]]
    for p in range(len(pop)):
        for q in range(len(pop)):
            if p == q:
                continue
            if _dominates(pop[p], pop[q], cons):
                S[p].append(q)
            elif _dominates(pop[q], pop[p], cons):
                n[p] += 1
        if n[p] == 0:
            pop[p]["_rank"] = 0
            fronts[0].append(p)
    i = 0
    while fronts[i]:
        nxt = []
        for p in fronts[i]:
            for q in S[p]:
                n[q] -= 1
                if n[q] == 0:
                    pop[q]["_rank"] = i + 1
                    nxt.append(q)
        i += 1
        fronts.append(nxt)
    return [f for f in fronts if f]


def _crowding(pop, front):
    for p in front:
        pop[p]["_crowd"] = 0.0
    if len(front) <= 2:
        for p in front:
            pop[p]["_crowd"] = float("inf")
        return
    for m in range(3):
        front.sort(key=lambda p: _objs(pop[p])[m])
        lo, hi = _objs(pop[front[0]])[m], _objs(pop[front[-1]])[m]
        pop[front[0]]["_crowd"] = pop[front[-1]]["_crowd"] = float("inf")
        if hi - lo < 1e-12:
            continue
        for k in range(1, len(front) - 1):
            pop[front[k]]["_crowd"] += (_objs(pop[front[k + 1]])[m]
                                        - _objs(pop[front[k - 1]])[m]) / (hi - lo)


# ─────────────────────────── NSGA-II ───────────────────────────

def optimize(pb, constraints=None, pop_size=40, generations=40, pareto_size=10,
             progress=None):
    cons = dict(DEFAULT_CONSTRAINTS)
    cons.update(constraints or {})
    rng = pb.rng
    L = pb.n_bits
    nb = len(pb.backups)

    def fix(bits):
        for k in pb.lock_backup:
            bits[k] = 1
        for k in pb.lock_relay:
            bits[nb + k] = 1
        return bits

    archive = []

    def ev(genome):
        e = evaluate(pb, genome)
        e["_v"] = violation(e, cons)
        archive.append(e)
        return e

    # 初始种群：几个极端种子 + 随机
    seeds = [([0] * L, 0), ([1] * L, 3), ([1] * nb + [0] * (L - nb), 1),
             ([0] * nb + [1] * (L - nb), 1), ([1] * L, 0)]
    pop = [ev((fix(list(b)), lv)) for b, lv in seeds]
    while len(pop) < pop_size:
        dens = rng.random()
        bits = [1 if rng.random() < dens else 0 for _ in range(L)]
        pop.append(ev((fix(bits), rng.randrange(len(MARGIN_LEVELS)))))

    evals = len(pop)
    for gen in range(generations):
        fr = _fronts(pop, cons)
        for f in fr:
            _crowding(pop, f)

        def tour():
            a, b = rng.sample(range(len(pop)), 2)
            pa, pb_ = pop[a], pop[b]
            if pa["_rank"] != pb_["_rank"]:
                return pa if pa["_rank"] < pb_["_rank"] else pb_
            return pa if pa["_crowd"] >= pb_["_crowd"] else pb_

        kids = []
        while len(kids) < pop_size:
            p1, p2 = tour(), tour()
            b1, b2 = p1["genome"][0], p2["genome"][0]
            child = [b1[k] if rng.random() < 0.5 else b2[k] for k in range(L)]
            pm = 1.0 / max(1, L)
            child = [1 - x if rng.random() < pm * 2 else x for x in child]
            lv = p1["genome"][1] if rng.random() < 0.5 else p2["genome"][1]
            if rng.random() < 0.15:
                lv = min(len(MARGIN_LEVELS) - 1, max(0, lv + rng.choice((-1, 1))))
            kids.append(ev((fix(child), lv)))
        evals += len(kids)
        union = pop + kids
        fr = _fronts(union, cons)
        nxt = []
        for f in fr:
            _crowding(union, f)
            if len(nxt) + len(f) <= pop_size:
                nxt += [union[i] for i in f]
            else:
                f.sort(key=lambda i: -union[i]["_crowd"])
                nxt += [union[i] for i in f[:pop_size - len(nxt)]]
                break
        pop = nxt
        if progress:
            progress(gen + 1, generations)

    fr = _fronts(pop, cons)
    for f in fr:
        _crowding(pop, f)
    first = [pop[i] for i in fr[0]]
    feasible = [e for e in first if e["_v"] == 0]
    # 按**目标值**去重：目标值相同、只是备份链路组合不同的解，对决策者是同一套方案。
    # 硬约束一加，可行域常常只剩少数几个目标点（本数据下抗毁性只有 87/96 一档可达），
    # 把十个同值解报成「十套方案」是误导。
    uniq, seen = [], set()
    pool = feasible or first
    # 无可行解时先挑**违约最小**的（离满足硬约束最近），再看连通率、抗毁性、功率。
    # 第一版直接按抗毁性排，会挑出一个抗毁性最高但连通率只有 0.952 的解。
    for e in sorted(pool, key=lambda e: (e["_v"], -e["mandatory_connectivity"],
                                         -e["connectivity"], -e["survivability"],
                                         e["total_power_w"], len(e["links"]))):
        key = _okey(e)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(e)
    if len(uniq) > pareto_size:
        uniq.sort(key=lambda e: -e.get("_crowd", 0))
        uniq = uniq[:pareto_size]
    uniq.sort(key=lambda e: (e["_v"], -e["mandatory_connectivity"], -e["connectivity"],
                             -e["survivability"], e["total_power_w"]))
    return dict(feasible=bool(feasible), solutions=uniq, population=pop,
                evaluations=evals, constraints=cons,
                tradeoff=tradeoff_front(archive, cons, pareto_size),
                infeasible=None if feasible else explain_infeasible(pop, cons))


def _okey(e):
    return (round(e["connectivity"], 4), round(e["total_power_w"], 1),
            round(e["survivability"], 4))


def tradeoff_front(archive, cons, size=10):
    """**不加抗毁性约束**时「功率 ↔ 抗毁性」的非支配前沿（必要通联全连通仍要求）。

    作为权衡参考单独给出，每个点都标明是否满足全部硬约束——让决策者看到
    「少用多少功率，要让出多少抗毁性」，而不是只看到一个可行点。
    """
    base = [e for e in archive
            if e["mandatory_connectivity"] >= cons["mandatory_e2e_connectivity"] - 1e-9
            and e["relay_hops"] <= cons["max_relay_hops"]]
    pts = {}
    for e in base:
        k = _okey(e)
        if k not in pts or len(e["links"]) < len(pts[k]["links"]):
            pts[k] = e
    cand = list(pts.values())
    front = []
    for a in cand:
        dom = False
        for b in cand:
            if b is a:
                continue
            if (b["total_power_w"] <= a["total_power_w"] + 1e-9
                    and b["survivability"] >= a["survivability"] - 1e-12
                    and b["connectivity"] >= a["connectivity"] - 1e-12
                    and (b["total_power_w"] < a["total_power_w"] - 1e-9
                         or b["survivability"] > a["survivability"] + 1e-12
                         or b["connectivity"] > a["connectivity"] + 1e-12)):
                dom = True
                break
        if not dom:
            front.append(a)
    front.sort(key=lambda e: (e["survivability"], e["total_power_w"]))
    if len(front) > size:
        step = (len(front) - 1) / float(size - 1)
        front = [front[int(round(k * step))] for k in range(size)]
    return front


def explain_infeasible(pop, cons):
    """扩展 1：指出冲突的硬约束，并按种群里实际达到的最好值给放宽建议。"""
    best_man = max(e["mandatory_connectivity"] for e in pop)
    best_surv = max(e["survivability"] for e in pop)
    min_hops = min(e["relay_hops"] for e in pop)
    reasons, tips = [], []
    if best_man < cons["mandatory_e2e_connectivity"] - 1e-9:
        reasons.append("本次搜索找到的必要通联端到端连通率最好值为 %.3f（要求 %.2f）"
                       % (best_man, cons["mandatory_e2e_connectivity"]))
        tips.append("先对不可达的必要通联调用部署规划补中继，或降低衰落余量档位")
    if best_surv < cons["survivability_threshold"] - 1e-9:
        # 措辞要准：这是本次搜索找到的最好值，**不是证明过的上界**。
        # 第 4 周吃过一次亏：候选中继口径不对时，三档加大搜索都收敛到 0.896，
        # 一度像是结构上限；修正候选口径后同一数据能到 0.906，满足 0.90。
        reasons.append("本次搜索找到的抗毁性最好值为 %.3f（要求 ≥ %.2f）；"
                       "此值是搜索结果而非已证上界" % (best_surv, cons["survivability_threshold"]))
        tips.append("把抗毁性门限放宽到 %.2f，或增加候选中继数量、放开编成定额中的备份端口"
                    % (math.floor(best_surv * 100) / 100))
    if min_hops > cons["max_relay_hops"]:
        reasons.append("中继跳数最少也有 %d（要求 ≤ %d）" % (min_hops, cons["max_relay_hops"]))
        tips.append("放宽中继跳数上限到 %d" % min_hops)
    return dict(conflicting_constraints=reasons, suggestions=tips,
                best_achievable=dict(mandatory_e2e_connectivity=round(best_man, 4),
                                     survivability=round(best_surv, 4),
                                     relay_hops=min_hops))


def describe(pb, e, cons, rank=None):
    """把一个解整理成接口文档 2.6 的形状。"""
    nb = len(pb.backups)
    added = []
    for i in e["relays"]:
        st = pb.fm.stations[i]
        added.append(dict(site_id=st.sid.split("-")[-1] if "-" in st.sid else st.sid,
                          station_id=st.sid, subtype=st.subtype,
                          lon=round(st.lon, 6), lat=round(st.lat, 6)))
    backups = [dict(node_a=pb.sid[a], node_b=pb.sid[b], band=band)
               for (a, b, band) in e["links"][len(pb.base):]
               if a not in e["relays"] and b not in e["relays"]]
    p_dbm = 10.0 * math.log10(max(e["total_power_w"], 1e-9) * 1000.0)
    wb = e["worst_bridge"]
    return dict(
        rank=rank,
        objectives=dict(e2e_connectivity=round(e["connectivity"], 4),
                        total_radiated_power_w=round(e["total_power_w"], 2),
                        total_radiated_power_dbm=round(p_dbm, 2),
                        survivability=round(e["survivability"], 4)),
        fade_margin_db=e["m_req"],
        added_relays=added,
        added_backup_links=backups,
        links_total=len(e["links"]), links_usable=len(e["usable"]),
        bridges=e["bridges"],
        worst_single_failure=dict(link=[pb.sid[wb[0]], pb.sid[wb[1]]]) if wb else None,
        constraint_check=dict(
            mandatory_e2e_connectivity=dict(value=round(e["mandatory_connectivity"], 4),
                                            required=cons["mandatory_e2e_connectivity"],
                                            **{"pass": e["mandatory_connectivity"]
                                               >= cons["mandatory_e2e_connectivity"] - 1e-9}),
            survivability=dict(value=round(e["survivability"], 4),
                               required=cons["survivability_threshold"],
                               **{"pass": e["survivability"]
                                  >= cons["survivability_threshold"] - 1e-9}),
            max_relay_hops=dict(value=e["relay_hops"], required=cons["max_relay_hops"],
                                **{"pass": e["relay_hops"] <= cons["max_relay_hops"]})),
    )


def compare(described):
    """多方案横向对比（扩展 3）：每个目标各自排名。"""
    keys = (("e2e_connectivity", True), ("total_radiated_power_w", False),
            ("survivability", True))
    rows = [dict(rank=d["rank"], **d["objectives"], fade_margin_db=d["fade_margin_db"],
                 relays=len(d["added_relays"]), backups=len(d["added_backup_links"]))
            for d in described]
    for k, desc in keys:
        order = sorted(range(len(rows)), key=lambda i: rows[i][k], reverse=desc)
        for pos, i in enumerate(order, start=1):
            rows[i]["rank_by_" + k] = pos
    return rows


# ─────────────────────────── 自检 ───────────────────────────

def _brute_survivability(pb, e):
    """暴力对拍：逐条删可用链路，重算连通分量，统计必要通联连通率的最小值。"""
    usable = e["usable"]
    nodes = set()
    for a, b, _band, _m in usable:
        nodes.update((a, b))
    for d in pb.demands:
        nodes.update((d[0], d[1]))

    def comps(skip):
        parent = {v: v for v in nodes}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for k, (a, b, _band, _m) in enumerate(usable):
            if k == skip:
                continue
            parent[find(a)] = find(b)
        return find
    f0 = comps(-1)
    worst = 1.0
    for k in range(len(usable)):
        f = comps(k)
        ok = sum(1 for s, t, _m, _d in pb.mandatory if f(s) == f(t))
        worst = min(worst, ok / max(1, len(pb.mandatory)))
    return worst


def _self_test():
    import time
    from plan_pipeline import run

    print("=" * 78)
    print("多目标优化组网自检（NSGA-II，自研，无求解器）")
    print("=" * 78)
    t0 = time.time()
    plan = run(verbose=False)
    t_plan = time.time() - t0
    t0 = time.time()
    pb = Problem(plan["fm"], plan["sol"], plan["demands"], plan["caps"])
    t_pb = time.time() - t0
    print("\n问题规模：基础链路 %d（树 + P1 中继），候选备份链路 %d，候选中继 %d，"
          "基因长度 %d 位 + 1 个余量档；通联需求 %d（必要 %d）"
          % (len(pb.base), len(pb.backups), len(pb.relay_cands), pb.n_bits,
             len(pb.demands), len(pb.mandatory)))
    print("准备耗时：规划 %.1f s + 建问题 %.1f s" % (t_plan, t_pb))

    print("\n[1] 抗毁性：求桥法 vs 暴力逐条删链路（必须完全一致）")
    rng = random.Random(7)
    mism = 0
    for k in range(12):
        dens = rng.random()
        g = ([1 if rng.random() < dens else 0 for _ in range(pb.n_bits)],
             rng.randrange(len(MARGIN_LEVELS)))
        e = evaluate(pb, g)
        bf = _brute_survivability(pb, e)
        same = abs(bf - e["survivability"]) < 1e-12
        mism += 0 if same else 1
        if k < 5 or not same:
            print("    解%02d 可用链路 %3d 桥 %3d  求桥法 %.4f  暴力 %.4f  %s"
                  % (k, len(e["usable"]), e["bridges"], e["survivability"], bf,
                     "✓" if same else "✗ 不一致"))
    print("    12 个随机解不一致 %d 个  %s" % (mism, "✓" if mism == 0 else "✗"))

    print("\n[2] 两个极端解（看约束能不能满足）")
    for name, g in (("什么都不加、门限 6 dB", ([0] * pb.n_bits, 0)),
                    ("全部加上、门限 6 dB", ([1] * pb.n_bits, 0))):
        e = evaluate(pb, g)
        print("    %-20s 连通 %.3f 必要 %.3f 抗毁 %.3f 功率 %.0f W 中继跳 %d 桥 %d"
              % (name, e["connectivity"], e["mandatory_connectivity"], e["survivability"],
                 e["total_power_w"], e["relay_hops"], e["bridges"]))

    print("\n[3] NSGA-II 求解")
    t0 = time.time()
    res = optimize(pb, pop_size=40, generations=40, pareto_size=10)
    el = time.time() - t0
    cons = res["constraints"]
    print("    评估 %d 次，耗时 %.1f s；有可行解：%s" % (res["evaluations"], el, res["feasible"]))
    if res["infeasible"]:
        inf = res["infeasible"]
        for r in inf["conflicting_constraints"]:
            print("    冲突：%s" % r)
        for t in inf["suggestions"]:
            print("    建议：%s" % t)
    desc = [describe(pb, e, cons, rank=k) for k, e in enumerate(res["solutions"], start=1)]
    print("    关键桥 %d 座（每座最多允许切断 %d 条必要通联），候选中继 %d 个"
          "（瓶颈导向 %d / 覆盖导向 %d）"
          % (len(pb.critical_bridges), pb.bridge_cut_allowed, len(pb.relay_cands),
             sum(1 for r in pb.relay_cands if r["why"].startswith("BRIDGE")),
             sum(1 for r in pb.relay_cands if r["why"] == "COVERAGE")))
    print("\n[4a] 权衡参考：不加抗毁性约束时「功率 ↔ 抗毁性」的前沿")
    print("    %8s %9s %8s %6s  %s" % ("抗毁性", "总功率W", "连通率", "门限", "满足全部硬约束"))
    for e in res["tradeoff"]:
        print("    %8.3f %9.0f %8.3f %6.0f  %s"
              % (e["survivability"], e["total_power_w"], e["connectivity"], e["m_req"],
                 "是" if violation(e, cons) == 0 else "否（抗毁性不足 %.2f）"
                 % cons["survivability_threshold"]))
    print("\n[4] 满足全部硬约束的方案（按目标值去重）")
    print("    %-4s %8s %9s %8s %6s %6s %6s %s"
          % ("序", "连通率", "总功率W", "抗毁性", "门限", "中继", "备份", "约束"))
    for d in desc:
        o, cc = d["objectives"], d["constraint_check"]
        allp = all(v["pass"] for v in cc.values())
        print("    %-4d %8.3f %9.0f %8.3f %6.0f %6d %6d %s"
              % (d["rank"], o["e2e_connectivity"], o["total_radiated_power_w"],
                 o["survivability"], d["fade_margin_db"], len(d["added_relays"]),
                 len(d["added_backup_links"]), "全部满足" if allp else "有违反"))

    print("\n[5] 非支配性自查：解集中不存在一个解被另一个解支配")
    bad = 0
    sols = res["solutions"]
    for a in sols:
        for b in sols:
            if a is not b and _dominates(a, b, cons) and a["_v"] == b["_v"] == 0:
                bad += 1
    print("    支配关系对数 %d  %s" % (bad, "✓" if bad == 0 else "✗"))

    print("\n[6] 锁定一个中继位置后重新求解（扩展 2）")
    if pb.relay_cands:
        site = pb.sid[pb.relay_cands[0]["idx"]].split("-")[-1]
        pb2 = Problem(plan["fm"], plan["sol"], plan["demands"], plan["caps"],
                      locked_relays=[site])
        r2 = optimize(pb2, pop_size=30, generations=20, pareto_size=5)
        has = all(any(pb2.sid[i].endswith(site) for i in e["relays"]) for e in r2["solutions"])
        print("    锁定 %s → %d 个解全部包含它：%s" % (site, len(r2["solutions"]),
                                               "✓" if has else "✗"))
    print("\n合计 %.1f s   [甲方指标 ≤300]" % (t_plan + t_pb + el))
    print("=" * 78)


if __name__ == "__main__":
    _self_test()
