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


def _parent_flow_sample(frozen_sample, monkeypatch):
    from scripts.planning import sr4_flow as flow
    engine, frozen, _ = frozen_sample
    source = deepcopy(frozen)
    detail = source["scene"]["plan_snapshot"]["raw_snapshot"]["detail"]
    nodes, devices = detail["nodes"], detail["devices"]
    nodes.append({**deepcopy(nodes[1]), "node_id": "UNIT-N3", "lon": "114.005", "lat": "38.005"})
    devices.append({**deepcopy(devices[1]), "node_id": "UNIT-N3", "device_id": "UNIT-D3"})
    for lid, a, b in (("L2", 0, 2), ("L3", 2, 1)):
        detail["links"].append({**deepcopy(detail["links"][0]), "link_id": lid,
            "node_a_id": nodes[a]["node_id"], "node_b_id": nodes[b]["node_id"],
            "device_a_id": devices[a]["device_id"], "device_b_id": devices[b]["device_id"]})
    tables = source["resource"]["tables"]
    tables["device.csv"] = deepcopy(devices)
    tables["node.csv"] = deepcopy(nodes)
    tables["comm_demand.csv"] = []
    tables["interference_source.csv"] = [{"interference_id": "SHOULD-NOT-LOAD"}]
    tables["candidate_site.csv"] = []
    tables["link_metric.csv"] = []
    demands = [{"demand_id": "UNIT-DEMAND", "task_id": "UNIT-TASK",
        "src_node_id": nodes[0]["node_id"], "dst_node_id": nodes[1]["node_id"],
        "priority": 1, "is_mandatory": "true", "required_rate_kbps": 1,
        "max_delay_ms": 1000, "min_reliability": .1, "service_type": "DATA"}]
    tasks = flow.FQ.tasks_from_nets(detail["links"], nodes, devices, tables["device_model.csv"])
    flow.FQ.fill_ranges_by_node(tasks, detail["links"], nodes, devices, tables["device_model.csv"])
    frequency = flow.FQ.assign(tasks, flow.FQ.FreqPool(tables["frequency_resource.csv"]))
    frequency["link_assignments"] = flow.FQ.expand_to_links(frequency, tasks)
    detail["frequency"] = frequency
    detail["optimization"] = {"best": {"fade_margin_db": 0}, "tradeoff": []}
    detail["params"]["params"] = [{"device_id": d["device_id"], "tx_power_dbm": float(d["tx_power_dbm"]),
        "antenna_height_m": float(d["antenna_height_m"])} for d in devices]
    refs = [{"device_id": d["device_id"], "node_id": d["node_id"], "band": "VUHF"} for d in devices]
    monkeypatch.setattr(flow, "DemTerrain", engine.terrain_provider)
    monkeypatch.setattr(flow, "default_terrain", lambda **kw: engine.terrain_provider())
    monkeypatch.setattr(flow, "load", lambda *args: (_ for _ in ()).throw(AssertionError("不能读CSV")))
    return flow, source, detail, tables, demands, refs


