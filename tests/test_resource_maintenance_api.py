"""台账参数维护：隔离数据库、权限、持久化及并发，不改原件。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, integration_identity_service as identity
from app import resource_dataset_service as datasets, resource_maintenance_service as maintenance
from app.database import Base
from app.main import app
from app.resource_dataset_models import ResourceDatasetOperation, ResourceDatasetVersion
from app.resource_maintenance_schemas import ResourceDeviceChanges


def headers(client):
    data = client.get("/api/v1/auth/csrf").json()["data"]
    return {"X-Session-Id": data["session_id"], "X-CSRF-Token": data["csrf_token"]}


def switch(client, account="integration-editor"):
    response = client.post("/api/v1/auth/integration/switch", json={"accountId": account}, headers=headers(client))
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.fixture
def resource_api(tmp_path, monkeypatch):
    path = tmp_path / "maintenance.sqlite"
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False, "timeout": 30})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    for module in (database, datasets, identity):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    baseline = datasets.initialize()
    with TestClient(app) as client:
        yield client, factory, baseline, path
    engine.dispose()


def body(baseline, request_id="edit-1", **fields):
    device = baseline["tables"]["device.csv"][0]
    return {"context": "ledger", "base_revision": baseline["revision"], "request_id": request_id,
        "stations": [], "devices": [{"id": device["device_id"], **(fields or {"antenna_height_m": 9.5})}]}


def save(client, payload):
    return client.post("/api/v1/resource/changes", headers=headers(client), json=payload)


def counts(factory):
    with factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model))
                     for model in (ResourceDatasetVersion, ResourceDatasetOperation))


def test_context_permissions_csrf_and_strict_fields(resource_api, monkeypatch):
    client, factory, baseline, _ = resource_api
    query = {"context": "ledger", "revision": baseline["revision"], "device_id": body(baseline)["devices"][0]["id"]}
    assert client.get("/api/v1/resource/maintenance-context", params=query).status_code == 403
    editor = switch(client)
    assert "resources.device.edit" in editor["permissions"] and "resources.edit" not in editor["permissions"]
    response = client.get("/api/v1/resource/maintenance-context", params=query)
    assert response.status_code == 200, response.text
    context = response.json()["data"]
    assert context["revision"] == context["base_revision"] == baseline["revision"]
    assert context["device"]["node_id"] == context["stations"][0]["node_id"]
    assert context["device"]["model_id"] == context["models"][0]["model_id"]
    assert isinstance(context["models"][0]["tx_power_max_dbm"], float)
    for params in ({**query, "context": "gis"}, {**query, "ids": "x"}, {**query, "device_id": "missing"}):
        assert client.get("/api/v1/resource/maintenance-context", params=params).status_code in (404, 422)
    assert client.get("/api/v1/resource/maintenance-context", params=[*query.items(), ("revision", "other")]).status_code == 422
    assert client.post("/api/v1/resource/changes", json=body(baseline)).status_code == 409
    assert client.post("/api/v1/resource/changes", json=body(baseline), headers={**headers(client), "X-CSRF-Token": "bad"}).status_code == 403
    switch(client, "integration-reviewer")
    assert save(client, body(baseline)).status_code == 403
    last_headers = headers(client)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert client.post("/api/v1/resource/changes", headers=last_headers, json=body(baseline)).status_code == 401
    assert counts(factory) == (1, 0)


def test_save_changes_only_one_device_and_preserves_history(resource_api):
    client, factory, baseline, _ = resource_api
    switch(client)
    device = baseline["tables"]["device.csv"][0]
    model = next(r for r in baseline["tables"]["device_model.csv"] if r["model_id"] == device["model_id"])
    payload = body(baseline, antenna_height_m=9.5, tx_power_dbm=float(model["tx_power_max_dbm"]) - 1,
                   work_freq_khz=float(model["freq_min_khz"]))
    response = save(client, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert receipt["changed"] and receipt["revision"] != baseline["revision"]
    assert receipt["read_revision"] == receipt["revision"]
    assert receipt["affected_ids"] == [device["device_id"]]
    current = datasets.current()
    assert current["source_files"] == baseline["source_files"]
    expected = deepcopy(baseline["tables"])
    expected["device.csv"][0].update({key: str(value) for key, value in payload["devices"][0].items() if key != "id"})
    assert current["tables"] == expected
    with factory() as session:
        assert datasets._decode(session.get(ResourceDatasetVersion, baseline["revision"]))["tables"] == baseline["tables"]
        operation = session.get(ResourceDatasetOperation, "edit-1")
        assert operation.actor_id == "integration-editor" and operation.receipt == receipt
    read = client.get("/api/v1/resource/devices/" + device["device_id"], params={"context": "ledger", "revision": receipt["revision"]})
    assert read.status_code == 200 and read.json()["data"]["item"]["antenna_height_m"] == 9.5
    assert counts(factory) == (2, 1)


@pytest.mark.parametrize("patch", [
    {"antenna_height_m": -1}, {"antenna_height_m": None}, {"antenna_height_m": True}, {"tx_power_dbm": "30"},
    {"tx_power_dbm": None}, {"tx_power_dbm": 9999}, {"work_freq_khz": 0}, {"work_freq_khz": 99999999},
    {"work_freq_khz": False}, {"node_id": "ND-0002"}, {"current_work_mode": "FM"}, {"ports": []},
])
def test_invalid_parameters_do_not_write(resource_api, patch):
    client, factory, baseline, _ = resource_api
    switch(client)
    response = save(client, body(baseline, **patch))
    assert response.status_code == 422, response.text
    assert response.json()["code"] == 1001 and counts(factory) == (1, 0)


def test_extra_operations_and_nonfinite_are_rejected(resource_api):
    client, factory, baseline, _ = resource_api
    switch(client)
    for payload in ({**body(baseline), "context": "gis"}, {**body(baseline), "actor_id": "admin"},
                    {**body(baseline), "newDevices": []}, {**body(baseline), "stations": [{"id": "ND-0001"}]},
                    {**body(baseline), "devices": []}, {**body(baseline), "devices": body(baseline)["devices"] * 2}):
        assert save(client, payload).status_code == 422
    payload = body(baseline)
    raw = __import__("json").dumps(payload).replace('9.5', 'NaN')
    assert client.post("/api/v1/resource/changes", headers={**headers(client), "Content-Type": "application/json"}, content=raw).status_code == 422
    assert counts(factory) == (1, 0)


def test_noop_null_frequency_and_change_back_still_new_version(resource_api):
    client, factory, baseline, _ = resource_api
    switch(client)
    first = baseline["tables"]["device.csv"][0]
    original_height = float(first["antenna_height_m"])
    noop = save(client, body(baseline, "noop", antenna_height_m=original_height)).json()["data"]
    assert noop["changed"] is False and noop["revision"] == baseline["revision"]
    assert noop["affected_ids"] == [] and counts(factory) == (1, 1)
    changed = save(client, body(baseline, "height", antenna_height_m=original_height + 1)).json()["data"]
    restored = save(client, {**body(baseline, "restore", antenna_height_m=original_height), "base_revision": changed["revision"]}).json()["data"]
    assert len({baseline["revision"], changed["revision"], restored["revision"]}) == 3
    empty = save(client, {**body(baseline, "freq-null", work_freq_khz=None), "base_revision": restored["revision"]})
    assert empty.status_code == 200 and empty.json()["data"]["device"]["work_freq_khz"] is None


def test_replay_conflict_and_restart(resource_api, monkeypatch):
    client, factory, baseline, path = resource_api
    switch(client)
    payload = body(baseline)
    first = save(client, payload).json()["data"]
    assert save(client, payload).json()["data"] == first
    assert save(client, body(baseline, "stale", antenna_height_m=11)).status_code == 409
    conflict = save(client, body(baseline, antenna_height_m=11))
    assert conflict.status_code == 409 and conflict.json()["code"] == 1206
    # 未提交频率和显式清空频率不是同一请求，不能重放成原保存成功。
    clear_frequency = deepcopy(payload)
    clear_frequency["devices"][0]["work_freq_khz"] = None
    assert save(client, clear_frequency).json()["code"] == 1206
    with pytest.raises(datasets.ResourceDatasetError) as error:
        maintenance.save(ResourceDeviceChanges.model_validate(payload), "other-editor")
    assert error.value.code == 1206
    reopened = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False})
    replacement = sessionmaker(bind=reopened, expire_on_commit=False)
    try:
        monkeypatch.setattr(datasets, "get_session_factory", lambda: replacement)
        assert datasets.current()["revision"] == first["revision"]
        assert maintenance.save(ResourceDeviceChanges.model_validate(payload), "integration-editor") == first
    finally:
        reopened.dispose()
    assert counts(factory) == (2, 1)


@pytest.mark.parametrize("same_request", [False, True])
def test_concurrent_saves_do_not_overwrite(resource_api, same_request):
    _, factory, baseline, _ = resource_api
    gate = threading.Barrier(2)
    def worker(index):
        payload = body(baseline, "same" if same_request else f"parallel-{index}", antenna_height_m=8 if same_request else 8 + index)
        gate.wait(timeout=10)
        try:
            return maintenance.save(ResourceDeviceChanges.model_validate(payload), "integration-editor")
        except datasets.ResourceDatasetError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, [0, 1]))
    if same_request:
        assert results[0] == results[1] and isinstance(results[0], dict)
    else:
        assert sum(isinstance(result, dict) for result in results) == 1 and 1205 in results
    assert counts(factory) == (2, 1)


def test_transaction_failure_rolls_back_and_file_mode_refuses_write(resource_api, monkeypatch):
    client, factory, baseline, _ = resource_api
    switch(client)
    def broken(_):
        raise datasets.ResourceDatasetError("隔离测试模拟完整性失败")
    validator = datasets._validate_snapshot
    monkeypatch.setattr(datasets, "_validate_snapshot", broken)
    assert save(client, body(baseline)).status_code == 503
    monkeypatch.setattr(datasets, "_validate_snapshot", validator)
    assert counts(factory) == (1, 0) and datasets.current()["revision"] == baseline["revision"]
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    assert save(client, body(baseline)).status_code == 503
