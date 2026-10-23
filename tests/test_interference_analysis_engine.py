"""小冻结样本直接运行既有干扰算法；显式合成地形，不是实测或完整SR4证据。"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import resource_dataset_service as resources
from app.interference_analysis_engine import AnalysisCancelled, AnalysisInputError, FrozenInterferenceEngine, _modules, digest


@pytest.fixture(scope="module")
def frozen_sample():
    _, resource = resources.capture_files()
    tables = resource["tables"]
    modules = _modules()
    models = {r["model_id"]: r for r in tables["device_model.csv"]}
    equipped = [r for r in tables["device.csv"] if models[r["model_id"]]["device_class"] == "VUHF"]
    first = equipped[0]
    second = next(r for r in equipped if r["node_id"] != first["node_id"] and r["model_id"] == first["model_id"])
    devices = deepcopy([first, second])
    all_nodes = {r["node_id"]: r for r in tables["node.csv"]}
    nodes = [deepcopy(all_nodes[r["node_id"]]) for r in devices]
    for index, node in enumerate(nodes):
        node["lon"], node["lat"] = str(114.0 + index * .01), "38.0"
    links = [{"link_id": "L1", "node_a_id": nodes[0]["node_id"], "node_b_id": nodes[1]["node_id"],
        "device_a_id": devices[0]["device_id"], "device_b_id": devices[1]["device_id"],
        "device_class": "VUHF", "is_available": "true", "link_margin_db": "20", "distance_m": "880"}]
    fq = modules["frequency"]
    tasks = fq.tasks_from_nets(links, nodes, devices, tables["device_model.csv"])
    fq._prepare(tasks, fq.FreqPool(tables["frequency_resource.csv"]))
    frequency = tasks[0].allowed[0]["freq_khz"]
    params = [{"device_id": d["device_id"], "tx_power_dbm": float(d["tx_power_dbm"]),
        "antenna_height_m": float(d["antenna_height_m"])} for d in devices]
    detail = {"nodes": nodes, "devices": devices, "links": links, "params": {"params": params},
        "frequency": {"assignments": [{"link_id": tasks[0].task_id, "task_id": tasks[0].task_id, "freq_khz": frequency}],
                      "link_assignments": [{"link_id": "L1", "net_id": tasks[0].task_id, "freq_khz": frequency}]},
        "routes": {"routes": []}, "optimization": {}}
    scene = {"plan_snapshot": {"raw_snapshot": {"terrain_fingerprint": "TEST-TERRAIN", "detail": detail}},
             "interference_sources": []}
    engine = FrozenInterferenceEngine(terrain_provider=lambda: modules["terrain"].SyntheticTerrain((113.995, 37.995, 114.02, 38.01)),
                                     fingerprint_provider=lambda: "TEST-TERRAIN")
    return engine, {"scene": scene, "resource": resource}, frequency


def test_native_zero_source_does_not_load_defaults_or_mutate(frozen_sample):
    engine, source, _ = frozen_sample
    before = digest(source)
    output = engine.analyze(source, lambda *args: None, lambda: False)
    assert output["summary"]["affected_links"] == 0 and output["summary"]["affected_nodes"] == 0
    assert output["measures"] == [] and output["affected_area"]["features"] == []
    assert digest(source) == before


@pytest.mark.parametrize("count", [1, 2])
def test_native_frozen_selected_sources_and_five_type_review(frozen_sample, count):
    engine, frozen, frequency = frozen_sample
    source = deepcopy(frozen)
    source["scene"]["interference_sources"] = [{"source_row": {
        "interference_id": "TEST-J" + str(index), "name": "构造强干扰", "lon": "114.005", "lat": "38.001",
        "tx_power_dbm": "80", "antenna_gain_dbi": "0", "center_freq_khz": str(frequency),
        "bandwidth_khz": "25", "antenna_height_m": "10", "duty_cycle": "1", "active": "true",
        "pattern_type": "OMNI", "interference_type": "NOISE", "azimuth_deg": ""}} for index in range(count)]
    # 样本只评估两节点，不扫描全数据候选站址。
    source["resource"]["tables"]["candidate_site.csv"] = []
    before = digest(source)
    output = engine.analyze(source, lambda *args: None, lambda: False)
    assert output["affected_links"] and output["affected_links"][0]["sinr_after_db"] < output["affected_links"][0]["snr_before_db"]
    assert len(output["measure_review"][0]["measures"]) == 5
    assert all(p["metrics"] is None for p in output["previews"].values())
    assert digest(source) == before


def test_missing_terrain_physics_and_cancel_are_explicit(frozen_sample):
    engine, source, _ = frozen_sample
    broken = deepcopy(source)
    broken["scene"]["plan_snapshot"]["raw_snapshot"]["terrain_fingerprint"] = None
    with pytest.raises(AnalysisInputError):
        engine.validate_source(broken)
    with pytest.raises(AnalysisCancelled):
        engine.analyze(source, lambda *args: None, lambda: True)


def test_runtime_cannot_escape_own_r2():
    with pytest.raises(AnalysisInputError):
        FrozenInterferenceEngine(runtime_root=ROOT / "data/runtime/collab")
