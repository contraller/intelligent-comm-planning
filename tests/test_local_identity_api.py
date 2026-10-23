"""真实成本本地登录、CSRF、失效与强制改密的隔离 HTTP 契约。"""
import secrets
import pytest
from sqlalchemy import select

from test_system_management_api import local_system, seed_store, login, mutation, write_headers, create_role, ORIGIN
from app.local_identity_models import LocalIdentitySession, LocalIdentityThrottle
from app.local_identity_service import SESSION_COOKIE
from app.system_management_models import LocalCredential


def post_login(e, username="operator", password=None, origin=ORIGIN):
    challenge = e.client.get("/api/v1/auth/csrf").json()["data"]
    return e.client.post("/api/v1/auth/login", json={"username": username, "password": password or e.password}, headers={"Origin": origin, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})


def test_anonymous_never_defaults_to_demo_and_local_capabilities(local_system):
    e = local_system
    assert e.client.get("/api/v1/auth/session").json()["data"] is None
    e.client.cookies.set("radio_integration_session", "not-formal")
    assert e.client.get("/api/v1/auth/session").json()["data"] is None
    caps = e.client.get("/api/v1/auth/capabilities").json()["data"]
    assert caps["authMode"] == "LOCAL_PASSWORD" and caps["initialized"] is True
    for path in ("/api/v1/auth/integration/identities", "/api/v1/auth/identities"):
        assert e.client.get(path).status_code == 404
    assert e.client.post("/api/v1/auth/integration/switch", json={"accountId": "operator"}).status_code == 404


def test_real_login_session_rotation_logout_and_persisted_revocation(local_system):
    e = local_system
    identity = login(e)
    assert identity["data_origin"] == "FORMAL_VERIFIED" and identity["integration_mode"] is False
    cookie = e.client.cookies.get(SESSION_COOKIE)
    assert cookie != identity["session_id"]
    assert e.client.get("/api/v1/auth/session").json()["data"] == identity
    with e.factory() as session:
        row = session.scalar(select(LocalIdentitySession))
        assert cookie not in str(row.__dict__) and not row.revoked
    assert e.client.post("/api/v1/auth/logout", json={}, headers=write_headers(e)).status_code == 200
    assert e.client.get("/api/v1/auth/session").json()["data"] is None
    assert e.client.post("/api/v1/auth/logout", json={}, headers={"Origin": ORIGIN}).status_code == 200
    e.client.cookies.set(SESSION_COOKIE, cookie)
    assert e.client.get("/api/v1/auth/session").status_code == 401


def test_origin_csrf_and_session_binding_fail_closed(local_system):
    e = local_system
    assert post_login(e, origin="http://evil.invalid").status_code == 403
    assert e.client.post("/api/v1/auth/login", json={"username": "operator", "password": e.password}, headers={"Origin": ORIGIN}).status_code == 403
    login(e)
    headers = write_headers(e)
    for changed in ({"X-CSRF-Token": "wrong"}, {"X-Session-Id": "other-session"}, {"Origin": "http://evil.invalid"}):
        response = e.client.put("/api/v1/system/parameters/PAR-01", json={**mutation(e), "value": 33}, headers={**headers, **changed})
        assert response.status_code in (403, 409)


def test_expired_and_identity_revision_changed_sessions_reject(local_system):
    from app.system_management_models import LocalAccount
    e = local_system
    login(e)
    with e.factory() as session, session.begin():
        session.get(LocalAccount, e.account_id).identity_revision += 1
    assert e.client.get("/api/v1/auth/session").json()["code"] == 1102
    login(e)
    e.clock[0] += e.identity.settings.idle_seconds + 1
    assert e.client.get("/api/v1/auth/session").json()["code"] == 1102


def test_throttle_commits_account_counter_and_recovers_after_window(local_system):
    e = local_system
    for _ in range(e.identity.settings.maximum_failures):
        assert post_login(e, password=secrets.token_urlsafe(24)).status_code == 401
    blocked = post_login(e)
    assert blocked.status_code == 429 and blocked.json()["data"]["reason"] == "THROTTLED"
    assert "Retry-After" in blocked.headers
    with e.factory() as session:
        row = session.get(LocalIdentityThrottle, "account:" + e.account_id)
        assert row.failures == e.identity.settings.maximum_failures
    e.clock[0] += e.identity.settings.lockout_seconds + 1
    assert post_login(e).status_code == 200


