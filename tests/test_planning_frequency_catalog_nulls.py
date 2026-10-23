"""规划目录保留人工频点未知参数，不影响设备维护契约。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from app import frontend_integration as integration


@pytest.mark.parametrize("missing", [None, "", "  "])
def test_missing_frequency_parameters_remain_unknown(monkeypatch, missing):
    row = {
        "freq_id": "FQ-TEST", "device_class": "HF", "center_freq_khz": "7000",
        "bandwidth_khz": missing, "channel_no": "0", "is_available": "true",
        "occupied_by": "", "reuse_min_distance_m": missing,
        "adjacent_guard_khz": missing, "note": "人工构造，非正式频率许可",
    }
    monkeypatch.setattr(integration, "_rows", lambda kind: [row])
    monkeypatch.setattr(integration, "resource_revision", lambda: "resource-0123456789abcdef")
    result = integration.planning_frequency_catalog()["data"]
    item = result["frequency_resources"][0]
    assert item["center_freq_khz"] == 7000
    assert item["bandwidth_khz"] is None
    assert item["reuse_min_distance_m"] is None
    assert item["adjacent_guard_khz"] is None
    assert item["channel_no"] == 0
    assert item["is_available"] is True
    assert result["items"][0]["min_khz"] == 7000
    assert row["bandwidth_khz"] is missing


def test_explicit_zero_guard_and_nonzero_bandwidth_are_preserved(monkeypatch):
    row = {
        "freq_id": "FQ-ZERO", "device_class": "VUHF", "center_freq_khz": "500000",
        "bandwidth_khz": "25", "channel_no": "0", "is_available": "false",
        "occupied_by": "", "reuse_min_distance_m": "0", "adjacent_guard_khz": "0",
        "note": "构造验证",
    }
    monkeypatch.setattr(integration, "_rows", lambda kind: [row])
    monkeypatch.setattr(integration, "resource_revision", lambda: "resource-0123456789abcdef")
    result = integration.planning_frequency_catalog()["data"]
    item = result["frequency_resources"][0]
    assert item["bandwidth_khz"] == 25
    assert item["reuse_min_distance_m"] == 0
    assert item["adjacent_guard_khz"] == 0
    assert item["channel_no"] == 0
    assert item["is_available"] is False
    assert result["items"] == []
