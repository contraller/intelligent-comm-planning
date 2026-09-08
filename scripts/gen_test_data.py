#!/usr/bin/env python3
"""基础测试数据集生成器（第 1 周交付物）。

生成"自行构造"的 7 类数据 + 构造版故障案例，全部符合 docs/01_数据字典.md。
纯标准库，无需安装任何包：
    python3 scripts/gen_test_data.py

DEM 到位后把 terrain.SyntheticTerrain 换成 DemTerrain，重跑本脚本即可。
"""
import csv, json, math, os, random, sys, datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terrain import SyntheticTerrain, BBOX, haversine_m, los_clearance
from propagation import vuhf_path_loss, hf_path_loss, link_budget, margin_to_state

SEED = 20260908
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "generated")
LON0, LAT0, LON1, LAT1 = BBOX
T0 = dt.datetime(2026, 9, 8, 8, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=8)))

N_HF, N_VUHF = 52, 104          # 软需下限 50 / 100
N_HF_FIXED, N_VUHF_FIXED = 8, 14
N_TASK_SCENARIOS = 6
N_INTERFERENCE = 16
MAX_LINKS = 500

rng = random.Random(SEED)
terrain = SyntheticTerrain()


def iso(t): return t.isoformat()
def sid(p, n): return "%s-%04d" % (p, n)


def write_csv(name, rows, header):
    path = os.path.join(OUT, name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print("  %-26s %5d 行" % (name, len(rows)))
    return path


# ─────────────────────────── 设备型号 ───────────────────────────
DEFAULT_MODELS = [
    dict(model_id="DM-0001", model_name="XB-150 短波车载电台", manufacturer="构造厂家A",
         device_class="HF", category="车载电台", freq_min_khz=1600, freq_max_khz=29999,
         tx_power_max_dbm=51.8, tx_power_levels_dbm="37;43;47;51.8", rx_sensitivity_dbm=-110,
         bandwidth_khz="3", modulation="USB;LSB;CW;FSK", work_mode="定频;跳频;自适应ALE",
         service_type="话音;数据", data_rate_kbps="2.4;4.8", antenna_type_default="鞭状/双极",
         power_consumption_w=350, constraint_note="跳频模式下最大功率降至 47 dBm",
         source_doc="CONSTRUCTED"),
    dict(model_id="DM-0002", model_name="XB-050 短波背负电台", manufacturer="构造厂家A",
         device_class="HF", category="背负电台", freq_min_khz=1600, freq_max_khz=29999,
         tx_power_max_dbm=47, tx_power_levels_dbm="33;37;43;47", rx_sensitivity_dbm=-108,
         bandwidth_khz="3", modulation="USB;LSB;CW", work_mode="定频;自适应ALE",
         service_type="话音;短消息", data_rate_kbps="2.4", antenna_type_default="鞭状/双极",
         power_consumption_w=90, constraint_note="", source_doc="CONSTRUCTED"),
    dict(model_id="DM-0003", model_name="XB-400 短波固定台", manufacturer="构造厂家B",
         device_class="HF", category="固定台", freq_min_khz=1600, freq_max_khz=29999,
         tx_power_max_dbm=56, tx_power_levels_dbm="47;50;53;56", rx_sensitivity_dbm=-112,
         bandwidth_khz="3;6", modulation="USB;LSB;CW;FSK", work_mode="定频;跳频;自适应ALE",
         service_type="话音;数据", data_rate_kbps="2.4;4.8;9.6", antenna_type_default="双极/对数周期",
         power_consumption_w=900, constraint_note="需固定馈线与地网", source_doc="CONSTRUCTED"),
    dict(model_id="DM-0011", model_name="CD-020 超短波车载电台", manufacturer="构造厂家A",
         device_class="VUHF", category="车载电台", freq_min_khz=30000, freq_max_khz=88000,
         tx_power_max_dbm=43, tx_power_levels_dbm="30;37;43", rx_sensitivity_dbm=-116,
         bandwidth_khz="25", modulation="FM;QPSK", work_mode="定频;跳频",
         service_type="话音;数据", data_rate_kbps="16;64", antenna_type_default="鞭状",
         power_consumption_w=110, constraint_note="", source_doc="CONSTRUCTED"),
    dict(model_id="DM-0012", model_name="CD-005 超短波背负电台", manufacturer="构造厂家A",
         device_class="VUHF", category="背负电台", freq_min_khz=30000, freq_max_khz=88000,
         tx_power_max_dbm=37, tx_power_levels_dbm="27;33;37", rx_sensitivity_dbm=-116,
         bandwidth_khz="25", modulation="FM", work_mode="定频;跳频",
         service_type="话音", data_rate_kbps="16", antenna_type_default="鞭状",
         power_consumption_w=22, constraint_note="", source_doc="CONSTRUCTED"),
    dict(model_id="DM-0013", model_name="CD-400 超短波中继台", manufacturer="构造厂家B",
         device_class="VUHF", category="中继台", freq_min_khz=225000, freq_max_khz=400000,
         tx_power_max_dbm=40, tx_power_levels_dbm="30;35;40", rx_sensitivity_dbm=-114,
         bandwidth_khz="25", modulation="FM;QPSK", work_mode="定频",
         service_type="话音;数据", data_rate_kbps="64;256", antenna_type_default="八木/全向",
         power_consumption_w=75, constraint_note="UHF 频段依赖通视", source_doc="CONSTRUCTED"),
]

DEFAULT_ANTENNAS = [
    dict(antenna_id="AM-0001", antenna_name="短波鞭状天线 3m", device_class="HF",
         gain_dbi=-2, pattern_type="OMNI", hbeamwidth_deg=360, vbeamwidth_deg=60,
         height_range_m="2-4", polarization="V"),
    dict(antenna_id="AM-0002", antenna_name="短波双极天线(NVIS)", device_class="HF",
         gain_dbi=2, pattern_type="NVIS", hbeamwidth_deg=360, vbeamwidth_deg=80,
         height_range_m="4-12", polarization="H"),
    dict(antenna_id="AM-0003", antenna_name="短波对数周期天线", device_class="HF",
         gain_dbi=8, pattern_type="DIRECTIONAL", hbeamwidth_deg=60, vbeamwidth_deg=55,
         height_range_m="10-20", polarization="H"),
    dict(antenna_id="AM-0011", antenna_name="超短波鞭状天线 1.5m", device_class="VUHF",
         gain_dbi=2, pattern_type="OMNI", hbeamwidth_deg=360, vbeamwidth_deg=50,
         height_range_m="1-6", polarization="V"),
    dict(antenna_id="AM-0012", antenna_name="超短波全向增益天线", device_class="VUHF",
         gain_dbi=6, pattern_type="OMNI", hbeamwidth_deg=360, vbeamwidth_deg=25,
         height_range_m="4-15", polarization="V"),
    dict(antenna_id="AM-0013", antenna_name="超短波八木天线", device_class="VUHF",
         gain_dbi=10, pattern_type="DIRECTIONAL", hbeamwidth_deg=55, vbeamwidth_deg=45,
         height_range_m="4-12", polarization="V"),
]


def load_models():
    """优先用师弟采集的真实型号库；未到位或仍是示例行则用构造型号。"""
    p = os.path.join(OUT, "..", "raw", "device", "device_model.csv")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f)
                    if r.get("model_id") and "示例" not in r.get("model_name", "")]
        if rows:
            print("  使用真实设备型号库: %d 个型号" % len(rows))
            return rows, "REAL"
    print("  设备型号库未到位，使用构造型号 (%d 个)" % len(DEFAULT_MODELS))
    return DEFAULT_MODELS, "CONSTRUCTED"


