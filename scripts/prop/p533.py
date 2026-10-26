"""ITU-R P.533-14：短波天波传播（1.6–30 MHz）。

用于**短波跳距与静区**（SR-1.1.2.6.2 a 的环带形态）以及远距离天波链路判据，
见 05 方案 6.8。

实现的部分
----------
- 单跳/多跳反射几何：以虚高 h' 折射面近似，含地球曲率
- 正割定律基本 MUF：MUF = foF2 · sec(φ)，φ 为 F2 层入射角
- 跳距 d_skip：给定频率下天波能返回地面的最小地面距离
- 静区：地波作用距离与跳距之间的环带
- 非偏移吸收（D 层）：P.533 简化式
      La = 677.2·sec(i)·I / [ (f + fH)^1.98 + 10.2 ]   （每跳，dB）
  其中 I 为吸收指数（随太阳天顶角与太阳黑子数变化），fH 为回旋频率
- 空间扩散：按斜距计算的自由空间损耗
- 多跳：每跳一次地面反射损耗

**未实现的部分（调用方必须知道）**
-----------------------------------
- **电离层参数不来自 ITU 电离层图。** P.533 要求用 CCIR/URSI 系数计算
  foF2、M(3000)F2、foE 的逐时逐月逐地值，那套系数表离线不可得。
  本模块把 foF2 / 虚高 / 太阳黑子数做成**参数**，默认值是典型值，
  一律标注**待确认**，必须由合作方给出本地实测或订正值后才能作绝对判据。
- Es（偶发 E 层）传播未实现。
- MUF 以上的「超 MUF 模式」与 MUF 附近的概率分布未实现：本模块对
  f > MUF 直接判为不可用，实际会有一定概率仍可通。
- 偏移吸收、极区吸收、极光吸收未实现。
- 多径时延与多普勒展宽未实现（本项目暂不需要）。
- 信噪比与可通概率未实现（噪声在 p372.py，两者未按 P.533 §6 合成）。

也就是说：**几何与频率关系是真的，电离层状态是假定的。**
跳距与静区的**形态**可用；其绝对半径随 foF2 变化，须待实测订正。

单位：距离 m、频率 kHz（对外口径），内部换算为 km/MHz。
"""
import math

RE_KM = 6371.0

# —— 以下为典型值，全部「待确认」，必须由合作方订正 ——
FOF2_DAY_MHZ = 7.5          # F2 层临界频率（日间）
FOF2_NIGHT_MHZ = 4.5        # F2 层临界频率（夜间）
VIRTUAL_HEIGHT_KM = 300.0   # F2 层等效虚高
GYRO_FREQ_MHZ = 1.0         # 电子回旋频率（中纬度典型）
SUNSPOT_R12 = 50.0          # 12 个月平滑太阳黑子数
GROUND_REFLECT_DB = 2.0     # 每次地面反射损耗


def ionosphere(hour, fof2_mhz=None, h_km=None):
    """返回该时刻的电离层假定参数。**全部为待确认的典型值。**"""
    if fof2_mhz is None:
        fof2_mhz = FOF2_DAY_MHZ if 8 <= hour <= 18 else FOF2_NIGHT_MHZ
    return {"foF2": fof2_mhz,
            "h": VIRTUAL_HEIGHT_KM if h_km is None else h_km,
            "day": 8 <= hour <= 18}


def incidence_angle(d_km, h_km, hops=1):
    """单跳地面距离对应的 F2 层入射角 φ（弧度），含地球曲率。

    每跳地面距离 dh = d/hops，对应地心张角 θ = dh/(2·Re)。
    入射角由三角关系给出：tanφ = Re·sinθ / (Re + h − Re·cosθ)
    """
    dh = max(d_km / max(hops, 1), 1e-6)
    theta = dh / (2.0 * RE_KM)
    num = RE_KM * math.sin(theta)
    den = (RE_KM + h_km) - RE_KM * math.cos(theta)
    return math.atan2(num, den)


def basic_muf_mhz(d_km, hour=12, hops=1, fof2_mhz=None, h_km=None):
    """正割定律基本 MUF（MHz）。距离越远入射角越斜，可用频率越高。"""
    io = ionosphere(hour, fof2_mhz, h_km)
    phi = incidence_angle(d_km, io["h"], hops)
    return io["foF2"] / max(math.cos(phi), 1e-6)


