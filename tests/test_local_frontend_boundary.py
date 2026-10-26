"""LOCAL前置边界矩阵；不导入main，不执行算法或连接运行库。"""
from pathlib import Path
import secrets
import sys
from types import SimpleNamespace
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import local_frontend_boundary as boundary
from app.application_identity import install_local_identity
from app.database import Base
from app.local_identity_models import IDENTITY_TABLES
from app.local_identity_schemas import LocalIdentitySettings
from app.system_management_models import SYSTEM_TABLES, LocalAccount, LocalRole
from app.system_management_schemas import ADMIN_PERMISSIONS, SystemActor, SystemManagementError


class Adapter:
    def __init__(self, permissions=(), error=None):
        self.permissions, self.error, self.calls = list(permissions), error, []

    def require(self, request, *, writing=False):
        self.calls.append((request.method, writing))
        if self.error is not None:
            raise self.error
        return {"permissions": self.permissions}


def request(path, method="GET", adapter=None, *, query=(), headers=()):
    app = SimpleNamespace(state=SimpleNamespace(local_identity_adapter=adapter))
    return Request({"type": "http", "http_version": "1.1", "scheme": "https", "method": method,
        "path": path, "raw_path": path.encode("utf8"), "query_string": urlencode(query).encode("ascii"),
        "headers": headers, "app": app, "server": ("boundary.example", 443), "client": ("127.0.0.15", 59001)})


MATRIX = [
    ("/task-inputs", "GET", ("planning.view",)),
    ("/task-inputs/TASK-one", "GET", ("planning.view",)),
    ("/task-inputs/TASK-one", "PUT", ("planning.view", "planning.execute")),
    ("/task-inputs/validate", "POST", ("planning.view", "planning.execute")),
    ("/planning", "GET", ("planning.view",)),
    ("/planning/submit", "POST", ("planning.view", "planning.execute")),
    ("/plan/jobs", "GET", ("planning.view",)),
    ("/plan/tasks/JOB-one", "GET", ("planning.view",)),
    ("/plan/sr4-flow", "POST", ("planning.view", "planning.execute")),
    ("/plan/candidate-sites", "POST", ("planning.view", "planning.execute")),
    ("/plan/deployment", "POST", ("planning.view", "planning.execute")),
    ("/plan/coverage", "POST", ("planning.view", "planning.execute")),
    ("/plan/route", "POST", ("planning.view", "planning.execute")),
    ("/plan/frequency", "POST", ("planning.view", "planning.execute")),
    ("/plan/radio-params", "POST", ("planning.view", "planning.execute")),
    ("/plan/check", "POST", ("planning.view", "planning.execute")),
    ("/plan/network-optimize", "POST", ("planning.view", "planning.execute")),
    ("/task/JOB-one", "GET", ("planning.view",)),
    ("/tasks/JOB-one", "DELETE", ("planning.view", "planning.execute")),
    ("/jobs", "GET", ("planning.view",)),
    ("/jobs/JOB-one", "PATCH", ("planning.view", "planning.execute")),
    ("/planning-operations/OP-one", "GET", ("planning.view",)),
    ("/plans", "POST", ("planning.view", "planning.save")),
    ("/plans/PLAN-one", "PUT", ("planning.view", "planning.save")),
    ("/plans", "GET", ("planning.view",)),
    ("/plans/PLAN-one", "GET", ("planning.view",)),
    ("/plans/compare", "POST", ("planning.view",)),
    ("/plans/PLAN-one/confirm", "POST", ("planning.view", "planning.confirm")),
    ("/plans/PLAN-one/export", "GET", ("planning.view",)),
    ("/resource/context", "GET", ("planning.view",)),
    ("/resource/map", "GET", ("planning.view",)),
    ("/resource/nodes", "GET", ("planning.view",)),
    ("/resource/nodes/NODE-one", "GET", ("planning.view",)),
    ("/resource/devices", "GET", ("planning.view",)),
    ("/resource/devices/DEVICE-one", "GET", ("planning.view",)),
    ("/resource/interference-sources", "GET", ("planning.view",)),
    ("/resource/device-models", "GET", ("planning.view",)),
    ("/resource/antenna-models", "GET", ("planning.view",)),
    ("/resource/frequency-pool", "GET", ("planning.view",)),
    ("/resource/param-presets", "GET", ("planning.view",)),
    ("/resource/gis-directory", "GET", ("situation.view",)),
    ("/resource/gis-scene", "GET", ("situation.view",)),
    ("/resource/frequency-resources", "GET", ("resources.view",)),
    ("/resource/import/commit", "POST", ("resources.view",)),
    ("/resource/export", "POST", ("resources.view",)),
    ("/resource/changes", "POST", ("resources.view",)),
    ("/resource/workspace/changes", "POST", ("resources.view",)),
    ("/fault/tasks/RUN-one", "GET", ("diagnosis.view",)),
    ("/fault/impact/RUN-one/export", "GET", ("diagnosis.view", "diagnosis.export")),
    ("/fault/workbench/export/RUN-one", "GET", ("diagnosis.view", "diagnosis.export")),
    ("/kg/stats", "GET", ("knowledge.view",)),
    ("/kg/versions/V-one/snapshot", "GET", ("knowledge.view",)),
    ("/files/report.pdf", "GET", ("diagnosis.view", "diagnosis.export")),
]


