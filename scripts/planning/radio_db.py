"""从任务 06 交付的 CSV 构建无线电参数（06 喂 05 的接入点）。

device_model.csv 提供：device_class(频段) / tx_power_max_dbm / rx_sensitivity_dbm /
bandwidth_khz / service_type / antenna_type_default(天线名)。
antenna_model.csv 提供：gain_dbi / pattern_type(NVIS|OMNI) / height_range_m(挂高)。

设计文档 2.4 第 3 条原称「真实设备型号未并入」，任务 06 交付后此缺口已闭合：
本模块就是把 06 的真实参数接入 05 的链路预算。
"""
from __future__ import annotations

import csv
import os
from typing import Dict, List, Optional

from .model import RadioProfile, parse_height_range

# 频段典型默认值（天线匹配失败时兜底，与设计文档 B1 典型值表一致）
_BAND_DEFAULT = {
    "HF":   dict(freq_khz=5000.0,  bandwidth_khz=3.0,  tx_gain_dbi=-2.0, rx_gain_dbi=-2.0, antenna_height_m=3.0, pattern="OMNI"),
    "VUHF": dict(freq_khz=400000.0, bandwidth_khz=25.0, tx_gain_dbi=2.0,  rx_gain_dbi=2.0,  antenna_height_m=3.0, pattern="OMNI"),
}


def _to_float(s: str, default: float = 0.0) -> float:
    s = (s or "").strip()
    if not s:
        return default
    try:
        return float(s)
    except ValueError:
        return default


def _service_of(service_type: str) -> str:
    """voice;data -> 话音（优先话音）；data -> 数据；msg -> 短消息。"""
    t = (service_type or "").lower()
    if "voice" in t or "话音" in t:
        return "话音"
    if "data" in t or "数据" in t:
        return "数据"
    if "msg" in t or "短消息" in t:
        return "短消息"
    return "话音"


