"""P06 独立应用与新建 SQLite：系统受理不代表设备执行。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import threading

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select, text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, integration_identity_service as identity
from app import resource_dataset_service as datasets
from app import device_configuration_service as service
from app.database import Base
from app.device_configuration_models import DeviceConfigurationRequest as Record
from app.device_configuration_router import router
from app.device_configuration_router import create_device_configuration_router
from app.device_configuration_schemas import ConfigurationSubmission, SCHEMA_VERSION
from app.integration_identity_models import IntegrationSession
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion, ResourceDatasetOperation


def isolated_app():
    app = FastAPI()
    app.include_router(router)

    def call(response, operation):
        try:
            return {"code": 0, "message": "success", "data": operation()}
        except identity.IdentityError as exc:
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": None}

    @app.get("/api/v1/auth/session")
    def session(request: Request, response: Response):
        return call(response, lambda: identity.current(request))

    @app.get("/api/v1/auth/csrf")
    def csrf(request: Request, response: Response):
        return call(response, lambda: identity.challenge(request))

    @app.post("/api/v1/auth/integration/switch")
    def switch(payload: dict, request: Request, response: Response):
        return call(response, lambda: identity.switch(request, response, payload["accountId"]))

    return app


@pytest.fixture
def api(tmp_path, monkeypatch):
    path = tmp_path / "p06.sqlite"
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False, "timeout": 10})
    tables = [cls.__table__ for cls in (ResourceDatasetVersion, ResourceDatasetCurrent,
        ResourceDatasetOperation, IntegrationSession, Record)]
    Base.metadata.create_all(engine, tables=tables)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    for module in (database, identity, datasets, service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(path))
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    datasets.initialize()
    baseline = datasets.current()
    with TestClient(isolated_app()) as client:
        yield client, factory, baseline, path
    engine.dispose()


def headers(client):
    data = client.get("/api/v1/auth/csrf").json()["data"]
    return {"X-Session-Id": data["session_id"], "X-CSRF-Token": data["csrf_token"]}


def editor(client, account="integration-editor"):
    reply = client.post("/api/v1/auth/integration/switch", headers=headers(client), json={"accountId": account})
    assert reply.status_code == 200, reply.text
    return reply.json()["data"]


def body(baseline, request_id="p06-request-1"):
    device = baseline["tables"]["device.csv"][0]
    model = next(row for row in baseline["tables"]["device_model.csv"] if row["model_id"] == device["model_id"])
    return {"schema_version": SCHEMA_VERSION, "context": "ledger", "base_revision": baseline["revision"],
        "request_id": request_id, "device_id": device["device_id"], "model_id": device["model_id"],
        "values": {"tx_power_dbm": float(model["tx_power_max_dbm"]) - 1,
                   "work_freq_khz": float(model["freq_min_khz"])}}


def submit(client, payload, extra_headers=None):
    return client.post("/api/v1/device-configurations", headers={**headers(client), "Content-Type": "application/json",
        **(extra_headers or {})}, content=json.dumps(payload, allow_nan=True))


def count(factory, model=Record):
    with factory() as session:
        return session.scalar(select(func.count()).select_from(model))


def detail(client, request_id):
    return client.get("/api/v1/device-configurations/" + request_id, params={"context": "ledger"}, headers=headers(client))


def new_snapshot(factory, baseline, mutate):
    snapshot = {key: deepcopy(baseline[key]) for key in ("schema_version", "tables", "source_files", "source_updated_at")}
    mutate(snapshot)
    digest = datasets.content_hash(snapshot)
    revision = "resource-" + digest[:16]
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=revision, content_hash=digest, source=baseline["source"],
            data_origin=baseline["data_origin"], snapshot=snapshot, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = revision
    return revision


def test_context_validate_acceptance_replay_and_resources_unchanged(api):
    client, factory, baseline, _ = api
    actor = editor(client)
    payload = body(baseline)
    query = {"context": "ledger", "device_id": payload["device_id"], "revision": baseline["revision"]}
    ctx = client.get("/api/v1/device-configurations/context", params=query, headers=headers(client))
    assert ctx.status_code == 200, ctx.text
    context = ctx.json()["data"]
    assert context["protocol"] == {"port_options": None, "mode_options": None, "confirmation": "待确认"}
    assert context["provenance"]["source_files"] == baseline["source_files"]
    validated = client.post("/api/v1/device-configurations/validate", headers=headers(client),
        json={key: value for key, value in payload.items() if key != "request_id"})
    assert validated.status_code == 200, validated.text
    assert validated.json()["data"]["valid"] is True and count(factory) == 0
    response = submit(client, payload)
    assert response.status_code == 200, response.text
    accepted = response.json()["data"]
    assert accepted["actor"]["account_id"] == actor["account_id"]
    assert accepted["status"] == "ACCEPTED" and accepted["receipt_scope"] == "SYSTEM_ACCEPTANCE"
    assert accepted["dispatch_status"] == "NOT_DISPATCHED" and accepted["device_execution_status"] == "UNKNOWN"
    assert all(accepted[key] is None for key in ("online", "effective", "applied_values", "device_reported_at"))
    assert accepted["requested_values"] == payload["values"]
    assert detail(client, payload["request_id"]).json()["data"] == accepted
    assert submit(client, payload).json()["data"] == accepted
    editor(client)
    assert submit(client, payload).json()["data"] == accepted
    assert count(factory) == 1 and count(factory, ResourceDatasetVersion) == 1 and count(factory, ResourceDatasetOperation) == 0
    assert datasets.current() == baseline


def test_a2_injected_principal_preserves_a1_receipt_and_request_digest(api):
    client, factory, baseline, _ = api
    actor = editor(client)
    original = body(baseline, "old-a1")
    old = submit(client, original).json()["data"]
    permissions = []
    def principal(request, permission, writing=False):
        permissions.append((permission, writing))
        return {**actor, "authentication_mode": "INTEGRATION"}
    app = FastAPI()
    app.include_router(create_device_configuration_router(principal))
    with TestClient(app) as isolated:
        replay = isolated.post("/api/v1/device-configurations", json=original)
        assert replay.json()["data"] == old and old["schema_version"] == SCHEMA_VERSION
        payload = {**original, "request_id": "new-a2"}
        accepted = isolated.post("/api/v1/device-configurations", json=payload)
        assert accepted.status_code == 200, accepted.text
        data = accepted.json()["data"]
        assert data["schema_version"] == "device-configuration-a2"
        assert data["actor"]["authentication_mode"] == "INTEGRATION" and "integration_mode" not in data["actor"]
        assert data["request_digest"] == old["request_digest"]
        assert data["status"] == "ACCEPTED" and data["dispatch_status"] == "NOT_DISPATCHED"
        assert isolated.get("/api/v1/device-configurations/new-a2?context=ledger").json()["data"] == data
        assert isolated.post("/api/v1/device-configurations", json=payload).json()["data"] == data
    assert ("resources.view", False) in permissions and ("resources.device.edit", True) in permissions
    assert count(factory) == 2


def test_a2_local_actor_snapshot_is_not_a_formal_login_test(api):
    client, factory, baseline, _ = api
    # 只核验已授权适配字段，不连接 P05 凭据库或声称正式身份联调。
    actor = {"account_id": "local-fixture", "display_name": "本地身份测试桩", "role_id": "role-fixture",
        "identity_revision": "fixture-r1", "authentication_mode": "LOCAL_PASSWORD"}
    app = FastAPI()
    app.include_router(create_device_configuration_router(lambda *args, **kwargs: actor))
    with TestClient(app) as isolated:
        result = isolated.post("/api/v1/device-configurations", json=body(baseline, "local-a2")).json()["data"]
        assert result["actor"] == actor and result["schema_version"] == "device-configuration-a2"
        assert result["provenance"]["data_origin"] == "SYNTHETIC_INTEGRATION"


def test_injected_auth_error_is_not_reported_as_validation_or_success(api):
    _, factory, baseline, _ = api
    from app.system_management_schemas import SystemManagementError
    def reject(*args, **kwargs):
        raise SystemManagementError("请维护密码", 1104, 403, reason="PASSWORD_CHANGE_REQUIRED")
    app = FastAPI()
    app.include_router(create_device_configuration_router(reject))
    with TestClient(app) as isolated:
        response = isolated.post("/api/v1/device-configurations", json=body(baseline))
        assert response.status_code == 403 and response.json()["code"] == 1104
        assert response.json()["data"] == {"reason": "PASSWORD_CHANGE_REQUIRED"}
    assert count(factory) == 0


@pytest.mark.parametrize("kind", ["identity", "system"])
@pytest.mark.parametrize("code,status", [(1102, 401), (1103, 401), (1103, 403)])
@pytest.mark.parametrize("phase", ["read", "write"])
def test_local_session_rejection_preserves_auth_envelope(monkeypatch, kind, code, status, phase):
    from app.system_management_schemas import SystemManagementError
    error = identity.IdentityError("session rejected", code, status) if kind == "identity" else SystemManagementError(
        "session rejected", code, status, reason="SESSION_REVOKED")
    calls = []
    def principal(request, permission, writing=False):
        calls.append((permission, writing))
        if writing == (phase == "write"):
            raise error
        return {"account_id": "local-fixture"}
    def no_business(*args, **kwargs):
        pytest.fail("authentication rejection entered configuration business")
    monkeypatch.setattr(service, "query_history", no_business)
    monkeypatch.setattr(service, "submit_request", no_business)
    app = FastAPI()
    app.include_router(create_device_configuration_router(principal))
    with TestClient(app) as client:
        response = client.get("/api/v1/device-configurations/history?context=ledger") if phase == "read" else client.post(
            "/api/v1/device-configurations", json={})
    assert response.status_code == status
    assert response.json() == {"code": code, "message": "session rejected", "data": None if kind == "identity" else {"reason": "SESSION_REVOKED"}}
    assert calls == [("resources.view", False)] + ([("resources.device.edit", True)] if phase == "write" else [])


@pytest.mark.parametrize("kind", ["runtime", "forged-session", "forged-known", "unknown-code", "unknown-status"])
def test_unknown_principal_error_is_not_swallowed(kind):
    from app.system_management_schemas import SystemManagementError
    class ForgedPrincipalError(ValueError):
        code, status = (1102 if kind == "forged-session" else 1104), 401
    error = RuntimeError("unexpected principal") if kind == "runtime" else ForgedPrincipalError("unexpected principal")
    if kind in ("unknown-code", "unknown-status"):
        error = SystemManagementError("unexpected principal", 9999 if kind == "unknown-code" else 1102,
            401 if kind == "unknown-code" else 500)
    def reject(*args, **kwargs):
        raise error
    app = FastAPI()
    app.include_router(create_device_configuration_router(reject))
    with TestClient(app) as client, pytest.raises(type(error), match="unexpected principal"):
        client.get("/api/v1/device-configurations/history?context=ledger")


@pytest.mark.parametrize("patch", [
    {"ports": []}, {"current_work_mode": "AM"}, {"currentWorkMode": "FM"}, {"mode": "FM"},
    {"scenario": "success"}, {"presetVersion": "1"}, {"retryOf": "old"}, {"actor": {"account_id": "admin"}},
    {"context": "gis"}, {"schema_version": "other"}, {"request_id": "history"}, {"request_id": "bad/id"},
    {"device_id": " "}, {"request_id": ""}, {"request_id": "x" * 121},
    {"values": {"tx_power_dbm": True, "work_freq_khz": 2000}},
    {"values": {"tx_power_dbm": "30", "work_freq_khz": 2000}},
    {"values": {"tx_power_dbm": None, "work_freq_khz": 2000}},
    {"values": {"tx_power_dbm": float("nan"), "work_freq_khz": 2000}},
    {"values": {"tx_power_dbm": float("inf"), "work_freq_khz": 2000}},
    {"values": {"tx_power_dbm": 30, "work_freq_khz": 0}},
    {"values": {"tx_power_dbm": 30, "work_freq_khz": "2000"}},
    {"values": {"tx_power_dbm": 30, "work_freq_khz": None}},
    {"values": {"tx_power_dbm": 30, "work_freq_khz": 2000, "ports": []}},
])
def test_strict_requests_never_persist(api, patch):
    client, factory, baseline, _ = api
    editor(client)
    reply = submit(client, {**body(baseline), **patch})
    assert reply.status_code == 422 and reply.json()["code"] == 1001, reply.text
    assert count(factory) == 0 and datasets.current() == baseline


def test_model_limits_and_resource_identity(api):
    client, factory, baseline, _ = api
    editor(client)
    payload = body(baseline)
    model = next(row for row in baseline["tables"]["device_model.csv"] if row["model_id"] == payload["model_id"])
    for freq in (float(model["freq_min_khz"]), float(model["freq_max_khz"])):
        candidate = {**payload, "values": {"tx_power_dbm": float(model["tx_power_max_dbm"]), "work_freq_khz": freq}}
        assert submit(client, candidate).status_code == 200
        payload["request_id"] += "x"
    for values in ({"tx_power_dbm": float(model["tx_power_max_dbm"]) + 0.001, "work_freq_khz": float(model["freq_min_khz"])},
            {"tx_power_dbm": -20, "work_freq_khz": float(model["freq_max_khz"]) + 1}):
        reply = submit(client, {**payload, "values": values})
        assert reply.status_code == 422 and reply.json()["code"] == 1001
    for patch, code in (({"model_id": "other-model"}, 1203), ({"device_id": "missing"}, 1002),
            ({"base_revision": "old"}, 1205)):
        reply = submit(client, {**payload, **patch})
        assert reply.json()["code"] == code
    assert count(factory) == 2


def test_real_identity_csrf_permissions_and_owner_scope(api, monkeypatch):
    client, factory, baseline, _ = api
    payload = body(baseline)
    assert client.get("/api/v1/device-configurations/history?context=ledger").json()["code"] == 1101
    assert submit(client, payload).json()["code"] == 1101
    editor(client, "integration-planner")
    assert submit(client, payload).json()["code"] == 1104
    editor(client)
    assert submit(client, payload, {"X-CSRF-Token": "bad"}).json()["code"] == 1105
    assert submit(client, payload, {"X-CSRF-Token": b"\xc3\xa9"}).json()["code"] == 1105
    old_headers = headers(client)
    editor(client)
    assert submit(client, payload, old_headers).json()["code"] == 1106
    assert submit(client, payload).status_code == 200
    editor(client, "integration-reviewer")
    assert submit(client, payload).json()["code"] == 1104
    assert detail(client, payload["request_id"]).status_code == 404
    assert client.get("/api/v1/device-configurations/history?context=ledger", headers=headers(client)).json()["data"]["total"] == 0
    assert client.get("/api/v1/device-configurations/history?context=ledger").json()["code"] == 1106
    supplied = headers(client)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert client.get("/api/v1/device-configurations/history?context=ledger", headers=supplied).json()["code"] == 1101
    assert count(factory) == 1


def test_version_change_and_off_shelf_preserve_previous_receipt(api):
    client, factory, baseline, _ = api
    editor(client)
    payload = body(baseline)
    accepted = submit(client, payload).json()["data"]
    revision = new_snapshot(factory, baseline, lambda snapshot: snapshot["tables"]["device.csv"][0].update(availability="OFF_SHELF"))
    assert submit(client, payload).json()["data"] == accepted
    assert detail(client, payload["request_id"]).json()["data"] == accepted
    fresh = {**payload, "request_id": "p06-new"}
    assert submit(client, fresh).json()["code"] == 1205
    assert submit(client, {**fresh, "base_revision": revision}).json()["code"] == 1203
    assert count(factory) == 1


def test_idempotency_content_actor_and_numeric_canonicalization(api):
    client, factory, baseline, _ = api
    actor = editor(client)
    payload = body(baseline)
    payload["values"]["tx_power_dbm"] = 0
    accepted = submit(client, payload).json()["data"]
    payload["values"]["tx_power_dbm"] = -0.0
    assert submit(client, payload).json()["data"] == accepted
    payload["values"]["tx_power_dbm"] = -1
    assert submit(client, payload).json()["code"] == 1206
    # 仅验证服务层跨操作者冲突，不向路由注入权限或伪造登录。
    with pytest.raises(service.ConfigurationError) as raised:
        service.submit_request(ConfigurationSubmission.model_validate(body(baseline)), {**actor, "account_id": "other-editor"})
    assert raised.value.code == 1206 and count(factory) == 1


@pytest.mark.parametrize("query", ["context=ledger&page=0", "context=ledger&page_size=101", "context=ledger&page=true",
    "context=ledger&page=1.5", "context=ledger&page=99999999999", "context=ledger&extra=x", "context=ledger&context=ledger", "context=gis", ""])
def test_history_query_rejects_unknown_duplicate_or_invalid(api, query):
    client, factory, _, _ = api
    editor(client)
    reply = client.get("/api/v1/device-configurations/history?" + query, headers=headers(client))
    assert reply.status_code == 422 and reply.json()["code"] == 1001
    assert count(factory) == 0


def test_history_pagination_is_read_only_and_reopen_durable(api, monkeypatch):
    client, factory, baseline, path = api
    editor(client)
    receipts = [submit(client, body(baseline, "p06-" + str(i))).json()["data"] for i in range(3)]
    page = client.get("/api/v1/device-configurations/history?context=ledger&page_size=2", headers=headers(client)).json()["data"]
    assert page["total"] == 3 and [item["request_id"] for item in page["items"]] == [r["request_id"] for r in reversed(receipts[1:])]
    assert "device_snapshot" not in page["items"][0] and page["items"][0]["data_origin"] == "SYNTHETIC_INTEGRATION"
    empty = client.get("/api/v1/device-configurations/history?context=ledger&page=3&page_size=2", headers=headers(client)).json()["data"]
    assert empty["items"] == [] and empty["total"] == 3
    assert client.get("/api/v1/device-configurations/history?context=ledger&device_id=missing", headers=headers(client)).json()["data"]["total"] == 0
    new_engine = create_engine("sqlite:///" + str(path))
    new_factory = sessionmaker(bind=new_engine, expire_on_commit=False)
    factory.kw["bind"].dispose()
    monkeypatch.setattr(service, "get_session_factory", lambda: new_factory)
    assert detail(client, "p06-0").json()["data"] == receipts[0]
    assert count(new_factory) == 3 and count(new_factory, ResourceDatasetVersion) == 1
    new_engine.dispose()


def test_same_request_concurrently_creates_one_record(api):
    client, factory, baseline, _ = api
    actor = editor(client)
    payload = ConfigurationSubmission.model_validate(body(baseline))
    with ThreadPoolExecutor(max_workers=4) as workers:
        receipts = list(workers.map(lambda _: service.submit_request(payload, actor), range(4)))
    assert all(receipt == receipts[0] for receipt in receipts) and count(factory) == 1


def test_resource_writer_commits_before_blocked_request_is_validated(api):
    client, factory, baseline, _ = api
    actor = editor(client)
    payload = ConfigurationSubmission.model_validate(body(baseline))
    begun = threading.Event()
    def accept():
        begun.set()
        return service.submit_request(payload, actor)
    with factory() as session:
        session.execute(text("BEGIN IMMEDIATE"))
        # 持有资源写事务，插入完整新版本并切换指针，等待受理方开始。
        snapshot = {key: deepcopy(baseline[key]) for key in ("schema_version", "tables", "source_files", "source_updated_at")}
        snapshot["tables"]["device.csv"][0]["availability"] = "OFF_SHELF"
        digest = datasets.content_hash(snapshot)
        revision = "resource-" + digest[:16]
        session.add(ResourceDatasetVersion(revision=revision, content_hash=digest, source=baseline["source"],
            data_origin=baseline["data_origin"], snapshot=snapshot, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = revision
        with ThreadPoolExecutor(max_workers=1) as workers:
            pending = workers.submit(accept)
            assert begun.wait(2)
            session.commit()
            with pytest.raises(service.ConfigurationError) as raised:
                pending.result(timeout=10)
            assert raised.value.code == 1205
    assert count(factory) == 0


def test_atomic_write_failure_and_orm_immutability(api):
    client, factory, baseline, _ = api
    editor(client)
    def fail(mapper, connection, target):
        raise OperationalError("controlled insertion failure", {}, RuntimeError("controlled"))
    event.listen(Record, "before_insert", fail)
    try:
        reply = submit(client, body(baseline))
        assert reply.status_code == 503 and reply.json()["code"] == 5002
        assert count(factory) == 0
    finally:
        event.remove(Record, "before_insert", fail)
    assert submit(client, body(baseline)).status_code == 200
    with factory() as session:
        row = session.get(Record, "p06-request-1")
        row.actor_id = "tampered"
        with pytest.raises(ValueError, match="不可修改"):
            session.flush()
        session.rollback()
    assert count(factory) == 1 and datasets.current() == baseline


@pytest.mark.parametrize("damage", ["source-hash", "model-number", "model-range", "receipt"])
def test_corruption_rejected_without_success_or_repair(api, damage):
    client, factory, baseline, _ = api
    editor(client)
    payload = body(baseline)
    if damage == "receipt":
        original = submit(client, payload).json()["data"]
        corrupted = {**original, "online": True}
        with factory.begin() as session:
            session.execute(update(Record).values(receipt=corrupted))
        reply = detail(client, payload["request_id"])
        assert reply.status_code == 503 and reply.json()["code"] == 5002
        assert submit(client, payload).json()["code"] == 5002
        return
    if damage == "source-hash":
        with factory.begin() as session:
            session.execute(update(ResourceDatasetVersion).values(content_hash="0" * 64))
    else:
        def mutate(snapshot):
            model = next(row for row in snapshot["tables"]["device_model.csv"] if row["model_id"] == payload["model_id"])
            model["freq_min_khz"] = "broken" if damage == "model-number" else str(float(model["freq_max_khz"]) + 1)
        payload["base_revision"] = new_snapshot(factory, baseline, mutate)
    reply = submit(client, payload)
    assert reply.status_code == 503 and reply.json()["code"] == 5002
    assert count(factory) == 0


def test_missing_module_tables_and_disabled_database_mode(api, tmp_path, monkeypatch):
    client, _, baseline, _ = api
    editor(client)
    empty_engine = create_engine("sqlite:///" + str(tmp_path / "new-unmigrated.sqlite"))
    monkeypatch.setattr(service, "get_session_factory", lambda: sessionmaker(bind=empty_engine))
    reply = submit(client, body(baseline))
    assert reply.status_code == 503 and reply.json()["code"] == 5003
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    assert submit(client, body(baseline)).json()["code"] == 5003
    empty_engine.dispose()


def test_invalid_json_and_non_object_envelopes(api):
    client, factory, _, _ = api
    editor(client)
    for content in ("{", "[]", "null", "true"):
        reply = client.post("/api/v1/device-configurations", content=content,
            headers={**headers(client), "Content-Type": "application/json"})
        assert reply.status_code == 422 and reply.json()["code"] == 1001
    assert count(factory) == 0
