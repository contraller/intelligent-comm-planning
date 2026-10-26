"""R4-B 原生结果投影定向测试；构造夹具不代表物理求解或真实联调。"""
from __future__ import annotations

from copy import deepcopy
import gzip
import json
from pathlib import Path
import struct
import sys
from types import SimpleNamespace

import pytest
from pydantic import ValidationError


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from app import planning_result_adapter as adapter
from app.task_input_schemas import PlanningDemand


def demand(identity, mandatory):
    return {"id": identity, "sourceId": "N1", "targetId": "N2",
            "endpointMode": "station", "service": "数据", "priority": "P1",
            "mandatory": mandatory, "dataVolumeMb": 0,
            "requiredRateKbps": 64, "maxDelayMs": 100, "minReliability": 0.9}


@pytest.fixture
def native(monkeypatch):
    monkeypatch.setattr(adapter.planning_w4, "_load", lambda *_: pytest.fail("读取当前资源CSV"))
    devices = [{"device_id": f"D{i}", "node_id": f"N{i}", "model_id": "M1",
                "tx_power_dbm": 40, "antenna_height_m": 10, "tilt_deg": 7}
               for i in range(1, 4)]
    links = [{"link_id": identity, "node_a_id": a, "node_b_id": b,
              "device_a_id": a.replace("N", "D"), "device_b_id": b.replace("N", "D"),
              "device_class": "HF", "link_margin_db": 15,
              "is_available": True, "is_backup": identity != "L12", "distance_m": distance}
             for identity, a, b, distance in (("L12", "N1", "N2", 1000),
                                            ("L13", "N1", "N3", 2000),
                                            ("L32", "N3", "N2", 1500))]
    assignments = [{"link_id": "NET-A", "task_id": "NET-A", "member_link_ids": ["L12"],
                    "freq_id": "F1", "freq_khz": 7000, "bandwidth_khz": 3, "reuse_group": 0},
                   {"link_id": "NET-B", "task_id": "NET-B", "member_link_ids": ["L13", "L32"],
                    "freq_id": "F2", "freq_khz": 7100, "bandwidth_khz": 3, "reuse_group": 1}]
    expanded = [dict(row, link_id=key, net_id=row["task_id"])
                for row in assignments for key in row["member_link_ids"]]
    plan = {
        "solution_id": "PL-R4B0001",
        "summary": {"objectives": {"e2e_connectivity": 0.5,
                                   "survivability": 0.92, "total_radiated_power_w": 30}},
        "detail": {
            "nodes": [{"node_id": f"N{i}", "node_name": f"构造节点{i}",
                       "lon": 114 + i / 10, "lat": 37 + i / 10} for i in range(1, 4)],
            "devices": devices, "links": links,
            "params": {"params": [dict(device, band="HF", tilt_deg=0, tilt_effective=False)
                                   for device in devices]},
            "routes": {"routes": [
                {"demand_id": "REQ", "reachable": True,
                 "primary": {"node_path": ["N1", "N2"], "link_path": ["L12"],
                             "hop_count": 1, "total_delay_ms": 0, "min_link_margin_db": 6.5,
                             "reliability": 0.95, "bottleneck_link_id": "L12"},
                 "backup": {"node_path": ["N1", "N3", "N2"], "link_path": ["L13", "L32"],
                            "hop_count": 2, "total_delay_ms": 5, "min_link_margin_db": 6.1,
                            "reliability": 0.9, "bottleneck_link_id": "L32"}},
                {"demand_id": "OPT", "reachable": False, "primary": None, "backup": None}],
                "unreachable_demand_ids": ["OPT"]},
            "frequency": {"assignments": assignments, "link_assignments": expanded,
                          "conflicts": [], "conflict_free": True,
                          "gap": {"HF": {"required_channels": 2, "available_channels": 4,
                                         "shortage": 0}}},
            "optimization": {"best": {"constraint_check": {
                "mandatory_e2e_connectivity": {"value": 1, "required": 1, "pass": True},
                "survivability": {"value": 0.92, "required": 0.9, "pass": True},
                "max_relay_hops": {"value": 2, "required": 2, "pass": True}}}},
            "check": {"passed": True, "issues": []},
        },
    }
    frozen = {"device_model.csv": [{"model_id": "M1", "model_name": "构造冻结型号", "device_class": "HF"}],
              "device.csv": [{"device_id": "CURRENT-NOT-A-SOURCE"}]}
    return plan, {"demands": [demand("REQ", True), demand("OPT", False)]}, frozen