def load_antennas():
    p = os.path.join(OUT, "..", "raw", "device", "antenna_model.csv")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f)
                    if r.get("antenna_id") and "示例" not in r.get("antenna_name", "")]
        if rows:
            return rows, "REAL"
    return DEFAULT_ANTENNAS, "CONSTRUCTED"


# ─────────────────────────── 节点 ───────────────────────────
TASK_AREAS = [
    ("西山任务区", 114.42, 37.55, 0.16),
    ("中部走廊区", 114.86, 37.18, 0.20),
    ("东部平原区", 115.34, 37.52, 0.22),
    ("南部隘口区", 114.68, 36.92, 0.15),
]


def gen_nodes():
    nodes, n = [], 0

    def add(cls, role, mobility, lon, lat, name):
        nonlocal n
        n += 1
        lon = min(max(lon, LON0 + 0.02), LON1 - 0.02)
        lat = min(max(lat, LAT0 + 0.02), LAT1 - 0.02)
        nodes.append(dict(
            node_id=sid("ND", n), node_name=name, node_role=role, mobility=mobility,
            lon=round(lon, 6), lat=round(lat, 6),
            elevation_m=round(terrain.elevation(lon, lat), 1),
            region=nearest_area(lon, lat), device_class=cls,
            status="NORMAL", is_key="false", remark=""))

    def nearest_area(lon, lat):
        return min(TASK_AREAS, key=lambda a: (a[1] - lon) ** 2 + (a[2] - lat) ** 2)[0]

    # 固定站：优先高地（通视好），在全区高程分位前 40% 的点里选
    def pick_high(tries=60):
        best = None
        for _ in range(tries):
            lo = rng.uniform(LON0 + 0.05, LON1 - 0.05)
            la = rng.uniform(LAT0 + 0.05, LAT1 - 0.05)
            e = terrain.elevation(lo, la)
            sl = terrain.slope_deg(lo, la)
            if sl > 20:
                continue
            sc = e - 40 * sl
            if best is None or sc > best[0]:
                best = (sc, lo, la)
        return best[1], best[2]

    for i in range(N_HF_FIXED):
        lo, la = pick_high()
        add("HF", "FIXED_STATION", "FIXED", lo, la, "短波固定站%02d" % (i + 1))
    for i in range(N_VUHF_FIXED):
        lo, la = pick_high()
        add("VUHF", "FIXED_STATION", "FIXED", lo, la, "超短波固定站%02d" % (i + 1))

    # 任务节点：按任务区聚簇
    hf_left = N_HF - N_HF_FIXED
    vu_left = N_VUHF - N_VUHF_FIXED
    for cls, left, tag in (("HF", hf_left, "短波"), ("VUHF", vu_left, "超短波")):
        for i in range(left):
            area = TASK_AREAS[i % len(TASK_AREAS)]
            lo = rng.gauss(area[1], area[3] * 0.42)
            la = rng.gauss(area[2], area[3] * 0.42)
            mob = "VEHICLE" if rng.random() < 0.55 else "MANPACK"
            add(cls, "TASK", mob, lo, la, "%s任务节点%03d" % (tag, i + 1))

    # 关键节点：固定站 + 每个任务区各 2 个
    for nd in nodes:
        if nd["node_role"] == "FIXED_STATION":
            nd["is_key"] = "true"
    for area in TASK_AREAS:
        cand = [x for x in nodes if x["region"] == area[0] and x["node_role"] == "TASK"]
        for x in rng.sample(cand, min(2, len(cand))):
            x["is_key"] = "true"
    return nodes


