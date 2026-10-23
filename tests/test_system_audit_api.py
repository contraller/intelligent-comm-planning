"""审计仅来自服务端事务，归档保留原记录。"""
import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError

from test_system_management_api import local_system, seed_store, login, mutation, write_headers
from app.system_audit_service import append_system_audit
from app.system_management_models import LocalAccount, SystemAuditEvent, SystemOperation
from app.system_management_schemas import SystemManagementError


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