def project(native):
    plan, input_data, frozen = native
    return adapter.adapt_planning_result(plan, input_data, resource_rows=frozen)


def connectivity(result):
    return next(row for row in result["checks"] if row["id"] == "connectivity")


def test_unreachable_optional_demand_does_not_fail_mandatory_gate(native):
    result, outcome = project(native)
    assert connectivity(result)["passed"] is True
    assert "1/1" in connectivity(result)["detail"]
    assert outcome["code"] == 0
    assert result["metrics"]["connectivityPercent"] == 50
    assert result["result_details"]["unreachableDemandIds"] == ["OPT"]


@pytest.mark.parametrize("primary", [None, {"node_path": ["N1", "N2"], "link_path": ["FOREIGN"]},
                                     {"node_path": ["N1", "N2"], "link_path": []}])
def test_backup_or_invalid_primary_does_not_satisfy_mandatory_demand(native, primary):
    native[0]["detail"]["routes"]["routes"][0]["primary"] = primary
    result, outcome = project(native)
    assert any(route["backup"] for route in result["configuration"]["routes"])
    assert connectivity(result)["passed"] is False
    assert "0/1" in connectivity(result)["detail"]
    assert outcome["code"] == 3001


@pytest.mark.parametrize("algorithm_pass", [False, None, "false", "true", 1])
def test_algorithm_requires_explicit_true_even_with_all_primary_routes(native, algorithm_pass):
    native[0]["detail"]["optimization"]["best"]["constraint_check"]["mandatory_e2e_connectivity"]["pass"] = algorithm_pass
    result, outcome = project(native)
    assert connectivity(result)["passed"] is False
    assert "1/1" in connectivity(result)["detail"]
    assert outcome["code"] == 3001


def test_all_mandatory_demands_require_primary_routes(native):
    native[1]["demands"][1]["mandatory"] = True
    result, outcome = project(native)
    assert connectivity(result)["passed"] is False
    assert "1/2" in connectivity(result)["detail"]
    assert outcome["code"] == 3001


def test_schema_allows_no_mandatory_and_check_explicitly_cannot_evaluate(native):
    for row in native[1]["demands"]:
        row["mandatory"] = False
        assert PlanningDemand.model_validate(row).mandatory is False
    result, outcome = project(native)
    check = connectivity(result)
    assert check["passed"] is False
    assert "无必要需求" in check["detail"] and "无法评价" in check["detail"]
    assert "0/0" not in check["detail"] and "100" not in check["detail"]
    assert outcome["code"] == 3001


@pytest.mark.parametrize("flag", [1, "true", "false", None])
def test_mandatory_is_not_coerced_from_truthy_non_strictbool(native, flag):
    row = native[1]["demands"][0]
    row["mandatory"] = flag
    with pytest.raises(ValidationError):
        PlanningDemand.model_validate(row)
    result, _ = project(native)
    assert connectivity(result)["passed"] is False
    assert "无必要需求" in connectivity(result)["detail"]


def test_native_route_quality_is_bound_to_primary_and_backup(native):
    result, _ = project(native)
    primary, backup = result["result_details"]["routeQuality"]
    assert primary == {"routeId": "REQ-PRIMARY", "demandId": "REQ", "hopCount": 1,
                       "totalDistanceM": 1000, "totalDelayMs": 0, "bottleneckMarginDb": 6.5,
                       "reliability": 0.95, "isFeasible": None, "bottleneckLinkId": "L12"}
    assert backup["routeId"] == "REQ-BACKUP"
    assert backup["totalDistanceM"] == 3500
    assert backup["totalDelayMs"] == 5 and backup["bottleneckLinkId"] == "L32"
    assert result["metrics"]["delayMs"] == 0


def test_missing_route_numbers_are_null_and_distance_requires_every_link(native):
    path = native[0]["detail"]["routes"]["routes"][0]["primary"]
    for key in ("hop_count", "total_delay_ms", "min_link_margin_db", "reliability", "bottleneck_link_id"):
        path.pop(key)
    native[0]["detail"]["links"][1].pop("distance_m")
    result, _ = project(native)
    primary, backup = result["result_details"]["routeQuality"]
    assert all(primary[key] is None for key in ("hopCount", "totalDelayMs", "bottleneckMarginDb",
                                               "reliability", "bottleneckLinkId", "isFeasible"))
    assert backup["totalDistanceM"] is None


