"""冻结覆盖纯模块测试；小栅格/载荷均为隔离构造，不是实测验收。"""
from copy import deepcopy
import array
import builtins
import gzip
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "algorithm-service", ROOT / "scripts", ROOT / "scripts/planning"):
    sys.path.insert(0, str(path))

from app import frozen_coverage_engine as engine
import feasibility
import terrain as terrain_module
import viewshed


FINGERPRINT = "a" * 64
SMALL = {"radius_m": 250, "cell_m": 250, "az_step_deg": 45,
         "margin_min_db": -100, "hf_max_km": 1, "ring_vertices": 24}


def small_terrain(path):
    for name, dtype, code, value, nodata in (("dem", "int16", "h", 100, -32768),
                                            ("lc", "uint8", "B", 40, None)):
        values = array.array(code, [value] * 41 * 41)
        raw = values.tobytes()
        metadata = {"crs": "EPSG:4326", "width": 41, "height": 41, "dtype": dtype,
                    "byteorder": sys.byteorder, "nodata": nodata,
                    "origin_lon": 113.8, "origin_lat": 37.21, "pixel_lon": 0.01, "pixel_lat": 0.01,
                    "bbox": [113.8, 36.8, 114.21, 37.21], "data_file": name + ".bin.gz",
                    "source": "UNIT_TEST_ONLY_NOT_MEASURED"}
        (path / (name + ".json")).write_text(json.dumps(metadata), encoding="utf-8")
        (path / (name + ".bin.gz")).write_bytes(gzip.compress(raw))
    return terrain_module.DemTerrain(str(path / "dem.json"), str(path / "lc.json"))


@pytest.fixture
def scenario(tmp_path):
    nodes = [{"node_id": "N1", "node_subtype": "UNIT", "lon": "114", "lat": "37"},
             {"node_id": "N2", "node_subtype": "UNIT", "lon": "114.001", "lat": "37.001"}]
    devices = [{"device_id": did, "node_id": nid, "model_id": "M1", "antenna_id": "A1",
                "tx_power_dbm": "99", "antenna_height_m": "999"}
               for did, nid in (("D1", "N1"), ("D2", "N1"), ("D3", "N2"))]
    plans = [{"device_id": d["device_id"], "node_id": d["node_id"], "model_id": "M1", "antenna_id": "A1",
              "band": "VUHF", "tx_power_dbm": 20 + i * 10, "antenna_height_m": 5 + i}
             for i, d in enumerate(devices)]
    links = [{"link_id": "L" + str(i), "node_a_id": "N1", "node_b_id": "N2",
              "device_a_id": did, "device_b_id": "D3", "device_class": "VUHF", "is_available": "true"}
             for i, did in enumerate(("D1", "D2"), 1)]
    raw = {"solution_id": "PL-UNIT", "terrain_fingerprint": FINGERPRINT, "detail": {
        "nodes": nodes, "devices": devices, "links": links, "params": {"params": plans},
        "frequency": {"link_assignments": [{"link_id": "L1", "freq_khz": 150000},
                                             {"link_id": "L2", "freq_khz": 160000}]}}}
    tables = {"device_model.csv": [{"model_id": "M1", "device_class": "VUHF", "freq_min_khz": "136000",
        "freq_max_khz": "174000", "rx_sensitivity_dbm": "-110", "bandwidth_khz": "25", "source": None}],
        "antenna_model.csv": [{"antenna_id": "A1", "gain_dbi": "2", "pattern_type": "OMNI",
                               "note": "UNIT构造参数，来源未知字段保留"}]}
    dem = small_terrain(tmp_path)
    return SimpleNamespace(raw=raw, tables=tables, dem=dem, factory=lambda: dem)


def compute(s, **kwargs):
    return engine.compute_frozen_coverage(s.raw, s.tables,
        **{"terrain": s.factory, "fingerprint": lambda: FINGERPRINT, "params": SMALL, **kwargs})


def fake_cells(monkeypatch, cells=None):
    calls = []

    def calculate(terrain, station, **kwargs):
        calls.append((station.sid, deepcopy(dict(station.radio["VUHF"])), kwargs))
        return SimpleNamespace(cells={(1, 0): 7.5} if cells is None else cells)

    monkeypatch.setattr(viewshed, "vuhf_coverage", calculate)
    return calls