@pytest.mark.parametrize("path,method,permissions", MATRIX)
def test_matrix_requires_each_permission_and_its_view_dependency(path, method, permissions):
    adapter = Adapter(permissions)
    assert boundary.authorize_local_request(request("/api/v1" + path, method, adapter)) is None
    assert adapter.calls == [(method, method != "GET")]
    for missing in permissions:
        without = Adapter(code for code in permissions if code != missing)
        with pytest.raises(SystemManagementError) as error:
            boundary.authorize_local_request(request("/api/v1" + path, method, without))
        assert (error.value.code, error.value.status) == (1104, 403)


@pytest.mark.parametrize("context,permission", [("ledger", "resources.view"), ("gis", "situation.view"), ("planning", "planning.view")])
@pytest.mark.parametrize("path", ["/resource/context", "/resource/map", "/resource/devices/DEVICE-one", "/resource/device-models", "/resource/export"])
def test_explicit_resource_context_never_falls_back_to_another_module(path, context, permission):
    boundary.authorize_local_request(request("/api/v1" + path, adapter=Adapter([permission]), query=[("context", context)]))
    other = Adapter([p for p in ("resources.view", "situation.view", "planning.view") if p != permission])
    with pytest.raises(SystemManagementError) as error:
        boundary.authorize_local_request(request("/api/v1" + path, adapter=other, query=[("context", context)]))
    assert error.value.code == 1104


@pytest.mark.parametrize("query", [[("context", "")], [("context", "invalid")], [("context", " ledger")],
    [("context", "ledger"), ("context", "gis")], [("context", "gis"), ("context", "gis")]])
def test_ambiguous_resource_context_is_rejected_after_authentication(query):
    adapter = Adapter(["resources.view", "planning.view", "situation.view"])
    with pytest.raises(SystemManagementError) as error:
        boundary.authorize_local_request(request("/api/v1/resource/context", adapter=adapter, query=query))
    assert (error.value.code, error.value.status) == (1001, 422)
    assert len(adapter.calls) == 1


@pytest.mark.parametrize("path", ["/integration/sr4", "/integration/sr4/catalog", "/integration/sr4/runs", "/legacy", "/legacy/interference/analyze", "/interference/analyze", "/interference/adopt/", "/interference/adopt/id"])
@pytest.mark.parametrize("method", ["GET", "POST", "DELETE"])
def test_legacy_entrypoints_are_denied_even_to_all_permissions(path, method):
    adapter = Adapter(row["code"] for row in boundary.SERVER_PERMISSION_REGISTRY)
    with pytest.raises(SystemManagementError) as error:
        boundary.authorize_local_request(request("/api/v1" + path, method, adapter))
    assert (error.value.code, error.value.status) == (1104, 403)
    assert adapter.calls == [(method, method != "GET")]


@pytest.mark.parametrize("path", ["/fault/scenarios", "/fault/diagnose", "/fault/impact", "/fault/not-workbench/actions", "/kg/query", "/kg/changes", "/kg/versions/V-one/rollback", "/kg/workbench-copy/actions", "/fault/workbench-copy/actions"])
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
def test_nonworkbench_fault_and_knowledge_writes_are_always_denied(path, method):
    with pytest.raises(SystemManagementError) as error:
        boundary.authorize_local_request(request("/api/v1" + path, method, Adapter(row["code"] for row in boundary.SERVER_PERMISSION_REGISTRY)))
    assert error.value.code == 1104


@pytest.mark.parametrize("path", ["/fault/workbench/actions/submit", "/kg/workbench/actions/publish", "/interference/scenes/SCENE-one/versions", "/system/accounts", "/device-status/import", "/unregistered", "/authentication", ""])
@pytest.mark.parametrize("method", ["GET", "POST", "HEAD", "OPTIONS", "CUSTOM"])
def test_specialized_and_unknown_routes_still_authenticate_without_implicit_grants(path, method):
    adapter = Adapter()
    boundary.authorize_local_request(request("/api/v1" + path, method, adapter, headers=[(b"x-role", b"planner")]))
    assert adapter.calls == [(method, method != "GET")]
    assert adapter.permissions == []


@pytest.mark.parametrize("path", ["/api/v1/auth", "/api/v1/auth/csrf", "/api/v1/auth/login/", "/api/v1/auth/password", "/api/v10/plans", "/health", "/"])
def test_auth_and_non_api_paths_remain_with_their_own_handlers(path):
    adapter = Adapter(error=AssertionError("Exempt handler must not use boundary adapter"))
    boundary.authorize_local_request(request(path, "POST", adapter))
    assert adapter.calls == []


