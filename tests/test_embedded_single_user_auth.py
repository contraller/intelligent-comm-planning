"""新建F盘隔离库上的独立页会话；不接触现用实例或用户数据。"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, ExitStack
from copy import deepcopy
import json
import socket
import threading
import time

import httpx
import pytest
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import select
import uvicorn

from test_local_single_user_api import environment, ORIGIN, ROOT
from app.local_business_context import create_local_business_context
from app.local_identity_models import LocalIdentitySession
from app.local_identity_service import EMBEDDED_HEADER, SESSION_COOKIE
from app.local_single_user_service import SINGLE_ACCOUNT_ID
from app.system_management_models import LocalAccount, LocalCredential
from app.system_management_schemas import SystemManagementError

MARKER = {"X-Radio-Embedded": "1"}


def add_probe(app, adapter, factory):
    @app.post("/api/v1/embed-auth-probe")
    def probe(request: Request):
        try:
            context = create_local_business_context(request, adapter=adapter)
            with factory() as store, store.begin():
                context.prepare(store, "planning.execute")
            return {"code": 0, "data": {"session_id": context.actor.session_id, "account_id": context.actor.account_id,
                                        "auth_source": context.actor.auth_source}}
        except SystemManagementError as error:
            return JSONResponse(status_code=error.status, content={"code": error.code, "data": None})


def embedded_session(client):
    response = client.get("/api/v1/auth/session", headers=MARKER)
    assert response.status_code == 200, response.text
    assert "set-cookie" not in response.headers
    return response.json()["data"]


def embedded_headers(client, origin):
    response = client.get("/api/v1/auth/csrf", headers=MARKER)
    assert response.status_code == 200 and "set-cookie" not in response.headers
    data = response.json()["data"]
    return {**MARKER, "Origin": origin, "X-Session-Id": data["session_id"], "X-CSRF-Token": data["csrf_token"]}


def test_embedded_fixed_identity_ignores_cookie_and_keeps_original_accounts(environment):
    e = environment
    with e.factory() as store:
        before = [{k: deepcopy(v) for k, v in store.get(model, e.account_id).__dict__.items() if not k.startswith("_")}
                  for model in [LocalAccount, LocalCredential]]
    e.client.cookies.set(SESSION_COOKIE, "cookie-from-a-different-port")
    cookie_before = str(e.client.cookies)
    first = embedded_session(e.client)
    for _ in range(4):
        assert embedded_session(e.client) == first
    assert first["account_id"] == SINGLE_ACCOUNT_ID and first["auth_source"] == "LOCAL_SINGLE_USER"
    assert first["single_user_mode"] is True and first["allow_self_review"] is True
    assert str(e.client.cookies) == cookie_before
    with e.factory() as store:
        after = [{k: v for k, v in store.get(model, e.account_id).__dict__.items() if not k.startswith("_")}
                 for model in [LocalAccount, LocalCredential]]
    assert after == before


def test_embedded_business_context_still_checks_csrf_session_origin_and_permission(environment):
    e = environment
    add_probe(e.app, e.adapter, e.factory)
    first = embedded_session(e.client)
    good = embedded_headers(e.client, ORIGIN)
    ok = e.client.post("/api/v1/embed-auth-probe", headers=good)
    assert ok.status_code == 200 and ok.json()["data"]["session_id"] == first["session_id"]
    for changes, expected in [({"X-CSRF-Token": "wrong"}, 403), ({"X-Session-Id": "wrong"}, 409),
                              ({"Origin": "http://other.invalid"}, 403), ({"Sec-Fetch-Site": "cross-site"}, 403),
                              ({"Sec-Fetch-Site": "same-site"}, 403)]:
        assert e.client.post("/api/v1/embed-auth-probe", headers={**good, **changes}).status_code == expected
    assert e.client.post("/api/v1/embed-auth-probe", headers={**MARKER, "Origin": ORIGIN}).status_code in (403, 409)
    assert e.client.post("/api/v1/auth/logout", headers=good, json={}).status_code == 403
    assert embedded_session(e.client) == first


@pytest.mark.parametrize("marker", ["0", "true", "1,1"])
def test_invalid_embedded_marker_rejected(environment, marker):
    response = environment.client.get("/api/v1/auth/session", headers={"X-Radio-Embedded": marker})
    assert response.status_code == 403


def test_embedded_expiry_rotates_real_session_and_old_header_is_rejected(environment):
    e = environment
    add_probe(e.app, e.adapter, e.factory)
    first = embedded_session(e.client)
    old = embedded_headers(e.client, ORIGIN)
    with e.factory.begin() as store:
        row = store.scalar(select(LocalIdentitySession).where(LocalIdentitySession.session_id == first["session_id"]))
        row.revoked = True
    failed = e.client.get("/api/v1/auth/csrf", headers=MARKER)
    assert failed.status_code == 401 and "set-cookie" not in failed.headers
    second = embedded_session(e.client)
    assert second["account_id"] == first["account_id"] and second["session_id"] != first["session_id"]
    assert second["session_generation"] != first["session_generation"]
    assert e.client.post("/api/v1/embed-auth-probe", headers=old).status_code == 409
    assert e.client.post("/api/v1/embed-auth-probe", headers=embedded_headers(e.client, ORIGIN)).status_code == 200


def test_password_mode_marker_never_grants_a_session(environment):
    e = environment
    app, _ = e.make_app("LOCAL_PASSWORD")
    with TestClient(app, base_url=ORIGIN, client=("127.0.0.1", 50001)) as client:
        response = client.get("/api/v1/auth/session", headers=MARKER)
        assert response.status_code == 403 and response.json()["code"] == 1104
        assert client.get("/api/v1/auth/session").json()["data"] is None
        assert client.get("/api/v1/system/accounts", headers=MARKER).status_code == 403
        assert SESSION_COOKIE not in client.cookies


@contextmanager
def running_app(e, mode="LOCAL_SINGLE_USER"):
    listener = socket.socket(); listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]; origin = f"http://127.0.0.1:{port}"
    app, adapter = e.make_app(mode, origin=origin)
    add_probe(app, adapter, e.factory)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, access_log=False, log_level="error"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    try:
        thread.start(); deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline: time.sleep(.02)
        assert server.started
        yield origin
    finally:
        server.should_exit = True
        if thread.ident is not None: thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive()


def test_real_http_parallel_cookieless_frames_and_port_pollution(environment):
    e = environment
    with ExitStack() as stack:
        origin = stack.enter_context(running_app(e))
        other = stack.enter_context(running_app(e))
        password_origin = stack.enter_context(running_app(e, "LOCAL_PASSWORD"))
        barrier = threading.Barrier(6)
        def frame(_):
            with httpx.Client(base_url=origin, trust_env=False, timeout=20) as client:
                barrier.wait(timeout=10)
                first = embedded_session(client)
                assert not client.cookies
                good = embedded_headers(client, origin)
                checked = client.post("/api/v1/embed-auth-probe", headers=good)
                assert checked.status_code == 200, checked.text
                assert not client.cookies
                return first["session_id"], first["session_generation"], good["X-CSRF-Token"]
        with ThreadPoolExecutor(max_workers=6) as pool: frames = list(pool.map(frame, range(6)))
        assert len(set(frames)) == 1
        with httpx.Client(base_url=origin, trust_env=False, timeout=20) as client, httpx.Client(base_url=other, trust_env=False, timeout=20) as other_client:
            initial = embedded_session(client)
            ordinary = other_client.get("/api/v1/auth/session").json()["data"]
            foreign_cookie = other_client.cookies.get(SESSION_COOKIE)
            assert foreign_cookie
            client.cookies.set(SESSION_COOKIE, foreign_cookie)
            assert embedded_session(client) == initial
            assert embedded_session(other_client)["session_id"] != initial["session_id"]
            assert other_client.cookies.get(SESSION_COOKIE) == foreign_cookie
            assert other_client.get("/api/v1/auth/session").json()["data"] == ordinary
            assert client.get("/api/v1/auth/session", headers={**MARKER, "Origin": other}).status_code == 403
            good = embedded_headers(client, origin)
            assert client.post("/api/v1/embed-auth-probe", headers={**good, "X-CSRF-Token": "bad"}).status_code == 403
            assert client.post("/api/v1/embed-auth-probe", headers={**good, "X-Session-Id": "bad"}).status_code == 409
        with httpx.Client(base_url=password_origin, trust_env=False, timeout=20) as client:
            assert client.get("/api/v1/auth/session", headers=MARKER).status_code == 403
            assert client.get("/api/v1/auth/session").json()["data"] is None
    target = ROOT / "data/runtime/module-embed-20261104/auth"
    target.mkdir(parents=True, exist_ok=True)
    (target / "real-http-parallel.json").write_text(json.dumps({"realHTTP": True, "parallelCookieLessFrames": 6,
        "stableSessionAndCSRF": True, "portScopedInternalIdentity": True, "foreignCookieIgnored": True,
        "ordinaryCookieUnchanged": True, "crossOriginRejected": True, "badCSRFRejected": True,
        "wrongSessionRejected": True, "passwordModeRejected": True, "allListenersAndThreadsStopped": True}, indent=2), encoding="utf-8")
