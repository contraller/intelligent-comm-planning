"""V6 短波局地地形色面：构造 DEM 的行为回归，不代替现场传播验收。"""
from copy import deepcopy
import importlib
import json
import math

import pytest

from test_frozen_coverage_engine import FINGERPRINT, SMALL, hf, scenario
from app import coverage_field_surface as v5_surface
from app import frozen_coverage_engine as engine
from prop import p533


LOCAL = dict(radius_m=5000, cell_m=1000, hf_max_km=10, margin_min_db=-100)
SIGNAL_FIELDS = (
    "rx_power_dbm", "path_loss_db", "margin_db", "field_strength_dbuvm",
    "required_field_dbuvm", "strength_class", "is_coverage",
)


@pytest.fixture
def surface():
    # 核心可以晚于测试落盘；缺失实现应明确失败，不能静默跳过。
    return importlib.import_module("app.coverage_terrain_surface")


@pytest.fixture
def hf_case(scenario):
    hf(scenario)
    for row in scenario.raw["detail"]["frequency"]["link_assignments"]:
        row["freq_khz"] = 3000
    for row in scenario.raw["detail"]["params"]["params"]:
        row["tx_power_dbm"] = 0
    return scenario


@pytest.fixture
def ground_only(monkeypatch):
    # 使用原模型的不可用哨兵，仅隔离地波效应，不假定天波也应产生山影。
    monkeypatch.setattr(p533, "path_loss", lambda *a, **k: (1e9, {"reason": "UNIT_SKY_UNAVAILABLE"}))


def options(**overrides):
    return {**SMALL, **LOCAL, **overrides}


def calculate(s, *, parameters=None, **callbacks):
    return engine.compute_frozen_terrain_coverage(
        s.raw, s.tables, terrain=s.factory, fingerprint=lambda: FINGERPRINT,
        params=options(**(parameters or {})), **callbacks,
    )


def legacy(s, *, parameters=None):
    return engine.compute_frozen_field_coverage(
        s.raw, s.tables, terrain=s.factory, fingerprint=lambda: FINGERPRINT,
        params=options(**(parameters or {})),
    )


def part(result):
    return result["devices"][0]["computations"][0]


def cells(result):
    return {(row["gx"], row["gy"]): row for row in part(result)["cells"]}


def features(result):
    return {(row["properties"]["gx"], row["properties"]["gy"]): row
            for row in part(result)["geojson"]["features"]}


def ridge(s, side):
    # 沿原生像元整列设置山脊；发射站、地物、冻结电台参数不变。
    raster = s.dem._dem
    col, _ = raster.index(114 + side * 0.015, 37)
    for row in range(raster.height):
        raster.data[row * raster.width + col] = 2000


def native_item(s):
    old = legacy(s)
    device = deepcopy(old["devices"][0])
    return dict(device, frequency=device["computations"][0]["freq_khz"])


def test_v6_hf_uses_local_cells_but_retains_radial_explanation(hf_case, surface):
    before = deepcopy((hf_case.raw, hf_case.tables))
    result = calculate(hf_case)
    assert surface.VERSION == result["provenance"]["engine_version"] == "V01-6"
    assert surface.metadata()["hf_geometry"] == "P368_P533_LOCAL_TERRAIN_GRID"
    assert result["provenance"]["field_strength"] == surface.metadata()
    assert result["provenance"]["units"]["field_strength"] == "dBuV/m"
    assert result["status"] == "COMPLETE"
    for device in result["devices"]:
        for computation in device["computations"]:
            assert computation["shape"] == "CELLS" and computation["cells"]
            assert computation["radial_samples"] and computation["rings"]
            assert [row["distance_m"] for row in computation["radial_samples"]] == list(range(1000, 10001, 1000))
            assert all(row["properties"]["surface_kind"] == "TERRAIN_CELL"
                       for row in computation["geojson"]["features"])
    assert (hf_case.raw, hf_case.tables) == before
    assert json.loads(json.dumps(result, allow_nan=False)) == result


def test_hf_cells_and_colour_faces_share_the_v5_signal_contract(hf_case, surface, ground_only):
    result = calculate(hf_case)
    native_cells = cells(result)
    painted = features(result)
    assert painted and set(painted) == {key for key, row in native_cells.items() if row["is_coverage"]}
    for key, feature in painted.items():
        props = feature["properties"]
        assert props["device_id"] == "D1" and props["node_id"] == "N1"
        assert props["freq_khz"] == 3000 and props["is_coverage"] is True
        assert props["strength_class"] in ("WEAK", "MEDIUM", "STRONG")
        for field in SIGNAL_FIELDS:
            assert props[field] == native_cells[key][field]
        for field in SIGNAL_FIELDS[:5]:
            assert math.isfinite(props[field])


