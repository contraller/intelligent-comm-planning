"""独立SQLite/HTTP测试；EngineStub仅验证状态机，不作为真实算法证据。"""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import threading

import pytest
from sqlalchemy import select

from test_interference_frontend_api import api as scene_api, body, data, headers, read, save
from test_interference_analysis_engine import frozen_sample
from app.interference_analysis_engine import digest, FrozenInterferenceEngine
from app.interference_workbench_models import InterferenceWorkbenchRun as Run
from app.interference_workbench_router import router
from app.interference_workbench_schemas import RunSubmit
from app.interference_workbench_service import InterferenceWorkbenchService, now
from app.planning_plan_models import PlanningPlan
from app import resource_dataset_service as resources
from app.task_input_models import PlanningTaskRevision

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


def test_accepted_run_freezes_effective_parameters_separately_from_scene(wb):
    from app.interference_workbench_schemas import TaskQuery
    api, service, engine, previous = wb
    data(save(api, body(api, request_id="scene-with-sources", base_scene_version_id=previous["version_id"])))
    wb = (api, service, engine, data(read(api))["version"])
    # 只用状态机桩替代执行；参数标准化调用真实逻辑，不把桩称为传播计算证据。
    engine.freeze_parameters = FrozenInterferenceEngine.freeze_parameters
    scene_before = deepcopy(wb[3])
    receipt = data(submit(wb))
    detail = service.detail(receipt["object_id"], TaskQuery(task_id="T1"))
    assert detail["source"] == scene_before
    assert len(detail["analysis_parameters"]) == len(scene_before["interference_ids"])
    first = detail["analysis_parameters"][0]
    assert first["parameters"]["antenna_gain_dbi"] == float(scene_before["interference_sources"][0]["source_row"]["antenna_gain_dbi"])
    assert "冻结场景" in first["sources"]["antenna_gain_dbi"]
    with api[1]() as session:
        run = session.get(Run, receipt["object_id"])
        assert digest(run.source_snapshot) == run.source_hash
        assert run.source_snapshot["scene"] == scene_before
        assert run.source_snapshot["analysis_parameters"] == detail["analysis_parameters"]
    # 调用方改动返回副本不能改变持久化的冻结有效参数。
    first["parameters"]["antenna_gain_dbi"] = 999
    assert service.detail(receipt["object_id"], TaskQuery(task_id="T1"))["analysis_parameters"] != detail["analysis_parameters"]
    accepted_parameters = service.detail(receipt["object_id"], TaskQuery(task_id="T1"))["analysis_parameters"]
    def update_resource(snapshot):
        snapshot["tables"]["interference_source.csv"][0]["antenna_gain_dbi"] = "88"
        return True, {"object_id": "test-resource-change", "affected_ids": [], "warnings": []}
    resources.commit_device_change(scene_before["resource_revision"], "resource-after-acceptance", "a" * 64,
                                   "test-fixture", update_resource)
    historical = service.detail(receipt["object_id"], TaskQuery(task_id="T1"))
    assert historical["source_state"]["state"] == "HISTORICAL"
    assert historical["analysis_parameters"] == accepted_parameters and historical["source"] == scene_before


def test_legacy_invalid_parameters_are_422_not_version_conflict(scene_api):
    api = scene_api
    def legacy_parameters(snapshot):
        first, second = snapshot["tables"]["interference_source.csv"][:2]
        first.update(name="历史缺增益源", antenna_gain_dbi="", bandwidth_khz="0")
        second.update(name="历史缺方位源", pattern_type="DIRECTIONAL", azimuth_deg="")
        return True, {"object_id": "legacy-parameters", "affected_ids": [], "warnings": []}
    resources.commit_device_change(api[2]["revision"], "legacy-parameters", "b" * 64, "test-fixture", legacy_parameters)
    snapshot = resources.current()
    with api[1].begin() as session:
        session.get(PlanningPlan, "P1").resource_revision = snapshot["revision"]
        session.get(PlanningTaskRevision, "REV-P1").resource_revision = snapshot["revision"]
    api = (api[0], api[1], snapshot, *api[3:])
    data(save(api, body(api)))
    engine = EngineStub()
    engine.freeze_parameters = FrozenInterferenceEngine.freeze_parameters
    service = InterferenceWorkbenchService(api[1], engine=engine)
    api[0].app.include_router(router)
    api[0].app.state.interference_workbench = service
    wb = (api, service, engine, data(read(api))["version"])
    response = submit(wb)
    assert response.status_code == 422 and response.json()["code"] == 1001
    message = response.json()["message"]
    assert all(text in message for text in ("历史缺增益源", "天线增益", "带宽", "历史缺方位源", "方位角", "IF-0001", "IF-0002"))
    with api[1]() as session:
        assert session.scalar(select(Run)) is None


