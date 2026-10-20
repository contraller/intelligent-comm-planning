"""SR5 正式场景以数据库版本绑定已确认的规划方案。"""
from __future__ import annotations

import csv
import io
from copy import deepcopy

from test_sr5_plan_api import _completed, _create_plan, api  # noqa: F401


def _payload(object_id, **extra):
    return {"context": "planning", "task_id": "task-a", "plan_id": "plan-a",
            "scenario_name": "设备新故障", "faults": [{
                "object_type": "DEVICE", "object_id": object_id,
                "fault_type": "HW_FAILURE", "symptom_ids": []}], **extra}


def test_formal_scenario_versions_archive_and_frozen_diagnosis(api):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    payload = _payload(device_id)
    assert client.post("/api/v1/fault/scenarios", json={
        key: value for key, value in payload.items() if key != "context"
    }).status_code == 422
    assert client.get("/api/v1/fault/scenarios", params={"task_id": "task-a"}).status_code == 422
    assert client.post("/api/v1/fault/scenarios/validate", json=payload).json()["data"]["valid"]
    created = client.post("/api/v1/fault/scenarios", json=payload).json()["data"]
    sid, v1 = created["scenario_id"], created["version_id"]
    assert created["version_no"] == 1
    assert client.get("/api/v1/fault/scenarios", params={
        "context": "planning", "task_id": "task-a"}).json()["data"]["total"] == 1

    revised = client.put(f"/api/v1/fault/scenarios/{sid}", json={
        **payload, "scenario_name": "修订后的名称"}).json()["data"]
    assert revised["version_no"] == 2
    assert revised["version_id"] != v1
    historic = client.get(f"/api/v1/fault/scenarios/{sid}", params={
        "context": "planning", "task_id": "task-a", "version_id": v1}).json()["data"]
    assert historic["scenario_name"] == "设备新故障"

    submitted = client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_id": sid, "scenario_version_id": v1, "request_id": "diagnose-v1"})
    assert submitted.json()["code"] == 0
    result = _completed(client, submitted.json()["data"]["task_id"])["data"]
    assert result["input_snapshot"]["scenario_name"] == "设备新故障"
    assert result["scenario_version_no"] == 1

    archived = client.delete(f"/api/v1/fault/scenarios/{sid}", params={
        "context": "planning", "task_id": "task-a"})
    assert archived.json()["data"]["archived"] is True
    assert client.get("/api/v1/fault/scenarios", params={
        "context": "planning", "task_id": "task-a"}).json()["data"]["total"] == 0
    assert client.get("/api/v1/fault/scenarios", params={
        "context": "planning", "task_id": "task-a", "include_archived": True
    }).json()["data"]["total"] == 1
    assert client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_id": sid, "scenario_version_id": v1,
        "request_id": "diagnose-archived"}).status_code == 409
    restored = client.post(f"/api/v1/fault/scenarios/{sid}/archive", json={
        "task_id": "task-a", "archived": False})
    assert restored.json()["data"]["archived"] is False


def test_formal_scenario_rejects_cross_task_and_changed_source(api, monkeypatch):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    _create_plan(factory, task_id="task-b", plan_id="plan-b")
    created = client.post("/api/v1/fault/scenarios", json=_payload(device_id)).json()["data"]
    sid = created["scenario_id"]
    assert client.get(f"/api/v1/fault/scenarios/{sid}", params={
        "context": "planning", "task_id": "task-b"}).status_code == 404
    assert client.put(f"/api/v1/fault/scenarios/{sid}", json={
        **_payload(device_id), "task_id": "task-b", "plan_id": "plan-b"}).status_code == 404
    assert client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-b", "plan_id": "plan-b",
        "scenario_id": sid, "scenario_version_id": created["version_id"],
        "request_id": "diagnose-cross"}).status_code == 404
    assert client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_id": sid}).status_code == 422

    from app import fault_plan_source
    monkeypatch.setattr(fault_plan_source.frontend_integration, "resource_revision",
                        lambda: "resource-v2")
    assert client.post("/api/v1/fault/scenarios/validate", json=_payload(device_id)).status_code == 409
    assert client.get(f"/api/v1/fault/scenarios/{sid}", params={
        "context": "planning", "task_id": "task-a"}).json()["data"]["version_id"] == created["version_id"]


def test_formal_import_is_atomic_and_demo_path_remains_available(api):
    client, factory = api
    _, device_id, _ = _create_plan(factory)
    good = _payload(device_id)
    bad = deepcopy(good)
    bad["faults"][0]["object_id"] = "DV-NOT-IN-PLAN"
    rejected = client.post("/api/v1/fault/scenarios/import", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenarios": [good, bad]})
    assert rejected.json()["code"] == 1002
    assert client.get("/api/v1/fault/scenarios", params={
        "context": "planning", "task_id": "task-a"}).json()["data"]["total"] == 0

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["scenario_name", "faults"])
    writer.writerow(["文件导入故障", '[{"object_type":"DEVICE","object_id":"%s","fault_type":"HW_FAILURE"}]' % device_id])
    imported = client.post("/api/v1/fault/scenarios/import", params={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a"},
        files={"file": ("faults.csv", output.getvalue().encode("utf-8"), "text/csv")})
    assert imported.json()["data"]["imported"] == 1
    assert imported.json()["data"]["items"][0]["version_no"] == 1

    demo = client.get("/api/v1/fault/scenarios")
    assert demo.json()["data"]["total"] >= 1
    assert all(row["scenario_id"] != imported.json()["data"]["items"][0]["scenario_id"]
               for row in demo.json()["data"]["items"])