@pytest.mark.parametrize("mode", ["OFF", "INTEGRATION"])
def test_no_local_adapter_preserves_legacy_mode_tests_and_does_not_open_database(monkeypatch, mode):
    monkeypatch.setenv("AUTH_MODE", mode)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1" if mode == "INTEGRATION" else "0")
    from app import database
    monkeypatch.setattr(database, "get_session_factory", lambda: pytest.fail("Boundary must not open database"))
    for path, method in (("/api/v1/legacy/interference/analyze", "POST"), ("/api/v1/fault/scenarios", "DELETE"), ("/api/v1/resource/context", "GET")):
        assert boundary.authorize_local_request(request(path, method)) is None


@pytest.mark.parametrize("error", [SystemManagementError("匿名", 1101, 401), SystemManagementError("CSRF拒绝", 1105, 403), SystemManagementError("会话变化", 1106, 409), SQLAlchemyError("database unavailable")])
def test_authentication_and_database_errors_propagate_without_fallback(error):
    with pytest.raises(type(error)) as caught:
        boundary.authorize_local_request(request("/api/v1/integration/sr4/runs", "POST", Adapter(error=error)))
    assert caught.value is error


def test_invalid_principal_and_missing_registry_dependency_fail_closed(monkeypatch):
    adapter = Adapter()
    adapter.permissions = "planning.view"
    with pytest.raises(SystemManagementError) as principal:
        boundary.authorize_local_request(request("/api/v1/plans", adapter=adapter))
    assert principal.value.code == 5001
    monkeypatch.setitem(boundary._REGISTRY, "planning.execute", ("not.registered",))
    with pytest.raises(SystemManagementError) as registry:
        boundary.authorize_local_request(request("/api/v1/plan/sr4-flow", "POST", Adapter(["planning.execute", "planning.view", "not.registered"])))
    assert registry.value.code == 5001


def test_real_local_adapter_rejects_anonymous_csrf_and_insufficient_permission(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO", raising=False)
    path = tmp_path / "explicit-boundary.sqlite"
    assert not path.exists()
    engine = create_engine("sqlite:///" + path.as_posix(), connect_args={"check_same_thread": False})
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    Base.metadata.create_all(engine, tables=SYSTEM_TABLES + IDENTITY_TABLES)
    app, hits = FastAPI(), []
    origin = "https://boundary.example"
    try:
        install_local_identity(app, session_factory=factory, settings=LocalIdentitySettings(allowed_origins=frozenset((origin,))), request_key=secrets.token_bytes(32))
        with factory() as session:
            assert session.scalar(select(func.count()).select_from(LocalAccount)) == 0
        system = app.state.system_management
        password = secrets.token_urlsafe(24)
        account_id = system.initialize(username="boundary.operator", password=password, name="显式隔离主体", department="边界测试")
        with factory() as session:
            account = session.get(LocalAccount, account_id)
            role = session.get(LocalRole, account.role_id)
            role_id, role_name = role.id, role.name
            actor = SystemActor(account.id, "explicit-test-actor", str(account.identity_revision), ADMIN_PERMISSIONS)
        system.execute("role.update", actor, {"baseRevision": system.read("options", actor)["revision"], "requestId": "boundary-test-role",
            "role": {"name": role_name, "description": "保留系统管理，仅追加规划只读", "permissions": sorted(ADMIN_PERMISSIONS | {"planning.view"})}}, object_id=role_id)

        @app.middleware("http")
        async def check_boundary(incoming, call_next):
            try:
                boundary.authorize_local_request(incoming)
            except SystemManagementError as error:
                return JSONResponse({"code": error.code, "message": str(error), "data": error.data}, status_code=error.status)
            return await call_next(incoming)

        @app.api_route("/api/v1/{remaining:path}", methods=["GET", "POST"])
        def protected(remaining: str, incoming: Request):
            hits.append((remaining, incoming.method))
            return {"code": 0}

        with TestClient(app, base_url=origin) as client:
            client.cookies.set("radio_integration_session", "untrusted-test-token")
            anonymous = client.get("/api/v1/task-inputs")
            assert anonymous.status_code == 401
            assert anonymous.json()["code"] == 1101
            assert hits == []
            challenge = client.get("/api/v1/auth/csrf").json()["data"]
            logged_in = client.post("/api/v1/auth/login", json={"username": "boundary.operator", "password": password}, headers={"Origin": origin, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
            assert logged_in.status_code == 200
            assert logged_in.json()["data"]["integration_mode"] is False
            assert logged_in.json()["data"]["data_origin"] == "FORMAL_VERIFIED"
            assert client.get("/api/v1/task-inputs").status_code == 200
            assert client.post("/api/v1/unregistered").json()["code"] == 1105
            challenge = client.get("/api/v1/auth/csrf").json()["data"]
            headers = {"Origin": origin, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": challenge["session_id"]}
            assert client.post("/api/v1/task-inputs/validate", json={}, headers=headers).json()["code"] == 1104
            assert client.get("/api/v1/files/report.pdf").json()["code"] == 1104
            assert client.get("/api/v1/legacy/interference/analyze").json()["code"] == 1104
            assert client.post("/api/v1/unregistered", headers=headers).status_code == 200
            assert hits == [("task-inputs", "GET"), ("unregistered", "POST")]
            assert client.post("/api/v1/auth/logout", json={}, headers=headers).status_code == 200
            assert client.get("/api/v1/task-inputs").status_code == 401
    finally:
        engine.dispose()
