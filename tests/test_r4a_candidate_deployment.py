"""R4-A轻量原生筛选/部署验证；构造小场景，不加载完整DEM。"""
from __future__ import annotations

import copy
import csv
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "scripts", ROOT / "scripts/planning"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import deployment as D
import deployment_inputs as DI
from candidate_sites import in_exclusion_polygon, validate_exclusion_polygon
from feasibility import Station
from plan_pipeline import topology_from_deployment


class Raster:
    bbox = (113.0, 36.0, 115.0, 38.0)

    def sample(self, lon, lat):
        return 100.0


class FlatTerrain:
    _dem = Raster()
    bbox = Raster.bbox

    def elevation(self, lon, lat):
        return 100.0

    def slope_deg(self, lon, lat):
        return 0.0

    def landcover(self, lon, lat):
        return "草地"

    def profile(self, lon1, lat1, lon2, lat2, n=64):
        from terrain import haversine_m
        distance = haversine_m(lon1, lat1, lon2, lat2)
        return [(distance * index / n, 100.0) for index in range(n + 1)]


def radio(height=10.0):
    return dict(tx_dbm=50.0, gain=3.0, height=height, sens=-120.0, bw=3.0,
                pattern="OMNI", fmin=3000.0, fmax=30000.0)


def base_stations():
    return [Station("base", 114.0, 37.0, "I_MOBILE", {"HF": radio()}),
            Station("leaf", 114.02, 37.0, "MANPACK", {"HF": radio()})]


def candidate(site_id="CS-1", **changes):
    return dict(dict(site_id=site_id, lon=114.01, lat=37.0, elevation_m=100,
        slope_deg=5, landcover_type="草地", nearest_road_distance_m=500,
        nearest_node_distance_m=800, score=70, is_deployable="true"), **changes)


def conditions(**changes):
    return dict(dict(maxSlopeDeg=None, elevationRangeM=None, allowedLandcover=None,
        roadMaxDistanceM=None, minSiteSpacingM=None, losRequiredNodeIds=[], gridStepM=None,
        forcedInclude=[], forcedExcludePolygons=[]), **changes)


def metadata(c=None, solve=None, bbox=(113.9, 36.9, 114.1, 37.1)):
    return dict(schema_version=1, bbox=list(bbox), stationIds=["base", "leaf"],
                deploymentConstraints=c, deploymentSolve=solve)


def prepare(rows, c=None, *, terrain=None, stations=None, bbox=(113.9, 36.9, 114.1, 37.1)):
    stations = base_stations() if stations is None else stations
    nodes = [dict(node_id=s.sid, lon=s.lon, lat=s.lat) for s in stations]
    return DI.prepare_candidates(rows, metadata(c, bbox=bbox), terrain or FlatTerrain(), nodes, stations)


def polygon():
    return dict(type="Polygon", coordinates=[
        [[114, 37], [114.1, 37], [114.1, 37.1], [114, 37.1], [114, 37]],
        [[114.02, 37.02], [114.08, 37.02], [114.08, 37.08], [114.02, 37.08], [114.02, 37.02]]])


def test_no_advanced_conditions_preserve_frozen_candidate_order_and_values():
    rows = [candidate("b"), candidate("a", lon=114.011)]
    before = copy.deepcopy(rows)
    accepted, info = prepare(rows)
    assert accepted == rows == before
    assert [row["site_id"] for row in info["candidates"]] == ["b", "a"]
    assert info["accepted_count"] == 2
    assert not any(info["rejected_stats"].values())
    assert prepare(rows, conditions())[0] == accepted


def test_bbox_only_excludes_new_candidates_without_changing_original_nodes():
    stations = base_stations()
    stations[0].lon = 113.5
    accepted, info = prepare([candidate(), candidate("outside", lon=114.5)], stations=stations)
    assert [row["site_id"] for row in accepted] == ["CS-1"]
    assert stations[0].lon == 113.5
    assert info["rejected_stats"]["outside_bbox"] == 1