def hf(s):
    model = s.tables["device_model.csv"][0]
    model.update(device_class="HF", freq_min_khz="3000", freq_max_khz="30000", bandwidth_khz="3")
    for row in s.raw["detail"]["params"]["params"]:
        row["band"] = "HF"
    for row in s.raw["detail"]["links"]:
        row["device_class"] = "HF"
    for row in s.raw["detail"]["frequency"]["link_assignments"]:
        row["freq_khz"] /= 15


def test_real_vuhf_native_cells_and_json(scenario):
    result = compute(scenario)
    assert result["status"] == "COMPLETE"
    assert [row["device_id"] for row in result["devices"]] == ["D1", "D2", "D3"]
    item = result["devices"][0]
    station = feasibility.Station("N1", 114, 37, "UNIT", {"VUHF": item["radio_parameters"]})
    native = viewshed.vuhf_coverage(scenario.dem, station, radius_m=250, cell_m=250, az_step=45,
                                   margin_min=-100, freq_khz=150000, rx_height_m=2)
    cells = item["computations"][0]["cells"]
    assert {(row["gx"], row["gy"]): row["margin_db"] for row in cells} == pytest.approx(native.cells)
    assert cells
    assert len(item["computations"][0]["geojson"]["features"]) == len(cells)
    assert result["provenance"]["units"]["margin_db"] == "dB"
    assert "field_strength" not in json.dumps(result)
    assert "dBuV/m" in result["provenance"]["limitations"][0]
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_each_physical_radio_uses_plan_power_height_and_own_frequencies(scenario, monkeypatch):
    calls = fake_cells(monkeypatch)
    result = compute(scenario)
    assert [(sid, radio["tx_dbm"], radio["height"], opts["freq_khz"]) for sid, radio, opts in calls] == [
        ("N1", 20, 5, 150000), ("N1", 30, 6, 160000), ("N2", 40, 7, 150000), ("N2", 40, 7, 160000)]
    assert [c["link_ids"] for c in result["devices"][2]["computations"]] == [["L1"], ["L2"]]
    assert result["devices"][0]["frozen_model"]["source"] is None
    assert "来源未知" in result["devices"][0]["frozen_antenna"]["note"]


def test_same_device_multiple_links_same_frequency_is_one_native_calculation(scenario, monkeypatch):
    scenario.raw["detail"]["frequency"]["link_assignments"][1]["freq_khz"] = 150000
    calls = fake_cells(monkeypatch)
    result = compute(scenario)
    assert len(calls) == 3
    assert result["devices"][2]["computations"][0]["link_ids"] == ["L1", "L2"]


def test_idle_device_kept_unavailable_without_representative_frequency(scenario, monkeypatch):
    fake_cells(monkeypatch)
    device = deepcopy(scenario.raw["detail"]["devices"][0])
    device["device_id"] = "D4"
    scenario.raw["detail"]["devices"].append(device)
    plan = deepcopy(scenario.raw["detail"]["params"]["params"][0])
    plan["device_id"] = "D4"
    scenario.raw["detail"]["params"]["params"].append(plan)
    result = compute(scenario)
    assert result["status"] == "PARTIAL"
    idle = result["devices"][-1]
    assert idle["status"] == "UNAVAILABLE" and idle["computations"] == []
    assert "代表频率" in idle["reasons"][0]


@pytest.mark.parametrize("table,field", [("device_model.csv", "rx_sensitivity_dbm"),
    ("device_model.csv", "bandwidth_khz"), ("device_model.csv", "freq_min_khz"),
    ("device_model.csv", "freq_max_khz"), ("antenna_model.csv", "gain_dbi"),
    ("antenna_model.csv", "pattern_type")])
def test_unknown_radio_does_not_impute_or_disappear(scenario, monkeypatch, table, field):
    calls = fake_cells(monkeypatch)
    scenario.tables[table][0][field] = None
    result = compute(scenario)
    assert result["status"] == "UNAVAILABLE" and len(result["devices"]) == 3
    assert all(row["radio_parameters"] is None and field in row["reasons"][0] for row in result["devices"])
    assert not calls


@pytest.mark.parametrize("field", ["tx_power_dbm", "antenna_height_m"])
def test_unknown_plan_does_not_use_device_original(scenario, monkeypatch, field):
    fake_cells(monkeypatch)
    scenario.raw["detail"]["params"]["params"][0][field] = None
    result = compute(scenario)
    assert result["status"] == "PARTIAL"
    assert result["devices"][0]["computations"] == []
    assert field in result["devices"][0]["reasons"][0]