def load_device_db(path: str) -> Dict[str, dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    return {r["model_id"]: r for r in rows}


def load_antenna_db(path: str) -> Dict[str, dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    db = {r["antenna_id"]: r for r in rows}
    # 备用：天线名 -> 行，便于按 device.antenna_type_default 名称匹配
    by_name = {}
    for r in rows:
        by_name.setdefault(r["antenna_name"], r)
    db["__by_name__"] = by_name
    return db


def match_antenna(antenna_db: Dict[str, dict], name: str) -> Optional[dict]:
    """按天线名称匹配天线行：精确 -> 首 token 子串（如 'OE-505 3m whip' 匹配 'OE-505'）。"""
    if not name:
        return None
    name = name.strip()
    by_name = antenna_db.get("__by_name__", {})
    if name in by_name:
        return by_name[name]
    token = name.split()[0].lower() if name.split() else ""
    if token:
        for an, row in by_name.items():
            if token in an.lower():
                return row
    return None


def build_profile(device_row: dict,
                  antenna_row: Optional[dict] = None,
                  freq_khz: Optional[float] = None,
                  service: Optional[str] = None) -> RadioProfile:
    """由设备行(+可选天线行)构造 RadioProfile。"""
    band = (device_row.get("device_class") or "VUHF").strip().upper()
    if band not in _BAND_DEFAULT:
        band = "VUHF"
    d = _BAND_DEFAULT[band]

    freq = freq_khz if freq_khz else d["freq_khz"]
    bandwidth = _to_float(device_row.get("bandwidth_khz"), d["bandwidth_khz"])
    tx = _to_float(device_row.get("tx_power_max_dbm"), 0.0)
    rxsens = _to_float(device_row.get("rx_sensitivity_dbm"), -110.0)
    svc = service or _service_of(device_row.get("service_type", ""))

    if antenna_row:
        gain = _to_float(antenna_row.get("gain_dbi"), d["tx_gain_dbi"])
        pat = (antenna_row.get("pattern_type") or d["pattern"]).strip().upper()
        height = parse_height_range(antenna_row.get("height_range_m"))
        height = height if height is not None else d["antenna_height_m"]
    else:
        gain = d["tx_gain_dbi"]
        pat = d["pattern"]
        height = d["antenna_height_m"]

    # HF 仅区分 NVIS（天波）与其余（地波 OMNI）；VUHF 不走 hf_path_loss，pattern 恒 OMNI
    pattern = "NVIS" if pat == "NVIS" else "OMNI"
    if band != "HF":
        pattern = "OMNI"

    return RadioProfile(
        band=band,
        freq_khz=freq,
        bandwidth_khz=bandwidth,
        tx_power_dbm=tx,
        rx_sensitivity_dbm=rxsens,
        tx_gain_dbi=gain,
        rx_gain_dbi=gain,
        service=svc,
        antenna_pattern=pattern,
        antenna_height_m=height,
    )


def profile_for_device(device_db: Dict[str, dict],
                       antenna_db: Dict[str, dict],
                       model_id: str,
                       freq_khz: Optional[float] = None,
                       service: Optional[str] = None) -> Optional[RadioProfile]:
    """按 model_id 取设备并匹配其默认天线，构造 RadioProfile。"""
    dev = device_db.get(model_id)
    if not dev:
        return None
    ant_name = dev.get("antenna_type_default", "")
    ant = match_antenna(antenna_db, ant_name)
    return build_profile(dev, ant, freq_khz=freq_khz, service=service)


def default_profile_for_band(band: str) -> RadioProfile:
    """无具体设备型号时（如候选点默认挂同一型号），按频段典型值兜底。"""
    d = _BAND_DEFAULT.get(band.upper(), _BAND_DEFAULT["VUHF"])
    return RadioProfile(
        band=band.upper(),
        freq_khz=d["freq_khz"],
        bandwidth_khz=d["bandwidth_khz"],
        tx_power_dbm=40.0,
        rx_sensitivity_dbm=-110.0,
        tx_gain_dbi=d["tx_gain_dbi"],
        rx_gain_dbi=d["rx_gain_dbi"],
        service="话音",
        antenna_pattern=d["pattern"],
        antenna_height_m=d["antenna_height_m"],
    )


# 06 交付物路径解析（按序查找第一个存在的）：
#   1. 环境变量 RADIO_DEVICE_CSV / RADIO_ANTENNA_CSV
#   2. 交付包布局：<根>/data/models/device_model_filled.csv 等
#   3. 开发布局：<根>/06_taskA/device_model_filled.csv 等
#   4. 仓库合成库：<根>/data/synthetic/nodes/device_models_v1.csv 等
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))


def _resolve_csv(env_key: str, rel_candidates: List[str]) -> str:
    env = os.environ.get(env_key, "").strip()
    if env and os.path.isfile(env):
        return env
    for rel in rel_candidates:
        p = os.path.join(_ROOT, rel)
        if os.path.isfile(p):
            return p
    raise FileNotFoundError(
        f"找不到 06 设备/天线表（{env_key} 未设置且以下路径均不存在）：\n"
        + "\n".join("  - " + os.path.join(_ROOT, r) for r in rel_candidates)
    )


def _default_device_csv() -> str:
    return _resolve_csv("RADIO_DEVICE_CSV", [
        "data/models/device_model_filled.csv",
        "06_taskA/device_model_filled.csv",
        "data/synthetic/nodes/device_models_v1.csv",
    ])


def _default_antenna_csv() -> str:
    return _resolve_csv("RADIO_ANTENNA_CSV", [
        "data/models/antenna_model_filled.csv",
        "06_taskB/antenna_model_filled.csv",
        "data/synthetic/nodes/antenna_models_v1.csv",
    ])


def load_default_radio_db():
    """加载 06 默认交付物，返回 (device_db, antenna_db)。"""
    return load_device_db(_default_device_csv()), load_antenna_db(_default_antenna_csv())