def skip_distance_km(freq_khz, hour=12, fof2_mhz=None, h_km=None):
    """跳距：该频率天波能返回地面的**最小**地面距离（km）。

    平面近似下 d_skip = 2h'·√((f/foF2)² − 1)；本实现在此基础上用
    正割定律沿距离求解，使结果与 `basic_muf_mhz` 自洽（含曲率）。
    f ≤ foF2 时垂直入射即可反射，无跳距（NVIS 情形），返回 0。
    """
    io = ionosphere(hour, fof2_mhz, h_km)
    f = freq_khz / 1000.0
    if f <= io["foF2"]:
        return 0.0
    # 二分求解 basic_muf(d) = f
    lo, hi = 1.0, 4000.0
    if basic_muf_mhz(hi, hour, 1, io["foF2"], io["h"]) < f:
        return float("inf")          # 该频率任何距离都反射不回来
    for _ in range(80):
        mid = (lo + hi) / 2.0
        if basic_muf_mhz(mid, hour, 1, io["foF2"], io["h"]) < f:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def skip_distance_flat_km(freq_khz, hour=12, fof2_mhz=None, h_km=None):
    """平面近似的教科书式跳距 d = 2h'·√((f/foF2)²−1)，用于对照。"""
    io = ionosphere(hour, fof2_mhz, h_km)
    f = freq_khz / 1000.0
    if f <= io["foF2"]:
        return 0.0
    return 2.0 * io["h"] * math.sqrt((f / io["foF2"]) ** 2 - 1.0)


def solar_zenith_cos(hour, lat_deg=37.0, declination_deg=0.0):
    """太阳天顶角余弦的粗略估计（用于吸收指数）。仅按时角与纬度，
    不含日期与经度修正 —— 待确认。"""
    ha = math.radians(15.0 * (hour - 12.0))
    lat = math.radians(lat_deg)
    dec = math.radians(declination_deg)
    c = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ha)
    return max(c, 0.0)


def absorption_db(freq_khz, d_km, hour=12, hops=1, lat_deg=37.0,
                  r12=SUNSPOT_R12, h_km=None, fof2_mhz=None):
    """D 层非偏移吸收（dB，全路径）。

    P.533 简化式：La = 677.2·sec(i)·I / [(f+fH)^1.98 + 10.2]，每跳计一次。
    i 为 110 km 处的入射角，I 为吸收指数。夜间 I 趋近 0（D 层消失）。
    """
    io = ionosphere(hour, fof2_mhz, h_km)
    f = freq_khz / 1000.0
    # D 层高度取 110 km
    i_ang = incidence_angle(d_km, 110.0, hops)
    sec_i = 1.0 / max(math.cos(i_ang), 1e-6)
    chi_cos = solar_zenith_cos(hour, lat_deg)
    absorption_index = (1.0 + 0.0037 * r12) * (chi_cos ** 1.3)
    per_hop = 677.2 * sec_i * absorption_index / ((f + GYRO_FREQ_MHZ) ** 1.98 + 10.2)
    return per_hop * hops


def slant_range_km(d_km, h_km, hops=1):
    """天波斜距（km）：每跳两段斜边之和。"""
    dh = d_km / max(hops, 1)
    theta = dh / (2.0 * RE_KM)
    # 余弦定理求一段斜边
    r = math.sqrt(RE_KM ** 2 + (RE_KM + h_km) ** 2
                  - 2.0 * RE_KM * (RE_KM + h_km) * math.cos(theta))
    return 2.0 * r * hops


def path_loss(d_m, freq_khz, hour=12, hops=None, lat_deg=37.0,
              fof2_mhz=None, h_km=None, r12=SUNSPOT_R12):
    """天波基本传输损耗（dB）。

    返回 (Lb, 明细 dict)。不可用时 Lb 返回一个很大的值，并在明细的
    `reason` 里说明原因（低于跳距 / 高于 MUF）。
    """
    d_km = d_m / 1000.0
    io = ionosphere(hour, fof2_mhz, h_km)
    f = freq_khz / 1000.0
    det = {"d_km": d_km, "foF2": io["foF2"], "h_km": io["h"], "f_mhz": f}

    if d_km < 1e-6:
        return 1e9, dict(det, reason="距离为零")

    if hops is None:
        # 单跳最大地面距离（切线入射），按需增加跳数
        max_hop = 2.0 * RE_KM * math.acos(RE_KM / (RE_KM + io["h"]))
        hops = max(1, int(math.ceil(d_km / max_hop)))
    det["hops"] = hops

    muf = basic_muf_mhz(d_km, hour, hops, io["foF2"], io["h"])
    det["MUF"] = muf
    if f > muf:
        return 1e9, dict(det, reason="高于基本 MUF，电波穿透电离层")

    d_skip = skip_distance_km(freq_khz, hour, io["foF2"], io["h"])
    det["d_skip"] = d_skip
    if hops == 1 and d_km < d_skip:
        return 1e9, dict(det, reason="落在跳距以内（静区）")

    slant = slant_range_km(d_km, io["h"], hops)
    det["slant_km"] = slant
    lbfs = 32.44 + 20.0 * math.log10(f) + 20.0 * math.log10(slant)
    la = absorption_db(freq_khz, d_km, hour, hops, lat_deg, r12, io["h"], io["foF2"])
    lg = GROUND_REFLECT_DB * (hops - 1)
    det.update({"Lbfs": lbfs, "La": la, "Lg": lg})
    return lbfs + la + lg, det


