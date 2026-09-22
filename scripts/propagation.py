"""传播与链路预算 —— 门面层。

**第 2 周已按 `CLAUDE.md` 的要求把第 1 周的占位实现换成真实 ITU-R 模型。**
选型依据见 `docs/design/05_移动电台部署规划算法方案.md` 第 6.8 节：

    超短波点对点   ITU-R P.1812   -> prop/p1812.py
    短波地波       ITU-R P.368    -> prop/p368.py
    短波天波       ITU-R P.533    -> prop/p533.py
    无线电噪声     ITU-R P.372    -> prop/p372.py

**本文件只做接口适配，不含物理模型。** 每个模型实现到什么程度、
哪几节没做，写在各自模块的文件头，调用前请先读。

对外接口与占位实现完全一致（`CLAUDE.md` 要求「替换时调用方代码不应改动」）：

    fspl_db / knife_edge_loss_db / landcover_loss_db
    vuhf_path_loss / hf_ground_wave_loss / hf_nvis_loss / hf_path_loss
    noise_floor_dbm / link_budget / margin_to_state / REQUIRED_SNR_DB

已知的口径问题（待确认，见各模块文件头）：
  1. P.368 的绝对定标未与官方曲线核对，当前只可用于相对比较；
  2. P.533 的电离层参数（foF2 / 虚高 / R12）是假定的典型值；
  3. P.372 未含大气噪声，短波低端夜间偏乐观；
  4. 本模块 ΔN=45（P.1812 中纬度典型值，k≈1.40），而 terrain.los_clearance
     的视域几何用 k=4/3，两者不同源。
"""
import math

from terrain import haversine_m, los_clearance
from prop import p1812, p368, p533, p372

C = 299792458.0

# 地形剖面采样：间距 500 m，点数限制在 [16, 96]
PROFILE_SPACING_M = 500.0
PROFILE_MIN_PTS = 16
PROFILE_MAX_PTS = 96


def fspl_db(freq_khz, dist_m):
    """自由空间基本传输损耗。"""
    if dist_m < 1.0:
        return 0.0
    return 32.44 + 20 * math.log10(freq_khz / 1000.0) + 20 * math.log10(dist_m / 1000.0)


def knife_edge_loss_db(clearance_m, freq_khz, d1_m, d2_m):
    """单刃绕射损耗（P.526 J(ν)）。clearance<0 表示被遮挡。

    保留此函数是为了接口兼容；P.1812 路径内部用的是 Delta-Bullington，
    不再单独调用本函数。
    """
    if d1_m <= 0 or d2_m <= 0:
        return 0.0
    lam = C / (freq_khz * 1000.0)
    v = -clearance_m * math.sqrt(2.0 / lam * (1.0 / d1_m + 1.0 / d2_m))
    return p1812.j_nu(v)


def landcover_loss_db(lc, freq_khz):
    """地物损耗。接口兼容用；改为 P.1812 §4.7 的代表性地物高度模型，
    按 2 m 接收高度给出单端值。"""
    return p1812.clutter_loss(2.0, freq_khz / 1e6, lc)


def _profile(terrain, a, b):
    """取两点间地形剖面，返回 ([(距离m, 高程m), ...], 总距离m)。"""
    d = haversine_m(a[0], a[1], b[0], b[1])
    n = int(d / PROFILE_SPACING_M)
    n = max(PROFILE_MIN_PTS, min(PROFILE_MAX_PTS, n))
    return terrain.profile(a[0], a[1], b[0], b[1], n), d


