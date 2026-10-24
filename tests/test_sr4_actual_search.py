"""真实引擎封装的有界搜索；UNIT解析传播桩不是主DEM证据。"""
import copy
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "planning"))

import actual_search as search
import frequency as FQ
import sr4_flow as flow


def pool_rows():
    return [{"freq_id": name, "device_class": "HF", "center_freq_khz": str(frequency),
             "bandwidth_khz": "3", "is_available": available,
             "reuse_min_distance_m": "60000", "adjacent_guard_khz": "3"}
            for name, frequency, available in (("F1", 5000, "true"), ("F2", 6000, "true"),
                                               ("DISABLED", 7000, "false"))]


def tasks(count=1):
    return [FQ.FreqTask("NET-%d" % index, "HF", ["L%d" % index], [(114, 38)], 4000, 6500)
            for index in range(count)]


def test_channel_preference_is_only_an_order_with_exact_legacy_default():
    rows = pool_rows()
    before = copy.deepcopy(rows)
    legacy = FQ.assign(tasks(), FQ.FreqPool(rows))
    assert legacy == FQ.assign(tasks(), FQ.FreqPool(rows), channel_preference=None)
    preference = {"NET-0": ["DISABLED", "INVENTED", "F2", "F1"]}
    actual = FQ.assign(tasks(), FQ.FreqPool(rows), channel_preference=preference)
    assert legacy["assignments"][0]["freq_id"] == "F1"
    assert actual["assignments"][0]["freq_id"] == "F2"
    assert actual["conflict_free"]
    assert rows == before


def test_channel_preference_cannot_override_manual_or_remove_conflict():
    pool = FQ.FreqPool(pool_rows())
    actual = FQ.assign(tasks(3), pool, [{"link_id": "NET-0", "freq_khz": 5000}],
                       channel_preference={"NET-0": ["F2"], "NET-1": ["F2"]})
    assert actual["assignments"][0]["freq_id"] == "F1"
    assert actual["assignments"][0]["manual"]
    assert not actual["conflict_free"] and actual["conflicts"]
    assert actual["gap"]["HF"]["shortage"] == 1


@pytest.mark.parametrize("locked", [False, True])
def test_channel_preference_local_exchange_preserves_both_hard_channels(locked):
    objects = tasks(2)
    pool = FQ.FreqPool(pool_rows())
    FQ._prepare(objects, pool)
    adj, sep = FQ.build_interference(objects, pool)
    f1, f2 = pool.of_band("HF")
    original = {0: f2, 1: f1}
    result, moves = FQ._preference_repair(objects, adj, sep, original, {1} if locked else set(),
                                        {"NET-0": ["F1", "F2"], "NET-1": ["F2", "F1"]})
    assert FQ.check_conflicts(objects, adj, sep, result) == []
    assert result[0]["freq_id"] == ("F2" if locked else "F1")
    assert moves == (0 if locked else 1)
    assert original[0]["freq_id"] == "F2"


@pytest.fixture
def native_case(monkeypatch):
    nodes = [{"node_id": name, "node_subtype": subtype, "lon": 114 + index * .01, "lat": 38}
             for index, (name, subtype) in enumerate((("UNIT-A", "I_FIXED"), ("UNIT-B", "II_FIXED")))]
    model = {"model_id": "UNIT-M", "device_class": "HF", "freq_min_khz": "4000", "freq_max_khz": "8000",
             "tx_power_levels_dbm": "0;10;20;30", "tx_power_max_dbm": "30",
             "rx_sensitivity_dbm": "-120", "bandwidth_khz": "3"}
    antennas = [{"antenna_id": "UNIT-ANT", "gain_dbi": "0", "pattern_type": "OMNI"}]
    devices = [{"device_id": "D-" + row["node_id"], "node_id": row["node_id"], "model_id": "UNIT-M",
                "antenna_id": "UNIT-ANT", "tx_power_dbm": "30", "antenna_height_m": "10"} for row in nodes]
    links = [{"link_id": "L0", "node_a_id": "UNIT-A", "node_b_id": "UNIT-B", "device_class": "HF",
              "device_a_id": "D-UNIT-A", "device_b_id": "D-UNIT-B", "is_available": "true"}]
    stations = flow.stations_from_nodes(nodes, devices, [model], antennas)
    monkeypatch.setattr(flow.IF, "hf_path_loss", lambda _terrain, _pa, _pb, frequency, *_args:
                        (140.0 if frequency == 5000 else 105.0, True, 0, 1000))
    monkeypatch.setattr(flow.IF, "noise_floor_dbm", lambda *_: -100.0)
    ftasks = FQ.tasks_from_nets(links, nodes, devices, [model])
    params = flow.RP.plan_bound_devices(stations, links, devices, [model], antennas, None,
        frequency_by_link={"L0": 5000}, interference_rows=[])
    links[0]["link_margin_db"] = str(params["links"][0]["margin_db"])
    result = {"links": links, "stations": stations, "devices": devices, "ftasks": ftasks,
              "params": params, "caps": flow.RP.capabilities_by_device(stations, devices, [model], antennas),
              "frequency": {"conflicts": []}}
    demands = [{"demand_id": "UNIT-D", "src_node_id": "UNIT-A", "dst_node_id": "UNIT-B", "is_mandatory": "true"}]
    return result, [model], antennas, demands