@pytest.mark.parametrize("side", [1, -1], ids=["east-ridge", "west-ridge"])
def test_one_sided_ridge_attenuates_ground_wave_only_on_obstructed_side(
    hf_case, surface, ground_only, side,
):
    flat = cells(calculate(hf_case))
    ridge(hf_case, side)
    obstructed = cells(calculate(hf_case))
    shadow, clear = (side * 4, 0), (-side * 4, 0)
    assert flat[shadow]["propagation_mode"] == obstructed[shadow]["propagation_mode"] == "GROUND"
    assert obstructed[shadow]["field_strength_dbuvm"] < flat[shadow]["field_strength_dbuvm"] - 3
    assert obstructed[clear]["field_strength_dbuvm"] == pytest.approx(flat[clear]["field_strength_dbuvm"])


def test_terrain_alone_changes_field_and_painted_geometry(hf_case, surface, ground_only):
    raw_before = deepcopy((hf_case.raw, hf_case.tables))
    raster = hf_case.dem._dem
    flat_dem = raster.data[:]
    flat_probe = calculate(hf_case)
    ridge(hf_case, 1)
    ridge_dem = raster.data[:]
    ridge_probe = calculate(hf_case)
    target = (4, 0)
    flat_margin = cells(flat_probe)[target]["margin_db"]
    ridge_margin = cells(ridge_probe)[target]["margin_db"]
    assert flat_margin > ridge_margin + 3
    # 以两次独立观测的中间值选显示门限，不重写传播或绕射公式作为预期。
    threshold = (flat_margin + ridge_margin) / 2
    assert -100 <= threshold <= 100
    raster.data[:] = flat_dem
    flat = calculate(hf_case, parameters={"margin_min_db": threshold})
    flat_saved = deepcopy(flat)
    raster.data[:] = ridge_dem
    changed = calculate(hf_case, parameters={"margin_min_db": threshold})
    assert flat["provenance"]["parameters"] == changed["provenance"]["parameters"]
    assert target in features(flat) and target not in features(changed)
    assert part(flat)["geojson"] != part(changed)["geojson"]
    assert cells(changed)[target]["field_strength_dbuvm"] < cells(flat)[target]["field_strength_dbuvm"]
    assert (hf_case.raw, hf_case.tables) == raw_before and flat == flat_saved


def test_viable_skywave_can_cross_ridge_without_artificial_shadow(hf_case, surface, monkeypatch):
    # 受控天波损耗只用于选择分支，不把该值当作实测或实际电离层参数。
    monkeypatch.setattr(p533, "path_loss", lambda *a, **k: (50.0, {"reason": "UNIT_AVAILABLE_SKY"}))
    flat = cells(calculate(hf_case))
    ridge(hf_case, 1)
    changed = cells(calculate(hf_case))
    assert flat[(4, 0)]["propagation_mode"] == changed[(4, 0)]["propagation_mode"] == "SKYWAVE"
    assert changed[(4, 0)]["field_strength_dbuvm"] == pytest.approx(flat[(4, 0)]["field_strength_dbuvm"])


def test_available_but_weaker_skywave_does_not_replace_better_ground_budget(hf_case, surface, monkeypatch):
    monkeypatch.setattr(p533, "path_loss", lambda *a, **k: (1e9, {"reason": "UNIT_UNAVAILABLE"}))
    ground = cells(calculate(hf_case))
    monkeypatch.setattr(p533, "path_loss", lambda *a, **k: (200.0, {"reason": "UNIT_WEAK_SKY"}))
    weak_sky = cells(calculate(hf_case))
    assert ground.keys() == weak_sky.keys() and ground
    for key, row in ground.items():
        assert row["propagation_mode"] == weak_sky[key]["propagation_mode"] == "GROUND"
        for field in SIGNAL_FIELDS:
            assert weak_sky[key][field] == row[field]


