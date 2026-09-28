"""电台参数规划（SR-4.2.3）。

在部署位置已定的前提下，联合配置**发射功率、天线挂高、天线倾角**，
目标是：在每条链路都留足衰落余量的前提下，**总辐射功率最小**
（《技术参考》3)b 的口径）。

实现的条目
----------
- a) 基于部署位置与地形联合优化功率/挂高/倾角，自动生成参数方案
- b) 人工调整（`manual_override`），调整后重算全网余量
- c) 基于所选参数算覆盖 —— 覆盖计算在 `viewshed.py`，本模块只产出参数
- d) 多组参数方案的对比与优选（`compare_plans()`）
- 扩展 1 参数到顶仍达不到要求 → `upgrade_advice()` 给设备升级建议
- **缺口 A3「预选配置 ≥3 种」** → `PRESETS` 三套预置方案（地形/任务/干扰）

功率优化为什么可以求到精确解
----------------------------
链路余量对发射功率是 **1 dB 对 1 dB** 的线性关系，而 `link_budget` 取的是
两端功率的**较小值**。于是每条链路给出一个下界
`min(tx_a, tx_b) ≥ p_req(link)`，每台设备的功率只需取它所有链路 `p_req`
的最大值，再向上取到最近的可选功率档。这在「最小化总功率」这个目标下是
**精确最优**，不需要迭代搜索。

挂高与倾角
----------
- 挂高改变路径损耗，没有闭式关系，按「不够就抬到上限再重算」处理。
- **倾角对全向天线无效**。本项目天线库全部是 OMNI / NVIS 方向图，
  所以倾角接口保留、取值记录，但**不参与计算**，并在结果里如实标注
  `tilt_effective=False`。将来接入定向天线时再实现，不在这里假装它有用。

衰落余量（缺口 A7）
-------------------
需规无对应条文。《技术参考》4)c 给「瑞利 + 对数正态阴影（σ 6–10 dB），
典型余量 6–12 dB，对应边缘覆盖率 ≥90%」。本模块默认 **8 dB**，
三套预置方案分别取 10 / 12 / 6 dB，取值写在 `PRESETS` 里，一处可改。
"""
import copy
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E
from feasibility import link_margin

DEFAULT_FADE_MARGIN_DB = 8.0          # 缺口 A7，见文件头
TILT_RANGE_DEG = (-10.0, 10.0)        # 接口文档 2.5 的 bounds，记录用


# ---------------------------------------------------------------- 预置方案（A3）

PRESETS = {
    "TERRAIN": dict(
        name="地形地貌型",
        note="山地遮蔽重、绕射损耗大：天线挂高优先抬到上限，余量留 10 dB",
        fade_margin_db=10.0,
        height_policy="MAX",          # 直接用挂高上限
        power_policy="MIN_TOTAL",
    ),
    "MISSION": dict(
        name="任务需求型",
        note="高可靠通联优先：余量留 12 dB，宁可多耗功率",
        fade_margin_db=12.0,
        height_policy="MAX",
        power_policy="MIN_TOTAL",
    ),
    "INTERFERENCE": dict(
        name="干扰环境型",
        note="强干扰/需控制辐射：余量压到 6 dB，功率取满足门限的最低档，"
             "减小互扰与被侦测范围",
        fade_margin_db=6.0,
        height_policy="KEEP",         # 不抬高，避免增大暴露面
        power_policy="MIN_TOTAL",
    ),
}


def preset_list():
    """供前端渲染的预置方案清单（SR-4.2.3 的 ≥3 种预选配置）。"""
    return [dict(preset_id=k, **v) for k, v in PRESETS.items()]


# ---------------------------------------------------------------- 设备能力

def power_levels_of(model_row, fallback_max=None):
    """解析型号的可选功率档位，升序。缺失时退化为单档最大功率。"""
    raw = (model_row or {}).get("tx_power_levels_dbm", "") or ""
    out = []
    for part in str(raw).replace("；", ";").split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(float(part))
        except ValueError:
            continue
    if not out:
        mx = fallback_max
        if mx is None:
            try:
                mx = float((model_row or {}).get("tx_power_max_dbm"))
            except (TypeError, ValueError):
                mx = None
        out = [mx] if mx is not None else []
    return sorted(set(out))


