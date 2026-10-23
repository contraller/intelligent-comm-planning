"""审计仅来自服务端事务，归档保留原记录。"""
from dataclasses import FrozenInstanceError

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import DBAPIError, SQLAlchemyError

from test_system_management_api import local_system, seed_store, login, mutation, write_headers
from app.system_audit_service import append_business_audit, append_system_audit, prepare_audit
from app.system_management_models import LocalAccount, SystemAuditEvent, SystemOperation, SystemParameter, SystemState
from app.system_management_schemas import SystemActor, SystemManagementError


def test_archive_is_append_only_and_history_remains_readable(local_system):
    e = local_system
    before = e.system.read("logs", e.actor)
    first = before["items"][0]
    body = dict(baseAuditRevision=before["revision"], requestId="archive-one", throughSequence=before["snapshotSequence"], reason="归档视图", confirm="ARCHIVE_LOG_VIEW")
    result = e.system.execute("logs.archive", e.actor, body)
    assert result["archivedThroughSequence"] == before["snapshotSequence"]
    assert e.system.read("logs", e.actor)["total"] == 1
    assert e.system.read("logs", e.actor, query={"includeArchived": True})["total"] == before["total"] + 1
    assert e.system.read("logs", e.actor, object_id=first["id"])["id"] == first["id"]
    with e.factory() as session:
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent)) == before["total"] + 1


@pytest.mark.parametrize("table", ["system_audit_events", "system_operations", "system_audit_archives"])
@pytest.mark.parametrize("action", ["UPDATE", "DELETE"])
def test_sqlite_triggers_reject_history_mutation(local_system, table, action):
    e = local_system
    e.system.execute("parameter.save", e.actor, {**mutation(e), "value": 36}, object_id="PAR-01")
    logs = e.system.read("logs", e.actor)
    e.system.execute("logs.archive", e.actor, dict(baseAuditRevision=logs["revision"], requestId="archive", throughSequence=logs["snapshotSequence"], reason="测试归档", confirm="ARCHIVE_LOG_VIEW"))
    column = "outcome" if table == "system_audit_events" else "action" if table == "system_operations" else "reason"
    sql = f"UPDATE {table} SET {column} = {column}" if action == "UPDATE" else f"DELETE FROM {table}"
    with pytest.raises(DBAPIError):
        with e.engine.begin() as connection:
            connection.execute(text(sql))


def test_audit_failure_rolls_back_management_transaction(local_system, monkeypatch):
    import app.system_management_service as module
    e = local_system
    before = e.system.read("options", e.actor)["revision"]
    def unavailable(*args, **kwargs):
        raise SystemManagementError("审计不可用", 5002, 503)
    monkeypatch.setattr(module, "append_system_audit", unavailable)
    with pytest.raises(SystemManagementError):
        e.system.execute("parameter.save", e.actor, {**mutation(e), "value": 42}, object_id="PAR-01")
    assert e.system.read("options", e.actor)["revision"] == before
    assert e.system.read("parameters", e.actor, object_id="PAR-01")["parameter"]["value"] == 30


def test_server_actor_snapshot_and_rejection_audit(local_system):
    e = local_system
    login(e)
    response = e.client.put("/api/v1/system/parameters/PAR-01", headers=write_headers(e), json={**mutation(e), "value": 0, "outcome": "SUCCESS"})
    assert response.status_code == 422
    logs = e.system.read("logs", e.actor)
    denied = logs["items"][0]
    assert denied["outcome"] != "SUCCESS"
    assert denied["actor"]["id"] == e.account_id
    with e.factory() as session, session.begin():
        session.get(LocalAccount, e.account_id).name = "修改后的姓名"
    assert e.system.read("logs", e.actor, object_id=denied["id"])["actor"]["name"] == "显式测试主体"


def test_csrf_rejection_audited_without_client_actor_or_secret(local_system):
    e = local_system
    login(e)
    headers = write_headers(e)
    response = e.client.put("/api/v1/system/parameters/PAR-01", headers={**headers, "X-CSRF-Token": "invalid"}, json={**mutation(e), "value": 42})
    assert response.status_code == 403
    item = e.system.read("logs", e.actor)["items"][0]
    assert item["outcome"] == "DENIED" and item["errorCode"] == "1105"
    assert item["actor"]["id"] == e.account_id
    assert headers["X-CSRF-Token"] not in str(item)


