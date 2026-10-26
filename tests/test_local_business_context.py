"""真实隔离本地会话的事务内复核、只追加归属证据；不接运行服务。"""
from dataclasses import FrozenInstanceError, is_dataclass, replace
import hashlib
from urllib.parse import urlsplit

import pytest
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.requests import Request

from test_system_management_api import ORIGIN, local_system, login, seed_store, write_headers

import app.local_business_context as module
from app.local_business_context import LocalBusinessContext, create_local_business_context
from app.local_identity_models import LocalIdentitySession
from app.local_identity_service import LocalIdentityAdapter, SESSION_COOKIE
from app.local_operation_digest import bind_local_operation_digest
from app.system_audit_service import append_system_audit, log_rows, prepare_audit
from app.system_management_models import (
    LocalAccount, LocalCredential, LocalRole, SystemAuditArchive, SystemAuditEvent,
    SystemOperation, SystemParameter,
)
from app.system_management_schemas import SystemManagementError


OPERATIONS = {
    "task.save": "planning.execute", "planning.submit": "planning.execute",
    "planning.cancel": "planning.execute", "plan.save": "planning.save", "plan.confirm": "planning.confirm",
}


@pytest.fixture
def business(local_system):
    e = local_system
    permissions = {"planning.view", *OPERATIONS.values()}
    # 仅给本轮隔离fixture显式配置规划权限，不更改生产初始角色。
    for permission in permissions:
        e.system.registry[permission] = dict(code=permission, name=permission, group="planning",
            requires=[] if permission.endswith(".view") else ["planning.view"])
    with e.factory() as session, session.begin():
        account = session.get(LocalAccount, e.account_id)
        role = session.get(LocalRole, account.role_id)
        role.permissions = sorted(set(role.permissions) | permissions)
        e.actor = replace(e.actor, permissions=frozenset(role.permissions))
    login(e)
    e.adapter = LocalIdentityAdapter(service=e.identity)
    e.app.state.local_identity_adapter = e.adapter
    return e


def capture(e, method="POST"):
    headers = write_headers(e)
    origin = urlsplit(ORIGIN)
    headers["Cookie"] = SESSION_COOKIE + "=" + e.client.cookies.get(SESSION_COOKIE)
    request = Request(dict(type="http", app=e.app, method=method, scheme=origin.scheme,
        server=(origin.hostname, origin.port), client=("127.0.0.15", 43210), path="/api/v1/planning-operations",
        query_string=b"", headers=[(key.lower().encode(), value.encode("latin-1")) for key, value in headers.items()]))
    return create_local_business_context(request, adapter=e.adapter)


def session_row(session, context):
    return session.get(LocalIdentitySession, context._token_hash)


def append(e, context, operation="task.save", request_id="request-one", object_id="object-one", **kwargs):
    with e.factory() as session, session.begin():
        ticket = context.prepare(session, OPERATIONS[operation])
        return context.append_owner(session, ticket, operation=operation, request_id=request_id, object_id=object_id, **kwargs)


def assert_owner(e, context, **kwargs):
    with e.factory() as session, session.begin():
        context.require_owner(session, operation=kwargs.pop("operation", "task.save"),
            request_id=kwargs.pop("request_id", "request-one"), object_id=kwargs.pop("object_id", "object-one"), **kwargs)


def proof(e, **overrides):
    values = dict(now=e.clock[0], action="task.save", module="planning", object_id="object-one",
        request_id="request-one", changes={"ownerProofVersion": "local-owner-v1"})
    values.update(overrides)
    with e.factory() as session, session.begin():
        return append_system_audit(session, e.actor, **values).id


def test_factory_is_installed_adapter_only_and_context_is_private_frozen(business):
    e = business
    context = capture(e)
    assert is_dataclass(context)
    assert context.actor.account_id == e.account_id
    assert context.actor.session_id != e.actor.session_id
    assert context.actor.auth_source == "LOCAL_PASSWORD"
    assert e.password not in repr(context)
    assert e.client.cookies.get(SESSION_COOKIE) not in repr(context)
    assert context._csrf not in repr(context)
    with pytest.raises(FrozenInstanceError):
        context.actor = e.actor
    with pytest.raises(TypeError):
        LocalBusinessContext(actor=e.actor)
    with pytest.raises(SystemManagementError) as error:
        object.__new__(LocalBusinessContext).digest("0" * 64, operation="task.save")
    assert error.value.code == 1101
    with pytest.raises(TypeError):
        create_local_business_context(None, adapter=e.adapter, actor=e.actor)
    e.app.state.local_identity_adapter = None
    with pytest.raises(SystemManagementError) as error:
        capture(e)
    assert error.value.code == 1101


