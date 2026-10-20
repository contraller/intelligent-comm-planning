"""SR5 正式两段任务的幂等提交与统一只读视图。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select

from test_sr5_plan_api import _completed, _create_plan, api  # noqa: F401
from app import fault, fault_plan_source
from app.fault_submission_models import FaultTaskSubmission


def _scenario(client, device_id):
    response = client.post("/api/v1/fault/scenarios", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_name": "幂等诊断故障", "faults": [{
            "object_type": "DEVICE", "object_id": device_id,
            "fault_type": "HW_FAILURE", "symptom_ids": []}]})
    assert response.json()["code"] == 0
    return response.json()["data"]


def _diagnose_payload(scenario, request_id="diag-request"):
    return {"context": "planning", "task_id": "task-a", "plan_id": "plan-a",
            "scenario_id": scenario["scenario_id"],
            "scenario_version_id": scenario["version_id"], "request_id": request_id}


def test_two_step_analysis_idempotency_and_report_view(api, monkeypatch):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    scenario = _scenario(client, device_id)
    payload = _diagnose_payload(scenario)
    assert client.post("/api/v1/fault/diagnose", json={
        key: value for key, value in payload.items() if key != "request_id"
    }).status_code == 422
    submitted = client.post("/api/v1/fault/diagnose", json=payload)
    assert submitted.json()["code"] == 0
    diagnose_id = submitted.json()["data"]["task_id"]
    assert submitted.json()["data"]["replayed"] is False
    replay = client.post("/api/v1/fault/diagnose", json=payload)
    assert replay.json()["data"]["task_id"] == diagnose_id
    assert replay.json()["data"]["replayed"] is True
    conflict = client.post("/api/v1/fault/diagnose", json={**payload, "confidence_threshold": 0.7})
    assert conflict.status_code == 409
    assert conflict.json()["code"] == 1204
    assert _completed(client, diagnose_id)["code"] == 0

    # 幂等重放不重新校验已变化的资源版本，也不会创建第二个算法任务。
    monkeypatch.setattr(fault_plan_source.frontend_integration, "resource_revision",
                        lambda: "resource-changed")
    assert client.post("/api/v1/fault/diagnose", json=payload).json()["data"]["task_id"] == diagnose_id
    monkeypatch.setattr(fault_plan_source.frontend_integration, "resource_revision",
                        lambda: "resource-v1")
    path = f"/api/v1/fault/analyses/{diagnose_id}"
    first = client.get(path, params={"task_id": "task-a"}).json()["data"]
    assert first["state"] == "DIAGNOSIS_READY"
    assert first["diagnosis_ready"] and not first["impact_ready"]
    assert not first["report_ready"] and first["report"] is None
    assert first["scenario"]["version_id"] == scenario["version_id"]
    assert client.get(path, params={"task_id": "other-task"}).status_code == 404

    impact_payload = {"context": "planning", "task_id": "task-a", "plan_id": "plan-a",
                      "diagnose_task_id": diagnose_id, "request_id": "impact-request"}
    assert client.post("/api/v1/fault/impact", json={
        key: value for key, value in impact_payload.items() if key != "request_id"
    }).status_code == 422
    cross_kind = client.post("/api/v1/fault/impact", json={
        **impact_payload, "request_id": payload["request_id"]})
    assert cross_kind.status_code == 409 and cross_kind.json()["code"] == 1204
    impact_submitted = client.post("/api/v1/fault/impact", json=impact_payload)
    assert impact_submitted.json()["code"] == 0
    impact_id = impact_submitted.json()["data"]["task_id"]
    assert client.post("/api/v1/fault/impact", json=impact_payload).json()["data"]["task_id"] == impact_id
    impact_conflict = client.post("/api/v1/fault/impact", json={
        **impact_payload, "consider_backup_route": False})
    assert impact_conflict.status_code == 409
    assert impact_conflict.json()["code"] == 1204
    assert _completed(client, impact_id)["code"] == 0
    params = {"task_id": "task-a", "impact_task_id": impact_id}
    view = client.get(path, params=params).json()["data"]
    assert view["state"] == "SUCCESS" and view["progress"] == 1.0
    assert view["report_ready"] and view["impact_ready"]
    assert view["impact"]["diagnose_task_id"] == diagnose_id
    assert view["report"]["scenario"]["faults"][0]["object_id"] == device_id
    assert view["report"]["diagnosis"] == view["diagnosis"]
    assert view["report"]["generated_at"] == client.get(path, params=params).json()["data"]["report"]["generated_at"]
    with factory() as session:
        receipts = session.scalars(select(FaultTaskSubmission)).all()
    assert len(receipts) == 2


def test_analysis_view_rejects_unrelated_impact_task(api):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    scenario = _scenario(client, device_id)
    diagnoses = []
    impacts = []
    for number in (1, 2):
        payload = _diagnose_payload(scenario, f"diagnosis-{number}")
        diagnose_id = client.post("/api/v1/fault/diagnose", json=payload).json()["data"]["task_id"]
        assert _completed(client, diagnose_id)["code"] == 0
        impact_id = client.post("/api/v1/fault/impact", json={
            "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
            "diagnose_task_id": diagnose_id, "request_id": f"impact-{number}"
        }).json()["data"]["task_id"]
        assert _completed(client, impact_id)["code"] == 0
        diagnoses.append(diagnose_id)
        impacts.append(impact_id)
    response = client.get(f"/api/v1/fault/analyses/{diagnoses[0]}", params={
        "task_id": "task-a", "impact_task_id": impacts[1]})
    assert response.status_code == 409
    assert response.json()["code"] == 1204


def test_missing_runtime_record_is_failed_not_stuck_running(api, monkeypatch):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    scenario = _scenario(client, device_id)
    monkeypatch.setattr(fault, "_spawn", lambda kind, payload, work, **kw:
                        fault._ok({"task_id": kw["task_id"], "estimated_sec": 5}))
    submitted = client.post("/api/v1/fault/diagnose", json={
        **_diagnose_payload(scenario), "request_id": "orphan-request"})
    task_id = submitted.json()["data"]["task_id"]
    view = client.get(f"/api/v1/fault/analyses/{task_id}", params={
        "task_id": "task-a"}).json()["data"]
    assert view["state"] == "FAILED"
    assert "运行记录不可用" in view["error"]
    assert not view["report_ready"]


def test_analysis_view_exposes_pending_running_and_failed(api, monkeypatch):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    scenario = _scenario(client, device_id)
    monkeypatch.setattr(fault, "_spawn", lambda kind, payload, work, **kw:
                        fault._ok({"task_id": kw["task_id"], "estimated_sec": 5}))
    task_id = client.post("/api/v1/fault/diagnose", json={
        **_diagnose_payload(scenario), "request_id": "state-request"
    }).json()["data"]["task_id"]
    status = {"task_id": task_id, "kind": "FAULT_DIAGNOSE",
              "status": "PENDING", "progress": 0.0, "error": None}
    monkeypatch.setattr(fault, "get_task_record", lambda _: dict(status))
    path = f"/api/v1/fault/analyses/{task_id}"
    assert client.get(path, params={"task_id": "task-a"}).json()["data"]["state"] == "PENDING"
    status.update(status="RUNNING", progress=0.4)
    running = client.get(path, params={"task_id": "task-a"}).json()["data"]
    assert running["state"] == "RUNNING" and running["progress"] == 0.2
    status.update(status="FAILED", error="诊断失败", progress=1.0)
    failed = client.get(path, params={"task_id": "task-a"}).json()["data"]
    assert failed["state"] == "FAILED" and failed["error"] == "诊断失败"
    assert failed["report"] is None


def test_concurrent_same_request_reserves_one_receipt(api):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    scenario = _scenario(client, device_id)
    payload = _diagnose_payload(scenario, "concurrent-request")

    def reserve(_):
        return fault._reserve_submission(payload, "FAULT_DIAGNOSE", "task-a", "plan-a",
                                         scenario["scenario_id"], scenario["version_id"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(reserve, range(2)))
    assert results[0][0] == results[1][0]
    assert sorted(created for _, created in results) == [False, True]


def test_demo_diagnosis_does_not_require_request_id(api):
    client, _ = api
    response = client.post("/api/v1/fault/diagnose", json={"scenario_id": "FS-0001"})
    assert response.json()["code"] == 0
    assert _completed(client, response.json()["data"]["task_id"])["code"] == 0
