"""下架设备的任务校验、版本重存与 SR4 消费边界；受控测试不等于实跑。"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from test_sr4_submit_api import api, _save_task, _submit  # noqa: F401
from app import resource_dataset_service as datasets, resource_maintenance_service as maintenance
from app.resource_maintenance_schemas import AvailabilityChange


def prepare(api, monkeypatch):
    client, factory, calls = api
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    return client, factory, calls, datasets.initialize()


def change(snapshot, ids, request_id="down", availability="OFF_SHELF"):
    return maintenance.set_availability(AvailabilityChange.model_validate({"context": "ledger", "base_revision": snapshot["revision"],
        "request_id": request_id, "ids": ids, "availability": availability}), "integration-editor")


def resave(client, saved, revision, input_data=None, request_id="resave"):
    return client.put("/api/v1/task-inputs/" + saved["task_id"], json={"context": "planning", "task_id": saved["task_id"],
        "expected_revision": saved["revision"], "resource_revision": revision, "request_id": request_id,
        "input": input_data or saved["input"]})


def test_unchanged_task_rebinds_new_resource_and_freezes_flags(api, monkeypatch):
    client, _, calls, baseline = prepare(api, monkeypatch)
    saved = _save_task(client)
    device = baseline["tables"]["device.csv"][0]
    receipt = change(baseline, [device["device_id"]])
    assert client.post("/api/v1/plan/sr4-flow", json=_submit(saved)).json()["code"] == 1205
    response = resave(client, saved, receipt["revision"])
    assert response.status_code == 200, response.text
    updated = response.json()["data"]
    assert updated["revision"] != saved["revision"] and updated["condition_version"] == saved["condition_version"]
    assert updated["resource_revision"] == receipt["revision"] and updated["input"] == saved["input"]
    assert client.post("/api/v1/plan/sr4-flow", json=_submit(updated)).status_code == 202
    frozen = deepcopy(calls[0][0]["resource_rows"])
    assert frozen["device.csv"][0]["availability"] == "OFF_SHELF"
    change(datasets.current(), [device["device_id"]], "up", "ACTIVE")
    assert calls[0][0]["resource_rows"] == frozen


def test_explicit_off_shelf_endpoint_fails_validate_save_and_submit(api, monkeypatch):
    client, _, calls, baseline = prepare(api, monkeypatch)
    saved = _save_task(client)
    data = deepcopy(saved["input"])
    source, target = data["demands"][0]["sourceId"], data["demands"][0]["targetId"]
    devices = baseline["tables"]["device.csv"]
    a = next(row["device_id"] for row in devices if row["node_id"] == source)
    b = next(row["device_id"] for row in devices if row["node_id"] == target)
    data["demands"][0].update(endpointMode="device", sourceDeviceId=a, targetDeviceId=b)
    updated = resave(client, saved, baseline["revision"], data).json()["data"]
    receipt = change(baseline, [a])
    query = {"context": "planning", "task_id": saved["task_id"], "expected_revision": updated["revision"],
        "resource_revision": receipt["revision"], "input": data}
    validated = client.post("/api/v1/task-inputs/validate", json=query).json()["data"]
    assert not validated["valid"] and any(row["field"] == "sourceDeviceId" for row in validated["issues"])
    assert resave(client, updated, receipt["revision"], data, "off-save").status_code == 422
    # 即使绕过任务保存直接给提交层传相同输入，也不能使用下架端点。
    from app import planning_job_service
    with pytest.raises(planning_job_service.PlanningJobError) as error:
        planning_job_service._validate_resources(data, receipt["revision"])
    assert error.value.code == 1001 and not calls


def test_node_without_active_devices_rejects_station_demand(api, monkeypatch):
    client, _, calls, baseline = prepare(api, monkeypatch)
    saved = _save_task(client)
    node_id = saved["input"]["stationIds"][0]
    ids = [row["device_id"] for row in baseline["tables"]["device.csv"] if row["node_id"] == node_id]
    receipt = change(baseline, ids)
    response = resave(client, saved, receipt["revision"])
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert any(row["field"] == "stationIds" for row in response.json()["data"])
    assert not calls


def test_flow_excludes_inactive_device_before_deployment(api, monkeypatch):
    _, _, _, baseline = prepare(api, monkeypatch)
    import sr4_flow
    tables = deepcopy(baseline["tables"])
    tables["device.csv"][0]["availability"] = "OFF_SHELF"
    monkeypatch.setattr(sr4_flow, "default_terrain", lambda **_: object())
    class ReachedDeployment(Exception):
        pass
    def deployment(stations, terrain, nodes, devices, models, candidates, **kwargs):
        assert len(devices) == len(tables["device.csv"]) - 1
        assert tables["device.csv"][0]["device_id"] not in {row["device_id"] for row in devices}
        assert callable(kwargs["checkpoint"])
        raise ReachedDeployment()
    monkeypatch.setattr(sr4_flow, "topology_from_deployment", deployment)
    with pytest.raises(ReachedDeployment):
        sr4_flow.run(task_id="TS-0001", resource_rows=tables, verbose=False)
    assert len(tables["device.csv"]) == 414


def test_parent_cannot_silently_replace_off_shelf_device(api, monkeypatch):
    _, _, _, baseline = prepare(api, monkeypatch)
    import sr4_flow
    tables = deepcopy(baseline["tables"])
    device = tables["device.csv"][0]
    device["availability"] = "OFF_SHELF"
    with pytest.raises(ValueError, match="父方案包含已下架"):
        sr4_flow.run_from_parent({"detail": {"nodes": [], "devices": [device], "links": [],
            "optimization": {"uplinks": {}}}}, {}, [], "T1", [], resource_rows=tables)
