"""资源台账查询服务（SR-3 资源管理，供 SR-2 前端设备配置界面使用）。

为什么有这个模块
----------------
合作方 2026-09-28 确认：**调制解调等电台功能由前端完整呈现，不参与算法计算**。
前端要「完整呈现电台功能」，就得有地方取这份型号台账——而此前服务里
没有任何资源类接口，`device_model_id` 只作为规划接口的入参出现。
本模块补上这个缺口。

口径
----
- **`modulation` / `work_mode` / `service_type` / `data_rate_kbps` 是呈现与台账字段，
  规划算法不消费它们**（已全库核对：只有 gen_test_data 写数据时用到）。
  算法实际吃的只有频段范围、功率、灵敏度、带宽、天线增益与挂高。
  接口在 `field_semantics` 里逐字段标出 `used_by_algorithm`，避免日后
  出现「改了工作方式为什么方案没变」的误会。
- 取值枚举由 `enums` 一并返回，前端直接用来渲染下拉与多选，不要自己硬编码。
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
for _p in (REPO_ROOT / "scripts", REPO_ROOT / "scripts" / "planning"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

# 字段语义：算法是否消费。前端据此决定哪些字段只读展示、哪些影响规划结果。
DEVICE_FIELD_SEMANTICS = {
    "model_id": True, "model_name": False, "manufacturer": False,
    "device_class": True, "category": False,
    "freq_min_khz": True, "freq_max_khz": True,
    "tx_power_max_dbm": True, "tx_power_levels_dbm": True,
    "rx_sensitivity_dbm": True, "bandwidth_khz": True,
    "modulation": False, "work_mode": False,
    "service_type": True, "data_rate_kbps": False,
    "antenna_type_default": True, "power_consumption_w": False,
    "constraint_note": False, "source_doc": False,
}
ANTENNA_FIELD_SEMANTICS = {
    "antenna_id": True, "antenna_name": False, "device_class": True,
    "gain_dbi": True, "pattern_type": True,
    "hbeamwidth_deg": False, "vbeamwidth_deg": False,
    # height_range_m 采集值多为天线长度，规划改按平台取挂高区间，不再读它（待办 #18）
    "height_range_m": False, "antenna_length_m": False, "polarization": False,
}
MULTI_VALUE_FIELDS = ("tx_power_levels_dbm", "bandwidth_khz", "modulation",
                      "work_mode", "service_type", "data_rate_kbps")


def _load(rel: str) -> list[dict[str, str]]:
    from datapaths import path as dpath
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _split(v: str) -> list[str]:
    return [x.strip() for x in str(v or "").replace("；", ";").split(";") if x.strip()]


def _enums(rows: list[dict[str, str]], fields) -> dict[str, list[str]]:
    out: dict[str, set] = {f: set() for f in fields}
    for r in rows:
        for f in fields:
            out[f].update(_split(r.get(f, "")))
    return {f: sorted(v) for f, v in out.items() if v}


def _envelope(data: Any, code: int = 0, message: str = "success") -> dict[str, Any]:
    return {"code": code, "message": message, "data": data}


def list_device_models(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /api/v1/resource/device-models`

    可选查询参数：`device_class`（HF / VUHF）、`model_ids`（逗号分隔）。
    """
    payload = payload or {}
    rows = _load("device_model.csv")
    cls = payload.get("device_class")
    if cls:
        rows = [r for r in rows if r.get("device_class") == cls]
    ids = payload.get("model_ids")
    if ids:
        want = set(ids.split(",") if isinstance(ids, str) else ids)
        rows = [r for r in rows if r.get("model_id") in want]
    items = []
    for r in rows:
        item = dict(r)
        for f in MULTI_VALUE_FIELDS:
            if f in item:
                item[f] = _split(item[f])
        items.append(item)
    return _envelope({
        "total": len(items),
        "items": items,
        "enums": _enums(rows, ("device_class", "category", "modulation",
                               "work_mode", "service_type")),
        "field_semantics": [
            {"field": k, "used_by_algorithm": v} for k, v in DEVICE_FIELD_SEMANTICS.items()],
        "note": "modulation / work_mode / data_rate_kbps 为呈现与台账字段，"
                "不参与规划计算；改动它们不会改变规划结果。",
    })


def list_antenna_models(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /api/v1/resource/antenna-models`"""
    payload = payload or {}
    rows = _load("antenna_model.csv")
    cls = payload.get("device_class")
    if cls:
        rows = [r for r in rows if r.get("device_class") == cls]
    return _envelope({
        "total": len(rows),
        "items": [dict(r) for r in rows],
        "enums": _enums(rows, ("device_class", "pattern_type", "polarization")),
        "field_semantics": [
            {"field": k, "used_by_algorithm": v} for k, v in ANTENNA_FIELD_SEMANTICS.items()],
        "note": "倾角（tilt）对全向天线无效；本库 pattern_type 全部为 OMNI / NVIS，"
                "电台参数规划中 tilt_effective 恒为 false。",
    })


def list_frequency_pool(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /api/v1/resource/frequency-pool` —— 频率资源池（SR-4.2.2.2 b 的展示面）。"""
    payload = payload or {}
    rows = _load("frequency_resource.csv")
    cls = payload.get("device_class")
    if cls:
        rows = [r for r in rows if r.get("device_class") == cls]
    avail = [r for r in rows if str(r.get("is_available", "")).lower() == "true"]
    return _envelope({
        "total": len(rows), "available": len(avail),
        "items": [dict(r) for r in rows],
        "by_band": {b: sum(1 for r in avail if r["device_class"] == b)
                    for b in sorted({r["device_class"] for r in rows})},
    })


def radio_param_presets(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """`GET /api/v1/resource/param-presets` —— 三套预选参数配置。

    对应甲方指标「短波/超短波规划预选配置 ≥3 种」（缺口 A3）。
    """
    import radio_params as RP
    return _envelope({"total": len(RP.PRESETS), "items": RP.preset_list()})