def test_anonymous_never_falls_back_to_planner(local_system):
    e = local_system
    adapter = LocalIdentityAdapter(service=e.identity)
    e.app.state.local_identity_adapter = adapter
    request = Request(dict(type="http", app=e.app, method="GET", scheme="http", server=("127.0.0.15", 8115),
        client=("127.0.0.15", 43210), path="/api/v1/planning-operations", query_string=b"", headers=[]))
    with pytest.raises(SystemManagementError) as error:
        create_local_business_context(request, adapter=adapter)
    assert error.value.code == 1101


def test_requires_caller_transaction_and_identical_database_bind(business):
    e = business
    context = capture(e)
    with e.factory() as session:
        with pytest.raises(SystemManagementError) as error:
            context.prepare(session, "planning.execute")
        assert error.value.code == 5001
        assert not session.in_transaction()
    engine = create_engine("sqlite://")
    try:
        with Session(engine) as other, other.begin():
            with pytest.raises(SystemManagementError) as error:
                context.prepare(other, "planning.execute")
            assert error.value.code == 5001
    finally:
        engine.dispose()


@pytest.mark.parametrize("field,value,code", [
    ("revoked", True, 1102), ("expires_at", 1_800_000_000, 1102),
    ("last_seen", 1_800_000_000 - 1800, 1102), ("created_at", 1_800_000_001, 1102),
    ("last_seen", 1_800_000_001, 1102), ("session_id", "changed-session", 1106),
    ("generation", "changed-generation", 1106), ("created_at", 1_799_999_999, 1106),
    ("identity_revision", 2, 1102), ("csrf", "令牌已轮换", 1105),
])
def test_session_mutation_after_request_capture_is_rechecked(business, field, value, code):
    e = business
    context = capture(e)
    with e.factory() as session, session.begin():
        setattr(session_row(session, context), field, value)
    with e.factory() as session, session.begin(), pytest.raises(SystemManagementError) as error:
        context.prepare(session, "planning.execute")
    assert error.value.code == code


@pytest.mark.parametrize("change,code", [("disabled", 1103), ("revision", 1102), ("role", 1104), ("first-password", 1104)])
def test_account_role_and_first_password_rechecked_in_business_transaction(business, change, code):
    e = business
    context = capture(e)
    with e.factory() as session, session.begin():
        account = session.get(LocalAccount, e.account_id)
        if change == "disabled":
            account.enabled = False
        elif change == "revision":
            account.identity_revision += 1
        elif change == "role":
            session.get(LocalRole, account.role_id).permissions = ["planning.view"]
        else:
            session.get(LocalCredential, account.id).must_change_password = True
    with e.factory() as session, session.begin(), pytest.raises(SystemManagementError) as error:
        context.prepare(session, "planning.execute")
    assert error.value.code == code
    if change == "first-password":
        assert error.value.data == {"reason": "PASSWORD_CHANGE_REQUIRED"}


def test_fresh_read_overrides_old_cached_identity_rows(business):
    e = business
    context = capture(e)
    with e.factory() as session:
        cached = session_row(session, context)
        session.commit()
        with e.factory() as other, other.begin():
            session_row(other, context).revoked = True
        assert cached.revoked is False
        with session.begin(), pytest.raises(SystemManagementError) as error:
            context.prepare(session, "planning.execute")
        assert error.value.code == 1102


def test_non_ascii_comparison_has_explicit_utf8_and_invalid_scalar_behavior():
    assert module._equal("令牌é", "令牌é") is True
    assert module._equal("令牌é", "令牌e") is False
    assert module._equal("\ud800", "\ud800") is False
    assert module._equal(None, "令牌") is False