@pytest.mark.parametrize("mode", ["GROUND", "SKYWAVE"])
def test_ten_db_more_power_adds_ten_db_field_without_changing_path_loss(
    hf_case, surface, monkeypatch, mode,
):
    sky_loss = 1e9 if mode == "GROUND" else 50.0
    monkeypatch.setattr(p533, "path_loss", lambda *a, **k: (sky_loss, {"reason": "UNIT_MODE"}))
    ridge(hf_case, 1)
    original = calculate(hf_case)
    saved = deepcopy(original)
    hf_case.raw["detail"]["params"]["params"][0]["tx_power_dbm"] += 10
    higher = calculate(hf_case)
    before, after = cells(original), cells(higher)
    assert before.keys() == after.keys() and before
    assert before[(4, 0)]["propagation_mode"] == mode
    for key, row in before.items():
        assert after[key]["path_loss_db"] == pytest.approx(row["path_loss_db"])
        assert after[key]["field_strength_dbuvm"] - row["field_strength_dbuvm"] == pytest.approx(10)
        assert after[key]["margin_db"] - row["margin_db"] == pytest.approx(10)
    assert original == saved
    assert higher["devices"][1:] == original["devices"][1:]


@pytest.mark.parametrize("edge", ["west", "east", "south", "north"])
def test_only_finite_closed_grid_polygons_inside_dem_are_drawn(hf_case, surface, monkeypatch, edge):
    west, south, east, north = hf_case.dem.bbox
    lon, lat = {"west": (west + .0001, 37), "east": (east - .0001, 37),
                "south": (114, south + .0001), "north": (114, north - .0001)}[edge]
    for node in hf_case.raw["detail"]["nodes"]:
        node.update(lon=str(lon), lat=str(lat))
    sampled = []
    for raster in (hf_case.dem._dem, hf_case.dem._lc):
        original = raster.sample

        def sample(x, y, original=original):
            assert west <= x < east and south < y <= north
            sampled.append((x, y))
            return original(x, y)

        monkeypatch.setattr(raster, "sample", sample)
    result = calculate(hf_case, parameters={"radius_m": 10000, "cell_m": 2000, "hf_max_km": 60})
    painted = part(result)["geojson"]["features"]
    assert sampled and painted
    assert part(result)["max_distance_m"] == 60000
    for device in result["devices"]:
        for computation in device["computations"]:
            for feature in computation["geojson"]["features"]:
                geometry = feature["geometry"]
                assert geometry["type"] == "Polygon" and len(geometry["coordinates"]) == 1
                ring = geometry["coordinates"][0]
                assert len(ring) == 5 and ring[0] == ring[-1]
                assert len({tuple(point) for point in ring[:-1]}) == 4
                for x, y in ring:
                    assert math.isfinite(x) and math.isfinite(y)
                    assert west <= x <= east and south <= y <= north


@pytest.mark.parametrize("outside", [(113.7999, 37), (114.2101, 37), (114, 36.7999), (114, 37.2101)])
def test_station_outside_dem_is_rejected_without_edge_clamping(hf_case, surface, monkeypatch, outside):
    lon, lat = outside
    hf_case.raw["detail"]["nodes"][0].update(lon=str(lon), lat=str(lat))
    monkeypatch.setattr(surface, "hf_surface", lambda *a, **k: pytest.fail("DEM外站点不得产生覆盖"))
    with pytest.raises(engine.FrozenCoverageError, match="禁止边缘钳位") as error:
        calculate(hf_case)
    assert error.value.code == "COVERAGE_TERRAIN"


def test_dem_nodata_inside_hf_profile_is_rejected_instead_of_zero_filled(hf_case, surface, ground_only):
    raster = hf_case.dem._dem
    col, _ = raster.index(114.015, 37)
    for row in range(raster.height):
        raster.data[row * raster.width + col] = raster.nodata
    # 4km格心在缺测带之外；到格心的剖面必须跨过该带。
    assert raster.sample(114, 37) == 100 and raster.sample(114.045, 37) == 100
    with pytest.raises(engine.FrozenCoverageError, match="nodata") as error:
        calculate(hf_case, parameters={"radius_m": 4000, "cell_m": 4000})
    assert error.value.code == "COVERAGE_TERRAIN"


