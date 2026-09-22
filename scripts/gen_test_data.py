#!/usr/bin/env python3
"""基础测试数据集生成器（第 1 周交付物）。

生成"自行构造"的 7 类数据 + 构造版故障案例，全部符合 docs/design/01_数据字典.md。
纯标准库，无需安装任何包：
    python3 scripts/gen_test_data.py

地形与地物默认读取 data/raw/ 下的真实网格（见 scripts/terrain.py），
数据缺失时自动回退合成地形。
"""
import csv, json, math, os, random, sys, datetime as dt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "planning"))
from terrain import default_terrain, BBOX, haversine_m, los_clearance
from propagation import vuhf_path_loss, hf_path_loss, link_budget, margin_to_state
from datapaths import path as dpath, RAW_DEVICE_MODEL, RAW_ANTENNA_MODEL
from devicespec import SpecFiller

SEED = 20260908
LON0, LAT0, LON1, LAT1 = BBOX
T0 = dt.datetime(2026, 9, 8, 8, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=8)))

N_TASK_SCENARIOS = 6
N_INTERFERENCE = 16
MAX_LINKS = 500

rng = random.Random(SEED)
terrain = default_terrain()


def iso(t): return t.isoformat()
def sid(p, n): return "%s-%04d" % (p, n)


def write_csv(name, rows, header):
    path = dpath(name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
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
    p = RAW_DEVICE_MODEL
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
    p = RAW_ANTENNA_MODEL
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            rows = [r for r in csv.DictReader(f)
                    if r.get("antenna_id") and "示例" not in r.get("antenna_name", "")]
        if rows:
            return rows, "REAL"
    return DEFAULT_ANTENNAS, "CONSTRUCTED"


# ─────────────────────────── 编成结构 ───────────────────────────
# 来源：《技术参考》内嵌 Visio 图（word/embeddings/Microsoft_Visio_Drawing.vsdx）。
# 图中给出的是一个编成样板（Ⅲ×6、b机动车×12、背负式×12），本脚本按该结构放大到
# 软需 SR-4.2 f 的规模口径：短波节点 ≥50、超短波节点 ≥100。
#
# 图上是五行（以形状纵坐标为证，非四行）：
#   行1  Ⅰdb固定站 ── Ⅰdb机动站          （同行有链路，互为备份）
#   行2  Ⅱdb/cdb固定站                    （单独一行，是行3两类 Ⅱ 的上级）
#   行3  Ⅱdb/cdb机动站  Ⅱdb/cdb机动节点站  （同行之间无链路，须经 Ⅱ固定站中继）
#   行4  Ⅲdb/cdb机动站                    （同行之间图上无链路；合作方补充可直连中继）
#   行5  Ⅳcdb机动站                       （同行之间无链路）
# 右支为 Ⅰ 直属短波机动力量：Ⅰ机动站 → a机动车 / b机动车 → 背负式电台，全为 db。

N_II_FIXED = 4                  # 每个 Ⅱ固定站领 2 个 Ⅱ机动站 + 2 个 Ⅱ机动节点站
N_II_MOBILE_PER, N_II_NODE_PER = 2, 2
N_III, N_IV = 30, 60
N_VEH_A, N_VEH_B, N_MANPACK = 2, 12, 12

# 编成口径（层级、子类型、容量、功率、中继能力）统一由 planning/echelon.py 定义，
# 本脚本只引用，不另建一份 —— 避免两处常量漂移。
from echelon import (ECHELON_CAP, SUBTYPE_ECHELON, SUBTYPE_MOBILITY,
                     SUBTYPE_NAME, SUBTYPE_POWER, SUBTYPE_RELAY)


# ─────────────────────────── 节点 ───────────────────────────
# 任务区分布在规划区内，覆盖山地、山前过渡与平原三类地形，
# 使部署规划与传播计算都能落到有区分度的地形上。
TASK_AREAS = [
    ("太行山区", 114.16, 37.55, 0.14),
    ("山前过渡区", 114.42, 37.25, 0.16),
    ("中部平原区", 114.85, 37.65, 0.18),
    ("东部平原区", 115.20, 37.20, 0.18),
]


def gen_nodes():
    """按编成结构生成节点，并逐级指派上级（parent_node_id，多归属以 ; 分隔）。

    上级指派受容量约束：一个节点能带多少下级，由它在该频段的设备台数决定。
    频段分配由 Visio 连线度数反推（见方案 3.1）：
        Ⅱ固定站──Ⅱ机动站/节点站  走 db      Ⅱ机动站/节点站──Ⅲ  走 cdb
        Ⅲ──Ⅳ                     走 cdb     Ⅰ──Ⅱ固定站         走 db
    """
    nodes, n = [], 0
    used = {}          # (node_id, band) -> 已占用端口数

    def add(subtype, lon, lat, name, parents=(), region=None):
        nonlocal n
        n += 1
        lon = min(max(lon, LON0 + 0.02), LON1 - 0.02)
        lat = min(max(lat, LAT0 + 0.02), LAT1 - 0.02)
        cap = ECHELON_CAP[subtype]
        cls = ";".join(b for b in ("HF", "VUHF") if cap[b] > 0)
        nd = dict(
            node_id=sid("ND", n), node_name=name,
            echelon=SUBTYPE_ECHELON[subtype], node_subtype=subtype,
            parent_node_id=";".join(parents),
            node_role="FIXED_STATION" if SUBTYPE_MOBILITY[subtype] == "FIXED" else "TASK",
            mobility=SUBTYPE_MOBILITY[subtype],
            lon=round(lon, 6), lat=round(lat, 6),
            elevation_m=round(terrain.elevation(lon, lat), 1),
            region=nearest_area(lon, lat), device_class=cls,
            relay_capable="true" if SUBTYPE_RELAY[subtype] else "false",
            status="NORMAL", is_key="false", remark="")
        nodes.append(nd)
        used[(nd["node_id"], "HF")] = 0
        used[(nd["node_id"], "VUHF")] = 0
        return nd

    def nearest_area(lon, lat):
        return min(TASK_AREAS, key=lambda a: (a[1] - lon) ** 2 + (a[2] - lat) ** 2)[0]

    def spare(nd, band):
        return ECHELON_CAP[nd["node_subtype"]][band] - used[(nd["node_id"], band)]

    def take(nd, band, k=1):
        used[(nd["node_id"], band)] += k

    def pick_high(lon_c=None, lat_c=None, r=0.0, tries=60):
        """在给定中心半径内挑高程高、坡度小的点；不给中心则全区搜。"""
        best = None
        for _ in range(tries):
            if lon_c is None:
                lo = rng.uniform(LON0 + 0.05, LON1 - 0.05)
                la = rng.uniform(LAT0 + 0.05, LAT1 - 0.05)
            else:
                lo = min(max(rng.gauss(lon_c, r), LON0 + 0.03), LON1 - 0.03)
                la = min(max(rng.gauss(lat_c, r), LAT0 + 0.03), LAT1 - 0.03)
            sl = terrain.slope_deg(lo, la)
            if sl > 20:
                continue
            sc = terrain.elevation(lo, la) - 40 * sl
            if best is None or sc > best[0]:
                best = (sc, lo, la)
        return (best[1], best[2]) if best else (lon_c or 114.7, lat_c or 37.45)

    # ── 行1：Ⅰ 固定站与机动站（同行互为备份）──
    lo, la = pick_high()
    i_fixed = add("I_FIXED", lo, la, "Ⅰ短波固定站01")
    lo, la = pick_high(i_fixed["lon"], i_fixed["lat"], 0.12)
    i_mobile = add("I_MOBILE", lo, la, "Ⅰ短波机动站01", parents=(i_fixed["node_id"],))
    take(i_fixed, "HF"); take(i_mobile, "HF")

    # ── 行2：Ⅱ 固定站，上行 Ⅰ固定站（db）──
    ii_fixed = []
    for i in range(N_II_FIXED):
        area = TASK_AREAS[i % len(TASK_AREAS)]
        lo, la = pick_high(area[1], area[2], area[3] * 0.5)
        nd = add("II_FIXED", lo, la, "Ⅱ双频固定站%02d" % (i + 1),
                 parents=(i_fixed["node_id"],))
        take(i_fixed, "HF"); take(nd, "HF")
        ii_fixed.append(nd)

    # ── 行3：Ⅱ 机动站 / 机动节点站，上行本组 Ⅱ固定站（db）──
    ii_row3 = []
    for k, par in enumerate(ii_fixed):
        for j in range(N_II_MOBILE_PER):
            lo, la = pick_high(par["lon"], par["lat"], 0.13)
            nd = add("II_MOBILE", lo, la, "Ⅱ双频机动站%02d" % (k * N_II_MOBILE_PER + j + 1),
                     parents=(par["node_id"],))
            take(par, "HF"); take(nd, "HF"); ii_row3.append(nd)
        for j in range(N_II_NODE_PER):
            lo, la = pick_high(par["lon"], par["lat"], 0.13)
            nd = add("II_NODE", lo, la, "Ⅱ双频机动节点站%02d" % (k * N_II_NODE_PER + j + 1),
                     parents=(par["node_id"],))
            take(par, "HF"); take(nd, "HF"); ii_row3.append(nd)

    # ── 行4：Ⅲ 机动站，上行 Ⅱ 行3（cdb），尽量双上级 ──
    iii = []
    for i in range(N_III):
        pool = [x for x in ii_row3 if spare(x, "VUHF") > 0]
        if not pool:
            break
        pool.sort(key=lambda x: -spare(x, "VUHF"))
        par = pool[0]
        lo, la = pick_high(par["lon"], par["lat"], 0.16)
        nd = add("III_MOBILE", lo, la, "Ⅲ双频机动站%02d" % (i + 1))
        # 第一上级
        take(par, "VUHF"); take(nd, "VUHF")
        ps = [par["node_id"]]
        # 第二上级：另一个还有余量、且不是同一个的 Ⅱ
        alt = [x for x in ii_row3
               if x is not par and spare(x, "VUHF") > 0 and spare(nd, "VUHF") > 1]
        if alt:
            alt.sort(key=lambda x: -spare(x, "VUHF"))
            take(alt[0], "VUHF"); take(nd, "VUHF")
            ps.append(alt[0]["node_id"])
        nd["parent_node_id"] = ";".join(ps)
        iii.append(nd)

    # ── 行5：Ⅳ 任务站点，上行 Ⅲ（cdb），单上级 ──
    n_iv = 0
    for i in range(N_IV):
        pool = [x for x in iii if spare(x, "VUHF") > 0]
        if not pool:
            break
        pool.sort(key=lambda x: -spare(x, "VUHF"))
        par = pool[0]
        lo = rng.gauss(par["lon"], 0.10)
        la = rng.gauss(par["lat"], 0.10)
        nd = add("IV_MOBILE", lo, la, "Ⅳ任务站点%03d" % (i + 1),
                 parents=(par["node_id"],))
        take(par, "VUHF"); take(nd, "VUHF"); n_iv += 1

    # ── 右支：Ⅰ机动站 → a车 / b车 → 背负式，全为 db ──
    veh = []
    for i in range(N_VEH_A):
        lo, la = pick_high(i_mobile["lon"], i_mobile["lat"], 0.18)
        nd = add("VEHICLE_A", lo, la, "a机动车%02d" % (i + 1),
                 parents=(i_mobile["node_id"],))
        take(i_mobile, "HF"); take(nd, "HF"); veh.append(nd)
    for i in range(N_VEH_B):
        lo, la = pick_high(i_mobile["lon"], i_mobile["lat"], 0.24)
        nd = add("VEHICLE_B", lo, la, "b机动车%02d" % (i + 1),
                 parents=(i_mobile["node_id"],))
        take(i_mobile, "HF"); take(nd, "HF"); veh.append(nd)
    for i in range(N_MANPACK):
        pool = [x for x in veh if spare(x, "HF") > 0]
        if not pool:
            break
        pool.sort(key=lambda x: -spare(x, "HF"))
        ps = []
        lo, la = pick_high(pool[0]["lon"], pool[0]["lat"], 0.10)
        nd = add("MANPACK", lo, la, "背负式短波电台%02d" % (i + 1))
        for par in pool[:2]:                      # 图中背负式同时挂 a车 与 b车
            if spare(nd, "HF") <= 0:
                break
            take(par, "HF"); take(nd, "HF"); ps.append(par["node_id"])
        nd["parent_node_id"] = ";".join(ps)

    # ── 关键节点：Ⅰ、Ⅱ 全部，加每个任务区 2 个 Ⅳ ──
    for nd in nodes:
        if nd["echelon"] in ("I", "II") and nd["node_subtype"].startswith(("I_", "II_")):
            nd["is_key"] = "true"
    for area in TASK_AREAS:
        cand = [x for x in nodes if x["region"] == area[0] and x["node_subtype"] == "IV_MOBILE"]
        for x in rng.sample(cand, min(2, len(cand))):
            x["is_key"] = "true"
    return nodes


# ─────────────────────────── 设备实例 ───────────────────────────
def gen_devices(nodes, models, antennas):
    """按编成定额为每个节点生成多台设备。

    **一个节点可以同时装 db 与 cdb 两套电台**（Ⅱ、Ⅲ 即如此），
    台数由 ECHELON_CAP 给出，等于该节点在该频段能同时维持的链路数。
    频段转换只发生在这类双频节点内部（合作方：「转了一层」）；
    一条链路的两端必须是同一频段的电台，见 gen_links。
    """
    by_cls, ant_by_cls = {}, {}
    for m in models:
        by_cls.setdefault(m["device_class"], []).append(m)
    for a_ in antennas:
        ant_by_cls.setdefault(a_["device_class"], []).append(a_)

    def pick_model(band, want_dbm):
        """挑发射功率档位最接近编成标注值的型号。"""
        pool = by_cls.get(band) or by_cls[list(by_cls)[0]]
        best, bestd = None, None
        for m in pool:
            levels = [float(x) for x in str(m["tx_power_levels_dbm"]).split(";") if x]
            for lv in levels:
                d = abs(lv - want_dbm)
                if bestd is None or d < bestd:
                    best, bestd = (m, lv), d
        return best

    def pick_antenna(band, subtype):
        pool = ant_by_cls.get(band) or ant_by_cls[list(ant_by_cls)[0]]
        if band == "VUHF":
            # 图注：所有 cdb 天线均为 1.5 m 鞭天线
            whip = [x for x in pool if "1.5" in x["antenna_name"]]
            return rng.choice(whip or [x for x in pool if x["pattern_type"] == "OMNI"] or pool)
        # 短波：固定站与半数车载配 NVIS（区域内通信主力），其余鞭状
        nv = [x for x in pool if x["pattern_type"] == "NVIS"]
        om = [x for x in pool if x["pattern_type"] == "OMNI"]
        want_nvis = SUBTYPE_MOBILITY[subtype] == "FIXED" or rng.random() < 0.5
        return rng.choice(nv if (want_nvis and nv) else (om or pool))

    def pick_height(subtype, band):
        if SUBTYPE_MOBILITY[subtype] == "FIXED":
            return rng.uniform(10, 18)
        if SUBTYPE_MOBILITY[subtype] == "MANPACK":
            return rng.uniform(1.8, 3.0)
        return rng.uniform(3.5, 8)

    filler = SpecFiller(models)
    devices, i = [], 0
    for nd in nodes:
        st = nd["node_subtype"]
        for band in ("HF", "VUHF"):
            cap = ECHELON_CAP[st][band]
            for k in range(cap):
                i += 1
                want = SUBTYPE_POWER.get((st, band), 47.0)
                m, lv = pick_model(band, want)
                a_ = pick_antenna(band, st)
                bw = filler.bandwidth(m)
                sens = filler.sensitivity(m)
                devices.append(dict(
                    device_id=sid("DV", i), node_id=nd["node_id"], model_id=m["model_id"],
                    antenna_id=a_["antenna_id"],
                    antenna_height_m=round(pick_height(st, band), 1),
                    tilt_deg="", azimuth_deg="", tx_power_dbm=round(lv, 1),
                    work_freq_khz="", status="NORMAL", install_time=iso(T0),
                    _class=band, _node=nd, _subtype=st, _port=k,
                    _pattern=a_["pattern_type"], _gain=float(a_["gain_dbi"]),
                    _sens=sens, _bw=bw,
                    _fmin=float(m["freq_min_khz"]),
                    _fmax=float(m["freq_max_khz"])))
    print(filler.report())
    return devices


def index_devices(devices):
    """(node_id, band) -> 该节点该频段的设备列表。

    「db 不能和 cdb 相连」在代码中的落点：链路只在双方**都持有同一频段端口**时才成立，
    不能再用比较两个节点 device_class 字符串的老办法——节点现在可能是双频的。
    """
    idx = {}
    for d in devices:
        idx.setdefault((d["node_id"], d["_class"]), []).append(d)
    return idx


# ─────────────────────────── 频率资源池 ───────────────────────────
def gen_freq_pool(models=None):
    """频率资源池。

    **频段边界由实际设备型号库推导，不写死。** 起初短波 3–12 MHz、
    超短波 30–88 MHz 是按军用战术频段构造的；师弟交付真实型号后发现
    采集到的超短波电台全是 136–870 MHz 的商用制式，两边对不上，
    导致 157 条链路的工作频率落在设备型号范围之外（由校验段 [9b] 抓出）。
    因此改为从型号库取各频段的可用区间，池子永远与在库设备自洽。
    """
    rows, n = [], 0

    def span(band, fallback):
        if not models:
            return fallback
        lo = [float(m["freq_min_khz"]) for m in models
              if m.get("device_class") == band and m.get("freq_min_khz")]
        hi = [float(m["freq_max_khz"]) for m in models
              if m.get("device_class") == band and m.get("freq_max_khz")]
        if not lo or not hi:
            return fallback
        lo.sort(); hi.sort()
        # 取中位数边界：让多数型号都能用，不被个别宽频段型号拉偏
        return (lo[len(lo) // 2], hi[len(hi) // 2])

    # 短波：限制在 3–12 MHz。NVIS 需低于昼间反射上限 7.5 MHz，
    # 且区域内（<300 km）通信主要靠地波与 NVIS，高频段用不上。
    hf_lo, hf_hi = span("HF", (1600.0, 30000.0))
    lo = max(3000.0, hf_lo)
    hi = min(12000.0, hf_hi)
    step = (hi - lo) / 46.0
    for i in range(46):
        n += 1
        rows.append(dict(freq_id=sid("FQ", n), device_class="HF",
                         center_freq_khz=round(lo + i * step, 1),
                         bandwidth_khz=3, channel_no=i + 1,
                         is_available="true" if i % 11 else "false", occupied_by="",
                         reuse_min_distance_m=60000, adjacent_guard_khz=3,
                         note="" if i % 11 else "禁用-预留应急频点"))

    vu_lo, vu_hi = span("VUHF", (30000.0, 88000.0))
    step = (vu_hi - vu_lo) / 48.0
    for i in range(48):
        n += 1
        rows.append(dict(freq_id=sid("FQ", n), device_class="VUHF",
                         center_freq_khz=round(vu_lo + i * step + step / 2, 1),
                         bandwidth_khz=25, channel_no=i + 1,
                         is_available="true" if i % 13 else "false", occupied_by="",
                         reuse_min_distance_m=25000, adjacent_guard_khz=25,
                         note="" if i % 13 else "禁用-邻区占用"))
    return rows


def default_freq(dev, pool, other=None):
    """挑一个工作频点。

    **必须对链路两端的设备型号都合法**。原先只检查了 dev 一端，
    两端频率范围不同时会选出一端够不着的频点（校验段 [9b] 会判为非法链路）。
    """
    lo, hi = dev["_fmin"], dev["_fmax"]
    if other is not None:
        lo, hi = max(lo, other["_fmin"]), min(hi, other["_fmax"])
    cand = [f for f in pool if f["device_class"] == dev["_class"]
            and f["is_available"] == "true"
            and lo <= f["center_freq_khz"] <= hi]
    if not cand:
        cand = [f for f in pool if f["device_class"] == dev["_class"]
                and lo <= f["center_freq_khz"] <= hi]
    if not cand:
        return None                      # 两端频段无交集 → 该链路不成立
    if dev["_class"] == "HF":
        # NVIS 需低于昼间反射上限 7.5 MHz
        low = [f for f in cand if f["center_freq_khz"] <= 7000]
        cand = low or cand
    return cand[0]["center_freq_khz"]


# ─────────────────────────── 链路 ───────────────────────────
def gen_links(nodes, devices, models=None):
    """构建网络拓扑。

    两步走：先用余量最好的链路建出连通骨架（并查集），保证路由规划有解；
    再按链路状态配额分层补足。若只取最短的若干条，全网会清一色 EXCELLENT，
    SR-6.2 无法从指标挖掘状态判定规则，故障诊断也没有弱链路可分析。
    """
    dev_idx = index_devices(devices)
    pool = gen_freq_pool(models)
    max_range = {"HF": 175000, "VUHF": 95000}

    # 1) 枚举候选并算链路预算
    #
    # **按 (节点, 频段) 二元组枚举，而不是按节点。**
    # 一个节点现在可能同时装 db 与 cdb 两套电台（Ⅱ、Ⅲ），
    # 「db 不能和 cdb 相连」因此不能再靠比较两个节点的 device_class 字符串来保证——
    # 那个写法只在「每节点单频」时才等价。正确判据是：
    # 链路归属于某个频段，两端都必须持有该频段的端口。
    cands = []
    for band in ("HF", "VUHF"):
        holders = [nd for nd in nodes if (nd["node_id"], band) in dev_idx]
        for i in range(len(holders)):
            for j in range(i + 1, len(holders)):
                a, b = holders[i], holders[j]
                d = haversine_m(a["lon"], a["lat"], b["lon"], b["lat"])
                if d > max_range[band]:
                    continue
                da = dev_idx[(a["node_id"], band)][0]
                db = dev_idx[(b["node_id"], band)][0]
                cls = band
                f = default_freq(da, pool)
                pa = (a["lon"], a["lat"]); pb = (b["lon"], b["lat"])
                if cls == "HF":
                    pat = "NVIS" if "NVIS" in (da["_pattern"], db["_pattern"]) else "OMNI"
                    pl, ok, clr, dd = hf_path_loss(terrain, pa, pb, f, pat)
                else:
                    pl, ok, clr, dd = vuhf_path_loss(terrain, pa, pb, f,
                                                     da["antenna_height_m"],
                                                     db["antenna_height_m"])
                svc = "数据" if cls == "VUHF" else "话音"
                rx, snr, mg = link_budget(min(da["tx_power_dbm"], db["tx_power_dbm"]),
                                          da["_gain"], db["_gain"], pl, f, da["_bw"], svc,
                                          max(da["_sens"], db["_sens"]))
                if mg < -12:                      # 远低于门限，不作为候选
                    continue
                cands.append(dict(a=a, b=b, da=da, db=db, cls=cls, f=f, pl=pl, rx=rx,
                                  snr=snr, mg=mg, d=dd, los=ok,
                                  state=margin_to_state(mg)))

    # 2) 连通骨架：**每个频段各做一棵**最大生成树（按余量降序）
    #    不能跨频段合并连通分量——db 网和 cdb 网是两张独立的网。
    parent = {}
    for nd in nodes:
        for band in ("HF", "VUHF"):
            parent[(nd["node_id"], band)] = (nd["node_id"], band)

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
        if union((c["a"]["node_id"], c["cls"]), (c["b"]["node_id"], c["cls"])):
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
            # 两端必须至少共享一个频段，否则「db 不能和 cdb 相连」，需求无法成立
            if a["node_id"] == b["node_id"]:
                continue
            if not (set(a["device_class"].split(";")) & set(b["device_class"].split(";"))):
                continue
            key = tuple(sorted((a["node_id"], b["node_id"])))
            if key in seen:
                continue
            seen.add(key)
            dn += 1
            both = set(a["device_class"].split(";")) & set(b["device_class"].split(";"))
            shared = "VUHF" if "VUHF" in both else "HF"
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
                service_type=svc, preferred_class=shared))
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
    dev_by_node = {}
    for _d in devices:                      # 一个节点现在有多台设备，取第一台作代表
        dev_by_node.setdefault(_d["node_id"], _d)
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
    print("生成基础测试数据集  seed=%d  地形=%s" % (SEED, terrain.name))
    print("规划区 %.4f,%.4f - %.4f,%.4f\n" % BBOX)

    models, msrc = load_models()
    antennas, asrc = load_antennas()

    nodes = gen_nodes()
    devices = gen_devices(nodes, models, antennas)
    links, freq_pool = gen_links(nodes, devices, models)
    tasks, demands = gen_tasks_and_demands(nodes, links)
    inters = gen_interference()
    metrics = gen_link_metrics(links)
    cases = gen_fault_cases(links, devices)
    scenarios = gen_fault_scenarios(links, devices, nodes)

    print("\n输出:")
    write_csv("node.csv", nodes,
              ["node_id", "node_name", "echelon", "node_subtype", "parent_node_id",
               "node_role", "mobility", "lon", "lat",
               "elevation_m", "region", "device_class", "relay_capable",
               "status", "is_key", "remark"])
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
    _p = dpath("fault_scenario.json")
    os.makedirs(os.path.dirname(_p), exist_ok=True)
    with open(_p, "w", encoding="utf-8") as f:
        json.dump(scenarios, f, ensure_ascii=False, indent=2)
    print("  %-26s %5d 个" % ("fault_scenario.json", len(scenarios)))

    # ── 数据体检 ──
    print("\n数据体检:")
    hf = [n for n in nodes if "HF" in n["device_class"].split(";")]
    vu = [n for n in nodes if "VUHF" in n["device_class"].split(";")]
    dual = [n for n in nodes if ";" in n["device_class"]]
    print("  节点 %d (持短波 %d / 持超短波 %d / 双频 %d)  关键节点 %d"
          "   [软需: 短波>=50 超短波>=100]"
          % (len(nodes), len(hf), len(vu), len(dual),
             sum(1 for n in nodes if n["is_key"] == "true")))
    ec = {}
    for n in nodes:
        ec[n["node_subtype"]] = ec.get(n["node_subtype"], 0) + 1
    print("  编成构成: " + "  ".join("%s=%d" % (k, ec[k]) for k in
          ["I_FIXED", "I_MOBILE", "II_FIXED", "II_MOBILE", "II_NODE",
           "III_MOBILE", "IV_MOBILE", "VEHICLE_A", "VEHICLE_B", "MANPACK"] if k in ec))
    print("  设备 %d 台 (短波 %d / 超短波 %d)  = 各节点编成定额之和，即容量上限"
          % (len(devices), sum(1 for d in devices if d["_class"] == "HF"),
             sum(1 for d in devices if d["_class"] == "VUHF")))
    if ec.get("III_MOBILE", 0) < N_III or ec.get("IV_MOBILE", 0) < N_IV:
        print("  注: Ⅲ 请求 %d 实际 %d，Ⅳ 请求 %d 实际 %d —— 受上级端口容量限制，"
              "非缺陷（这正是容量约束在起作用）"
              % (N_III, ec.get("III_MOBILE", 0), N_IV, ec.get("IV_MOBILE", 0)))
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
        print("  → 真实型号库放到 data/raw/equipment_docs/ 后重跑本脚本自动切换")


if __name__ == "__main__":
    main()
