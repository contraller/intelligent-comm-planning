"""R4-A冻结输入/W4持久化契约测试；替身不作为真实HTTP或DEM验证。"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "algorithm-service", ROOT / "scripts", ROOT / "scripts/planning"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from app import planning_job_service as JS
from app import planning_w4 as W4
from app.planning_job_schemas import PlanningJobSubmitRequest
import deployment_inputs as DI
import sr4_flow
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.database import Base
from app.planning_job_models import PlanningJob, PlanningJobCancellation
from app.planning_plan_models import PlanningPlan
from app.resource_dataset_models import ResourceDatasetVersion
from app.task_input_models import PlanningTask, PlanningTaskRevision


def request():
    return PlanningJobSubmitRequest(context="planning", request_id="r4a-request", task_id="r4a-task",
        expected_revision="input-1", input_version="input-1", condition_version="condition-1",
        resource_revision="resource-1", parent_plan_id=None)


def input_data():
    return dict(name="R4-A", bbox=[114.0, 37.0, 114.1, 37.1], stationIds=["a", "b"],
        presetId="balanced", frequencyId="frequency", constraints=dict(connectivityPercent=100,
        survivabilityPercent=90, maxRelayHops=2), demands=[dict(id="demand", sourceId="a", targetId="b",
        priority="P1", mandatory=True, requiredRateKbps=1.0, maxDelayMs=100.0, minReliability=0.9,
        service="数据")])


def tables():
    return {"node.csv": [dict(node_id="a"), dict(node_id="b"), dict(node_id="outside")],
        "comm_demand.csv": [dict(demand_id="network-required", task_id="other", is_mandatory="true")],
        "frequency_resource.csv": [dict(freq_id="f1", device_class="HF")],
        "candidate_site.csv": [dict(site_id="c")], "device.csv": [], "device_model.csv": [],
        "antenna_model.csv": [], "link_metric.csv": [], "interference_source.csv": []}


def test_payload_freezes_bbox_deployment_and_preserves_all_resource_tables():
    data, frozen = input_data(), tables()
    data["deploymentSolve"] = dict(mode="FIXED_COUNT", fixedCount=0, solutionCount=2)
    data["deploymentConstraints"] = dict(maxSlopeDeg=0, elevationRangeM=None, allowedLandcover=None,
        roadMaxDistanceM=None, minSiteSpacingM=None, losRequiredNodeIds=[], gridStepM=None,
        forcedInclude=[], forcedExcludePolygons=[])
    before = copy.deepcopy(frozen)
    revision = SimpleNamespace(input_snapshot=data, resource_revision="resource-1")
    result = JS._algorithm_payload(request(), revision, frozen_rows=frozen)
    assert {name: result["resource_rows"][name] for name in frozen} == before == frozen
    meta = result["resource_rows"]["planning_input"]
    assert meta["bbox"] == data["bbox"]
    assert meta["deploymentSolve"]["fixedCount"] == 0
    assert meta["deploymentConstraints"]["maxSlopeDeg"] == 0
    data["bbox"][0] = 0
    frozen["node.csv"].clear()
    assert meta["bbox"][0] == 114.0
    assert len(result["resource_rows"]["node.csv"]) == 3
    assert result["hard_constraints"] == dict(mandatory_e2e_connectivity=1.0,
        survivability_threshold=0.9, max_relay_hops=2)


def test_csv_compatibility_freezes_inputs_without_enabling_advanced_frequency(monkeypatch):
    frozen = tables()
    monkeypatch.setattr(JS, "_validate_resources", lambda *_: None)
    monkeypatch.setattr(JS.resource_dataset, "database_mode", lambda: False)
    monkeypatch.setattr(W4, "_load", lambda name: copy.deepcopy(frozen[name]))
    revision = SimpleNamespace(input_snapshot=input_data(), resource_revision="resource-1")
    result = JS._algorithm_payload(request(), revision)
    assert all(result["resource_rows"][name] == rows for name, rows in frozen.items())
    revision.input_snapshot["frequencyConstraints"] = {"filters": [
        dict(deviceClass="HF", rangeKhz=[3000.0, 5000.0], excludeFreqIds=[])]}
    with pytest.raises(JS.PlanningJobError, match="不能回退CSV"):
        JS._algorithm_payload(request(), revision)


def test_invalid_deployment_input_is_reported_before_dispatch():
    data = input_data()
    data["deploymentSolve"] = dict(mode="FIXED_COUNT", fixedCount=-1, solutionCount=1)
    with pytest.raises(JS.PlanningJobError) as exc:
        JS._algorithm_payload(request(), SimpleNamespace(input_snapshot=data, resource_revision="r"), frozen_rows=tables())
    assert exc.value.status == 422 and exc.value.data[0]["field"] == "deploymentSolve"


def test_payload_preserves_parent_deployment_conditions_for_reservation_validation():
    data = input_data()
    data["deploymentSolve"] = dict(mode="FIXED_COUNT", fixedCount=0, solutionCount=1)
    payload = request().model_copy(update={"parent_plan_id": "parent"})
    result = JS._algorithm_payload(payload, SimpleNamespace(input_snapshot=data, resource_revision="r"), frozen_rows=tables())
    assert result["resource_rows"]["planning_input"]["deploymentSolve"] == data["deploymentSolve"]


def test_w4_existing_container_persists_raw_candidate_and_solve_contract(monkeypatch, tmp_path):
    screening = dict(source="FROZEN_CANDIDATE_TABLE", scanned_count=1, accepted_count=0,
        candidates=[], rejected_stats=dict.fromkeys(DI.REJECT_KEYS, 0), data_sources=["冻结输入表：candidate_site.csv"],
        unavailable_reasons=[dict(site_id="c", field="roadMaxDistanceM", reason="缺少道路资料")])
    solve = dict(mode="FIXED_COUNT", requested_count=1, actual_count=0, count_satisfied=False,
        requested_solution_count=3, returned_solution_count=0, forced_site_ids=[], selected_sites=[],
        lower_bound=0, proved_optimal=False, constraint_issues=[dict(field="fixedCount", reason="数量不足")],
        shortfall_reasons=["数量不足"], solutions=[])
    output = dict(task_id="r4a-task", total_s=0.1, within_limit=True, steps=[],
        optimization=dict(best=dict(objectives={}), feasible=False,
            candidate_filter=screening, deployment_solve=solve), routes={}, frequency=dict(conflicts=[]),
        params={}, check=dict(passed=False, summary={}), interference=dict(analysis=dict(summary=dict(affected_links=0))),
        links=[], nodes=[], devices=[])
    calls = []
    monkeypatch.setattr(sr4_flow, "run", lambda **kwargs: calls.append(kwargs) or copy.deepcopy(output))
    monkeypatch.setattr(W4, "PLAN_DIR", tmp_path / "plans")
    payload = dict(task_id="r4a-task", resource_rows=tables())
    saved = W4._do_sr4(payload, lambda *_: None)
    path = W4.PLAN_DIR / (saved["solution_id"] + ".json")
    detail = json.loads(path.read_text(encoding="utf-8"))["detail"]["optimization"]
    assert detail["candidate_filter"] == screening
    assert detail["deployment_solve"] == solve
    assert calls[0]["resource_rows"] == payload["resource_rows"]
    assert path.resolve().is_relative_to((ROOT / "data/runtime/r4").resolve())


def test_only_distinct_fully_verified_results_count_as_generated():
    def result(passed=True, link="l1"):
        return dict(score=(0 if passed else 1,), nodes=[], devices=[], links=[dict(link_id=link)],
            routes={}, frequency=dict(assignments=[]), params={}, check=dict(passed=passed), objectives={},
            constraint_check={}, deployment_issues=[])
    good, duplicate, bad, other = result(), result(), result(False), result(link="l2")
    verified = [(None, None, None, value) for value in (good, duplicate, bad, other)]
    actual = DI.verified_solutions(verified, good, [], [], 3)
    assert len(actual) == 2
    assert all(row["check"]["passed"] for row in actual)
    assert all(row["evaluation_basis"] == "ACTUAL_FREQUENCY_FULL_CHECK" for row in actual)


def small_native_tables():
    frozen = tables()
    frozen["node.csv"] = [dict(node_id="a", node_subtype="I_FIXED", lon=114.0, lat=37.0),
                          dict(node_id="b", node_subtype="I_MOBILE", lon=114.01, lat=37.0)]
    frozen["device_model.csv"] = [dict(model_id="UNIT-HF", device_class="HF",
        freq_min_khz="4000", freq_max_khz="8000", tx_power_levels_dbm="0;10;20;30",
        tx_power_max_dbm="30", rx_sensitivity_dbm="-120", bandwidth_khz="3")]
    frozen["antenna_model.csv"] = [dict(antenna_id="UNIT-ANT", gain_dbi="0", pattern_type="OMNI")]
    frozen["device.csv"] = [dict(device_id="D-" + node["node_id"], node_id=node["node_id"],
        model_id="UNIT-HF", antenna_id="UNIT-ANT", tx_power_dbm="30", antenna_height_m="10")
        for node in frozen["node.csv"]]
    frozen["frequency_resource.csv"] = [dict(freq_id="F1", device_class="HF", center_freq_khz="5000",
        bandwidth_khz="3", is_available="true", reuse_min_distance_m="60000", adjacent_guard_khz="3")]
    frozen["comm_demand.csv"] = [dict(demand_id="D1", task_id="unit", src_node_id="a", dst_node_id="b",
        is_mandatory="false", priority="P1", max_delay_ms="1000", required_rate_kbps="1",
        min_reliability="0.9", service_type="数据")]
    frozen["candidate_site.csv"] = []
    frozen["planning_input"] = dict(schema_version=1, bbox=[113.9, 36.9, 114.1, 37.1],
        stationIds=["a", "b"], deploymentConstraints=None,
        deploymentSolve=dict(mode="FIXED_COUNT", fixedCount=0, solutionCount=2))
    return frozen


def test_small_native_sr4_run_carries_inputs_and_keeps_fixed_zero(monkeypatch):
    from test_r4a_candidate_deployment import FlatTerrain

    frozen = small_native_tables()
    before = copy.deepcopy(frozen)
    monkeypatch.setattr(sr4_flow, "default_terrain", lambda **_: FlatTerrain())
    output = sr4_flow.run(task_id="unit", resource_rows=frozen, pop_size=8, generations=1, verbose=False)
    detail = output["optimization"]
    assert detail["planning_input"]["bbox"] == frozen["planning_input"]["bbox"]
    assert detail["candidate_filter"]["scanned_count"] == 0
    assert detail["deployment_solve"]["actual_count"] == 0
    assert detail["deployment_solve"]["count_satisfied"] is True
    assert detail["deployment_solve"]["requested_solution_count"] == 2
    assert detail["deployment_solve"]["returned_solution_count"] == len(detail["deployment_solve"]["solutions"])
    assert {row["node_id"] for row in output["nodes"]} == {"a", "b"}
    assert frozen == before


@pytest.fixture
def completed_job(monkeypatch, tmp_path):
    assert tmp_path.resolve().is_relative_to((ROOT / "data/runtime/r4").resolve())
    engine = create_engine("sqlite+pysqlite:///" + (tmp_path / "query.sqlite").as_posix())
    Base.metadata.create_all(engine, tables=[model.__table__ for model in (
        PlanningTask, PlanningTaskRevision, PlanningJob, PlanningJobCancellation,
        PlanningPlan, ResourceDatasetVersion)])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    resource_id = "resource-00000000000000a1"
    with factory.begin() as session:
        session.add(PlanningTask(task_id="task", current_revision_id="revision", current_version_no=1,
                                 created_at=now, updated_at=now))
        session.add(PlanningTaskRevision(revision_id="revision", task_id="task", version_no=1,
            condition_version="condition", resource_revision=resource_id, context="planning",
            input_snapshot=input_data(), created_at=now))
        session.add(PlanningJob(job_id="job", request_id="job-request", request_digest="a" * 64,
            task_id="task", revision_id="revision", condition_version="condition", resource_revision=resource_id,
            context="planning", status="SUCCESS", progress=1, stage="完成", created_at=now, updated_at=now))
    monkeypatch.setattr(JS.frontend_integration, "resource_revision", lambda: "resource-00000000000000b2")
    monkeypatch.setattr(JS.planning_w3, "get_task_record", lambda *_: dict(status="SUCCESS", progress=1,
        stage="完成", result=dict(solution_id="PL-R4A")))
    monkeypatch.setattr(W4, "get_plan", lambda *_: dict(code=0, data=dict(detail={})))

    def forbidden_current(*_args, **_kwargs):
        pytest.fail("完成作业不得读取当前CSV或当前资源表")

    monkeypatch.setattr(W4, "_load", forbidden_current)
    monkeypatch.setattr(JS.resource_dataset, "algorithm_tables", forbidden_current)
    yield factory, resource_id, now
    engine.dispose()


def add_frozen_resource(factory, resource_id, now, *, corrupt=False):
    _, snapshot = JS.resource_dataset.capture_files()
    snapshot["tables"]["device_model.csv"][0]["model_name"] = "FROZEN-R4A-MODEL"
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=resource_id,
            content_hash="0" * 64 if corrupt else JS.resource_dataset.content_hash(snapshot),
            source=JS.resource_dataset.SOURCE, data_origin=JS.resource_dataset.ORIGIN,
            snapshot=snapshot, created_at=now))
    return snapshot["tables"]


def test_normal_completed_job_projection_uses_its_historical_resource_tables(completed_job, monkeypatch):
    factory, resource_id, now = completed_job
    expected = add_frozen_resource(factory, resource_id, now)
    captured = []

    def adapt(plan, input_snapshot, *, resource_rows):
        captured.append(copy.deepcopy(resource_rows))
        return dict(model_name=resource_rows["device_model.csv"][0]["model_name"]), dict(code=0, message="success")

    monkeypatch.setattr(JS.planning_result_adapter, "adapt_planning_result", adapt)
    result = JS.query_planning_job("job", "task", factory)
    assert result["data"]["result"]["model_name"] == "FROZEN-R4A-MODEL"
    assert result["data"]["source_changed"] is True
    assert captured == [expected]
    assert result["data"]["resource_revision"] == resource_id


@pytest.mark.parametrize("corrupt", [False, True], ids=["missing", "corrupt"])
def test_unreadable_historical_resource_fails_without_csv_fallback(completed_job, monkeypatch, corrupt):
    factory, resource_id, now = completed_job
    if corrupt:
        add_frozen_resource(factory, resource_id, now, corrupt=True)
    calls = []
    monkeypatch.setattr(JS.planning_result_adapter, "adapt_planning_result", lambda *_a, **_k: calls.append(True))
    with pytest.raises(JS.PlanningJobError, match="SR4作业冻结资源不可读") as exc:
        JS.query_planning_job("job", "task", factory)
    assert exc.value.status == 503
    assert exc.value.code == (5002 if corrupt else 5003)
    assert not calls


@pytest.mark.parametrize("fail_child", [False, True])
def test_parent_candidates_are_invalidated_after_actual_child_recompute(monkeypatch, fail_child):
    from test_r4a_candidate_deployment import FlatTerrain
    import feasibility

    frozen = small_native_tables()
    frozen["node.csv"].extend([
        dict(node_id="c", node_subtype="I_FIXED", lon=114.02, lat=37.0),
        dict(node_id="d", node_subtype="I_MOBILE", lon=114.03, lat=37.0),
    ])
    frozen["device.csv"] = [dict(device_id=f"D-{node['node_id']}-{index}", node_id=node["node_id"],
        model_id="UNIT-HF", antenna_id="UNIT-ANT", tx_power_dbm="30", antenna_height_m="10")
        for node in frozen["node.csv"] for index in range(2)]
    frozen["frequency_resource.csv"] = [dict(freq_id=f"F{index}", device_class="HF", center_freq_khz=str(frequency),
        bandwidth_khz="3", is_available="true", reuse_min_distance_m="60000", adjacent_guard_khz="3")
        for index, frequency in enumerate((5000, 6000, 7000), 1)]
    frozen["comm_demand.csv"][0]["is_mandatory"] = "true"
    monkeypatch.setattr(sr4_flow, "default_terrain", lambda **_: FlatTerrain())
    # 受控解析传播夹具，保留实际频率、功率、路由和完整校验算法及6dB/90%门槛。
    loss = lambda *_a, **_k: (105.0, True, 0, 1000.0)
    monkeypatch.setattr(feasibility, "hf_path_loss", loss)
    monkeypatch.setattr(sr4_flow.IF, "hf_path_loss", loss)
    monkeypatch.setattr(sr4_flow.IF, "noise_floor_dbm", lambda *_a, **_k: -100.0)
    base = sr4_flow.run(task_id="unit", resource_rows=frozen, pop_size=8, generations=1, verbose=False)
    assert base["optimization"]["feasible"] and base["check"]["passed"], {
        "infeasible": base["optimization"]["infeasible"], "check": base["check"],
        "constraints": base["optimization"]["best"]["constraint_check"],
    }
    assert base["params"]["fade_margin_db"] >= 6
    assert base["optimization"]["deployment_solve"]["returned_solution_count"] >= 1
    parent = dict(detail={key: copy.deepcopy(base[key]) for key in (
        "nodes", "devices", "links", "optimization", "params", "routes", "frequency", "check")})
    before = copy.deepcopy(parent)
    adjustment = dict(manual_override=([dict(device_id=device["device_id"], tx_power_dbm=0.0)
        for device in base["devices"]] if fail_child else []), manual_paths=[])
    refs = [dict(device_id=device["device_id"], node_id=device["node_id"], band="HF") for device in base["devices"]]
    child = sr4_flow.run_from_parent(parent, adjustment, refs, "unit", frozen["comm_demand.csv"], resource_rows=frozen)
    assert child["optimization"]["feasible"] is (not fail_child)
    assert child["check"]["passed"] is (not fail_child)
    assert child["optimization"]["deployment_solve"]["solutions"] == []
    assert child["optimization"]["deployment_solve"]["returned_solution_count"] == 0
    assert any("已失效" in reason for reason in child["optimization"]["deployment_solve"]["shortfall_reasons"])
    assert child["nodes"] == parent["detail"]["nodes"]
    assert parent == before


@pytest.fixture
def parent_reservation(completed_job, monkeypatch):
    from app.planning_job_schemas import PlanningAdjustmentInput
    from test_r4a_candidate_deployment import conditions

    factory, resource_id, now = completed_job
    frozen = add_frozen_resource(factory, resource_id, now)
    data = input_data()
    data["deploymentSolve"] = dict(mode="MIN_COUNT", fixedCount=None, solutionCount=2)
    data["deploymentConstraints"] = conditions(maxSlopeDeg=10, minSiteSpacingM=500)
    raw = dict(solution_id="PL-PARENT", terrain_fingerprint="terrain-r4a", summary={}, detail=dict(
        nodes=[dict(node_id="a"), dict(node_id="b")],
        devices=[dict(device_id="D-a", node_id="a"), dict(device_id="D-b", node_id="b")],
        links=[dict(link_id="L1", node_a_id="a", node_b_id="b", device_a_id="D-a", device_b_id="D-b")]))
    with factory.begin() as session:
        revision = session.get(PlanningTaskRevision, "revision")
        revision.input_snapshot = copy.deepcopy(data)
        session.add(PlanningPlan(plan_id="parent", request_id="parent-save", request_digest="b" * 64,
            task_id="task", job_id="job", revision_id="revision", condition_version="condition",
            resource_revision=resource_id, version_no=1, name="父方案", note="", state="REFERENCE",
            input_snapshot=copy.deepcopy(data), raw_snapshot=raw,
            result_snapshot=dict(snapshot_id="SNP-PL-PARENT", devices=[dict(id="D-a", stationId="a", deviceClass="HF")]),
            outcome_snapshot=dict(code=0, message="success"), source="SR4", saved_at=now))
    adjustment = PlanningAdjustmentInput(schema_version=1, source_plan_id="parent", source_snapshot_id="SNP-PL-PARENT",
        manual_override=[dict(device_id="D-a", tx_power_dbm=10.0, antenna_height_m=12.0)],
        manual_paths=[dict(demand_id="demand", node_path=["a", "b"])])
    payload = PlanningJobSubmitRequest(context="planning", request_id="reserve-child", task_id="task",
        expected_revision="revision", input_version="revision", condition_version="condition",
        resource_revision=resource_id, parent_plan_id="parent", adjustment=adjustment)
    monkeypatch.setattr(JS.frontend_integration, "resource_revision", lambda: resource_id)
    monkeypatch.setattr(JS, "_validate_resources", lambda *_: None)
    monkeypatch.setattr(JS.resource_dataset, "database_mode", lambda: True)
    monkeypatch.setattr(JS.resource_dataset, "algorithm_tables", lambda *_: copy.deepcopy(frozen))
    monkeypatch.setattr(JS.planning_adjustment_service, "terrain_fingerprint", lambda: "terrain-r4a")
    return factory, payload, data, raw


def test_actual_reservation_allows_same_advanced_conditions_with_power_height_and_path_adjustment(parent_reservation):
    factory, payload, data, raw = parent_reservation
    with factory.begin() as session:
        revision = session.get(PlanningTaskRevision, "revision")
        revision.input_snapshot = dict(copy.deepcopy(data), name="仅改名称", description="允许修改说明")
    job, revision, created, algorithm = JS._reserve(factory, payload, JS._digest(payload))
    assert created and job.parent_plan_id == "parent"
    assert algorithm["parent_snapshot"] == raw
    assert algorithm["manual_device_refs"] == [dict(device_id="D-a", node_id="a", band="HF")]
    assert algorithm["resource_rows"]["planning_input"]["deploymentConstraints"] == data["deploymentConstraints"]
    assert algorithm["adjustment"]["manual_override"][0]["tx_power_dbm"] == 10.0
    with factory() as session:
        assert session.get(PlanningPlan, "parent").raw_snapshot == raw


@pytest.mark.parametrize("field", ["deploymentSolve", "deploymentConstraints", "bbox", "condition_version"])
def test_actual_reservation_still_rejects_changed_parent_deployment_conditions(parent_reservation, field):
    from sqlalchemy import func, select

    factory, payload, data, _raw = parent_reservation
    with factory.begin() as session:
        revision = session.get(PlanningTaskRevision, "revision")
        changed = copy.deepcopy(data)
        if field == "deploymentSolve":
            changed[field] = dict(mode="FIXED_COUNT", fixedCount=0, solutionCount=2)
        elif field == "deploymentConstraints":
            changed[field]["maxSlopeDeg"] = 5
        elif field == "bbox":
            changed[field][0] += 0.01
        else:
            revision.condition_version = "condition-changed"
            payload = payload.model_copy(update={"condition_version": "condition-changed"})
        revision.input_snapshot = changed
    with pytest.raises(JS.PlanningJobError, match="任务条件与父方案冻结输入不一致") as exc:
        JS._reserve(factory, payload, JS._digest(payload))
    assert exc.value.status == 409 and exc.value.code == 1203
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(PlanningJob)) == 1