@pytest.mark.parametrize("kind", ["dem", "landcover"])
def test_station_nodata_is_rejected_before_any_hf_surface(hf_case, surface, monkeypatch, kind):
    raster = hf_case.dem._dem if kind == "dem" else hf_case.dem._lc
    if kind == "landcover":
        raster.nodata = 255
    col, row = raster.index(114, 37)
    raster.data[row * raster.width + col] = raster.nodata
    monkeypatch.setattr(surface, "hf_surface", lambda *a, **k: pytest.fail("未知站点不得计算传播面"))
    with pytest.raises(engine.FrozenCoverageError) as error:
        calculate(hf_case)
    assert error.value.code == "COVERAGE_TERRAIN"


def test_hf_surface_enforces_explicit_sample_budget(hf_case, surface, ground_only):
    item = native_item(hf_case)
    checked = engine._CheckedTerrain(hf_case.dem, lambda: None)
    with pytest.raises(ValueError, match="限额|预算|采样"):
        surface.hf_surface(checked, item, engine._parameters(options()), lambda: None, engine._circle, limit=1)


def test_each_hf_cell_uses_a_bounded_sixteen_segment_dem_profile(hf_case, surface, ground_only, monkeypatch):
    original, profiles, targets = engine._CheckedTerrain.profile, [], []

    def profile(terrain, lon1, lat1, lon2, lat2, n=64):
        profiles.append(n)
        targets.append((lon2, lat2))
        return original(terrain, lon1, lat1, lon2, lat2, n=n)

    monkeypatch.setattr(engine._CheckedTerrain, "profile", profile)
    result = calculate(hf_case)
    count = sum(len(computation["cells"]) for device in result["devices"]
                for computation in device["computations"])
    assert count > 0 and len(profiles) == count
    # 固定稀疏剖面预算，不随距离增长为无界采样；不复述绕射计算公式。
    assert set(profiles) == {16}
    painted = features(result)
    for row, target in zip(part(result)["cells"], targets):
        key = row["gx"], row["gy"]
        ring = painted[key]["geometry"]["coordinates"][0]
        lon = (ring[0][0] + ring[2][0]) / 2
        lat = (ring[0][1] + ring[2][1]) / 2
        if key == (0, 0):
            assert target != (lon, lat)
            assert ring[0][0] < target[0] < ring[2][0] and ring[0][1] < target[1] < ring[2][1]
        else:
            assert target == pytest.approx((lon, lat), abs=1e-10)


def test_engine_passes_decreasing_remaining_budget_to_each_hf_computation(hf_case, surface, monkeypatch):
    native, remaining = surface.hf_surface, []

    def limited(terrain, item, options, check, circle, limit=250000):
        remaining.append(limit)
        return native(terrain, item, options, check, circle, limit=limit)

    monkeypatch.setattr(surface, "hf_surface", limited)
    result = calculate(hf_case)
    expected_count = sum(len(device["computations"]) for device in result["devices"])
    assert len(remaining) == expected_count > 1 and remaining[0] == engine.MAX_CELLS
    assert all(0 <= b < a for a, b in zip(remaining, remaining[1:]))
    assert sum(len(computation["cells"]) for device in result["devices"]
               for computation in device["computations"]) <= engine.MAX_CELLS


def test_engine_rejects_hf_grid_over_budget_instead_of_silent_truncation(hf_case, surface, monkeypatch):
    monkeypatch.setattr(engine, "MAX_CELLS", 1)
    with pytest.raises(engine.FrozenCoverageError) as error:
        calculate(hf_case)
    assert error.value.code == "COVERAGE_LIMIT"


def test_cancel_before_start_does_not_load_dem_or_verify_fingerprint(hf_case, surface):
    def forbidden():
        pytest.fail("已取消计算不得加载地形或查询指纹")

    with pytest.raises(engine.FrozenCoverageCancelled):
        engine.compute_frozen_terrain_coverage(
            hf_case.raw, hf_case.tables, terrain=forbidden, fingerprint=forbidden,
            params=options(), cancelled=lambda: True,
        )


def test_cancel_inside_hf_dem_profile_stops_sampling(hf_case, surface, ground_only, monkeypatch):
    requested, samples = False, 0
    original = hf_case.dem._dem.sample

    def sample(lon, lat):
        nonlocal requested, samples
        samples += 1
        if samples == 12:
            requested = True
        return original(lon, lat)

    monkeypatch.setattr(hf_case.dem._dem, "sample", sample)
    with pytest.raises(engine.FrozenCoverageCancelled):
        calculate(hf_case, cancelled=lambda: requested)
    assert samples == 12


