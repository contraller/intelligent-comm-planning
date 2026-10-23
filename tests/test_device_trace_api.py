"""只读投影真实资源版本与操作，不新建历史或执行恢复写入。"""
from copy import deepcopy
from pathlib import Path
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, resource_dataset_service as datasets, device_trace_service as service
from app.database import Base
from app.resource_dataset_models import ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation
from app.device_trace_router import create_device_trace_router
from app.device_trace_schemas import SCHEMA
from app.integration_identity_service import IdentityError


HEADERS = {"x-test-actor": "editor", "x-test-csrf": "valid"}


@pytest.fixture
def api(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "trace.sqlite"), connect_args={"check_same_thread": False})
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine, tables=[model.__table__ for model in (ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation)])
    for module in (database, datasets, service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    datasets.initialize()
    baseline = datasets.current()

    def actor(request, permission, writing=False):
        if not request.headers.get("x-test-actor"):
            raise IdentityError("unauthenticated", 1101, 401)
        if writing and request.headers.get("x-test-actor") == "reader":
            raise IdentityError("forbidden", 1104, 403)
        if writing and request.headers.get("x-test-csrf") != "valid":
            raise IdentityError("csrf", 1105, 403)
        return {"account_id": "editor"}

    app = FastAPI()
    app.include_router(create_device_trace_router(actor))
    with TestClient(app) as client:
        yield client, factory, baseline, engine
    engine.dispose()


def device_id(baseline, index=0):
    return baseline["tables"]["device.csv"][index]["device_id"]


def save(baseline, request_id, patch, index=0):
    def mutate(snapshot):
        snapshot["tables"]["device.csv"][index].update({key: str(value) for key, value in patch.items()})
        return True, {"device_id": device_id(baseline, index)}
    return datasets.commit_device_change(datasets.current()["revision"], request_id, datasets.content_hash(patch), "editor", mutate)


def history(client, baseline, revision=None, **params):
    return client.get("/api/v1/device-traces/" + device_id(baseline) + "/history", headers=HEADERS,
        params={"context": "ledger", "resource_revision": revision or baseline["revision"], **params})


def preview(client, baseline, current, source=None, request_id=None, headers=HEADERS, **patch):
    return client.post("/api/v1/device-traces/" + device_id(baseline) + "/restore-preview", headers=headers,
        json={"schema_version": SCHEMA, "context": "ledger", "base_revision": current,
            "source_revision": source or baseline["revision"], "source_request_id": request_id, **patch})


def counts(factory):
    with factory() as session:
        return [session.scalar(select(func.count()).select_from(model)) for model in (ResourceDatasetVersion, ResourceDatasetOperation)]


def test_retained_baseline_is_not_a_device_operation(api):
    client, factory, baseline, _ = api
    response = history(client, baseline)
    assert response.status_code == 200, response.text
    item = response.json()["data"]["items"][0]
    assert item["kind"] == "RETAINED_BASELINE" and item["request_id"] is None and item["actor_id"] is None
    assert item["changed"] is False and item["changed_fields"] == [] and counts(factory) == [1, 0]
    assert history(client, baseline, page=2, page_size=1).json()["data"]["items"] == []


def test_actual_changes_details_paging_and_anchor_history(api):
    client, factory, baseline, _ = api
    original = baseline["tables"]["device.csv"][0]
    value = float(original["tx_power_dbm"]) - 1
    first = save(baseline, "change-one", {"tx_power_dbm": value})
    second = save(baseline, "other-device", {"antenna_height_m": 25}, 1)
    third = save(baseline, "change-three", {"antenna_height_m": 30})
    items = history(client, baseline, third["revision"]).json()["data"]["items"]
    assert [item["request_id"] for item in items] == ["change-three", "change-one", None]
    assert history(client, baseline, first["revision"]).json()["data"]["total"] == 2
    assert history(client, baseline, baseline["revision"]).json()["data"]["total"] == 1
    assert history(client, baseline, third["revision"], page=2, page_size=1).json()["data"]["items"] == [items[1]]
    response = client.get("/api/v1/device-traces/" + device_id(baseline) + "/operations/change-one",
        headers=HEADERS, params={"context": "ledger", "resource_revision": third["revision"]})
    detail = response.json()["data"]
    assert response.status_code == 200 and detail["before"]["tx_power_dbm"] == original["tx_power_dbm"]
    assert detail["after"]["tx_power_dbm"] == str(value) and detail["actor_id"] == "editor"
    assert detail["diffs"] == [{"field": "tx_power_dbm", "before": original["tx_power_dbm"], "after": str(value), "known": True}]
    wrong = client.get("/api/v1/device-traces/" + device_id(baseline) + "/operations/other-device",
        headers=HEADERS, params={"context": "ledger", "resource_revision": third["revision"]})
    assert wrong.status_code == 404 and counts(factory) == [4, 3]


def test_restore_three_parameters_is_only_a_readonly_candidate(api):
    client, factory, baseline, _ = api
    model = next(row for row in baseline["tables"]["device_model.csv"] if row["model_id"] == baseline["tables"]["device.csv"][0]["model_id"])
    value = float(model["tx_power_max_dbm"]) - 1
    source = save(baseline, "valid-source", {"tx_power_dbm": value})["revision"]
    current = save(baseline, "power-change", {"tx_power_dbm": value - 1})["revision"]
    before = deepcopy(datasets.current())
    response = preview(client, baseline, current, source, "valid-source")
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["compatible"] is True and result["patch"] == {"tx_power_dbm": value}
    assert set(result["patch"]) <= {"tx_power_dbm", "work_freq_khz", "antenna_height_m"}
    assert "status" in result["blocked_fields"] and "ports" in result["blocked_fields"]
    assert datasets.current() == before and counts(factory) == [3, 2]
    assert preview(client, baseline, baseline["revision"]).json()["code"] == 1205
    assert preview(client, baseline, current, request_id="power-change").json()["code"] == 1203
    source_current = preview(client, baseline, current, current, "power-change").json()["data"]
    assert source_current["compatible"] is False and source_current["patch"] == {}


def test_out_of_model_baseline_is_not_restored(api):
    client, factory, baseline, _ = api
    current = save(baseline, "valid-power", {"tx_power_dbm": 40})["revision"]
    result = preview(client, baseline, current).json()["data"]
    assert "tx_power_dbm" not in result["patch"]
    assert any("当前型号约束" in reason for reason in result["warnings"])


def test_off_shelf_does_not_restore_or_infer_status(api):
    client, factory, baseline, _ = api
    current = save(baseline, "shelf-change", {"availability": "OFF_SHELF"})["revision"]
    assert preview(client, baseline, current).json()["code"] == 1203
    assert counts(factory) == [2, 1]


def test_unknown_historical_parameter_is_not_fabricated(api):
    client, factory, baseline, _ = api
    unknown = save(baseline, "unknown-value", {"antenna_height_m": ""})["revision"]
    current = save(baseline, "known-value", {"antenna_height_m": 21})["revision"]
    response = preview(client, baseline, current, unknown, "unknown-value")
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert "antenna_height_m" not in result["patch"]
    assert any("未知" in reason for reason in result["warnings"])


@pytest.mark.parametrize("patch", [{"ports": []}, {"context": "gis"}, {"source_request_id": "bad/id"},
    {"schema_version": "bad"}, {"source_request_id": "history"}, {"base_revision": " "}])
def test_restore_request_strict(api, patch):
    client, factory, baseline, _ = api
    response = preview(client, baseline, baseline["revision"], **patch)
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert counts(factory) == [1, 0]


def test_authentication_permissions_csrf_and_queries(api):
    client, factory, baseline, _ = api
    path = "/api/v1/device-traces/" + device_id(baseline) + "/history"
    assert client.get(path).status_code == 401
    assert preview(client, baseline, baseline["revision"], headers={"x-test-actor": "editor"}).json()["code"] == 1105
    assert preview(client, baseline, baseline["revision"], headers={**HEADERS, "x-test-actor": "reader"}).json()["code"] == 1104
    for query in ("context=ledger", "context=gis&resource_revision=x", "context=ledger&resource_revision=x&x=1", "context=ledger&resource_revision=x&page=0"):
        assert client.get(path + "?" + query, headers=HEADERS).status_code == 422
    assert counts(factory) == [1, 0]


def test_damaged_parent_or_receipt_does_not_fall_back(api):
    client, factory, baseline, engine = api
    current = save(baseline, "power-change", {"tx_power_dbm": 1})["revision"]
    with engine.begin() as connection:
        connection.execute(text("UPDATE resource_dataset_operations SET actor_id='corrupted' WHERE request_id='power-change'"))
    response = history(client, baseline, current)
    assert response.status_code == 503 and response.json()["code"] == 5002, response.text
    assert counts(factory) == [2, 1]


def test_injected_principal_error_not_misclassified_as_validation():
    class PrincipalError(ValueError):
        code, status, data = 1104, 403, {"reason": "PASSWORD_CHANGE_REQUIRED"}
    def reject(*args, **kwargs):
        raise PrincipalError("password required")
    app = FastAPI()
    app.include_router(create_device_trace_router(reject))
    with TestClient(app) as client:
        reply = client.get("/api/v1/device-traces/D1/history?context=ledger&resource_revision=R")
        assert reply.status_code == 403 and reply.json()["code"] == 1104


def test_preview_checks_read_permission_and_rejects_missing_actor():
    calls = []
    def reject_read(request, permission, writing=False):
        calls.append((permission, writing))
        raise IdentityError("read denied", 1104, 403)
    app = FastAPI()
    app.include_router(create_device_trace_router(reject_read))
    with TestClient(app) as client:
        assert client.post("/api/v1/device-traces/D1/restore-preview", json={}).status_code == 403
    assert calls == [("resources.view", False)]
    app = FastAPI()
    app.include_router(create_device_trace_router(lambda *args, **kwargs: None))
    with TestClient(app) as client:
        response = client.get("/api/v1/device-traces/D1/history?context=ledger&resource_revision=R")
        assert response.status_code == 503 and response.json()["code"] == 5001