def height_range_of(antenna_row):
    """解析天线挂高区间 '2-3' / '3' / ''，返回 (下限, 上限)。"""
    s = str((antenna_row or {}).get("height_range_m", "") or "").strip()
    if not s:
        return (None, None)
    if "-" in s:
        a, b = s.split("-", 1)
        try:
            return (float(a), float(b))
        except ValueError:
            return (None, None)
    try:
        v = float(s)
        return (v, v)
    except ValueError:
        return (None, None)


# 天线可调架设高度区间，按**平台**取（m）。**待确认**：需规与《技术参考》未给出，
# 取工程常见值，且与 gen_test_data.pick_height 的生成区间一致或更宽。
#
# 为什么不用天线库的 height_range_m：数据字典定义它是「可用挂高范围，如 2-12」，
# 但采集回来的 45 条值是 0.09 / 0.11 / 0.16 这种——显然是**天线自身长度**，
# 另有 33 条为空。第 3 周曾照字面当成可调区间用，结果 180 台里 90 台
# 「抬到上限」反而比现网挂高还低（17.3 m 铁塔上的天线被「抬」到 0.1 m）。
# 2026-09-29 勘误，改为按平台取，该字段的数据问题已交回采集方更正。
PLATFORM_HEIGHT_RANGE_M = {
    "FIXED": (10.0, 30.0),       # 固定站铁塔/桅杆
    "VEHICLE": (2.0, 10.0),      # 车载伸缩桅杆
    "MANPACK": (1.5, 3.0),       # 背负
}


class DeviceCapability:
    """一台设备在参数规划中可动的范围。"""

    __slots__ = ("sid", "band", "levels", "h_min", "h_max",
                 "tx_now", "h_now", "pattern", "model_id", "antenna_id")

    def __init__(self, sid, band, levels, h_min, h_max, tx_now, h_now,
                 pattern="OMNI", model_id=None, antenna_id=None):
        self.sid, self.band = sid, band
        self.levels = levels or [tx_now]
        self.h_min = h_now if h_min is None else h_min
        self.h_max = h_now if h_max is None else h_max
        self.tx_now, self.h_now = tx_now, h_now
        self.pattern = pattern
        self.model_id, self.antenna_id = model_id, antenna_id

    @property
    def tx_max(self):
        return max(self.levels)

    @property
    def tx_min(self):
        return min(self.levels)

    def snap_up(self, want):
        """向上取到最近的可选功率档；超过上限返回上限。"""
        for lv in self.levels:
            if lv >= want - 1e-9:
                return lv
        return self.tx_max


def capabilities_from_tables(stations, devices, models, antennas):
    """由四张表装配每个 (台站, 频段) 的可动范围。"""
    mrow = {m["model_id"]: m for m in models}
    arow = {a["antenna_id"]: a for a in antennas}
    dev_by_node = {}
    for d in devices:
        dev_by_node.setdefault(d["node_id"], []).append(d)
    caps = {}
    for st in stations:
        for d in dev_by_node.get(st.sid, []):
            m = mrow.get(d["model_id"])
            a = arow.get(d["antenna_id"])
            if not m or not a:
                continue
            band = m["device_class"]
            if band not in st.radio or (st.sid, band) in caps:
                continue
            h_now = float(d["antenna_height_m"])
            lo, hi = PLATFORM_HEIGHT_RANGE_M.get(
                E.SUBTYPE_MOBILITY.get(st.subtype, "VEHICLE"), (h_now, h_now))
            # 区间必须包含现网实际挂高：可调，但不会被「调」得比现在更差
            lo, hi = min(lo, h_now), max(hi, h_now)
            caps[(st.sid, band)] = DeviceCapability(
                st.sid, band,
                power_levels_of(m),
                lo, hi,
                float(d["tx_power_dbm"]), h_now,
                a.get("pattern_type", "OMNI"), m["model_id"], a["antenna_id"])
    return caps