def test_actual_channel_preference_uses_native_maximum_and_same_run_cache(native_case):
    result, models, antennas, demands = native_case
    before = copy.deepcopy((result["links"], result["params"], result["devices"]))
    engine = search.ChannelSearch(models, antennas, None, [], deadline=time.monotonic() + 10)
    preference = engine.preferences(result, pool_rows(), demands)
    net_id = result["ftasks"][0].task_id
    assert preference[net_id] == ["F2", "F1"]
    count = engine.evaluations
    assert count == 2
    assert engine.preferences(result, pool_rows(), demands) == preference
    assert engine.evaluations == count
    result["params"]["params"][0]["antenna_height_m"] += 1
    engine.preferences(result, pool_rows(), demands)
    assert engine.evaluations == count + 2
    result["params"]["params"][0]["antenna_height_m"] -= 1
    assert (result["links"], result["params"], result["devices"]) == before


def test_actual_channel_preference_retains_unrecoverable_gap(native_case):
    result, models, antennas, demands = native_case
    engine = search.ChannelSearch(models, antennas, None, [], deadline=time.monotonic() + 10)
    only_bad = pool_rows()[:1]
    preference = engine.preferences(result, only_bad, demands)
    assert list(preference.values()) == [["F1"]]
    assert result["params"]["failed_links"]
    assert float(result["links"][0]["link_margin_db"]) < 6


def test_actual_channel_budget_and_cancel_do_not_mutate_snapshot(native_case):
    result, models, antennas, demands = native_case
    before = copy.deepcopy(result["params"])
    engine = search.ChannelSearch(models, antennas, None, [], deadline=time.monotonic() - 1)
    assert engine.preferences(result, pool_rows(), demands) == {}
    assert engine.exhausted and engine.evaluations == 0
    def cancelled():
        raise RuntimeError("UNIT cancelled")
    engine = search.ChannelSearch(models, antennas, None, [], deadline=time.monotonic() + 10, progress=cancelled)
    with pytest.raises(RuntimeError, match="UNIT cancelled"):
        engine.preferences(result, pool_rows(), demands)
    assert result["params"] == before


def test_actual_failure_weights_prioritize_bypass_not_healthy_bridge():
    links = [{"link_id": name, "node_a_id": a, "node_b_id": b, "link_margin_db": margin}
             for name, a, b, margin in (("BRIDGE", "A", "B", 23), ("BACKUP", "A", "C", -10),
                                       ("TAIL", "B", "C", 23), ("OTHER", "C", "D", -10))]
    demands = [{"demand_id": "D%d" % index, "src_node_id": "A", "dst_node_id": "C", "is_mandatory": "true"}
               for index in range(20)]
    actual = search.failure_context(links, demands, 6)
    assert actual["cuts"][0]["lost"] == [row["demand_id"] for row in demands]
    assert actual["weights"]["BACKUP"] > actual["weights"]["OTHER"]
    assert actual["mandatory_count"] == 20


def test_new_task_runs_native_actual_frequency_refinement_without_creating_devices(native_case, monkeypatch):
    import feasibility
    from terrain import SyntheticTerrain
    result, models, antennas, demands = native_case
    nodes = [{"node_id": station.sid, "node_subtype": station.subtype, "lon": station.lon, "lat": station.lat}
             for station in result["stations"]]
    tables = {"node.csv": nodes, "device.csv": result["devices"], "device_model.csv": models,
              "antenna_model.csv": antennas, "frequency_resource.csv": pool_rows(), "interference_source.csv": [],
              "comm_demand.csv": [dict(demands[0], task_id="UNIT-TASK")], "link_metric.csv": [],
              "candidate_site.csv": [{"site_id": "UNFUNDED", "lon": 114.01, "lat": 38.01}]}
    before = copy.deepcopy(tables)
    monkeypatch.setattr(flow, "default_terrain", lambda **_: SyntheticTerrain((113.9, 37.9, 114.2, 38.1)))
    monkeypatch.setattr(feasibility, "link_margin", lambda *_args, **_kwargs: (12.0, 1000.0, 80.0))
    actual = flow.run("UNIT-TASK", resource_rows=tables, pop_size=4, generations=1, verbose=False)
    # 两站只有一条物理边：恢复频点能连通，但不能伪称能抗该边失效。
    assert not actual["optimization"]["feasible"]
    assert actual["optimization"]["infeasible"]["conflicting_constraints"] == ["survivability"]
    assert actual["check"]["passed"]
    assert actual["optimization"]["best"]["objectives"]["e2e_connectivity"] == 1.0
    assert actual["optimization"]["best"]["objectives"]["survivability"] == 0.0
    assert actual["optimization"]["actual_search"]["evaluations"] == 2
    assert actual["frequency"]["assignments"][0]["freq_id"] == "F2"
    assert actual["params"]["margin_basis"] == "ASSIGNED_FREQUENCY_WITH_INTERFERENCE"
    assert {row["device_id"] for row in actual["devices"]} == {row["device_id"] for row in tables["device.csv"]}
    assert actual["deployment"]["added"] == [] and actual["within_limit"]
    assert tables == before