@pytest.mark.parametrize("missing", ["model", "antenna", "plan", "band"])
def test_missing_frozen_resources_explicitly_unavailable(scenario, monkeypatch, missing):
    fake_cells(monkeypatch)
    if missing == "model":
        scenario.tables["device_model.csv"] = []
    elif missing == "antenna":
        scenario.tables["antenna_model.csv"] = []
    elif missing == "plan":
        scenario.raw["detail"]["params"]["params"] = []
    else:
        scenario.tables["device_model.csv"][0]["device_class"] = None
    result = compute(scenario)
    assert result["status"] == "UNAVAILABLE"
    assert all(row["reasons"] and row["computations"] == [] for row in result["devices"])


@pytest.mark.parametrize("kind", ["node", "device", "param", "link", "frequency", "model", "antenna"])
def test_duplicate_identity_rejects_entire_input(scenario, kind):
    detail = scenario.raw["detail"]
    rows = {"node": detail["nodes"], "device": detail["devices"], "param": detail["params"]["params"],
            "link": detail["links"], "frequency": detail["frequency"]["link_assignments"],
            "model": scenario.tables["device_model.csv"], "antenna": scenario.tables["antenna_model.csv"]}[kind]
    rows.append(deepcopy(rows[0]))
    with pytest.raises(engine.FrozenCoverageError, match="重复"):
        compute(scenario)


@pytest.mark.parametrize("change", ["device_node", "device_id", "missing_device_node", "link_band", "param_node",
                                    "param_model", "param_antenna", "param_band", "freq_range", "missing_freq", "foreign_freq"])
def test_reference_or_frequency_mismatch_rejected(scenario, monkeypatch, change):
    fake_cells(monkeypatch)
    detail = scenario.raw["detail"]
    if change == "device_node":
        detail["links"][0]["node_a_id"] = "N2"
    elif change == "device_id":
        detail["links"][0]["device_a_id"] = "OTHER"
    elif change == "missing_device_node":
        detail["devices"][0].pop("node_id")
    elif change == "link_band":
        detail["links"][0]["device_class"] = "HF"
    elif change.startswith("param_"):
        detail["params"]["params"][0][{"param_node": "node_id", "param_model": "model_id",
                                      "param_antenna": "antenna_id", "param_band": "band"}[change]] = "OTHER"
    elif change == "freq_range":
        detail["frequency"]["link_assignments"][0]["freq_khz"] = 200000
    elif change == "missing_freq":
        detail["frequency"]["link_assignments"].pop()
    else:
        detail["frequency"]["link_assignments"][0]["link_id"] = "OTHER"
    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario)
    assert error.value.code == "COVERAGE_INPUT"


def test_unavailable_link_never_uses_pool_or_frequency_fallback(scenario, monkeypatch):
    calls = fake_cells(monkeypatch)
    for link in scenario.raw["detail"]["links"]:
        link["is_available"] = "false"
    scenario.raw["detail"]["frequency"]["link_assignments"] = []
    scenario.tables["frequency_resource.csv"] = [{"center_freq_khz": 150000}]
    result = compute(scenario)
    assert result["status"] == "UNAVAILABLE" and not calls


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf"), True, "not-a-number"])
def test_illegal_plan_numeric_never_leaks_nan(scenario, value):
    scenario.raw["detail"]["params"]["params"][0]["tx_power_dbm"] = value
    with pytest.raises(engine.FrozenCoverageError):
        compute(scenario)


@pytest.mark.parametrize("params", [{"radius_m": 0}, {"radius_m": 120001}, {"cell_m": 249},
    {"cell_m": 5001}, {"radius_m": 250, "cell_m": 500}, {"az_step_deg": 0}, {"az_step_deg": 46},
    {"az_step_deg": 7}, {"hour": -1}, {"hour": 24}, {"hf_max_km": 0}, {"hf_max_km": 901},
    {"hf_max_km": 1.5}, {"ring_vertices": 23}, {"ring_vertices": 361}, {"ring_vertices": 25},
    {"rx_height_m": -1}, {"rx_height_m": 301}, {"margin_min_db": -101}, {"margin_min_db": 101},
    {"unknown": 1}, {"cell_m": True}, {"hour": float("nan")}, {"radius_m": None}, []])
def test_parameter_limits_reject_without_algorithm(scenario, monkeypatch, params):
    calls = fake_cells(monkeypatch)
    with pytest.raises(engine.FrozenCoverageError):
        compute(scenario, params=params)
    assert not calls


