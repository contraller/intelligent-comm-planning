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
              "device_a_id": "D-UNIT-A", "device_b_id": "D-UNIT-B", "is_available": "true", "distance_m": "1000"}]
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


def test_complete_check_gate_is_shared_and_never_accepts_the_twenty_fifth():
    engine = search.ChannelSearch([], [], None, [], deadline=time.monotonic() + 10)
    assert sum(engine.begin_check() for _ in range(30)) == 24
    assert engine.complete_checks == 24
    expired = search.ChannelSearch([], [], None, [], deadline=time.monotonic() - 1)
    assert not expired.begin_check()
    assert expired.begin_check(allow_initial=True)
    assert not expired.begin_check(allow_initial=True)
    assert expired.complete_checks == 1


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
              "candidate_site.csv": []}
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
    assert actual["optimization"]["actual_search"]["radio_bandwidth"]["devices"]
    assert actual["optimization"]["actual_search"]["planned_devices"] == []
    assert tables == before


def test_new_task_keeps_frozen_candidate_sites_for_original_deployment(native_case, monkeypatch):
    from terrain import SyntheticTerrain
    result, models, antennas, demands = native_case
    nodes = [{"node_id": station.sid, "node_subtype": station.subtype, "lon": station.lon, "lat": station.lat}
             for station in result["stations"]]
    sites = [{"site_id": "UNIT-PLANNED-SITE", "lon": 114.01, "lat": 38.01}]
    tables = {"node.csv": nodes, "device.csv": result["devices"], "device_model.csv": models,
              "antenna_model.csv": antennas, "frequency_resource.csv": pool_rows(), "interference_source.csv": [],
              "comm_demand.csv": [dict(demands[0], task_id="UNIT-TASK")], "link_metric.csv": [],
              "candidate_site.csv": sites}
    monkeypatch.setattr(flow, "default_terrain", lambda **_: SyntheticTerrain((113.9, 37.9, 114.2, 38.1)))
    def original_deployment(*args):
        assert args[5] == sites
        raise RuntimeError("UNIT original deployment received frozen sites")
    monkeypatch.setattr(flow, "topology_from_deployment", original_deployment)
    with pytest.raises(RuntimeError, match="original deployment received frozen sites"):
        flow.run("UNIT-TASK", resource_rows=tables, pop_size=4, generations=1, verbose=False)


@pytest.mark.parametrize("margin", [0.0, 5.99, 6.0, 7.0])
def test_final_candidate_routes_only_use_actual_margin_qualified_edges(native_case, monkeypatch, margin):
    from types import SimpleNamespace
    result, models, antennas, demands = native_case
    models[0]["tx_power_levels_dbm"] = "30"
    required_snr = flow.IF.REQUIRED_SNR_DB[flow.IF.SERVICE_OF_BAND["HF"]]
    monkeypatch.setattr(flow.IF, "hf_path_loss", lambda *_args: (130.0 - required_snr - margin, True, 0, 1000))
    nodes = [{"node_id": station.sid, "node_subtype": station.subtype, "lon": station.lon, "lat": station.lat}
             for station in result["stations"]]
    monkeypatch.setattr(flow, "rows_from_solution", lambda *_args: copy.deepcopy((result["links"], nodes, result["devices"])))
    candidate = flow._check_candidate(SimpleNamespace(fm=SimpleNamespace(stations=result["stations"])),
        {"relays": [], "m_req": 6.0, "uplinks": {1: 0}}, result["stations"], nodes, result["devices"],
        models, antennas, None, demands, demands, "MAX_RELIABILITY", "TERRAIN", pool_rows(), [],
        dict(flow.MO.DEFAULT_CONSTRAINTS), interference_rows=[])
    by_id = {row["link_id"]: row for row in candidate["links"]}
    assert candidate["routes"]["routes"][0]["reachable"] == (margin >= 6)
    for route in candidate["routes"]["routes"]:
        if route["reachable"]:
            assert all(float(by_id[lid]["link_margin_db"]) >= 6 for lid in route["primary"]["link_path"])
    assert all(row["is_available"] == "true" for row in candidate["links"])


