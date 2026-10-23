"""来源声明隔离测试；新GUID临时库，不连接r2开发库。"""
from copy import deepcopy
import hashlib
from pathlib import Path
import socket
import sqlite3
import sys
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import integration_identity_service as identity, spectrum_source_routes as routes, spectrum_source_service as service
from app.database import Base, get_db
from app.integration_identity_models import IntegrationSession
from app.spectrum_source_models import SPECTRUM_SOURCE_METADATA, SpectrumSourceCurrent as Current, SpectrumSourceOperation as Operation, SpectrumSourceVersion as Version, sqlite_immutability_ddl

PREFIX = "/api/v1/spectrum"
HEADERS = {"X-Session-Id": "r2-source-editor", "X-CSRF-Token": "r2-source-csrf"}


def application(factory):
    app = FastAPI()
    app.include_router(routes.router)
    def db():
        with factory() as session:
            yield session
    app.dependency_overrides[get_db] = db
    return app


@pytest.fixture
def source_api(tmp_path, monkeypatch):
    assert (ROOT / "data/runtime/tmp").resolve() in tmp_path.resolve().parents
    path = tmp_path / "spectrum-sources.sqlite"
    assert not path.exists()
    engine = create_engine("sqlite:///" + path.as_posix(), connect_args={"check_same_thread": False, "timeout": 10})
    @event.listens_for(engine, "connect")
    def foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
    Base.metadata.create_all(engine, tables=[IntegrationSession.__table__])
    SPECTRUM_SOURCE_METADATA.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("AUTH_MODE", "INTEGRATION")
    monkeypatch.setattr(routes, "get_session_factory", lambda: factory)
    monkeypatch.setattr(identity, "get_session_factory", lambda: factory)
    catalog = deepcopy(identity.CATALOG)
    name, role, permissions = catalog["integration-editor"]
    catalog["integration-editor"] = (name, role, [*permissions, "resources.spectrum.edit"])
    monkeypatch.setattr(identity, "CATALOG", catalog)
    token = "r2-spectrum-test-cookie"
    with factory.begin() as session:
        session.add(IntegrationSession(token_hash=hashlib.sha256(token.encode()).hexdigest(),
            session_id=HEADERS["X-Session-Id"], account_id="integration-editor", csrf=HEADERS["X-CSRF-Token"], active=True, expires_at=time.time() + 3600))
    app = application(factory)
    with TestClient(app) as client:
        client.cookies.set(identity.COOKIE, token)
        yield {"path": path, "engine": engine, "factory": factory, "client": client, "app": app}
    engine.dispose()


def draft(**changes):
    return {"name": "构造来源声明", "protocolHint": None, "endpoint": None, "intervalSeconds": None,
        "minKhz": 6000, "maxKhz": 10000, "enabled": True, "provenanceNote": "测试构造来源，未连接设备", **changes}


def post(db, body=None, path="/sources"):
    return db["client"].post(PREFIX + path, json=body or {
        "schemaVersion": 1, "requestId": "source-save-1", "sourceId": "source:HF", "baseConfigRevision": None, "draft": draft()}, headers=HEADERS)


def get(db, path="/sources", **params):
    return db["client"].get(PREFIX + path, params=params)


def counts(db):
    with db["factory"]() as session:
        return tuple(session.scalar(select(func.count()).select_from(model)) for model in (Version, Current, Operation))


def test_local_synthetic_source_internal_actor_and_uninstalled_identity_fail_closed(source_api, monkeypatch):
    db = source_api
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    saved = service.save_source({"schemaVersion": 1, "requestId": "local-source", "sourceId": "source:LOCAL",
        "baseConfigRevision": None, "draft": draft()}, actor_id="local-service-unit", factory=db["factory"])
    checked = service.check_source("source:LOCAL", {"schemaVersion": 1, "requestId": "local-check", "configRevision": saved["configRevision"]},
        actor_id="local-service-unit", factory=db["factory"])
    assert saved["source"]["dataOrigin"] == "SYNTHETIC_INTEGRATION" and saved["actorId"] == "local-service-unit"
    assert checked["check"]["connection"] == "NOT_ATTEMPTED" and checked["check"]["validationMode"] == "OFFLINE_ONLY"
    assert counts(db) == (1, 1, 2)
    def forbidden_factory():
        pytest.fail("未安装真实LOCAL身份时不得进入业务factory")
    monkeypatch.setattr(routes, "get_session_factory", forbidden_factory)
    db["app"].dependency_overrides[get_db] = forbidden_factory
    assert get(db).status_code == 401
    assert post(db).status_code == 401
    assert post(db, {"schemaVersion": 1, "requestId": "denied-check", "configRevision": saved["configRevision"]}, "/sources/source:LOCAL/checks").status_code == 401
    assert counts(db) == (1, 1, 2)