def test_other_module_can_append_server_audit_in_its_own_transaction(local_system):
    e = local_system
    with e.factory() as session, session.begin():
        row = append_system_audit(session, e.actor, now=e.clock[0], module="resources", action="resource.update", object_id="constructed-resource", changes={"source": "SYNTHETIC_INTEGRATION"})
        event_id = row.id
    item = e.system.read("logs", e.actor, object_id=event_id)
    assert item["module"] == "resources" and item["authSource"] == "LOCAL_PASSWORD"
    assert item["changes"]["source"] == "SYNTHETIC_INTEGRATION"


@pytest.mark.parametrize("date", ["2026-02-30", "2026-2-03", "2026-01-01T00:00:00", "garbage"])
def test_invalid_calendar_dates_rejected(local_system, date):
    with pytest.raises(SystemManagementError):
        local_system.system.read("logs", local_system.actor, query={"date": date})


@pytest.mark.parametrize("key", ["password", "csrf", "cookie", "password_hash", "token", "secret"])
def test_audit_rejects_sensitive_fields(local_system, key):
    e = local_system
    with pytest.raises(SystemManagementError):
        with e.factory() as session, session.begin():
            append_system_audit(session, e.actor, now=e.clock[0], action="test", changes={key: "not-logged"})


def prepared(e, session):
    return prepare_audit(session, actor=e.actor, permission="system.parameters", check_actor=e.system.check_actor)


def append_prepared(e, session, ticket, **extra):
    return append_business_audit(session, ticket, now=e.clock[0], module="planning", action="planning.submit.accepted",
        object_id="isolated-job", request_id="isolated-request", summary="规划作业已受理，尚未完成", **extra)


def test_prepared_audit_freezes_actor_and_inserts_complete_event_once(local_system):
    e, statements = local_system, []
    def record(connection, cursor, statement, parameters, context, many):
        statements.append(statement.lower())
    event.listen(e.engine, "before_cursor_execute", record)
    try:
        with e.factory() as session, session.begin():
            ticket = prepared(e, session)
            with pytest.raises(FrozenInstanceError):
                ticket._snapshot = ()
            session.get(LocalAccount, e.account_id).name = "事务内更新的姓名"
            event_id = append_prepared(e, session, ticket, changes={"phase": "ACCEPTED", "dataOrigin": "SYNTHETIC_INTEGRATION"})
            assert session.in_transaction()
    finally:
        event.remove(e.engine, "before_cursor_execute", record)
    assert sum(statement.startswith("insert into system_audit_events") for statement in statements) == 1
    assert not any(statement.startswith("update system_audit_events") for statement in statements)
    item = e.system.read("logs", e.actor, object_id=event_id)
    assert item["actor"]["name"] == "显式测试主体"
    assert item["summary"] == "规划作业已受理，尚未完成"
    assert item["changes"]["dataOrigin"] == "SYNTHETIC_INTEGRATION"
    assert item["authSource"] == "LOCAL_PASSWORD"


def test_prepared_ticket_cannot_insert_twice_even_if_shallow_copied(local_system):
    from copy import copy
    e = local_system
    with e.factory() as session, session.begin():
        ticket = prepared(e, session)
        duplicate = copy(ticket)
        event_id = append_prepared(e, session, ticket)
        for used in (ticket, duplicate):
            with pytest.raises(SystemManagementError) as error:
                append_prepared(e, session, used)
            assert (error.value.code, error.value.status) == (5001, 503)
    with e.factory() as session:
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.request_id == "isolated-request")) == 1
        assert session.scalar(select(SystemAuditEvent.id).where(SystemAuditEvent.request_id == "isolated-request")) == event_id


def test_prepare_requires_an_existing_transaction_and_does_not_autobegin(local_system):
    e = local_system
    with e.factory() as session:
        with pytest.raises(SystemManagementError) as error:
            prepared(e, session)
        assert (error.value.code, error.value.status) == (5001, 503)
        assert not session.in_transaction()


@pytest.mark.parametrize("scope", ["other-session", "new-transaction", "ended-savepoint"])
def test_ticket_cannot_cross_session_or_transaction_scope(local_system, scope):
    e = local_system
    with e.factory() as session:
        with session.begin():
            if scope == "ended-savepoint":
                with session.begin_nested():
                    ticket = prepared(e, session)
                with pytest.raises(SystemManagementError) as error:
                    append_prepared(e, session, ticket)
            else:
                ticket = prepared(e, session)
                if scope == "other-session":
                    with e.factory() as other, other.begin():
                        with pytest.raises(SystemManagementError) as error:
                            append_prepared(e, other, ticket)
        if scope == "new-transaction":
            with session.begin():
                with pytest.raises(SystemManagementError) as error:
                    append_prepared(e, session, ticket)
        assert (error.value.code, error.value.status) == (5001, 503)
    with e.factory() as session:
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.request_id == "isolated-request")) == 0