@pytest.mark.parametrize("kind", ["FREQ_ADJUST", "CHANNEL_SWITCH", "POWER_OPT", "NODE_REDEPLOY", "ROUTE_REBUILD"])
def test_native_five_frozen_replan_types_apply_and_recalculate(frozen_sample, monkeypatch, kind):
    from app.interference_replan_service import InterferenceReplanService
    flow, source, detail, tables, demands, refs = _parent_flow_sample(frozen_sample, monkeypatch)
    before = digest(source)
    overrides = deepcopy(detail["params"]["params"])
    task = flow.FQ.tasks_from_nets(detail["links"], detail["nodes"], detail["devices"], tables["device_model.csv"])[0]
    values = {}
    target = {"link_id": task.members[0], "net_id": task.task_id}
    change = {"type": kind, "target": target, "detail": values}
    paths = []
    if kind in ("FREQ_ADJUST", "CHANNEL_SWITCH"):
        flow.FQ._prepare([task], flow.FQ.FreqPool(tables["frequency_resource.csv"]))
        previous = next(r["freq_khz"] for r in detail["frequency"]["assignments"] if r["task_id"] == task.task_id)
        values.update(to_freq_khz=next(row["freq_khz"] for row in task.allowed if row["freq_khz"] != previous),
                      links_in_net=list(task.members))
    elif kind == "POWER_OPT":
        stations = flow.stations_from_nodes(detail["nodes"], detail["devices"], tables["device_model.csv"], tables["antenna_model.csv"])
        caps = flow.RP.capabilities_by_device(stations, detail["devices"], tables["device_model.csv"], tables["antenna_model.csv"])
        changed = overrides[0]
        changed["tx_power_dbm"] = next(p for p in caps[changed["device_id"]].levels if p != changed["tx_power_dbm"])
        change["device_changes"] = [{"device_id": changed["device_id"], "tx_power_dbm": changed["tx_power_dbm"]}]
    elif kind == "NODE_REDEPLOY":
        target["node_id"] = detail["nodes"][0]["node_id"]
        values.update(to_lon=114.002, to_lat=38.002, to_site_id="UNIT-SITE")
    else:
        path = {"node_path": [detail["nodes"][0]["node_id"], "UNIT-N3", detail["nodes"][1]["node_id"]],
                "link_path": ["L2", "L3"]}
        values.update(banned_links=["L1"], rerouted=[{"demand_id": "UNIT-DEMAND", "primary": path,
            "backup": None, "backup_type": "NONE"}])
        paths = [{"demand_id": "UNIT-DEMAND", "node_path": path["node_path"]}]
    adjustment = {"manual_override": overrides, "manual_paths": paths,
        "interference_origin": {"adoption_id": "UNIT-ADOPTION"},
        "interference": {"change_set": change, "sources": [], "terrain_fingerprint": "TEST-TERRAIN",
            "parameter_substitutions": []}}
    result = flow.run_from_parent({"detail": detail, "terrain_fingerprint": "TEST-TERRAIN"},
        adjustment, refs, "UNIT-TASK", demands, interference_rows=[], resource_rows=tables)
    assert InterferenceReplanService.applied(change, result)
    assert result["params"]["links"] and result["routes"]["routes"] and result["check"]
    assert result["interference"]["effect"]["sources"] == []
    assert result["interference"]["analysis"]["summary"]["affected_links"] == 0
    assert digest(source) == before
    if kind == "NODE_REDEPLOY":
        assert result["links"][0]["distance_m"] != detail["links"][0]["distance_m"]
    if kind not in ("FREQ_ADJUST", "CHANNEL_SWITCH"):
        assert [r["freq_khz"] for r in result["frequency"]["assignments"]] == [r["freq_khz"] for r in detail["frequency"]["assignments"]]


@pytest.mark.parametrize("filters,expected", [
    (None, {"H3", "H4", "V5"}),
    ([{"device_class": "HF", "range_khz": [3000, 3000], "exclude_freq_ids": []}], {"H3", "V5"}),
    ([{"device_class": "HF", "range_khz": None, "exclude_freq_ids": ["H3"]}], {"H4", "V5"}),
    ([{"device_class": "HF", "range_khz": [3000, 4000], "exclude_freq_ids": ["H4"]},
      {"device_class": "VUHF", "range_khz": [50000, 50000], "exclude_freq_ids": []}], {"H3", "V5"}),
    ([{"device_class": "HF", "range_khz": None, "exclude_freq_ids": ["HD"]}], {"H3", "H4", "V5"}),
    ([{"device_class": "HF", "range_khz": [3100, 3200], "exclude_freq_ids": []}], {"V5"}),
])
def test_f12_native_pool_closed_ranges_separate_bands_and_no_fallback(filters, expected):
    from scripts.planning.sr4_flow import constrained_frequency_rows
    rows = [{"freq_id": fid, "device_class": band, "center_freq_khz": str(frequency), "is_available": available}
        for fid, band, frequency, available in (("H3", "HF", 3000, "true"), ("H4", "HF", 4000, "true"),
            ("HD", "HF", 3500, "false"), ("V5", "VUHF", 50000, "true"))]
    original = deepcopy(rows)
    assert {row["freq_id"] for row in constrained_frequency_rows(rows, {"filters": filters} if filters else None)} == expected
    assert rows == original


def _f12_payload(frozen_sample, constraints):
    from types import SimpleNamespace
    from app.planning_job_service import _algorithm_payload
    _, source, _ = frozen_sample
    rows = deepcopy(source["resource"]["tables"])
    input_data = {"frequencyConstraints": constraints, "presetId": "balanced", "demands": [],
        "constraints": {"connectivityPercent": 100, "survivabilityPercent": 90, "maxRelayHops": 2}}
    payload = _algorithm_payload(SimpleNamespace(task_id="UNIT-TASK"),
        SimpleNamespace(input_snapshot=input_data, resource_revision="UNIT-RESOURCE"), frozen_rows=rows)
    return payload, rows


@pytest.mark.parametrize("kind,code", [("unknown", 1002), ("wrong_band", 1001)])
def test_f12_exclusion_validates_frozen_id_and_class(frozen_sample, kind, code):
    from app.planning_job_service import PlanningJobError
    rows = frozen_sample[1]["resource"]["tables"]["frequency_resource.csv"]
    actual = next(row for row in rows if row["device_class"] == "VUHF")
    constraints = {"filters": [{"deviceClass": "HF", "rangeKhz": None,
        "excludeFreqIds": [actual["freq_id"] if kind == "wrong_band" else "UNIT-UNKNOWN"]}]}
    with pytest.raises(PlanningJobError) as error:
        _f12_payload(frozen_sample, constraints)
    assert error.value.code == code
    assert error.value.data[0]["field"] == "input.frequencyConstraints.filters[0].excludeFreqIds"