def test_negative_margin_zero_reliability_and_false_tilt_survive(native):
    path = native[0]["detail"]["routes"]["routes"][0]["primary"]
    path.update(min_link_margin_db=-3, reliability=0)
    result, _ = project(native)
    assert result["result_details"]["routeQuality"][0]["bottleneckMarginDb"] == -3
    assert result["result_details"]["routeQuality"][0]["reliability"] == 0
    assert result["devices"][0]["tiltDeg"] == 0
    assert result["result_details"]["deviceParameters"][0] == {
        "deviceId": "D1", "tiltDeg": 0, "tiltEffective": False}


def test_legacy_node_band_parameters_bind_to_same_configured_device(native):
    for row in native[0]["detail"]["params"]["params"]:
        row.pop("device_id")
        row.pop("tilt_effective")
    result, _ = project(native)
    assert [row["deviceId"] for row in result["result_details"]["deviceParameters"]] == ["D1", "D2", "D3"]
    assert all(row["tiltEffective"] is None for row in result["result_details"]["deviceParameters"])


def test_expanded_frequency_assignments_are_unique_and_match_frozen_links(native):
    result, _ = project(native)
    assignments = result["result_details"]["frequencyAssignments"]
    assert [row["linkId"] for row in assignments] == ["L12", "L13", "L32"]
    assert assignments[0] == {"id": "FA-PL-R4B0001-L12", "linkId": "L12",
                              "resourceGroupId": "ALLOC-PL-R4B0001", "freqId": "F1",
                              "reuseGroup": 0, "frequencyKhz": 7000, "bandwidthKhz": 3}
    assert len({row["id"] for row in assignments}) == 3


def test_group_frequency_assignments_expand_from_explicit_native_members(native):
    native[0]["detail"]["frequency"]["link_assignments"] = deepcopy(native[0]["detail"]["frequency"]["assignments"])
    result, _ = project(native)
    assert [row["linkId"] for row in result["result_details"]["frequencyAssignments"]] == ["L12", "L13", "L32"]


def test_unassigned_frequency_does_not_become_zero_detail(native):
    for row in native[0]["detail"]["frequency"]["link_assignments"]:
        row.update(freq_khz=None, freq_id=None, reuse_group=None, bandwidth_khz=None)
    result, _ = project(native)
    assert result["result_details"]["frequencyAssignments"] == []
    assert all(row["workFreqKhz"] is None for row in result["devices"])


@pytest.mark.parametrize("value", [None, 0, -1, float("inf")])
def test_invalid_or_missing_bandwidth_is_null_without_losing_assignment(native, value):
    native[0]["detail"]["frequency"]["link_assignments"][0]["bandwidth_khz"] = value
    result, _ = project(native)
    row = result["result_details"]["frequencyAssignments"][0]
    assert row["bandwidthKhz"] is None
    assert row["frequencyKhz"] == 7000


def test_adjacent_net_conflict_expands_members_without_picking_one_frequency(native):
    native[0]["detail"]["frequency"].update(conflict_free=False, conflicts=[{
        "type": "ADJACENT_CHANNEL", "link_ids": ["NET-A", "NET-B"], "freq_khz": [7000, 7100],
        "distance_m": 0, "required_distance_m": 30000, "severity": "MODERATE"}])
    result, outcome = project(native)
    assert result["result_details"]["frequencyConflicts"] == [{
        "id": "FC-PL-R4B0001-1", "type": "ADJACENT_CHANNEL", "linkIds": ["L12", "L13", "L32"],
        "frequencyKhz": None, "distanceM": 0, "requiredDistanceM": 30000, "severity": "MODERATE"}]
    assert result["result_details"]["conflictFree"] is False
    assert outcome["code"] == 3001


def test_legacy_conflict_kind_and_physical_link_reference_are_preserved(native):
    native[0]["detail"]["frequency"]["conflicts"] = [{"kind": "FREQ_CONFLICT", "link_ids": ["L12"],
                                                             "freq_khz": 7000, "severity": "SEVERE"}]
    result, _ = project(native)
    row = result["result_details"]["frequencyConflicts"][0]
    assert row["type"] == "FREQ_CONFLICT" and row["linkIds"] == ["L12"]
    assert row["frequencyKhz"] == 7000 and row["distanceM"] is None


