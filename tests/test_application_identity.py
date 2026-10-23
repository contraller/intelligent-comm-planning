"""安装工厂的隔离矩阵；不导入main、不连接运行库、不启动监听。"""
import base64
import json
from pathlib import Path
import secrets
import sys

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, inspect, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import application_identity as module
from app.application_identity import install_local_identity
from app.database import Base
from app.local_identity_models import IDENTITY_TABLES
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import LocalIdentityAdapter
from app.permission_registry import SERVER_PERMISSION_REGISTRY
from app.system_management_models import SYSTEM_TABLES, LocalAccount, LocalCredential, LocalRole, SystemState
from app.system_management_schemas import ADMIN_PERMISSIONS, SystemManagementError

ORIGIN = "https://identity.example"
ENVIRONMENT = ("AUTH_MODE", "FRONTEND_INTEGRATION_DEMO", "LOCAL_IDENTITY_REQUEST_KEY", "LOCAL_IDENTITY_ALLOWED_ORIGINS", "LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK")


@pytest.fixture(autouse=True)
def clean_identity_environment(monkeypatch):
    for key in ENVIRONMENT:
        monkeypatch.delenv(key, raising=False)


def local_environment(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.setenv("LOCAL_IDENTITY_REQUEST_KEY", base64.b64encode(secrets.token_bytes(32)).decode("ascii"))
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOWED_ORIGINS", json.dumps([ORIGIN]))


def no_database(*args, **kwargs):
    raise AssertionError("Factory must not access database/configuration in this branch")


@pytest.mark.parametrize("mode,demo,expected", [
    (None, None, "OFF"), (None, "0", "OFF"), (None, "true", "OFF"),
    (None, "1", "INTEGRATION"), ("OFF", None, "OFF"), ("OFF", "1", "OFF"),
    ("INTEGRATION", "1", "INTEGRATION"),
])
def test_nonlocal_modes_do_not_read_key_settings_or_database(monkeypatch, mode, demo, expected):
    if mode is not None:
        monkeypatch.setenv("AUTH_MODE", mode)
    if demo is not None:
        monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", demo)
    monkeypatch.setattr(module, "_settings", no_database)
    monkeypatch.setattr(module, "_key", no_database)
    from app import database
    monkeypatch.setattr(database, "get_session_factory", no_database)
    app = FastAPI()
    count = len(app.routes)
    assert install_local_identity(app, session_factory=no_database, settings=object(), request_key=object()) is None
    assert app.state.auth_mode == expected
    assert len(app.routes) == count
    assert not hasattr(app.state, "local_identity_adapter")
    assert not hasattr(app.state, "system_management")


@pytest.mark.parametrize("mode,demo", [("LOCAL_PASSWORD", "1"), ("INTEGRATION", None), ("INTEGRATION", "0"), ("local_password", None), ("LOCAL", None), ("", None), (" LOCAL_PASSWORD", None)])
def test_mode_conflicts_fail_before_local_configuration(monkeypatch, mode, demo):
    monkeypatch.setenv("AUTH_MODE", mode)
    if demo is not None:
        monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", demo)
    monkeypatch.setattr(module, "_settings", no_database)
    with pytest.raises(SystemManagementError) as error:
        install_local_identity(FastAPI())
    assert error.value.status == 503 and error.value.code == 5001
    assert error.value.data == {"reason": "IDENTITY_CONFIGURATION"}


@pytest.mark.parametrize("encoded", [None, "", "not-base64-do-not-echo", "秘密不可回显", "A" * 43, base64.b64encode(b"x" * 31).decode(), base64.b64encode(b"x" * 32).decode() + "=", base64.b64encode(b"x" * 32).decode() + "\n"], ids=["missing", "empty", "invalid", "unicode", "padding", "short", "extra-padding", "newline"])
def test_invalid_key_is_redacted_and_rejected_before_database(monkeypatch, encoded):
    local_environment(monkeypatch)
    if encoded is None:
        monkeypatch.delenv("LOCAL_IDENTITY_REQUEST_KEY")
    else:
        monkeypatch.setenv("LOCAL_IDENTITY_REQUEST_KEY", encoded)
    from app import database
    monkeypatch.setattr(database, "get_session_factory", no_database)
    with pytest.raises(SystemManagementError) as error:
        install_local_identity(FastAPI())
    assert "LOCAL_IDENTITY_REQUEST_KEY" in str(error.value)
    if encoded:
        assert encoded not in str(error.value)
    assert error.value.__suppress_context__


@pytest.mark.parametrize("value", [None, "", "not-json", "null", "{}", '"https://identity.example"', "[]", "[null]", "[true]", '["https://identity.example","https://identity.example"]'], ids=["missing", "empty", "invalid-json", "null", "object", "string", "empty-list", "null-item", "boolean-item", "duplicates"])
def test_invalid_origin_document_is_rejected_before_database(monkeypatch, value):
    local_environment(monkeypatch)
    if value is None:
        monkeypatch.delenv("LOCAL_IDENTITY_ALLOWED_ORIGINS")
    else:
        monkeypatch.setenv("LOCAL_IDENTITY_ALLOWED_ORIGINS", value)
    from app import database
    monkeypatch.setattr(database, "get_session_factory", no_database)
    with pytest.raises(SystemManagementError) as error:
        install_local_identity(FastAPI())
    assert "LOCAL_IDENTITY_ALLOWED_ORIGINS" in str(error.value)
    if value:
        assert value not in str(error.value)


@pytest.mark.parametrize("origin", ["https://identity.example/", "https://IDENTITY.example", "HTTPS://identity.example", "https://identity.example:443", "https://identity.example:", "https://identity.example:0", "https://identity.example:65536", "https://identity.example?", "https://identity.example#", "https://user:do-not-echo@identity.example", "https://identity.example/path", "https://identity.example\\evil", "https://identity.example\n", "https://例子.测试", "https://127.000.0.1", "https://127.1", "https://0x7f.1", "https://[::01]", "https://[::1%scope]", "http://127.0.0.15:8115", "http://192.0.2.10", "file:///identity", "null", "//identity.example"], ids=lambda value: "origin-" + str(len(value)) + "-" + str(sum(map(ord, value))))
def test_noncanonical_or_insecure_origins_fail_closed(monkeypatch, origin):
    local_environment(monkeypatch)
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOWED_ORIGINS", json.dumps([origin]))
    with pytest.raises(SystemManagementError) as error:
        install_local_identity(FastAPI(), session_factory=no_database)
    assert "LOCAL_IDENTITY_ALLOWED_ORIGINS" in str(error.value)
    assert origin not in str(error.value)


@pytest.mark.parametrize("flag", ["true", "false", "", " 1", "2"])
def test_loopback_flag_requires_explicit_configuration(monkeypatch, flag):
    local_environment(monkeypatch)
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK", flag)
    with pytest.raises(SystemManagementError) as error:
        install_local_identity(FastAPI(), session_factory=no_database)
    assert "LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK" in str(error.value)


@pytest.mark.parametrize("origin", ["https://identity.example", "https://identity.example:8443", "https://127.0.0.15", "https://[::1]", "http://127.0.0.15:8115", "http://[::1]:8115"])
def test_valid_canonical_origins_and_explicit_loopback_do_not_access_database(monkeypatch, origin):
    local_environment(monkeypatch)
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOWED_ORIGINS", json.dumps([origin]))
    if origin.startswith("http:"):
        monkeypatch.setenv("LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK", "1")
    app = FastAPI()
    adapter = install_local_identity(app, session_factory=no_database)
    assert isinstance(adapter, LocalIdentityAdapter)
    assert adapter.delegate is adapter
    assert app.state.local_identity_adapter is adapter
    assert app.state.system_management is adapter.service.system
    assert app.state.auth_mode == "LOCAL_PASSWORD"
    assert adapter.service.settings.allowed_origins == frozenset((origin,))


@pytest.mark.parametrize("origin", ["http://192.0.2.10", "http://localhost", "http://identity.example"])
def test_loopback_exception_never_enables_other_plain_http(monkeypatch, origin):
    local_environment(monkeypatch)
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK", "1")
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOWED_ORIGINS", json.dumps([origin]))
    with pytest.raises(SystemManagementError):
        install_local_identity(FastAPI(), session_factory=no_database)


def test_explicit_test_parameters_do_not_read_environment_secrets(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.setenv("LOCAL_IDENTITY_REQUEST_KEY", "invalid-not-used")
    monkeypatch.setenv("LOCAL_IDENTITY_ALLOWED_ORIGINS", "invalid-not-used")
    settings = LocalIdentitySettings(allowed_origins=frozenset((ORIGIN,)))
    assert install_local_identity(FastAPI(), session_factory=no_database, settings=settings, request_key=secrets.token_bytes(48)) is not None


def test_duplicate_installation_and_existing_auth_routes_are_rejected(monkeypatch):
    local_environment(monkeypatch)
    app = FastAPI()
    install_local_identity(app, session_factory=no_database)
    count = len(app.routes)
    with pytest.raises(SystemManagementError):
        install_local_identity(app, session_factory=no_database)
    assert len(app.routes) == count
    conflicting = FastAPI()
    @conflicting.get("/api/v1/auth/session")
    def earlier_auth():
        return {"unexpected": "must-not-take-precedence"}
    count = len(conflicting.routes)
    with pytest.raises(SystemManagementError):
        install_local_identity(conflicting, session_factory=no_database)
    assert len(conflicting.routes) == count
    assert not hasattr(conflicting.state, "local_identity_adapter")


def test_installer_never_connects_or_creates_tables(monkeypatch, tmp_path):
    local_environment(monkeypatch)
    engine = create_engine("sqlite:///" + (tmp_path / "unmigrated.sqlite").as_posix())
    connections = []
    @event.listens_for(engine, "connect")
    def connected(*args):
        connections.append(True)
    install_local_identity(FastAPI(), session_factory=sessionmaker(bind=engine))
    assert connections == []
    assert inspect(engine).get_table_names() == []
    engine.dispose()


def test_local_router_precedes_later_legacy_decorators_and_no_default_user(monkeypatch, tmp_path):
    local_environment(monkeypatch)
    engine = create_engine("sqlite:///" + (tmp_path / "migrated.sqlite").as_posix())
    Base.metadata.create_all(engine, tables=SYSTEM_TABLES + IDENTITY_TABLES)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    app = FastAPI()
    adapter = install_local_identity(app, session_factory=factory)
    @app.get("/api/v1/auth/session")
    def later_legacy_auth():
        return {"code": 0, "message": "wrong", "data": {"account_id": "integration-planner"}}
    @app.exception_handler(SystemManagementError)
    async def identity_error(request, error):
        return JSONResponse(status_code=error.status, content={"code": error.code, "message": str(error), "data": error.data})
    @app.get("/probe/current")
    def current(request: Request):
        return request.app.state.local_identity_adapter.delegate.current(request)
    @app.get("/probe/require")
    def require(request: Request):
        return request.app.state.local_identity_adapter.delegate.require(request, "system.view")
    with TestClient(app, base_url=ORIGIN) as client:
        client.cookies.set("radio_integration_session", "never-a-local-principal")
        assert client.get("/api/v1/auth/session").json()["data"] is None
        assert client.get("/probe/current").json() is None
        assert client.get("/probe/require").status_code == 401
        assert client.get("/api/v1/auth/capabilities").json()["data"]["initialized"] is False
        with factory() as session:
            for model in (LocalAccount, LocalCredential, LocalRole, SystemState):
                assert session.scalar(select(func.count()).select_from(model)) == 0
        password = secrets.token_urlsafe(24)
        account_id = app.state.system_management.initialize(username="explicit", password=password, name="显式隔离测试主体", department="测试")
        challenge = client.get("/api/v1/auth/csrf").json()["data"]
        logged = client.post("/api/v1/auth/login", json={"username": "explicit", "password": password}, headers={"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
        assert logged.status_code == 200
        principal = client.get("/probe/current").json()
        assert principal["account_id"] == account_id
        assert principal["data_origin"] == "FORMAL_VERIFIED" and principal["integration_mode"] is False
        assert set(principal["permissions"]) == ADMIN_PERMISSIONS
        assert client.get("/probe/require").json() == principal
        assert client.get("/api/v1/system/options").status_code == 200
        assert password not in json.dumps(principal)
    engine.dispose()


def test_server_registry_is_complete_and_does_not_grant_roles():
    entries = {item["code"]: item for item in SERVER_PERMISSION_REGISTRY}
    assert len(entries) == len(SERVER_PERMISSION_REGISTRY) == 36
    assert {"resources.frequency.maintain", "resources.spectrum.edit", "resources.device.status.import", "situation.observation.import"} <= entries.keys()
    for code, item in entries.items():
        assert set(item) == {"code", "name", "group", "requires"}
        assert item["name"] and item["group"] and type(item["requires"]) is list
        module = code.split(".", 1)[0]
        expected = [] if code == module + ".view" else [module + ".view"]
        if code in ("knowledge.publish", "knowledge.rollback", "knowledge.reset"):
            expected.append("knowledge.review")
        assert item["requires"] == expected
        assert set(item["requires"]) <= entries.keys()
