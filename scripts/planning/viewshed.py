"""覆盖范围计算（SR-1.1.2.6.2、SR-4.2.1 扩展流 1）。

**本模块不参与部署求解。** 合作方 2026-09-18 答复「覆盖指的是联通就行，
覆盖率不需要计算，以全连通为唯一目标」——覆盖率已退出优化目标。
但覆盖范围仍要算，因为需规要求在地图上呈现，并据此框出盲区。

SR-1.1.2.6.2 a) 原文：

> 支持以信号覆盖热力图形式展示设备通信覆盖范围，**短波按跳距与静区结构呈现
> 环带形态**，超短波按地形遮蔽后的不规则覆盖边界呈现，**不采用规则扇形/圆形近似**

这一条要求两件不同的事，本模块分开实现：

  超短波  径向视域（R3 变体）+ 链路预算 → 地形遮蔽后的不规则边界
  短波    地波连续衰减 + NVIS 近垂直入射 + 低仰角天波的跳距/静区 → 环带

**尺度提醒**：规划区 120×120 km，而低仰角天波第一跳落区约 300–800 km，
**静区落在规划区之外**。因此短波环带服务的是 SR-1 全域态势呈现，
须按全域尺度单独算，不能复用规划区那张栅格。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from terrain import haversine_m
from prop import p533 as P533
from propagation import (vuhf_path_loss, hf_ground_wave_loss, hf_nvis_loss,
                         link_budget, noise_floor_dbm)

DEG_PER_M_LAT = 1.0 / 111320.0
DEFAULT_AZ_STEP = 2.0        # 方位角步进（度）
DEFAULT_RAY_STEP = 250.0     # 径向步进（米）
DEFAULT_MARGIN_MIN = 6.0     # 判为「被覆盖」的余量门限 dB


class CoverageResult:
    """一个台站的覆盖结果。

    cells   {(gx, gy): margin_db}，栅格坐标相对 origin，步长 cell_m
    """

    __slots__ = ("sid", "band", "lon", "lat", "cells", "cell_m", "origin",
                 "radius_m", "rings")

    def __init__(self, sid, band, lon, lat, cell_m, origin, radius_m):
        self.sid = sid
        self.band = band
        self.lon = lon
        self.lat = lat
        self.cells = {}
        self.cell_m = cell_m
        self.origin = origin          # (lon0, lat0) 栅格原点
        self.radius_m = radius_m
        self.rings = []               # 短波用：[(内径 m, 外径 m, 说明)]

    def area_km2(self):
        return len(self.cells) * (self.cell_m / 1000.0) ** 2

    def to_cellsize_lonlat(self):
        lat_rad = math.radians(self.lat)
        return (self.cell_m * DEG_PER_M_LAT / max(0.2, math.cos(lat_rad)),
                self.cell_m * DEG_PER_M_LAT)


def _radio_of(station, band):
    return station.radio[band]


def vuhf_coverage(terrain, station, radius_m=60000.0, cell_m=DEFAULT_RAY_STEP,
                  az_step=DEFAULT_AZ_STEP, margin_min=DEFAULT_MARGIN_MIN,
                  freq_khz=None, rx_height_m=2.0):
    """超短波径向视域覆盖（R3 变体）。

    沿每条方位射线向外推进，维护**射线上已出现的最大仰角**：
    只有当前点的仰角超过此前最大值，该点才通视。这是 R3 视域算法的标准做法，
    一次扫描 O(方位数 × 径向步数)，不需要对每个格点单独做剖面。

    通视之后再过链路预算，余量达标才算被覆盖 —— 需规要求的是**通信**覆盖，
    不是单纯的视域。
    """
    r = _radio_of(station, E.VUHF)
    # 2026-09-29 勘误：原先写死 150 MHz。改为本台电台工作频段的几何中心，
    # 与可行性判据同一口径（feasibility.representative_freq）。
    f = freq_khz or math.sqrt(max(r.get("fmin", 136000.0), 1.0) * r.get("fmax", 174000.0))
    res = CoverageResult(station.sid, E.VUHF, station.lon, station.lat,
                         cell_m, (station.lon, station.lat), radius_m)
    lat_rad = math.radians(station.lat)
    m_per_deg_lon = 111320.0 * max(0.2, math.cos(lat_rad))
    h0 = terrain.elevation(station.lon, station.lat) + r["height"]

    n_az = int(360.0 / az_step)
    n_step = int(radius_m / cell_m)
    for k in range(n_az):
        az = math.radians(k * az_step)
        dx, dy = math.sin(az), math.cos(az)
        max_tan = -9e9
        for si in range(1, n_step + 1):
            d = si * cell_m
            lon = station.lon + dx * d / m_per_deg_lon
            lat = station.lat + dy * d * DEG_PER_M_LAT
            z = terrain.elevation(lon, lat)
            # 4/3 地球等效曲率修正
            drop = d * d / (2.0 * 4.0 / 3.0 * 6371000.0)
            tan_e = (z + rx_height_m - drop - h0) / d
            if tan_e < max_tan:
                continue                      # 被前方地形挡住
            max_tan = tan_e
            pl, _los, _clr, _dd = vuhf_path_loss(
                terrain, (station.lon, station.lat), (lon, lat), f,
                r["height"], rx_height_m)
            _rx, _snr, margin = link_budget(r["tx_dbm"], r["gain"], 0.0, pl, f,
                                            r["bw"], "数据", r["sens"])
            if margin < margin_min:
                break                         # 再远只会更差，本条射线到此为止
            gx = int(round(dx * d / cell_m))
            gy = int(round(dy * d / cell_m))
            prev = res.cells.get((gx, gy))
            if prev is None or margin > prev:
                res.cells[(gx, gy)] = margin
    return res


def hf_skip_geometry(freq_khz, hour=12, virtual_height_km=300.0):
    """短波低仰角天波的跳距与静区（SR-1.1.2.6.2 a「环带形态」）。

    **几何与电离层参数统一由 `prop/p533.py`（ITU-R P.533）提供**，本函数
    只做接口适配，不再自带公式与 foF2 常数，避免两处口径漂移。

    p533 的跳距用正割定律沿距离求解并含地球曲率；教科书平面近似
    d = 2h'·√((f/foF2)²−1) 在远距离会明显偏大，两者差异见 p533 自检第 [2] 项。

    f ≤ foF2 时垂直入射也能反射（即 NVIS），**不存在静区**。

    返回 (d_skip_m, note)；d_skip 为 None 表示该频率无静区。
    """
    io_ = P533.ionosphere(hour, h_km=virtual_height_km)
    f_mhz = freq_khz / 1000.0
    fo_f2 = io_["foF2"]
    if f_mhz <= fo_f2:
        return None, ("f=%.1f MHz ≤ foF2=%.1f MHz，垂直入射可反射（NVIS），无静区"
                      % (f_mhz, fo_f2))
    d_skip_km = P533.skip_distance_km(freq_khz, hour, fo_f2, virtual_height_km)
    if d_skip_km == float("inf"):
        return None, "f=%.1f MHz 任何入射角都反射不回来，无天波落区" % f_mhz
    flat_km = P533.skip_distance_flat_km(freq_khz, hour, fo_f2, virtual_height_km)
    return d_skip_km * 1000.0, ("f=%.1f MHz > foF2=%.1f MHz，跳距 %.0f km"
                                "（平面近似 %.0f km），地波边缘至此为静区"
                                % (f_mhz, fo_f2, d_skip_km, flat_km))


def hf_coverage_rings(terrain, station, freq_khz=5000.0, hour=12,
                      margin_min=DEFAULT_MARGIN_MIN, max_km=900.0):
    """短波覆盖的环带结构：地波区 → 静区 → 天波落区。

    与超短波不同，短波不按视域算 —— 地波绕射沿地表传播，不受视距限制。
    因此这里算的是**一维的距离-余量曲线**，再切成环。
    """
    r = _radio_of(station, E.HF)
    res = CoverageResult(station.sid, E.HF, station.lon, station.lat,
                         1000.0, (station.lon, station.lat), max_km * 1000.0)
    lc = terrain.landcover(station.lon, station.lat)

    def margin_at(d_m, mode):
        if mode == "ground":
            pl = hf_ground_wave_loss(freq_khz, d_m, lc)
        else:
            pl = hf_nvis_loss(freq_khz, d_m, hour)
        _rx, _snr, m = link_budget(r["tx_dbm"], r["gain"], 0.0, pl, freq_khz,
                                   r["bw"], "话音", r["sens"])
        return m

    # 1) 地波区：从近到远，余量首次跌破门限处即为地波边缘
    ground_edge = 0.0
    for km in range(1, int(max_km) + 1):
        if margin_at(km * 1000.0, "ground") < margin_min:
            break
        ground_edge = km * 1000.0

    # 2) NVIS：高仰角天波，0–300 km 较均匀，与地波区叠加
    nvis_edge = 0.0
    for km in range(1, 301):
        if margin_at(km * 1000.0, "sky") < margin_min:
            break
        nvis_edge = km * 1000.0

    inner_edge = max(ground_edge, nvis_edge)
    d_skip, note = hf_skip_geometry(freq_khz, hour)

    res.rings.append((0.0, inner_edge, "地波 + NVIS 连续覆盖区"))
    if d_skip is None:
        res.rings.append((inner_edge, inner_edge, note))
    else:
        if d_skip > inner_edge:
            res.rings.append((inner_edge, d_skip, "**静区**（地波已衰竭，天波尚未落地）"))
        # 第一跳落区：跳距起，按经验取 1.6 倍跳距为外缘
        res.rings.append((max(d_skip, inner_edge), d_skip * 1.6, "第一跳天波落区"))
    res.rings.append((0.0, 0.0, note))
    return res


def blind_zones(covered_cells, bbox, cell_m=1000.0, min_area_km2=5.0):
    """盲区识别（SR-4.2.1 扩展事件流 1「标注盲区范围并给出增加部署数量的建议」）。

    covered_cells  已覆盖的 (gx, gy) 集合，栅格相对 bbox 左下角
    返回按面积降序的盲区连通块 [(面积 km2, 格点集合, 中心经纬度)]
    """
    lon0, lat0, lon1, lat1 = bbox
    m_per_deg_lon = 111320.0 * max(0.2, math.cos(math.radians((lat0 + lat1) / 2)))
    nx = int((lon1 - lon0) * m_per_deg_lon / cell_m)
    ny = int((lat1 - lat0) / DEG_PER_M_LAT / cell_m)
    todo = set()
    for gx in range(nx):
        for gy in range(ny):
            if (gx, gy) not in covered_cells:
                todo.add((gx, gy))
    zones = []
    while todo:
        seed = todo.pop()
        blob, stack = {seed}, [seed]
        while stack:
            x, y = stack.pop()
            for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nb in todo:
                    todo.discard(nb)
                    blob.add(nb)
                    stack.append(nb)
        area = len(blob) * (cell_m / 1000.0) ** 2
        if area >= min_area_km2:
            cx = sum(p[0] for p in blob) / len(blob)
            cy = sum(p[1] for p in blob) / len(blob)
            zones.append((area, blob,
                          (lon0 + cx * cell_m / m_per_deg_lon,
                           lat0 + cy * cell_m * DEG_PER_M_LAT)))
    zones.sort(key=lambda z: -z[0])
    return zones


def expansion_advice(terrain, zones, candidate_rows, stations, bbox, cell_m=1000.0,
                     radius_m=25000.0, per_zone=3, max_cands=30, sample=16):
    """盲区扩容建议（SR-4.2 扩展 4「覆盖盲区自动识别与扩容建议」）。

    对每块盲区，在附近候选位置里评估「部署一台 Ⅲ 机动站（唯一带超短波的可部署类型）」：
    - **能覆盖盲区多少**：从候选点对盲区内抽样格点做通视判断
      （覆盖在本项目功率量级下由地形遮挡决定，见交接 2026-09-22 的实测）；
    - **能不能接进网**：候选点到现网合法上级的最好链路余量（≥ 6 dB 才算接得上）。
    按「接得上」优先、再按覆盖比例排序，每块盲区给前 per_zone 个。

    射频参数取现网 Ⅲ 机动站的实际参数（deployment.radio_templates），不手写常数。
    接入对象限于能转发的节点（SUBTYPE_RELAY）；对端端口是否有余量此处不判，
    真正部署时由 P1 按编成定额校验。
    """
    from deployment import radio_templates, candidate_stations
    from feasibility import link_margin, DEFAULT_MARGIN_MIN
    from terrain import los_clearance
    tpl = radio_templates(stations)
    by_band = {}
    for st in stations:
        for band in st.radio:
            by_band.setdefault(band, []).append(st)
    lon0, lat0, lon1, lat1 = bbox
    m_per_deg_lon = 111320.0 * max(0.2, math.cos(math.radians((lat0 + lat1) / 2)))
    out = []
    for area, blob, center in zones:
        cells = sorted(blob)
        step = max(1, len(cells) // sample)
        pts = [(lon0 + (gx + 0.5) * cell_m / m_per_deg_lon,
                lat0 + (gy + 0.5) * cell_m * DEG_PER_M_LAT) for gx, gy in cells[::step]][:sample]
        near = []
        for r in candidate_rows:
            if str(r.get("is_deployable", "true")).lower() != "true":
                continue
            d = haversine_m(center[0], center[1], float(r["lon"]), float(r["lat"]))
            if d <= radius_m:
                near.append((d, r))
        near.sort(key=lambda t: t[0])
        ranked = []
        for d, r in near[:max_cands]:
            cand = candidate_stations([r], "III_MOBILE", templates=tpl)[0]
            h = cand.radio[E.VUHF]["height"]
            seen = sum(1 for (x, y) in pts
                       if los_clearance(terrain, cand.lon, cand.lat, h, x, y, 2.0)[0])
            frac = seen / max(1, len(pts))
            best_up = None
            for band in cand.radio:
                for st in by_band.get(band, []):
                    if not E.relation_allowed(cand.subtype, st.subtype, band):
                        continue
                    # 只能挂到能转发的节点上：Ⅳ、背负站没有空余端口可供转发
                    if not E.SUBTYPE_RELAY.get(st.subtype, False):
                        continue
                    if haversine_m(cand.lon, cand.lat, st.lon, st.lat) > 60000:
                        continue
                    m, _dist, _pl = link_margin(terrain, cand, st, band)
                    if best_up is None or m > best_up[0]:
                        best_up = (m, st.sid, band)
            joins = best_up is not None and best_up[0] >= DEFAULT_MARGIN_MIN
            ranked.append(dict(site_id=r["site_id"], lon=float(r["lon"]), lat=float(r["lat"]),
                               distance_to_zone_m=round(d, 1),
                               zone_cells_visible_ratio=round(frac, 3),
                               joins_network=joins,
                               uplink=dict(node_id=best_up[1], band=best_up[2],
                                           margin_db=round(best_up[0], 2)) if best_up else None))
        ranked.sort(key=lambda x: (not x["joins_network"], -x["zone_cells_visible_ratio"],
                                   x["distance_to_zone_m"]))
        top = ranked[:per_zone]
        if top and top[0]["joins_network"] and top[0]["zone_cells_visible_ratio"] > 0:
            advice = ("建议在 %s 增设 Ⅲ 机动站：可看到该盲区约 %.0f%% 的抽样格点，"
                      "经 %s（%s，余量 %.1f dB）接入网络"
                      % (top[0]["site_id"], 100 * top[0]["zone_cells_visible_ratio"],
                         top[0]["uplink"]["node_id"], top[0]["uplink"]["band"],
                         top[0]["uplink"]["margin_db"]))
        elif not near:
            advice = "盲区 %.0f km 内没有可部署的候选位置，需扩大候选筛选范围" % (radius_m / 1000)
        else:
            advice = ("附近 %d 个候选位置均不能同时看到该盲区且接入网络，"
                      "可能需要两级中继或更高的架设高度" % len(near[:max_cands]))
        out.append(dict(area_km2=round(area, 1),
                        center=dict(lon=round(center[0], 5), lat=round(center[1], 5)),
                        candidates=top, advice=advice))
    return out
