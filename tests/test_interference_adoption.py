"""分别验证显式测试桩与真实小样本桥，不代表完整SR4或页面验收。"""
from copy import deepcopy
from contextlib import contextmanager
from datetime import timedelta
import threading

import pytest

from test_interference_workbench_api import BASE, wb, scene_api, data, headers, submit, progress
from test_interference_analysis_engine import frozen_sample
from app.interference_analysis_engine import MEASURE_TYPES
from app.interference_replan_service import InterferenceReplanService
from app.interference_workbench_models import InterferenceWorkbenchAdoption
from app.interference_workbench_service import now
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan


@pytest.fixture
def _native_runtime(monkeypatch):
    """仅给真实规划入口绑定独立算法目录；DB仍由scene_api放在本树tmp。"""
    from uuid import uuid4
    from app import planning_w3, planning_w4
    from app.interference_analysis_engine import runtime_path
    root = runtime_path() / ("pytest-adoption-" + uuid4().hex)
    assert not root.exists(), "只创建新GUID运行目录，禁止复用既有业务证据"
    tasks, plans = root / "tasks", root / "plans"
    tasks.mkdir(parents=True, exist_ok=False)
    plans.mkdir(exist_ok=False)
    monkeypatch.setattr(planning_w3, "TASK_DIR", tasks)
    monkeypatch.setattr(planning_w4, "PLAN_DIR", plans)
    return root  # 保留测试文件；不删除、不修改生产guard或既有runtime。


class BridgeStub:
    supported_types = frozenset(MEASURE_TYPES)
    supports_frozen_sources = True

    def __init__(self, factory, *, omit_change=False):
        self.factory, self.omit_change = factory, omit_change
        self.submissions, self.cancellations = 0, 0

    def submit(self, request):
        self.submissions += 1
        with self.factory.begin() as session:
            parent = session.get(PlanningPlan, "P1")
            job = PlanningJob(job_id="CHILD-JOB", request_id=request["planning_request_id"], request_digest="c" * 64,
                task_id="T1", revision_id=parent.revision_id, condition_version=parent.condition_version,
                resource_revision=parent.resource_revision, context="planning", parent_plan_id="P1",
                adjustment={"interference_origin": request["interference_origin"]}, status="SUCCESS", progress=1,
                stage="测试桩重算", created_at=now(), updated_at=now())
            session.add(job)
            session.flush()
            raw = deepcopy(parent.raw_snapshot)
            raw["detail"]["frequency"] = {"link_assignments": [{"link_id": "L1", "freq_khz": 4000 if self.omit_change else 5000}]}
            session.add(PlanningPlan(plan_id="CHILD-PLAN", request_id="save-child", request_digest="d" * 64,
                task_id="T1", job_id=job.job_id, revision_id=parent.revision_id, condition_version=parent.condition_version,
                resource_revision=parent.resource_revision, parent_plan_id="P1", adjustment=deepcopy(job.adjustment),
                version_no=2, name="构造子方案", note="不是真实SR4证据", state="REFERENCE",
                input_snapshot=deepcopy(parent.input_snapshot), result_snapshot={}, raw_snapshot=raw,
                outcome_snapshot={}, source="SR4", saved_at=now()))
        return "CHILD-JOB"

    def poll(self, request):
        return {"state": "SUCCESS", "progress": 100, "plan_id": "CHILD-PLAN", "error": None}

    def cancel(self, request):
        self.cancellations += 1


def ready(wb, bridge):
    wb[1].replanner.bridge = bridge
    run_id = data(submit(wb))["object_id"]
    wb[1].run_once()
    run = progress(wb, run_id)
    return {"request_id": "adopt-1", "task_id": "T1", "run_id": run_id, "measure_id": "CM1",
        "expected_run_version": run["run_version"], "plan_id": "P1", "plan_version": "V1",
        "resource_revision": wb[3]["resource_revision"], "scene_version_id": wb[3]["version_id"], "snapshot_hash": wb[3]["snapshot_hash"]}


def adoption(wb, payload):
    client = wb[0][0]
    return client.post(BASE + "/adoptions", json=payload, headers=headers(client))


def test_unwired_replan_explicit_unavailable(wb):
    payload = ready(wb, None)
    assert adoption(wb, payload).json()["code"] == 2002


@pytest.mark.parametrize("omit_change", [False, True])
def test_durable_adoption_verifies_actual_child_and_preserves_parent(wb, omit_change):
    bridge = BridgeStub(wb[0][1], omit_change=omit_change)
    payload = ready(wb, bridge)
    receipt = data(adoption(wb, payload))
    assert receipt["planning_job_id"] is None and receipt["plan_id"] is None
    wb[1].run_once()
    client = wb[0][0]
    result = data(client.get(BASE + "/adoptions/" + receipt["object_id"], params={"task_id": "T1"}))
    assert result["state"] == ("FAILED" if omit_change else "SUCCESS")
    assert result["planning_progress"] == 100
    assert result["result_plan_id"] == (None if omit_change else "CHILD-PLAN")
    assert data(adoption(wb, payload)) == receipt and bridge.submissions == 1
    with wb[0][1]() as session:
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == wb[0][4]