def test_f12_payload_keeps_original_tables_and_detaches_caller(frozen_sample):
    first = frozen_sample[1]["resource"]["tables"]["frequency_resource.csv"][0]
    constraints = {"filters": [{"deviceClass": first["device_class"], "rangeKhz": None,
        "excludeFreqIds": [first["freq_id"]]}]}
    payload, rows = _f12_payload(frozen_sample, constraints)
    assert payload["resource_rows"]["frequency_resource.csv"] == rows["frequency_resource.csv"]
    expected = deepcopy(payload)
    constraints["filters"][0]["excludeFreqIds"].append("LATE")
    rows["frequency_resource.csv"].clear()
    assert payload == expected


@pytest.mark.parametrize("entry", [
    {"deviceClass": "HF", "rangeKhz": None, "excludeFreqIds": []},
    {"deviceClass": "HF", "rangeKhz": [2, 1], "excludeFreqIds": []},
    {"deviceClass": "HF", "rangeKhz": [True, 2], "excludeFreqIds": []},
    {"deviceClass": "HF", "rangeKhz": [0, 2], "excludeFreqIds": []},
    {"deviceClass": "HF", "rangeKhz": [1, float("nan")], "excludeFreqIds": []},
    {"deviceClass": "HF", "rangeKhz": [1, 2], "excludeFreqIds": ["H3", "H3"]},
])
def test_f12_malformed_conditions_remain_strict(entry):
    from pydantic import ValidationError
    from app.task_input_schemas import FrequencyConstraints
    with pytest.raises(ValidationError):
        FrequencyConstraints.model_validate({"filters": [entry]})


def test_f12_parent_lock_rejects_excluded_frequency_without_silent_switch(frozen_sample, monkeypatch):
    flow, _, detail, tables, _, _ = _parent_flow_sample(frozen_sample, monkeypatch)
    tasks = flow.FQ.tasks_from_nets(detail["links"], detail["nodes"], detail["devices"], tables["device_model.csv"])
    flow.FQ.fill_ranges_by_node(tasks, detail["links"], detail["nodes"], detail["devices"], tables["device_model.csv"])
    with pytest.raises(ValueError, match="共同可用池"):
        flow._frozen_frequency_locks(detail, tasks, [], {"type": "POWER_OPT"})


