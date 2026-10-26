"""编辑后的资源作为 SR4 冻结输入；受控提交不是算法实跑。"""
from copy import deepcopy
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from test_sr4_submit_api import api, _save_task, _submit  # noqa: F401
from app import resource_dataset_service as datasets, resource_maintenance_service as maintenance
from app.resource_maintenance_schemas import ResourceDeviceChanges


def test_edited_device_is_frozen_and_old_task_refused(api, monkeypatch):
    client, factory, calls = api
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    old = datasets.initialize()
    saved_old = _save_task(client)
    device_id = old["tables"]["device.csv"][0]["device_id"]
    request = ResourceDeviceChanges.model_validate({"context": "ledger", "base_revision": old["revision"],
        "request_id": "edit-for-planning", "devices": [{"id": device_id, "antenna_height_m": 12.25}]})
    receipt = maintenance.save(request, "integration-editor")
    assert client.post("/api/v1/plan/sr4-flow", json=_submit(saved_old)).status_code == 409
    saved = _save_task(client, "edited-resource-task")
    assert saved["resource_revision"] == receipt["revision"]
    response = client.post("/api/v1/plan/sr4-flow", json=_submit(saved))
    assert response.status_code == 202, response.text
    payload = calls[0][0]
    assert payload["resource_revision"] == receipt["revision"]
    assert payload["resource_rows"]["device.csv"][0]["antenna_height_m"] == "12.25"
    frozen = deepcopy(payload)
    maintenance.save(request.model_copy(update={"base_revision": receipt["revision"], "request_id": "second-edit",
        "devices": [request.devices[0].model_copy(update={"antenna_height_m": 13.25})]}), "integration-editor")
    assert payload == frozen