@pytest.mark.parametrize("condition,changes,reason", [
    ({"maxSlopeDeg": 4}, {}, "slope"),
    ({"maxSlopeDeg": 0}, {}, "slope"),
    ({"elevationRangeM": [200, 300]}, {}, "elevation"),
    ({"allowedLandcover": ["裸地"]}, {}, "landcover"),
    ({"roadMaxDistanceM": 499}, {}, "road"),
    ({"roadMaxDistanceM": 0}, {}, "road"),
    ({"maxSlopeDeg": 10}, {"is_deployable": "false"}, "source_rule"),
])
def test_each_existing_candidate_condition_changes_solver_input(condition, changes, reason):
    accepted, info = prepare([candidate(**changes)], conditions(**condition))
    assert not accepted
    assert info["rejected_stats"][reason] == 1
    assert info["candidates"][0]["is_deployable"] is False


@pytest.mark.parametrize("attribute,condition", [
    ("slope_deg", {"maxSlopeDeg": 10}),
    ("elevation_m", {"elevationRangeM": [0, 200]}),
    ("landcover_type", {"allowedLandcover": ["草地"]}),
    ("nearest_road_distance_m", {"roadMaxDistanceM": 1000}),
])
def test_missing_input_is_distinct_from_constraint_rejection(attribute, condition):
    accepted, info = prepare([candidate(**{attribute: None})], conditions(**condition))
    assert not accepted
    assert info["candidates"][0]["is_deployable"] is None
    assert info["rejected_stats"]["data_unavailable"] == 1
    assert info["unavailable_reasons"][0]["site_id"] == "CS-1"
    assert set(info["unavailable_reasons"][0]) == {"site_id", "field", "reason"}
    assert all(isinstance(label, str) for label in info["data_sources"])


@pytest.mark.parametrize("point,excluded", [
    ((114.01, 37.01), True), ((114.05, 37.05), False),
    ((114, 37.05), True), ((114.02, 37.05), True), ((113.9, 37), False),
])
def test_exclusion_polygon_preserves_holes_and_excludes_boundaries(point, excluded):
    validate_exclusion_polygon(polygon())
    assert in_exclusion_polygon(*point, polygon()) is excluded


def test_self_intersecting_polygon_is_rejected_instead_of_guessed():
    crossed = dict(type="Polygon", coordinates=[[
        [114, 37], [114.1, 37.1], [114.1, 37], [114, 37.1], [114, 37]]])
    with pytest.raises(ValueError, match="自相交"):
        prepare([candidate()], conditions(forcedExcludePolygons=[crossed]))


def test_advanced_conditions_cannot_use_synthetic_terrain_fallback():
    terrain = SimpleNamespace(elevation=lambda *_: 0, landcover=lambda *_: "草地")
    with pytest.raises(DI.DataUnavailable, match="禁止使用合成地形回退"):
        prepare([candidate()], conditions(maxSlopeDeg=10), terrain=terrain)


def test_forced_point_cannot_bypass_exclusion_or_task_bounds():
    with pytest.raises(ValueError, match="强制部署点"):
        prepare([], conditions(forcedInclude=[dict(lon=114.01, lat=37.01)], forcedExcludePolygons=[polygon()]))
    with pytest.raises(ValueError, match="outside_bbox"):
        prepare([], conditions(forcedInclude=[dict(lon=114.5, lat=37.0)]))


def test_forced_points_are_not_lost_by_spacing_thinning():
    accepted, info = prepare([candidate(), candidate("near", lon=114.0101)],
        conditions(minSiteSpacingM=100, forcedInclude=[dict(lon=114.01, lat=37.0)]))
    assert len(accepted) == 1 and accepted[0]["forced"]
    assert info["rejected_stats"]["spacing"] == 1


def test_explicit_grid_step_changes_native_candidate_coordinates():
    box = (114.0, 37.0, 114.01, 37.01)
    coarse, info = prepare([candidate("original")], conditions(gridStepM=1000), bbox=box)
    fine, _ = prepare([candidate("original")], conditions(gridStepM=500), bbox=box)
    assert len(fine) > len(coarse) > 0
    assert info["source"] == "TERRAIN_GRID"
    assert all(row["site_id"].startswith("R4-GRID-") for row in coarse)
    assert all(DI.inside(row["lon"], row["lat"], box) for row in fine)


def test_new_point_dem_nodata_is_never_zero_filled():
    terrain = FlatTerrain()
    terrain._dem = SimpleNamespace(bbox=Raster.bbox, sample=lambda *_: None)
    accepted, info = prepare([], conditions(gridStepM=1000), terrain=terrain,
                             bbox=(114, 37, 114.001, 37.001))
    assert not accepted
    assert info["candidates"][0]["elevation_m"] is None
    assert info["unavailable_reasons"]
    assert info["rejected_stats"]["data_unavailable"] == 1