@pytest.mark.parametrize("limit,value", [("MAX_DEVICES", 2), ("MAX_COMPUTATIONS", 3), ("MAX_RAY_STEPS", 1)])
def test_work_limits_prevent_native_calculation(scenario, monkeypatch, limit, value):
    calls = fake_cells(monkeypatch)
    monkeypatch.setattr(engine, limit, value)
    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario)
    assert error.value.code == "COVERAGE_LIMIT" and not calls


def test_cell_output_limit_rejects_instead_of_silent_downsampling(scenario, monkeypatch):
    fake_cells(monkeypatch, {(1, 0): 1, (0, 1): 2})
    monkeypatch.setattr(engine, "MAX_CELLS", 1)
    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario)
    assert error.value.code == "COVERAGE_LIMIT"


@pytest.mark.parametrize("field,value", [("lon", 114.21), ("lat", 36.8), ("lon", 115), ("lat", 90)])
def test_out_of_dem_node_is_not_clamped(scenario, field, value):
    scenario.raw["detail"]["nodes"][0][field] = value
    with pytest.raises(engine.FrozenCoverageError):
        compute(scenario)


@pytest.mark.parametrize("kind", ["dem_nodata", "lc_nodata", "lc_unknown", "synthetic", "missing_grid", "crs", "bbox"])
def test_unknown_or_unverified_terrain_is_rejected(scenario, kind):
    if kind in ("dem_nodata", "lc_nodata", "lc_unknown"):
        raster = scenario.dem._dem if kind == "dem_nodata" else scenario.dem._lc
        col, row = raster.index(114, 37)
        if kind == "lc_nodata":
            raster.nodata = 255
        raster.data[row * raster.width + col] = raster.nodata if kind.endswith("nodata") else 77
    elif kind == "synthetic":
        scenario.dem.name = "SYNTHETIC"
    elif kind == "missing_grid":
        scenario.dem._dem = None
    elif kind == "crs":
        scenario.dem._dem.meta["crs"] = "UNKNOWN"
    else:
        scenario.dem.bbox = (0, 0, 1, 1)
    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario)
    assert error.value.code == "COVERAGE_TERRAIN"


def test_nodata_along_native_ray_does_not_become_zero_elevation(scenario):
    original = scenario.dem._dem.sample
    nodes = {(float(row["lon"]), float(row["lat"])) for row in scenario.raw["detail"]["nodes"]}

    def sample(lon, lat):
        return original(lon, lat) if (lon, lat) in nodes else None

    scenario.dem._dem.sample = sample
    with pytest.raises(engine.FrozenCoverageError, match="nodata"):
        compute(scenario)


@pytest.mark.parametrize("value", [None, "", "a" * 63, "g" * 64])
def test_invalid_frozen_fingerprint_does_not_load_terrain(scenario, value):
    scenario.raw["terrain_fingerprint"] = value
    loaded = []
    with pytest.raises(engine.FrozenCoverageError):
        compute(scenario, terrain=lambda: loaded.append(True))
    assert not loaded


@pytest.mark.parametrize("change_at", [0, 1, 2, 3])
def test_fingerprint_checked_before_load_after_load_and_before_return(scenario, monkeypatch, change_at):
    fake_cells(monkeypatch)
    calls = []

    def fingerprint():
        calls.append(True)
        return FINGERPRINT if len(calls) <= change_at else "b" * 64

    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario, fingerprint=fingerprint)
    assert error.value.code == "COVERAGE_TERRAIN_CHANGED"
    assert len(calls) == change_at + 1


def test_explicit_dem_factory_failure_never_uses_default(scenario, monkeypatch):
    monkeypatch.setattr(terrain_module, "default_terrain", lambda **_: pytest.fail("default terrain forbidden"))

    def factory():
        raise FileNotFoundError("missing measured grid")

    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario, terrain=factory)
    assert error.value.code == "COVERAGE_TERRAIN"


def test_initial_cancel_does_not_load_or_call_fingerprint(scenario):
    def forbidden():
        pytest.fail("cancelled work may not load")

    with pytest.raises(engine.FrozenCoverageCancelled):
        compute(scenario, terrain=forbidden, fingerprint=forbidden, cancelled=lambda: True)