def test_source_create_detail_history_noop_and_reopen(source_api):
    db = source_api
    assert get(db).json()["data"]["items"] == []
    response = post(db)
    assert response.status_code == 200, response.text
    first = response.json()["data"]
    assert first["source"]["draft"] == draft()
    assert first["source"]["dataOrigin"] == "SYNTHETIC_INTEGRATION"
    assert first["changed"] is True and first["check"] is None
    revision = first["configRevision"]
    assert revision == "SPV-" + first["source"]["contentHash"]
    assert get(db, "/sources/source:HF").json()["data"] == first["source"]
    assert post(db).json()["data"] == first
    assert counts(db) == (1, 1, 1)
    noop = post(db, {"schemaVersion": 1, "requestId": "source-noop", "sourceId": "source:HF", "baseConfigRevision": revision, "draft": draft()}).json()["data"]
    assert noop["changed"] is False and noop["configRevision"] == revision
    assert counts(db) == (1, 1, 2)
    second = post(db, {"schemaVersion": 1, "requestId": "source-disable", "sourceId": "source:HF", "baseConfigRevision": revision, "draft": draft(enabled=False)}).json()["data"]
    assert second["changed"] is True and second["source"]["draft"]["enabled"] is False
    assert post(db).json()["data"] == first
    assert get(db, "/sources/source:HF", config_revision=revision).json()["data"] == first["source"]
    history = get(db, "/sources/source:HF/versions", page_size=1).json()["data"]
    assert history["total"] == 2 and history["items"][0] == second["source"]
    assert get(db, page=99).json()["data"]["items"] == []
    assert get(db, enabled="false").json()["data"]["total"] == 1
    assert get(db, enabled="true").json()["data"]["total"] == 0
    assert get(db, search="%_").json()["data"]["total"] == 0
    assert get(db, search="构造来源").json()["data"]["total"] == 1
    other = create_engine("sqlite:///" + db["path"].as_posix())
    try:
        with sessionmaker(bind=other)() as session:
            assert service.get_version(session, "source:HF", revision) == first["source"]
    finally:
        other.dispose()


def test_offline_only_checks_no_network_and_no_false_ready(source_api, monkeypatch):
    db = source_api
    def forbidden(*_, **__):
        pytest.fail("离线检查不允许调用网络")
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    first = post(db).json()["data"]
    check = {"schemaVersion": 1, "requestId": "offline-check-1", "configRevision": first["configRevision"]}
    response = post(db, check, "/sources/source:HF/checks")
    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert receipt["changed"] is False
    assert receipt["check"]["connection"] == "NOT_ATTEMPTED"
    assert receipt["check"]["validationMode"] == "OFFLINE_ONLY"
    assert receipt["check"]["validation"] == "INCOMPLETE"
    assert post(db, check, "/sources/source:HF/checks").json()["data"] == receipt
    assert get(db).json()["data"]["items"][0]["latestOfflineCheck"] == receipt["check"]
    updated = post(db, {"schemaVersion": 1, "requestId": "complete-source", "sourceId": "source:HF", "baseConfigRevision": first["configRevision"],
        "draft": draft(protocolHint="HTTP_JSON", endpoint="http://collector.invalid/spectrum", intervalSeconds=30)}).json()["data"]
    assert get(db).json()["data"]["items"][0]["latestOfflineCheck"] is None
    valid = post(db, {**check, "requestId": "offline-check-2", "configRevision": updated["configRevision"]}, "/sources/source:HF/checks").json()["data"]["check"]
    assert valid["validation"] == "VALID" and valid["connection"] == "NOT_ATTEMPTED"
    checks = get(db, "/sources/source:HF/checks", config_revision=first["configRevision"]).json()["data"]
    assert checks["total"] == 1 and checks["items"] == [receipt["check"]]
    assert counts(db) == (2, 1, 4)


def test_conflicts_and_actor_owned_operation_lookup(source_api):
    db = source_api
    first = post(db).json()["data"]
    changed = {"schemaVersion": 1, "requestId": "source-save-1", "sourceId": "source:HF", "baseConfigRevision": None, "draft": draft(name="另一个名称")}
    assert post(db, changed).json()["code"] == 1206
    changed["requestId"] = "stale-save"
    assert post(db, changed).json()["code"] == 1204
    lookup = get(db, "/source-operations/source-save-1", operation_type="SOURCE_SAVE").json()["data"]
    assert lookup["status"] == "COMMITTED" and lookup["receipt"] == first
    assert get(db, "/source-operations/source-save-1", operation_type="SOURCE_CHECK").json()["code"] == 1204
    assert get(db, "/source-operations/absent", operation_type="SOURCE_SAVE").json()["data"]["status"] == "NOT_FOUND"
    db["client"].cookies.clear()
    assert get(db, "/source-operations/source-save-1", operation_type="SOURCE_SAVE").status_code == 403
    assert post(db).status_code == 409


