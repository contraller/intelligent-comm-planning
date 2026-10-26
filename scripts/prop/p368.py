"""ITU-R P.368-9：短波地波传播（10 kHz–30 MHz，垂直极化）。

用于**短波链路可行性判据**在本项目 120 km 尺度上的主导分量，见 05 方案 6.8。

实现的部分
----------
- 平地面 Sommerfeld-Norton 表面波衰减函数 A(p, b)
  （数值距离 p 与地质相位角 b 由复介电常数导出）
- 超出球面地视距后的绕射衰减，复用 P.526-15 §4.2.2.1 一阶项法，
  代入短波地质参数；两段取较大的损耗。
- 地表覆盖分类 → (εr, σ) 的映射表（P.368 附录 1 的典型地质）

**未实现 / 需要注意的部分**
---------------------------
- **本模块是按 Sommerfeld-Norton 理论「重建」P.368 的地波衰减，
  不是对 P.368 官方曲线的数字化。** 与官方曲线的偏差未经逐点核对，
  验收前需要拿 P.368 原始曲线对标 —— 列为**待确认**。
- 混合路径（Millington 法）未实现：路径跨越不同地质时按中点地质取单一值。
  本项目规划区为连续内陆地形，影响有限；跨大水体的路径会有偏差。
- 地面不规则性修正未实现（P.368 假设光滑地球）。

单位：距离 m、频率 kHz（与项目对外口径一致），内部换算为 km/MHz。
"""
import math

from .p1812 import _ldft_single, effective_earth_radius_km

# 地表覆盖分类 → (相对介电常数 εr, 电导率 σ S/m)
# 取自 P.368 附录 1 的典型地质，映射关系由本项目自行确定（待确认）。
GROUND = {
    "水域":     (80.0, 5.0),      # 海水/大型水体
    "耕地":     (15.0, 0.005),    # 湿润农田
    "草地":     (13.0, 0.005),
    "林地":     (13.0, 0.003),
    "建成区":   (5.0,  0.001),    # 城区，干燥、多建筑
    "山地岩石": (10.0, 0.002),    # 岩石
    "裸地":     (7.0,  0.002),    # 干燥土壤
}
DEFAULT_GROUND = (15.0, 0.005)


def ground_constants(lc):
    return GROUND.get(lc, DEFAULT_GROUND)


def norton_attenuation(d_m, freq_khz, eps_r, sigma):
    """平地面表面波衰减因子 A（相对自由空间，0<A≤1）。

    p 为「数值距离」，b 为地质相位角：
        x   = 18000·σ/f_MHz        （即 60σλ）
        ε_c = εr − j·x
        b   = arctan[(εr+1)/x]
        p   = (π·d/λ)·cos(b)/|ε_c|
    Norton 近似：
        A = (2+0.3p)/(2+p+0.6p²) − sin(b)·exp(−5p/8)·√(p/2)
    p→0 时 A→1（理想导体，无额外衰减），p 很大时 A→1/(0.6p)。
    """
    f_mhz = max(freq_khz / 1000.0, 1e-6)
    lam = 299.792458 / f_mhz                 # 波长 m
    x = 18000.0 * sigma / f_mhz
    if x <= 0.0:
        x = 1e-9
    abs_eps = math.hypot(eps_r, x)
    b = math.atan2(eps_r + 1.0, x)
    p = (math.pi * max(d_m, 1.0) / lam) * math.cos(b) / abs_eps

    a = (2.0 + 0.3 * p) / (2.0 + p + 0.6 * p * p)
    a -= math.sin(b) * math.exp(-0.625 * p) * math.sqrt(p / 2.0)
    return max(a, 1e-12)


def fspl_db(freq_khz, d_m):
    if d_m < 1.0:
        return 0.0
    return 32.44 + 20.0 * math.log10(freq_khz / 1000.0) + 20.0 * math.log10(d_m / 1000.0)


def path_loss(d_m, freq_khz, lc="耕地", ht_m=3.0, hr_m=3.0):
    """短波地波基本传输损耗（dB）。

    返回 (Lb, 明细 dict)。取「平地面表面波」与「球面地绕射」中损耗较大者：
    近距离由表面波主导，超出视距后由绕射主导。
    """
    if d_m < 1.0:
        return 0.0, {"d_m": 0.0}
    eps_r, sigma = ground_constants(lc)
    lbfs = fspl_db(freq_khz, d_m)

    a = norton_attenuation(d_m, freq_khz, eps_r, sigma)
    excess_flat = -20.0 * math.log10(a)

    f_ghz = freq_khz / 1e6
    ae = effective_earth_radius_km()
    # 短波天线挂高远小于波长，按贴地处理但保留一个下限避免奇异
    excess_sph = _ldft_single(d_m / 1000.0, max(ht_m, 0.5), max(hr_m, 0.5),
                              ae, f_ghz, eps_r, sigma, pol="v")

    excess = max(excess_flat, excess_sph)
    return lbfs + excess, {"d_m": d_m, "Lbfs": lbfs,
                           "excess": excess, "excess_flat": excess_flat,
                           "excess_sph": excess_sph,
                           "eps_r": eps_r, "sigma": sigma}