def test_cancel_during_real_vuhf_terrain_sampling(scenario):
    requested, samples = False, 0
    original = scenario.dem._dem.sample

    def sample(lon, lat):
        nonlocal samples, requested
        samples += 1
        if samples == 6:
            requested = True
        return original(lon, lat)

    scenario.dem._dem.sample = sample
    with pytest.raises(engine.FrozenCoverageCancelled):
        compute(scenario, cancelled=lambda: requested)
    assert samples == 6


def test_cancel_inside_real_hf_budget_not_only_between_devices(scenario, monkeypatch):
    hf(scenario)
    requested, budgets = False, 0
    original = viewshed.link_budget

    def budget(*args, **kwargs):
        nonlocal requested, budgets
        budgets += 1
        requested = True
        return original(*args, **kwargs)

    monkeypatch.setattr(viewshed, "link_budget", budget)
    with pytest.raises(engine.FrozenCoverageCancelled):
        compute(scenario, cancelled=lambda: requested)
    assert budgets == 1


def test_cancel_in_final_progress_never_returns_publishable_result(scenario, monkeypatch):
    fake_cells(monkeypatch)
    requested = False

    def progress(value, stage):
        nonlocal requested
        if value == 1:
            requested = True

    with pytest.raises(engine.FrozenCoverageCancelled):
        compute(scenario, cancelled=lambda: requested, progress=progress)


def test_inputs_and_parameters_frozen_before_external_callbacks(scenario, monkeypatch):
    fake_cells(monkeypatch)
    before_raw, before_tables, options = deepcopy(scenario.raw), deepcopy(scenario.tables), dict(SMALL)

    def progress(value, stage):
        if value == 0:
            scenario.raw["detail"]["params"]["params"][0]["tx_power_dbm"] = 90
            scenario.tables["antenna_model.csv"][0]["gain_dbi"] = "80"
            options["cell_m"] = 5000

    result = compute(scenario, params=options, progress=progress)
    assert result["devices"][0]["radio_parameters"]["tx_dbm"] == 20
    assert result["devices"][0]["radio_parameters"]["gain"] == 2
    assert result["provenance"]["parameters"]["cell_m"] == 250
    assert result["provenance"]["raw_snapshot_sha256"] == engine._digest(before_raw)
    assert result["provenance"]["frozen_tables_sha256"] == engine._digest(before_tables)


def test_no_input_mutation_no_csv_default_database_or_cache_io(scenario, monkeypatch):
    before = deepcopy((scenario.raw, scenario.tables))
    monkeypatch.setattr(terrain_module, "default_terrain", lambda **_: pytest.fail("default terrain forbidden"))

    def forbidden(*args, **kwargs):
        pytest.fail("pure engine may not read current CSV or write business files")

    monkeypatch.setattr(builtins, "open", forbidden)
    monkeypatch.setattr(Path, "open", forbidden)
    result = compute(scenario)
    assert result["status"] == "COMPLETE"
    assert (scenario.raw, scenario.tables) == before


def test_real_hf_rings_keep_skip_zone_excluded_and_holes(scenario):
    hf(scenario)
    result = compute(scenario, params={**SMALL, "margin_min_db": 6})
    comp = result["devices"][0]["computations"][0]
    station = feasibility.Station("N1", 114, 37, "UNIT", {"HF": result["devices"][0]["radio_parameters"]})
    native = viewshed.hf_coverage_rings(scenario.dem, station, freq_khz=10000, hour=12, margin_min=6, max_km=1)
    assert [(r["inner_m"], r["outer_m"], r["note"]) for r in comp["rings"]] == native.rings
    skip = [r for r in comp["rings"] if r["outer_m"] > r["inner_m"] and "静区" in r["note"]]
    assert skip and not any(r["is_coverage"] for r in skip)
    features = comp["geojson"]["features"]
    assert any(not f["properties"]["is_coverage"] for f in features)
    annuli = [f for f in features if f["properties"]["inner_m"] > 0]
    assert annuli and all(len(f["geometry"]["coordinates"]) == 2 for f in annuli)

    def area(ring):
        return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2

    for feature in features:
        shell, *holes = feature["geometry"]["coordinates"]
        assert len(shell) == 25 and shell[0] == shell[-1] and area(shell) > 0
        assert all(hole[0] == hole[-1] and area(hole) < 0 for hole in holes)
    assert comp["cells"] == []
    assert "coverage_ratio" not in json.dumps(result)