@pytest.mark.parametrize("patch", [
    {"name": " "}, {"protocolHint": "MQTT"}, {"endpoint": "http://user:pass@collector.invalid"},
    {"endpoint": "http://collector.invalid/#secret"}, {"endpoint": "http://collector.invalid:0"},
    {"endpoint": "http://collector.invalid", "protocolHint": "WEBSOCKET_JSON"},
    {"intervalSeconds": True}, {"enabled": 1}, {"minKhz": None}, {"maxKhz": 5000},
])
def test_invalid_source_never_persists(source_api, patch):
    response = post(source_api, {"schemaVersion": 1, "requestId": "invalid-source", "sourceId": "source:HF", "baseConfigRevision": None, "draft": draft(**patch)})
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(source_api) == (0, 0, 0)


def test_query_validation_csrf_permissions_and_disabled_mode(source_api, monkeypatch):
    db = source_api
    for query in ("page=0", "page=1&page=2", "enabled=yes", "page_size=101", "unknown=x"):
        assert db["client"].get(PREFIX + "/sources?" + query).status_code == 422
    bad = {**HEADERS, "X-CSRF-Token": "wrong"}
    response = db["client"].post(PREFIX + "/sources", json={}, headers=bad)
    assert response.status_code == 403 and response.json()["code"] == 1105
    assert post(db, {"schemaVersion": True, "requestId": "bad", "sourceId": "s", "baseConfigRevision": None, "draft": draft()}).status_code == 422
    catalog = deepcopy(identity.CATALOG)
    name, role, permissions = catalog["integration-editor"]
    catalog["integration-editor"] = (name, role, [item for item in permissions if item != "resources.spectrum.edit"])
    monkeypatch.setattr(identity, "CATALOG", catalog)
    assert post(db).json()["code"] == 1104
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert get(db).json()["code"] == 1101


def test_export_preserves_declared_unknowns_and_is_read_only(source_api):
    db = source_api
    first = post(db).json()["data"]
    before = counts(db)
    response = get(db, "/sources/source:HF/export", config_revision=first["configRevision"])
    assert response.status_code == 200 and response.headers["content-type"].startswith("application/json")
    assert "attachment" in response.headers["content-disposition"]
    assert response.json()["draft"] == draft()
    assert response.json()["fileKind"] == "SPECTRUM_SOURCE_CONFIG"
    assert counts(db) == before
    readonly = create_engine("sqlite://", creator=lambda: sqlite3.connect(f"file:{db['path'].as_posix()}?mode=ro", uri=True, check_same_thread=False))
    try:
        with TestClient(application(sessionmaker(bind=readonly))) as client:
            for path in ("/sources", "/sources/source:HF", "/sources/source:HF/versions", "/sources/source:HF/checks"):
                assert client.get(PREFIX + path).status_code == 200
    finally:
        readonly.dispose()


@pytest.mark.parametrize("model", [Version, Operation])
@pytest.mark.parametrize("action", ["UPDATE", "DELETE"])
def test_source_history_immutable(source_api, model, action):
    db = source_api
    post(db)
    with pytest.raises(IntegrityError, match="immutable"):
        with db["factory"].begin() as session:
            key = list(model.__table__.primary_key.columns)[0].name
            session.execute(text(f"DELETE FROM {model.__tablename__}" if action == "DELETE" else f"UPDATE {model.__tablename__} SET {key}={key}"))
    assert counts(db) == (1, 1, 1)
    assert len(sqlite_immutability_ddl()) == 4


def test_save_rollback_and_unique_constraint_retry(source_api):
    db = source_api
    remaining = {"value": 1}
    @event.listens_for(db["engine"], "before_cursor_execute")
    def failure(_connection, _cursor, statement, params, _context, _many):
        if statement.startswith("INSERT INTO spectrum_source_operations") and remaining["value"]:
            remaining["value"] -= 1
            raise IntegrityError(statement, params, RuntimeError("controlled operation insert failure"))
    try:
        response = post(db)
        assert response.status_code == 200
        assert counts(db) == (1, 1, 1)
    finally:
        event.remove(db["engine"], "before_cursor_execute", failure)