@pytest.mark.parametrize("operation,permission", OPERATIONS.items())
def test_five_actions_bind_real_owner_and_append_exact_proof(business, operation, permission):
    e = business
    context = capture(e)
    body = hashlib.sha256(b"controlled-test-body").hexdigest()
    assert context.digest(body, operation=operation) == bind_local_operation_digest(body, operation=operation, account_id=e.account_id)
    assert context.digest(body, operation=operation) != body
    identifier = append(e, context, operation=operation, changes={"source": "ISOLATED_TEST"})
    with e.factory() as session:
        row = session.scalar(select(SystemAuditEvent).where(SystemAuditEvent.id == identifier))
        assert row.module == "planning" and row.action == operation
        assert row.actor["id"] == e.account_id
        assert set(row.actor) == {"id", "name", "roleId", "roleName"}
        assert row.outcome == "SUCCESS" and row.error_code == ""
        assert row.changes == {"ownerProofVersion": "local-owner-v1", "source": "ISOLATED_TEST"}
        assert body not in str(row.changes)
        if operation == "planning.submit":
            assert row.summary == "规划作业已受理，尚未完成"
        if operation == "planning.cancel":
            assert row.summary == "取消请求已受理，尚待终态确认"
    assert_owner(e, context, operation=operation)


def test_unchanged_is_positive_evidence_not_replay_and_does_not_commit(business):
    e = business
    context = capture(e)
    with e.factory() as session, session.begin():
        ticket = context.prepare(session, "planning.execute")
        context.append_owner(session, ticket, operation="task.save", request_id="request-one", object_id="object-one", changed=False)
        assert session.in_transaction()
        row = session.scalar(select(SystemAuditEvent).where(SystemAuditEvent.action == "task.save"))
        assert row.outcome == "UNCHANGED"
    assert_owner(e, context)


def test_second_prepare_issues_distinct_single_use_tickets_in_same_transaction(business):
    e = business
    context = capture(e)
    with e.factory() as session, session.begin():
        first = context.prepare(session, "planning.execute")
        second = context.prepare(session, "planning.execute")
        assert first is not second
        context.append_owner(session, first, operation="task.save", request_id="first", object_id="first-object")
        context.append_owner(session, second, operation="planning.submit", request_id="second", object_id="second-object")
        with pytest.raises(SystemManagementError) as error:
            context.append_owner(session, first, operation="task.save", request_id="third", object_id="third-object")
        assert error.value.code == 5001
    assert_owner(e, context, request_id="first", object_id="first-object")
    assert_owner(e, context, operation="planning.submit", request_id="second", object_id="second-object")


def test_context_does_not_read_body_and_invalid_digest_never_echoes_it(business):
    e = business
    class BodyForbiddenRequest:
        app = e.app
        method = "POST"
        url = urlsplit(ORIGIN)
        client = type("Peer", (), {"host": "127.0.0.15"})()
        cookies = {SESSION_COOKIE: e.client.cookies.get(SESSION_COOKIE)}
        headers = {key.lower(): value for key, value in write_headers(e).items()}
        def body(self):
            raise AssertionError("Business context must not read the request body")
        def json(self):
            raise AssertionError("Business context must not parse client identity or body")
    context = create_local_business_context(BodyForbiddenRequest(), adapter=e.adapter)
    marker = "private-body-marker-not-a-digest"
    with pytest.raises(SystemManagementError) as error:
        context.digest(marker, operation="task.save")
    assert error.value.code == 1001
    assert marker not in str(error.value)
    assert marker not in repr(context)
    assert marker not in str(error.value.data)
    append(e, context)
    with e.factory() as session:
        row = session.scalar(select(SystemAuditEvent).where(SystemAuditEvent.module == "planning"))
        assert row.changes == {"ownerProofVersion": "local-owner-v1"}
        assert marker not in str(row.changes)
        assert context._csrf not in str(row.changes)
        assert e.client.cookies.get(SESSION_COOKIE) not in str(row.changes)


@pytest.mark.parametrize("scope", ["other-session", "nested-transaction"])
def test_ticket_cannot_move_to_another_session_or_nested_transaction(business, scope):
    e = business
    context = capture(e)
    with e.factory() as session, session.begin():
        ticket = context.prepare(session, "planning.execute")
        if scope == "other-session":
            with e.factory() as other, other.begin(), pytest.raises(SystemManagementError) as error:
                context.append_owner(other, ticket, operation="task.save", request_id="request-one", object_id="object-one")
        else:
            with session.begin_nested(), pytest.raises(SystemManagementError) as error:
                context.append_owner(session, ticket, operation="task.save", request_id="request-one", object_id="object-one")
        assert error.value.code == 5001


