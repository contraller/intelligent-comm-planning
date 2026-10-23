"""采纳桥测试桩只模拟共享规划落库；不代表完整SR4重算已通过。"""
from copy import deepcopy
from datetime import timedelta

import pytest

from test_interference_workbench_api import BASE, wb, scene_api, data, headers, submit, progress
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