def test_los_uses_frozen_heights_and_excludes_missing_target():
    accepted, info = prepare([candidate()], conditions(losRequiredNodeIds=["base"]))
    assert accepted and accepted[0]["eligible_subtypes"]
    assert info["candidates"][0]["visible_node_count"] == 1
    accepted, info = prepare([candidate()], conditions(losRequiredNodeIds=["unknown"]))
    assert not accepted
    assert info["candidates"][0]["is_deployable"] is None
    assert "unknown" in info["unavailable_reasons"][0]["reason"]


def test_los_with_missing_actual_height_is_unavailable():
    stations = base_stations()
    stations[0].radio["HF"]["height"] = None
    accepted, info = prepare([candidate()], conditions(losRequiredNodeIds=["base"]), stations=stations)
    assert not accepted
    assert info["rejected_stats"]["data_unavailable"] == 1


def test_native_p1_deploys_relay_without_moving_existing_stations():
    stations = base_stations()
    before = [(s.sid, s.lon, s.lat) for s in stations]
    fm, sol = D.p1_solve(stations, [candidate()], FlatTerrain(), types=("VEHICLE_A",), refine=False)
    assert sol.count == 1 and not sol.unconnected
    assert [(s.sid, s.lon, s.lat) for s in fm.stations[:2]] == before
    assert fm.margin_min == 6.0


def test_native_p2_zero_and_forced_points_obey_count():
    fm, _ = D.p1_solve(base_stations(), [candidate()], FlatTerrain(), types=("VEHICLE_A",), refine=False)
    zero = D.p2_solve(fm, [0, 1], [2], 0, enforce_sites=True)
    assert zero.count == 0 and zero.unconnected
    forced = D.p2_solve(fm, [0, 1], [2], 1, enforce_sites=True, required_site_ids=["CS-1"])
    assert forced.count == 1 and not forced.unconnected
    with pytest.raises(ValueError, match="小于强制"):
        D.p2_solve(fm, [0, 1], [2], 0, enforce_sites=True, required_site_ids=["CS-1"])


def test_native_required_sites_are_not_removed_as_redundant():
    stations = [base_stations()[0]]
    fm, sol = D.p1_solve(stations, [candidate()], FlatTerrain(), types=("VEHICLE_A",),
        refine=False, enforce_sites=True, required_site_ids=["CS-1"])
    assert sol.count == 1
    assert D.candidate_site_id(fm.stations[sol.added[0][0]]) == "CS-1"


def test_native_forced_spacing_conflict_is_explicit():
    with pytest.raises(ValueError, match="间距冲突"):
        D.p1_solve(base_stations(), [candidate("a"), candidate("b", lon=114.0101)], FlatTerrain(),
            types=("VEHICLE_A",), refine=False, enforce_sites=True,
            required_site_ids=["a", "b"], min_site_spacing_m=100)


def test_default_topology_matches_same_native_call_with_empty_conditions():
    stations = base_stations()
    stations.append(Station("dual", 114.03, 37.0, "III_MOBILE", {
        "HF": radio(), "VUHF": dict(radio(), bw=25.0, fmin=136000.0, fmax=174000.0)}))
    rows = [candidate()]
    # 保留原生求解与物理矩阵，仅对比入口参数是否引入额外行为。
    first = topology_from_deployment(stations, FlatTerrain(), candidate_rows=rows)
    second = topology_from_deployment(stations, FlatTerrain(), candidate_rows=rows,
        deployment_options=metadata(conditions()))
    assert first[1].added == second[1].added
    assert first[1].parent_of == second[1].parent_of
    assert first[2] == second[2]


def test_r3_default_planning_bbox_preserves_entire_original_candidate_set():
    path = ROOT / "data/synthetic/nodes/candidate_sites_v1.csv"
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.DictReader(stream))
    box = json.loads((ROOT / "data/raw/dem/dem_current.json").read_text(encoding="utf-8"))["planning_bbox"]
    accepted, info = prepare(rows, bbox=box)
    assert [row["site_id"] for row in accepted] == [row["site_id"] for row in rows]
    assert info["accepted_count"] == len(rows)


def test_explicit_forced_point_does_not_use_frozen_table_rounding_tolerance():
    with pytest.raises(ValueError, match="outside_bbox"):
        prepare([], conditions(forcedInclude=[dict(lon=113.9999997, lat=37)]),
                bbox=(114, 36.9, 114.1, 37.1))