@pytest.mark.parametrize("kind", ["wrong-permission", "other-context", "external-ticket", "consumed", "old-transaction"])
def test_ticket_is_context_permission_and_transaction_bound(business, kind):
    e = business
    context = capture(e)
    other = capture(e)
    with e.factory() as session:
        with session.begin():
            permission = "planning.save" if kind == "wrong-permission" else "planning.execute"
            if kind == "external-ticket":
                ticket = prepare_audit(session, actor=context.actor, permission=permission, check_actor=e.system.check_actor)
            else:
                ticket = context.prepare(session, permission)
            if kind == "consumed":
                context.append_owner(session, ticket, operation="task.save", request_id="request-one", object_id="object-one")
            if kind != "old-transaction":
                with pytest.raises(SystemManagementError) as error:
                    (other if kind == "other-context" else context).append_owner(session, ticket,
                        operation="task.save", request_id="request-two", object_id="object-two")
                assert error.value.code == 5001
        if kind == "old-transaction":
            with session.begin(), pytest.raises(SystemManagementError) as error:
                context.append_owner(session, ticket, operation="task.save", request_id="request-one", object_id="object-one")
            assert error.value.code == 5001


def test_read_request_cannot_prepare_business_write(business):
    e = business
    context = capture(e, "GET")
    with e.factory() as session, session.begin(), pytest.raises(SystemManagementError) as error:
        context.prepare(session, "planning.execute")
    assert error.value.code == 1105


def test_session_expiring_between_prepare_and_append_rejects_and_rolls_back(business):
    e = business
    context = capture(e)
    with pytest.raises(SystemManagementError) as error:
        with e.factory() as session, session.begin():
            ticket = context.prepare(session, "planning.execute")
            session.get(SystemParameter, "PAR-01").value = 77
            session.flush()
            e.clock[0] += e.identity.settings.idle_seconds
            context.append_owner(session, ticket, operation="task.save", request_id="request-one", object_id="object-one")
    assert error.value.code == 1102
    with e.factory() as session:
        assert session.get(SystemParameter, "PAR-01").value == 30
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.module == "planning")) == 0


@pytest.mark.parametrize("changes", [{"ownerProofVersion": "forged"}, {"password": "sensitive-test-marker"}, {"csrf": "marker"}])
def test_client_override_and_secret_metadata_never_persist(business, changes):
    e = business
    with pytest.raises(SystemManagementError) as error:
        append(e, capture(e), changes=changes)
    assert error.value.code == 1001
    with e.factory() as session:
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.module == "planning")) == 0


@pytest.mark.parametrize("operation", ["task", "planning.submit.accepted", "plan.save ", "unknown", None])
def test_unknown_operation_does_not_expand_planning_domains(business, operation):
    context = capture(business)
    with pytest.raises(SystemManagementError) as error:
        context.digest("0" * 64, operation=operation)
    assert error.value.code == 1001


@pytest.mark.parametrize("override", [
    {"changes": {}}, {"changes": {"ownerProofVersion": "old-version"}},
    {"outcome": "FAILED"}, {"outcome": "DENIED"}, {"action": "planning.finished"},
    {"module": "other"}, {"object_id": "another-object"}, {"request_id": "another-request"},
    {"snapshot": dict(id="another-account", name="历史他人", roleId="historical-role", roleName="历史角色")},
])
def test_legacy_foreign_negative_and_wrong_scope_are_not_claimed(business, override):
    e = business
    context = capture(e)
    proof(e, **override)
    with pytest.raises(SystemManagementError) as error:
        assert_owner(e, context)
    assert error.value.code == 1104


def test_missing_proof_is_denied_without_claiming_old_receipt(business):
    e = business
    with pytest.raises(SystemManagementError) as error:
        assert_owner(e, capture(e))
    assert error.value.code == 1104
    with e.factory() as session:
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.module == "planning")) == 0


