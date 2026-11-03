"""新建隔离SQLite上的真实本地统一会话/知识工作流及密码模式兼容。"""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
sys.path.insert(0, str(ROOT / "scripts"))
from app import database, kg, kg_frontend_service, kg_workflow_service
from app.application_identity import install_local_identity
from app.database import Base
from app.local_identity_models import LocalIdentitySession
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import SESSION_COOKIE
from app.local_single_user_service import SINGLE_ACCOUNT_ID, SINGLE_ROLE_ID
from app.main import knowledge_workbench, knowledge_workbench_action, knowledge_workbench_browse
from app.permission_registry import SERVER_PERMISSION_REGISTRY
from app.system_management_models import LocalAccount, LocalCredential, LocalRole, SystemAuditEvent
from app.system_management_service import SystemManagementService
from diagnosis import sr6
from diagnosis.kg_store import KnowledgeGraph
from diagnosis.link_state_kg import LinkStateKnowledge

ORIGIN = "http://127.0.0.1:18598"
EVIDENCE = ROOT / "data/runtime/gis-stable-rework-20261103"


class IsolatedEnvironment(SimpleNamespace):
    def __repr__(self):
        return "<IsolatedLocalSingleUserEnvironment>"


@pytest.fixture
def environment(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + (tmp_path / "single-user.sqlite").as_posix())
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    key, password = secrets.token_bytes(32), secrets.token_urlsafe(24)
    original = SystemManagementService(session_factory=factory, permission_registry=SERVER_PERMISSION_REGISTRY, request_key=key)
    account_id = original.initialize(username="original_operator", password=password, name="原账号", department="隔离测试")
    for module in (database, kg_frontend_service, kg_workflow_service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "absent-legacy.json")

    def small_graph():
        graph = KnowledgeGraph("constructed-single-user-api")
        graph.add_triple(("DeviceModel", "DM-LOCAL"), "hasFunction", ("Function", "基线功能"),
                         source="隔离构造会话工作流测试", graph="device")
        graph.freeze("构造基线")
        return graph, LinkStateKnowledge()
    monkeypatch.setattr(sr6, "build_graph", small_graph)
    monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO", raising=False)

    def make_app(mode="LOCAL_SINGLE_USER", origin=ORIGIN):
        monkeypatch.setenv("AUTH_MODE", mode)
        app = FastAPI()
        adapter = install_local_identity(app, session_factory=factory,
            settings=LocalIdentitySettings(frozenset((origin,)), allow_insecure_loopback=True), request_key=key)
        app.add_api_route("/api/v1/kg/workbench", knowledge_workbench, methods=["GET"])
        app.add_api_route("/api/v1/kg/workbench/actions/{action}", knowledge_workbench_action, methods=["POST"])
        app.add_api_route("/api/v1/kg/workbench/browse/{kind}", knowledge_workbench_browse, methods=["GET"])
        return app, adapter
    app, adapter = make_app()
    with TestClient(app, base_url=ORIGIN, client=("127.0.0.1", 50000)) as client:
        yield IsolatedEnvironment(app=app, adapter=adapter, factory=factory, client=client, make_app=make_app,
                              account_id=account_id, original_password=password)
    engine.dispose()


def session(client):
    response = client.get("/api/v1/auth/session")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def headers(client, origin=ORIGIN):
    data = client.get("/api/v1/auth/csrf").json()["data"]
    return {"Origin": origin, "X-CSRF-Token": data["csrf_token"], "X-Session-Id": data["session_id"]}


def change(client, action, body, origin=ORIGIN):
    who = session(client)
    state = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]
    return client.post("/api/v1/kg/workbench/actions/" + action, headers=headers(client, origin), json={
        "actorId": who["account_id"], "requestId": "test-" + secrets.token_hex(8),
        "baseRevision": state["revision"], **body})


def draft(client):
    data = client.get("/api/v1/kg/workbench").json()["data"]
    version = data["workspace"]["currentVersionId"]
    return {"baseVersionId": version, "summary": "同身份全流程构造验证", "relations": [], "entities": [{
        "id": "E-LOCAL-NEW", "name": "本机新增功能", "type": "Function", "category": "设备知识",
        "description": "会话与审核流程验证", "source": "隔离构造数据，非现场实测", "keywords": [],
        "attributes": [], "modelIds": []}]}