# ─────────────────────────── 设备实例 ───────────────────────────
def gen_devices(nodes, models, antennas):
    by_cls = {}
    for m in models:
        by_cls.setdefault(m["device_class"], []).append(m)
    ant_by_cls = {}
    for a in antennas:
        ant_by_cls.setdefault(a["device_class"], []).append(a)

    devices = []
    for i, nd in enumerate(nodes, 1):
        cls = nd["device_class"]
        pool = by_cls.get(cls) or by_cls[list(by_cls)[0]]
        if nd["node_role"] == "FIXED_STATION":
            m = max(pool, key=lambda x: float(x["tx_power_max_dbm"]))
        elif nd["mobility"] == "MANPACK":
            m = min(pool, key=lambda x: float(x["tx_power_max_dbm"]))
        else:
            m = rng.choice(pool)

        apool = ant_by_cls.get(cls) or ant_by_cls[list(ant_by_cls)[0]]
        if cls == "HF":
            # 固定站与半数车载配 NVIS（区域内通信主力），其余鞭状
            nv = [a for a in apool if a["pattern_type"] == "NVIS"]
            om = [a for a in apool if a["pattern_type"] == "OMNI"]
            want_nvis = nd["node_role"] == "FIXED_STATION" or rng.random() < 0.5
            a = rng.choice(nv if (want_nvis and nv) else (om or apool))
        else:
            a = rng.choice([x for x in apool if x["pattern_type"] == "OMNI"] or apool)

        if nd["node_role"] == "FIXED_STATION":
            h = rng.uniform(10, 18)
        elif nd["mobility"] == "VEHICLE":
            h = rng.uniform(3.5, 8)
        else:
            h = rng.uniform(1.8, 3.0)

        levels = [float(x) for x in str(m["tx_power_levels_dbm"]).split(";") if x]
        pw = max(levels) if nd["node_role"] == "FIXED_STATION" else rng.choice(levels)
        bw = float(str(m["bandwidth_khz"]).split(";")[0])
        devices.append(dict(
            device_id=sid("DV", i), node_id=nd["node_id"], model_id=m["model_id"],
            antenna_id=a["antenna_id"], antenna_height_m=round(h, 1),
            tilt_deg="", azimuth_deg="", tx_power_dbm=round(pw, 1),
            work_freq_khz="", status="NORMAL", install_time=iso(T0),
            _class=cls, _pattern=a["pattern_type"], _gain=float(a["gain_dbi"]),
            _sens=float(m["rx_sensitivity_dbm"]), _bw=bw,
            _fmin=float(m["freq_min_khz"]), _fmax=float(m["freq_max_khz"])))
    return devices


# ─────────────────────────── 频率资源池 ───────────────────────────
def gen_freq_pool():
    rows, n = [], 0
    for i in range(46):                       # 短波 3-12 MHz，3 kHz 话路
        n += 1
        f = 3000 + i * 195
        rows.append(dict(freq_id=sid("FQ", n), device_class="HF",
                         center_freq_khz=f, bandwidth_khz=3, channel_no=i + 1,
                         is_available="true" if i % 11 else "false", occupied_by="",
                         reuse_min_distance_m=60000, adjacent_guard_khz=3,
                         note="" if i % 11 else "禁用-预留应急频点"))
    for i in range(48):                       # 超短波 30-88 MHz，25 kHz
        n += 1
        f = 30125 + i * 1200
        rows.append(dict(freq_id=sid("FQ", n), device_class="VUHF",
                         center_freq_khz=f, bandwidth_khz=25, channel_no=i + 1,
                         is_available="true" if i % 13 else "false", occupied_by="",
                         reuse_min_distance_m=25000, adjacent_guard_khz=25,
                         note="" if i % 13 else "禁用-邻区占用"))
    return rows


def default_freq(dev, pool):
    cand = [f for f in pool if f["device_class"] == dev["_class"]
            and f["is_available"] == "true"
            and dev["_fmin"] <= f["center_freq_khz"] <= dev["_fmax"]]
    if not cand:
        cand = [f for f in pool if f["device_class"] == dev["_class"]]
    if dev["_class"] == "HF":
        # NVIS 需低于昼间反射上限 7.5 MHz
        low = [f for f in cand if f["center_freq_khz"] <= 7000]
        cand = low or cand
    return cand[0]["center_freq_khz"] if cand else 5000