def test_manual_adjustment_digest_is_upgrade_compatible():
    import hashlib
    import json
    from app.planning_job_schemas import PlanningJobSubmitRequest
    from app.planning_job_service import _digest
    raw = {"context": "planning", "request_id": "UNIT-MANUAL", "task_id": "T1",
        "expected_revision": "R1", "input_version": "R1", "condition_version": "C1",
        "resource_revision": "RES1", "parent_plan_id": "P1", "adjustment": {
            "schema_version": 1, "source_plan_id": "P1", "source_snapshot_id": "SNP-PL-12345678",
            "manual_override": [{"device_id": "D1", "tx_power_dbm": 0}], "manual_paths": []}}
    legacy_body = deepcopy(raw)
    legacy_body["adjustment"]["manual_override"][0]["antenna_height_m"] = None
    legacy_body["adjustment"]["manual_override"][0]["tx_power_dbm"] = 0.0
    expected = hashlib.sha256(json.dumps(legacy_body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert _digest(PlanningJobSubmitRequest.model_validate(raw)) == expected


def _prepare_sample(frozen_sample, monkeypatch):
    from types import SimpleNamespace
    from app import planning_adjustment_service as adjustment
    flow, source, detail, tables, _, _ = _parent_flow_sample(frozen_sample, monkeypatch)
    raw = source["scene"]["plan_snapshot"]["raw_snapshot"]
    raw.update(solution_id="PL-12345678", summary={}, terrain_fingerprint="a" * 64)
    input_data = {"demands": [{"id": "UNIT-DEMAND", "sourceId": detail["nodes"][0]["node_id"],
        "targetId": detail["nodes"][1]["node_id"]}]}
    frozen = source["scene"]["plan_snapshot"]
    frozen.update(input_snapshot=input_data, input_version="REV-P1", condition_version="COND-1")
    source["scene"].update(task_id="T1", plan_id="P1", plan_version="V1", scene_id="SC1",
        version_id="ISV-UNIT", snapshot_hash="b" * 64, resource_content_hash="c" * 64,
        resource_revision="UNIT-RESOURCE", data_origin="UNIT_TEST")
    plan = SimpleNamespace(plan_id="P1", task_id="T1", version_no=1, source="SR4",
        raw_snapshot=raw, input_snapshot=input_data, resource_revision="UNIT-RESOURCE", condition_version="COND-1",
        result_snapshot={"snapshot_id": "SNP-PL-12345678", "devices": [
            {"id": d["device_id"], "stationId": d["node_id"], "deviceClass": "VUHF"} for d in detail["devices"]]})
    revision = SimpleNamespace(task_id="T1", revision_id="REV-P1", condition_version="COND-1",
        resource_revision="UNIT-RESOURCE", input_snapshot=deepcopy(input_data))
    engine = FrozenInterferenceEngine(terrain_provider=frozen_sample[0].terrain_provider,
        fingerprint_provider=lambda: "a" * 64)
    monkeypatch.setattr(adjustment, "terrain_fingerprint", lambda: "a" * 64)
    return adjustment, flow, source, plan, revision, engine


@pytest.mark.parametrize("bad", [False, True])
def test_prepare_power_requires_exact_physical_device_and_model_level(frozen_sample, monkeypatch, bad):
    adjustment, flow, source, plan, revision, engine = _prepare_sample(frozen_sample, monkeypatch)
    detail = plan.raw_snapshot["detail"]
    modules, _, _, caps, _, _ = engine._build(source)
    link = detail["links"][0]
    did = link["device_a_id"]
    power = caps[did].levels[0]
    change = {"type": "POWER_OPT", "target": {"link_id": link["link_id"]},
        "detail": {"tx_changes": [{"node_id": link["node_a_id"], "band": "VUHF", "to_dbm": power}]},
        "device_changes": [{"device_id": "UNIT-UNKNOWN" if bad else did, "tx_power_dbm": power}]}
    origin = {"adoption_id": "IAD-UNIT", "run_id": "IR-UNIT", "measure_id": "CM-UNIT",
        "source_hash": digest(source), "change_hash": digest(change), "actor_id": "UNIT-TEST"}
    if bad:
        with pytest.raises(adjustment.AdjustmentError, match="精确映射"):
            adjustment.prepare_interference_parent(plan, revision, source, change, origin, engine=engine)
    else:
        snapshot, refs, result = adjustment.prepare_interference_parent(plan, revision, source, change, origin, engine=engine)
        assert snapshot == plan.raw_snapshot and snapshot is not plan.raw_snapshot
        assert len(refs) == len(caps) and result.interference.sources == []
        assert next(r for r in result.manual_override if r.device_id == did).tx_power_dbm == power


@pytest.mark.parametrize("bad", [False, True])
def test_prepare_node_uses_exact_frozen_candidate_and_dem(frozen_sample, monkeypatch, bad):
    adjustment, _, source, plan, revision, engine = _prepare_sample(frozen_sample, monkeypatch)
    source["resource"]["tables"]["candidate_site.csv"] = [{"site_id": "UNIT-SITE", "lon": "114.002", "lat": "38.002", "is_deployable": "true"}]
    change = {"type": "NODE_REDEPLOY", "target": {"node_id": plan.raw_snapshot["detail"]["nodes"][0]["node_id"]},
        "detail": {"to_site_id": "UNIT-SITE", "to_lon": 115 if bad else 114.002, "to_lat": 38.002}}
    origin = {"adoption_id": "IAD-UNIT", "run_id": "IR-UNIT", "measure_id": "CM-UNIT",
        "source_hash": digest(source), "change_hash": digest(change), "actor_id": "UNIT-TEST"}
    if bad:
        with pytest.raises(adjustment.AdjustmentError, match="坐标"):
            adjustment.prepare_interference_parent(plan, revision, source, change, origin, engine=engine)
    else:
        _, _, result = adjustment.prepare_interference_parent(plan, revision, source, change, origin, engine=engine)
        assert result.interference.change_set == change


def test_f12_condition_signature_is_set_based_but_range_sensitive():
    from app.task_input_service import _condition_signature
    first = {"demands": [], "bbox": [113, 37, 115, 39], "stationIds": [], "constraints": {},
        "presetId": "balanced", "frequencyId": "default", "frequencyConstraints": {"filters": [
            {"deviceClass": "HF", "rangeKhz": [3000, 4000], "excludeFreqIds": ["H4", "H3"]},
            {"deviceClass": "VUHF", "rangeKhz": None, "excludeFreqIds": ["V5"]}]}}
    second = deepcopy(first)
    second["frequencyConstraints"]["filters"].reverse()
    second["frequencyConstraints"]["filters"][1]["excludeFreqIds"].reverse()
    assert _condition_signature(first) == _condition_signature(second)
    second["frequencyConstraints"]["filters"][1]["rangeKhz"][1] = 5000
    assert _condition_signature(first) != _condition_signature(second)


def test_small_manual_parent_path_remains_compatible(frozen_sample, monkeypatch):
    flow, _, detail, tables, demands, refs = _parent_flow_sample(frozen_sample, monkeypatch)
    node_ids = [node["node_id"] for node in detail["nodes"][:2]]
    override = deepcopy(detail["params"]["params"][0])
    manual = {"manual_override": [override], "manual_paths": [{"demand_id": "UNIT-DEMAND", "node_path": node_ids}]}
    result = flow.run_from_parent({"detail": detail}, manual, refs, "UNIT-TASK", demands,
        interference_rows=[], resource_rows=tables)
    assert result["nodes"] == detail["nodes"] and result["devices"] == detail["devices"]
    assert result["routes"]["routes"][0]["primary"]["node_path"] == node_ids
    assert "effect" not in result["interference"]
    actual = next(row for row in result["params"]["params"] if row["device_id"] == override["device_id"])
    assert actual["tx_power_dbm"] == override["tx_power_dbm"]


def _margin_contract_topology():
    nodes = [{"node_id": "R", "node_subtype": "III_MOBILE"},
             {"node_id": "A", "node_subtype": "III_MOBILE"},
             {"node_id": "H", "node_subtype": "II_MOBILE"}]
    links = [{"link_id": "RA", "node_a_id": "R", "node_b_id": "A", "device_class": "VUHF",
              "is_available": "true", "is_backup": "true"},
             {"link_id": "AH", "node_a_id": "A", "node_b_id": "H", "device_class": "HF",
              "is_available": "true", "is_backup": "false"}]
    return {"nodes": nodes, "links": links, "optimization": {"uplinks": {"R": "A", "A": "H"}}}


def test_margin_contract_explicit_uplink_preserves_real_borrowing_despite_backup_flag():
    from scripts.planning import sr4_flow as flow
    detail = _margin_contract_topology()
    before = deepcopy(detail)
    actual = flow._frozen_uplinks(detail)
    check = flow.plan_check.check(nodes=detail["nodes"], links=detail["links"], uplinks=actual)
    assert not any(row["kind"] == "PEER_CROSS_GROUP" for row in check["issues"])
    assert actual == {"R": "A", "A": "H"} and detail == before
    actual["R"] = "H"
    assert detail == before


@pytest.mark.parametrize("mapping", [None, [], {"R": "MISSING"}, {"R": "H"}, {"R": "R"}, {"R": "A", "A": "R"}, {"R": "A", "A": []}])
def test_margin_contract_missing_or_invalid_uplink_never_guesses_historical_relation(mapping):
    from scripts.planning import sr4_flow as flow
    detail = _margin_contract_topology()
    detail["optimization"]["uplinks"] = mapping
    before = deepcopy(detail)
    with pytest.raises(ValueError, match="主上行关系"):
        flow._frozen_uplinks(detail)
    assert detail == before


def test_margin_contract_non_peer_legacy_snapshot_needs_no_invented_uplink():
    from scripts.planning import sr4_flow as flow
    detail = _margin_contract_topology()
    detail["nodes"][0]["node_subtype"] = "IV_MOBILE"
    detail["optimization"].pop("uplinks")
    assert flow._frozen_uplinks(detail) == {}


@pytest.mark.parametrize("jammed", [False, True])
def test_margin_contract_parent_and_child_use_same_actual_frequency_and_frozen_sources(frozen_sample, monkeypatch, jammed):
    from types import SimpleNamespace
    flow, source, detail, tables, demands, _ = _parent_flow_sample(frozen_sample, monkeypatch)
    detail["nodes"] = detail["nodes"][:2]
    detail["devices"] = detail["devices"][:2]
    detail["links"] = detail["links"][:1]
    tables["node.csv"] = deepcopy(detail["nodes"])
    tables["device.csv"] = deepcopy(detail["devices"])
    tasks = flow.FQ.tasks_from_nets(detail["links"], detail["nodes"], detail["devices"], tables["device_model.csv"])
    flow.FQ.fill_ranges_by_node(tasks, detail["links"], detail["nodes"], detail["devices"], tables["device_model.csv"])
    flow.FQ._prepare(tasks, flow.FQ.FreqPool(tables["frequency_resource.csv"]))
    selected = tasks[0].allowed[-1]
    tables["frequency_resource.csv"] = [row for row in tables["frequency_resource.csv"] if row["freq_id"] == selected["freq_id"]]
    jam_rows = [] if not jammed else [{"interference_id": "UNIT-MARGIN-JAM", "name": "显式构造口径测试源",
        "lon": "114.005", "lat": "38.001", "center_freq_khz": str(selected["freq_khz"]),
        "bandwidth_khz": "1000", "tx_power_dbm": "100", "antenna_gain_dbi": "0",
        "antenna_height_m": "10", "duty_cycle": "1", "active": "true", "pattern_type": "OMNI",
        "interference_type": "NOISE", "azimuth_deg": ""}]
    tables["interference_source.csv"] = deepcopy(jam_rows)
    source["scene"]["interference_sources"] = [{"source_row": deepcopy(row)} for row in jam_rows]
    stations = flow.stations_from_nodes(detail["nodes"], detail["devices"], tables["device_model.csv"], tables["antenna_model.csv"])
    problem = SimpleNamespace(fm=SimpleNamespace(stations=stations))
    solution = {"relays": [], "m_req": 6.0, "uplinks": {0: 1}}
    frozen_topology = deepcopy((detail["links"], detail["nodes"], detail["devices"]))
    monkeypatch.setattr(flow, "rows_from_solution", lambda *args: deepcopy(frozen_topology))
    checked_uplinks = []
    real_check = flow.plan_check.check
    def check_with_explicit_uplinks(**kwargs):
        checked_uplinks.append(deepcopy(kwargs["uplinks"]))
        return real_check(**kwargs)
    monkeypatch.setattr(flow.plan_check, "check", check_with_explicit_uplinks)
    candidate = flow._check_candidate(problem, solution, stations, detail["nodes"], detail["devices"],
        tables["device_model.csv"], tables["antenna_model.csv"], frozen_sample[0].terrain_provider(),
        demands, demands, "MAX_RELIABILITY", "TERRAIN", tables["frequency_resource.csv"], [],
        dict(flow.MO.DEFAULT_CONSTRAINTS), interference_rows=jam_rows)
    detail.update(nodes=candidate["nodes"], devices=candidate["devices"], links=candidate["links"],
        params=candidate["params"], frequency=candidate["frequency"], routes=candidate["routes"],
        optimization={"best": {"fade_margin_db": 6.0}, "uplinks": deepcopy(candidate["uplinks"])})
    before = digest(source)
    expected_scenario = frozen_sample[0]._build(source)[1]
    expected = expected_scenario.link_state(expected_scenario.links[0])
    overrides = [{key: row[key] for key in ("device_id", "tx_power_dbm", "antenna_height_m")}
                 for row in candidate["params"]["params"]]
    refs = [{"device_id": row["device_id"]} for row in detail["devices"]]
    child = flow.run_from_parent({"detail": detail}, {"manual_override": overrides, "manual_paths": []},
        refs, "UNIT-TASK", demands, interference_rows=jam_rows, resource_rows=tables)
    parent_link, child_link = candidate["params"]["links"][0], child["params"]["links"][0]
    assert parent_link["freq_khz"] == child_link["freq_khz"] == selected["freq_khz"]
    assert parent_link["margin_db"] == pytest.approx(expected["margin_after"])
    assert child_link["margin_db"] == pytest.approx(parent_link["margin_db"])
    assert child_link["margin_before_interference_db"] == pytest.approx(expected["margin_before"])
    assert child["optimization"]["uplinks"] == candidate["uplinks"]
    assert checked_uplinks == [candidate["uplinks"], candidate["uplinks"]]
    assert child["optimization"]["best"]["objectives"] == candidate["objectives"]
    assert child["optimization"]["best"]["constraint_check"] == candidate["constraint_check"]
    assert parent_link["required_margin_db"] == child_link["required_margin_db"] == 6.0
    legacy = flow.RP.plan_bound_devices(stations, detail["links"], detail["devices"], tables["device_model.csv"],
        tables["antenna_model.csv"], frozen_sample[0].terrain_provider(), fade_margin_db=6.0, manual_override=overrides)
    assert abs(legacy["links"][0]["margin_db"] - expected["margin_before"]) > .02
    if jammed:
        assert parent_link["margin_db"] < 6.0 and not parent_link["meets"] and not child_link["meets"]
        assert not child["optimization"]["feasible"] and not candidate["check"]["passed"]
    assert digest(source) == before


def test_margin_contract_unassigned_frequency_never_falls_back_to_representative(frozen_sample, monkeypatch):
    flow, _, detail, tables, _, _ = _parent_flow_sample(frozen_sample, monkeypatch)
    stations = flow.stations_from_nodes(detail["nodes"], detail["devices"], tables["device_model.csv"], tables["antenna_model.csv"])
    terrain = frozen_sample[0].terrain_provider()
    params = flow.RP.plan_bound_devices(stations, detail["links"], detail["devices"], tables["device_model.csv"],
        tables["antenna_model.csv"], terrain, fade_margin_db=6.0)
    caps = flow.RP.capabilities_by_device(stations, detail["devices"], tables["device_model.csv"], tables["antenna_model.csv"])
    frequency = {"link_assignments": [{"link_id": row["link_id"], "freq_khz": None} for row in detail["links"]]}
    scenario = flow._actual_link_margins(stations, detail["links"], terrain, frequency, [], params,
        detail["devices"], tables["device_model.csv"], tables["antenna_model.csv"], [], caps)
    assert not scenario.links and params["summary"]["failed"] == len(params["links"])
    assert all(row["freq_khz"] is None and not row["meets"] for row in params["links"])
    assert all(row["margin_before_interference_db"] is None for row in params["links"])


@pytest.fixture
def actual_power_case(monkeypatch):
    """独立构造型号/网络及解析损耗桩，验证档位求解，不是主DEM证据。"""
    from types import SimpleNamespace
    from scripts.planning import sr4_flow as flow
    nodes = [{"node_id": name, "node_subtype": "III_MOBILE", "lon": 114 + index * .01, "lat": 38.0}
             for index, name in enumerate(("UNIT-A", "UNIT-B", "UNIT-C"))]
    models = [{"model_id": "UNIT-POWER-MODEL", "device_class": "VUHF", "freq_min_khz": "30000",
        "freq_max_khz": "300000", "tx_power_levels_dbm": "0;10;20;30", "tx_power_max_dbm": "30",
        "rx_sensitivity_dbm": "-120", "bandwidth_khz": "25"}]
    antennas = [{"antenna_id": "UNIT-POWER-ANT", "gain_dbi": "0", "pattern_type": "OMNI"}]
    devices = [{"device_id": "D-" + name, "node_id": name, "model_id": models[0]["model_id"],
        "antenna_id": antennas[0]["antenna_id"], "tx_power_dbm": "0", "antenna_height_m": "3"}
        for name in ("UNIT-A", "UNIT-B", "UNIT-C")]
    links = [{"link_id": name, "node_a_id": "UNIT-A", "node_b_id": other, "device_class": "VUHF",
        "device_a_id": "D-UNIT-A", "device_b_id": "D-" + other, "is_available": "true"}
        for name, other in (("EASY", "UNIT-B"), ("HARD", "UNIT-C"))]
    stations = flow.stations_from_nodes(nodes, devices, models, antennas)
    terrain = _modules()["terrain"].SyntheticTerrain((113.99, 37.99, 114.03, 38.01))
    required_snr = flow.IF.REQUIRED_SNR_DB[flow.IF.SERVICE_OF_BAND["VUHF"]]
    extra_loss = {"hard": 0.0}
    def loss(_terrain, pa, pb, frequency, _ha, _hb):
        hard = max(pa[0], pb[0]) > 114.015
        value = 100 - required_snr - 5 + (10 + extra_loss["hard"] if hard else 0) + (10 if frequency > 100000 else 0)
        return value, True, 0.0, 1000.0
    monkeypatch.setattr(flow.IF, "vuhf_path_loss", loss)
    monkeypatch.setattr(flow.IF, "noise_floor_dbm", lambda *_args: -100.0)
    monkeypatch.setattr(flow.IF, "interference_at", lambda _cache, jammers, *_args:
        {jam.jid: -90.0 for jam in jammers})
    def representative_margin(_terrain, sa, sb, _band, tx_a, tx_b, _ha, _hb):
        return min(tx_a, tx_b) + ( -5 if max(sa.lon, sb.lon) > 114.015 else 5), 1000.0, 80.0
    monkeypatch.setattr(flow.RP, "_margin_with", representative_margin)
    frequencies = {row["link_id"]: 200000.0 for row in links}
    def calculate(**kwargs):
        return flow.RP.plan_bound_devices(stations, links, devices, models, antennas, terrain,
            fade_margin_db=6.0, **kwargs)
    return SimpleNamespace(flow=flow, nodes=nodes, devices=devices, models=models, antennas=antennas,
        links=links, frequencies=frequencies, extra_loss=extra_loss, calculate=calculate)


def test_actual_power_repairs_recoverable_gap_and_honors_all_shared_device_links(actual_power_case):
    case = actual_power_case
    before = digest({key: getattr(case, key) for key in ("nodes", "devices", "models", "antennas", "links", "frequencies")})
    legacy = case.calculate()
    actual = case.calculate(frequency_by_link=case.frequencies, interference_rows=[])
    legacy_power = {row["device_id"]: row["tx_power_dbm"] for row in legacy["params"]}
    power = {row["device_id"]: row["tx_power_dbm"] for row in actual["params"]}
    assert legacy_power == {"D-UNIT-A": 20, "D-UNIT-B": 10, "D-UNIT-C": 20}
    assert power == {"D-UNIT-A": 30, "D-UNIT-B": 20, "D-UNIT-C": 30}
    assert not actual["failed_links"] and all(row["required_margin_db"] == 6.0 for row in actual["links"])
    assert actual["summary"]["total_radiated_w"] == 2.1
    assert actual["margin_basis"] == "ASSIGNED_FREQUENCY_WITH_INTERFERENCE"
    assert all(row["antenna_height_m"] == row["antenna_height_range_m"][1] for row in actual["params"])
    lower = case.calculate(frequency_by_link=case.frequencies, interference_rows=[], manual_override=[
        {"device_id": did, "tx_power_dbm": value - 10 if did == "D-UNIT-A" else value}
        for did, value in power.items()])
    assert {row["link_id"] for row in lower["failed_links"]} == {"HARD"}
    assert digest({key: getattr(case, key) for key in ("nodes", "devices", "models", "antennas", "links", "frequencies")}) == before


def test_actual_power_unreachable_link_keeps_best_margin_instead_of_trading_it_for_savings(actual_power_case):
    case = actual_power_case
    case.extra_loss["hard"] = 40.0
    actual = case.calculate(frequency_by_link=case.frequencies, interference_rows=[])
    by_id = {row["link_id"]: row for row in actual["links"]}
    power = {row["device_id"]: row["tx_power_dbm"] for row in actual["params"]}
    assert by_id["EASY"]["meets"] and not by_id["HARD"]["meets"]
    assert by_id["HARD"]["margin_db"] == pytest.approx(by_id["HARD"]["margin_at_allowed_power_db"])
    assert by_id["HARD"]["margin_at_max_power_db"] < 6.0
    assert power == {"D-UNIT-A": 30, "D-UNIT-B": 20, "D-UNIT-C": 30}


@pytest.mark.parametrize("freeze_all", [False, True])
def test_actual_power_never_rewrites_manual_or_adoption_frozen_power_and_height(actual_power_case, freeze_all):
    case = actual_power_case
    overrides = [{"device_id": "D-UNIT-A", "tx_power_dbm": 20, "antenna_height_m": 3},
                 {"device_id": "D-UNIT-C", "tx_power_dbm": 10, "antenna_height_m": 4}]
    if freeze_all:
        overrides.append({"device_id": "D-UNIT-B", "tx_power_dbm": 0, "antenna_height_m": 5})
    before = deepcopy(overrides)
    actual = case.calculate(frequency_by_link=case.frequencies, interference_rows=[], manual_override=overrides)
    parameters = {row["device_id"]: row for row in actual["params"]}
    for row in overrides:
        assert parameters[row["device_id"]]["tx_power_dbm"] == row["tx_power_dbm"]
        assert parameters[row["device_id"]]["antenna_height_m"] == row["antenna_height_m"]
    assert actual["failed_links"] and not actual["manual_errors"] and overrides == before


def test_actual_power_uses_selected_frequency_and_exact_frozen_jammers(actual_power_case):
    case = actual_power_case
    low = case.calculate(frequency_by_link={lid: 50000.0 for lid in case.frequencies}, interference_rows=[])
    clear = case.calculate(frequency_by_link=case.frequencies, interference_rows=[])
    source = [{"interference_id": "UNIT-J", "name": "构造解析功率测试源", "lon": "114.01", "lat": "38.0",
        "center_freq_khz": "200000", "bandwidth_khz": "25", "tx_power_dbm": "10", "antenna_gain_dbi": "0",
        "antenna_height_m": "3", "duty_cycle": "1", "active": "true", "pattern_type": "OMNI",
        "interference_type": "NOISE", "azimuth_deg": ""}]
    before = deepcopy(source)
    jammed = case.calculate(frequency_by_link=case.frequencies, interference_rows=source)
    assert low["summary"]["total_radiated_w"] < clear["summary"]["total_radiated_w"]
    assert not clear["failed_links"] and jammed["failed_links"]
    assert all(row["margin_before_interference_db"] > row["margin_db"] for row in jammed["links"])
    assert all(row["margin_db"] >= min(6.0, row["margin_at_allowed_power_db"]) - 1e-6 for row in jammed["links"])
    assert source == before


@pytest.mark.parametrize("missing", [False, True])
def test_actual_power_missing_frequency_keeps_gap_without_representative_fallback(actual_power_case, missing):
    case = actual_power_case
    frequencies = {"EASY": 200000.0}
    if not missing:
        frequencies["HARD"] = None
    actual = case.calculate(frequency_by_link=frequencies, interference_rows=[])
    row = next(row for row in actual["links"] if row["link_id"] == "HARD")
    assert not row["meets"] and row["freq_khz"] is None and row["margin_before_interference_db"] is None
    assert row["margin_at_max_power_db"] is None and row in actual["failed_links"]


@pytest.mark.parametrize("frequency", [float("nan"), float("inf"), 0, -1, True, 400000.0])
def test_actual_power_rejects_invalid_frequency_without_mutating_inputs(actual_power_case, frequency):
    case = actual_power_case
    before = deepcopy(case.devices)
    with pytest.raises(ValueError, match="实际功率求解频点"):
        case.calculate(frequency_by_link={"EASY": frequency, "HARD": 200000.0}, interference_rows=[])
    assert case.devices == before


def test_actual_power_legacy_keywords_are_exactly_backward_compatible(actual_power_case):
    case = actual_power_case
    assert case.calculate() == case.calculate(frequency_by_link=None, interference_rows=None)
    assert "margin_basis" not in case.calculate()
    assert case.calculate(frequency_by_link=case.frequencies) == case.calculate(
        frequency_by_link=case.frequencies, interference_rows=[])
    with pytest.raises(ValueError, match="绑定实际频点"):
        case.calculate(interference_rows=[])