def test_frequency_gap_sums_disjoint_bands_without_double_counting_subbands(native):
    gap = native[0]["detail"]["frequency"]["gap"]
    gap["HF"].update(shortage=2, sub_bands=[{"shortage": 2}, {"shortage": 2}])
    gap["VUHF"] = {"required_channels": 3, "available_channels": 5, "shortage": 1}
    result, _ = project(native)
    assert result["result_details"]["frequencyGap"] == {"requiredChannels": 5, "availableChannels": 9, "shortage": 3}
    gap["VUHF"].pop("available_channels")
    assert project(native)[0]["result_details"]["frequencyGap"]["availableChannels"] is None


def test_missing_and_explicit_empty_collections_remain_distinct(native):
    detail = native[0]["detail"]
    for key in ("params", "routes", "frequency"):
        detail.pop(key)
    result, _ = project(native)
    for key in ("deviceParameters", "routeQuality", "frequencyAssignments", "frequencyConflicts",
                "frequencyGap", "conflictFree", "unreachableDemandIds"):
        assert result["result_details"][key] is None
    detail.update(params={"params": []}, routes={"routes": [], "unreachable_demand_ids": []},
                  frequency={"link_assignments": [], "conflicts": [], "gap": {}})
    result, _ = project(native)
    for key in ("deviceParameters", "routeQuality", "frequencyAssignments", "frequencyConflicts", "unreachableDemandIds"):
        assert result["result_details"][key] == []
    assert result["result_details"]["frequencyGap"] is None
    assert result["result_details"]["conflictFree"] is None


def test_unreachable_is_explicit_native_fact_scoped_to_input_not_missing_routes(native):
    native[0]["detail"]["routes"]["unreachable_demand_ids"] = ["OPT", "OTHER-NETWORK-DEMAND"]
    result, _ = project(native)
    assert result["result_details"]["unreachableDemandIds"] == ["OPT"]
    native[0]["detail"]["routes"].pop("unreachable_demand_ids")
    assert project(native)[0]["result_details"]["unreachableDemandIds"] is None


def add_candidate_and_deployment(native):
    optimization = native[0]["detail"]["optimization"]
    optimization["candidate_filter"] = {
        "source": "构造冻结候选筛选，非实测", "scanned_count": 12, "accepted_count": 2,
        "data_sources": ["冻结候选表：candidate_site.csv", "道路来源待确认"],
        "rejected_stats": {"slope": 0, "road": 3},
        "unavailable_reasons": [{"site_id": "CS1", "field": "visible_node_count", "reason": "通视数量未计算"}],
        "candidates": [{"site_id": "CS1", "lon": 114, "lat": 37, "elevation_m": 0,
                        "slope_deg": 0, "nearest_road_distance_m": 0, "is_deployable": False,
                        "score": 0, "forced": True}, {"site_id": "CS2"}],
    }
    optimization["deployment_solve"] = {
        "mode": "FIXED_COUNT", "requested_count": 3, "actual_count": 2, "count_satisfied": False,
        "requested_solution_count": 3, "returned_solution_count": 1, "forced_site_ids": ["CS1"],
        "lower_bound": 1, "proved_optimal": False, "shortfall_reasons": ["构造夹具只返回两个部署点"],
    }
    return optimization


def test_candidate_projection_preserves_counts_missing_fields_and_forced_flag_independence(native):
    add_candidate_and_deployment(native)
    result, _ = project(native)
    screening = result["result_details"]["candidateScreening"]
    assert screening["candidateCount"] == 12 and screening["deployableCount"] == 2
    assert screening["rejectedStats"] == {"slope": 0, "road": 3}
    assert screening["unavailableReasons"] == ["CS1/visible_node_count：通视数量未计算"]
    assert screening["dataSources"] == ["冻结候选表：candidate_site.csv", "道路来源待确认"]
    first, second = screening["candidates"]
    assert first == {"siteId": "CS1", "coordinate": [114, 37], "elevationM": 0, "slopeDeg": 0,
                     "landcoverType": None, "nearestRoadDistanceM": 0, "nearestNodeDistanceM": None,
                     "visibleNodeCount": None, "candidateRole": None, "isDeployable": False,
                     "recommendationLevel": None, "score": 0, "rejectReason": None}
    assert second["coordinate"] is None and second["isDeployable"] is None


def test_candidate_and_deployment_extensions_are_optional_for_legacy(native):
    result, _ = project(native)
    assert "candidateScreening" not in result["result_details"]
    assert "deploymentSummary" not in result["result_details"]
    assert "optimization" not in result["result_details"]