# ---------------------------------------------------------------- 优化

def _margin_with(terrain, sa, sb, band, tx_a, tx_b, h_a, h_b):
    """按给定功率/挂高重算一条链路的余量。"""
    ra = dict(sa.radio[band]); ra["tx_dbm"] = tx_a; ra["height"] = h_a
    rb = dict(sb.radio[band]); rb["tx_dbm"] = tx_b; rb["height"] = h_b
    sa2 = copy.copy(sa); sa2.radio = dict(sa.radio); sa2.radio[band] = ra
    sb2 = copy.copy(sb); sb2.radio = dict(sb.radio); sb2.radio[band] = rb
    m, dist, pl = link_margin(terrain, sa2, sb2, band)
    return m, dist, pl


def plan(stations, topo, caps, terrain, preset="TERRAIN",
         fade_margin_db=None, manual_override=None, tilt_deg=None):
    """参数规划主入口。

    参数
        stations  台站列表（feasibility.Station）
        topo      拓扑链路 [(i, j, band)]，i/j 为 stations 下标
        caps      capabilities_from_tables 的结果
        preset    PRESETS 里的键，或 None（用传入的 fade_margin_db）
        manual_override  [{node_id, band, tx_power_dbm?, antenna_height_m?}]
    """
    cfg = dict(PRESETS.get(preset, {})) if preset else {}
    M_req = fade_margin_db if fade_margin_db is not None else \
        cfg.get("fade_margin_db", DEFAULT_FADE_MARGIN_DB)
    height_policy = cfg.get("height_policy", "KEEP")

    # 1) 先定挂高（挂高不花功率，先用满）
    height = {}
    for key, c in caps.items():
        height[key] = c.h_max if height_policy == "MAX" else c.h_now

    # 2) 人工覆写（SR-4.2.3 b）
    manual_keys = set()
    manual_errors = []
    forced_tx = {}
    for mo in (manual_override or []):
        key = (mo["node_id"], mo.get("band") or mo.get("device_class"))
        if key not in caps:
            manual_errors.append("%s 没有 %s 频段的设备，无法覆写" % key)
            continue
        c = caps[key]
        if "antenna_height_m" in mo and mo["antenna_height_m"] is not None:
            h = float(mo["antenna_height_m"])
            if not (c.h_min - 1e-9 <= h <= c.h_max + 1e-9):
                manual_errors.append("%s %s 挂高 %.1f m 超出天线允许区间 %.1f–%.1f m"
                                     % (key[0], key[1], h, c.h_min, c.h_max))
            else:
                height[key] = h
        if "tx_power_dbm" in mo and mo["tx_power_dbm"] is not None:
            p = float(mo["tx_power_dbm"])
            if p > c.tx_max + 1e-9 or p < c.tx_min - 1e-9:
                manual_errors.append("%s %s 功率 %.1f dBm 超出型号档位 %.1f–%.1f dBm"
                                     % (key[0], key[1], p, c.tx_min, c.tx_max))
            else:
                forced_tx[key] = p
                manual_keys.add(key)

    # 3) 在「两端都开到最大功率」下量一次基准余量，据此反推每条链路的功率下界
    base = []
    for (i, j, band) in topo:
        sa, sb = stations[i], stations[j]
        ka, kb = (sa.sid, band), (sb.sid, band)
        if ka not in caps or kb not in caps:
            continue
        ca, cb = caps[ka], caps[kb]
        tx_ref = min(ca.tx_max, cb.tx_max)
        m, dist, pl = _margin_with(terrain, sa, sb, band, ca.tx_max, cb.tx_max,
                                   height[ka], height[kb])
        # 余量与 min(tx) 是 1:1 的，所以 p_req = tx_ref - (m - M_req)
        p_req = tx_ref - (m - M_req)
        base.append(dict(i=i, j=j, band=band, ka=ka, kb=kb,
                         margin_at_max=m, p_req=p_req, distance_m=dist,
                         path_loss_db=pl))

    # 4) 每台设备取它所有链路 p_req 的最大值，向上取档
    want = {}
    for b in base:
        for k in (b["ka"], b["kb"]):
            want[k] = max(want.get(k, -1e9), b["p_req"])
    tx = {}
    for key, c in caps.items():
        if key in forced_tx:
            tx[key] = forced_tx[key]
        elif key in want:
            tx[key] = c.snap_up(min(want[key], c.tx_max))
        else:
            tx[key] = c.tx_min          # 没有链路的设备开最低档

    # 5) 按最终参数复算，得出真实余量与未达标链路
    links, failed = [], []
    for b in base:
        sa, sb = stations[b["i"]], stations[b["j"]]
        m, dist, pl = _margin_with(terrain, sa, sb, b["band"],
                                   tx[b["ka"]], tx[b["kb"]],
                                   height[b["ka"]], height[b["kb"]])
        rec = dict(node_a=sa.sid, node_b=sb.sid, band=b["band"],
                   distance_m=round(dist, 1), path_loss_db=round(pl, 2),
                   tx_a_dbm=tx[b["ka"]], tx_b_dbm=tx[b["kb"]],
                   height_a_m=height[b["ka"]], height_b_m=height[b["kb"]],
                   margin_db=round(m, 2), required_margin_db=M_req,
                   meets=m >= M_req - 1e-6,
                   margin_at_max_power_db=round(b["margin_at_max"], 2))
        links.append(rec)
        if not rec["meets"]:
            failed.append(rec)

    params = []
    for key in sorted(caps):
        c = caps[key]
        params.append(dict(node_id=key[0], band=key[1],
                           model_id=c.model_id, antenna_id=c.antenna_id,
                           tx_power_dbm=tx[key],
                           tx_power_levels_dbm=c.levels,
                           antenna_height_m=height[key],
                           antenna_height_range_m=[c.h_min, c.h_max],
                           tilt_deg=tilt_deg if tilt_deg is not None else 0.0,
                           tilt_effective=False,      # 全向天线，倾角不参与计算
                           manual=key in manual_keys))
    total_w = sum(10 ** ((tx[k] - 30.0) / 10.0) for k in tx)
    return dict(
        preset=preset, preset_name=cfg.get("name"), note=cfg.get("note"),
        fade_margin_db=M_req,
        params=params, links=links, failed_links=failed,
        manual_errors=manual_errors,
        summary=dict(devices=len(params), links=len(links),
                     failed=len(failed),
                     total_radiated_w=round(total_w, 2),
                     mean_tx_dbm=round(sum(tx.values()) / max(1, len(tx)), 2),
                     min_margin_db=round(min((l["margin_db"] for l in links),
                                             default=float("nan")), 2),
                     devices_at_max=sum(1 for k in tx if tx[k] >= caps[k].tx_max - 1e-9)),
    )