def _self_test():
    print("=" * 70)
    print("P.368 地波自检")
    print("=" * 70)

    print("\n[1] 衰减因子的极限与单调性")
    a_ideal = norton_attenuation(10000.0, 5000.0, 80.0, 1e6)   # 近乎理想导体
    print("    理想导体 A=%.4f（应趋近 1）  %s" % (a_ideal, "✓" if a_ideal > 0.9 else "✗"))
    seq = [norton_attenuation(100000.0, 5000.0, e, sg)
           for e, sg in ((80, 5.0), (15, 0.005), (10, 0.002), (5, 0.001))]
    mono1 = all(seq[i] > seq[i + 1] for i in range(len(seq) - 1))
    print("    地质由好到差 A=%s  递减：%s"
          % (" > ".join("%.2e" % a for a in seq), "✓" if mono1 else "✗"))
    seq2 = [norton_attenuation(100000.0, f, 15.0, 0.005)
            for f in (1000, 3000, 10000, 30000)]
    mono2 = all(seq2[i] > seq2[i + 1] for i in range(len(seq2) - 1))
    print("    频率由低到高 A=%s  递减：%s"
          % (" > ".join("%.2e" % a for a in seq2), "✓" if mono2 else "✗"))

    print("\n[2] 5 MHz 平均地质（耕地 εr=15 σ=0.005）随距离")
    print("    %8s %9s %9s %9s %9s" % ("距离", "Lbfs", "平地超额", "球面超额", "Lb"))
    prev = -1e9
    mono = True
    for dkm in (1, 5, 10, 20, 50, 100, 150, 200, 300):
        lb, det = path_loss(dkm * 1000.0, 5000.0)
        if lb < prev:
            mono = False
        prev = lb
        print("    %6d km %8.1f %9.1f %9.1f %9.1f"
              % (dkm, det["Lbfs"], det["excess_flat"], det["excess_sph"], lb))
    print("    随距离单调增：%s" % ("✓" if mono else "✗"))

    print("\n[3] 频率越高地波衰减越快（5 / 10 / 20 MHz @ 100 km）")
    for f in (2000, 5000, 10000, 20000):
        lb, _ = path_loss(100000.0, f)
        print("    %5.1f MHz  Lb=%.1f dB" % (f / 1000.0, lb))

    print("\n[4] 地质越好衰减越小（100 km @ 5 MHz）")
    for lc in ("水域", "耕地", "林地", "山地岩石", "建成区"):
        lb, det = path_loss(100000.0, 5000.0, lc)
        print("    %-8s εr=%4.1f σ=%.4f  Lb=%.1f dB" % (lc, det["eps_r"], det["sigma"], lb))

    print("\n[5] 与被替换的占位实现对照（5 MHz）")
    print("    %8s %12s %12s %8s" % ("距离", "占位实现", "本实现", "差"))
    for dkm, old_v in ((10, 91.0), (50, 121.0), (100, 141.0), (200, 166.0)):
        lb, _ = path_loss(dkm * 1000.0, 5000.0)
        print("    %6d km %12.1f %12.1f %+8.1f" % (dkm, old_v, lb, lb - old_v))
    print("    占位实现那四个数是它自己注释里写的「P.368 锚点」，出处未经核实，")
    print("    此处只作量级对照，两边都不能当验收依据。")

    print("\n⚠ 绝对定标尚未完成（见文件头）：")
    print("    本模块给出的是理论计算值，没有与 P.368 官方曲线逐点核对过。")
    print("    在拿到官方曲线之前，输出只可用于**相对比较与排序**，")
    print("    不可作为绝对场强/损耗对外承诺。")
    print("    另有一个 6 dB 量级的参考面问题待确认：Sommerfeld 衰减因子 A")
    print("    是相对「理想导体平地面」定义的（贴地源有镜像加倍），而本模块以")
    print("    自由空间为参考。此处假定镜像增益已包含在设备库的天线增益里。")
    print("=" * 70)


if __name__ == "__main__":
    _self_test()