def silent_zone(freq_khz, ground_wave_range_km, hour=12,
                fof2_mhz=None, h_km=None):
    """静区环带：地波作用距离之外、跳距之内的区域。

    返回 (内半径 km, 外半径 km)；若地波作用距离已覆盖到跳距，返回 None。
    """
    d_skip = skip_distance_km(freq_khz, hour, fof2_mhz, h_km)
    if d_skip <= ground_wave_range_km:
        return None
    return ground_wave_range_km, d_skip


def _self_test():
    print("=" * 70)
    print("P.533 天波自检")
    print("=" * 70)

    print("\n[1] 入射角随距离增大（日间 foF2=7.5 MHz, h'=300 km）")
    for dkm in (100, 300, 600, 1000, 2000, 3000):
        phi = incidence_angle(dkm, 300.0)
        print("    d=%4d km  φ=%5.1f°  sec φ=%5.2f  基本 MUF=%5.2f MHz"
              % (dkm, math.degrees(phi), 1 / math.cos(phi),
                 basic_muf_mhz(dkm, 12)))

    print("\n[2] 跳距：f ≤ foF2 无跳距；f 越高跳距越远")
    prev, mono = -1, True
    for fk in (4000, 7000, 7500, 9000, 12000, 15000, 20000):
        ds = skip_distance_km(fk, 12)
        dsf = skip_distance_flat_km(fk, 12)
        if ds < prev:
            mono = False
        prev = ds
        print("    f=%5.1f MHz  跳距(含曲率)=%8.1f km   平面近似=%8.1f km"
              % (fk / 1000.0, ds, dsf))
    print("    随频率单调不减：%s" % ("✓" if mono else "✗"))
    print("    注：平面近似在远距离明显偏大，曲率不可忽略")

    print("\n[3] 静区（地波作用距离设为 80 km，日间）")
    for fk in (5000, 9000, 12000, 15000):
        sz = silent_zone(fk, 80.0, 12)
        print("    f=%5.1f MHz  %s" % (fk / 1000.0,
              "无静区（地波已覆盖到跳距）" if sz is None
              else "静区 %.0f–%.0f km（环带宽 %.0f km）" % (sz[0], sz[1], sz[1] - sz[0])))

    print("\n[4] 昼夜差异（f=7 MHz）")
    for hour, name in ((12, "日间"), (2, "夜间")):
        io = ionosphere(hour)
        ds = skip_distance_km(7000, hour)
        la = absorption_db(7000, 1000.0, hour)
        print("    %s foF2=%.1f MHz  跳距=%.0f km  1000 km 路径吸收=%.1f dB"
              % (name, io["foF2"], ds, la))
    print("    夜间 D 层消失、吸收趋零，但 foF2 降低使可用频率上限下降 —— 与实际一致")

    print("\n[5] 1000 km 天波链路损耗随频率")
    print("    %8s %8s %9s %8s %8s  %s" % ("f MHz", "跳数", "斜距km", "Lbfs", "吸收", "Lb"))
    for fk in (3000, 5000, 7000, 10000, 14000):
        lb, det = path_loss(1000000.0, fk, 12)
        if lb > 1e8:
            print("    %8.1f  %s" % (fk / 1000.0, det["reason"]))
        else:
            print("    %8.1f %8d %9.0f %8.1f %8.1f  %8.1f"
                  % (fk / 1000.0, det["hops"], det["slant_km"],
                     det["Lbfs"], det["La"], lb))

    print("\n[6] 本项目 120 km 尺度：天波是否可用")
    for fk in (3000, 5000, 7000, 9000, 12000):
        lb, det = path_loss(120000.0, fk, 12)
        print("    f=%5.1f MHz  %s"
              % (fk / 1000.0,
                 det.get("reason", "可用，Lb=%.1f dB" % lb)))
    print("    结论：f ≤ foF2 时垂直入射即可反射（NVIS），120 km 上可用；")
    print("          f > foF2 时 120 km 落在跳距以内，天波打不到 —— 要靠地波。")
    print("          这与「短波近距离通联靠地波/NVIS」的编成设计一致。")

    print("\n⚠ 电离层参数全部为假定值（foF2 / h' / R12），见文件头。")
    print("   跳距与静区的**形态**可用，**绝对半径**须待实测订正。")
    print("=" * 70)


if __name__ == "__main__":
    _self_test()