def test_historical_name_and_role_are_not_rebound_to_current_profile(business):
    e = business
    context = capture(e)
    historical = dict(id=e.account_id, name="历史名称", roleId="previous-role", roleName="历史角色")
    proof(e, snapshot=historical)
    assert_owner(e, context)
    with e.factory() as session:
        row = session.scalar(select(SystemAuditEvent).where(SystemAuditEvent.module == "planning"))
        assert row.actor == historical


def test_owner_lookup_rechecks_current_permission_before_proof(business):
    e = business
    context = capture(e)
    append(e, context)
    with e.factory() as session, session.begin():
        role = session.get(LocalRole, session.get(LocalAccount, e.account_id).role_id)
        role.permissions = [permission for permission in role.permissions if not permission.startswith("planning.")]
    current = capture(e, "GET")
    with pytest.raises(SystemManagementError) as error:
        assert_owner(e, current)
    assert error.value.code == 1104


@pytest.mark.parametrize("problem", ["duplicate", "inconsistent-error"])
def test_contradictory_positive_proof_fails_closed(business, problem):
    e = business
    context = capture(e)
    proof(e)
    if problem == "duplicate":
        proof(e)
    else:
        # 新建故意损坏的隔离证据，不UPDATE不可变历史。
        proof(e, request_id="bad-status", error_code="CONTRADICTORY")
    with pytest.raises(SystemManagementError) as error:
        assert_owner(e, context, request_id="bad-status" if problem == "inconsistent-error" else "request-one")
    assert error.value.code == 5002


def test_archive_hides_display_not_owner_and_context_checks_only_read(business):
    e = business
    context = capture(e)
    append(e, context)
    with e.factory() as session, session.begin():
        boundary = session.scalar(select(func.max(SystemAuditEvent.sequence)))
        session.add(SystemAuditArchive(id="test-archive", through_sequence=boundary, actor_id=e.account_id, reason="仅归档视图", time=e.clock[0]))
    with e.factory() as session:
        assert log_rows(session, {}) == []
        seen = session_row(session, context).last_seen
    e.clock[0] += 10
    statements = []
    def record(conn, cursor, statement, parameters, ctx, executemany):
        statements.append(statement.lstrip().split(None, 1)[0].upper())
    event.listen(e.engine, "before_cursor_execute", record)
    try:
        assert_owner(e, context)
    finally:
        event.remove(e.engine, "before_cursor_execute", record)
    assert statements and set(statements) == {"SELECT"}
    with e.factory() as session:
        assert session_row(session, context).last_seen == seen


def test_same_account_relogin_retains_owner_but_old_session_is_rejected(business):
    e = business
    old = capture(e)
    append(e, old)
    response = e.client.post("/api/v1/auth/logout", headers=write_headers(e), json={})
    assert response.status_code == 200
    login(e)
    current = capture(e)
    assert current.actor.account_id == old.actor.account_id
    assert current.actor.session_id != old.actor.session_id
    assert_owner(e, current)
    with pytest.raises(SystemManagementError) as error:
        assert_owner(e, old)
    assert error.value.code == 1102


def test_audit_insert_failure_rolls_back_business_and_receipt(business):
    e = business
    context = capture(e)
    def fail_insert(conn, cursor, statement, parameters, ctx, executemany):
        if statement.startswith("INSERT INTO system_audit_events"):
            raise SQLAlchemyError("controlled audit INSERT failure")
    event.listen(e.engine, "before_cursor_execute", fail_insert)
    try:
        with pytest.raises(SQLAlchemyError):
            with e.factory() as session, session.begin():
                ticket = context.prepare(session, "planning.execute")
                session.get(SystemParameter, "PAR-01").value = 77
                session.add(SystemOperation(id="isolated-receipt", actor_id=e.account_id, request_id="request-one", action="task.save",
                    fingerprint="0" * 64, permission="planning.execute", result={"test": True}, created_at=e.clock[0]))
                session.flush()
                context.append_owner(session, ticket, operation="task.save", request_id="request-one", object_id="object-one")
    finally:
        event.remove(e.engine, "before_cursor_execute", fail_insert)
    with e.factory() as session:
        assert session.get(SystemParameter, "PAR-01").value == 30
        assert session.get(SystemOperation, "isolated-receipt") is None
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.module == "planning")) == 0