def test_automatic_cookie_session_full_permissions_audit_and_existing_accounts_unchanged(environment):
    e = environment
    with e.factory() as store:
        account_before = deepcopy(dict(store.get(LocalAccount, e.account_id).__dict__))
        credential_before = deepcopy(dict(store.get(LocalCredential, e.account_id).__dict__))
    first = session(e.client)
    assert first["account_id"] == SINGLE_ACCOUNT_ID
    assert first["auth_source"] == "LOCAL_SINGLE_USER" and first["single_user_mode"] is True and first["allow_self_review"] is True
    assert set(first["permissions"]) == {row["code"] for row in SERVER_PERMISSION_REGISTRY}
    assert first["integration_mode"] is False and first["data_origin"] == "FORMAL_VERIFIED"
    assert e.client.cookies.get(SESSION_COOKIE) != first["session_id"]
    assert session(e.client) == first
    for path in ("accounts", "roles", "parameters", "logs"):
        assert e.client.get("/api/v1/system/" + path).status_code == 200
    with e.factory() as store:
        for model, before in ((LocalAccount, account_before), (LocalCredential, credential_before)):
            after = dict(store.get(model, e.account_id).__dict__)
            assert {k: v for k, v in after.items() if not k.startswith("_")} == {k: v for k, v in before.items() if not k.startswith("_")}
        assert len(store.scalars(select(LocalIdentitySession)).all()) == 1
    logs = e.client.get("/api/v1/system/logs").json()["data"]["items"]
    assert any(row["action"] == "auth.local_session" and row["authSource"] == "LOCAL_SINGLE_USER" for row in logs)
    assert e.client.get("/api/v1/auth/capabilities").json()["data"]["capabilities"]["selfReview"] is True