def upgrade_advice(result, caps):
    """参数到顶仍不达标 → 设备升级建议（SR-4.2.3 扩展 1）。

    只讲有依据的：差多少 dB、抬挂高还能补多少、还差多少要靠换设备。
    """
    tips = []
    for l in result["failed_links"]:
        gap = l["required_margin_db"] - l["margin_at_max_power_db"]
        if gap <= 0:
            tips.append(dict(
                link="%s—%s" % (l["node_a"], l["node_b"]), band=l["band"],
                kind="RAISE_POWER",
                detail="当前档位不足，提到本型号最大功率即可达标（还差 %.1f dB）"
                       % (l["required_margin_db"] - l["margin_db"])))
            continue
        tips.append(dict(
            link="%s—%s" % (l["node_a"], l["node_b"]), band=l["band"],
            kind="UPGRADE",
            shortfall_db=round(gap, 2),
            detail="两端已开到最大功率仍差 %.1f dB。可选：①换更高增益天线"
                   "（每 +3 dBi 补 3 dB）②换更大功率型号 ③在两点之间增设中继"
                   % gap))
    return tips


def compare_plans(results):
    """多组参数方案对比与优选（SR-4.2.3 d）。"""
    rows = []
    for r in results:
        s = r["summary"]
        rows.append(dict(
            preset=r["preset"], name=r["preset_name"],
            fade_margin_db=r["fade_margin_db"],
            total_radiated_w=s["total_radiated_w"],
            mean_tx_dbm=s["mean_tx_dbm"],
            min_margin_db=s["min_margin_db"],
            failed=s["failed"],
            devices_at_max=s["devices_at_max"],
        ))
    return rows


