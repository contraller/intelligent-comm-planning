"""新增任务采用当前DEM声明范围，不能静默替换已保存任务。"""
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import frontend_integration as frontend
from app.resource_dataset_service import ResourceDatasetError


def test_current_preset_uses_planning_extent_not_node_envelope(monkeypatch):
    metadata = json.loads((ROOT / "data/raw/dem/dem_current.json").read_text(encoding="utf-8"))
    monkeypatch.setattr(frontend, "_rows", lambda name: [
        {"node_id": "A", "lon": "114", "lat": "37"},
        {"node_id": "B", "lon": "114.01", "lat": "37.01"},
        {"node_id": "C", "lon": "114.02", "lat": "37.02"}])
    monkeypatch.setattr(frontend, "resource_revision", lambda: "frozen-test-version")
    presets = frontend.planning_preset_catalog()["data"]["items"]
    assert all(row["defaults"]["bbox"] == metadata["planning_bbox"] for row in presets)
    assert all(row["defaults"]["bbox"] != [114, 37, 114.02, 37.02] for row in presets)
    assert all(row["defaults"]["stationIds"] == ["A", "B", "C"] for row in presets)


@pytest.mark.parametrize("planning,extent", [
    (None, [0, 0, 2, 2]), ([0, 0, 0, 2], [0, 0, 2, 2]),
    ([0, 0, 3, 2], [0, 0, 2, 2]), ([False, 0, 1, 1], [0, 0, 2, 2]),
    ([0, 0, 1, 1], None), ([0, 0, 1, 1], [0, 0, float("inf"), 2]),
])
def test_missing_or_invalid_dem_bounds_do_not_fallback(monkeypatch, tmp_path, planning, extent):
    monkeypatch.setattr(frontend, "REPO_ROOT", tmp_path)
    path = tmp_path / "data/raw/dem/dem_current.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"planning_bbox": planning, "bbox": extent}), encoding="utf-8")
    with pytest.raises(ResourceDatasetError, match="DEM规划范围"):
        frontend._planning_bounds()


def test_missing_file_does_not_create_or_replace_it(monkeypatch, tmp_path):
    monkeypatch.setattr(frontend, "REPO_ROOT", tmp_path)
    with pytest.raises(ResourceDatasetError):
        frontend._planning_bounds()
    assert not (tmp_path / "data/raw/dem/dem_current.json").exists()
