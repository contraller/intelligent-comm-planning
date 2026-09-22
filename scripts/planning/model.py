"""规划领域模型：无线电参数、站点、链路余量。

纯标准库。所有传播/地形计算委托给 scripts/terrain.py 与 scripts/propagation.py，
替换占位传播模型时本文件无需改动（见 05 方案第 2.4 条 / 第 6 节第 8 问）。

约定：
  - 频段 band 取值 'HF' / 'VUHF'（与 device_model.csv 的 device_class 对齐）。
  - HF 走 propagation.hf_path_loss（地波 + NVIS），VUHF 走 propagation.vuhf_path_loss。
  - 链路余量取双向最小值（链路须双向可用）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from terrain import haversine_m
from propagation import (
    vuhf_path_loss,
    hf_path_loss,
    link_budget,
)


def parse_height_range(s: str) -> Optional[float]:
    """解析天线挂高区间 '2-3' / '3' / '' -> 代表值（区间取中点）。"""
    s = (s or "").strip()
    if not s:
        return None
    if "-" in s:
        a, b = s.split("-", 1)
        try:
            return (float(a) + float(b)) / 2.0
        except ValueError:
            return None
    try:
        return float(s)
    except ValueError:
        return None


@dataclass
class RadioProfile:
    """单端电台的无线电参数。链路两端各持一份。"""

    band: str                       # 'HF' / 'VUHF'
    freq_khz: float                 # 工作频率
    bandwidth_khz: float            # 带宽（决定噪声底）
    tx_power_dbm: float             # 发射功率（最大档）
    rx_sensitivity_dbm: float       # 接收灵敏度
    tx_gain_dbi: float              # 发射天线增益
    rx_gain_dbi: float              # 接收天线增益
    service: str = "话音"            # 业务类型 -> 解调 SNR 门限（话音10/数据15/短消息8）
    antenna_pattern: str = "OMNI"   # HF 专用：'NVIS' 或 'OMNI'（地波）
    antenna_height_m: float = 3.0   # VUHF 专用：天线挂高（地波路径损耗用）

    @property
    def is_hf(self) -> bool:
        return self.band.upper().startswith("H")


@dataclass
class Site:
    """规划要素点：固定站 / 任务节点 / 候选部署点。"""

    site_id: str
    lon: float
    lat: float
    band: str                       # 'HF' / 'VUHF'
    profile: RadioProfile
    kind: str = "candidate"          # 'fixed' / 'task' / 'candidate'
    meta: dict = field(default_factory=dict)

    def point(self):
        return (self.lon, self.lat)


def _path_loss(terrain, a: Site, b: Site, hour: int):
    """按频段选择传播模型，返回路径损耗(dB)。a 为发射端。"""
    if a.profile.is_hf:
        loss, _, _, _ = hf_path_loss(
            terrain, a.point(), b.point(),
            a.profile.freq_khz, a.profile.antenna_pattern, hour,
        )
        return loss
    loss, _, _, _ = vuhf_path_loss(
        terrain, a.point(), b.point(),
        a.profile.freq_khz,
        a.profile.antenna_height_m, b.profile.antenna_height_m,
    )
    return loss


def link_margin(terrain, a: Site, b: Site, hour: int = 12) -> float:
    """链路余量(dB)，取双向最小值（链路须双向可用）。

    M = Pt + Gt + Gr - L - N - SNR_req，与 05 方案 3.2 一致。
    """
    # 方向 a -> b（a 发射）
    loss_ab = _path_loss(terrain, a, b, hour)
    rx_ab, _, m_ab = link_budget(
        a.profile.tx_power_dbm, a.profile.tx_gain_dbi, b.profile.rx_gain_dbi,
        loss_ab, a.profile.freq_khz, a.profile.bandwidth_khz,
        a.profile.service, a.profile.rx_sensitivity_dbm,
    )
    # 方向 b -> a（b 发射）
    loss_ba = _path_loss(terrain, b, a, hour)
    rx_ba, _, m_ba = link_budget(
        b.profile.tx_power_dbm, b.profile.tx_gain_dbi, a.profile.rx_gain_dbi,
        loss_ba, b.profile.freq_khz, b.profile.bandwidth_khz,
        b.profile.service, b.profile.rx_sensitivity_dbm,
    )
    return min(m_ab, m_ba)


def feasible_link(terrain, a: Site, b: Site, m_min: float, hour: int = 12) -> bool:
    """链路余量是否达到门限。"""
    return link_margin(terrain, a, b, hour) >= m_min


def distance_m(a: Site, b: Site) -> float:
    return haversine_m(a.lon, a.lat, b.lon, b.lat)