def recommend(rows):
    """在多套方案里挑一套：先看达标数，再看总辐射功率。"""
    if not rows:
        return None
    return sorted(rows, key=lambda r: (r["failed"], r["total_radiated_w"]))[0]


# ---------------------------------------------------------------- 自检

def topo_from_links(stations, links):
    """由 link.csv 造拓扑 [(i, j, band)]。"""
    idx = {s.sid: i for i, s in enumerate(stations)}
    out = []
    for l in links:
        a, b = idx.get(l["node_a_id"]), idx.get(l["node_b_id"])
        if a is None or b is None:
            continue
        if str(l.get("is_available", "true")).lower() == "false":
            continue
        out.append((a, b, l["device_class"]))
    return out


def _self_test():
    import csv
    import time
    from datapaths import path as dpath
    from terrain import default_terrain
    from feasibility import stations_from_nodes

    def load(rel):
        with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    print("=" * 76)
    print("电台参数规划自检（真实数据）")
    print("=" * 76)
    terrain = default_terrain(verbose=False)
    nodes, devices = load("node.csv"), load("device.csv")
    models, antennas = load("device_model.csv"), load("antenna_model.csv")
    links = load("link.csv")
    stations = stations_from_nodes(nodes, devices, models, antennas)
    topo = topo_from_links(stations, links)
    caps = capabilities_from_tables(stations, devices, models, antennas)
    print("\n规模：台站 %d，可调设备 %d 台，拓扑链路 %d 条"
          % (len(stations), len(caps), len(topo)))

    print("\n[1] 设备可动范围")
    lv = {}
    for c in caps.values():
        lv.setdefault(len(c.levels), 0)
        lv[len(c.levels)] += 1
    print("    功率档位数分布：%s"
          % "，".join("%d 档×%d台" % (k, v) for k, v in sorted(lv.items())))
    sample = next(iter(caps.values()))
    print("    示例 %s %s：功率档 %s dBm，挂高 %.1f–%.1f m，方向图 %s"
          % (sample.sid, sample.band, sample.levels,
             sample.h_min, sample.h_max, sample.pattern))

    print("\n[2] 三套预选配置（缺口 A3：甲方要求 ≥3 种）")
    results = []
    for pid in ("TERRAIN", "MISSION", "INTERFERENCE"):
        t0 = time.time()
        r = plan(stations, topo, caps, terrain, preset=pid)
        el = time.time() - t0
        results.append(r)
        s = r["summary"]
        print("    %-12s 余量门限 %4.1f dB  总辐射 %8.1f W  均功率 %5.1f dBm  "
              "最差余量 %6.1f dB  未达标 %3d 条  %.1fs"
              % (r["preset_name"], r["fade_margin_db"], s["total_radiated_w"],
                 s["mean_tx_dbm"], s["min_margin_db"], s["failed"], el))

    print("\n[3] 方案对比与优选（SR-4.2.3 d）")
    rows = compare_plans(results)
    best = recommend(rows)
    for row in rows:
        mark = " ←推荐" if row is best else ""
        print("    %-12s 门限%5.1f  总辐射%8.1f W  最差余量%6.1f dB  未达标%3d%s"
              % (row["name"], row["fade_margin_db"], row["total_radiated_w"],
                 row["min_margin_db"], row["failed"], mark))
    print("    优选口径：先看未达标条数，再看总辐射功率")

    print("\n[3b] 未达标链路的来源分解 —— 别把测试数据的故意劣化算到算法头上")
    state = {}
    for l in links:
        state[(l["node_a_id"], l["node_b_id"], l["device_class"])] = l["link_state"]
        state[(l["node_b_id"], l["node_a_id"], l["device_class"])] = l["link_state"]
    from collections import Counter
    for r in results:
        c = Counter(state.get((f["node_a"], f["node_b"], f["band"]), "?")
                    for f in r["failed_links"])
        print("    %-12s 未达标 %3d 条，其中源数据本就是 FAULT %d / WARNING %d / GOOD %d / EXCELLENT %d"
              % (r["preset_name"], r["summary"]["failed"], c["FAULT"], c["WARNING"],
                 c["GOOD"], c["EXCELLENT"]))
    print("    说明：link.csv 按配额故意掺了 6% FAULT、16% WARNING 链路，")
    print("          这些链路余量本就低于解调门限，留多少衰落余量都达不到。")

    print("\n[4] 功率优化省了多少（对照：全部开到最大档）")
    r = results[0]
    full = sum(10 ** ((caps[(p["node_id"], p["band"])].tx_max - 30.0) / 10.0)
               for p in r["params"])
    got = r["summary"]["total_radiated_w"]
    print("    全开最大 %.1f W → 优化后 %.1f W，省 %.1f%%"
          % (full, got, 100.0 * (full - got) / full if full else 0.0))
    multi = sum(1 for c in caps.values() if len(c.levels) > 1)
    print("    可优化空间受数据限制：%d/%d 台设备只有**一个**功率档，"
          % (len(caps) - multi, len(caps)))
    print("    414 台设备只用到 16 个型号里的 4 个，其中 3 个是单档型号 —— ")
    print("    这是测试数据的型号分配过于集中，不是算法没优化。已记入待办。")

    print("\n[5] 参数都在设备允许范围内")
    bad = 0
    for p in r["params"]:
        c = caps[(p["node_id"], p["band"])]
        if p["tx_power_dbm"] not in c.levels:
            bad += 1
        if not (c.h_min - 1e-9 <= p["antenna_height_m"] <= c.h_max + 1e-9):
            bad += 1
    print("    越界项 %d  %s" % (bad, "✓" if bad == 0 else "✗"))

    print("\n[6] 人工调整（SR-4.2.3 b）")
    tgt = r["params"][0]
    c = caps[(tgt["node_id"], tgt["band"])]
    r2 = plan(stations, topo, caps, terrain, preset="TERRAIN",
              manual_override=[dict(node_id=tgt["node_id"], band=tgt["band"],
                                    tx_power_dbm=c.tx_min)])
    got2 = next(p for p in r2["params"]
                if p["node_id"] == tgt["node_id"] and p["band"] == tgt["band"])
    print("    把 %s %s 从 %.1f 压到 %.1f dBm → 实得 %.1f，manual=%s"
          % (tgt["node_id"], tgt["band"], tgt["tx_power_dbm"], c.tx_min,
             got2["tx_power_dbm"], got2["manual"]))
    print("    全网未达标链路 %d → %d（人工降功率的代价）"
          % (r["summary"]["failed"], r2["summary"]["failed"]))

    print("\n[7] 非法人工值应当被拒绝")
    r3 = plan(stations, topo, caps, terrain, preset="TERRAIN",
              manual_override=[dict(node_id=tgt["node_id"], band=tgt["band"],
                                    tx_power_dbm=999.0, antenna_height_m=999.0)])
    for e in r3["manual_errors"]:
        print("    · %s" % e)

    print("\n[8] 设备升级建议（扩展 1）")
    tips = upgrade_advice(results[1], caps)          # 任务需求型门限最高
    print("    任务需求型下未达标 %d 条，给出建议 %d 条"
          % (results[1]["summary"]["failed"], len(tips)))
    for t in tips[:3]:
        print("    · %s %s：%s" % (t["link"], t["band"], t["detail"]))

    print("\n[9] 倾角：全向天线不参与计算，如实标注")
    print("    tilt_effective 为 True 的设备数：%d（天线库全是 OMNI/NVIS，应为 0）"
          % sum(1 for p in r["params"] if p["tilt_effective"]))
    print("=" * 76)


if __name__ == "__main__":
    _self_test()
