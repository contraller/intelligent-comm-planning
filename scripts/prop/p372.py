"""ITU-R P.372-16：无线电噪声。

用于链路预算的噪声底，替换原先「30 MHz 以下取 40 dB、以上取 8 dB」的两档常数。

实现的部分
----------
- §5 人为噪声中值：Fam = c − d·log10(f_MHz)，按环境类别取 (c, d)
- 银河噪声：Fam = 52.0 − 23.0·log10(f_MHz)
- 噪声底：N = −174 + 10log10(B_Hz) + Fa

**未实现的部分**
-----------------
- 大气噪声（雷暴）逐时逐季的世界分布图（P.372 图 1a–36b）：那是官方图表数据，
  离线不可得，不得凭空编造。短波低端（<5 MHz）夜间实际噪声可能明显高于本模块
  给出的人为噪声值 —— 列为**待确认**。
- 噪声的时间变异（十分位数 Du/Dl）未实现，只给中值。
- 天线方向性对外部噪声的影响未计入（按全向处理）。
"""
import math

# P.372 §5 表 2：人为噪声中值参数 (c, d)，适用 0.3–250 MHz
MAN_MADE = {
    "business":    (76.8, 27.7),
    "residential": (72.5, 27.7),
    "rural":       (67.2, 27.7),
    "quiet_rural": (53.6, 28.6),
}
GALACTIC = (52.0, 23.0)

# 地表覆盖分类 → 人为噪声环境类别（本项目自行确定的映射，待确认）
LC_TO_ENV = {
    "建成区": "business",
    "耕地": "rural",
    "草地": "rural",
    "裸地": "quiet_rural",
    "山地岩石": "quiet_rural",
    "林地": "quiet_rural",
    "水域": "quiet_rural",
}


def fa_man_made(freq_khz, env="rural"):
    """人为噪声系数 Fam（dB，相对 kT0B）。"""
    f_mhz = max(freq_khz / 1000.0, 0.3)
    c, d = MAN_MADE.get(env, MAN_MADE["rural"])
    return c - d * math.log10(f_mhz)


def fa_galactic(freq_khz):
    f_mhz = max(freq_khz / 1000.0, 0.3)
    c, d = GALACTIC
    return c - d * math.log10(f_mhz)


def fa_total(freq_khz, env="rural", rx_noise_fig_db=6.0):
    """总外部噪声系数：人为、银河、接收机三者按功率相加取大。"""
    terms = [fa_man_made(freq_khz, env), fa_galactic(freq_khz), rx_noise_fig_db]
    lin = sum(10.0 ** (t / 10.0) for t in terms)
    return 10.0 * math.log10(lin)


def noise_floor_dbm(freq_khz, bandwidth_khz, env="rural", rx_noise_fig_db=6.0):
    """接收机输入端噪声功率（dBm）。"""
    fa = fa_total(freq_khz, env, rx_noise_fig_db)
    return -174.0 + 10.0 * math.log10(max(bandwidth_khz, 1e-6) * 1000.0) + fa


def _self_test():
    print("=" * 70)
    print("P.372 噪声自检")
    print("=" * 70)
    print("\n[1] 人为噪声 Fam 随频率下降（rural）")
    for f in (2000, 5000, 10000, 30000, 100000, 400000):
        print("    %7.1f MHz  人为 %6.1f dB  银河 %6.1f dB  合计 %6.1f dB"
              % (f / 1000.0, fa_man_made(f), fa_galactic(f), fa_total(f)))
    print("\n[2] 环境类别对比（5 MHz）")
    for env in ("business", "residential", "rural", "quiet_rural"):
        print("    %-12s Fam=%.1f dB" % (env, fa_man_made(5000, env)))
    print("\n[3] 噪声底对照（替换前是两档常数：<30 MHz 取 40 dB，≥30 MHz 取 8 dB）")
    print("    %9s %8s %12s %12s" % ("频率", "带宽", "本实现", "占位实现"))
    for f, bw in ((5000, 3.0), (2000, 3.0), (150000, 25.0), (400000, 25.0)):
        new = noise_floor_dbm(f, bw)
        old_fa = 40.0 if f / 1000.0 < 30 else 8.0
        old = -174.0 + 10 * math.log10(bw * 1000.0) + old_fa
        print("    %7.1fMHz %6.1fkHz %11.1f dBm %11.1f dBm  (差 %+.1f)"
              % (f / 1000.0, bw, new, old, new - old))
    print("\n⚠ 大气噪声（雷暴）未实现，短波低端夜间可能明显偏乐观 —— 待确认")
    print("=" * 70)


if __name__ == "__main__":
    _self_test()
