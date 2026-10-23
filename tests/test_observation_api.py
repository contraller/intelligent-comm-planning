"""P07 独立应用/新建测试库验证，不导入主入口或连接运行库。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
from pathlib import Path
import sqlite3
import sys
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import frontend_integration, integration_identity_service as identities
from app import observation_service as service, resource_dataset_service as resources
from app.database import Base, DatabaseConfigurationError, get_db
from app.integration_identity_models import IntegrationSession
from app.observation_models import (
    OBSERVATION_METADATA, ObservationDataset, ObservationFrame, ObservationImportOperation,
    sqlite_immutability_ddl,
)
from app.observation_routes import router
from app.observation_schemas import ObservationImportRequest
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion

PREFIX = "/api/v1/observations/spectrum"
TABLES = (ObservationDataset, ObservationFrame, ObservationImportOperation)


def application(factory):
    app = FastAPI()
    app.include_router(router)

    def db():
        with factory() as session:
            yield session

    app.dependency_overrides[get_db] = db
    return app


@pytest.fixture
def database(tmp_path, monkeypatch):
    assert (ROOT / "data/runtime/tmp").resolve() in tmp_path.resolve().parents
    path = tmp_path / "observation.sqlite"
    assert not path.exists()
    engine = create_engine("sqlite:///" + path.as_posix(), connect_args={"check_same_thread": False, "timeout": 10})

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine, tables=[ResourceDatasetVersion.__table__, ResourceDatasetCurrent.__table__, IntegrationSession.__table__])
    OBSERVATION_METADATA.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    monkeypatch.setattr(identities, "get_session_factory", lambda: factory)
    snapshot = resources.initialize(factory)
    app = application(factory)
    with TestClient(app) as client:
        yield {"path": path, "engine": engine, "factory": factory, "client": client,
            "app": app, "revision": snapshot["revision"]}
    engine.dispose()


def payload(db, dataset_id="obs-A", request_id="request-A"):
    source = {"sourceId": "source:HF", "name": "构造短波样本", "configRevision": "declared-v1",
        "minKhz": 6000, "maxKhz": 8000, "intervalSeconds": None}
    frames = []
    for index in range(3):
        unknown = index == 1
        frames.append({"frameId": f"frame:{index}", "index": index,
            "observedAt": None if unknown else f"2026-10-05T09:0{index}:00+08:00",
            "label": "构造观测", "occupancyPercent": None if unknown else 20,
            "abnormalBandCount": None if unknown else int(index == 2),
            "unknownReasons": ["构造资料未提供帧汇总和时间"] if unknown else [],
            "bins": [{"binId": "bin:HF", "minKhz": 6000, "maxKhz": 7000,
                "occupancyPercent": None if unknown else 20,
                "powerDbm": None if unknown else -90,
                "abnormal": None if unknown else index == 2,
                "reason": "构造异常标记" if index == 2 else None,
                "unknownReasons": ["构造资料未提供频段观测"] if unknown else []}]})
    return {"schemaVersion": 1, "requestId": request_id, "datasetId": dataset_id,
        "dataOrigin": "SYNTHETIC_INTEGRATION", "provenanceNote": "单元测试显式构造，非实测",
        "resourceRevision": db["revision"], "deviceStatusSnapshotId": None,
        "source": source, "frames": frames}


def imported(db, value=None, actor="p07-test-internal"):
    return service.import_synthetic_dataset(ObservationImportRequest.model_validate(value or payload(db)),
        actor_id=actor, factory=db["factory"])


def counts(db):
    with db["factory"]() as session:
        return tuple(session.scalar(select(func.count()).select_from(model)) for model in TABLES)


def get(db, path, revision=None, **params):
    if revision is not None:
        params["dataset_revision"] = revision
    return db["client"].get(PREFIX + path, params=params)


def test_empty_context_and_only_four_get_routes(database):
    db = database
    value = get(db, "/context").json()["data"]
    assert value["selected"] is None and value["datasetCount"] == 0
    assert value["reasons"] == ["NO_IMPORTED_DATA"]
    assert value["replay"]["loop"] is False
    assert get(db, "/datasets").json()["data"]["items"] == []
    assert counts(db) == (0, 0, 0)
    assert len(router.routes) == 4
    assert all(route.methods == {"GET"} for route in router.routes)


def test_import_reopen_and_finite_frame_reads(database):
    db = database
    original = payload(db)
    receipt = imported(db, original)
    assert receipt.changed is True and receipt.frameCount == 3
    assert receipt.datasetRevision.startswith("observation-")
    assert counts(db) == (1, 3, 1)
    revision = receipt.datasetRevision
    context = get(db, "/context", revision, dataset_id="obs-A").json()["data"]
    summary = context["selected"]
    assert summary["deviceStatusSnapshotId"] is None
    assert summary["source"]["intervalSeconds"] is None
    assert summary["dataOrigin"] == "SYNTHETIC_INTEGRATION"
    assert summary["firstObservedAt"] == "2026-10-05T01:00:00.000000Z"
    assert get(db, "/context").json()["data"]["reasons"] == ["DATASET_NOT_SELECTED"]
    first = get(db, "/datasets/obs-A/frames/0", revision).json()["data"]
    assert first["hasPrevious"] is False and first["hasNext"] is True
    unknown = get(db, "/datasets/obs-A/frames/1", revision).json()["data"]["frame"]
    assert unknown["observedAt"] is None and unknown["occupancyPercent"] is None
    assert unknown["bins"][0]["powerDbm"] is None and unknown["bins"][0]["abnormal"] is None
    assert unknown["unknownReasons"] == original["frames"][1]["unknownReasons"]
    last = get(db, "/datasets/obs-A/frames/2", revision).json()["data"]
    assert last["hasNext"] is False and last["hasPrevious"] is True
    assert get(db, "/datasets/obs-A/frames/3", revision).status_code == 404
    second_engine = create_engine("sqlite:///" + db["path"].as_posix())
    try:
        with sessionmaker(bind=second_engine)() as session:
            assert service.frame(session, "obs-A", revision, 1)["frame"] == unknown
    finally:
        second_engine.dispose()


def test_pagination_order_and_empty_page(database):
    db = database
    receipt = imported(db, payload(db, "obs-Z", "request-Z"))
    imported(db)
    assert [item["datasetId"] for item in get(db, "/datasets").json()["data"]["items"]] == ["obs-A", "obs-Z"]
    page = get(db, "/datasets/obs-Z/frames", receipt.datasetRevision, page=2, page_size=2).json()["data"]
    assert page["total"] == 3 and [item["index"] for item in page["items"]] == [2]
    empty = get(db, "/datasets/obs-Z/frames", receipt.datasetRevision, page=99, page_size=2).json()["data"]
    assert empty["items"] == [] and empty["total"] == 3
    assert get(db, "/datasets", page=9007199254740991, page_size=100).json()["data"]["items"] == []


def test_idempotency_conflict_and_resource_change(database, monkeypatch):
    db = database
    first = imported(db)
    assert imported(db) == first
    assert counts(db) == (1, 3, 1)
    for value, actor in (({**payload(db), "provenanceNote": "另一构造来源"}, "p07-test-internal"), (payload(db), "another-test-actor")):
        with pytest.raises(service.ObservationError) as error:
            imported(db, value, actor)
        assert (error.value.code, error.value.status) == (1206, 409)
    second = imported(db, payload(db, request_id="request-second"))
    assert second.changed is False and second.datasetRevision == first.datasetRevision
    assert counts(db) == (1, 3, 2)
    different_dataset_content = payload(db, request_id="request-conflict")
    different_dataset_content["source"]["name"] = "另一个构造名"
    with pytest.raises(service.ObservationError, match="观测集编号"):
        imported(db, different_dataset_content)
    # 真正在新建测试库切换资源指针；不修改历史资源或开发库。
    with db["factory"].begin() as session:
        pointer = session.get(ResourceDatasetCurrent, resources.SCOPE)
        row = session.get(ResourceDatasetVersion, pointer.revision)
        session.add(ResourceDatasetVersion(revision="resource-" + "f" * 16, content_hash=row.content_hash,
            source=row.source, data_origin=row.data_origin, snapshot=deepcopy(row.snapshot), created_at=row.created_at))
        session.flush()
        pointer.revision = "resource-" + "f" * 16
    assert resources.current(db["factory"])["revision"] != db["revision"]
    assert imported(db) == first
    with pytest.raises(service.ObservationError) as error:
        imported(db, payload(db, "new-dataset", "new-request"))
    assert error.value.code == 1205
    monkeypatch.setattr(resources, "current", lambda **_: pytest.fail("读取历史不能读取当前资源"))
    assert get(db, "/datasets/obs-A/frames/0", first.datasetRevision).status_code == 200


def test_resource_switch_after_read_keeps_explicit_historical_identity(database, monkeypatch):
    db = database
    original_current = resources.current
    new_revision = "resource-" + "e" * 16

    def switch_after_validation(*args, **kwargs):
        captured = original_current(*args, **kwargs)
        # 在来源读取之后、观测写入之前，另一连接真实提交资源指针换版。
        with db["factory"].begin() as session:
            pointer = session.get(ResourceDatasetCurrent, resources.SCOPE)
            old = session.get(ResourceDatasetVersion, pointer.revision)
            session.add(ResourceDatasetVersion(revision=new_revision, content_hash=old.content_hash,
                source=old.source, data_origin=old.data_origin, snapshot=deepcopy(old.snapshot), created_at=old.created_at))
            session.flush()
            pointer.revision = new_revision
        return captured

    monkeypatch.setattr(resources, "current", switch_after_validation)
    receipt = imported(db)
    assert original_current(factory=db["factory"])["revision"] == new_revision
    assert receipt.resourceRevision == db["revision"] != new_revision
    assert receipt.dataOrigin == "SYNTHETIC_INTEGRATION"
    summary = get(db, "/context", receipt.datasetRevision, dataset_id="obs-A").json()["data"]["selected"]
    assert summary["resourceRevision"] == db["revision"]
    assert summary["source"]["configRevision"] == "declared-v1"
    assert "endpoint" not in summary["source"] and "protocol" not in summary["source"]
    assert summary["deviceStatusSnapshotId"] is None
    assert counts(db) == (1, 3, 1)


@pytest.mark.parametrize("kind", ["origin", "extra", "snapshot", "boolean", "version-bool", "nan", "duplicate-frame", "duplicate-bin", "index", "time", "timezone", "time-overflow", "reverse-time", "band", "overlap", "unknown", "count", "reason", "too-many"])
def test_invalid_import_is_atomic(database, kind):
    value = payload(database)
    if kind == "origin": value["dataOrigin"] = "MEASURED"
    elif kind == "extra": value["endpoint"] = "https://invalid.example"
    elif kind == "snapshot": value["deviceStatusSnapshotId"] = "fake-p06"
    elif kind == "boolean": value["frames"][0]["occupancyPercent"] = True
    elif kind == "version-bool": value["schemaVersion"] = True
    elif kind == "nan": value["frames"][0]["bins"][0]["powerDbm"] = float("nan")
    elif kind == "duplicate-frame": value["frames"][1]["frameId"] = value["frames"][0]["frameId"]
    elif kind == "duplicate-bin": value["frames"][0]["bins"].append(deepcopy(value["frames"][0]["bins"][0]))
    elif kind == "index": value["frames"][1]["index"] = 2
    elif kind == "time": value["frames"][0]["observedAt"] = "2026-10-05T09:00:00"
    elif kind == "timezone": value["frames"][0]["observedAt"] = "2026-10-05T09:00:00+00:99"
    elif kind == "time-overflow": value["frames"][0]["observedAt"] = "0001-01-01T00:00:00+01:00"
    elif kind == "reverse-time": value["frames"][2]["observedAt"] = "2026-10-04T09:00:00+08:00"
    elif kind == "band": value["source"]["maxKhz"] = 6500
    elif kind == "overlap": value["frames"][0]["bins"].append({**deepcopy(value["frames"][0]["bins"][0]), "binId": "other-bin"})
    elif kind == "unknown": value["frames"][1]["bins"][0]["unknownReasons"] = []
    elif kind == "count": value["frames"][2]["abnormalBandCount"] = 0
    elif kind == "reason": value["frames"][2]["bins"][0]["reason"] = None
    elif kind == "too-many": value["frames"] = [deepcopy(value["frames"][0]) for _ in range(257)]
    with pytest.raises(ValidationError):
        service.import_synthetic_dataset(value, actor_id="p07-test", factory=database["factory"])
    assert counts(database) == (0, 0, 0)


@pytest.mark.parametrize("path,params", [
    ("/datasets", "page=0"), ("/datasets", "page_size=101"), ("/datasets", "page=1&page=2"),
    ("/datasets", "unknown=x"), ("/datasets", "page=true"), ("/datasets", "page=9007199254740992"),
    ("/context", "dataset_id=obs-A"), ("/datasets/obs-A/frames", ""),
    ("/datasets/obs-A/frames/-1", "dataset_revision=observation-" + "a" * 64),
])
def test_invalid_query_error_envelope(database, path, params):
    response = database["client"].get(PREFIX + path + "?" + params)
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(database) == (0, 0, 0)


def test_wrong_revision_and_absent_dataset(database):
    receipt = imported(database)
    response = get(database, "/datasets/obs-A/frames/0", "observation-" + "a" * 64)
    assert response.status_code == 409 and response.json()["code"] == 1204
    response = get(database, "/datasets/missing/frames/0", receipt.datasetRevision)
    assert response.status_code == 404 and response.json()["code"] == 1002


def test_real_identity_checks_and_expired_cookie(database, monkeypatch):
    db = database
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert get(db, "/context").json()["code"] == 1101
    with pytest.raises(service.ObservationError) as error:
        imported(db)
    assert error.value.code == 1101
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    response = db["client"].get(PREFIX + "/context", headers={"X-Session-Id": "wrong"})
    assert response.status_code == 409 and response.json()["code"] == 1106
    token = "p07-expired-test-cookie"
    with db["factory"].begin() as session:
        session.add(IntegrationSession(token_hash=hashlib.sha256(token.encode()).hexdigest(), session_id="expired",
            account_id="integration-editor", csrf="test", active=True, expires_at=time.time() - 1))
    db["client"].cookies.set(identities.COOKIE, token)
    assert get(db, "/context").json()["code"] == 1106
    db["client"].cookies.clear()
    # 仅测试权限边界的受控 principal；实际 require 仍执行，不冒充正式身份源。
    original = frontend_integration.session_identity()
    monkeypatch.setattr(frontend_integration, "session_identity", lambda: {**original, "permissions": []})
    response = get(db, "/context")
    assert response.status_code == 403 and response.json()["code"] == 1104


def test_authorization_precedes_database_dependency(database, monkeypatch):
    def forbidden_database_access():
        pytest.fail("未授权请求不能进入数据库依赖")
    database["app"].dependency_overrides[get_db] = forbidden_database_access
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    response = get(database, "/context")
    assert response.status_code == 401 and response.json()["code"] == 1101


def test_get_is_read_only_and_missing_tables_do_not_initialize(database, tmp_path, monkeypatch):
    db = database
    receipt = imported(db)
    before = counts(db)
    readonly_engine = create_engine("sqlite://", creator=lambda: sqlite3.connect(
        f"file:{db['path'].as_posix()}?mode=ro", uri=True, check_same_thread=False))
    factory = sessionmaker(bind=readonly_engine)
    statements = []

    @event.listens_for(readonly_engine, "before_cursor_execute")
    def trace(_connection, _cursor, statement, _params, _context, _many):
        statements.append(statement)

    try:
        with TestClient(application(factory)) as client:
            for path in ("/context", "/datasets", "/datasets/obs-A/frames", "/datasets/obs-A/frames/1"):
                assert client.get(PREFIX + path, params={"dataset_revision": receipt.datasetRevision} if "/frames" in path else {}).status_code == 200
        assert all(statement.lstrip().upper().startswith("SELECT") for statement in statements)
        assert counts(db) == before
    finally:
        readonly_engine.dispose()
    missing_path = tmp_path / "missing-tables.sqlite"
    missing_engine = create_engine("sqlite:///" + missing_path.as_posix())
    try:
        with TestClient(application(sessionmaker(bind=missing_engine))) as client:
            response = client.get(PREFIX + "/context")
            assert response.status_code == 503 and response.json()["code"] == 5002
        with missing_engine.connect() as connection:
            assert connection.exec_driver_sql("SELECT count(*) FROM sqlite_master WHERE type='table'").scalar() == 0
    finally:
        missing_engine.dispose()
    def unconfigured():
        raise DatabaseConfigurationError("test")
    db["app"].dependency_overrides[get_db] = unconfigured
    assert get(db, "/context").json()["code"] == 5001


@pytest.mark.parametrize("model", TABLES)
@pytest.mark.parametrize("operation", ["UPDATE", "DELETE"])
def test_database_and_orm_immutability(database, model, operation):
    db = database
    imported(db)
    with pytest.raises(IntegrityError, match="immutable"):
        with db["factory"].begin() as session:
            table = model.__tablename__
            statement = f"DELETE FROM {table}" if operation == "DELETE" else f"UPDATE {table} SET {list(model.__table__.primary_key.columns)[0].name}={list(model.__table__.primary_key.columns)[0].name}"
            session.execute(text(statement))
    with pytest.raises(ValueError, match="不可修改或删除"):
        with db["factory"].begin() as session:
            row = session.scalars(select(model)).first()
            if operation == "DELETE":
                session.delete(row)
            else:
                setattr(row, "actor_id" if hasattr(row, "actor_id") else "frame_id", "attempted-change")
    assert counts(db) == (1, 3, 1)


def test_frame_insert_failure_rolls_back_whole_import(database):
    db = database
    @event.listens_for(db["engine"], "before_cursor_execute")
    def injected_failure(_connection, _cursor, statement, parameters, _context, _many):
        if statement.startswith("INSERT INTO observation_frames"):
            raise IntegrityError(statement, parameters, RuntimeError("controlled frame insert failure"))
    try:
        with pytest.raises(service.ObservationError):
            imported(db)
        assert counts(db) == (0, 0, 0)
    finally:
        event.remove(db["engine"], "before_cursor_execute", injected_failure)


def test_unique_key_retry_and_concurrent_request(database):
    db = database
    once = {"remaining": 1}
    @event.listens_for(db["engine"], "before_cursor_execute")
    def injected_race(_connection, _cursor, statement, parameters, _context, _many):
        if statement.startswith("INSERT INTO observation_datasets") and once["remaining"]:
            once["remaining"] -= 1
            raise IntegrityError(statement, parameters, RuntimeError("controlled unique-key race"))
    try:
        receipt = imported(db)
        assert counts(db) == (1, 3, 1)
    finally:
        event.remove(db["engine"], "before_cursor_execute", injected_race)
    concurrent_payload = payload(db, "concurrent-dataset", "concurrent-request")
    def send():
        try:
            return imported(db, concurrent_payload)
        except service.ObservationError as error:
            # SQLite busy 仅允许明确失败；重试原请求后必须得到同一持久化回执。
            assert error.code == 5002
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: send(), range(2)))
    final = imported(db, concurrent_payload)
    assert any(item is not None for item in results)
    assert all(item == final for item in results if item is not None)
    assert counts(db) == (2, 6, 2)
    assert imported(db) == receipt


def test_corruption_decoder_and_metadata_registration(database):
    db = database
    receipt = imported(db)
    with db["factory"]() as session:
        dataset = session.get(ObservationDataset, "obs-A")
        frame = session.get(ObservationFrame, ("obs-A", 0))
        session.expunge(frame)
        frame.frame_hash = "0" * 64
        with pytest.raises(service.ObservationError, match="损坏"):
            service._frame(frame, dataset)
        session.expunge(dataset)
        dataset.provenance_note = "controlled corrupt decoder input"
        with pytest.raises(service.ObservationError, match="损坏"):
            service._summary(dataset)
    assert counts(db) == (1, 3, 1)
    assert OBSERVATION_METADATA is not Base.metadata
    assert set(OBSERVATION_METADATA.tables) == {item.__tablename__ for item in TABLES}
    assert len(sqlite_immutability_ddl()) == 6
    assert get(db, "/datasets/obs-A/frames/0", receipt.datasetRevision).status_code == 200


def test_missing_resource_baseline_and_file_mode(database, monkeypatch, tmp_path):
    db = database
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    with pytest.raises(service.ObservationError) as error:
        imported(db)
    assert error.value.code == 5001
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    engine = create_engine("sqlite:///" + (tmp_path / "uninitialized-resource.sqlite").as_posix())
    try:
        Base.metadata.create_all(engine, tables=[ResourceDatasetVersion.__table__, ResourceDatasetCurrent.__table__])
        OBSERVATION_METADATA.create_all(engine)
        factory = sessionmaker(bind=engine)
        with pytest.raises(resources.ResourceDatasetError) as error:
            service.import_synthetic_dataset(payload(db), actor_id="p07-test", factory=factory)
        assert error.value.code == 5003
        with factory() as session:
            assert session.scalar(select(func.count()).select_from(ObservationDataset)) == 0
    finally:
        engine.dispose()