def test_cancel_pending_never_dispatches(wb):
    bridge = BridgeStub(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    client = wb[0][0]
    path = BASE + "/adoptions/" + receipt["object_id"]
    data(client.post(path + "/cancel", json={"request_id": "cancel-adopt", "task_id": "T1", "expected_adoption_version": 1}, headers=headers(client)))
    wb[1].run_once()
    assert data(client.get(path, params={"task_id": "T1"}))["state"] == "CANCELLED"
    assert bridge.submissions == 0


def test_dispatch_unknown_outcome_recovers_by_stable_child_key(wb, monkeypatch):
    bridge = BridgeStub(wb[0][1])
    payload = ready(wb, bridge)
    receipt = data(adoption(wb, payload))
    original = bridge.submit
    def interrupted(request):
        original(request)
        raise RuntimeError("模拟子作业提交成功后连接中断")
    monkeypatch.setattr(bridge, "submit", interrupted)
    wb[1].run_once()
    with wb[0][1].begin() as session:
        row = session.get(InterferenceWorkbenchAdoption, receipt["object_id"])
        assert row.planning_job_id is None and row.error
        row.lease_until = now() - timedelta(seconds=1)
    wb[1].run_once()
    result = data(wb[0][0].get(BASE + "/adoptions/" + receipt["object_id"], params={"task_id": "T1"}))
    assert result["state"] == "SUCCESS" and result["planning_job_id"] == "CHILD-JOB"
    assert bridge.submissions == 1


def test_later_explicit_confirmation_does_not_break_adoption_history(wb):
    bridge = BridgeStub(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    wb[1].run_once()
    with wb[0][1].begin() as session:
        session.get(PlanningPlan, "CHILD-PLAN").state = "CONFIRMED"
        session.get(PlanningCurrentPlan, "T1").plan_id = "CHILD-PLAN"
    result = data(wb[0][0].get(BASE + "/adoptions/" + receipt["object_id"], params={"task_id": "T1"}))
    assert result["state"] == "SUCCESS" and result["result_plan_state"] == "CONFIRMED"
    detail = data(wb[0][0].get(BASE + "/runs/" + result["run_id"], params={"task_id": "T1"}))
    assert detail["source_state"]["state"] == "HISTORICAL"
    assert not any(cap["enabled"] for cap in detail["adoption_capabilities"].values())


def test_child_job_fractional_progress_is_explicitly_percent(wb):
    class ProgressBridge(BridgeStub):
        def poll(self, request):
            with self.factory.begin() as session:
                job = session.get(PlanningJob, "CHILD-JOB")
                job.status, job.progress = "RUNNING", 0.25
            return {"state": "RUNNING", "progress": 25, "plan_id": None, "error": None}
    bridge = ProgressBridge(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    wb[1].run_once()
    result = data(wb[0][0].get(BASE + "/adoptions/" + receipt["object_id"], params={"task_id": "T1"}))
    assert result["state"] == "RUNNING" and result["planning_progress"] == 25
    assert result["result_plan_id"] is None


@pytest.mark.parametrize("kind", MEASURE_TYPES)
def test_five_change_verifiers_reject_omissions(kind):
    change = {"type": kind, "target": {"link_id": "L1", "node_id": "N1"},
        "detail": {"links_in_net": ["L1"], "to_freq_khz": 5100, "to_lon": 10, "to_lat": 20,
                   "rerouted": [{"demand_id": "C1", "primary": {"node_path": ["N1", "N3", "N2"]}, "backup": None}]},
        "device_changes": [{"device_id": "D1", "tx_power_dbm": 40}]}
    detail = {"frequency": {"link_assignments": [{"link_id": "L1", "freq_khz": 5100}]},
        "params": {"params": [{"device_id": "D1", "tx_power_dbm": 40}]},
        "nodes": [{"node_id": "N1", "lon": 10, "lat": 20}], "routes": {"routes": deepcopy(change["detail"]["rerouted"])}}
    assert InterferenceReplanService.applied(change, detail)
    assert not InterferenceReplanService.applied(change, {})


def test_cancellation_waits_for_worker_checkpoint_not_runtime_request(wb, monkeypatch, _native_runtime):
    from sqlalchemy import select
    from app import planning_job_service as jobs
    from app.planning_job_models import PlanningJobCancellation
    from app.planning_job_schemas import PlanningJobCancelRequest
    bridge = BridgeStub(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    wb[1].run_once()
    with wb[0][1].begin() as session:
        job = session.get(PlanningJob, "CHILD-JOB")
        job.status, job.progress = "RUNNING", .25
        revision = job.revision_id
    runtime = {"status": "RUNNING", "progress": .25, "stage": "构造计算检查点之前"}
    monkeypatch.setattr(jobs.planning_w3, "get_task_record", lambda _: deepcopy(runtime))
    monkeypatch.setattr(jobs.planning_w3, "cancel_task", lambda _: runtime.update(status="CANCELLED", progress=1))
    payload = PlanningJobCancelRequest(context="planning", request_id="UNIT-CANCEL-CHECKPOINT", task_id="T1", expected_revision=revision)
    jobs.request_interference_cancellation("CHILD-JOB", payload, wb[0][1])
    assert jobs.query_planning_job("CHILD-JOB", "T1", wb[0][1])["data"]["status"] == "RUNNING"
    with wb[0][1]() as session:
        assert session.scalar(select(PlanningJobCancellation)).outcome_status == "CANCEL_REQUESTED"
    assert jobs.stop_frozen_planning_jobs(wb[0][1], timeout=0) is False
    jobs._update_interference_job(wb[0][1], "CHILD-JOB", runtime)
    assert jobs.query_planning_job("CHILD-JOB", "T1", wb[0][1])["data"]["status"] == "CANCELLED"
    with wb[0][1]() as session:
        assert session.scalar(select(PlanningJobCancellation)).outcome_status == "CANCELLED"
    assert jobs.stop_frozen_planning_jobs(wb[0][1], timeout=0) is True


@pytest.mark.parametrize("runtime_status", [None, "PENDING", "RUNNING", "CANCELLED", "SUCCESS"])
def test_startup_recovery_preserves_unacknowledged_cancellation_as_failure(wb, monkeypatch, runtime_status, _native_runtime):
    """构造崩溃后遗留状态，不模拟杀进程，也不删除已有任务/方案证据。"""
    from app import planning_job_service as jobs
    from app.interference_replan_service import FrozenPlanningReplanner
    from app.planning_job_models import PlanningJobCancellation
    factory = wb[0][1]
    with factory.begin() as session:
        parent = session.get(PlanningPlan, "P1")
        for job_id, status, interference in (("INTERRUPTED", "RUNNING", True),
                ("ACKNOWLEDGED", "CANCELLED", True), ("MANUAL", "RUNNING", False)):
            session.add(PlanningJob(job_id=job_id, request_id="UNIT-RECOVER-" + job_id,
                request_digest="e" * 64, task_id="T1", revision_id=parent.revision_id,
                condition_version=parent.condition_version, resource_revision=parent.resource_revision,
                context="planning", parent_plan_id="P1", adjustment={"interference_origin": {
                    "adoption_id": "UNIT-INTERRUPTED", "actor_id": "UNIT"}} if interference else {},
                status=status, progress=.25, stage="构造中断证据，非真实杀进程",
                created_at=now(), updated_at=now()))
        session.flush()
        session.add(PlanningJobCancellation(request_id="UNIT-RECOVER-CANCEL", request_digest="f" * 64,
            job_id="INTERRUPTED", task_id="T1", revision_id=parent.revision_id,
            outcome_status="CANCEL_REQUESTED", created_at=now()))
    runtime = {"status": runtime_status, "progress": 1, "stage": "构造磁盘记录"} if runtime_status else None
    monkeypatch.setattr(jobs.planning_w3, "get_task_record", lambda _: deepcopy(runtime))
    def must_not_dispatch_or_cancel(*args, **kwargs):
        raise AssertionError("启动恢复不得重派或把取消请求当作检查点")
    monkeypatch.setattr(jobs.planning_w4, "submit_sr4", must_not_dispatch_or_cancel)
    monkeypatch.setattr(jobs.planning_w3, "cancel_task", must_not_dispatch_or_cancel)
    bridge = FrozenPlanningReplanner(factory)
    with pytest.raises(jobs.PlanningJobError) as rejected:
        bridge.recover_interrupted()
    assert rejected.value.code == 1001
    assert bridge.recover_interrupted(exclusive_runtime=True) == ["INTERRUPTED"]
    assert bridge.recover_interrupted(exclusive_runtime=True) == []
    assert jobs.query_planning_job("INTERRUPTED", "T1", factory)["data"]["status"] == "FAILED"
    jobs._update_interference_job(factory, "INTERRUPTED", {"status": "CANCELLED", "progress": 1})
    with factory() as session:
        assert session.get(PlanningJob, "INTERRUPTED").status == "FAILED"
        assert session.get(PlanningJobCancellation, "UNIT-RECOVER-CANCEL").outcome_status == "FAILED"
        assert session.get(PlanningJob, "ACKNOWLEDGED").status == "CANCELLED"
        assert session.get(PlanningJob, "MANUAL").status == "RUNNING"
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == wb[0][4]


def test_recovered_child_reaches_failed_adoption_history_without_redispatch(wb, monkeypatch, _native_runtime):
    from sqlalchemy import func, select
    from app import planning_job_service as jobs
    from app.interference_replan_service import FrozenPlanningReplanner
    from app.planning_job_schemas import PlanningJobCancelRequest
    class PendingBridge(BridgeStub):
        def submit(self, request):
            self.submissions += 1
            with self.factory.begin() as session:
                parent = session.get(PlanningPlan, "P1")
                session.add(PlanningJob(job_id="UNIT-LOST-CHILD", request_id=request["planning_request_id"],
                    request_digest="e" * 64, task_id="T1", revision_id=parent.revision_id,
                    condition_version=parent.condition_version, resource_revision=parent.resource_revision,
                    context="planning", parent_plan_id="P1", adjustment={"interference_origin": request["interference_origin"]},
                    status="RUNNING", progress=.25, stage="构造进程中断状态，非真实SR4",
                    created_at=now(), updated_at=now()))
            return "UNIT-LOST-CHILD"
        def poll(self, request):
            return {"state": "RUNNING", "progress": 25, "plan_id": None, "error": None}
    pending = PendingBridge(wb[0][1])
    payload = ready(wb, pending)
    receipt = data(adoption(wb, payload))
    wb[1].run_once()
    path = BASE + "/adoptions/" + receipt["object_id"]
    current = data(wb[0][0].get(path, params={"task_id": "T1"}))
    assert current["state"] == "RUNNING" and pending.submissions == 1
    data(wb[0][0].post(path + "/cancel", json={"request_id": "UNIT-LOST-ADOPTION-CANCEL",
        "task_id": "T1", "expected_adoption_version": current["adoption_version"]}, headers=headers(wb[0][0])))
    monkeypatch.setattr(jobs.planning_w3, "get_task_record", lambda _: {"status": "CANCELLED", "progress": 1})
    monkeypatch.setattr(jobs.planning_w3, "cancel_task", lambda _: None)
    with wb[0][1]() as session:
        revision = session.get(PlanningJob, "UNIT-LOST-CHILD").revision_id
    jobs.request_interference_cancellation("UNIT-LOST-CHILD", PlanningJobCancelRequest(context="planning",
        request_id="UNIT-LOST-CANCEL", task_id="T1", expected_revision=revision), wb[0][1])
    bridge = FrozenPlanningReplanner(wb[0][1])
    assert bridge.recover_interrupted(exclusive_runtime=True) == ["UNIT-LOST-CHILD"]
    wb[1].replanner.bridge = bridge
    assert wb[1].run_once()
    final = data(wb[0][0].get(path, params={"task_id": "T1"}))
    assert final["state"] == "FAILED" and final["result_plan_id"] is None
    assert "未持久化" in final["error"] and pending.submissions == 1
    assert data(adoption(wb, payload)) == receipt
    with wb[0][1]() as session:
        assert session.scalar(select(func.count()).select_from(PlanningJob).where(
            PlanningJob.request_id == receipt["planning_request_id"])) == 1
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == wb[0][4]


def _native_dispatch_case(scene_api, frozen_sample, monkeypatch, kind, *, progress_observer=None,
                          after_submit=None, expected_state="SUCCESS", accepted_receipt=True):
    """真实W3/W4小样本；措施显式UNIT构造，不冒充推荐/完整页面验收。"""
    import importlib
    import threading
    from sqlalchemy import select
    from test_interference_analysis_engine import _prepare_sample
    from test_interference_frontend_api import body, read, save
    from app import planning_job_service as jobs
    from app import resource_dataset_service as resources
    from app.interference_analysis_engine import digest, _modules
    from app.interference_workbench_models import InterferenceWorkbenchRun
    from app.task_input_models import PlanningTaskRevision
    from app.task_input_schemas import PlanningInput
    adjustment, _, _, unit_parent, _, engine = _prepare_sample(frozen_sample, monkeypatch)
    raw = deepcopy(unit_parent.raw_snapshot)
    count = 3 if kind == "ROUTE_REBUILD" else 2
    raw["detail"]["devices"] = raw["detail"]["devices"][:count]
    raw["detail"]["nodes"] = raw["detail"]["nodes"][:count]
    raw["detail"]["links"] = raw["detail"]["links"][:3 if count == 3 else 1]
    raw["detail"]["params"]["params"] = raw["detail"]["params"]["params"][:count]
    client, factory, baseline, _, _ = scene_api
    modules = _modules()
    if kind == "POWER_OPT":
        models = {row["model_id"]: row for row in baseline["tables"]["device_model.csv"]}
        candidates = [row for row in baseline["tables"]["device.csv"] if row.get("availability", "ACTIVE") == "ACTIVE"
            and models[row["model_id"]]["device_class"] == "VUHF"
            and len(modules["radio_params"].power_levels_of(models[row["model_id"]])) > 1]
        first = candidates[0]
        second = next(row for row in candidates if row["model_id"] == first["model_id"] and row["node_id"] != first["node_id"])
        raw["detail"]["devices"] = deepcopy([first, second])
        nodes = {row["node_id"]: row for row in baseline["tables"]["node.csv"]}
        raw["detail"]["nodes"] = [deepcopy(nodes[row["node_id"]]) for row in (first, second)]
        for index, node in enumerate(raw["detail"]["nodes"]):
            node.update(lon=str(114 + index * .01), lat="38")
        raw["detail"]["links"][0].update(node_a_id=first["node_id"], node_b_id=second["node_id"],
            device_a_id=first["device_id"], device_b_id=second["device_id"])
        raw["detail"]["params"]["params"] = [{"device_id": row["device_id"], "tx_power_dbm": float(row["tx_power_dbm"]),
            "antenna_height_m": float(row["antenna_height_m"])} for row in (first, second)]
    site = None
    if kind == "NODE_REDEPLOY":
        site = next(row for row in baseline["tables"]["candidate_site.csv"] if row["is_deployable"] == "true")
        lon, lat = float(site["lon"]), float(site["lat"])
        for index, node in enumerate(raw["detail"]["nodes"]):
            node.update(lon=str(lon - .002 + index * .005), lat=str(lat + .003))
        engine.terrain_provider = lambda: modules["terrain"].SyntheticTerrain((lon - .02, lat - .02, lon + .02, lat + .02))
    input_data = {"name": "UNIT真实派发", "description": "合成小网，仅模块算法与持久化证据，非实测或生产方案",
        "bbox": list(engine.terrain_provider().bbox), "stationIds": [row["node_id"] for row in raw["detail"]["nodes"]],
        "presetId": "balanced", "frequencyId": "available-vuhf",
        "constraints": {"connectivityPercent": 100, "survivabilityPercent": 90, "maxRelayHops": 2},
        "demands": [{"id": "UNIT-DEMAND", "sourceId": raw["detail"]["nodes"][0]["node_id"],
            "targetId": raw["detail"]["nodes"][1]["node_id"], "priority": "P1", "mandatory": True, "dataVolumeMb": 1,
            "requiredRateKbps": 1, "maxDelayMs": 1000, "minReliability": .1, "service": "数据"}]}
    input_data = PlanningInput.model_validate(input_data).model_dump(mode="json")
    fq = modules["frequency"]
    frozen_tasks = fq.tasks_from_nets(raw["detail"]["links"], raw["detail"]["nodes"], raw["detail"]["devices"], baseline["tables"]["device_model.csv"])
    fq.fill_ranges_by_node(frozen_tasks, raw["detail"]["links"], raw["detail"]["nodes"], raw["detail"]["devices"], baseline["tables"]["device_model.csv"])
    raw["detail"]["frequency"] = fq.assign(frozen_tasks, fq.FreqPool(baseline["tables"]["frequency_resource.csv"]))
    raw["detail"]["frequency"]["link_assignments"] = fq.expand_to_links(raw["detail"]["frequency"], frozen_tasks)
    raw["detail"]["routes"] = modules["routing"].plan_routes(
        modules["routing"].graph_from_links(raw["detail"]["links"])[0], [{"demand_id": "UNIT-DEMAND",
            "src_node_id": input_data["demands"][0]["sourceId"], "dst_node_id": input_data["demands"][0]["targetId"]}])
    flow = importlib.import_module("sr4_flow")
    monkeypatch.setattr(flow, "DemTerrain", engine.terrain_provider)
    monkeypatch.setattr(adjustment, "FrozenInterferenceEngine", lambda **kw: engine)
    with factory.begin() as session:
        parent = session.get(PlanningPlan, "P1")
        parent.raw_snapshot, parent.input_snapshot = raw, deepcopy(input_data)
        parent.result_snapshot = {"snapshot_id": "SNP-PL-12345678", "devices": [
            {"id": row["device_id"], "stationId": row["node_id"], "deviceClass": "VUHF"} for row in raw["detail"]["devices"]]}
        session.get(PlanningTaskRevision, "REV-P1").input_snapshot = deepcopy(input_data)
    data(save(scene_api, body(scene_api, interference_ids=[])))
    scene = data(read(scene_api))["version"]
    resource = resources.current(factory)
    source = {"schema_version": 1, "scene": scene, "resource": resource,
              "actor": {"account_id": "integration-planner"}}
    task = next(row for row in modules["frequency"].tasks_from_nets(raw["detail"]["links"], raw["detail"]["nodes"],
        raw["detail"]["devices"], resource["tables"]["device_model.csv"]) if "L1" in row.members)
    modules["frequency"]._prepare([task], modules["frequency"].FreqPool(resource["tables"]["frequency_resource.csv"]))
    change = {"type": kind, "target": {"link_id": "L1", "net_id": task.task_id}, "detail": {}}
    if kind in ("FREQ_ADJUST", "CHANNEL_SWITCH"):
        previous = next(row["freq_khz"] for row in raw["detail"]["frequency"]["assignments"] if row["task_id"] == task.task_id)
        change["detail"] = {"links_in_net": list(task.members),
            "to_freq_khz": next(row["freq_khz"] for row in task.allowed if row["freq_khz"] != previous)}
    elif kind == "POWER_OPT":
        _, _, _, caps, _, _ = engine._build(source)
        link = raw["detail"]["links"][0]
        did = link["device_a_id"]
        previous = next(row["tx_power_dbm"] for row in raw["detail"]["params"]["params"] if row["device_id"] == did)
        power = next(level for level in caps[did].levels if abs(level - previous) > .051)
        change["detail"] = {"tx_changes": [{"node_id": link["node_a_id"], "band": "VUHF", "from_dbm": previous, "to_dbm": power}]}
        change["device_changes"] = [{"device_id": did, "tx_power_dbm": power}]
    elif kind == "NODE_REDEPLOY":
        change["target"]["node_id"] = raw["detail"]["nodes"][0]["node_id"]
        change["detail"] = {"to_site_id": site["site_id"], "to_lon": float(site["lon"]), "to_lat": float(site["lat"])}
    else:
        change["detail"] = {"banned_links": ["L1"], "rerouted": [{"demand_id": "UNIT-DEMAND", "reachable": True,
            "primary": {"node_path": [raw["detail"]["nodes"][0]["node_id"], "UNIT-N3", raw["detail"]["nodes"][1]["node_id"]],
                        "link_path": ["L2", "L3"]}, "backup": None, "backup_type": "NONE"}]}
    measure = {"measure_id": "CM-UNIT", "type": kind, "available": True, "change_set": change}
    with factory.begin() as session:
        session.add(InterferenceWorkbenchRun(run_id="IR-UNIT", request_id="UNIT-RUN", task_id="T1", plan_id="P1",
            scene_version_id=scene["version_id"], resource_revision=baseline["revision"], run_version=1,
            state="SUCCESS", progress=100, phase="显式构造措施测试", source_snapshot=source, source_hash=digest(source),
            result_snapshot={"measures": [measure]}, result_hash=digest({"measures": [measure]}),
            actor_id="integration-planner", started_at=now(), updated_at=now()))
        session.flush()
        row = InterferenceWorkbenchAdoption(adoption_id="IAD-UNIT", task_id="T1", run_id="IR-UNIT", measure_id="CM-UNIT",
            adoption_version=1, state="RUNNING", source_hash=digest(source), change_set=change, change_hash=digest(change),
            planning_request_id="UNIT-NATIVE-CHILD", actor_id="integration-planner", created_at=now(), updated_at=now())
        session.add(row)
        if accepted_receipt:
            from app.interference_workbench_schemas import AdoptionSubmit
            from app.interference_workbench_service import InterferenceWorkbenchService
            # 显式UNIT原件补齐后台授权前提；不冒称HTTP登录/采纳流程已验收。
            accepted = AdoptionSubmit(request_id="UNIT-NATIVE-ACCEPT", task_id=row.task_id,
                run_id=row.run_id, measure_id=row.measure_id, expected_run_version=1,
                plan_id="P1", plan_version=scene["plan_version"], resource_revision=baseline["revision"],
                scene_version_id=scene["version_id"], snapshot_hash=scene["snapshot_hash"])
            session.flush()
            InterferenceWorkbenchService(factory)._receipt(session, accepted, "ADOPT_MEASURE",
                {"account_id": row.actor_id}, row,
                digest({"operation": "ADOPT_MEASURE", "actor": row.actor_id, "body": accepted.model_dump()}), True,
                {"adoption_id": row.adoption_id, "planning_request_id": row.planning_request_id,
                 "planning_job_id": None, "plan_id": None})
        origin = InterferenceReplanService.origin(row)
    request = {"adoption_id": "IAD-UNIT", "task_id": "T1", "planning_request_id": "UNIT-NATIVE-CHILD",
        "actor_id": "integration-planner", "interference_origin": origin, "source": source, "change_set": change, "measure": measure}
    complete = threading.Event()
    real_submit = jobs.planning_w4.submit_sr4
    def observed(payload, *, job_id, on_update):
        def update(state):
            on_update(state)
            if progress_observer is not None:
                progress_observer(state)
            if state["status"] in ("SUCCESS", "FAILED", "CANCELLED"):
                complete.set()
        return real_submit(payload, job_id=job_id, on_update=update)
    monkeypatch.setattr(jobs.planning_w4, "submit_sr4", observed)
    for patch in ({"actor_id": "UNIT-SPOOF"}, {"task_id": "UNIT-OTHER"},
                  {"change_set": {**change, "type": "UNIT-UNSUPPORTED"}}):
        with pytest.raises(jobs.PlanningJobError) as rejected:
            jobs.submit_interference_replan({**request, **patch}, factory)
        assert rejected.value.code == 1203
    with factory() as session:
        assert session.scalar(select(PlanningJob.job_id).where(PlanningJob.request_id == request["planning_request_id"])) is None
    job_id = jobs.submit_interference_replan(request, factory)
    request["planning_job_id"] = job_id
    if after_submit is not None:
        after_submit(jobs, factory, request)
    assert complete.wait(120), "真实小样本线程未结束；不能当已通过"
    with factory() as session:
        job = session.get(PlanningJob, job_id)
        assert job.status == expected_state, job.error
        assert job.request_id == request["planning_request_id"] and job.parent_plan_id == "P1"
        assert session.get(InterferenceWorkbenchAdoption, "IAD-UNIT").planning_job_id == job_id
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == raw
    runtime = jobs.planning_w3.get_task_record(job_id)
    if expected_state == "SUCCESS":
        plan = jobs.planning_w4.get_plan(runtime["result"]["solution_id"])["data"]
        assert InterferenceReplanService.applied(change, plan["detail"])
        assert plan["detail"]["interference"]["effect"]["origin"] == origin
        assert plan["detail"]["interference"]["effect"]["sources"] == []
    else:
        assert runtime["status"] == expected_state and not (runtime.get("result") or {}).get("solution_id")
        with factory() as session:
            assert session.scalar(select(PlanningPlan.plan_id).where(PlanningPlan.job_id == job_id)) is None
    assert jobs.submit_interference_replan(request, factory) == job_id
    with factory() as session:
        assert len(session.scalars(select(PlanningJob).where(PlanningJob.request_id == "UNIT-NATIVE-CHILD")).all()) == 1
    assert resources.current(factory) == resource
    return jobs, factory, request, raw, resource, engine


@pytest.mark.parametrize("kind", MEASURE_TYPES)
def test_native_dispatch_creates_one_real_frozen_child(scene_api, frozen_sample, monkeypatch, kind, _native_runtime):
    _native_dispatch_case(scene_api, frozen_sample, monkeypatch, kind)


def _has_frozen_adapter():
    from inspect import signature
    from app.planning_result_adapter import adapt_planning_result
    return "resource_rows" in signature(adapt_planning_result).parameters


@pytest.mark.skipif(not _has_frozen_adapter(), reason="main冻结adapter已实现，但P03树尚未取得其精确依赖提交；不复制源码")
@pytest.mark.parametrize("kind", MEASURE_TYPES)
def test_native_bridge_saves_replays_and_reopens_without_runtime(scene_api, frozen_sample, monkeypatch, kind, _native_runtime):
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker
    from app.interference_replan_service import FrozenPlanningReplanner
    from app.interference_workbench_schemas import TaskQuery
    from app.interference_workbench_service import InterferenceWorkbenchService
    jobs, factory, request, raw, resource, engine = _native_dispatch_case(scene_api, frozen_sample, monkeypatch, kind)
    bridge = FrozenPlanningReplanner(factory)
    outcome = bridge.poll(request)
    with factory() as session:
        child = session.get(PlanningPlan, outcome["plan_id"])
        expected = "SAVED" if child.outcome_snapshot["code"] == 0 else "REFERENCE"
        assert child.state == expected and child.confirmed_at is None
        assert child.raw_snapshot["detail"]["interference"]["effect"]["origin"] == request["interference_origin"]
        assert child.raw_snapshot["detail"]["interference"]["effect"]["sources"] == []
        assert InterferenceReplanService.applied(request["change_set"], child.raw_snapshot["detail"])
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == raw
        expected_result = deepcopy(child.result_snapshot)
    service = InterferenceWorkbenchService(factory, engine=engine, replanner=bridge)
    assert service.run_once()
    adopted = service.replanner.detail("IAD-UNIT", TaskQuery(task_id="T1"))
    assert adopted["state"] == "SUCCESS" and adopted["result_plan_id"] == outcome["plan_id"]
    assert bridge.poll(request) == outcome
    reopened = create_engine("sqlite:///" + str(scene_api[3]), connect_args={"check_same_thread": False})
    new_factory = sessionmaker(bind=reopened, expire_on_commit=False)
    try:
        monkeypatch.setattr(jobs.planning_w3, "get_task_record", lambda _: None)
        def no_current_or_plan_file(*args, **kwargs):
            raise AssertionError("已保存冻结历史不能从运行文件重组")
        monkeypatch.setattr(jobs.planning_w4, "get_plan", no_current_or_plan_file)
        rebuilt = FrozenPlanningReplanner(new_factory)
        assert rebuilt.poll(request) == outcome
        assert jobs.query_planning_job(request["planning_job_id"], "T1", new_factory)["data"]["result"] == expected_result
        with new_factory() as session:
            assert len(session.scalars(select(PlanningPlan).where(PlanningPlan.job_id == request["planning_job_id"])).all()) == 1
    finally:
        reopened.dispose()


def test_native_child_cooperative_cancel_waits_and_joins_worker(scene_api, frozen_sample, monkeypatch, _native_runtime):
    import threading
    from sqlalchemy import select
    from app.planning_job_models import PlanningJobCancellation
    from app.planning_job_schemas import PlanningJobCancelRequest
    entered, release = threading.Event(), threading.Event()
    workers = []
    def observe(state):
        if state["status"] == "RUNNING" and state["progress"] == .2:
            workers.append(threading.current_thread())
            entered.set()
            assert release.wait(120), "测试必须释放真实算法线程"
    def cancel_at_checkpoint(jobs, factory, request):
        try:
            assert entered.wait(120), "真实W3/W4未到冻结拓扑检查点"
            with factory() as session:
                revision = session.get(PlanningJob, request["planning_job_id"]).revision_id
            jobs.request_interference_cancellation(request["planning_job_id"], PlanningJobCancelRequest(
                context="planning", request_id="UNIT-COOPERATIVE-CANCEL", task_id="T1", expected_revision=revision),
                factory, actor_id=request["actor_id"])
            assert jobs.planning_w3.get_task_record(request["planning_job_id"])["status"] == "CANCELLED"
            assert jobs.query_planning_job(request["planning_job_id"], "T1", factory)["data"]["status"] == "RUNNING"
            assert jobs.stop_frozen_planning_jobs(factory, timeout=0) is False
            with pytest.raises(jobs.PlanningJobError) as rejected:
                jobs.recover_interrupted_interference_jobs(factory, exclusive_runtime=True)
            assert rejected.value.code == 2002
        finally:
            release.set()
    try:
        jobs, factory, request, *_ = _native_dispatch_case(scene_api, frozen_sample, monkeypatch, "FREQ_ADJUST",
            progress_observer=observe, after_submit=cancel_at_checkpoint, expected_state="CANCELLED")
        assert jobs.stop_frozen_planning_jobs(factory, timeout=0) is True
        with factory() as session:
            outcomes = list(session.scalars(select(PlanningJobCancellation.outcome_status).where(
                PlanningJobCancellation.job_id == request["planning_job_id"])))
            assert outcomes and set(outcomes) == {"CANCELLED"}
    finally:
        release.set()
        for worker in workers:
            worker.join(timeout=120)
            assert not worker.is_alive(), "不能留下仍在运行的本组算法线程"


@pytest.mark.skipif(not _has_frozen_adapter(), reason="需要main已审冻结adapter依赖提交")
def test_native_late_cancel_preserves_real_saved_adoption(scene_api, frozen_sample, monkeypatch, _native_runtime):
    from sqlalchemy import select
    from app.interference_replan_service import FrozenPlanningReplanner
    from app.interference_workbench_schemas import TaskQuery
    from app.interference_workbench_service import InterferenceWorkbenchService
    from app.planning_job_models import PlanningJobCancellation
    jobs, factory, request, raw, _, engine = _native_dispatch_case(scene_api, frozen_sample, monkeypatch, "FREQ_ADJUST")
    bridge = FrozenPlanningReplanner(factory)
    with factory.begin() as session:
        session.get(InterferenceWorkbenchAdoption, request["adoption_id"]).state = "CANCEL_REQUESTED"
    service = InterferenceWorkbenchService(factory, engine=engine, replanner=bridge)
    assert service.run_once()
    adopted = service.replanner.detail(request["adoption_id"], TaskQuery(task_id="T1"))
    assert adopted["state"] == "SUCCESS" and adopted["result_plan_id"]
    with factory() as session:
        assert session.get(PlanningJob, request["planning_job_id"]).status == "SUCCESS"
        assert session.scalar(select(PlanningJobCancellation.outcome_status).where(
            PlanningJobCancellation.job_id == request["planning_job_id"])) == "SUCCESS"
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == raw


def _submit_lock_available_from_other_thread():
    """不能在持RLock的同一线程探测；用独立线程非阻塞获取，无sleep猜时序。"""
    from app import planning_job_service as jobs
    available, errors = [], []

    def probe():
        try:
            acquired = jobs._SUBMIT_LOCK.acquire(blocking=False)
            available.append(acquired)
            if acquired:
                jobs._SUBMIT_LOCK.release()
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=probe, daemon=True)
    thread.start()
    thread.join(timeout=5)
    assert not thread.is_alive(), "状态锁探测线程必须结束"
    assert not errors, errors
    assert len(available) == 1
    return available[0]


@pytest.mark.parametrize("before,after", [
    ("PENDING", "RUNNING"), ("RUNNING", "SUCCESS"),
    ("RUNNING", "FAILED"), ("RUNNING", "CANCELLED"),
])
def test_poll_state_window_serializes_callback_until_wb_commit(wb, monkeypatch, before, after):
    """显式桥桩控制旧快照；另一线程走真实状态回调，非算法/UI验收。"""
    from app import planning_job_service as jobs
    attempted, updated = threading.Event(), threading.Event()
    workers, errors, contended = [], [], []

    class RacingBridge(BridgeStub):
        polls = 0

        def submit(self, request):
            job_id = super().submit(request)
            with self.factory.begin() as session:
                child = session.get(PlanningPlan, "CHILD-PLAN")
                self.child = {column.name: deepcopy(getattr(child, column.name))
                              for column in PlanningPlan.__table__.columns}
                session.delete(child)
                job = session.get(PlanningJob, job_id)
                job.status, job.progress = before, 0 if before == "PENDING" else .25
            return job_id

        def poll(self, request):
            self.polls += 1
            # 独立连接可开写事务，证明调用桥时没有持有WB写事务。
            with self.factory.begin() as session:
                session.connection().exec_driver_sql("BEGIN IMMEDIATE")
                job = session.get(PlanningJob, request["planning_job_id"])
                snapshot = {"state": job.status, "progress": job.progress * 100,
                            "plan_id": None, "error": job.error}
                if job.status == "SUCCESS":
                    session.add(PlanningPlan(**deepcopy(self.child)))
                    snapshot["plan_id"] = "CHILD-PLAN"
            if self.polls == 1:
                def advance():
                    try:
                        acquired = jobs._SUBMIT_LOCK.acquire(blocking=False)
                        contended.append(not acquired)
                        if acquired:
                            jobs._SUBMIT_LOCK.release()
                        attempted.set()
                        assert jobs._SUBMIT_LOCK.acquire(timeout=5), "原回调不能永久等待状态锁"
                        try:
                            jobs._update_interference_job(self.factory, request["planning_job_id"], {
                                "status": after, "progress": .5 if after == "RUNNING" else 1,
                                "stage": "UNIT受控回调", "error": "UNIT计算失败" if after == "FAILED" else None})
                        finally:
                            jobs._SUBMIT_LOCK.release()
                    except BaseException as exc:
                        errors.append(exc)
                    finally:
                        updated.set()
                thread = threading.Thread(target=advance, daemon=True)
                workers.append(thread)
                thread.start()
                assert attempted.wait(5), "回调必须在返回旧快照前尝试状态锁"
            return snapshot

    bridge = RacingBridge(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    original_transaction = wb[1].transaction
    committed_lock_available = []

    @contextmanager
    def transaction(*, writing=False):
        with original_transaction(writing=writing) as session:
            yield session
        if writing:
            # 在真实commit之后、退出调用方with之前探测，不能只保护poll。
            committed_lock_available.append(_submit_lock_available_from_other_thread())

    monkeypatch.setattr(wb[1], "transaction", transaction)
    try:
        assert wb[1].run_once()
        assert updated.wait(5), "WB提交释放状态锁后，原回调必须能完成"
    finally:
        for worker in workers:
            worker.join(timeout=5)
            assert not worker.is_alive(), "不能遗留本组状态回调线程"
    assert not errors, errors
    assert contended == [True]
    # Workbench空分析扫描 -> replanner领取租约 -> 关联job -> poll后最终提交。
    # 前三段均先结束；只有最后一段commit仍被状态锁保护。
    assert committed_lock_available == [True, True, True, False]
    with wb[0][1]() as session:
        row = session.get(InterferenceWorkbenchAdoption, receipt["object_id"])
        assert row.state == "RUNNING" and row.error is None and row.lease_owner is None
        assert row.result_plan_id is None
        assert session.get(PlanningJob, "CHILD-JOB").status == after
    assert wb[1].run_once()
    final = data(wb[0][0].get(BASE + "/adoptions/" + receipt["object_id"], params={"task_id": "T1"}))
    assert final["state"] == after
    assert final["planning_job_id"] == "CHILD-JOB"
    assert final["result_plan_id"] == ("CHILD-PLAN" if after == "SUCCESS" else None)
    assert final["error"] == ("UNIT计算失败" if after == "FAILED" else None)
    assert bridge.submissions == 1 and bridge.polls == 2
    with wb[0][1]() as session:
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == wb[0][4]


@pytest.mark.parametrize("persisted,reported", [
    ("RUNNING", "SUCCESS"), ("FAILED", "CANCELLED"),
    ("CANCELLED", "SUCCESS"), ("SUCCESS", "RUNNING"),
])
def test_poll_state_window_still_rejects_exact_mismatch(wb, persisted, reported):
    class MismatchedBridge(BridgeStub):
        def poll(self, request):
            with self.factory.begin() as session:
                job = session.get(PlanningJob, request["planning_job_id"])
                job.status = persisted
                job.progress = .5 if persisted == "RUNNING" else 1
            return {"state": reported, "progress": 100, "plan_id": "CHILD-PLAN", "error": None}

    bridge = MismatchedBridge(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    assert wb[1].run_once()
    path = BASE + "/adoptions/" + receipt["object_id"]
    result = data(wb[0][0].get(path, params={"task_id": "T1"}))
    assert result["state"] == "FAILED" and result["result_plan_id"] is None
    assert result["error"] == "桥回报与持久化作业状态不一致"
    assert result["planning_state"] == persisted
    assert wb[1].run_once() is False  # FAILED历史不能被重新领取或变成成功。
    assert data(wb[0][0].get(path, params={"task_id": "T1"})) == result
    assert bridge.submissions == 1 and _submit_lock_available_from_other_thread()


@pytest.mark.parametrize("fault", ["job-request", "job-origin", "plan-parent", "plan-origin", "measure-omitted"])
def test_poll_state_window_preserves_child_source_and_measure_checks(wb, fault):
    class InvalidChildBridge(BridgeStub):
        def poll(self, request):
            with self.factory.begin() as session:
                job = session.get(PlanningJob, "CHILD-JOB")
                plan = session.get(PlanningPlan, "CHILD-PLAN")
                if fault == "job-request":
                    job.request_id = "UNIT-FOREIGN-REQUEST"
                elif fault == "job-origin":
                    origin = deepcopy(job.adjustment)
                    origin["interference_origin"]["source_hash"] = "f" * 64
                    job.adjustment = origin
                elif fault == "plan-parent":
                    plan.parent_plan_id = None
                elif fault == "plan-origin":
                    origin = deepcopy(plan.adjustment)
                    origin["interference_origin"]["source_hash"] = "f" * 64
                    plan.adjustment = origin
                else:
                    raw = deepcopy(plan.raw_snapshot)
                    raw["detail"]["frequency"]["link_assignments"][0]["freq_khz"] = 4000
                    plan.raw_snapshot = raw
            return super().poll(request)

    bridge = InvalidChildBridge(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    assert wb[1].run_once()
    # 错job来源的DTO也必须拒绝，直接核对持久化事实避免绕开该只读校验。
    with wb[0][1]() as session:
        row = session.get(InterferenceWorkbenchAdoption, receipt["object_id"])
        assert row.state == "FAILED" and row.result_plan_id is None
        expected = ("共享规划作业没有回显精确冻结来源" if fault.startswith("job-") else
                    "真实重算结果未应用所采纳的措施" if fault == "measure-omitted" else
                    "共享重算没有真实保存正确的新方案")
        assert row.error == expected
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == wb[0][4]
    assert bridge.submissions == 1 and _submit_lock_available_from_other_thread()


@pytest.mark.parametrize("exit_path", ["poll-error", "mismatch", "lease-lost", "already-final"])
def test_poll_state_window_releases_lock_on_error_and_early_return(wb, exit_path):
    class ExitingBridge(BridgeStub):
        polls = 0

        def poll(self, request):
            self.polls += 1
            if exit_path == "poll-error":
                raise RuntimeError("UNIT桥传输失败")
            if exit_path in ("lease-lost", "already-final"):
                with self.factory.begin() as session:
                    row = session.get(InterferenceWorkbenchAdoption, request["adoption_id"])
                    if exit_path == "lease-lost":
                        row.lease_owner = "UNIT-OTHER-WORKER"
                    else:
                        row.state, row.error = "FAILED", "UNIT既有终态"
                        row.lease_owner, row.lease_until = None, None
            if exit_path == "mismatch":
                return {"state": "FAILED", "progress": 100, "plan_id": None, "error": None}
            return super().poll(request)

    bridge = ExitingBridge(wb[0][1])
    receipt = data(adoption(wb, ready(wb, bridge)))
    assert wb[1].run_once()
    assert _submit_lock_available_from_other_thread(), "异常/return均必须释放最外层RLock"
    with wb[0][1]() as session:
        row = session.get(InterferenceWorkbenchAdoption, receipt["object_id"])
        assert row.result_plan_id is None
        if exit_path == "poll-error":
            assert row.state == "RUNNING" and row.error == "UNIT桥传输失败"
        elif exit_path == "mismatch":
            assert row.state == "FAILED" and row.error == "桥回报与持久化作业状态不一致"
        elif exit_path == "lease-lost":
            assert row.state == "RUNNING" and row.lease_owner == "UNIT-OTHER-WORKER"
        else:
            assert row.state == "FAILED" and row.error == "UNIT既有终态"
    assert bridge.submissions == 1 and bridge.polls == 1


def test_poll_state_window_native_reference_saved_once(scene_api, frozen_sample, monkeypatch, _native_runtime):
    """真实W3/W4两节点单边小样本天然不满足90%抗毁；不改门槛/结果。"""
    from sqlalchemy import func, select
    from app import planning_job_service as jobs, planning_plan_service as plans
    from app.interference_replan_service import FrozenPlanningReplanner
    from app.interference_workbench_schemas import TaskQuery
    from app.interference_workbench_service import InterferenceWorkbenchService
    dispatches, saves = [], []
    real_dispatch = jobs.planning_w4.submit_sr4
    real_save = plans.save_planning_plan

    def dispatch(payload, **kwargs):
        dispatches.append(kwargs["job_id"])
        return real_dispatch(payload, **kwargs)

    def save(payload, *args, **kwargs):
        saves.append(payload.model_dump())
        return real_save(payload, *args, **kwargs)

    monkeypatch.setattr(jobs.planning_w4, "submit_sr4", dispatch)
    monkeypatch.setattr(plans, "save_planning_plan", save)
    jobs, factory, request, raw, _, engine = _native_dispatch_case(
        scene_api, frozen_sample, monkeypatch, "FREQ_ADJUST")
    original = jobs.query_planning_job(request["planning_job_id"], "T1", factory)["data"]
    assert original["status"] == "SUCCESS" and original["saved_plan_id"] is None
    assert original["outcome"]["code"] == 3001 and original["outcome"]["gap"]
    assert next(check for check in original["result"]["checks"] if check["id"] == "survivability")["passed"] is False
    assert original["input"]["constraints"]["survivabilityPercent"] == 90
    bridge = FrozenPlanningReplanner(factory)
    service = InterferenceWorkbenchService(factory, engine=engine, replanner=bridge)
    assert service.run_once()
    adopted = service.replanner.detail(request["adoption_id"], TaskQuery(task_id="T1"))
    assert adopted["state"] == "SUCCESS" and adopted["planning_state"] == "SUCCESS"
    assert adopted["result_plan_state"] == "REFERENCE" and adopted["error"] is None
    assert adopted["planning_job_id"] == request["planning_job_id"]
    assert service.run_once() is False
    replay = bridge.poll(request)
    assert replay["state"] == "SUCCESS" and replay["plan_id"] == adopted["result_plan_id"]
    assert dispatches == [request["planning_job_id"]]
    assert len(saves) == 1 and saves[0]["request_id"] == "interference-save-" + request["adoption_id"]
    with factory() as session:
        child = session.get(PlanningPlan, adopted["result_plan_id"])
        assert child.state == "REFERENCE" and child.confirmed_at is None
        assert child.result_snapshot == original["result"] and child.outcome_snapshot == original["outcome"]
        assert child.raw_snapshot["detail"]["interference"]["effect"]["origin"] == request["interference_origin"]
        assert InterferenceReplanService.applied(request["change_set"], child.raw_snapshot["detail"])
        assert session.scalar(select(func.count()).select_from(PlanningPlan).where(
            PlanningPlan.job_id == request["planning_job_id"])) == 1
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == raw
    assert _submit_lock_available_from_other_thread()
