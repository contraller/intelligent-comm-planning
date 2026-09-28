"""干扰影响分析与抗干扰措施推荐（SR-4.2.5）。

给定干扰源（位置、频率、带宽、功率、方向性、占空比），在已定的组网方案上计算：
受扰链路、受扰节点、干扰影响区域，并给出五类抗干扰措施及效果预评估。

实现的条目
----------
- a) 结合电波传播模型计算干扰影响：受扰节点清单、受扰链路清单、影响区域
- b) 按受扰程度分级（SEVERE / MODERATE / MINOR）
- c) 五类措施：频率调整 FREQ_ADJUST / 信道切换 CHANNEL_SWITCH / 功率优化 POWER_OPT /
     路由重构 ROUTE_REBUILD / 节点重部署 NODE_REDEPLOY，每条带效果预评估 `pre_eval`
- 扩展 1 多个干扰源按**功率线性域叠加**统一计算，不重复计数
- 扩展 2 无可行措施时列出受扰对象与受限原因（`unresolved`）
- 主事件流 7 采纳措施后更新方案（`adopt()`）

干扰计算
--------
接收端 r 受干扰源 k 的干扰功率（dBm）：

    I_k = P_k + G_k(方位) − L(k→r, f_k) + G_r − FDR(k, r) + 10·log10(占空比_k)

- 传播损耗 L 走 `propagation` 门面（超短波 P.1812、短波 P.368/P.533），
  **按干扰源自己的频率**算——干扰电波是按它的频率传播的。
- FDR 频率相关抑制：频谱有重叠时取「落入接收带宽的功率比例」；
  不重叠时按接收机选择性衰减，见 `fdr_db()`，斜率参数标**待确认**。
- 多源叠加：Σ 10^(I_k/10)，与噪声在线性域相加后求 SINR。

分级口径（本项目自拟，需规无对应条文）
--------------------------------------
- SEVERE   干扰后跌到 FAULT（余量 < 3 dB），或 SINR 下降 ≥ 20 dB
- MODERATE 链路状态至少降一级
- MINOR    状态未变但 SINR 下降 ≥ 3 dB
- 下降不足 3 dB 且状态不变 → 不计为受扰

两类频率措施的区分（本项目口径）
--------------------------------
- CHANNEL_SWITCH 信道切换：只在当前频点**邻近的预置信道**（候选频点序列 ±3 个）里换，
  操作快、只动本网，不做全网冲突重排，但如实报告冲突风险。
- FREQ_ADJUST 频率调整：在全网设备可用频段内重新选频，**要求不引入同频冲突**
  （按复用距离全网校验），可跨子频段。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from propagation import (vuhf_path_loss, hf_path_loss, noise_floor_dbm,
                         margin_to_state, REQUIRED_SNR_DB)
from terrain import haversine_m, BBOX
from feasibility import representative_freq
import gridgeo

# ── 口径参数（待确认）──────────────────────────────────
FDR_OFFTUNE_BASE_DB = 30.0      # 频谱不重叠时的起始抑制
FDR_OFFTUNE_SLOPE_DB = 20.0     # 每 10 倍频差再加的抑制
FDR_CAP_DB = 80.0               # 抑制上限；达到即视为无影响，不再算传播
DIR_BEAMWIDTH_DEG = 60.0        # 定向干扰源 3 dB 波束宽度（数据未给）
DIR_MAX_ATTEN_DB = 25.0         # 旁瓣最大衰减
AFFECT_DELTA_DB = 3.0
SEVERE_DELTA_DB = 20.0
RESTORED_MARGIN_DB = 3.0        # 措施后余量 ≥ 3 dB（不再是 FAULT）算「恢复可用」
REDEPLOY_RADIUS_M = 15000.0     # 节点重部署的搜索半径
CHANNEL_SWITCH_SPAN = 3         # 信道切换只在邻近 ±3 个候选频点内
AREA_REF_BW_KHZ = {E.HF: 3.0, E.VUHF: 12.5}
AREA_LEVELS = ((20.0, "SEVERE"), (10.0, "MODERATE"), (0.0, "MINOR"))   # I/N 门限

STATE_RANK = {"EXCELLENT": 3, "GOOD": 2, "WARNING": 1, "FAULT": 0}
LEVEL_RANK = {"SEVERE": 3, "MODERATE": 2, "MINOR": 1, None: 0}
SERVICE_OF_BAND = {E.HF: "话音", E.VUHF: "数据"}
COST_RANK = {"CHANNEL_SWITCH": 1, "FREQ_ADJUST": 2, "POWER_OPT": 3,
             "ROUTE_REBUILD": 4, "NODE_REDEPLOY": 5}


def _band_of_freq(f_khz):
    return E.HF if f_khz < 30000.0 else E.VUHF


class Jammer:
    """一个干扰源（interference_source.csv 的一行）。"""

    __slots__ = ("jid", "name", "lon", "lat", "h", "f", "bw", "p", "g",
                 "kind", "pattern", "az", "duty", "active")

    def __init__(self, row):
        self.jid = row["interference_id"]
        self.name = row.get("name", self.jid)
        self.lon, self.lat = float(row["lon"]), float(row["lat"])
        self.h = float(row.get("antenna_height_m") or 10.0)
        self.f = float(row["center_freq_khz"])
        self.bw = max(float(row.get("bandwidth_khz") or 1.0), 1e-3)
        self.p = float(row["tx_power_dbm"])
        self.g = float(row.get("antenna_gain_dbi") or 0.0)
        self.kind = row.get("interference_type", "NOISE")
        self.pattern = row.get("pattern_type", "OMNI") or "OMNI"
        self.az = float(row.get("azimuth_deg") or 0.0)
        self.duty = min(1.0, max(float(row.get("duty_cycle") or 1.0), 1e-3))
        self.active = str(row.get("active", "true")).lower() == "true"

    @property
    def band(self):
        return _band_of_freq(self.f)


def fdr_db(fj, bj, fr, br):
    """频率相关抑制：干扰功率里有多少进不了接收机（dB，越大越安全）。"""
    lo = max(fj - bj / 2.0, fr - br / 2.0)
    hi = min(fj + bj / 2.0, fr + br / 2.0)
    if hi > lo:
        # 频谱重叠：干扰功率按其带宽均匀分布，只有重叠部分进入接收带宽
        return max(0.0, -10.0 * math.log10((hi - lo) / bj))
    gap = max(fj - bj / 2.0 - (fr + br / 2.0), fr - br / 2.0 - (fj + bj / 2.0))
    return min(FDR_CAP_DB, FDR_OFFTUNE_BASE_DB
               + FDR_OFFTUNE_SLOPE_DB * math.log10(1.0 + gap / max(br, 1e-3)))


def _bearing_deg(lon1, lat1, lon2, lat2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def pattern_loss_db(j, lon, lat):
    """定向干扰源的方向图衰减：主瓣抛物线近似，旁瓣封顶。全向为 0。"""
    if j.pattern.upper() != "DIRECTIONAL":
        return 0.0
    off = abs((_bearing_deg(j.lon, j.lat, lon, lat) - j.az + 180.0) % 360.0 - 180.0)
    return min(DIR_MAX_ATTEN_DB, 12.0 * (off / DIR_BEAMWIDTH_DEG) ** 2)


class _PLCache:
    """干扰源 → 接收点的传播损耗缓存。损耗只取决于干扰源频率与两点位置，
    与受害链路的工作频率无关（那部分在 FDR 里），所以可以跨措施复用。"""

    def __init__(self, terrain, hour=12):
        self.terrain = terrain
        self.hour = hour
        self.memo = {}

    def loss(self, j, lon, lat, h_rx):
        key = (j.jid, round(lon, 6), round(lat, 6), round(h_rx, 1))
        v = self.memo.get(key)
        if v is None:
            a, b = (j.lon, j.lat), (lon, lat)
            if j.band == E.HF:
                v = hf_path_loss(self.terrain, a, b, j.f, "OMNI", self.hour)[0]
            else:
                v = vuhf_path_loss(self.terrain, a, b, j.f, j.h, h_rx)[0]
            self.memo[key] = v
        return v


def interference_at(cache, jammers, lon, lat, h_rx, g_rx, f_rx, b_rx):
    """某接收点在给定工作频率下受到的各干扰源功率 {jid: dBm}（已剔除可忽略者）。"""
    out = {}
    for j in jammers:
        fdr = fdr_db(j.f, j.bw, f_rx, b_rx)
        if fdr >= FDR_CAP_DB - 1e-9:
            continue
        pl = cache.loss(j, lon, lat, h_rx)
        out[j.jid] = (j.p + j.g - pattern_loss_db(j, lon, lat) + g_rx - pl - fdr
                      + 10.0 * math.log10(j.duty))
    return out


def _sum_dbm(values):
    if not values:
        return -300.0
    return 10.0 * math.log10(sum(10.0 ** (v / 10.0) for v in values))


# ─────────────────────────── 受害链路模型 ───────────────────────────

class VictimLink:
    """组网方案里的一条链路，两端各是一个接收机。"""

    __slots__ = ("link_id", "a", "b", "band", "f", "bw", "net_id",
                 "tx", "pl", "st_a", "st_b")

    def __init__(self, link_id, st_a, st_b, band, f, net_id=None):
        self.link_id = link_id
        self.st_a, self.st_b = st_a, st_b
        self.a, self.b = st_a.sid, st_b.sid
        self.band = band
        self.f = f
        self.bw = max(st_a.radio[band]["bw"], st_b.radio[band]["bw"])
        self.net_id = net_id
        self.tx = {self.a: st_a.radio[band]["tx_dbm"], self.b: st_b.radio[band]["tx_dbm"]}
        self.pl = None


class Scenario:
    """一次干扰分析的全部状态。措施预评估在它的副本上改参数重算。"""

    def __init__(self, stations, links, terrain, jammers, hour=12):
        self.stations = {s.sid: s for s in stations}
        self.links = links                     # [VictimLink]
        self.terrain = terrain
        self.jammers = [j for j in jammers if j.active]
        self.hour = hour
        self.cache = _PLCache(terrain, hour)
        self.pos = {s.sid: (s.lon, s.lat) for s in stations}
        self._sig = {}                         # (link_id, f, 位置签名) -> 路径损耗

    # —— 信号 ——
    def _signal_pl(self, lk):
        pa, pb = self.pos[lk.a], self.pos[lk.b]
        key = (lk.link_id, round(lk.f, 3), pa, pb)
        v = self._sig.get(key)
        if v is None:
            ra, rb = lk.st_a.radio[lk.band], lk.st_b.radio[lk.band]
            if lk.band == E.HF:
                pat = "NVIS" if "NVIS" in (ra["pattern"], rb["pattern"]) else "OMNI"
                v = hf_path_loss(self.terrain, pa, pb, lk.f, pat, self.hour)[0]
            else:
                v = vuhf_path_loss(self.terrain, pa, pb, lk.f,
                                   ra["height"], rb["height"])[0]
            self._sig[key] = v
        return v

    def end_state(self, lk, rx_sid):
        """某一端作为接收机的 (S, N, I 明细, SNR, SINR, 余量前, 余量后)。"""
        tx_sid = lk.b if rx_sid == lk.a else lk.a
        st_rx = self.stations[rx_sid]
        st_tx = self.stations[tx_sid]
        rr, rt = st_rx.radio[lk.band], st_tx.radio[lk.band]
        pl = self._signal_pl(lk)
        s = lk.tx[tx_sid] + rt["gain"] + rr["gain"] - pl
        n = noise_floor_dbm(lk.f, lk.bw)
        lon, lat = self.pos[rx_sid]
        ii = interference_at(self.cache, self.jammers, lon, lat, rr["height"],
                             rr["gain"], lk.f, lk.bw)
        i_tot = _sum_dbm(list(ii.values()))
        snr = s - n
        sinr = s - 10.0 * math.log10(10.0 ** (n / 10.0) + 10.0 ** (i_tot / 10.0))
        req = REQUIRED_SNR_DB.get(SERVICE_OF_BAND[lk.band], 10.0)
        sens_gap = s - rr["sens"]
        m_before = min(snr - req, sens_gap)
        m_after = min(sinr - req, sens_gap)
        return dict(rx=rx_sid, s=s, n=n, i=ii, i_total=i_tot, snr=snr, sinr=sinr,
                    margin_before=m_before, margin_after=m_after)

    def link_state(self, lk):
        ea, eb = self.end_state(lk, lk.a), self.end_state(lk, lk.b)
        worst = ea if ea["margin_after"] <= eb["margin_after"] else eb
        before = min(ea["margin_before"], eb["margin_before"])
        after = min(ea["margin_after"], eb["margin_after"])
        return dict(ends=(ea, eb), worst=worst, margin_before=before, margin_after=after,
                    level=grade(before, after,
                                worst["snr"] - worst["sinr"]))


def grade(m_before, m_after, delta_db):
    """受扰分级。返回 SEVERE / MODERATE / MINOR / None。"""
    sb, sa = margin_to_state(m_before), margin_to_state(m_after)
    dropped = STATE_RANK[sa] < STATE_RANK[sb]
    if delta_db < AFFECT_DELTA_DB and not dropped:
        return None
    if sa == "FAULT" and sb != "FAULT":
        return "SEVERE"
    if delta_db >= SEVERE_DELTA_DB:
        return "SEVERE"
    if dropped:
        return "MODERATE"
    return "MINOR"


def build_scenario(stations, topo_rows, terrain, jammer_rows, freq_of=None,
                   net_of=None, tx_of=None, hour=12):
    """由组网方案造分析场景。

    topo_rows  规划拓扑链路（link_id / node_a_id / node_b_id / device_class）
    freq_of    {link_id: freq_khz}，频率分配结果；缺省用代表频率
    net_of     {link_id: net_id}
    tx_of      {(node_id, band): tx_dbm}，参数规划结果；缺省用台站现值
    """
    by_id = {s.sid: s for s in stations}
    links = []
    for r in topo_rows:
        sa, sb = by_id.get(r["node_a_id"]), by_id.get(r["node_b_id"])
        band = r["device_class"]
        if sa is None or sb is None or band not in sa.radio or band not in sb.radio:
            continue
        f = (freq_of or {}).get(r["link_id"])
        if f is None:
            f = representative_freq(sa.radio[band], sb.radio[band], band)
        if f is None:
            continue
        lk = VictimLink(r["link_id"], sa, sb, band, f, (net_of or {}).get(r["link_id"]))
        for sid in (lk.a, lk.b):
            if tx_of and (sid, band) in tx_of:
                lk.tx[sid] = tx_of[(sid, band)]
        links.append(lk)
    return Scenario(stations, links, terrain, [Jammer(x) for x in jammer_rows], hour)


# ─────────────────────────── 分析 ───────────────────────────

def analyze(sc, area=True, area_cell_m=3000.0):
    """主分析：受扰链路、受扰节点、影响区域。"""
    states = {}
    affected_links = []
    for lk in sc.links:
        st = sc.link_state(lk)
        states[lk.link_id] = st
        if st["level"] is None:
            continue
        w = st["worst"]
        main_j = max(w["i"].items(), key=lambda kv: kv[1])[0] if w["i"] else None
        affected_links.append(dict(
            link_id=lk.link_id, node_a=lk.a, node_b=lk.b, band=lk.band,
            freq_khz=round(lk.f, 3), net_id=lk.net_id, level=st["level"],
            snr_before_db=round(w["snr"], 2), snr_after_db=round(w["sinr"], 2),
            delta_db=round(w["sinr"] - w["snr"], 2),
            margin_before_db=round(st["margin_before"], 2),
            margin_after_db=round(st["margin_after"], 2),
            state_before=margin_to_state(st["margin_before"]),
            state_after=margin_to_state(st["margin_after"]),
            victim_end=w["rx"],
            interference_id=main_j,
            contributions_dbm={k: round(v, 2) for k, v in sorted(
                w["i"].items(), key=lambda kv: -kv[1])},
        ))
    affected_links.sort(key=lambda x: (-LEVEL_RANK[x["level"]], x["delta_db"]))

    # 节点：取该节点作为接收端时恶化最大的那一条
    node_worst = {}
    for lk in sc.links:
        st = states[lk.link_id]
        if st["level"] is None:
            continue
        for e in st["ends"]:
            d = e["sinr"] - e["snr"]
            cur = node_worst.get(e["rx"])
            if cur is None or d < cur["delta"]:
                node_worst[e["rx"]] = dict(delta=d, e=e, level=st["level"])
    affected_nodes = []
    for sid, v in node_worst.items():
        if v["delta"] > -AFFECT_DELTA_DB and v["level"] is None:
            continue
        lvl = v["level"]
        affected_nodes.append(dict(node_id=sid, level=lvl,
                                   snr_before_db=round(v["e"]["snr"], 2),
                                   snr_after_db=round(v["e"]["sinr"], 2),
                                   delta_db=round(v["delta"], 2)))
    affected_nodes.sort(key=lambda x: (-LEVEL_RANK[x["level"]], x["delta_db"]))

    out = dict(affected_links=affected_links, affected_nodes=affected_nodes,
               _states=states,
               summary=dict(links=len(sc.links), jammers=len(sc.jammers),
                            affected_links=len(affected_links),
                            affected_nodes=len(affected_nodes),
                            by_level={k: sum(1 for x in affected_links if x["level"] == k)
                                      for k in ("SEVERE", "MODERATE", "MINOR")}))
    if area:
        out["affected_area"] = affected_area(sc, area_cell_m)
    return out


def _jammer_groups(jammers):
    """频谱互相重叠的干扰源才会同时打到同一台接收机，按此分组叠加。"""
    n = len(jammers)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for i in range(n):
        for k in range(i + 1, n):
            a, b = jammers[i], jammers[k]
            if min(a.f + a.bw / 2, b.f + b.bw / 2) > max(a.f - a.bw / 2, b.f - b.bw / 2):
                parent[find(i)] = find(k)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(jammers[i])
    return list(groups.values())


def affected_area(sc, cell_m=3000.0, bbox=BBOX):
    """干扰影响区域：一台调谐在干扰频点上的参考接收机，在各处看到的 I/N。

    参考接收机：全向 0 dBi，短波 3 m / 超短波 2 m，带宽取该频段典型值。
    频谱重叠的干扰源按线性功率叠加（扩展 1），不重叠的各自成组、取最重的一组。
    """
    nx, ny, mpd = gridgeo.grid_spec(bbox, cell_m)
    groups = _jammer_groups(sc.jammers)
    level_cells = {}
    for gx in range(nx):
        for gy in range(ny):
            lon, lat = gridgeo.cell_center(bbox, cell_m, gx, gy, mpd)
            best_in, best_ids = None, None
            for grp in groups:
                band = grp[0].band
                bw = AREA_REF_BW_KHZ[band]
                h = 3.0 if band == E.HF else 2.0
                terms, ids = [], []
                for j in grp:
                    pl = sc.cache.loss(j, lon, lat, h)
                    fdr = max(0.0, -10.0 * math.log10(min(1.0, bw / j.bw)))
                    ij = (j.p + j.g - pattern_loss_db(j, lon, lat) - pl - fdr
                          + 10.0 * math.log10(j.duty))
                    terms.append(ij)
                    ids.append((ij, j.jid))
                n = noise_floor_dbm(grp[0].f, bw)
                i_over_n = _sum_dbm(terms) - n
                if best_in is None or i_over_n > best_in:
                    tot = 10.0 ** (_sum_dbm(terms) / 10.0)
                    best_in = i_over_n
                    best_ids = sorted({jid for v, jid in ids
                                       if 10.0 ** (v / 10.0) >= 0.1 * tot})
            for thr, lvl in AREA_LEVELS:
                if best_in is not None and best_in >= thr:
                    level_cells.setdefault(lvl, {}).setdefault(
                        tuple(best_ids), set()).add((gx, gy))
                    break
    features = []
    for _thr, lvl in AREA_LEVELS:
        for ids, cells in sorted(level_cells.get(lvl, {}).items()):
            features.append(dict(
                type="Feature",
                properties=dict(level=lvl, interference_ids=list(ids),
                                area_km2=round(gridgeo.area_km2(cells, cell_m), 1),
                                i_over_n_min_db=_thr),
                geometry=gridgeo.cells_to_multipolygon(cells, bbox, cell_m, mpd)))
    return dict(type="FeatureCollection", features=features,
                properties=dict(cell_m=cell_m, bbox=list(bbox),
                                levels={lvl: "I/N ≥ %g dB" % thr for thr, lvl in AREA_LEVELS}))


# ─────────────────────────── 抗干扰措施 ───────────────────────────

def _affected_count(sc):
    return sum(1 for lk in sc.links if sc.link_state(lk)["level"] is not None)


class FreqContext:
    """频率措施需要的上下文：每个网的候选频点、当前全网频点分配、复用距离。

    由第 3 周频率分配结果构造（frequency.FreqTask + assign 结果）。
    """

    def __init__(self, tasks, assignments):
        self.tasks = {t.task_id: t for t in tasks}
        self.assign = {a["task_id"]: a["freq_khz"] for a in assignments
                       if a.get("freq_khz") is not None}
        self.net_of_link = {}
        for t in tasks:
            for lid in t.members:
                self.net_of_link[lid] = t.task_id

    def conflicts_if(self, net_id, f_new):
        """若把 net_id 换到 f_new，会与哪些网同频冲突。"""
        from frequency import _sep_m, DEFAULT_REUSE_M
        me = self.tasks[net_id]
        out = []
        for other_id, f in self.assign.items():
            if other_id == net_id or abs(f - f_new) > 1e-6:
                continue
            other = self.tasks.get(other_id)
            if other is None or other.band != me.band:
                continue
            reuse = next((c["reuse_min_distance_m"] for c in me.allowed
                          if abs(c["freq_khz"] - f_new) < 1e-6),
                         DEFAULT_REUSE_M.get(me.band, 25000.0))
            if _sep_m(me, other) < reuse:
                out.append(other_id)
        return out


def _net_links(sc, net_id, fallback_link=None):
    ls = [lk for lk in sc.links if lk.net_id == net_id] if net_id else []
    return ls or ([fallback_link] if fallback_link else [])


def _eval_freq(sc, links, f_new):
    old = [lk.f for lk in links]
    for lk in links:
        lk.f = f_new
    worst = min(sc.link_state(lk)["margin_after"] for lk in links)
    for lk, f in zip(links, old):
        lk.f = f
    return worst


def _apply_global(sc, mutate, undo):
    mutate()
    n = _affected_count(sc)
    undo()
    return n


def _freq_measures(sc, target, freq_ctx, n_before):
    """FREQ_ADJUST 与 CHANNEL_SWITCH。目标是整个网（同一网共用一个频点）。"""
    lk0 = target
    net_id = lk0.net_id or (freq_ctx.net_of_link.get(lk0.link_id) if freq_ctx else None)
    links = _net_links(sc, net_id, lk0)
    cur = lk0.f
    task = freq_ctx.tasks.get(net_id) if (freq_ctx and net_id) else None
    allowed = sorted({c["freq_khz"] for c in task.allowed}) if task else []
    out, reasons = [], []
    if not allowed:
        reasons.append("频率措施：缺少该网的候选频点信息（未提供频率分配结果）")
        return out, reasons

    # —— 信道切换：当前频点邻近的 ±N 个候选 ——
    if cur in allowed:
        k = allowed.index(cur)
    else:
        k = min(range(len(allowed)), key=lambda i: abs(allowed[i] - cur))
    near = [f for f in allowed[max(0, k - CHANNEL_SWITCH_SPAN):k + CHANNEL_SWITCH_SPAN + 1]
            if abs(f - cur) > 1e-6]
    best = None
    for f in near:
        m = _eval_freq(sc, links, f)
        if best is None or m > best[1]:
            best = (f, m)
    if best:
        f, m = best
        conf = freq_ctx.conflicts_if(net_id, f) if net_id else []
        n_after = _apply_global(sc, lambda: [setattr(x, "f", f) for x in links],
                                lambda: [setattr(x, "f", cur) for x in links])
        out.append(_cm("CHANNEL_SWITCH", dict(net_id=net_id, link_id=lk0.link_id),
                       dict(from_freq_khz=round(cur, 3), to_freq_khz=round(f, 3),
                            links_in_net=[x.link_id for x in links],
                            conflict_risk_with_nets=conf),
                       m, n_before, n_after,
                       note="只在邻近 ±%d 个候选信道内切换，不做全网重排；%s"
                            % (CHANNEL_SWITCH_SPAN,
                               "会与 %d 个网同频，需人工确认" % len(conf) if conf else "未引入同频冲突")))
    else:
        reasons.append("信道切换：当前频点邻近没有其它候选信道")

    # —— 频率调整：全部候选频点，要求不引入同频冲突 ——
    best = None
    blocked = 0
    for f in allowed:
        if abs(f - cur) < 1e-6:
            continue
        if net_id and freq_ctx.conflicts_if(net_id, f):
            blocked += 1
            continue
        m = _eval_freq(sc, links, f)
        if best is None or m > best[1]:
            best = (f, m)
    if best:
        f, m = best
        n_after = _apply_global(sc, lambda: [setattr(x, "f", f) for x in links],
                                lambda: [setattr(x, "f", cur) for x in links])
        out.append(_cm("FREQ_ADJUST", dict(net_id=net_id, link_id=lk0.link_id),
                       dict(from_freq_khz=round(cur, 3), to_freq_khz=round(f, 3),
                            links_in_net=[x.link_id for x in links],
                            candidates_blocked_by_reuse=blocked),
                       m, n_before, n_after,
                       note="在全网设备可用频段内重选，已按复用距离全网校验，不引入同频冲突"))
    else:
        reasons.append("频率调整：%d 个候选频点全部会与邻网同频冲突" % blocked)
    return out, reasons


def _power_measure(sc, lk, caps, n_before):
    reasons = []
    ends = []
    for sid in (lk.a, lk.b):
        c = (caps or {}).get((sid, lk.band))
        mx = c.tx_max if c else sc.stations[sid].radio[lk.band]["tx_dbm"]
        ends.append((sid, lk.tx[sid], mx))
    if all(new <= old + 1e-9 for _sid, old, new in ends):
        return None, ["功率优化：两端已是型号最大功率档"]
    touched = [x for x in sc.links if x.band == lk.band and (x.a in (lk.a, lk.b)
                                                             or x.b in (lk.a, lk.b))]
    saved = [(x, dict(x.tx)) for x in touched]

    def mutate():
        for x in touched:
            for sid, _old, new in ends:
                if sid in x.tx:
                    x.tx[sid] = new

    def undo():
        for x, tx in saved:
            x.tx = dict(tx)
    mutate()
    m = sc.link_state(lk)["margin_after"]
    undo()
    n_after = _apply_global(sc, mutate, undo)
    return _cm("POWER_OPT", dict(link_id=lk.link_id),
               dict(tx_changes=[dict(node_id=sid, band=lk.band, from_dbm=round(old, 2),
                                     to_dbm=round(new, 2)) for sid, old, new in ends],
                    side_effect="提高功率会同时扩大本网对邻网的互扰范围，采纳后应重跑频率冲突校验"),
               m, n_before, n_after,
               note="两端提到型号最大功率档"), reasons


def _route_measure(sc, lk, route_ctx, bad_links):
    """路由重构：让经过受扰链路的通联需求绕开所有中、重度受扰链路。"""
    if not route_ctx:
        return None, ["路由重构：未提供路由结果"]
    import routing
    g, routes = route_ctx
    through = [r for r in routes["routes"]
               if r.get("reachable") and lk.link_id in (r["primary"] or {}).get("link_path", [])]
    if not through:
        return None, []
    ok, fail = [], []
    for r in through:
        d = r["demand_id"]
        src, dst = r["primary"]["node_path"][0], r["primary"]["node_path"][-1]
        alt = routing.plan_one(g, src, dst, r.get("strategy", "MAX_RELIABILITY"),
                               banned_links=bad_links)
        (ok if alt else fail).append((d, alt))
    cm = _cm("ROUTE_REBUILD", dict(link_id=lk.link_id),
             dict(demands_through_link=len(through),
                  rerouted=[dict(demand_id=d, node_path=a["node_path"],
                                 hop_count=a["hop_count"],
                                 reliability=a["reliability"]) for d, a in ok],
                  still_unreachable=[d for d, _a in fail]),
             None, None, None,
             note="绕开全部中、重度受扰链路重新选路")
    cm["pre_eval"] = dict(demands_affected_before=len(through),
                          demands_restored=len(ok),
                          demands_unreachable_after=len(fail))
    cm["_restores"] = len(fail) == 0
    reasons = []
    if fail:
        reasons.append("路由重构：%d 条需求绕开受扰链路后无可达路径" % len(fail))
    return cm, reasons


def _redeploy_measure(sc, sid, candidate_rows, n_before, top=25):
    """节点重部署：在附近候选位置里找一个干扰更轻、且本站链路仍能达标的点。"""
    if not candidate_rows:
        return None, ["节点重部署：未提供候选位置"]
    st = sc.stations[sid]
    my = [lk for lk in sc.links if sid in (lk.a, lk.b)]
    if not my:
        return None, []
    lon0, lat0 = sc.pos[sid]
    near = []
    for r in candidate_rows:
        if str(r.get("is_deployable", "true")).lower() != "true":
            continue
        d = haversine_m(lon0, lat0, float(r["lon"]), float(r["lat"]))
        if d <= REDEPLOY_RADIUS_M:
            near.append((d, r))
    near.sort(key=lambda x: x[0])
    near = near[:top]
    if not near:
        return None, ["节点重部署：%.0f km 内没有可部署的候选位置" % (REDEPLOY_RADIUS_M / 1000)]
    base = min(sc.link_state(lk)["margin_after"] for lk in my)
    best = None
    for d, r in near:
        sc.pos[sid] = (float(r["lon"]), float(r["lat"]))
        m = min(sc.link_state(lk)["margin_after"] for lk in my)
        sc.pos[sid] = (lon0, lat0)
        if best is None or m > best[1]:
            best = (r, m, d)
    r, m, d = best
    if m <= base + 1e-6:
        return None, ["节点重部署：%.0f km 内 %d 个候选位置均不优于原位置"
                      % (REDEPLOY_RADIUS_M / 1000, len(near))]
    new = (float(r["lon"]), float(r["lat"]))
    n_after = _apply_global(sc, lambda: sc.pos.__setitem__(sid, new),
                            lambda: sc.pos.__setitem__(sid, (lon0, lat0)))
    return _cm("NODE_REDEPLOY", dict(node_id=sid),
               dict(to_site_id=r["site_id"], to_lon=new[0], to_lat=new[1],
                    move_distance_m=round(d, 1), links_of_node=[lk.link_id for lk in my]),
               m, n_before, n_after,
               note="在 %.0f km 内的候选位置中选受扰最轻、本站链路余量最好者"
                    % (REDEPLOY_RADIUS_M / 1000)), []


def _cm(kind, target, detail, margin_after, n_before, n_after, note=""):
    cm = dict(type=kind, target=target, detail=detail, note=note)
    if margin_after is not None:
        cm["pre_eval"] = dict(margin_after_db=round(margin_after, 2),
                              state_after=margin_to_state(margin_after),
                              affected_link_count_before=n_before,
                              affected_link_count_after=n_after)
        cm["_restores"] = margin_after >= RESTORED_MARGIN_DB
    return cm


def recommend(sc, analysis, freq_ctx=None, caps=None, route_ctx=None,
              candidate_rows=None, max_targets=30):
    """为中、重度受扰对象生成五类措施并排序（SR-4.2.5 c）。

    返回 (countermeasures, unresolved)。
    - 同一目标的措施按「能否恢复可用」优先、再按操作代价排 priority；
    - 一个受扰对象若五类措施都不能恢复，列入 unresolved 并说明原因（扩展 2）。
    """
    n_before = analysis["summary"]["affected_links"]
    by_id = {lk.link_id: lk for lk in sc.links}
    serious = [x for x in analysis["affected_links"] if x["level"] in ("SEVERE", "MODERATE")]
    bad_links = {x["link_id"] for x in serious}
    if route_ctx:
        import routing
        g, routes = route_ctx
        route_ctx = (g, routes)

    cms, unresolved = [], []
    seen_nets = set()
    reasons_of = {}
    for x in serious[:max_targets]:
        lk = by_id[x["link_id"]]
        cand, reasons = [], []
        net = lk.net_id or (freq_ctx.net_of_link.get(lk.link_id) if freq_ctx else None)
        if net not in seen_nets or net is None:
            fm_, rs = _freq_measures(sc, lk, freq_ctx, n_before)
            cand += fm_
            reasons += rs
            if net:
                seen_nets.add(net)
        pm, rs = _power_measure(sc, lk, caps, n_before)
        reasons += rs
        if pm:
            cand.append(pm)
        rm, rs = _route_measure(sc, lk, route_ctx, bad_links)
        reasons += rs
        if rm:
            cand.append(rm)
        reasons_of[lk.link_id] = list(reasons)
        cand.sort(key=lambda c: (not c.get("_restores", False), COST_RANK[c["type"]]))
        for p, c in enumerate(cand, start=1):
            c["priority"] = p
            c["target_level"] = x["level"]
        cms += cand
        if not any(c.get("_restores") for c in cand):
            unresolved.append(dict(kind="LINK", link_id=lk.link_id, level=x["level"],
                                   margin_after_db=x["margin_after_db"],
                                   reasons=reasons or ["各类措施均不能把余量恢复到 %.0f dB 以上"
                                                       % RESTORED_MARGIN_DB]))

    node_reasons = {}
    for nd in [n for n in analysis["affected_nodes"] if n["level"] == "SEVERE"][:10]:
        rm, rs = _redeploy_measure(sc, nd["node_id"], candidate_rows, n_before)
        node_reasons[nd["node_id"]] = rs
        if rm:
            rm["priority"] = 1 if rm.get("_restores") else 5
            rm["target_level"] = "SEVERE"
            cms.append(rm)
        elif rs:
            unresolved.append(dict(kind="NODE", node_id=nd["node_id"], level="SEVERE",
                                   reasons=rs))

    # 若某链路的节点重部署能恢复，就不该再算它「无解」
    fixed_by_move = set()
    for c in cms:
        if c["type"] == "NODE_REDEPLOY" and c.get("_restores"):
            fixed_by_move.update(c["detail"]["links_of_node"])
    unresolved = [u for u in unresolved if u.get("link_id") not in fixed_by_move]

    for c in cms:
        c["restores"] = bool(c.pop("_restores", False))
    cms.sort(key=lambda c: (-LEVEL_RANK.get(c.get("target_level"), 0),
                            c.get("priority", 9), COST_RANK[c["type"]]))
    review = five_type_review(serious[:max_targets], cms, reasons_of, node_reasons, by_id)
    return cms, unresolved, review


_REASON_PREFIX = {"信道切换": "CHANNEL_SWITCH", "频率调整": "FREQ_ADJUST",
                  "功率优化": "POWER_OPT", "路由重构": "ROUTE_REBUILD",
                  "节点重部署": "NODE_REDEPLOY"}


def five_type_review(serious, cms, reasons_of, node_reasons, by_id):
    """每个受扰对象的**五类措施逐项结论**（SR-4.2.5 c「五类措施的分析结果」）。

    某类措施没生成也要说清为什么——「两端已是最大功率档」本身就是分析结论，
    不能让它悄悄缺席。
    """
    out = []
    for x in serious:
        lid = x["link_id"]
        lk = by_id[lid]
        row = dict(link_id=lid, level=x["level"], measures={})
        for kind in COST_RANK:
            if kind == "NODE_REDEPLOY":
                hit = [c for c in cms if c["type"] == kind
                       and lid in c["detail"].get("links_of_node", [])]
            elif kind in ("CHANNEL_SWITCH", "FREQ_ADJUST"):
                hit = [c for c in cms if c["type"] == kind
                       and (c["target"].get("link_id") == lid
                            or lid in c["detail"].get("links_in_net", []))]
            else:
                hit = [c for c in cms if c["type"] == kind and c["target"].get("link_id") == lid]
            if hit:
                best = max(hit, key=lambda c: (c["restores"],
                                               c.get("pre_eval", {}).get("margin_after_db", -1e9)))
                row["measures"][kind] = dict(status="GENERATED", restores=best["restores"],
                                             priority=best.get("priority"))
                continue
            why = [r for r in reasons_of.get(lid, [])
                   if _REASON_PREFIX.get(r.split("：", 1)[0]) == kind
                   or (r.startswith("频率措施") and kind in ("CHANNEL_SWITCH", "FREQ_ADJUST"))]
            if kind == "NODE_REDEPLOY":
                for sid in (lk.a, lk.b):
                    why += node_reasons.get(sid, [])
                if not why:
                    why = ["两端节点均未达到严重受扰，未评估重部署"]
            if kind == "ROUTE_REBUILD" and not why:
                why = ["该链路上没有承载通联需求的主用路由"]
            row["measures"][kind] = dict(status="NOT_APPLICABLE",
                                         reason="；".join(why) or "未生成")
        out.append(row)
    return out


def adopt(sc, cm):
    """采纳一条措施（主事件流 7）：把改动写进场景，返回改动后的全网受扰概况。"""
    kind, det = cm["type"], cm["detail"]
    changed = {}
    if kind in ("FREQ_ADJUST", "CHANNEL_SWITCH"):
        ids = set(det.get("links_in_net") or [cm["target"].get("link_id")])
        for lk in sc.links:
            if lk.link_id in ids:
                lk.f = det["to_freq_khz"]
        changed["frequency"] = dict(links=sorted(ids), freq_khz=det["to_freq_khz"])
    elif kind == "POWER_OPT":
        for ch in det["tx_changes"]:
            for lk in sc.links:
                if lk.band == ch["band"] and ch["node_id"] in lk.tx:
                    lk.tx[ch["node_id"]] = ch["to_dbm"]
        changed["power"] = det["tx_changes"]
    elif kind == "NODE_REDEPLOY":
        sid = cm["target"]["node_id"]
        sc.pos[sid] = (det["to_lon"], det["to_lat"])
        changed["position"] = dict(node_id=sid, site_id=det["to_site_id"],
                                   lon=det["to_lon"], lat=det["to_lat"])
    elif kind == "ROUTE_REBUILD":
        changed["routes"] = det["rerouted"]
    after = analyze(sc, area=False)
    return dict(adopted=cm["type"], changed=changed,
                summary_after=after["summary"])


# ─────────────────────────── 自检 ───────────────────────────

def scenario_from_plan(plan, jammer_rows, hour=12):
    """由第 3 周全流程结果造干扰分析场景：用分配到的频点与参数规划后的功率。"""
    la = plan["frequency"].get("link_assignments") or []
    if not la:
        from frequency import expand_to_links
        la = expand_to_links(plan["frequency"], plan["freq_tasks"])
    freq_of = {r["link_id"]: r["freq_khz"] for r in la if r.get("freq_khz") is not None}
    net_of = {r["link_id"]: r.get("net_id") for r in la}
    tx_of = {(p["node_id"], p["band"]): p["tx_power_dbm"] for p in plan["params"]["params"]}
    return build_scenario(plan["stations"], plan["links"], plan["terrain"], jammer_rows,
                          freq_of=freq_of, net_of=net_of, tx_of=tx_of, hour=hour)


def _self_test():
    import csv
    import time
    from datapaths import path as dpath
    from plan_pipeline import run

    def load(rel):
        with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    print("=" * 78)
    print("干扰影响分析与抗干扰推荐自检（第 3 周方案 + 真实干扰源表）")
    print("=" * 78)
    t0 = time.time()
    plan = run(verbose=False)
    t_plan = time.time() - t0
    jam = load("interference_source.csv")
    print("\n规划方案：%d 条链路，%.1f s 生成；干扰源 %d 个（生效 %d）"
          % (len(plan["links"]), t_plan, len(jam),
             sum(1 for r in jam if str(r.get("active")).lower() == "true")))

    print("\n[1] FDR 频率相关抑制（接收 25 kHz @ 300 MHz）")
    for fj, bj, note in ((300000, 25, "同频同宽"), (300000, 200, "同频、干扰带宽 8 倍"),
                         (300050, 25, "相邻信道"), (310000, 25, "相距 10 MHz"),
                         (5000, 3, "短波干扰打超短波")):
        print("    %-18s FDR = %5.1f dB" % (note, fdr_db(fj, bj, 300000, 25)))

    t0 = time.time()
    sc = scenario_from_plan(plan, jam)
    ana = analyze(sc, area=True, area_cell_m=3000.0)
    t_ana = time.time() - t0
    s = ana["summary"]
    print("\n[2] 受扰链路与节点（SR-4.2.5 a/b）   耗时 %.1f s" % t_ana)
    print("    链路 %d 条中受扰 %d 条：严重 %d / 中度 %d / 轻度 %d；受扰节点 %d 个"
          % (s["links"], s["affected_links"], s["by_level"]["SEVERE"],
             s["by_level"]["MODERATE"], s["by_level"]["MINOR"], s["affected_nodes"]))
    for x in ana["affected_links"][:5]:
        print("    %-8s %-9s %s—%s %-4s %9.1f kHz  SNR %6.1f → %6.1f dB  %s → %s  主因 %s"
              % (x["level"], x["link_id"], x["node_a"], x["node_b"], x["band"],
                 x["freq_khz"], x["snr_before_db"], x["snr_after_db"],
                 x["state_before"], x["state_after"], x["interference_id"]))

    print("\n[3] 多源叠加不重复计数（扩展 1）")
    multi = [x for x in ana["affected_links"] if len(x["contributions_dbm"]) > 1]
    if multi:
        x = multi[0]
        tot = _sum_dbm(list(x["contributions_dbm"].values()))
        print("    %s 同时受 %d 个源：%s → 线性叠加 %.1f dBm（不是简单相加 dB）"
              % (x["link_id"], len(x["contributions_dbm"]),
                 "、".join("%s %.1f" % kv for kv in x["contributions_dbm"].items()), tot))
    else:
        print("    本方案下没有链路同时受多个源显著影响")

    area = ana["affected_area"]
    print("\n[4] 影响区域（I/N 分级，3 km 栅格）")
    for f in area["features"][:6]:
        pr = f["properties"]
        print("    %-8s %7.0f km²  来源 %s" % (pr["level"], pr["area_km2"],
                                            "、".join(pr["interference_ids"])))

    from frequency import FreqPool
    fctx = FreqContext(plan["freq_tasks"], plan["frequency"]["assignments"])
    t0 = time.time()
    cms, unresolved, review = recommend(sc, ana, freq_ctx=fctx, caps=plan["caps"],
                                route_ctx=(plan["graph"], plan["routes"]),
                                candidate_rows=load("candidate_site.csv"))
    t_cm = time.time() - t0
    print("\n[5] 抗干扰措施（SR-4.2.5 c）   耗时 %.1f s" % t_cm)
    from collections import Counter
    kinds = Counter(c["type"] for c in cms)
    ok = Counter(c["type"] for c in cms if c["restores"])
    for k in ("CHANNEL_SWITCH", "FREQ_ADJUST", "POWER_OPT", "ROUTE_REBUILD", "NODE_REDEPLOY"):
        print("    %-15s 生成 %3d 条，能恢复可用 %3d 条" % (k, kinds[k], ok[k]))
    missing = [k for k in COST_RANK if kinds[k] == 0]
    print("    五类是否都出现：%s" % ("是 ✓" if not missing else "缺 %s" % missing))
    for c in cms[:4]:
        pe = c.get("pre_eval", {})
        print("    [P%d] %-14s 目标 %s  %s" % (c["priority"], c["type"], c["target"],
              ("余量 → %.1f dB，全网受扰 %s → %s 条" % (pe["margin_after_db"],
               pe["affected_link_count_before"], pe["affected_link_count_after"]))
              if "margin_after_db" in pe else pe))

    print("\n[5b] 五类措施逐项结论（每个受扰对象都要有五条，不适用也要说原因）")
    for row in review[:2]:
        print("    %s（%s）" % (row["link_id"], row["level"]))
        for kind, v in row["measures"].items():
            if v["status"] == "GENERATED":
                print("      %-15s 已生成  能恢复=%s  P%s" % (kind, v["restores"], v["priority"]))
            else:
                print("      %-15s 不适用  %s" % (kind, v["reason"]))
    full = all(len(r["measures"]) == 5 for r in review)
    print("    每个对象五类齐全：%s" % ("是 ✓" if full else "否 ✗"))

    print("\n[6] 无可行措施的对象（扩展 2）：%d 个" % len(unresolved))
    for u in unresolved[:3]:
        print("    %s %s：%s" % (u["kind"], u.get("link_id") or u.get("node_id"),
                               "；".join(u["reasons"][:2])))

    best = next((c for c in cms if c["restores"] and c["type"] != "ROUTE_REBUILD"), None)
    if best:
        print("\n[7] 采纳一条措施后重算（主事件流 7）")
        before = ana["summary"]["affected_links"]
        res = adopt(sc, best)
        print("    采纳 %s → 全网受扰链路 %d → %d 条"
              % (res["adopted"], before, res["summary_after"]["affected_links"]))
    print("\n合计耗时 %.1f s（规划 %.1f + 分析 %.1f + 措施 %.1f）   [甲方指标 ≤300]"
          % (t_plan + t_ana + t_cm, t_plan, t_ana, t_cm))
    print("=" * 78)


if __name__ == "__main__":
    _self_test()