def test_cancel_inside_radial_explanation_stops_before_next_budget(hf_case, surface, monkeypatch):
    requested, calls = False, 0

    def sky(*args, **kwargs):
        nonlocal requested, calls
        calls += 1
        requested = True
        return 1e9, {"reason": "UNIT_CANCEL"}

    monkeypatch.setattr(p533, "path_loss", sky)
    with pytest.raises(engine.FrozenCoverageCancelled):
        calculate(hf_case, cancelled=lambda: requested)
    assert calls == 1


def test_changed_dem_fingerprint_never_returns_publishable_v6(hf_case, surface):
    calls = []

    def fingerprint():
        calls.append(True)
        return FINGERPRINT if len(calls) <= 2 else "b" * 64

    with pytest.raises(engine.FrozenCoverageError) as error:
        engine.compute_frozen_terrain_coverage(
            hf_case.raw, hf_case.tables, terrain=hf_case.factory, fingerprint=fingerprint, params=options(),
        )
    assert error.value.code == "COVERAGE_TERRAIN_CHANGED" and len(calls) == 3


def test_v5_hf_stays_rings_and_version_five_after_v6_runs(hf_case, surface):
    original = legacy(hf_case)
    frozen = deepcopy(original)
    calculate(hf_case)
    later = legacy(hf_case)
    assert original == frozen == later
    assert original["provenance"]["engine_version"] == v5_surface.VERSION == "V01-5"
    assert original["provenance"]["field_strength"]["hf_geometry"] == "P368_P533_RADIAL_BUDGET"
    assert part(original)["shape"] == "RINGS" and part(original)["rings"] and not part(original)["cells"]
    assert all(row["properties"]["surface_kind"] != "TERRAIN_CELL"
               for row in part(original)["geojson"]["features"])


def test_v6_cache_identity_and_read_only_v5_record_preservation(hf_case, surface, tmp_path, monkeypatch):
    from app import frozen_coverage_service as service_module

    # 只调用缓存读取及验证，不启动后台服务、HTTP或数据库。
    monkeypatch.delenv("AUTH_MODE", raising=False)
    source = dict(plan_id="P1", task_id="T1", snapshot_id="SNP-PL-UNIT", input_version="TV1",
                  condition_version="TC1", resource_revision="UNIT-RES", resource_content_hash="b" * 64,
                  input_snapshot={"unit_test": True}, raw_snapshot=hf_case.raw, tables=hf_case.tables)
    service = service_module.create_frozen_coverage_service(
        runtime_root=tmp_path / "cache", source_loader=lambda *a: source,
        fingerprint_provider=lambda: FINGERPRINT,
        engine=lambda *a, **k: pytest.fail("缓存读取不得重新计算"),
    )
    old_page = service.cache("P1", "T1", "SNP-PL-UNIT", options(), engine_version="V01-5")
    new_page = service.cache("P1", "T1", "SNP-PL-UNIT", options(), engine_version="V01-6")
    assert old_page["state"] == new_page["state"] == "MISS"
    assert old_page["cache_key"] != new_page["cache_key"]
    assert {**old_page["anchor"], "engine_version": "V01-6"} == new_page["anchor"]
    old_result = legacy(hf_case)
    body = dict(plan_id="P1", task_id="T1", snapshot_id="SNP-PL-UNIT", request_id="UNIT-OLD-HF",
                parameters=options())
    record = dict(kind=service_module.KIND, job_id="FCJ-" + "a" * 32, actor_id="UNIT-OWNER",
                  request_id=body["request_id"], request_body=body, request_digest=service_module._hash(body),
                  state="SUCCESS", from_cache=False, anchor=old_page["anchor"],
                  parameters=old_page["parameters"], cache_key=old_page["cache_key"],
                  bandwidth_selection_id=None, bandwidth_selection_hash=None,
                  result=old_result, result_sha256=service_module._hash(old_result))
    record_path = service.root / (record["job_id"] + ".json")
    service.root.mkdir(parents=True)
    service_module._atomic(record_path, record)
    persisted = record_path.read_bytes()
    old_hit = service.cache("P1", "T1", "SNP-PL-UNIT", options(), engine_version="V01-5")
    new_miss = service.cache("P1", "T1", "SNP-PL-UNIT", options(), engine_version="V01-6")
    assert old_hit["state"] == "HIT" and new_miss["state"] == "MISS" and new_miss["result"] is None
    assert old_hit["result"]["provenance"]["engine_version"] == "V01-5"
    assert part(old_hit["result"])["shape"] == "RINGS"
    assert service._result(record) == old_result
    returned = service._result(record)
    returned["provenance"]["engine_version"] = "V01-6"
    assert record["result"]["provenance"]["engine_version"] == "V01-5"
    assert record_path.read_bytes() == persisted
    forged = deepcopy(record)
    forged["anchor"] = new_page["anchor"]
    with pytest.raises(service_module.CoverageServiceError):
        service._result(forged)