def vuhf_path_loss(terrain, a, b, freq_khz, ha, hb):
    """超短波路径损耗 —— ITU-R P.1812（中值、陆地）。

    返回 (损耗dB, 是否通视, 最小余隙m, 距离m)，与占位实现同签名。
    """
    prof, d = _profile(terrain, a, b)
    if d < 1.0:
        return 0.0, True, 999.0, d
    lb, det = p1812.basic_loss(prof, ha, hb, freq_khz / 1e6,
                               terrain.landcover(a[0], a[1]),
                               terrain.landcover(b[0], b[1]))
    # 余隙按 P.1812 同一等效地球半径重算，避免与视域几何用不同的 k 值
    ae_m = det["ae"] * 1000.0
    e1 = prof[0][1] + ha
    e2 = prof[-1][1] + hb
    worst = 1e9
    for di, zi in prof[1:-1]:
        bulge = di * (d - di) / (2.0 * ae_m)
        sight = e1 + (e2 - e1) * di / d
        worst = min(worst, sight - (zi + bulge))
    if worst > 1e8:
        worst = 999.0
    return lb, det["los"], worst, d


def hf_ground_wave_loss(freq_khz, dist_m, lc="耕地"):
    """短波地波路径损耗 —— ITU-R P.368（Sommerfeld-Norton 重建）。"""
    lb, _ = p368.path_loss(dist_m, freq_khz, lc)
    return lb


def hf_nvis_loss(freq_khz, dist_m, hour=12):
    """短波近垂直入射天波（NVIS）路径损耗 —— ITU-R P.533。

    f 高于 foF2 时无法反射，返回一个很大的值（与占位实现的语义一致）。
    """
    lb, det = p533.path_loss(dist_m, freq_khz, hour)
    if lb > 1e8:
        return 300.0
    return lb


def hf_path_loss(terrain, a, b, freq_khz, antenna_pattern="OMNI", hour=12):
    """短波路径损耗：地波与天波取较小者（较小损耗即实际主导的模式）。

    返回 (损耗dB, 是否通视, 最小余隙m, 距离m)。短波不做通视判断，
    第二、三个返回值固定为 (True, 0.0)，与占位实现一致。
    """
    d = haversine_m(a[0], a[1], b[0], b[1])
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    gw = hf_ground_wave_loss(freq_khz, d, terrain.landcover(*mid))
    if antenna_pattern == "NVIS":
        sw = hf_nvis_loss(freq_khz, d, hour)
        return min(gw, sw), True, 0.0, d
    return gw, True, 0.0, d


def noise_floor_dbm(freq_khz, bandwidth_khz, ext_noise_fig_db=None, lc=None):
    """接收机噪声底 —— ITU-R P.372。

    `ext_noise_fig_db` 显式给出时直接采用（兼容旧调用）；
    否则按地表覆盖分类推人为噪声环境，缺省为 rural。
    """
    if ext_noise_fig_db is not None:
        return -174.0 + 10 * math.log10(bandwidth_khz * 1000.0) + ext_noise_fig_db
    env = p372.LC_TO_ENV.get(lc, "rural")
    return p372.noise_floor_dbm(freq_khz, bandwidth_khz, env)


REQUIRED_SNR_DB = {"话音": 10.0, "数据": 15.0, "短消息": 8.0}


def link_budget(tx_power_dbm, gt_dbi, gr_dbi, path_loss_db,
                freq_khz, bandwidth_khz, service="话音", rx_sens_dbm=None):
    """返回 (接收功率dBm, 信噪比dB, 相对解调门限的余量dB)。

    余量以 SNR 为准而非接收灵敏度：灵敏度余量在短距离链路上动辄 60-70 dB，
    无法区分链路优劣；SNR 余量才与误码率、链路状态直接相关。
    """
    rx = tx_power_dbm + gt_dbi + gr_dbi - path_loss_db
    n = noise_floor_dbm(freq_khz, bandwidth_khz)
    snr = rx - n
    margin = snr - REQUIRED_SNR_DB.get(service, 10.0)
    if rx_sens_dbm is not None and rx < rx_sens_dbm:
        margin = min(margin, rx - rx_sens_dbm)      # 低于灵敏度直接判不可用
    return rx, snr, margin


def margin_to_state(margin_db):
    if margin_db >= 20:  return "EXCELLENT"
    if margin_db >= 10:  return "GOOD"
    if margin_db >= 3:   return "WARNING"
    return "FAULT"