def test_binding_proposals_skip_equivalent_device_permutations_but_keep_exact_ids():
    models = {"M": {"model_id": "M", "freq_min_khz": "4000", "freq_max_khz": "8000"}}
    devices = {"D%d" % index: {"model_id": "M"} for index in range(18)}
    original = ("D7", "D3", "D8", "D12")
    assert list(search.binding_proposals(sorted(devices), original, devices, models)) == [original]
    models["N"] = {"model_id": "N", "freq_min_khz": "6000", "freq_max_khz": "8000"}
    devices["N1"] = {"model_id": "N"}
    proposals = list(search.binding_proposals(sorted(devices), original, devices, models))
    assert len(proposals) == 5
    assert all(len(set(row)) == 4 for row in proposals)


@pytest.mark.parametrize("raw,other,rule,effective", [
    ("3", None, "MODEL_SINGLE_VALUE", 3.0),
    ("0.5;3;6", None, "IMPLICIT_FIRST_OPTION_ASSUMPTION", 0.5),
    ("", "6", "SAME_BAND_MEDIAN_ASSUMPTION", 6.0),
    ("", None, "STANDARD_DEFAULT_ASSUMPTION", 3.0),
])
def test_raw_bandwidth_audit_exposes_legacy_assumption_without_selecting(native_case, raw, other, rule, effective):
    result, models, antennas, _ = native_case
    models[0]["bandwidth_khz"] = raw
    if other:
        models.append(dict(models[0], model_id="OTHER", bandwidth_khz=other))
    frozen = copy.deepcopy((models, result["devices"], result["params"]))
    scenario = flow.IF.scenario_from_plan({"stations": result["stations"], "links": result["links"],
        "devices": result["devices"], "models": models, "antennas": antennas, "terrain": None,
        "params": result["params"], "freq_tasks": result["ftasks"],
        "frequency": {"link_assignments": [{"link_id": "L0", "freq_khz": 5000}]}}, [])
    audit = search.bandwidth_audit(scenario, result["devices"], models)
    assert audit["policy"] == "LEGACY_SPECFILLER_NO_BANDWIDTH_SEARCH"
    assert len(audit["devices"]) == 2
    for radio in audit["devices"]:
        assert radio["source_value"] == raw
        assert radio["selection_rule"] == rule
        assert radio["effective_bw_khz"] == effective
        assert radio["matches_legacy_rule"] and not radio["device_configuration_verified"]
    assert audit["links"][0]["aggregation"] == "MAX_ENDPOINT_NATIVE_RADIO_BW"
    assert audit["links"][0]["effective_bw_khz"] == effective
    assert (models, result["devices"], result["params"]) == frozen


@pytest.fixture
def physical_backup_case(native_case, monkeypatch):
    from types import SimpleNamespace
    _result, models, antennas, _demands = native_case
    monkeypatch.setattr(flow.IF, "hf_path_loss", lambda *_args: (105.0, True, 0, 1000))
    nodes = [{"node_id": name, "node_subtype": subtype, "lon": 114 + index * .01, "lat": 38}
             for index, (name, subtype) in enumerate((("A", "I_FIXED"), ("B", "II_FIXED"),
                                                     ("C", "II_FIXED"), ("D", "I_MOBILE")))]
    devices = [{"device_id": "%s-%d" % (node["node_id"], index), "node_id": node["node_id"], "model_id": "UNIT-M",
                "antenna_id": "UNIT-ANT", "tx_power_dbm": "30", "antenna_height_m": "10"}
               for node in nodes for index in range(3)]
    stations = flow.stations_from_nodes(nodes, devices, models, antennas)
    base = [(0, 1, "HF"), (0, 2, "HF"), (0, 3, "HF")]
    problem = SimpleNamespace(fm=SimpleNamespace(stations=stations), sid=[station.sid for station in stations],
                              base=base, backups=[], margin_at_max=lambda *_args: 1.0)
    solution = {"links": list(base), "relays": [], "m_req": 6.0, "uplinks": {1: 0, 2: 0}}
    demands = [{"demand_id": "D-" + target, "src_node_id": "A", "dst_node_id": target, "is_mandatory": "true"}
               for target in ("B", "C")]
    def check(candidate, selected_demands=demands):
        return flow._check_candidate(problem, candidate, stations, nodes, devices, models, antennas, None,
            selected_demands, selected_demands, "MAX_RELIABILITY", "TERRAIN", pool_rows(), [],
            dict(flow.MO.DEFAULT_CONSTRAINTS), interference_rows=[])
    return problem, solution, demands, models, check


