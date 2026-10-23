"""独立SQLite/HTTP测试；EngineStub仅验证状态机，不作为真实算法证据。"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import threading

import pytest
from sqlalchemy import select

from test_interference_frontend_api import api as scene_api, body, data, headers, read, save
from app.interference_analysis_engine import digest
from app.interference_workbench_models import InterferenceWorkbenchRun as Run
from app.interference_workbench_router import router
from app.interference_workbench_schemas import RunSubmit
from app.interference_workbench_service import InterferenceWorkbenchService, now
from app.planning_plan_models import PlanningPlan

BASE = "/api/v1/interference/workbench"


class EngineStub:
    def __init__(self):
        self.calls = 0
        self.on_analyze = None

    def probe_plan(self, plan):
        return []

    def validate_source(self, source):
        pass

    def analyze(self, source, progress, cancelled):
        self.calls += 1
        progress(30, "测试计算检查点")
        if self.on_analyze:
            self.on_analyze()
        change = {"type": "FREQ_ADJUST", "target": {"link_id": "L1"},
                  "detail": {"links_in_net": ["L1"], "to_freq_khz": 5000}}
        preview = {"measure_id": "CM1", "before_configuration": {}, "proposed_changes": change,
                   "impact_after": None, "metrics": None, "available": True, "unavailable_reasons": []}
        return {"affected_nodes": [], "affected_links": [], "affected_area": {"type": "FeatureCollection", "features": []},
            "summary": {"affected_nodes": 0, "affected_links": 0}, "measure_review": [], "unresolved": [],
            "parameter_substitutions": [], "notes": ["测试桩"],
            "measures": [{"measure_id": "CM1", "type": "FREQ_ADJUST", "available": True,
                          "change_set": change, "preview_hash": digest(preview)}],
            "previews": {"CM1": {**preview, "preview_hash": digest(preview)}}}


@pytest.fixture
def wb(scene_api):
    client, factory, baseline, path, raw = scene_api
    engine = EngineStub()
    service = InterferenceWorkbenchService(factory, engine=engine)
    client.app.include_router(router)
    client.app.state.interference_workbench = service
    data(save(scene_api, body(scene_api, interference_ids=[])))
    scene = data(read(scene_api))["version"]
    return scene_api, service, engine, scene


def submit_body(wb, **changes):
    scene = wb[3]
    return {"request_id": "submit-1", "task_id": "T1", "plan_id": "P1", "plan_version": "V1",
        "resource_revision": scene["resource_revision"], "scene_id": "SC1", "scene_version_id": scene["version_id"],
        "snapshot_hash": scene["snapshot_hash"], **changes}


def submit(wb, **changes):
    client = wb[0][0]
    return client.post(BASE + "/runs", json=submit_body(wb, **changes), headers=headers(client))


def progress(wb, run_id):
    return data(wb[0][0].get(BASE + f"/runs/{run_id}/progress", params={"task_id": "T1"}))


def test_submit_worker_persisted_preview_and_read_only(wb):
    client = wb[0][0]
    receipt = data(submit(wb))
    run_id = receipt["object_id"]
    assert progress(wb, run_id)["state"] == "PENDING" and wb[2].calls == 0
    assert data(client.get(BASE, params={"task_id": "T1"}))["interference_sources"]
    assert wb[1].run_once()
    detail = data(client.get(BASE + f"/runs/{run_id}", params={"task_id": "T1"}))
    assert detail["state"] == "SUCCESS" and detail["progress"] == 100
    assert "previews" not in detail["result"] and detail["adoption_capabilities"]["FREQ_ADJUST"]["enabled"] is False
    preview = data(client.get(BASE + f"/runs/{run_id}/measures/CM1/preview",
        params={"task_id": "T1", "expected_run_version": detail["run_version"]}))
    assert preview["metrics"] is None
    assert wb[2].calls == 1
    reopened = InterferenceWorkbenchService(wb[0][1], engine=EngineStub())
    from app.interference_workbench_schemas import TaskQuery
    assert reopened.detail(run_id, TaskQuery(task_id="T1")) == detail
    assert data(submit(wb)) == receipt


@pytest.mark.parametrize("patch", [{"expected": 1}, {"plan_version": "V0"}, {"snapshot_hash": "a"},
                                  {"request_id": "bad/id"}, {"scene_version_id": "missing"}])
def test_reject_invalid_or_missing_without_acceptance(wb, patch):
    response = submit(wb, **patch)
    assert response.status_code in (404, 409, 422)
    with wb[0][1]() as session:
        assert session.scalar(select(Run)) is None


def test_active_unique_digest_actor_and_task_scope(wb):
    receipt = data(submit(wb))
    assert submit(wb, request_id="other").json()["code"] == 2002
    assert submit(wb, scene_id="different").json()["code"] == 1206
    client = wb[0][0]
    assert client.get(BASE + f"/runs/{receipt['object_id']}", params={"task_id": "other"}).status_code == 404
    assert data(client.get(BASE + "/operations/submit-1", params={"task_id": "T1", "operation": "SUBMIT_ANALYSIS"})) == receipt
    assert client.get(BASE + "/operations/submit-1", params={"task_id": "T1", "operation": "CANCEL_ANALYSIS"}).status_code == 404


@pytest.mark.parametrize("during", [False, True])
def test_cancel_requested_not_success_and_late_result_ignored(wb, during):
    client = wb[0][0]
    run_id = data(submit(wb))["object_id"]
    def cancel():
        version = progress(wb, run_id)["run_version"]
        response = data(client.post(BASE + f"/runs/{run_id}/cancel", headers=headers(client), json={
            "request_id": "cancel-1", "task_id": "T1", "expected_run_version": version}))
        assert response["object_state"] == "CANCEL_REQUESTED"
        assert progress(wb, run_id)["state"] == "CANCEL_REQUESTED"
    if during:
        wb[2].on_analyze = cancel
    else:
        cancel()
    wb[1].run_once()
    assert progress(wb, run_id)["state"] == "CANCELLED"
    assert wb[2].calls == int(during)
    assert data(client.get(BASE + f"/runs/{run_id}", params={"task_id": "T1"}))["result"] is None


def test_failure_recovery_and_hash_damage(wb):
    run_id = data(submit(wb))["object_id"]
    with wb[0][1].begin() as session:
        row = session.get(Run, run_id)
        row.state, row.lease_owner, row.lease_until = "RUNNING", "dead-worker", now() - timedelta(seconds=1)
    assert progress(wb, run_id)["state"] == "RUNNING"
    wb[1].recover_expired()
    assert progress(wb, run_id)["state"] == "FAILED"
    with wb[0][1].begin() as session:
        session.get(Run, run_id).source_hash = "a" * 64
    assert wb[0][0].get(BASE + f"/runs/{run_id}", params={"task_id": "T1"}).json()["code"] == 5002


def test_permissions_csrf_query_and_service_registration(wb):
    client = wb[0][0]
    assert client.post(BASE + "/runs", json=submit_body(wb)).json()["code"] == 1106
    assert client.get(BASE + "/sources?page=01").status_code == 422
    assert client.get(BASE + "/sources?page=1&page=2").status_code == 422
    challenge = headers(client)
    data(client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-reviewer"}, headers=challenge))
    assert client.post(BASE + "/runs", json=submit_body(wb), headers=headers(client)).status_code == 403
    del client.app.state.interference_workbench
    assert client.get(BASE).status_code == 503


def test_worker_failure_keeps_current_plan_unchanged(wb):
    def explode():
        raise RuntimeError("构造算法异常")
    wb[2].on_analyze = explode
    run_id = data(submit(wb))["object_id"]
    wb[1].run_once()
    assert progress(wb, run_id)["error"] == "构造算法异常"
    with wb[0][1]() as session:
        assert session.get(PlanningPlan, "P1").raw_snapshot == wb[0][4]


def test_two_submitters_replay_one_durable_run(wb):
    actor = {"account_id": "integration-planner"}
    payload = RunSubmit.model_validate(submit_body(wb))
    with ThreadPoolExecutor(max_workers=2) as pool:
        receipts = list(pool.map(lambda _: wb[1].submit_run(payload, actor), range(2)))
    assert receipts[0] == receipts[1]
    with wb[0][1]() as session:
        assert len(session.scalars(select(Run)).all()) == 1


def test_only_one_worker_claims_pending_run(wb):
    run_id = data(submit(wb))["object_id"]
    entered, release = threading.Event(), threading.Event()
    def checkpoint():
        entered.set()
        assert release.wait(60)
    wb[2].on_analyze = checkpoint
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(wb[1].run_once)
        assert entered.wait(60)
        try:
            assert wb[1].run_once() is False
        finally:
            release.set()
        assert first.result(timeout=60)
    assert wb[2].calls == 1 and progress(wb, run_id)["state"] == "SUCCESS"
