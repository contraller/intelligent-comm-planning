"""传播与链路预算 —— 第 1 周占位实现。

用途仅限于生成有区分度的测试数据。真实模型在第 2 周替换：
  超短波  ITU-R P.526 刃形绕射 + P.1812 / Longley-Rice
  短波    ITU-R P.533 天波 + P.368 地波，含跳距与静区结构
接口保持不变（path_loss / link_budget），替换时调用方不改。
"""
import math
from terrain import haversine_m, los_clearance

C = 299792458.0


def fspl_db(freq_khz, dist_m):
    if dist_m < 1.0:
        return 0.0
    return 32.44 + 20 * math.log10(freq_khz / 1000.0) + 20 * math.log10(dist_m / 1000.0)


def knife_edge_loss_db(clearance_m, freq_khz, d1_m, d2_m):
    """单刃绕射损耗（ITU-R P.526 近似）。clearance<0 表示被遮挡。"""
    if d1_m <= 0 or d2_m <= 0:
        return 0.0
    lam = C / (freq_khz * 1000.0)
    v = -clearance_m * math.sqrt(2.0 / lam * (1.0 / d1_m + 1.0 / d2_m))
    if v <= -0.78:
        return 0.0
    return 6.9 + 20 * math.log10(math.sqrt((v - 0.1) ** 2 + 1.0) + v - 0.1)


def landcover_loss_db(lc, freq_khz):
    f = freq_khz / 1000.0
    base = {"林地": 8.0, "建成区": 12.0, "山地岩石": 3.0,
            "草地": 1.0, "耕地": 0.5, "裸地": 0.5, "水域": 0.0}.get(lc, 1.0)
    return base * (1.0 + 0.004 * f)


def vuhf_path_loss(terrain, a, b, freq_khz, ha, hb):
    """超短波：自由空间 + 地形绕射 + 地物损耗。"""
    d = haversine_m(a[0], a[1], b[0], b[1])
    ok, clr, at = los_clearance(terrain, a[0], a[1], ha, b[0], b[1], hb)
    loss = fspl_db(freq_khz, d)
    if not ok:
        loss += knife_edge_loss_db(clr, freq_khz, max(at, 1.0), max(d - at, 1.0))
    # 杂波损耗算在收发两端（地物遮蔽是终端局部效应），各计一半
    loss += 0.5 * landcover_loss_db(terrain.landcover(a[0], a[1]), freq_khz)
    loss += 0.5 * landcover_loss_db(terrain.landcover(b[0], b[1]), freq_khz)
    return loss, ok, clr, d


# —— 短波 ——
# 地波：随频率升高衰减加剧，随距离快速衰减
# 天波：NVIS 天线覆盖 0-300 km（高仰角，无静区）；鞭状/水平天线走低仰角，
#       存在静区，第一跳落区约 300-800 km（本区域 120 km 内主要靠地波与 NVIS）

def hf_ground_wave_loss(freq_khz, dist_m, lc="耕地"):
    """短波地波。在 ITU-R P.368 平均地质曲线（5 MHz / 1 kW）上标定：
    10 km≈91 dB, 50 km≈121 dB, 100 km≈141 dB, 200 km≈166 dB。
    形式为 自由空间损耗 + 地表附加衰减，附加项随频率与距离增长。"""
    d_km = max(dist_m / 1000.0, 0.1)
    f_mhz = max(freq_khz / 1000.0, 0.1)
    # 地质导电率修正：数值越大地面导电性越好、附加衰减越小
    sigma = {"水域": 2.5, "耕地": 1.0, "草地": 1.0,
             "林地": 0.85, "建成区": 0.75, "山地岩石": 0.70}.get(lc, 1.0)
    excess = 10.6 * (f_mhz / 5.0) ** 0.7 * d_km ** 0.366 / sigma
    return fspl_db(freq_khz, dist_m) + excess


def hf_nvis_loss(freq_khz, dist_m, hour=12):
    """NVIS 近垂直入射天波：0-300 km 较均匀覆盖，需 f 低于 foF2 反射上限。"""
    d_km = max(dist_m / 1000.0, 1.0)
    f_mhz = freq_khz / 1000.0
    f_max = 7.5 if 8 <= hour <= 18 else 4.5           # 昼夜 NVIS 可用频率上限
    if f_mhz > f_max:
        return 200.0                                   # 穿透电离层，不可用
    virt_h = 300.0
    path = 2.0 * math.hypot(virt_h, d_km / 2.0)
    return 32.44 + 20 * math.log10(f_mhz) + 20 * math.log10(path) + 12.0


def hf_path_loss(terrain, a, b, freq_khz, antenna_pattern="OMNI", hour=12):
    d = haversine_m(a[0], a[1], b[0], b[1])
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    lc = terrain.landcover(*mid)
    gw = hf_ground_wave_loss(freq_khz, d, lc)
    if antenna_pattern == "NVIS":
        sw = hf_nvis_loss(freq_khz, d, hour)
        return min(gw, sw), True, 0.0, d
    return gw, True, 0.0, d


def noise_floor_dbm(freq_khz, bandwidth_khz, ext_noise_fig_db=None):
    """接收机噪声底。短波由外部噪声（大气+人为）主导，超短波由接收机噪声主导。"""
    f_mhz = freq_khz / 1000.0
    if ext_noise_fig_db is None:
        # ITU-R P.372 农村外部噪声系数随频率下降，30 MHz 以上趋近接收机噪声
        ext_noise_fig_db = 40.0 if f_mhz < 30 else 8.0
    return -174.0 + 10 * math.log10(bandwidth_khz * 1000.0) + ext_noise_fig_db


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