def test_final_los_rechecks_actual_planned_heights():
    rows = [candidate()]
    sites = [dict(site_id="CS-1", node_id="new", lon=114.01, lat=37.0,
                  subtype="VEHICLE_A", forced=False)]
    meta = metadata(conditions(losRequiredNodeIds=["base"]))
    nodes = [dict(node_id="base", lon=114, lat=37)]
    params = dict(params=[dict(node_id="new", band="HF", antenna_height_m=0),
                          dict(node_id="base", band="HF", antenna_height_m=0)])
    assert any(row["field"] == "losRequiredNodeIds" for row in DI.final_issues(
        sites, meta, rows, nodes=nodes, params=params, terrain=FlatTerrain()))
    for row in params["params"]:
        row["antenna_height_m"] = 10
    assert DI.final_issues(sites, meta, rows, nodes=nodes, params=params, terrain=FlatTerrain()) == []


def test_final_all_new_relays_obey_count_exclusion_spacing_and_forced_points():
    rows = [candidate("required", forced=True), candidate("other", lon=114.0101)]
    sites = [dict(site_id="other", node_id="new", lon=114.0101, lat=37.0,
                  subtype="VEHICLE_A", forced=False),
             dict(site_id="extra", node_id="mo-extra", lon=114.0102, lat=37.0,
                  subtype="VEHICLE_A", forced=False)]
    issues = DI.final_issues(sites, metadata(conditions(minSiteSpacingM=100,
        forcedExcludePolygons=[polygon()]), dict(mode="FIXED_COUNT", fixedCount=1, solutionCount=1)), rows)
    fields = {row["field"] for row in issues}
    assert {"candidate", "forcedExcludePolygons", "minSiteSpacingM", "forcedInclude", "fixedCount"} <= fields


def test_min_count_and_requested_alternatives_are_not_claimed_as_proven():
    sol = D.Solution()
    detail = DI.solve_detail(metadata(solve=dict(mode="MIN_COUNT", fixedCount=None, solutionCount=3)), [], sol, [], [])
    assert detail["requested_solution_count"] == 3
    assert detail["returned_solution_count"] == 0
    assert detail["proved_optimal"] is False
    assert "未证明全局最少部署数量" in detail["shortfall_reasons"]
    json.dumps(detail, allow_nan=False)


def test_p1_representative_frequency_proof_is_not_a_global_network_proof():
    sol = D.Solution()
    sol.added = [(1, "VEHICLE_A")]
    sol.lower_bound = 1
    sol.proved_optimal = True
    sites = [dict(site_id="c", node_id="new", lon=114, lat=37, subtype="VEHICLE_A", forced=False)]
    detail = DI.solve_detail(metadata(), sites, sol, [], [dict(candidate_index=1)])
    assert detail["lower_bound"] == 1
    assert detail["proved_optimal"] is False


def test_oversized_grid_is_rejected_before_any_sampling_or_road_allocation(monkeypatch):
    calls = []

    def forbidden(*_args, **_kwargs):
        calls.append(True)
        pytest.fail("超限网格不能开始采样、枚举或道路分配")

    monkeypatch.setattr(DI, "grid_points", forbidden)
    monkeypatch.setattr(DI, "_sample_point", forbidden)
    monkeypatch.setattr(DI, "_road_field", forbidden)
    with pytest.raises(ValueError, match="14326490838点.*100000点"):
        prepare([], conditions(gridStepM=1, roadMaxDistanceM=1000), bbox=(114, 37, 115.35, 38.08))
    assert not calls


def test_grid_cap_allows_existing_half_kilometre_planning_scale():
    columns, rows, *_ = DI.grid_layout((114, 37, 115.35, 38.08), 500)
    assert 50_000 < columns * rows < DI.MAX_GRID_POINTS


def test_grid_sampling_is_streamed_into_filtering(monkeypatch):
    counts = dict(sampled=0, displayed=0)
    sample, display = DI._sample_point, DI._display

    def sampled(*args, **kwargs):
        counts["sampled"] += 1
        return sample(*args, **kwargs)

    def displayed(*args, **kwargs):
        counts["displayed"] += 1
        assert counts["sampled"] == counts["displayed"]
        return display(*args, **kwargs)

    monkeypatch.setattr(DI, "_sample_point", sampled)
    monkeypatch.setattr(DI, "_display", displayed)
    accepted, info = prepare([], conditions(gridStepM=500), bbox=(114, 37, 114.01, 37.01))
    assert len(accepted) == info["scanned_count"] == counts["sampled"] > 1