def test_candidate_unavailable_is_not_zero_or_success(native):
    add_candidate_and_deployment(native)["candidate_filter"] = {
        "source": "原生筛选不可计算", "unavailable_reasons": [
            {"site_id": "CS1", "field": "slope_deg", "reason": "缺少本次冻结来源"}]}
    result, _ = project(native)
    screening = result["result_details"]["candidateScreening"]
    assert all(screening[key] is None for key in ("candidateCount", "deployableCount", "candidates", "rejectedStats"))
    assert screening["unavailableReasons"] == ["CS1/slope_deg：缺少本次冻结来源"]
    assert "dataSources" not in screening


def test_candidate_data_sources_are_optional_for_old_metadata_and_preserve_explicit_empty(native):
    candidate_filter = add_candidate_and_deployment(native)["candidate_filter"]
    candidate_filter.pop("data_sources")
    assert "dataSources" not in project(native)[0]["result_details"]["candidateScreening"]
    candidate_filter["data_sources"] = []
    assert project(native)[0]["result_details"]["candidateScreening"]["dataSources"] == []


def test_candidate_data_sources_preserve_explicit_null(native):
    add_candidate_and_deployment(native)["candidate_filter"]["data_sources"] = None
    assert project(native)[0]["result_details"]["candidateScreening"]["dataSources"] is None


@pytest.mark.parametrize("sources", ["candidate_site.csv", [""], ["   "], [1], [{"source": "候选表"}]])
def test_candidate_data_sources_reject_non_string_array_without_fabricating_source(native, sources):
    add_candidate_and_deployment(native)["candidate_filter"]["data_sources"] = sources
    with pytest.raises(ValueError, match="字符串数组"):
        project(native)


def test_a_native_filter_and_solver_metadata_project_without_recomputing_business_conclusions(native, tmp_path):
    import deployment_inputs
    from terrain import DemTerrain

    metadata = {"bbox": [113, 36, 115, 38], "deploymentConstraints": {"maxSlopeDeg": 10},
                "deploymentSolve": {"mode": "MIN_COUNT", "solutionCount": 2}}
    rows = [{"site_id": "CS1", "lon": 114, "lat": 37, "slope_deg": 0},
            {"site_id": "CS2", "lon": 114.1, "lat": 37.1, "slope_deg": None}]
    with pytest.raises(deployment_inputs.DataUnavailable, match="缺少原始DEM"):
        deployment_inputs.prepare_candidates(rows, metadata, SimpleNamespace(), native[0]["detail"]["nodes"], [])
    # 2x2构造栅格走原生加载器，仅验证元数据对接，不冒称真实DEM或物理求解。
    for name, dtype, data in (("dem", "int16", struct.pack("<4h", 100, 101, 102, 103)),
                              ("landcover", "uint8", bytes([30] * 4))):
        (tmp_path / f"{name}.gz").write_bytes(gzip.compress(data))
        (tmp_path / f"{name}.json").write_text(json.dumps({
            "width": 2, "height": 2, "origin_lon": 113, "origin_lat": 38,
            "pixel_lon": 1, "pixel_lat": 1, "bbox": [113, 36, 115, 38],
            "dtype": dtype, "data_file": f"{name}.gz", "byteorder": "little",
            "source": "R4-B constructed 2x2 test fixture, not field data",
        }), encoding="utf-8")
    terrain = DemTerrain(str(tmp_path / "dem.json"), str(tmp_path / "landcover.json"))
    assert terrain._dem.sample(114, 37) == 103
    accepted, candidate_filter = deployment_inputs.prepare_candidates(
        rows, metadata, terrain, native[0]["detail"]["nodes"], [])
    assert [row["site_id"] for row in accepted] == ["CS1"]
    optimization = native[0]["detail"]["optimization"]
    optimization["candidate_filter"] = candidate_filter
    optimization["deployment_solve"] = deployment_inputs.solve_detail(
        metadata, [], SimpleNamespace(count=0, lower_bound=None, proved_optimal=False, unconnected=[]), [], [])
    result, _ = project(native)
    screening = result["result_details"]["candidateScreening"]
    assert screening["sourceLabel"] == "FROZEN_CANDIDATE_TABLE"
    assert screening["candidateCount"] == 2 and screening["deployableCount"] == 1
    assert screening["candidates"][0]["isDeployable"] is True
    assert screening["candidates"][1]["isDeployable"] is None
    assert screening["unavailableReasons"] == ["CS2/maxSlopeDeg：缺少可用候选属性：slope_deg"]
    assert screening["dataSources"] == candidate_filter["data_sources"]
    summary = result["result_details"]["deploymentSummary"]
    assert summary["mode"] == "MIN_COUNT" and summary["requestedCount"] is None
    assert summary["actualCount"] == summary["returnedSolutionCount"] == 0
    assert summary["requestedSolutionCount"] == 2 and summary["provedOptimal"] is False
    assert summary["lowerBound"] is None
    assert summary["shortfallReasons"] == optimization["deployment_solve"]["shortfall_reasons"]