def test_root_ticket_is_not_consumed_by_rejected_nested_append(local_system):
    e = local_system
    with e.factory() as session, session.begin():
        ticket = prepared(e, session)
        with session.begin_nested():
            with pytest.raises(SystemManagementError):
                append_prepared(e, session, ticket)
        assert append_prepared(e, session, ticket).startswith("AUD-")


def test_prepare_uses_injected_existing_actor_checker_before_snapshot(local_system):
    e, calls = local_system, []
    invalid = SystemActor(e.actor.account_id, e.actor.session_id, e.actor.identity_revision, frozenset())
    def check(session, actor, permission):
        calls.append(permission)
        return e.system.check_actor(session, actor, permission)
    with e.factory() as session, session.begin():
        with pytest.raises(SystemManagementError) as error:
            prepare_audit(session, actor=invalid, permission="system.parameters", check_actor=check)
    assert error.value.code == 1104
    assert calls == ["system.parameters"]


def test_business_and_receipt_rollback_when_audit_insert_fails(local_system):
    e = local_system
    def fail_insert(connection, cursor, statement, parameters, context, many):
        if statement.lower().startswith("insert into system_audit_events"):
            raise SQLAlchemyError("isolated audit failure")
    event.listen(e.engine, "before_cursor_execute", fail_insert)
    try:
        with pytest.raises(SQLAlchemyError):
            with e.factory() as session, session.begin():
                ticket = prepared(e, session)
                session.get(SystemState, 1).revision = 2
                session.get(SystemParameter, "PAR-01").value = 45
                session.add(SystemOperation(id="OP-isolated", actor_id=e.account_id, request_id="isolated-request",
                    action="parameter.save", fingerprint="isolated-test-only", permission="system.parameters", result={"changed": True}, created_at=e.clock[0]))
                session.flush()
                append_prepared(e, session, ticket)
    finally:
        event.remove(e.engine, "before_cursor_execute", fail_insert)
    with e.factory() as session:
        assert session.get(SystemState, 1).revision == 1
        assert session.get(SystemParameter, "PAR-01").value == 30
        assert session.get(SystemOperation, "OP-isolated") is None
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.request_id == "isolated-request")) == 0


def test_caller_rollback_removes_successfully_appended_audit_and_business(local_system):
    e = local_system
    with pytest.raises(RuntimeError):
        with e.factory() as session, session.begin():
            ticket = prepared(e, session)
            session.get(SystemParameter, "PAR-01").value = 45
            append_prepared(e, session, ticket)
            raise RuntimeError("caller aborts whole business transaction")
    with e.factory() as session:
        assert session.get(SystemParameter, "PAR-01").value == 30
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(SystemAuditEvent.request_id == "isolated-request")) == 0


@pytest.mark.parametrize("changes", [{"nested": {"csrf": "not-logged"}}, {"credential_digest": "not-logged"},
    {"value": float("nan")}, {"value": float("inf")}, [], {"value": object()}])
def test_business_audit_rejects_invalid_json_or_sensitive_fields(local_system, changes):
    e = local_system
    with pytest.raises(SystemManagementError):
        with e.factory() as session, session.begin():
            ticket = prepared(e, session)
            session.get(SystemParameter, "PAR-01").value = 45
            append_prepared(e, session, ticket, changes=changes)
    assert e.system.read("parameters", e.actor, object_id="PAR-01")["parameter"]["value"] == 30


def test_legacy_append_summary_is_compatible_and_snapshot_input_is_detached(local_system):
    e = local_system
    snapshot = {"id": e.account_id, "name": "冻结姓名", "roleId": "explicit-role", "roleName": "冻结角色"}
    with e.factory() as session, session.begin():
        row = append_system_audit(session, e.actor, now=e.clock[0], action="legacy.test", snapshot=snapshot)
        event_id = row.id
        snapshot["name"] = "调用方事后变更"
    item = e.system.read("logs", e.actor, object_id=event_id)
    assert item["summary"] == "请求已完成"
    assert item["actor"]["name"] == "冻结姓名"