def test_sampling_budget_expiration_cannot_return_a_last_partial_point(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(DI.time, "monotonic", lambda: clock[0])
    sample = DI._sample_point

    def expired(*args, **kwargs):
        result = sample(*args, **kwargs)
        clock[0] = 301.0
        return result

    monkeypatch.setattr(DI, "_sample_point", expired)
    with pytest.raises(TimeoutError, match="300秒"):
        prepare([], conditions(gridStepM=1000), bbox=(114, 37, 114.001, 37.001))


def test_spacing_shares_sampling_deadline_and_checks_after_bulk_operation(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(DI.time, "monotonic", lambda: clock[0])
    thin = DI.thin_by_spacing

    def expired(*args, **kwargs):
        assert kwargs.get("checkpoint") is not None
        result = thin(*args, **kwargs)
        clock[0] = 301.0
        return result

    monkeypatch.setattr(DI, "thin_by_spacing", expired)
    with pytest.raises(TimeoutError, match="300秒"):
        prepare([candidate("C1"), candidate("C2", lon=114.03)], conditions(minSiteSpacingM=100))


def test_final_metadata_uses_the_same_checkpoint(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(DI.time, "monotonic", lambda: clock[0])
    checkpoint = DI.input_checkpoint()
    count = DI.physical_count

    def expired(*args, **kwargs):
        result = count(*args, **kwargs)
        clock[0] = 301.0
        return result

    monkeypatch.setattr(DI, "physical_count", expired)
    with pytest.raises(TimeoutError, match="300秒"):
        DI.solve_detail(metadata(), [], D.Solution(), [], [], checkpoint=checkpoint)


def test_same_position_source_alias_is_audited_but_not_a_second_candidate():
    rows = [candidate("C1"), candidate("C2")]
    before = copy.deepcopy(rows)
    accepted, info = prepare(rows)
    assert [row["site_id"] for row in accepted] == ["C1"]
    assert info["scanned_count"] == len(info["candidates"]) == 2
    assert info["accepted_count"] == 1
    assert info["candidates"][1]["is_deployable"] is False
    assert info["candidates"][1]["reject_reason"] == "duplicate_position:C1"
    assert rows == before


@pytest.mark.parametrize("spacing", [None, 0, 100])
def test_same_position_is_incompatible_even_with_different_ids_and_zero_spacing(spacing):
    stations = [Station("CS-VEH-C1", 114, 37, "VEHICLE_A", {"HF": radio()}),
                Station("CS-MAN-C2", 114, 37, "MANPACK", {"HF": radio()})]
    assert not D._compatible_site(SimpleNamespace(stations=stations), 1, [0], spacing)


def test_native_fixed_count_cannot_be_filled_with_colocated_aliases():
    fm, _ = D.p1_solve(base_stations(), [candidate("C1"), candidate("C2")], FlatTerrain(),
        types=("VEHICLE_A",), refine=False, enforce_sites=True)
    sol = D.p2_solve(fm, [0, 1], [2, 3], 2, objective="redundant", enforce_sites=True)
    assert sol.count == 1


def test_final_duplicate_positions_fail_and_cannot_count_as_two_physical_sites():
    rows = [candidate("C1"), candidate("C2")]
    nodes = [dict(node_id="CS-VEH-C1", lon=114.01, lat=37, node_subtype="VEHICLE_A"),
             dict(node_id="CS-MAN-C2", lon=114.01, lat=37, node_subtype="MANPACK")]
    before = copy.deepcopy(nodes)
    sites = DI.selected_sites(nodes, [], rows)
    assert [site["site_id"] for site in sites] == ["C1", "C2"]
    meta = metadata(solve=dict(mode="FIXED_COUNT", fixedCount=2, solutionCount=1))
    issues = DI.final_issues(sites, meta, rows)
    assert any(issue["field"] == "duplicatePosition" for issue in issues)
    # 即使调用者遗漏最终校验问题，数量摘要本身也不能重复计数。
    detail = DI.solve_detail(meta, sites, D.Solution(), [], [])
    assert detail["actual_count"] == 1
    assert detail["count_satisfied"] is False
    assert any(issue["field"] == "duplicatePosition" for issue in detail["constraint_issues"])
    assert nodes == before
