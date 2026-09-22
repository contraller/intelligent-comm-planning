"""链路可行性矩阵（方案 4.2）。

传播计算昂贵，搜索过程只做位运算，因此把可行性一次算完、存成位图。
每个频段两张矩阵：

    damaged[band]  物理可行 且 频段一致          —— 作战损伤工况可用
    normal[band]   上式 且 (echelon, subtype) 跃迁合法 —— 正常工况可用

normal 恒为 damaged 的子集；两者的差就是「编成不允许但物理能通」的链路，
无解诊断要靠这个差集区分「物理不可达」与「层级不允许」两类原因（方案 4.4）。

三重判据（方案 3.2）：
    (a) 物理可行  M(u,v) = Pt + Gt + Gr - L - N - SNRreq >= M_min
    (b) 频段一致  band(u) == band(v)      ← 「db 不能和 cdb 相连」，任何工况都不放宽
    (c) 编成可行  (ℓ,τ) 跃迁合法           ← 仅正常工况

判据 (b) 由数据结构本身保证：矩阵按频段分开建，一个节点只在它**实际装备**了
该频段时才进入该频段的矩阵。跨频段的点对在任何一张矩阵里都不存在，
不需要写判断——这与方案 4.3 流网络的拆点结构是同一套表达。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from devicespec import SpecFiller
from terrain import haversine_m
from propagation import vuhf_path_loss, hf_path_loss, link_budget, margin_to_state

DEFAULT_MARGIN_MIN = 6.0          # dB，链路可用的余量门限
MAX_RANGE_M = {E.HF: 175000.0, E.VUHF: 95000.0}   # 超出即不必算传播
DEFAULT_FREQ_KHZ = {E.HF: 5000.0, E.VUHF: 31325.0}


class Station:
    """参与链路计算的一个台站。

    一个台站可能同时持有两个频段的电台（Ⅱ、Ⅲ 即如此），
    每个频段的射频参数分开存 —— 这是双频节点能做频段转换的数据基础。
    """

    __slots__ = ("sid", "lon", "lat", "subtype", "radio", "is_candidate")

    def __init__(self, sid, lon, lat, subtype, radio, is_candidate=False):
        self.sid = sid
        self.lon = float(lon)
        self.lat = float(lat)
        self.subtype = subtype
        self.radio = radio            # {band: dict(tx_dbm, gain, height, sens, bw, pattern)}
        self.is_candidate = is_candidate

    def has(self, band):
        return band in self.radio

    def __repr__(self):
        return "Station(%s,%s,%s)" % (self.sid, self.subtype, "/".join(sorted(self.radio)))


def stations_from_nodes(nodes, devices, models, antennas):
    """由 node / device / device_model / antenna_model 四张表装配台站列表。

    **频段由设备型号决定，不读 node.device_class 字符串** —— 双频节点的
    device_class 是 "HF;VUHF"，字符串比较在这里会出错（见交接 2026-09-18）。
    """
    model_by_id = {m["model_id"]: m for m in models}
    ant_by_id = {a["antenna_id"]: a for a in antennas}
    # 真实型号库按任务单要求「查不到留空」，空字段按 devicespec 的可追溯规则代入
    filler = SpecFiller(models)
    per_node = {}
    for d in devices:
        m = model_by_id.get(d["model_id"])
        a = ant_by_id.get(d["antenna_id"])
        if not m or not a:
            continue
        band = m["device_class"]
        slot = per_node.setdefault(d["node_id"], {})
        if band in slot:
            continue                    # 同频段多台，取第一台的射频参数即可
        slot[band] = dict(
            tx_dbm=float(d["tx_power_dbm"]),
            gain=float(a["gain_dbi"]),
            height=float(d["antenna_height_m"]),
            sens=filler.sensitivity(m),
            bw=filler.bandwidth(m),
            pattern=a["pattern_type"],
            fmin=float(m["freq_min_khz"]),
            fmax=float(m["freq_max_khz"]))
    out = []
    for n in nodes:
        radio = per_node.get(n["node_id"])
        if not radio:
            continue
        out.append(Station(n["node_id"], n["lon"], n["lat"],
                           n["node_subtype"], radio))
    return out


def link_margin(terrain, sa, sb, band, freq_khz=None):
    """算一条链路的余量 dB。两端都必须持有该频段，否则是调用方的错。"""
    ra, rb = sa.radio[band], sb.radio[band]
    f = freq_khz or DEFAULT_FREQ_KHZ[band]
    pa, pb = (sa.lon, sa.lat), (sb.lon, sb.lat)
    if band == E.HF:
        pat = "NVIS" if "NVIS" in (ra["pattern"], rb["pattern"]) else "OMNI"
        pl, los, clr, dist = hf_path_loss(terrain, pa, pb, f, pat)
        svc = "话音"
    else:
        pl, los, clr, dist = vuhf_path_loss(terrain, pa, pb, f,
                                            ra["height"], rb["height"])
        svc = "数据"
    rx, snr, margin = link_budget(min(ra["tx_dbm"], rb["tx_dbm"]),
                                  ra["gain"], rb["gain"], pl, f, ra["bw"], svc,
                                  max(ra["sens"], rb["sens"]))
    return margin, dist, pl


class FeasibilityMatrix:
    """两张位图矩阵，按频段分别建立。

    位图用 Python int：`|` `&` `bin(x).count('1')` 由 C 实现，
    比 list / set 快一个数量级，且无第三方依赖。
    """

    def __init__(self, stations, terrain, margin_min=DEFAULT_MARGIN_MIN, verbose=False,
                 candidate_pairs=True):
        """candidate_pairs=False 时**跳过候选点两两之间**的传播计算。

        规模测试实测：1100 候选 × 4 类型 + 132 台站 = 4532 个台站，
        全量两两要 4.7 M 对、约 50 s，其中绝大多数是候选×候选——
        而贪心每轮只会选中一两个候选，这些对算了也白算。
        跳过后降到候选×现有的 1.2 M 对。选中之后再用 extend_pairs 补算那几对即可。
        """
        self.stations = list(stations)
        self.margin_min = float(margin_min)
        self.terrain = terrain
        self.index = {s.sid: i for i, s in enumerate(self.stations)}
        self.normal = {}          # band -> [bitmask per station index]
        self.damaged = {}
        self.margins = {}         # (i, j, band) -> margin dB，i < j
        self._stats = {}
        self._build(terrain, verbose, candidate_pairs)

    def _build(self, terrain, verbose, candidate_pairs=True):
        n = len(self.stations)
        for band in E.BANDS:
            holders = [i for i, s in enumerate(self.stations) if s.has(band)]
            dmg = [0] * n
            nml = [0] * n
            cnt_phys = cnt_norm = cnt_far = 0
            for ii in range(len(holders)):
                i = holders[ii]
                sa = self.stations[i]
                for jj in range(ii + 1, len(holders)):
                    j = holders[jj]
                    sb = self.stations[j]
                    if not candidate_pairs and sa.is_candidate and sb.is_candidate:
                        continue
                    d = haversine_m(sa.lon, sa.lat, sb.lon, sb.lat)
                    if d > MAX_RANGE_M[band]:
                        cnt_far += 1
                        continue
                    margin, dist, _ = link_margin(terrain, sa, sb, band)
                    if margin < self.margin_min:
                        continue
                    # (a)+(b) 通过 → 损伤工况可用
                    dmg[i] |= 1 << j
                    dmg[j] |= 1 << i
                    self.margins[(i, j, band)] = margin
                    cnt_phys += 1
                    # (c) 编成 → 正常工况可用
                    if E.relation_allowed(sa.subtype, sb.subtype, band):
                        nml[i] |= 1 << j
                        nml[j] |= 1 << i
                        cnt_norm += 1
            self.damaged[band] = dmg
            self.normal[band] = nml
            self._stats[band] = dict(holders=len(holders), physical=cnt_phys,
                                     normal=cnt_norm, out_of_range=cnt_far)
            if verbose:
                print("  %-5s 持有台站 %3d  物理可行 %5d 条  编成允许 %5d 条  "
                      "(编成剪掉 %.0f%%)"
                      % (band, len(holders), cnt_phys, cnt_norm,
                         100.0 * (cnt_phys - cnt_norm) / max(1, cnt_phys)))

    def extend_pairs(self, indices):
        """补算给定台站集合内部的两两可行性（建矩阵时跳过的那部分）。

        贪心选中若干候选后调用，规模只有几对，代价可忽略。
        """
        idx = sorted(set(indices))
        added = 0
        for band in E.BANDS:
            hs = [i for i in idx if self.stations[i].has(band)]
            for ii in range(len(hs)):
                i = hs[ii]
                sa = self.stations[i]
                for jj in range(ii + 1, len(hs)):
                    j = hs[jj]
                    if (min(i, j), max(i, j), band) in self.margins:
                        continue
                    sb = self.stations[j]
                    d = haversine_m(sa.lon, sa.lat, sb.lon, sb.lat)
                    if d > MAX_RANGE_M[band]:
                        continue
                    margin, _, _ = link_margin(self.terrain, sa, sb, band)
                    if margin < self.margin_min:
                        continue
                    self.damaged[band][i] |= 1 << j
                    self.damaged[band][j] |= 1 << i
                    self.margins[(min(i, j), max(i, j), band)] = margin
                    if E.relation_allowed(sa.subtype, sb.subtype, band):
                        self.normal[band][i] |= 1 << j
                        self.normal[band][j] |= 1 << i
                    added += 1
        return added

    # ── 查询 ──
    def neighbors(self, i, band, damaged=False):
        mask = (self.damaged if damaged else self.normal)[band][i]
        while mask:
            low = mask & -mask
            yield low.bit_length() - 1
            mask ^= low

    def margin_of(self, i, j, band):
        return self.margins.get((i, j, band) if i < j else (j, i, band))

    def degree(self, i, band, damaged=False):
        return bin((self.damaged if damaged else self.normal)[band][i]).count("1")

    def blocked_by_echelon(self, i, band):
        """物理能通、但编成不允许的邻居位图。无解诊断用（方案 4.4）。"""
        return self.damaged[band][i] & ~self.normal[band][i]

    def stats(self):
        return dict(self._stats)


if __name__ == "__main__":
    import csv, time
    from datapaths import path as dpath
    from terrain import default_terrain

    def load(rel):
        with open(dpath(rel), encoding="utf-8") as f:
            return list(csv.DictReader(f))

    t = default_terrain()
    st = stations_from_nodes(load("node.csv"), load("device.csv"),
                             load("device_model.csv"), load("antenna_model.csv"))
    print("台站 %d 个，其中双频 %d 个"
          % (len(st), sum(1 for s in st if len(s.radio) > 1)))
    t0 = time.time()
    fm = FeasibilityMatrix(st, t, verbose=True)
    print("  建矩阵耗时 %.2f s" % (time.time() - t0))
    # 抽查：Ⅳ 的邻居必须全是 Ⅲ
    bad = []
    for i, s in enumerate(fm.stations):
        if s.subtype != "IV_MOBILE":
            continue
        for j in fm.neighbors(i, E.VUHF):
            if fm.stations[j].subtype != "III_MOBILE":
                bad.append((s.sid, fm.stations[j].sid, fm.stations[j].subtype))
    print("  正常工况下 Ⅳ 的非 Ⅲ 邻居: %d 个 %s" % (len(bad), bad[:3]))