def test_flat_hf_has_no_additional_terrain_loss(hf_case, surface, ground_only):
    result = calculate(hf_case)
    for device in result["devices"]:
        for computation in device["computations"]:
            assert computation["cells"]
            assert all(row["terrain_loss_db"] == pytest.approx(0, abs=1e-10)
                       for row in computation["cells"])


@pytest.mark.parametrize("band", ["HF", "VUHF"])
def test_v6_keeps_station_cell_and_v5_preserves_original_geometry(scenario, surface, band):
    if band == "HF":
        hf(scenario)
    parameters = dict(radius_m=1000, cell_m=1000, hf_max_km=2)
    old = legacy(scenario, parameters=parameters)
    frozen_old = deepcopy(old)
    current = calculate(scenario, parameters=parameters)
    central = cells(current)[(0, 0)]
    assert central["is_coverage"] is True and math.isfinite(central["field_strength_dbuvm"])
    assert (0, 0) in features(current)
    # 除中心补样外，其他格的传播结果沿用既有预算；HF修正平地基线另行验证。
    if band == "VUHF":
        old_cells = cells(old)
        assert (0, 0) not in old_cells
        assert {key: value for key, value in cells(current).items() if key != (0, 0)} == old_cells
    else:
        assert part(old)["shape"] == "RINGS" and not part(old)["cells"]
    assert old == frozen_old == legacy(scenario, parameters=parameters)
    assert old["provenance"]["engine_version"] == "V01-5"


@pytest.fixture(params=["HF", "VUHF"])
def full_terrain_result(scenario, request, ground_only):
    if request.param == "HF":
        hf(scenario)
        for assignment in scenario.raw["detail"]["frequency"]["link_assignments"]:
            assignment["freq_khz"] = 3000
    return calculate(scenario, parameters=dict(radius_m=1000, cell_m=1000, hf_max_km=2))


@pytest.mark.parametrize("change", [
    "missing_geometry", "null_geometry", "empty_coordinates", "open_ring", "degenerate",
    "triangle", "bow_tie", "hole", "nan_coordinate", "bool_coordinate", "string_coordinate",
    "point_arity", "shifted", "wrong_size", "outside_dem",
])
def test_full_validator_rejects_invalid_or_unrelated_grid_polygon(full_terrain_result, change):
    result = full_terrain_result
    feature = features(result)[(0, 0)]
    geometry = feature["geometry"]
    ring = geometry["coordinates"][0]
    if change == "missing_geometry":
        del feature["geometry"]
    elif change == "null_geometry":
        feature["geometry"] = None
    elif change == "empty_coordinates":
        geometry["coordinates"] = []
    elif change == "open_ring":
        ring.pop()
    elif change == "degenerate":
        geometry["coordinates"] = [[deepcopy(ring[0]) for _ in range(5)]]
    elif change == "triangle":
        geometry["coordinates"] = [[ring[0], ring[1], ring[2], ring[0]]]
    elif change == "bow_tie":
        ring[1], ring[2] = ring[2], ring[1]
    elif change == "hole":
        geometry["coordinates"].append(deepcopy(ring))
    elif change in ("nan_coordinate", "bool_coordinate", "string_coordinate"):
        ring[0][0] = {"nan_coordinate": float("nan"), "bool_coordinate": True,
                      "string_coordinate": str(ring[0][0])}[change]
    elif change == "point_arity":
        ring[0].append(0)
    elif change == "shifted":
        for coordinate in ring:
            coordinate[0] += .001
    elif change == "wrong_size":
        for coordinate in ring:
            coordinate[0] = 114 + (coordinate[0] - 114) / 2
            coordinate[1] = 37 + (coordinate[1] - 37) / 2
    else:
        ring[0][0] = result["provenance"]["dem_bbox"][0] - .001
    with pytest.raises(engine.FrozenCoverageError) as error:
        engine.validate_terrain_result(result)
    assert error.value.code == "COVERAGE_RESULT"


