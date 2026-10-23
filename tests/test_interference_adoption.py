"""采纳桥测试桩只模拟共享规划落库；不代表完整SR4重算已通过。"""
from copy import deepcopy
from datetime import timedelta

import pytest

from test_interference_workbench_api import BASE, wb, scene_api, data, headers, submit, progress
from test_interference_analysis_engine import frozen_sample
from app.interference_analysis_engine import MEASURE_TYPES
from app.interference_replan_service import InterferenceReplanService
from app.interference_workbench_models import InterferenceWorkbenchAdoption
from app.interference_workbench_service import now
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan


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


def test_cancellation_waits_for_worker_checkpoint_not_runtime_request(wb, monkeypatch):
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


def test_native_dispatch_creates_one_real_frozen_child(scene_api, frozen_sample, monkeypatch):
    """真实W3/W4小样本派发；措施为显式构造，不冒充算法推荐/完整页面验收。"""
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
    adjustment, _, _, unit_parent, _, engine = _prepare_sample(frozen_sample, monkeypatch)
    raw = deepcopy(unit_parent.raw_snapshot)
    raw["detail"]["devices"] = raw["detail"]["devices"][:2]
    raw["detail"]["nodes"] = raw["detail"]["nodes"][:2]
    raw["detail"]["links"] = raw["detail"]["links"][:1]
    raw["detail"]["params"]["params"] = raw["detail"]["params"]["params"][:2]
    client, factory, baseline, _, _ = scene_api
    input_data = {"name": "UNIT真实派发", "presetId": "balanced", "frequencyId": "default",
        "constraints": {"connectivityPercent": 100, "survivabilityPercent": 0, "maxRelayHops": 2},
        "demands": [{"id": "UNIT-DEMAND", "sourceId": raw["detail"]["nodes"][0]["node_id"],
            "targetId": raw["detail"]["nodes"][1]["node_id"], "priority": 1, "mandatory": True,
            "requiredRateKbps": 1, "maxDelayMs": 1000, "minReliability": .1, "service": "DATA"}]}
    modules = _modules()
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
        parent.result_snapshot = {"snapshot_id": "SNP-PL-12345678", "devices": unit_parent.result_snapshot["devices"][:2]}
        session.get(PlanningTaskRevision, "REV-P1").input_snapshot = deepcopy(input_data)
    data(save(scene_api, body(scene_api, interference_ids=[])))
    scene = data(read(scene_api))["version"]
    resource = resources.current(factory)
    source = {"schema_version": 1, "scene": scene, "resource": resource,
              "actor": {"account_id": "integration-planner"}}
    task = modules["frequency"].tasks_from_nets(raw["detail"]["links"], raw["detail"]["nodes"],
        raw["detail"]["devices"], resource["tables"]["device_model.csv"])[0]
    modules["frequency"]._prepare([task], modules["frequency"].FreqPool(resource["tables"]["frequency_resource.csv"]))
    change = {"type": "FREQ_ADJUST", "target": {"link_id": "L1", "net_id": task.task_id},
        "detail": {"links_in_net": ["L1"], "to_freq_khz": task.allowed[1]["freq_khz"]}}
    measure = {"measure_id": "CM-UNIT", "type": "FREQ_ADJUST", "available": True, "change_set": change}
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
        origin = InterferenceReplanService.origin(row)
    request = {"adoption_id": "IAD-UNIT", "task_id": "T1", "planning_request_id": "UNIT-NATIVE-CHILD",
        "actor_id": "integration-planner", "interference_origin": origin, "source": source, "change_set": change}
    complete = threading.Event()
    real_submit = jobs.planning_w4.submit_sr4
    def observed(payload, *, job_id, on_update):
        def update(state):
            on_update(state)
            if state["status"] in ("SUCCESS", "FAILED", "CANCELLED"):
                complete.set()
        return real_submit(payload, job_id=job_id, on_update=update)
    monkeypatch.setattr(jobs.planning_w4, "submit_sr4", observed)
    job_id = jobs.submit_interference_replan(request, factory)
    assert complete.wait(120), "真实小样本线程未结束；不能当已通过"
    with factory() as session:
        job = session.get(PlanningJob, job_id)
        assert job.status == "SUCCESS", job.error
        assert job.request_id == request["planning_request_id"] and job.parent_plan_id == "P1"
        assert session.get(InterferenceWorkbenchAdoption, "IAD-UNIT").planning_job_id == job_id
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == raw
    runtime = jobs.planning_w3.get_task_record(job_id)
    plan = jobs.planning_w4.get_plan(runtime["result"]["solution_id"])["data"]
    assert InterferenceReplanService.applied(change, plan["detail"])
    assert plan["detail"]["interference"]["effect"]["origin"] == origin
    assert plan["detail"]["interference"]["effect"]["sources"] == []
    assert jobs.submit_interference_replan(request, factory) == job_id
    with factory() as session:
        assert len(session.scalars(select(PlanningJob).where(PlanningJob.request_id == "UNIT-NATIVE-CHILD")).all()) == 1
    assert resources.current(factory) == resource