@pytest.mark.parametrize("reason", [["缺少资料"], [{"site_id": "CS1", "reason": "缺少字段身份"}]])
def test_candidate_reason_must_keep_native_site_field_and_reason(native, reason):
    add_candidate_and_deployment(native)["candidate_filter"]["unavailable_reasons"] = reason
    with pytest.raises(ValueError, match="对象数组|点位、字段或原因"):
        project(native)


def test_deployment_summary_reports_raw_shortfall_without_claiming_optimality(native):
    add_candidate_and_deployment(native)
    result, _ = project(native)
    assert result["result_details"]["deploymentSummary"] == {
        "mode": "FIXED_COUNT", "requestedCount": 3, "actualCount": 2, "countSatisfied": False,
        "requestedSolutionCount": 3, "returnedSolutionCount": 1, "forcedSiteIds": ["CS1"],
        "lowerBound": 1, "provedOptimal": False, "shortfallReasons": ["构造夹具只返回两个部署点"]}


def test_deployment_zero_false_and_absence_are_not_coerced(native):
    optimization = add_candidate_and_deployment(native)
    optimization["deployment_solve"].update(requested_count=0, actual_count=0, lower_bound=0)
    summary = project(native)[0]["result_details"]["deploymentSummary"]
    assert summary["requestedCount"] == summary["actualCount"] == summary["lowerBound"] == 0
    assert summary["countSatisfied"] is False and summary["provedOptimal"] is False
    optimization["deployment_solve"] = {}
    assert all(value is None for value in project(native)[0]["result_details"]["deploymentSummary"].values())


def test_deployment_constraint_issues_merge_with_raw_reasons_in_stable_order_without_duplicates(native):
    solve = add_candidate_and_deployment(native)["deployment_solve"]
    solve["shortfall_reasons"] = ["原生数量不足", "fixedCount/CS1：请求3个，实际2个", "原生数量不足"]
    solve["constraint_issues"] = [
        {"field": "fixedCount", "site_id": "CS1", "reason": "请求3个，实际2个"},
        {"field": "candidate_source", "site_id": None, "reason": "最终中继缺少通过筛选的来源"},
        {"field": "candidate_source", "reason": "最终中继缺少通过筛选的来源"},
    ]
    original = deepcopy(solve)
    result, _ = project(native)
    assert result["result_details"]["deploymentSummary"]["shortfallReasons"] == [
        "原生数量不足", "fixedCount/CS1：请求3个，实际2个", "candidate_source：最终中继缺少通过筛选的来源"]
    assert solve == original


@pytest.mark.parametrize("site", [None, "CS1"])
def test_deployment_constraint_issue_is_visible_when_raw_shortfall_reasons_are_missing(native, site):
    solve = add_candidate_and_deployment(native)["deployment_solve"]
    solve.pop("shortfall_reasons")
    solve["constraint_issues"] = [{"field": "forcedInclude", "site_id": site, "reason": "请求强制点未出现在最终网络"}]
    summary = project(native)[0]["result_details"]["deploymentSummary"]
    label = "forcedInclude/CS1" if site is not None else "forcedInclude"
    assert summary["shortfallReasons"] == [label + "：请求强制点未出现在最终网络"]


@pytest.mark.parametrize("reasons", [None, []])
def test_empty_constraint_issues_do_not_turn_missing_reasons_into_empty_array(native, reasons):
    solve = add_candidate_and_deployment(native)["deployment_solve"]
    solve.update(shortfall_reasons=reasons, constraint_issues=[])
    assert project(native)[0]["result_details"]["deploymentSummary"]["shortfallReasons"] == reasons


