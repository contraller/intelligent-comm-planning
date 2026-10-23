"""系统管理独立契约；所有数据库和账号为本轮新建测试材料。"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import secrets
import sqlite3
import sys
from threading import Barrier
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app.database import Base
from app.local_identity_models import IDENTITY_TABLES
from app.local_identity_router import create_local_identity_router
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import LocalIdentityService
from app.system_audit_service import IMMUTABLE_SQLITE_DDL
from app.system_management_models import SYSTEM_TABLES, LocalAccount, LocalRole, SystemAuditEvent
from app.system_management_router import create_system_management_router
from app.system_management_schemas import ADMIN_PERMISSIONS, SystemActor, SystemManagementError
from app.system_management_service import SystemManagementService

ORIGIN = "http://127.0.0.15:8115"


class IsolatedEnvironment(SimpleNamespace):
    def __repr__(self):
        # 即使断言失败，pytest的夹具展示也不输出随机测试密钥、口令或摘要。
        return "<IsolatedP05Environment path=" + repr(str(self.path)) + ">"


@pytest.fixture(scope="session")
def seed_store(tmp_path_factory):
    directory = tmp_path_factory.mktemp("r2-p05-seed")
    path = directory / "seed.sqlite"
    engine = create_engine("sqlite:///" + path.as_posix())
    Base.metadata.create_all(engine, tables=SYSTEM_TABLES + IDENTITY_TABLES)
    registry = [dict(code=p, name=p, group=p.split(".")[0], requires=[] if p.endswith(".view") else [p.split(".")[0] + ".view"])
                for p in sorted(ADMIN_PERMISSIONS | {"resources.view", "knowledge.view", "knowledge.edit", "knowledge.review"})]
    key, password = secrets.token_bytes(32), secrets.token_urlsafe(24)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    system = SystemManagementService(session_factory=factory, permission_registry=registry, request_key=key, clock=lambda: 1_800_000_000)
    account_id = system.initialize(username="operator", password=password, name="显式测试主体", department="隔离测试")
    with engine.begin() as conn:
        for ddl in IMMUTABLE_SQLITE_DDL:
            conn.exec_driver_sql(ddl)
    engine.dispose()
    return IsolatedEnvironment(path=path, registry=registry, key=key, password=password, account_id=account_id)


@pytest.fixture
def local_system(seed_store, tmp_path):
    path = tmp_path / "local.sqlite"
    assert not path.exists()
    # 仅克隆本轮测试种子，新库从不复制运行库、主库或旧证据。
    with sqlite3.connect(seed_store.path) as source, sqlite3.connect(path) as target:
        source.backup(target)
    engine = create_engine("sqlite:///" + path.as_posix(), connect_args={"timeout": 5})
    @event.listens_for(engine, "connect")
    def foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    clock = [1_800_000_000]
    service = SystemManagementService(session_factory=factory, permission_registry=seed_store.registry, request_key=seed_store.key, clock=lambda: clock[0])
    identity = LocalIdentityService(system_service=service, settings=LocalIdentitySettings(allowed_origins=frozenset((ORIGIN,)), allow_insecure_loopback=True))
    with factory() as session:
        account = session.get(LocalAccount, seed_store.account_id)
        role = session.get(LocalRole, account.role_id)
        actor = SystemActor(account.id, "explicit-test-binding", str(account.identity_revision), frozenset(role.permissions))
    app = FastAPI()
    app.include_router(create_local_identity_router(service=identity))
    app.include_router(create_system_management_router(authorize=identity.require, service=service))
    with TestClient(app, base_url=ORIGIN) as client:
        yield IsolatedEnvironment(system=service, identity=identity, factory=factory, engine=engine, client=client,
            actor=actor, password=seed_store.password, account_id=seed_store.account_id, clock=clock, path=path, app=app)
    engine.dispose()


def mutation(env, request_id="request-one"):
    return {"baseRevision": env.system.read("options", env.actor)["revision"], "requestId": request_id}


def create_role(env, permissions=None, name="资源查看"):
    return env.system.execute("role.create", env.actor, {**mutation(env, "role-" + secrets.token_hex(6)),
        "role": dict(name=name, description="显式测试角色", permissions=permissions or ["resources.view"])})


def login(env):
    challenge = env.client.get("/api/v1/auth/csrf").json()["data"]
    response = env.client.post("/api/v1/auth/login", json={"username": "operator", "password": env.password},
        headers={"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def write_headers(env):
    challenge = env.client.get("/api/v1/auth/csrf").json()["data"]
    return {"Origin": ORIGIN, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": challenge["session_id"]}


def test_fresh_system_reads_have_real_metadata_and_no_credential_material(local_system):
    e = local_system
    for kind in ("accounts", "roles", "parameters", "logs"):
        result = e.system.read(kind, e.actor, query={"pageNum": 1, "pageSize": 5})
        assert result["total"] >= 1
        assert "password_hash" not in str(result)
        assert e.password not in str(result)
    detail = e.system.read("accounts", e.actor, object_id=e.account_id)
    assert detail["account"]["username"] == "operator"
    assert e.system.read("accounts", e.actor, query={"search": "not-found"})["total"] == 0
    assert e.system.read("accounts", e.actor, query={"pageNum": 20, "pageSize": 5})["items"] == []


def test_role_create_and_account_create_readback_and_receipt(local_system):
    e = local_system
    role = create_role(e)
    password = secrets.token_urlsafe(24)
    body = {**mutation(e, "create-user"), "account": dict(username="viewer", name="查看人员", department="测试", roleId=role["objectId"]), "initialPassword": password}
    first = e.system.execute("account.create", e.actor, body)
    assert e.system.execute("account.create", e.actor, body) == {**first, "replayed": True}
    assert e.system.read("accounts", e.actor, object_id=first["objectId"])["account"]["mustChangePassword"] is True
    receipt = e.system.read("operations", e.actor, object_id="create-user")
    assert receipt["status"] == "FOUND"
    assert password not in str(receipt)
    assert e.system.read("operations", e.actor, object_id="absent") == {"status": "NOT_FOUND"}


def test_conflicts_keep_existing_state_and_history(local_system):
    e = local_system
    body = {**mutation(e), "role": dict(name="资源查看", description="", permissions=["resources.view"])}
    first = e.system.execute("role.create", e.actor, body)
    with pytest.raises(SystemManagementError) as conflict:
        e.system.execute("role.create", e.actor, {**body, "role": {**body["role"], "name": "另一角色"}})
    assert conflict.value.code == 1206
    with pytest.raises(SystemManagementError) as stale:
        e.system.execute("role.create", e.actor, {**body, "requestId": "another"})
    assert stale.value.code == 1203
    assert e.system.read("roles", e.actor, object_id=first["objectId"])["role"]["name"] == "资源查看"


@pytest.mark.parametrize("change", [
    {"role": dict(name="未知权限", description="", permissions=["unknown.view"])},
    {"role": dict(name="重复权限", description="", permissions=["resources.view", "resources.view"])},
    {"role": dict(name="缺少依赖", description="", permissions=["knowledge.edit"])},
    {"role": dict(name="职责混合", description="", permissions=["knowledge.view", "knowledge.edit", "knowledge.review"])},
    {"actorId": "forged"},
])
def test_invalid_role_and_client_actor_are_rejected(local_system, change):
    e = local_system
    body = {**mutation(e), "role": dict(name="基础角色", description="", permissions=["resources.view"]), **change}
    with pytest.raises(SystemManagementError) as error:
        e.system.execute("role.create", e.actor, body)
    assert error.value.code == 1001


def test_last_admin_disable_and_role_removal_rollback(local_system):
    e = local_system
    with pytest.raises(SystemManagementError) as disabled:
        e.system.execute("account.state", e.actor, {**mutation(e), "enabled": False}, object_id=e.account_id)
    assert disabled.value.data["reason"] == "LAST_ADMIN"
    role_id = e.system.read("accounts", e.actor, object_id=e.account_id)["account"]["roleId"]
    with pytest.raises(SystemManagementError) as role_changed:
        e.system.execute("role.update", e.actor, {**mutation(e), "role": dict(name="系统管理角色", description="", permissions=["system.view"])}, object_id=role_id)
    assert role_changed.value.code == 1203
    assert e.system.read("accounts", e.actor, object_id=e.account_id)["account"]["enabled"] is True


def test_parameter_save_noop_reset_and_readonly(local_system):
    e = local_system
    changed = e.system.execute("parameter.save", e.actor, {**mutation(e), "value": 45}, object_id="PAR-01")
    assert changed["applicationState"] == "STORED_ONLY"
    unchanged = e.system.execute("parameter.save", e.actor, {**mutation(e, "same"), "value": 45}, object_id="PAR-01")
    assert unchanged["changed"] is False
    reset = e.system.execute("parameter.reset", e.actor, {**mutation(e, "reset"), "parameterIds": ["PAR-01"], "reason": "测试恢复", "confirm": "RESTORE_PARAMETER_DEFAULTS"})
    assert reset["changed"] is True
    assert e.system.read("parameters", e.actor, object_id="PAR-01")["parameter"]["value"] == 30
    with pytest.raises(SystemManagementError):
        e.system.execute("parameter.save", e.actor, {**mutation(e, "readonly"), "value": "EPSG:3857"}, object_id="PAR-03")


@pytest.mark.parametrize("value", [True, 0, 3601, "30", None, [], float("nan")])
def test_parameter_type_and_range_are_server_validated(local_system, value):
    e = local_system
    with pytest.raises((SystemManagementError, ValueError)):
        e.system.execute("parameter.save", e.actor, {**mutation(e), "value": value}, object_id="PAR-01")


def test_router_rejects_anonymous_and_runs_real_local_authorization(local_system):
    e = local_system
    assert e.client.get("/api/v1/system/accounts").status_code == 401
    identity = login(e)
    assert identity["integration_mode"] is False
    assert e.client.get("/api/v1/system/accounts").json()["data"]["total"] == 1
    response = e.client.put("/api/v1/system/parameters/PAR-01", headers=write_headers(e), json={**mutation(e), "value": 42})
    assert response.status_code == 200, response.text
    assert e.client.get("/api/v1/system/parameters/PAR-01").json()["data"]["parameter"]["value"] == 42
    for query in ("?pageNum=0", "?enabled=1", "?pageNum=1&pageNum=2", "?unknown=1"):
        assert e.client.get("/api/v1/system/accounts" + query).status_code == 422


def test_bad_password_validation_never_echoes_secret(local_system):
    e = local_system
    login(e)
    secret = secrets.token_urlsafe(24)
    response = e.client.post("/api/v1/system/accounts", headers=write_headers(e), json={**mutation(e), "account": {}, "initialPassword": {"secret": secret}})
    assert response.status_code == 422
    assert secret not in response.text
    assert "input" not in response.text


def test_registry_response_cannot_mutate_authority(local_system):
    e = local_system
    catalog = e.system.read("options", e.actor)
    catalog["permissions"][0]["requires"].append("forged.permission")
    assert all("forged.permission" not in row["requires"] for row in e.system.registry.values())


def test_admin_password_maintenance_honors_account_throttle_before_hash(local_system, monkeypatch):
    from app.local_identity_models import LocalIdentityThrottle
    import app.system_management_service as module
    e = local_system
    with e.factory() as session, session.begin():
        session.add(LocalIdentityThrottle(key="account:" + e.account_id, failures=5, window_start=e.clock[0], blocked_until=e.clock[0] + 300))
    def unexpected(*args):
        raise AssertionError("Throttled requests must not run expensive hashing")
    monkeypatch.setattr(module, "hash_password", unexpected)
    with pytest.raises(SystemManagementError) as error:
        e.system.execute("account.password", e.actor, {**mutation(e), "operatorPassword": e.password, "newPassword": secrets.token_urlsafe(24)}, object_id=e.account_id)
    assert error.value.status == 429


def test_admin_password_reauthentication_failure_commits_counter(local_system):
    from app.local_identity_models import LocalIdentityThrottle
    e = local_system
    with pytest.raises(SystemManagementError) as error:
        e.system.execute("account.password", e.actor, {**mutation(e), "operatorPassword": secrets.token_urlsafe(24), "newPassword": secrets.token_urlsafe(24)}, object_id=e.account_id)
    assert error.value.code == 1101
    with e.factory() as session:
        assert session.get(LocalIdentityThrottle, "account:" + e.account_id).failures == 1


@pytest.mark.parametrize("action", ["role.update", "account.state"])
def test_concurrent_admin_changes_keep_one_usable_admin(local_system, action):
    e = local_system
    role = create_role(e, permissions=sorted(ADMIN_PERMISSIONS), name="第二维护角色")
    second = e.system.execute("account.create", e.actor, {**mutation(e, "second-admin"),
        "account": dict(username="second-operator", name="第二维护人员", department="隔离测试", roleId=role["objectId"]),
        "initialPassword": secrets.token_urlsafe(24)})
    second_actor = SystemActor(second["objectId"], "second-test-binding", "1", ADMIN_PERMISSIONS)
    actors = (e.actor, second_actor)
    baseline = mutation(e)["baseRevision"]
    barrier = Barrier(2)

    def change(index):
        actor = actors[index]
        if action == "role.update":
            with e.factory() as session:
                target = session.get(LocalAccount, actor.account_id).role_id
            change_body = {"role": dict(name="降权角色" + str(index), description="并发防自锁", permissions=["system.view"])}
        else:
            target = actors[1 - index].account_id
            change_body = {"enabled": False}
        barrier.wait(timeout=30)
        try:
            return e.system.execute(action, actor, {"baseRevision": baseline, "requestId": "concurrent-" + str(index), **change_body}, object_id=target)
        except SystemManagementError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as workers:
        outcomes = list(workers.map(change, range(2)))
    assert sum(isinstance(value, dict) for value in outcomes) == 1
    rejected = next(value for value in outcomes if isinstance(value, SystemManagementError))
    assert rejected.code in (1203, 1103, 1106)
    with e.factory() as session:
        usable = [(account, session.get(LocalRole, account.role_id))
            for account in session.scalars(select(LocalAccount).where(LocalAccount.enabled.is_(True)))
            if ADMIN_PERMISSIONS <= set(session.get(LocalRole, account.role_id).permissions)]
        assert len(usable) == 1
        account, remaining_role = usable[0]
        remaining = SystemActor(account.id, "remaining-test-binding", str(account.identity_revision), frozenset(remaining_role.permissions))
        target = remaining_role.id if action == "role.update" else account.id
    final_body = {"role": dict(name="最后维护角色", description="不得收回", permissions=["system.view"])} if action == "role.update" else {"enabled": False}
    with pytest.raises(SystemManagementError) as last_admin:
        e.system.execute(action, remaining, {"baseRevision": e.system.read("options", remaining)["revision"], "requestId": "last-admin-retry", **final_body}, object_id=target)
    assert last_admin.value.data["reason"] == "LAST_ADMIN"
