"""显式端口批准后的真实回环 HTTP 证据；默认不监听任何端口。"""
import os
import socket
import threading
import time
from contextlib import contextmanager

import httpx
import pytest
import uvicorn

from test_system_management_api import local_system, seed_store, ORIGIN
from fastapi import FastAPI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.local_identity_router import create_local_identity_router
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import LocalIdentityAdapter, LocalIdentityService
from app.system_management_router import create_system_management_router
from app.system_management_service import SystemManagementService


@contextmanager
def isolated_server(app):
    sock = socket.socket()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.15", port=8115, access_log=False, log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    try:
        sock.bind(("127.0.0.15", 8115))
        thread.start()
        deadline = time.monotonic() + 30
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert server.started
        yield
    finally:
        server.should_exit = True
        if thread.ident is not None:
            thread.join(timeout=15)
        sock.close()
        assert not thread.is_alive()


@pytest.mark.skipif(os.environ.get("R2_P05_LIVE_PORT") != "8115", reason="真实监听尚需指定本组8115；未启用不记通过")
def test_real_http_login_parameter_readback_logout(local_system, seed_store):
    e = local_system
    assert "/p5-identity/data/runtime/tmp/" in e.path.as_posix()
    with isolated_server(e.app):
        with httpx.Client(base_url=ORIGIN, trust_env=False) as client:
            challenge = client.get("/api/v1/auth/csrf").json()["data"]
            response = client.post("/api/v1/auth/login", json={"username": "operator", "password": e.password}, headers={"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
            assert response.status_code == 200
            assert response.json()["data"]["data_origin"] == "FORMAL_VERIFIED"
            assert client.get("/api/v1/auth/session").json()["data"] is not None
            csrf = client.get("/api/v1/auth/csrf").json()["data"]
            headers = {"Origin": ORIGIN, "X-CSRF-Token": csrf["csrf_token"], "X-Session-Id": csrf["session_id"]}
            revision = client.get("/api/v1/system/options").json()["data"]["revision"]
            changed = client.put("/api/v1/system/parameters/PAR-01", json={"baseRevision": revision, "requestId": "live-parameter", "value": 43}, headers=headers)
            assert changed.status_code == 200
            assert client.get("/api/v1/system/parameters/PAR-01").json()["data"]["parameter"]["value"] == 43
            assert client.get("/api/v1/system/operations/live-parameter").json()["data"]["status"] == "FOUND"
            cookie = client.cookies.get("radio_local_session")
            assert client.post("/api/v1/auth/logout", json={}, headers=headers).status_code == 200
            client.cookies.set("radio_local_session", cookie)
            assert client.get("/api/v1/auth/session").status_code == 401
    # 重建数据库连接/服务/app并重新监听，回读同一测试库，而非复用内存缓存。
    engine = create_engine("sqlite:///" + e.path.as_posix())
    system = SystemManagementService(session_factory=sessionmaker(bind=engine, expire_on_commit=False), permission_registry=seed_store.registry, request_key=seed_store.key, clock=lambda: e.clock[0])
    local = LocalIdentityService(system_service=system, settings=LocalIdentitySettings(allowed_origins=frozenset((ORIGIN,)), allow_insecure_loopback=True))
    adapter = LocalIdentityAdapter(service=local)
    app = FastAPI()
    app.include_router(create_local_identity_router(service=local))
    app.include_router(create_system_management_router(authorize=adapter.require_actor, service=system))
    try:
        with isolated_server(app), httpx.Client(base_url=ORIGIN, trust_env=False) as client:
            csrf = client.get("/api/v1/auth/csrf").json()["data"]
            assert client.post("/api/v1/auth/login", json={"username": "operator", "password": e.password}, headers={"Origin": ORIGIN, "X-CSRF-Token": csrf["csrf_token"], "X-Session-Id": ""}).status_code == 200
            assert client.get("/api/v1/system/parameters/PAR-01").json()["data"]["parameter"]["value"] == 43
            assert client.get("/api/v1/system/operations/live-parameter").json()["data"]["status"] == "FOUND"
            assert client.get("/api/v1/system/logs").json()["data"]["total"] >= 4
    finally:
        engine.dispose()