@pytest.mark.parametrize("issue", [
    {"reason": "缺字段"}, {"field": "forcedInclude"},
    {"field": "forcedInclude", "reason": "缺少合法站点", "site_id": 1},
])
def test_invalid_deployment_constraint_issue_does_not_get_fabricated_identity_or_reason(native, issue):
    add_candidate_and_deployment(native)["deployment_solve"]["constraint_issues"] = [issue]
    with pytest.raises(ValueError, match="部署约束问题"):
        project(native)


@pytest.mark.parametrize("field", ["e2e_connectivity", "survivability"])
def test_missing_metrics_are_null_instead_of_zero(native, field):
    native[0]["summary"]["objectives"].pop(field)
    result, _ = project(native)
    target = "connectivityPercent" if field == "e2e_connectivity" else "survivabilityPercent"
    assert result["metrics"][target] is None


def test_nonfinite_quality_and_tilt_are_json_safe_nulls(native):
    native[0]["detail"]["routes"]["routes"][0]["primary"].update(reliability=float("inf"), min_link_margin_db=float("nan"))
    native[0]["detail"]["params"]["params"][0]["tilt_deg"] = float("inf")
    result, _ = project(native)
    assert result["result_details"]["routeQuality"][0]["reliability"] is None
    assert result["result_details"]["routeQuality"][0]["bottleneckMarginDb"] is None
    assert result["result_details"]["deviceParameters"][0]["tiltDeg"] is None
    assert result["devices"][0]["tiltDeg"] is None
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("corruption, message", [
    ("bottleneck", "瓶颈链路"), ("conflict", "不能关联冻结链路"),
    ("contradictory_assignment", "频率分配"), ("duplicate_candidate", "候选点身份"),
])
def test_invalid_declared_relations_cannot_be_presented_as_valid_details(native, corruption, message):
    detail = native[0]["detail"]
    if corruption == "bottleneck":
        detail["routes"]["routes"][0]["primary"]["bottleneck_link_id"] = "L13"
    elif corruption == "conflict":
        detail["frequency"]["conflicts"] = [{"type": "CO_CHANNEL", "link_ids": ["FOREIGN"]}]
    elif corruption == "contradictory_assignment":
        detail["frequency"]["link_assignments"].append(dict(detail["frequency"]["link_assignments"][0], freq_khz=7200))
    else:
        screening = add_candidate_and_deployment(native)["candidate_filter"]
        screening["candidates"].append(deepcopy(screening["candidates"][0]))
    with pytest.raises(ValueError, match=message):
        project(native)


@pytest.mark.parametrize("with_details", [False, True])
def test_saved_snapshot_dto_keeps_legacy_extension_absence_without_reprojection(native, monkeypatch, with_details):
    from app import planning_plan_service

    snapshot = project(native)[0]
    if not with_details:
        snapshot.pop("result_details")
    else:
        snapshot["result_details"]["assetVersion"] = "legacy-version-1"
    original = deepcopy(snapshot)
    monkeypatch.setattr(planning_plan_service, "_source_changed", lambda _: False)
    monkeypatch.setattr(planning_plan_service, "get_session_factory", lambda: pytest.fail("访问数据库"))
    monkeypatch.setattr(adapter, "adapt_planning_result", lambda *_args, **_kw: pytest.fail("重算旧快照"))
    plan = SimpleNamespace(
        plan_id="PLAN-OLD", task_id="TASK-OLD", job_id="JOB-OLD", revision_id="REV-OLD", version_no=1,
        name="旧保存方案", note="", condition_version="COND-OLD", resource_revision="RESOURCE-OLD",
        input_snapshot={"demands": []}, parent_plan_id=None, state="REFERENCE", saved_at=None,
        confirmed_at=None, source="SR4", result_snapshot=snapshot, outcome_snapshot={"code": 3001}, adjustment=None)
    returned = planning_plan_service._dto(plan)["result"]
    assert returned == original and snapshot == original
    assert ("result_details" in returned) is with_details
    if with_details:
        assert "candidateScreening" not in returned["result_details"]
        assert "deploymentSummary" not in returned["result_details"]


def test_projection_is_deterministic_and_does_not_rewrite_frozen_inputs(native, tmp_path):
    add_candidate_and_deployment(native)
    originals = deepcopy(native)
    first = project(native)
    second = project(native)
    assert first == second and native == originals
    (tmp_path / "projected-result.json").write_text(
        json.dumps({"result": first[0], "outcome": first[1]}, ensure_ascii=False, allow_nan=False, indent=2),
        encoding="utf-8")
