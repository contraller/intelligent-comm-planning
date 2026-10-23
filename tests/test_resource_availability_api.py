"""设备上下架真实路由与隔离数据库验证，不改变运行状态或原件。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import sys
import threading

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from test_resource_maintenance_api import resource_api, headers, switch, counts  # noqa: F401
from app import resource_dataset_service as datasets, resource_maintenance_service as maintenance
from app.resource_maintenance_schemas import AvailabilityChange


def change(baseline, request_id="availability-1", ids=None, availability="OFF_SHELF"):
    return {"context": "ledger", "base_revision": baseline["revision"], "request_id": request_id,
        "ids": ids if ids is not None else [row["device_id"] for row in baseline["tables"]["device.csv"][:2]],
        "availability": availability}


def post(client, body, preview=False):
    return client.post("/api/v1/resource/device-availability" + ("/preview" if preview else ""),
        headers=headers(client), json=body)


def test_preview_permissions_headers_and_no_writes(resource_api, monkeypatch):
    client, factory, baseline, _ = resource_api
    payload = {"context": "ledger", "revision": baseline["revision"], "ids": change(baseline)["ids"]}
    assert post(client, payload, True).status_code == 403
    editor = switch(client)
    assert "resources.device.availability" in editor["permissions"] and "resources.edit" not in editor["permissions"]
    response = post(client, payload, True)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["selected_ids"] == payload["ids"] and data["device"] is None
    assert data["revision"] == data["base_revision"] == baseline["revision"]
    assert data["stations"] == data["models"] == data["antennas"] == []
    assert "未提供链路级影响" in data["impact"]["description"]
    assert post(client, {**payload, "revision": "old"}, True).status_code == 409
    assert client.post("/api/v1/resource/device-availability/preview", json=payload).status_code == 409
    assert client.post("/api/v1/resource/device-availability", json=change(baseline),
        headers={**headers(client), "X-CSRF-Token": "bad"}).status_code == 403
    switch(client, "integration-reviewer")
    assert post(client, change(baseline)).status_code == 403
    last_headers = headers(client)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert client.post("/api/v1/resource/device-availability", headers=last_headers, json=change(baseline)).status_code == 401
    assert counts(factory) == (1, 0)


@pytest.mark.parametrize("patch", [{"ids": []}, {"ids": ["DV-0001"] * 2}, {"ids": ["x"] * 51},
    {"ids": [1]}, {"ids": [True]}, {"availability": "FAULT"}, {"availability": None},
    {"availability": False}, {"context": "gis"}, {"actor_id": "admin"}, {"devices": []}])
def test_bad_request_rejects_entire_batch(resource_api, patch):
    client, factory, baseline, _ = resource_api
    switch(client)
    response = post(client, {**change(baseline), **patch})
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert counts(factory) == (1, 0)


def test_missing_device_rejects_preview_and_atomic_commit(resource_api):
    client, factory, baseline, _ = resource_api
    switch(client)
    payload = change(baseline, ids=[change(baseline)["ids"][0], "missing"])
    for preview in (False, True):
        body = {"context": "ledger", "revision": baseline["revision"], "ids": payload["ids"]} if preview else payload
        response = post(client, body, preview)
        assert response.status_code == 404 and response.json()["code"] == 1002
    assert counts(factory) == (1, 0) and datasets.current()["tables"] == baseline["tables"]


def test_batch_state_stats_filter_detail_and_gis(resource_api):
    client, factory, baseline, _ = resource_api
    switch(client)
    payload = change(baseline)
    response = post(client, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert receipt["updated"] == receipt["affected_ids"] == payload["ids"] and receipt["unchanged"] == []
    assert receipt["changed"] and receipt["revision"] != baseline["revision"]
    current = datasets.current()
    expected = deepcopy(baseline["tables"])
    for row in expected["device.csv"][:2]:
        row["availability"] = "OFF_SHELF"
    assert current["tables"] == expected and current["source_files"] == baseline["source_files"]
    stats = client.get("/api/v1/resource/context?context=ledger").json()["data"]["stats"]
    assert stats["devices"] == 414 and stats["active"] == 412 and stats["off_shelf"] == 2
    for state, total in (("ACTIVE", 412), ("OFF_SHELF", 2), ("UNKNOWN", 0)):
        response = client.get("/api/v1/resource/devices", params={"context": "ledger", "revision": current["revision"],
            "availability": state, "page": 1, "page_size": 5})
        assert response.status_code == 200
        page = response.json()["data"]
        assert page["total"] == total and len(page["items"]) == min(total, 5)
        assert all(row["availability"] == state for row in page["items"])
    assert client.get("/api/v1/resource/devices", params={"revision": current["revision"], "availability": "FAULT"}).status_code == 422
    for kind in ("gis-directory", "gis-scene"):
        response = client.get("/api/v1/resource/" + kind, params={"context": "gis", "revision": current["revision"]})
        assert response.status_code == 200
        device = next(row for row in response.json()["data"]["devices"] if row["device_id"] == payload["ids"][0])
        assert device["availability"] == "OFF_SHELF" and device["status"] == "NORMAL"
    detail = client.get("/api/v1/resource/devices/" + payload["ids"][0], params={"revision": current["revision"], "context": "ledger"}).json()["data"]["item"]
    assert detail["availability"] == "OFF_SHELF" and detail["status"] == "NORMAL"
    assert counts(factory) == (2, 1)


def test_noop_partial_replay_and_reenable_are_new_history(resource_api):
    client, factory, baseline, _ = resource_api
    switch(client)
    first_payload = change(baseline, ids=[change(baseline)["ids"][0]])
    first = post(client, first_payload).json()["data"]
    payload = {**change(baseline, "second"), "base_revision": first["revision"]}
    second = post(client, payload).json()["data"]
    assert second["updated"] == [payload["ids"][1]] and second["unchanged"] == [payload["ids"][0]]
    assert post(client, {**payload, "ids": list(reversed(payload["ids"]))}).json()["data"] == second
    noop = post(client, {**payload, "base_revision": second["revision"], "request_id": "noop"}).json()["data"]
    assert not noop["changed"] and noop["updated"] == [] and noop["revision"] == second["revision"]
    assert post(client, {**payload, "request_id": "stale"}).json()["code"] == 1205
    assert post(client, {**payload, "availability": "ACTIVE"}).json()["code"] == 1206
    restored = post(client, {**payload, "base_revision": second["revision"], "request_id": "restore", "availability": "ACTIVE"}).json()["data"]
    assert restored["changed"] and restored["revision"] not in (baseline["revision"], first["revision"], second["revision"])
    assert all(row.get("availability", "ACTIVE") == "ACTIVE" for row in datasets.current()["tables"]["device.csv"])
    assert counts(factory) == (4, 4)


def test_restart_replay_and_actor_binding(resource_api, monkeypatch):
    client, factory, baseline, path = resource_api
    switch(client)
    payload = change(baseline)
    receipt = post(client, payload).json()["data"]
    engine = create_engine("sqlite:///" + str(path))
    try:
        monkeypatch.setattr(datasets, "get_session_factory", lambda: sessionmaker(bind=engine))
        assert datasets.current()["revision"] == receipt["revision"]
        assert maintenance.set_availability(AvailabilityChange.model_validate(payload), "integration-editor") == receipt
        with pytest.raises(datasets.ResourceDatasetError) as error:
            maintenance.set_availability(AvailabilityChange.model_validate(payload), "someone-else")
        assert error.value.code == 1206
    finally:
        engine.dispose()
    assert counts(factory) == (2, 1)


@pytest.mark.parametrize("same", [False, True])
def test_concurrent_up_down_does_not_overwrite(resource_api, same):
    _, factory, baseline, _ = resource_api
    barrier = threading.Barrier(2)
    def worker(index):
        request = change(baseline, "same" if same else f"parallel-{index}")
        barrier.wait(timeout=10)
        try:
            return maintenance.set_availability(AvailabilityChange.model_validate(request), "integration-editor")
        except datasets.ResourceDatasetError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(worker, (0, 1)))
    assert result[0] == result[1] if same else sum(isinstance(r, dict) for r in result) == 1 and 1205 in result
    assert counts(factory) == (2, 1)


def test_corrupt_lifecycle_rejected_and_file_mode_no_write(resource_api, monkeypatch):
    client, factory, baseline, _ = resource_api
    switch(client)
    invalid = {key: deepcopy(baseline[key]) for key in ("schema_version", "tables", "source_files", "source_updated_at")}
    invalid["tables"]["device.csv"][0]["availability"] = "DELETED"
    with pytest.raises(datasets.ResourceDatasetError, match="上下架状态"):
        datasets._validate_snapshot(invalid)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    assert post(client, change(baseline)).status_code == 503
    assert counts(factory) == (1, 0)