def test_physical_backup_two_cuts_require_two_real_changes(physical_backup_case):
    problem, source, demands, models, check = physical_backup_case
    before = copy.deepcopy(source)
    original = check(source)
    assert original["objectives"]["survivability"] == 0.5
    proposals = search.backup_solutions(problem, source, original, demands, models, pool_rows())
    assert proposals and all(row["links"][:len(problem.base)] == problem.base for row in proposals)
    first = proposals[0]
    partial = check(first)
    assert partial["objectives"]["survivability"] == 0.5
    second = search.backup_solutions(problem, first, partial, demands, models, pool_rows())
    assert second
    completed = [check(row) for row in second]
    best = min(completed, key=lambda row: row["score"])
    assert best["score"][0] == 0 and best["objectives"]["survivability"] == 1.0
    assert len(best["links"]) == len(source["links"]) + 2
    assert {row["device_id"] for row in best["devices"]} == {row["device_id"] for row in original["devices"]}
    assert source == before


@pytest.mark.parametrize("spare_devices", [False, True])
def test_physical_backup_counts_independent_nets_not_same_net_edges(
        physical_backup_case, native_case, spare_devices):
    problem, source, demands, models, check = physical_backup_case
    original = check(source)
    devices = [row for row in original["devices"]
               if row["device_id"].endswith("-0")
               or spare_devices and row["node_id"] != "A" and row["device_id"].endswith("-1")]
    antennas = native_case[2]

    def validate(candidate):
        return flow._check_candidate(problem, candidate, original["stations"], original["nodes"],
            devices, models, antennas, None, demands, demands, "MAX_RELIABILITY", "TERRAIN",
            pool_rows(), [], dict(flow.MO.DEFAULT_CONSTRAINTS), interference_rows=[])

    result = validate(source)
    frozen = copy.deepcopy((source, result["links"], result["nodes"], result["devices"], devices))
    assert not result["binding_errors"] and result["check"]["passed"]
    proposals = search.backup_solutions(problem, source, result, demands, models, pool_rows())
    if not spare_devices:
        assert proposals == []
    else:
        assert proposals
        for proposal in proposals:
            verified = validate(proposal)
            assert not verified["binding_errors"] and verified["check"]["passed"]
            same_net = [row for row in verified["links"] if row["node_a_id"] == "A"]
            assert len(same_net) == 3
            assert {row["device_a_id"] for row in same_net} == {"A-0"}
            assert verified["devices"] == devices
            assert verified["nodes"] == result["nodes"]
    assert (source, result["links"], result["nodes"], result["devices"], devices) == frozen


@pytest.mark.parametrize("reason", ["no_pool", "full_ports", "cancelled"])
def test_physical_backup_does_not_invent_capacity_frequency_or_ignore_cancel(physical_backup_case, monkeypatch, reason):
    problem, source, demands, models, check = physical_backup_case
    original = check(source)
    pool = pool_rows()
    checkpoint = None
    if reason == "no_pool":
        pool = []
    elif reason == "full_ports":
        real_capacity = search.E.capacity
        monkeypatch.setattr(search.E, "capacity", lambda subtype, band: 1 if subtype == "II_FIXED" else real_capacity(subtype, band))
    else:
        def cancelled():
            raise RuntimeError("UNIT cancelled backup search")
        checkpoint = cancelled
    if reason == "cancelled":
        with pytest.raises(RuntimeError, match="cancelled backup search"):
            search.backup_solutions(problem, source, original, demands, models, pool, checkpoint=checkpoint)
    else:
        assert search.backup_solutions(problem, source, original, demands, models, pool, checkpoint=checkpoint) == []