# ─────────────────────────── 链路 ───────────────────────────
def gen_links(nodes, devices):
    """构建网络拓扑。

    两步走：先用余量最好的链路建出连通骨架（并查集），保证路由规划有解；
    再按链路状态配额分层补足。若只取最短的若干条，全网会清一色 EXCELLENT，
    SR-6.2 无法从指标挖掘状态判定规则，故障诊断也没有弱链路可分析。
    """
    dev_by_node = {d["node_id"]: d for d in devices}
    pool = gen_freq_pool()
    max_range = {"HF": 175000, "VUHF": 95000}

    # 1) 枚举候选并算链路预算
    cands = []
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            a, b = nodes[i], nodes[j]
            if a["device_class"] != b["device_class"]:
                continue
            d = haversine_m(a["lon"], a["lat"], b["lon"], b["lat"])
            if d > max_range[a["device_class"]]:
                continue
            da, db = dev_by_node[a["node_id"]], dev_by_node[b["node_id"]]
            cls = a["device_class"]
            f = default_freq(da, pool)
            pa = (a["lon"], a["lat"]); pb = (b["lon"], b["lat"])
            if cls == "HF":
                pat = "NVIS" if "NVIS" in (da["_pattern"], db["_pattern"]) else "OMNI"
                pl, ok, clr, dd = hf_path_loss(terrain, pa, pb, f, pat)
            else:
                pl, ok, clr, dd = vuhf_path_loss(terrain, pa, pb, f,
                                                 da["antenna_height_m"], db["antenna_height_m"])
            svc = "数据" if cls == "VUHF" else "话音"
            rx, snr, mg = link_budget(min(da["tx_power_dbm"], db["tx_power_dbm"]),
                                      da["_gain"], db["_gain"], pl, f, da["_bw"], svc,
                                      max(da["_sens"], db["_sens"]))
            if mg < -12:                      # 远低于门限，不作为候选
                continue
            cands.append(dict(a=a, b=b, da=da, db=db, cls=cls, f=f, pl=pl, rx=rx,
                              snr=snr, mg=mg, d=dd, los=ok,
                              state=margin_to_state(mg)))

    # 2) 连通骨架：每类设备内部按余量降序做最大生成树
    parent = {n["node_id"]: n["node_id"] for n in nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx_, ry = find(x), find(y)
        if rx_ == ry:
            return False
        parent[rx_] = ry
        return True

    chosen, rest = [], []
    for c in sorted(cands, key=lambda c: -c["mg"]):
        if union(c["a"]["node_id"], c["b"]["node_id"]):
            chosen.append(c)
        else:
            rest.append(c)

    # 3) 按状态配额分层补足，逼近真实网络的质量分布
    quota = {"EXCELLENT": 0.50, "GOOD": 0.28, "WARNING": 0.16, "FAULT": 0.06}
    room = MAX_LINKS - len(chosen)
    buckets = {k: [c for c in rest if c["state"] == k] for k in quota}
    for k in buckets:
        rng.shuffle(buckets[k])
    have = {}
    for c in chosen:
        have[c["state"]] = have.get(c["state"], 0) + 1
    for k, frac in sorted(quota.items(), key=lambda kv: -kv[1]):
        want = int(MAX_LINKS * frac) - have.get(k, 0)
        take = buckets[k][:max(0, min(want, room))]
        chosen.extend(take)
        room -= len(take)
    if room > 0:                               # 配额不足则用剩余候选补满
        used = {id(c) for c in chosen}
        pad = [c for c in rest if id(c) not in used]
        rng.shuffle(pad)
        chosen.extend(pad[:room])

    links = []
    for n, c in enumerate(sorted(chosen, key=lambda c: c["d"]), 1):
        links.append(dict(
            link_id=sid("LK", n), node_a_id=c["a"]["node_id"], node_b_id=c["b"]["node_id"],
            device_a_id=c["da"]["device_id"], device_b_id=c["db"]["device_id"],
            device_class=c["cls"], freq_khz=c["f"], bandwidth_khz=c["da"]["_bw"],
            distance_m=round(c["d"], 1), path_loss_db=round(c["pl"], 2),
            rx_power_dbm=round(c["rx"], 2), link_margin_db=round(c["mg"], 2),
            is_available="true" if c["mg"] >= 0 else "false",
            link_state=c["state"], is_backup="false",
            _snr=c["snr"], _los=c["los"]))
    return links, pool


# ─────────────────────────── 任务与通联需求 ───────────────────────────
def gen_tasks_and_demands(nodes, links):
    tasks, demands = [], []
    adj = {}
    for lk in links:
        adj.setdefault(lk["node_a_id"], set()).add(lk["node_b_id"])
        adj.setdefault(lk["node_b_id"], set()).add(lk["node_a_id"])
    nd_by_id = {n["node_id"]: n for n in nodes}
    dn = 0
    for t in range(1, N_TASK_SCENARIOS + 1):
        area = TASK_AREAS[(t - 1) % len(TASK_AREAS)]
        tid = sid("TS", t)
        tasks.append(dict(task_id=tid, task_name="%s任务场景%d" % (area[0], t),
                          area_bbox="%.4f;%.4f;%.4f;%.4f" % (LON0, LAT0, LON1, LAT1),
                          start_time=iso(T0 + dt.timedelta(hours=6 * (t - 1))),
                          duration_h=12, description="构造测试场景"))
        pool = [n for n in nodes if n["region"] == area[0]] or nodes
        others = [n for n in nodes if n["region"] != area[0]]
        cnt = rng.randint(38, 92)
        seen = set()
        tries = 0
        while len(seen) < cnt and tries < cnt * 60:
            tries += 1
            a = rng.choice(pool)
            b = rng.choice(pool if rng.random() < 0.72 else others)
            if a["node_id"] == b["node_id"] or a["device_class"] != b["device_class"]:
                continue
            key = tuple(sorted((a["node_id"], b["node_id"])))
            if key in seen:
                continue
            seen.add(key)
            dn += 1
            key_pair = a["is_key"] == "true" and b["is_key"] == "true"
            pr = "P1" if key_pair else ("P2" if rng.random() < 0.45 else "P3")
            mand = "true" if (pr == "P1" or (pr == "P2" and rng.random() < 0.3)) else "false"
            svc = rng.choice(["话音", "话音", "数据", "短消息"])
            demands.append(dict(
                demand_id=sid("CD", dn), task_id=tid,
                src_node_id=a["node_id"], dst_node_id=b["node_id"],
                priority=pr, is_mandatory=mand,
                data_volume_mb=round(rng.uniform(0.5, 240), 1),
                required_rate_kbps={"话音": 4.8, "数据": 32, "短消息": 1.2}[svc],
                max_delay_ms=rng.choice([150, 250, 400, 800]),
                min_reliability=round(rng.choice([0.90, 0.95, 0.99, 0.995]), 3),
                service_type=svc, preferred_class=a["device_class"]))
    return tasks, demands


# ─────────────────────────── 干扰源 ───────────────────────────
def gen_interference():
    rows = []
    types = ["NARROWBAND", "BROADBAND", "SWEEP", "PULSE", "NOISE"]
    for i in range(1, N_INTERFERENCE + 1):
        hf = i % 2 == 0
        lo = rng.uniform(LON0 + 0.08, LON1 - 0.08)
        la = rng.uniform(LAT0 + 0.08, LAT1 - 0.08)
        rows.append(dict(
            interference_id=sid("IF", i), name="干扰源%02d" % i,
            lon=round(lo, 6), lat=round(la, 6),
            elevation_m=round(terrain.elevation(lo, la), 1),
            antenna_height_m=round(rng.uniform(5, 40), 1),
            center_freq_khz=round(rng.uniform(3000, 11000) if hf
                                  else rng.uniform(30500, 87000), 1),
            bandwidth_khz=round(rng.choice([3, 6, 25, 200, 1000]), 1),
            tx_power_dbm=round(rng.uniform(37, 60), 1),
            antenna_gain_dbi=round(rng.uniform(0, 12), 1),
            interference_type=rng.choice(types),
            pattern_type=rng.choice(["OMNI", "OMNI", "DIRECTIONAL"]),
            azimuth_deg=round(rng.uniform(0, 360), 1),
            duty_cycle=round(rng.choice([0.1, 0.3, 0.6, 1.0]), 2),
            active="true" if i <= 12 else "false",
            _scenario="干扰场景%d" % (1 + (i - 1) // 4)))
    return rows


# ─────────────────────────── 链路运行状态 ───────────────────────────
def state_from_snr(snr, svc="话音"):
    req = {"话音": 10.0, "数据": 15.0, "短消息": 8.0}[svc]
    m = snr - req
    if m >= 20: return "EXCELLENT"
    if m >= 10: return "GOOD"
    if m >= 3:  return "WARNING"
    return "FAULT"


def gen_link_metrics(links, n_per_link=5):
    rows, k = [], 0
    for lk in links:
        svc = "数据" if lk["device_class"] == "VUHF" else "话音"
        base = lk["_snr"]
        for s in range(n_per_link):
            k += 1
            ts = T0 + dt.timedelta(minutes=30 * s + rng.randint(0, 12))
            # 短波受昼夜与电离层扰动影响更大
            jitter = rng.gauss(0, 5.5 if lk["device_class"] == "HF" else 2.8)
            snr = base + jitter
            st = state_from_snr(snr, svc)
            # 由 SNR 推导其余指标，保持物理一致性（供 SR-6.2 挖掘判定规则）
            ber = max(1e-9, 10 ** (-(snr - 2.0) / 3.4))
            loss = min(0.98, max(0.0, 0.55 * math.exp(-(snr - 3) / 5.5)))
            delay = 28 + lk["distance_m"] / 1000.0 * 0.42 + loss * 620 + rng.uniform(0, 14)
            cap = 64.0 if lk["device_class"] == "VUHF" else 4.8
            thr = max(0.0, cap * (1 - loss) * min(1.0, max(0.0, (snr - 2) / 22.0)))
            rows.append(dict(
                record_id="LM-%06d" % k, link_id=lk["link_id"], timestamp=iso(ts),
                snr_db=round(snr, 2), ber="%.2e" % ber,
                packet_loss_rate=round(loss, 4), delay_ms=round(delay, 1),
                throughput_kbps=round(thr, 2), link_state=st))
    return rows


# ─────────────────────────── 故障场景与构造案例 ───────────────────────────
SYMPTOMS = [
    ("SY-0001", "发射时驻波比告警", "DEVICE_STATUS", "", ""),
    ("SY-0002", "功率表读数接近零", "DEVICE_STATUS", "", ""),
    ("SY-0003", "设备自检报功放故障码", "DEVICE_STATUS", "", ""),
    ("SY-0004", "电源指示灯熄灭", "DEVICE_STATUS", "", ""),
    ("SY-0005", "对端完全失联", "LINK_METRIC", "packet_loss_rate", "packet_loss_rate > 0.95"),
    ("SY-0006", "误码率突增至不可用", "LINK_METRIC", "ber", "ber > 1e-2"),
    ("SY-0007", "握手超时", "LINK_METRIC", "delay_ms", "delay_ms > 2000"),
    ("SY-0008", "吞吐率跌至零", "LINK_METRIC", "throughput_kbps", "throughput_kbps < 0.1"),
    ("SY-0009", "收信底噪明显抬升", "LINK_METRIC", "snr_db", "snr_db < 6"),
    ("SY-0010", "特定频点不可用其余正常", "MANUAL", "", ""),
    ("SY-0011", "信噪比骤降但发射自检正常", "LINK_METRIC", "snr_db", "snr_db < 8"),
    ("SY-0012", "频率配置与对端不一致", "MANUAL", "", ""),
    ("SY-0013", "加密参数不匹配无法建链", "MANUAL", "", ""),
    ("SY-0014", "跳频图案不同步", "MANUAL", "", ""),
    ("SY-0015", "协议版本不一致", "MANUAL", "", ""),
]

FAULT_TEMPLATES = {
    "HW_FAILURE": dict(
        symptoms=[["SY-0001", "SY-0002"], ["SY-0003"], ["SY-0004"], ["SY-0001", "SY-0003"]],
        causes=["功放模块输出级晶体管击穿", "天线馈线接头进水短路", "电源模块滤波电容失效",
                "射频继电器触点氧化", "合成器锁相环失锁"],
        comps=["功率放大模块", "天线馈线", "电源模块", "射频开关组件", "频率合成模块"],
        sols=["更换功放模块", "更换馈线及接头并做防水处理", "更换电源模块",
              "更换射频继电器", "更换频率合成板"],
        obj="DEVICE", selftest=["ALARM_VSWR", "ALARM_PA", "ALARM_PWR", "FAULT_RF"]),
    "LINK_DOWN": dict(
        symptoms=[["SY-0005"], ["SY-0006", "SY-0008"], ["SY-0007"], ["SY-0005", "SY-0007"]],
        causes=["对端设备断电", "链路余量不足无法维持同步", "中继节点失效导致链路中断",
                "天线指向偏离", "传播条件恶化(电离层扰动)"],
        comps=["无(链路)", "无(链路)", "中继节点", "天线系统", "无(传播)"],
        sols=["恢复对端供电并重建链路", "提升发射功率或更换频点", "启用备份中继并切换路由",
              "校正天线方位", "改用 NVIS 天线或降低工作频率"],
        obj="LINK", selftest=["NORMAL", "LINK_LOSS"]),
    "SW_CONFIG": dict(
        symptoms=[["SY-0012"], ["SY-0013"], ["SY-0014"], ["SY-0015"], ["SY-0012", "SY-0014"]],
        causes=["工作频率配置与对端不一致", "加密密钥版本不匹配", "跳频图案编号配置错误",
                "通信协议版本不一致", "网络地址重复配置"],
        comps=["配置参数", "加密模块配置", "跳频配置", "协议栈配置", "网络配置"],
        sols=["按通联计划重新下发频率配置", "同步加密密钥版本", "统一跳频图案编号",
              "升级协议版本至一致", "重新分配网络地址"],
        obj="DEVICE", selftest=["NORMAL", "CFG_MISMATCH"]),
    "EMI": dict(
        symptoms=[["SY-0009", "SY-0011"], ["SY-0010"], ["SY-0009", "SY-0006"], ["SY-0011"]],
        causes=["邻近区域同频大功率辐射源", "宽带噪声干扰抬升底噪", "扫频干扰周期性覆盖工作频点",
                "邻频泄漏导致互调", "脉冲干扰导致突发误码"],
        comps=["无(外部干扰)"] * 5,
        sols=["切换至备用频点并上报干扰", "启用跳频模式规避", "调整天线方位形成零陷",
              "提升发射功率改善信干比", "重新部署受扰节点"],
        obj="LINK", selftest=["NORMAL"]),
}


def gen_fault_cases(links, devices, per_type=60):
    rows, k = [], 0
    for ft, tpl in FAULT_TEMPLATES.items():
        for i in range(per_type):
            k += 1
            idx = i % len(tpl["causes"])
            lk = rng.choice(links)
            svc = "数据" if lk["device_class"] == "VUHF" else "话音"
            if ft == "HW_FAILURE":
                snr, ber, loss = None, None, None
            elif ft == "LINK_DOWN":
                snr = round(rng.uniform(-8, 2), 2)
                loss = round(rng.uniform(0.85, 1.0), 4)
            elif ft == "SW_CONFIG":
                snr = round(lk["_snr"] + rng.gauss(0, 3), 2)
                loss = round(rng.uniform(0.9, 1.0), 4)
            else:  # EMI
                snr = round(rng.uniform(-2, 8), 2)
                loss = round(rng.uniform(0.2, 0.7), 4)
            ber = None if snr is None else float("%.2e" % max(1e-9, 10 ** (-(snr - 2.0) / 3.4)))
            thr = None if snr is None else round(max(0.0, (64.0 if lk["device_class"] == "VUHF" else 4.8)
                                                     * (1 - (loss or 0)) * min(1.0, max(0.0, (snr - 2) / 22.0))), 2)
            rows.append(dict(
                case_id=sid("FC", k), fault_type=ft,
                fault_subtype=tpl["comps"][idx],
                object_type=tpl["obj"],
                device_class=lk["device_class"],
                symptom_ids=";".join(tpl["symptoms"][i % len(tpl["symptoms"])]),
                symptom_text="",
                snr_db="" if snr is None else snr,
                ber="" if ber is None else "%.2e" % ber,
                packet_loss_rate="" if loss is None else loss,
                delay_ms="" if snr is None else round(28 + (loss or 0) * 620 + rng.uniform(0, 20), 1),
                throughput_kbps="" if thr is None else thr,
                device_selftest=rng.choice(tpl["selftest"]),
                root_cause=tpl["causes"][idx], fault_component=tpl["comps"][idx],
                diagnosis_steps="核对故障现象;读取设备自检码;测量链路指标;定位故障部件",
                solution=tpl["sols"][idx],
                repair_time_min=rng.choice([15, 20, 30, 45, 60, 90, 120]),
                source_doc="CONSTRUCTED"))
    return rows


def gen_fault_scenarios(links, devices, nodes):
    dev_by_node = {d["node_id"]: d for d in devices}
    key_nodes = [n for n in nodes if n["is_key"] == "true"]
    scen = []
    picks = [
        ("设备硬件故障-关键中继功放失效", "HW_FAILURE", "DEVICE"),
        ("链路中断-骨干链路失联", "LINK_DOWN", "LINK"),
        ("软件配置异常-频率配置不一致", "SW_CONFIG", "DEVICE"),
        ("电磁干扰-东部平原区受扰", "EMI", "LINK"),
        ("复合场景-硬件故障叠加电磁干扰", "MIXED", "MIXED"),
    ]
    for i, (name, ft, ot) in enumerate(picks, 1):
        faults = []
        if ft == "MIXED":
            nd = rng.choice(key_nodes)
            faults.append(dict(object_type="DEVICE", object_id=dev_by_node[nd["node_id"]]["device_id"],
                               fault_type="HW_FAILURE", symptom_ids=["SY-0001", "SY-0003"],
                               occur_time=iso(T0 + dt.timedelta(hours=2)), params={}))
            lk = rng.choice(links)
            faults.append(dict(object_type="LINK", object_id=lk["link_id"],
                               fault_type="EMI", symptom_ids=["SY-0009", "SY-0011"],
                               occur_time=iso(T0 + dt.timedelta(hours=2, minutes=25)),
                               params={"interference_id": "IF-0002"}))
        elif ot == "DEVICE":
            nd = rng.choice(key_nodes)
            tpl = FAULT_TEMPLATES[ft]
            faults.append(dict(object_type="DEVICE", object_id=dev_by_node[nd["node_id"]]["device_id"],
                               fault_type=ft, symptom_ids=tpl["symptoms"][0],
                               occur_time=iso(T0 + dt.timedelta(hours=i)), params={}))
        else:
            lk = rng.choice([l for l in links if l["link_state"] in ("EXCELLENT", "GOOD")])
            tpl = FAULT_TEMPLATES[ft]
            p = {"interference_id": "IF-0001"} if ft == "EMI" else {}
            faults.append(dict(object_type="LINK", object_id=lk["link_id"],
                               fault_type=ft, symptom_ids=tpl["symptoms"][0],
                               occur_time=iso(T0 + dt.timedelta(hours=i)), params=p))
        scen.append(dict(scenario_id=sid("FS", i), scenario_name=name,
                         faults=faults, create_time=iso(T0)))
    return scen


# ─────────────────────────── 主流程 ───────────────────────────
def main():
    os.makedirs(OUT, exist_ok=True)
    print("生成基础测试数据集  seed=%d  地形=%s" % (SEED, terrain.name))
    print("规划区 %.4f,%.4f - %.4f,%.4f\n" % BBOX)

    models, msrc = load_models()
    antennas, asrc = load_antennas()

    nodes = gen_nodes()
    devices = gen_devices(nodes, models, antennas)
    links, freq_pool = gen_links(nodes, devices)
    tasks, demands = gen_tasks_and_demands(nodes, links)
    inters = gen_interference()
    metrics = gen_link_metrics(links)
    cases = gen_fault_cases(links, devices)
    scenarios = gen_fault_scenarios(links, devices, nodes)

    print("\n输出:")
    write_csv("node.csv", nodes,
              ["node_id", "node_name", "node_role", "mobility", "lon", "lat",
               "elevation_m", "region", "device_class", "status", "is_key", "remark"])
    write_csv("device.csv", devices,
              ["device_id", "node_id", "model_id", "antenna_id", "antenna_height_m",
               "tilt_deg", "azimuth_deg", "tx_power_dbm", "work_freq_khz",
               "status", "install_time"])
    write_csv("device_model.csv", models, list(DEFAULT_MODELS[0].keys()))
    write_csv("antenna_model.csv", antennas, list(DEFAULT_ANTENNAS[0].keys()))
    write_csv("link.csv", links,
              ["link_id", "node_a_id", "node_b_id", "device_a_id", "device_b_id",
               "device_class", "freq_khz", "bandwidth_khz", "distance_m",
               "path_loss_db", "rx_power_dbm", "link_margin_db", "is_available",
               "link_state", "is_backup"])
    write_csv("task_scenario.csv", tasks,
              ["task_id", "task_name", "area_bbox", "start_time", "duration_h", "description"])
    write_csv("comm_demand.csv", demands,
              ["demand_id", "task_id", "src_node_id", "dst_node_id", "priority",
               "is_mandatory", "data_volume_mb", "required_rate_kbps", "max_delay_ms",
               "min_reliability", "service_type", "preferred_class"])
    write_csv("frequency_resource.csv", freq_pool,
              ["freq_id", "device_class", "center_freq_khz", "bandwidth_khz", "channel_no",
               "is_available", "occupied_by", "reuse_min_distance_m",
               "adjacent_guard_khz", "note"])
    write_csv("interference_source.csv", inters,
              ["interference_id", "name", "lon", "lat", "elevation_m", "antenna_height_m",
               "center_freq_khz", "bandwidth_khz", "tx_power_dbm", "antenna_gain_dbi",
               "interference_type", "pattern_type", "azimuth_deg", "duty_cycle", "active"])
    write_csv("link_metric.csv", metrics,
              ["record_id", "link_id", "timestamp", "snr_db", "ber",
               "packet_loss_rate", "delay_ms", "throughput_kbps", "link_state"])
    write_csv("symptom_dict.csv",
              [dict(symptom_id=a, symptom_name=b, observable_from=c,
                    metric_field=d, threshold_expr=e) for a, b, c, d, e in SYMPTOMS],
              ["symptom_id", "symptom_name", "observable_from", "metric_field", "threshold_expr"])
    write_csv("fault_case.csv", cases,
              ["case_id", "fault_type", "fault_subtype", "object_type", "device_class",
               "symptom_ids", "symptom_text", "snr_db", "ber", "packet_loss_rate",
               "delay_ms", "throughput_kbps", "device_selftest", "root_cause",
               "fault_component", "diagnosis_steps", "solution", "repair_time_min", "source_doc"])
    with open(os.path.join(OUT, "fault_scenario.json"), "w", encoding="utf-8") as f:
        json.dump(scenarios, f, ensure_ascii=False, indent=2)
    print("  %-26s %5d 个" % ("fault_scenario.json", len(scenarios)))

    # ── 数据体检 ──
    print("\n数据体检:")
    hf = [n for n in nodes if n["device_class"] == "HF"]
    vu = [n for n in nodes if n["device_class"] == "VUHF"]
    print("  节点 %d (短波 %d / 超短波 %d)  关键节点 %d   [软需: 短波>=50 超短波>=100]"
          % (len(nodes), len(hf), len(vu), sum(1 for n in nodes if n["is_key"] == "true")))
    avail = sum(1 for l in links if l["is_available"] == "true")
    print("  链路 %d (可用 %d)   [软需: 200-500]" % (len(links), avail))
    st = {}
    for l in links:
        st[l["link_state"]] = st.get(l["link_state"], 0) + 1
    print("  链路状态分布: " + "  ".join("%s=%d" % (k, st.get(k, 0))
          for k in ["EXCELLENT", "GOOD", "WARNING", "FAULT"]))
    mand = sum(1 for d in demands if d["is_mandatory"] == "true")
    print("  通联需求 %d (必要 %d, 占 %.0f%%)  任务场景 %d   [软需: 每组30-100条]"
          % (len(demands), mand, 100.0 * mand / max(1, len(demands)), len(tasks)))
    ms = {}
    for m in metrics:
        ms[m["link_state"]] = ms.get(m["link_state"], 0) + 1
    print("  链路状态记录 %d   [软需: >=1000]" % len(metrics))
    print("  状态标签分布: " + "  ".join("%s=%d" % (k, ms.get(k, 0))
          for k in ["EXCELLENT", "GOOD", "WARNING", "FAULT"]))
    fc = {}
    for c in cases:
        fc[c["fault_type"]] = fc.get(c["fault_type"], 0) + 1
    print("  故障案例 %d: " % len(cases) + "  ".join("%s=%d" % (k, v) for k, v in fc.items())
          + "   [软需: 每类50-100]")
    print("  频点 %d (短波 %d / 超短波 %d)  干扰源 %d"
          % (len(freq_pool), sum(1 for f in freq_pool if f["device_class"] == "HF"),
             sum(1 for f in freq_pool if f["device_class"] == "VUHF"), len(inters)))
    print("\n设备型号来源: %s   天线来源: %s" % (msrc, asrc))
    if msrc == "CONSTRUCTED":
        print("  → 师弟的真实型号库到位后放到 data/raw/device/，重跑本脚本自动切换")


if __name__ == "__main__":
    main()
