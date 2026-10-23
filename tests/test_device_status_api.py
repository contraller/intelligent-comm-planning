"""仅新建本轮 SQLite；构造导入不修改资源、不推断在线。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, func, text
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, resource_dataset_service as datasets, device_status_service as service
from app.database import Base
from app.device_status_models import DeviceStatusSnapshot as Snapshot, DeviceStatusRecord as Record, DeviceStatusImportOperation as Operation
from app.device_status_router import create_device_status_router
from app.device_status_schemas import SCHEMA
from app.resource_dataset_models import ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation
from app.integration_identity_service import IdentityError


@pytest.fixture
def api(tmp_path, monkeypatch):
    path = tmp_path / "status.sqlite"
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False, "timeout": 15})
    tables = [cls.__table__ for cls in (ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation, Snapshot, Record, Operation)]
    Base.metadata.create_all(engine, tables=tables)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    for module in (database, datasets, service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(path))
    datasets.initialize()
    baseline = datasets.current()
    # 显式模块测试依赖，不将它作为真实权限集成证据。
    def actor(request, permission, writing=False):
        account = request.headers.get("x-test-actor")
        if not account:
            raise IdentityError("unauthenticated", 1101, 401)
        if writing and request.headers.get("x-test-csrf") != "valid":
            raise IdentityError("csrf", 1105, 403)
        if writing and account == "reader":
            raise IdentityError("forbidden", 1104, 403)
        return {"account_id": account}
    app = FastAPI()
    app.include_router(create_device_status_router(actor))
    with TestClient(app) as client:
        yield client, factory, baseline, engine
    engine.dispose()


HEADERS = {"x-test-actor": "editor", "x-test-csrf": "valid"}
PREFIX = "/api/v1/device-status"


def body(baseline, request_id="status-request-1"):
    records = []
    for index, row in enumerate(baseline["tables"]["device.csv"][:4]):
        records.append({"device_id": row["device_id"], "node_id": row["node_id"], "model_id": row["model_id"],
            "observed_at": "2026-10-01T10:00:00+08:00" if index else None,
            "status": [None, "NORMAL", "FAULT", "OFFLINE"][index], "alert": None if not index else False,
            "unknown_reasons": ["构造来源未提供状态、告警和采集时间"] if not index else []})
    return {"schema_version": SCHEMA, "context": "ledger", "request_id": request_id,
        "base_revision": baseline["revision"], "data_origin": "SYNTHETIC_INTEGRATION",
        "source_label": "显式构造测试", "provenance_note": "非实测，不代表设备在线", "records": records}


def post(client, payload, headers=HEADERS):
    return client.post(PREFIX + "/imports", json=payload, headers=headers)


def query(client, receipt, extra=None):
    return client.get(PREFIX + "/snapshots/" + receipt["snapshot_id"] + "/devices", headers=HEADERS,
        params={"context": "ledger", "snapshot_revision": receipt["snapshot_revision"], **(extra or {})})


def count(factory, model):
    with factory() as session:
        return session.scalar(select(func.count()).select_from(model))


def test_import_replay_unknowns_filter_pages_and_no_resource_writes(api):
    client, factory, baseline, engine = api
    payload = body(baseline)
    response = post(client, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert post(client, payload).json()["data"] == receipt
    operation = client.get(PREFIX + "/imports/" + payload["request_id"], params={"context": "ledger"}, headers=HEADERS)
    assert operation.json()["data"] == receipt
    result = query(client, receipt).json()["data"]
    assert result["total"] == 4 and result["resource_revision"] == baseline["revision"]
    unknown = query(client, receipt, {"status_filter": "UNKNOWN"}).json()["data"]
    assert unknown["total"] == 1 and unknown["items"][0]["observed_at"] is None
    assert unknown["items"][0]["status"] is None and unknown["items"][0]["alert"] is None
    assert result["items"][1]["observed_at"] == "2026-10-01T02:00:00.000000Z"
    assert query(client, receipt, {"status_filter": "FAULT"}).json()["data"]["total"] == 1
    assert query(client, receipt, {"page": 2, "page_size": 3}).json()["data"]["items"] == result["items"][3:]
    assert query(client, receipt, {"page": 5}).json()["data"]["items"] == []
    header = client.get(PREFIX + "/snapshots/" + receipt["snapshot_id"], headers=HEADERS,
        params={"context": "ledger", "snapshot_revision": receipt["snapshot_revision"]}).json()["data"]
    assert header["counts"] == {"NORMAL": 1, "FAULT": 1, "OFFLINE": 1, "UNKNOWN": 1, "total": 4}
    assert header["first_observed_at"] == "2026-10-01T02:00:00.000000Z"
    assert header["imported_at"] != header["first_observed_at"]
    assert count(factory, Snapshot) == 1 and count(factory, Record) == 4 and count(factory, Operation) == 1
    assert count(factory, ResourceDatasetVersion) == 1 and count(factory, ResourceDatasetOperation) == 0
    assert datasets.current() == baseline
    engine.dispose()  # 新连接回读同一保留库，不清表、不覆盖。
    assert query(client, receipt).json()["data"] == result


@pytest.mark.parametrize("patch", [
    {"context": "gis"}, {"data_origin": "REAL"}, {"source_label": " "}, {"provenance_note": ""},
    {"request_id": "bad/id"}, {"request_id": "history"}, {"schema_version": "bad"}, {"actor_id": "admin"},
    {"records": []},
])
def test_strict_top_level(api, patch):
    client, factory, baseline, _ = api
    response = post(client, {**body(baseline), **patch})
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert count(factory, Snapshot) == 0 and count(factory, Record) == 0


@pytest.mark.parametrize("patch", [
    {"status": "ONLINE"}, {"status": True}, {"alert": 1}, {"alert": "false"},
    {"observed_at": "2026-10-01T00:00:00"}, {"observed_at": "2026-02-31T00:00:00Z"},
    {"observed_at": 1}, {"unknown_reasons": []}, {"unknown_reasons": [" "]},
    {"unknown_reasons": ["x", "x"]}, {"ports": []}, {"online": True},
])
def test_strict_record_and_no_partial_import(api, patch):
    client, factory, baseline, _ = api
    payload = body(baseline)
    payload["records"][0].update(patch)
    response = post(client, payload)
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert count(factory, Snapshot) == 0 and count(factory, Record) == 0 and count(factory, Operation) == 0


def test_duplicate_missing_mismatched_and_oversized_records(api):
    client, factory, baseline, _ = api
    payload = body(baseline)
    for records in ([payload["records"][0]] * 2, [payload["records"][0]] * 1001):
        assert post(client, {**payload, "records": records}).json()["code"] == 1001
    for patch, code in (({"device_id": "missing"}, 1002), ({"model_id": "mismatch"}, 1203), ({"node_id": "mismatch"}, 1203)):
        candidate = deepcopy(payload)
        candidate["records"][-1].update(patch)
        assert post(client, candidate).json()["code"] == code
    assert count(factory, Snapshot) == 0


def test_idempotency_actor_scope_and_same_content_new_batch(api):
    client, factory, baseline, _ = api
    payload = body(baseline)
    receipt = post(client, payload).json()["data"]
    assert post(client, {**payload, "source_label": "different"}).json()["code"] == 1206
    assert post(client, payload, {**HEADERS, "x-test-actor": "other"}).json()["code"] == 1206
    hidden = client.get(PREFIX + "/imports/" + payload["request_id"], params={"context": "ledger"},
        headers={**HEADERS, "x-test-actor": "other"})
    assert hidden.status_code == 404
    second = post(client, {**payload, "request_id": "second"}, {**HEADERS, "x-test-actor": "other"}).json()["data"]
    assert second["snapshot_id"] != receipt["snapshot_id"] and second["content_hash"] == receipt["content_hash"]
    assert count(factory, Snapshot) == 2
    listed = client.get(PREFIX + "/snapshots", params={"context": "ledger", "page_size": 1}, headers=HEADERS).json()["data"]
    assert listed["total"] == 2 and len(listed["items"]) == 1


def test_resource_advance_rejects_new_import_but_replays_existing(api):
    client, factory, baseline, _ = api
    payload = body(baseline)
    receipt = post(client, payload).json()["data"]
    snapshot = {key: deepcopy(baseline[key]) for key in ("schema_version", "tables", "source_files", "source_updated_at")}
    snapshot["tables"]["device.csv"][0]["availability"] = "OFF_SHELF"
    digest = datasets.content_hash(snapshot)
    revision = "resource-" + digest[:16]
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=revision, content_hash=digest, snapshot=snapshot,
            source=baseline["source"], data_origin=baseline["data_origin"], created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = revision
    assert post(client, payload).json()["data"] == receipt
    assert post(client, {**payload, "request_id": "new"}).json()["code"] == 1205
    new = post(client, {**payload, "base_revision": revision, "request_id": "off-shelf"}).json()["data"]
    record = query(client, new).json()["data"]["items"][0]
    assert record["availability"] == "OFF_SHELF" and record["status"] is None
    assert query(client, receipt).json()["data"]["items"][0]["availability"] == "ACTIVE"


def test_ref_resolver_and_version_fail_closed(api):
    client, factory, baseline, _ = api
    payload = body(baseline)
    receipt = post(client, payload).json()["data"]
    with factory() as session:
        header, records = service.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"],
            baseline["revision"], [payload["records"][0]["device_id"]])
        assert records[0]["status"] is None and header["data_origin"] == "SYNTHETIC_INTEGRATION"
        for revision, resource, ids, code in (("wrong", baseline["revision"], [], 1203),
            (receipt["snapshot_revision"], "wrong", [], 1203), (receipt["snapshot_revision"], baseline["revision"], ["missing"], 1002)):
            with pytest.raises(service.DeviceStatusError) as error:
                service.resolve_snapshot(session, receipt["snapshot_id"], revision, resource, ids)
            assert error.value.code == code


@pytest.mark.parametrize("sql", [
    "UPDATE device_status_records SET status='NORMAL' WHERE status IS NULL",
    "UPDATE device_status_records SET availability='OFF_SHELF'",
    "UPDATE device_status_snapshots SET source_label='corrupt'",
    "UPDATE device_status_records SET unknown_reasons='[]' WHERE status IS NULL",
    "UPDATE device_status_import_operations SET request_digest='corrupt'",
])
def test_corruption_not_silently_hidden(api, sql):
    client, factory, baseline, engine = api
    receipt = post(client, body(baseline)).json()["data"]
    with engine.begin() as connection:
        connection.execute(text(sql))
    if "import_operations" in sql:
        response = client.get(PREFIX + "/imports/status-request-1?context=ledger", headers=HEADERS)
    else:
        response = query(client, receipt, {"status_filter": "UNKNOWN"})
    assert response.status_code == 503 and response.json()["code"] == 5002, response.text


@pytest.mark.parametrize("suffix", [
    "/snapshots?context=gis", "/snapshots?context=ledger&page=0", "/snapshots?context=ledger&page_size=101",
    "/snapshots?context=ledger&page=1.0", "/snapshots?context=ledger&x=1", "/snapshots?context=ledger&context=ledger",
    "/snapshots/missing?context=ledger", "/snapshots/missing/devices?context=ledger&snapshot_revision=x&status_filter=ONLINE",
])
def test_queries_strict_and_get_does_not_create(api, suffix):
    client, factory, baseline, _ = api
    response = client.get(PREFIX + suffix, headers=HEADERS)
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert count(factory, Snapshot) == 0


def test_permissions_and_orm_immutable(api):
    client, factory, baseline, _ = api
    assert post(client, body(baseline), {}).status_code == 401
    assert post(client, body(baseline), {"x-test-actor": "editor"}).json()["code"] == 1105
    assert post(client, body(baseline), {**HEADERS, "x-test-actor": "reader"}).json()["code"] == 1104
    receipt = post(client, body(baseline)).json()["data"]
    with factory() as session:
        row = session.get(Snapshot, receipt["snapshot_id"])
        row.source_label = "mutation"
        with pytest.raises(ValueError, match="不可修改"):
            session.flush()


def test_concurrent_same_request_is_one_immutable_batch(api):
    client, factory, baseline, _ = api
    payload = body(baseline)
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(lambda _: post(client, payload).json(), range(2)))
    assert values[0]["code"] == values[1]["code"] == 0
    assert values[0]["data"] == values[1]["data"]
    assert count(factory, Snapshot) == count(factory, Operation) == 1