def test_own_password_commit_invalidates_sessions_and_keeps_sanitized_receipt(local_system):
    e = local_system
    login(e)
    new = secrets.token_urlsafe(24)
    response = e.client.post("/api/v1/auth/password", json=dict(requestId="self-password", currentPassword=e.password, newPassword=new), headers=write_headers(e))
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["reauthenticationRequired"] is True
    assert e.client.get("/api/v1/auth/session").json()["data"] is None
    assert post_login(e, password=new).status_code == 200
    receipt = e.client.get("/api/v1/system/operations/self-password").json()["data"]
    assert receipt["status"] == "FOUND" and new not in str(receipt) and e.password not in str(receipt)


def test_new_account_must_change_password_before_business_permission(local_system):
    e = local_system
    role = create_role(e, permissions=["system.view", "system.accounts"], name="账号维护角色")
    password = secrets.token_urlsafe(24)
    created = e.system.execute("account.create", e.actor, {**mutation(e), "account": dict(username="maintainer", name="维护员", department="测试", roleId=role["objectId"]), "initialPassword": password})
    assert post_login(e, username="maintainer", password=password).status_code == 200
    assert e.client.get("/api/v1/auth/capabilities").json()["data"]["passwordChangeRequired"] is True
    denied = e.client.get("/api/v1/system/accounts")
    assert denied.status_code == 403 and denied.json()["data"]["reason"] == "PASSWORD_CHANGE_REQUIRED"
    new = secrets.token_urlsafe(24)
    changed = e.client.post("/api/v1/auth/password", json=dict(requestId="first-password", currentPassword=password, newPassword=new), headers=write_headers(e))
    assert changed.status_code == 200, changed.text
    assert post_login(e, username="maintainer", password=new).status_code == 200
    assert e.client.get("/api/v1/system/accounts").status_code == 200


def test_non_ascii_csrf_is_rejected_without_type_error(local_system):
    from starlette.requests import Request
    e = local_system
    login(e)
    headers = write_headers(e)
    scope = {"type": "http", "method": "PUT", "scheme": "http", "server": ("127.0.0.15", 8115), "path": "/api/v1/system/parameters/PAR-01", "query_string": b"", "client": ("testclient", 50000), "headers": [(b"host", b"127.0.0.15:8115"), (b"cookie", (SESSION_COOKIE + "=" + e.client.cookies.get(SESSION_COOKIE)).encode()), (b"origin", ORIGIN.encode()), (b"x-session-id", headers["X-Session-Id"].encode()), (b"x-csrf-token", "é".encode("latin1"))]}
    from app.system_management_schemas import SystemManagementError
    with pytest.raises(SystemManagementError) as error:
        e.identity.require(Request(scope), "system.parameters", writing=True)
    assert error.value.code == 1105


def test_browsers_behind_same_peer_keep_independent_anonymous_challenges(local_system):
    from fastapi.testclient import TestClient
    e = local_system
    first = e.client.get("/api/v1/auth/csrf").json()["data"]
    with TestClient(e.app, base_url=ORIGIN) as other:
        second = other.get("/api/v1/auth/csrf").json()["data"]
        assert first["csrf_token"] != second["csrf_token"]
        for client, challenge in ((e.client, first), (other, second)):
            response = client.post("/api/v1/auth/login", json={"username": "operator", "password": e.password}, headers={"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
            assert response.status_code == 200, response.text


def test_shared_adapter_returns_same_trusted_principal_and_internal_actor(local_system):
    from starlette.requests import Request
    from app.local_identity_service import LocalIdentityAdapter
    from app.system_management_schemas import SystemActor, SystemManagementError
    e = local_system
    adapter = LocalIdentityAdapter(service=e.identity)
    scope = {"type": "http", "method": "GET", "scheme": "http", "server": ("127.0.0.15", 8115), "path": "/probe", "query_string": b"", "client": ("testclient", 50000), "headers": [(b"host", b"127.0.0.15:8115")]}
    assert adapter.current(Request(scope)) is None
    with pytest.raises(SystemManagementError):
        adapter.require(Request(scope), "system.view")
    identity = login(e)
    request = Request({**scope, "headers": [*scope["headers"], (b"cookie", (SESSION_COOKIE + "=" + e.client.cookies.get(SESSION_COOKIE)).encode())]})
    assert adapter.current(request) == identity
    assert adapter.require(request, "system.view") == identity
    actor = adapter.require_actor(request, "system.view")
    assert isinstance(actor, SystemActor) and actor.account_id == identity["account_id"]
    assert adapter.auth_mode == "LOCAL_PASSWORD"