@pytest.mark.parametrize("bad", [{"Origin": "http://evil.invalid"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Host": "evil.invalid"}])
def test_bootstrap_rejects_untrusted_origin_site_and_host(environment, bad):
    assert environment.client.get("/api/v1/auth/session", headers=bad).status_code == 403


def test_bootstrap_rejects_nonloopback_peer(environment):
    with TestClient(environment.app, base_url=ORIGIN, client=("192.0.2.15", 50100)) as remote:
        assert remote.get("/api/v1/auth/session").status_code == 403


def test_csrf_session_origin_and_managed_identity_protection(environment):
    e = environment
    session(e.client)
    current = e.client.get("/api/v1/system/options").json()["data"]["revision"]
    body = {"baseRevision": current, "requestId": "bad-write", "value": 41}
    good = headers(e.client)
    for changed in ({"X-CSRF-Token": "bad"}, {"X-Session-Id": "different"}, {"Origin": "http://evil.invalid"}):
        assert e.client.put("/api/v1/system/parameters/PAR-01", json=body, headers={**good, **changed}).status_code in (403, 409)
    assert e.client.put("/api/v1/system/parameters/PAR-01", json=body, headers=good).status_code == 200
    revision = e.client.get("/api/v1/system/options").json()["data"]["revision"]
    assert e.client.post("/api/v1/system/accounts/" + SINGLE_ACCOUNT_ID + "/state", headers=good,
                         json={"baseRevision": revision, "requestId": "protect", "enabled": False}).status_code == 403
    assert e.client.post("/api/v1/auth/login", headers=good, json={"username": "original_operator", "password": "ignored"}).status_code == 403
    assert e.client.post("/api/v1/auth/password", headers=good, json={}).status_code == 403


def exercise_workflow(client, origin):
    first = session(client)
    before = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]["currentVersionId"]
    saved = change(client, "save", {"draft": draft(client)}, origin)
    assert saved.status_code == 200, saved.text
    row = saved.json()["data"]["change"]
    common = {"changeId": row["id"], "revision": row["revision"]}
    for action, extra, state in (("submit", {}, "PENDING"), ("review", {"submission": 1, "approved": True, "opinion": "本机同身份确认"}, "APPROVED"), ("publish", {}, "PUBLISHED")):
        result = change(client, action, {**common, **extra}, origin)
        assert result.status_code == 200, result.text
        assert result.json()["data"]["change"]["state"] == state
        assert session(client)["account_id"] == first["account_id"]
        if action != "publish":
            assert result.json()["data"]["currentVersionId"] == before
    current = result.json()["data"]["currentVersionId"]
    assert current != before
    found = client.get("/api/v1/kg/workbench/browse/search", params={"versionId": current, "categories": "设备知识", "q": "本机新增功能", "pageNum": 1, "pageSize": 20})
    assert found.status_code == 200 and any(r["name"] == "本机新增功能" for r in found.json()["data"]["items"])
    return {"sameIdentity": True, "phases": ["SAVE", "SUBMIT", "REVIEW", "PUBLISH", "SEARCH"], "publishedVersion": current}


def test_single_identity_knowledge_edit_review_publish(environment):
    exercise_workflow(environment.client, ORIGIN)


def test_single_mode_password_maintenance_and_business_audit_keep_trusted_source(environment):
    from app.local_business_context import create_local_business_context
    from app.system_audit_service import event_dto
    from starlette.requests import Request
    e = environment
    session(e.client)
    good = headers(e.client)
    revision = e.client.get("/api/v1/system/options").json()["data"]["revision"]
    response = e.client.post("/api/v1/system/accounts/" + e.account_id + "/password", headers=good,
        json={"baseRevision": revision, "requestId": "local-maintain", "operatorPassword": "", "newPassword": secrets.token_urlsafe(24)})
    assert response.status_code == 200, response.text
    supplied = {**good, "Cookie": SESSION_COOKIE + "=" + e.client.cookies.get(SESSION_COOKIE), "Host": "127.0.0.1:18598"}
    request = Request({"type": "http", "app": e.app, "method": "POST", "scheme": "http", "server": ("127.0.0.1", 18598),
        "client": ("127.0.0.1", 50000), "path": "/api/v1/planning-operations", "query_string": b"",
        "headers": [(k.lower().encode(), v.encode()) for k, v in supplied.items()]})
    context = create_local_business_context(request, adapter=e.adapter)
    assert context.actor.auth_source == "LOCAL_SINGLE_USER"
    with e.factory.begin() as store:
        ticket = context.prepare(store, "planning.execute")
        event_id = context.append_owner(store, ticket, operation="task.save", request_id="local-owner-proof", object_id="local-test-task")
    with e.factory() as store:
        assert event_dto(store.scalar(select(SystemAuditEvent).where(SystemAuditEvent.id == event_id)))["authSource"] == "LOCAL_SINGLE_USER"


@pytest.mark.parametrize("origin", ["https://example.invalid", "http://192.0.2.1"])
def test_single_mode_configuration_never_enables_nonlocal_origins(environment, origin):
    from app.system_management_schemas import SystemManagementError
    with pytest.raises(SystemManagementError):
        environment.make_app(origin=origin)


def test_password_mode_keeps_anonymous_login_csrf_and_prohibits_self_review(environment):
    e = environment
    # 人工赋予测试账号并集权限，以证明旧模式禁止自审不依赖前端隐藏按钮。
    with e.factory.begin() as store:
        account = store.get(LocalAccount, e.account_id)
        store.get(LocalRole, account.role_id).permissions = [row["code"] for row in SERVER_PERMISSION_REGISTRY]
    app, _ = e.make_app("LOCAL_PASSWORD")
    with TestClient(app, base_url=ORIGIN, client=("127.0.0.1", 50001)) as client:
        assert session(client) is None
        challenge = client.get("/api/v1/auth/csrf").json()["data"]
        login = {"username": "original_operator", "password": e.original_password}
        assert client.post("/api/v1/auth/login", json=login, headers={"Origin": ORIGIN}).status_code == 403
        result = client.post("/api/v1/auth/login", json=login, headers={"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
        assert result.status_code == 200
        assert "single_user_mode" not in result.json()["data"]
        saved = change(client, "save", {"draft": draft(client)})
        assert saved.status_code == 200, saved.text
        row = saved.json()["data"]["change"]
        common = {"changeId": row["id"], "revision": row["revision"]}
        assert change(client, "submit", common).status_code == 200
        assert change(client, "review", {**common, "submission": 1, "approved": True}).status_code == 403
        assert change(client, "review", {**common, "submission": 1, "approved": True, "allowSelfReview": True}).status_code == 422


def test_real_loopback_http_cookie_and_knowledge_workflow(environment):
    e = environment
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    app, _ = e.make_app(origin=origin)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False, log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    try:
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(.02)
        assert server.started
        with httpx.Client(base_url=origin, trust_env=False, timeout=15) as client:
            bootstrap = client.get("/api/v1/auth/session")
            assert bootstrap.status_code == 200
            assert "HttpOnly" in bootstrap.headers["set-cookie"] and "SameSite=strict" in bootstrap.headers["set-cookie"]
            result = exercise_workflow(client, origin)
            result.update(realLoopbackHTTP=True, fullPermissions=set(session(client)["permissions"]) == {r["code"] for r in SERVER_PERMISSION_REGISTRY})
    finally:
        server.should_exit = True
        if thread.ident is not None:
            thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive()
    result["listenerClosed"] = True
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / "auth-live-http.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