@pytest.mark.parametrize("change", [
    "missing_cells", "duplicate_cell", "missing_feature", "duplicate_feature", "orphan_feature",
    "cell_field", "feature_field", "cell_only_extra", "feature_only_extra", "raw_bool_index",
    "feature_bool_index", "raw_nan_field", "wrong_cell_count", "origin", "resolution", "radius",
    "centre_outside_radius", "below_threshold_feature",
])
def test_full_validator_binds_raw_cells_features_and_frozen_grid(full_terrain_result, change):
    result = full_terrain_result
    computation = part(result)
    raw = cells(result)[(0, 0)]
    feature = features(result)[(0, 0)]
    props = feature["properties"]
    if change == "missing_cells":
        del computation["cells"]
    elif change == "duplicate_cell":
        computation["cells"].append(deepcopy(raw))
        computation["evaluated_samples"] += 1
    elif change == "missing_feature":
        computation["geojson"]["features"].remove(feature)
    elif change == "duplicate_feature":
        computation["geojson"]["features"].append(deepcopy(feature))
    elif change == "orphan_feature":
        props["gx"] = 99
    elif change == "cell_field":
        raw["field_strength_dbuvm"] += 100
    elif change == "feature_field":
        props["field_strength_dbuvm"] += 100
    elif change == "cell_only_extra":
        raw["unknown_extra"] = 1
    elif change == "feature_only_extra":
        props["unknown_extra"] = 1
    elif change == "raw_bool_index":
        raw["gx"] = True
    elif change == "feature_bool_index":
        props["gx"] = False
    elif change == "raw_nan_field":
        raw["path_loss_db"] = float("nan")
    elif change == "wrong_cell_count":
        computation["evaluated_samples"] += 1
    elif change == "origin":
        computation["origin"][0] += .001
    elif change == "resolution":
        computation["cell_m"] *= 2
    elif change == "radius":
        computation["radius_m"] *= 2
    elif change == "centre_outside_radius":
        raw["gx"] = props["gx"] = 10
        width = feature["geometry"]["coordinates"][0][1][0] - feature["geometry"]["coordinates"][0][0][0]
        for coordinate in feature["geometry"]["coordinates"][0]:
            coordinate[0] += 10 * width
    else:
        device = result["devices"][0]
        signal = v5_surface.signal_values(device["radio_parameters"], 1000, computation["freq_khz"],
            "话音" if device["band"] == "HF" else "数据", result["provenance"]["parameters"]["margin_min_db"])
        raw.update(signal)
        props.update(signal)
        assert raw["is_coverage"] is False
    with pytest.raises(engine.FrozenCoverageError) as error:
        engine.validate_terrain_result(result)
    assert error.value.code == "COVERAGE_RESULT"


@pytest.mark.parametrize("order", ["reversed", "rotated"])
def test_full_validator_accepts_equivalent_closed_rectangle_winding(full_terrain_result, order):
    result = full_terrain_result
    geometry = features(result)[(0, 0)]["geometry"]
    vertices = geometry["coordinates"][0][:-1]
    vertices = list(reversed(vertices)) if order == "reversed" else vertices[2:] + vertices[:2]
    geometry["coordinates"] = [vertices + [deepcopy(vertices[0])]]
    before = deepcopy(result)
    engine.validate_terrain_result(result)
    assert result == before


def test_full_validator_keeps_uncovered_raw_cells_without_drawing_them(full_terrain_result):
    result = full_terrain_result
    minimum = result["provenance"]["parameters"]["margin_min_db"]
    for device in result["devices"]:
        for computation in device["computations"]:
            for row in computation["cells"]:
                row.update(v5_surface.signal_values(device["radio_parameters"], 1000, computation["freq_khz"],
                    "话音" if device["band"] == "HF" else "数据", minimum))
                assert row["is_coverage"] is False
            computation["geojson"]["features"] = []
    before = deepcopy(result)
    engine.validate_terrain_result(result)
    assert result == before and part(result)["cells"] and not features(result)


def test_full_validator_rejects_grid_budget_overflow(full_terrain_result, monkeypatch):
    monkeypatch.setattr(engine, "MAX_CELLS", 1)
    with pytest.raises(engine.FrozenCoverageError) as error:
        engine.validate_terrain_result(full_terrain_result)
    assert error.value.code == "COVERAGE_RESULT"