def test_hf_day_night_passed_exactly_with_frozen_frequency(scenario, monkeypatch):
    hf(scenario)
    calls = []

    def rings(terrain, station, **kwargs):
        calls.append(kwargs)
        return SimpleNamespace(rings=[(0, 1000, "地波"), (1000, 2000, "静区"), (2000, 3000, "天波"), (0, 0, "注释")])

    monkeypatch.setattr(viewshed, "hf_coverage_rings", rings)
    result = compute(scenario, params={**SMALL, "hour": 23.5})
    assert all(row["hour"] == 23.5 and row["max_km"] == 1 for row in calls)
    assert [row["freq_khz"] for row in calls] == [10000, 160000 / 15, 10000, 160000 / 15]
    assert len(result["devices"][0]["computations"][0]["rings"]) == 4
    assert len(result["devices"][0]["computations"][0]["geojson"]["features"]) == 3


def test_hf_dateline_keeps_native_radii_without_false_polygon():
    native = SimpleNamespace(rings=[(1000, 500000, "天波")])
    result = engine._rings(native, {"lon": 179.9, "lat": 37, "device_id": "D", "node_id": "N"},
                           {"ring_vertices": 24}, lambda: None)
    assert result["rings"][0]["outer_m"] == 500000
    assert result["geojson"]["features"][0]["geometry"] is None
    assert "日期变更线" in result["geojson"]["features"][0]["properties"]["display_unavailable_reason"]


@pytest.mark.parametrize("cells", [{(1, 0): float("nan")}, {(1.5, 0): 5}, {(True, 0): 5}])
def test_invalid_native_cell_rejects_result(scenario, monkeypatch, cells):
    fake_cells(monkeypatch, cells)
    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario)
    assert error.value.code == "COVERAGE_RESULT"


def test_progress_exception_is_not_hidden_as_success(scenario):
    def progress(value, stage):
        raise RuntimeError("caller stopped")

    with pytest.raises(RuntimeError, match="caller stopped"):
        compute(scenario, progress=progress)


def test_provenance_distinguishes_receiver_and_assumed_ionosphere(scenario, monkeypatch):
    fake_cells(monkeypatch)
    result = compute(scenario, params={**SMALL, "hour": 23, "rx_height_m": 3})
    provenance = result["provenance"]
    assert provenance["receiver_assumptions"] == {"gain_dbi": 0, "vuhf_height_m": 3,
        "bandwidth_and_sensitivity": "same frozen device model", "service": {"HF": "话音", "VUHF": "数据"}}
    assert provenance["hf_ionosphere"]["foF2"] == viewshed.P533.FOF2_NIGHT_MHZ
    assert provenance["hf_ionosphere"]["assumed"] is True
    assert "待实测" in provenance["hf_ionosphere"]["verification"]
    assert provenance["terrain_metadata"]["dem"]["source"] == "UNIT_TEST_ONLY_NOT_MEASURED"


@pytest.mark.parametrize("failure", [FileNotFoundError("DEM unavailable"), ValueError("invalid grid")])
def test_fingerprint_provider_failure_is_typed(scenario, failure):
    def fingerprint():
        raise failure

    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario, fingerprint=fingerprint)
    assert error.value.code == "COVERAGE_TERRAIN"


def test_corrupt_dem_load_value_error_is_typed(scenario):
    def factory():
        raise ValueError("grid dimension mismatch")

    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario, terrain=factory)
    assert error.value.code == "COVERAGE_TERRAIN"


@pytest.mark.parametrize("failure", [ZeroDivisionError("native bad denominator"), ValueError("native failed")])
def test_native_algorithm_failure_cannot_publish_cache(scenario, monkeypatch, failure):
    def native(*args, **kwargs):
        raise failure

    monkeypatch.setattr(viewshed, "vuhf_coverage", native)
    with pytest.raises(engine.FrozenCoverageError) as error:
        compute(scenario)
    assert error.value.code == "COVERAGE_RESULT"


def test_nonstring_parameter_key_rejected(scenario):
    with pytest.raises(engine.FrozenCoverageError):
        compute(scenario, params={1: 2})


def test_native_cell_center_outside_dem_is_not_drawn_as_measured(scenario, monkeypatch):
    fake_cells(monkeypatch, {(1000, 1000): 9})
    result = compute(scenario)
    comp = result["devices"][0]["computations"][0]
    assert comp["cells"] == [{"gx": 1000, "gy": 1000, "margin_db": 9, "displayable": False}]
    assert comp["geojson"]["features"] == []