def test_new_task_uses_two_step_actual_cut_search_not_only_single_step_greedy(physical_backup_case, monkeypatch):
    from types import SimpleNamespace
    problem, source, demands, models, check = physical_backup_case
    initial = check(source)
    nodes, devices = initial["nodes"], initial["devices"]
    source.update(usable=[(*edge, 12.0) for edge in source["links"]], connectivity=1.0,
                  mandatory_connectivity=1.0, survivability=0.5, total_power_w=1.0,
                  bridges=3, worst_bridge=(0, 1), relay_hops=0)
    solution = SimpleNamespace(added=[])
    monkeypatch.setattr(flow, "default_terrain", lambda **_: None)
    monkeypatch.setattr(flow, "topology_from_deployment", lambda *_args: (
        problem.fm, solution, copy.deepcopy(initial["links"]), copy.deepcopy(nodes), copy.deepcopy(devices)))
    monkeypatch.setattr(flow.RP, "plan", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(flow.MO, "Problem", lambda *_args, **_kwargs: problem)
    monkeypatch.setattr(flow.MO, "optimize", lambda *_args, **kwargs: {
        "solutions": [source], "candidates": [], "tradeoff": [source], "evaluations": 1,
        "constraints": kwargs["constraints"]})
    tables = {"node.csv": nodes, "device.csv": devices, "device_model.csv": models,
              "antenna_model.csv": [{"antenna_id": "UNIT-ANT", "gain_dbi": "0", "pattern_type": "OMNI"}],
              "frequency_resource.csv": pool_rows(), "interference_source.csv": [],
              "comm_demand.csv": [dict(row, task_id="UNIT-TASK") for row in demands],
              "link_metric.csv": [], "candidate_site.csv": []}
    frozen = copy.deepcopy(tables)
    actual = flow.run("UNIT-TASK", resource_rows=tables, pop_size=4, generations=1, verbose=False)
    best = actual["optimization"]["best"]
    assert actual["optimization"]["feasible"]
    assert best["objectives"]["survivability"] == 1.0 and best["bridges"] == 0
    assert best["worst_single_failure"] is None
    assert actual["optimization"]["task_view"]["survivability"] == 1.0
    assert 4 <= actual["optimization"]["actual_search"]["checked_candidates"] <= 24
    assert actual["optimization"]["tradeoff"][0]["evaluation_basis"] == "REPRESENTATIVE_FREQUENCY_PRESELECTION"
    assert len(actual["links"]) == 5 and actual["within_limit"]
    assert tables == frozen


def test_unusable_optional_backup_can_be_removed_without_erasing_primary_or_history(physical_backup_case, monkeypatch):
    problem, source, demands, models, check = physical_backup_case
    source = dict(source, links=source["links"] + [(1, 3, "HF")])
    frozen = copy.deepcopy(source)
    def loss(_terrain, a, b, *_args):
        bad = {round(a[0], 2), round(b[0], 2)} == {114.01, 114.03}
        return (180.0 if bad else 105.0), True, 0, 1000
    monkeypatch.setattr(flow.IF, "hf_path_loss", loss)
    result = check(source)
    assert float(result["links"][-1]["link_margin_db"]) < 0
    proposals = search.backup_solutions(problem, source, result, demands, models, pool_rows())
    pruned = proposals[0]
    assert pruned["links"] == problem.base
    assert pruned["repair_changes"][-1]["kind"] == "DROP_UNUSABLE_OPTIONAL_BACKUP"
    after = check(pruned)
    assert after["objectives"]["survivability"] == result["objectives"]["survivability"]
    assert after["objectives"]["e2e_connectivity"] == result["objectives"]["e2e_connectivity"]
    assert source == frozen