def test_v6_unavailable_devices_do_not_require_computed_grid(scenario, surface):
    scenario.tables["device_model.csv"] = []
    result = calculate(scenario)
    assert result["status"] == "UNAVAILABLE"
    assert all(device["band"] is None and not device["computations"] for device in result["devices"])
    engine.validate_terrain_result(result)


@pytest.mark.parametrize("band", ["HF", "VUHF"])
def test_real_v6_below_threshold_keeps_central_sample_without_painting(scenario, surface, band):
    if band == "HF":
        hf(scenario)
    for planned in scenario.raw["detail"]["params"]["params"]:
        planned["tx_power_dbm"] = -50
    result = calculate(scenario, parameters=dict(radius_m=1000, cell_m=1000, hf_max_km=2, margin_min_db=100))
    assert cells(result)[(0, 0)]["is_coverage"] is False
    assert all(not computation["geojson"]["features"] for device in result["devices"]
               for computation in device["computations"])
    engine.validate_terrain_result(result)


def test_v6_cache_validates_full_persisted_result_before_projecting(hf_case, surface, tmp_path, monkeypatch):
    from app import frozen_coverage_service as service_module

    monkeypatch.delenv("AUTH_MODE", raising=False)
    result = calculate(hf_case)
    source = dict(plan_id="P1", task_id="T1", snapshot_id="SNP-PL-UNIT", input_version="TV1",
                  condition_version="TC1", resource_revision="UNIT-RES", resource_content_hash="b" * 64,
                  input_snapshot={"unit_test": True}, raw_snapshot=hf_case.raw, tables=hf_case.tables)
    service = service_module.create_frozen_coverage_service(
        runtime_root=tmp_path / "cache-v6", source_loader=lambda *a: source,
        fingerprint_provider=lambda: FINGERPRINT,
        engine=lambda *a, **k: pytest.fail("缓存读取不得重新计算"),
    )
    page = service.cache("P1", "T1", "SNP-PL-UNIT", options(), engine_version="V01-6")
    body = dict(plan_id="P1", task_id="T1", snapshot_id="SNP-PL-UNIT", request_id="UNIT-FULL-V6",
                parameters=options())
    record = dict(kind=service_module.KIND, job_id="FCJ-" + "b" * 32, actor_id="UNIT-OWNER",
                  request_id=body["request_id"], request_body=body, request_digest=service_module._hash(body),
                  state="SUCCESS", from_cache=False, anchor=page["anchor"], parameters=page["parameters"],
                  cache_key=page["cache_key"], bandwidth_selection_id=None, bandwidth_selection_hash=None,
                  result=result, result_sha256=service_module._hash(result))
    service.root.mkdir(parents=True)
    path = service.root / (record["job_id"] + ".json")
    service_module._atomic(path, record)
    persisted = path.read_bytes()
    validate, checks = engine.validate_terrain_result, []

    def full_only(value):
        assert all("cells" in computation for device in value["devices"] for computation in device["computations"])
        checks.append(True)
        validate(value)

    monkeypatch.setattr(engine, "validate_terrain_result", full_only)
    hit = service.cache("P1", "T1", "SNP-PL-UNIT", options(), engine_version="V01-6")
    assert hit["state"] == "HIT" and checks
    assert "cells" not in part(hit["result"]) and "radial_samples" not in part(hit["result"])
    assert path.read_bytes() == persisted
    # 投影本身不具备完整校验所需的原始格网，不能冒充完整持久结果。
    with pytest.raises(engine.FrozenCoverageError) as error:
        validate(hit["result"])
    assert error.value.code == "COVERAGE_RESULT"


def test_persisted_result_validates_in_fresh_process_without_prior_calculation(hf_case, tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import sys
    result = calculate(hf_case)
    file = tmp_path / "complete.json"
    file.write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
    environment = {key: value for key, value in os.environ.items() if key != "PYTHONPATH"}
    code = ("import json,sys;sys.path.insert(0,sys.argv[1]);"
            "from app.frozen_coverage_engine import validate_terrain_result;"
            "validate_terrain_result(json.load(open(sys.argv[2],encoding='utf-8')))")
    completed = subprocess.run([sys.executable, "-B", "-c", code,
        str(Path(engine.__file__).resolve().parents[1]), str(file)],
        cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=20)
    assert completed.returncode == 0, completed.stderr