def test_resource_change_before_acceptance_is_explicit_conflict_not_silent_refresh(wb):
    def update_resource(snapshot):
        snapshot["tables"]["interference_source.csv"][0]["antenna_gain_dbi"] = "77"
        return True, {"object_id": "before-acceptance", "affected_ids": [], "warnings": []}
    resources.commit_device_change(wb[3]["resource_revision"], "resource-before-acceptance", "c" * 64,
                                   "test-fixture", update_resource)
    response = submit(wb)
    assert response.status_code == 409 and response.json()["code"] == 1205
    assert "资源版本已变化" in response.json()["message"]
    assert data(read(wb[0]))["version"] == wb[3]
    with wb[0][1]() as session:
        assert session.scalar(select(Run)) is None


@pytest.mark.parametrize("gain", [0, -2])
def test_manual_source_http_save_scene_submit_and_native_small_analysis(scene_api, frozen_sample, gain, monkeypatch):
    """真实HTTP+隔离SQLite+原生小拓扑算法；地形显式合成，不冒充真实DEM联调。"""
    from app import resource_geography
    from app.resource_workspace_router import router as workspace_router
    api = scene_api
    client, factory, baseline, _, raw = api
    monkeypatch.setattr(resource_geography, "read_planning_bounds", lambda: (113.9, 36.9, 114.1, 37.1))
    client.app.include_router(workspace_router)
    data(client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-editor"}, headers=headers(client)))
    frequency = frozen_sample[2]
    manual = {"id": "MANUAL-J", "name": "手工完整流程源", "coordinate": [114.005, 37.001], "elevationM": None,
        "antennaHeightM": 0 if gain == 0 else 20, "centerFreqKhz": frequency, "bandwidthKhz": 25, "txPowerDbm": -10,
        "antennaGainDbi": gain, "interferenceType": "NOISE", "patternType": None,
        "azimuthDeg": None, "dutyCycle": None, "active": True, "origin": "MANUAL"}
    saved = data(client.post("/api/v1/resource/workspace/changes", headers=headers(client), json={
        "context": "gis", "base_revision": baseline["revision"], "request_id": "save-manual-source",
        "changes": {"newInterferences": [manual]}}))
    revision = saved["receipt"]["revision"]
    plan_raw = {**deepcopy(raw), **deepcopy(frozen_sample[1]["scene"]["plan_snapshot"]["raw_snapshot"])}
    for node in plan_raw["detail"]["nodes"]:
        node["lat"] = "37.0"
    node_ids = [row["node_id"] for row in plan_raw["detail"]["nodes"]]
    plan_raw["detail"]["routes"] = {"routes": [{"demand_id": "C1", "primary": {
        "node_path": node_ids, "link_path": ["L1"]}, "backup": None}]}
    with factory.begin() as session:
        plan = session.get(PlanningPlan, "P1")
        plan.resource_revision, plan.raw_snapshot = revision, plan_raw
        session.get(PlanningTaskRevision, "REV-P1").resource_revision = revision
    data(client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-planner"}, headers=headers(client)))
    data(save(api, body(api, resource_revision=revision, interference_ids=[manual["id"]])))
    scene = data(read(api))["version"]
    terrain = frozen_sample[0].terrain_provider().__class__((113.995, 36.995, 114.02, 37.01))
    engine = FrozenInterferenceEngine(terrain_provider=lambda: terrain, fingerprint_provider=lambda: "TEST-TERRAIN")
    service = InterferenceWorkbenchService(factory, engine=engine)
    client.app.include_router(router)
    client.app.state.interference_workbench = service
    wb = (api, service, engine, scene)
    receipt = data(submit(wb))
    accepted = data(client.get(BASE + "/runs/" + receipt["object_id"], params={"task_id": "T1"}))
    assert accepted["state"] == "PENDING"
    assert accepted["analysis_parameters"][0]["parameters"]["antenna_gain_dbi"] == gain
    assert accepted["analysis_parameters"][0]["parameters"]["antenna_height_m"] == manual["antennaHeightM"]
    assert accepted["analysis_parameters"][0]["parameters"]["duty_cycle"] == 1
    assert service.run_once()
    final = data(client.get(BASE + "/runs/" + receipt["object_id"], params={"task_id": "T1"}))
    assert final["state"] == "SUCCESS", final["error"]
    assert final["result"]["summary"]["jammers"] == 1
    assert final["source"] == scene and final["analysis_parameters"] == accepted["analysis_parameters"]
    source_row = next(row for row in resources.current()["tables"]["interference_source.csv"] if row["interference_id"] == manual["id"])
    assert source_row["antenna_gain_dbi"] == str(gain)
    assert source_row["elevation_m"] == source_row["pattern_type"] == source_row["azimuth_deg"] == source_row["duty_cycle"] == ""


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
