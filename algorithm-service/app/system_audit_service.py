"""只追加的服务端审计及归档视图；不接收浏览器自证成功。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
import uuid

from sqlalchemy import func, select

from .system_management_models import LocalAccount, LocalRole, SystemAuditArchive, SystemAuditEvent
from .system_management_schemas import SystemActor, SystemManagementError, safe_text

_SECRET = ("password", "credential", "csrf", "cookie", "token", "digest", "salt", "secret")


def actor_snapshot(session, actor: SystemActor | None) -> dict | None:
    if actor is None:
        return None
    account = session.get(LocalAccount, actor.account_id)
    role = session.get(LocalRole, account.role_id) if account else None
    if account is None or role is None:
        raise SystemManagementError("审计主体不存在", 1104, 403)
    return {"id": account.id, "name": account.name, "roleId": role.id, "roleName": role.name}


def _safe_changes(value, depth=0):
    if depth > 6:
        raise SystemManagementError("审计变更字段过深")
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if type(key) is not str or any(word in key.lower() for word in _SECRET):
                raise SystemManagementError("审计不能包含敏感字段")
            result[safe_text(key)] = _safe_changes(item, depth + 1)
        return result
    if isinstance(value, list):
        return [_safe_changes(item, depth + 1) for item in value]
    if value is None or type(value) in (bool, int, float):
        return value
    if type(value) is str:
        return safe_text(value, maximum=500, empty=True)
    raise SystemManagementError("审计变更字段无效")


def append_system_audit(session, actor: SystemActor | None, *, now: int, action: str,
                        object_id: str = "", request_id: str | None = None,
                        outcome: str = "SUCCESS", error_code: str = "", changes: dict | None = None,
                        snapshot: dict | None = None, module: str | None = None) -> SystemAuditEvent:
    if outcome not in ("SUCCESS", "FAILED", "DENIED", "UNCHANGED"):
        raise SystemManagementError("审计结果无效")
    row = SystemAuditEvent(id="AUD-" + uuid.uuid4().hex, time=now,
        actor=snapshot if snapshot is not None else actor_snapshot(session, actor), module=safe_text(module, maximum=40) if module else "auth" if action.startswith("auth.") else "system",
        action=safe_text(action, maximum=80), object_id=safe_text(object_id, empty=True),
        request_id=safe_text(request_id) if request_id is not None else None,
        outcome=outcome, error_code=safe_text(error_code, maximum=40, empty=True),
        summary={"SUCCESS": "请求已完成", "FAILED": "请求失败", "DENIED": "请求被拒绝", "UNCHANGED": "内容未变化"}[outcome],
        changes=_safe_changes(changes or {}))
    session.add(row)
    session.flush()
    return row


def audit_revision(session) -> str:
    return "AUD-" + str(session.scalar(select(func.max(SystemAuditEvent.sequence))) or 0)


def event_dto(row: SystemAuditEvent) -> dict:
    return {"id": row.id, "sequence": row.sequence, "epoch": "LOCAL_AUDIT_V1",
        "time": datetime.fromtimestamp(row.time, timezone.utc).isoformat(), "actor": row.actor,
        "attemptedUsername": "", "module": row.module, "action": row.action, "objectId": row.object_id,
        "requestId": row.request_id, "outcome": row.outcome, "summary": row.summary,
        "errorCode": row.error_code, "dedupeKey": row.id, "changes": row.changes,
        "authSource": "LOCAL_PASSWORD"}


def log_rows(session, query: dict):
    statement = select(SystemAuditEvent)
    if not query.get("includeArchived", False):
        boundary = session.scalar(select(func.max(SystemAuditArchive.through_sequence))) or 0
        statement = statement.where(SystemAuditEvent.sequence > boundary)
    if query.get("date"):
        value = query["date"]
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError()
            start = datetime.fromisoformat(value).replace(tzinfo=timezone(timedelta(hours=8)))
        except (ValueError, TypeError):
            raise SystemManagementError("日志日期无效") from None
        statement = statement.where(SystemAuditEvent.time >= int(start.timestamp()), SystemAuditEvent.time < int((start + timedelta(days=1)).timestamp()))
    for name, column in (("module", SystemAuditEvent.module), ("action", SystemAuditEvent.action), ("outcome", SystemAuditEvent.outcome)):
        if query.get(name):
            statement = statement.where(column == safe_text(query[name]))
    rows = list(session.scalars(statement.order_by(SystemAuditEvent.sequence.desc())))
    if query.get("actorId"):
        rows = [row for row in rows if row.actor and row.actor["id"] == query["actorId"]]
    return [event_dto(row) for row in rows]


# 由总集成加入正式 SQLite 迁移；模块测试可显式安装，不自动改变任何库。
IMMUTABLE_SQLITE_DDL = tuple(
    f"CREATE TRIGGER p05_{table}_{action.lower()} BEFORE {action} ON {table} BEGIN SELECT RAISE(ABORT, 'immutable system history'); END"
    for table in ("system_operations", "system_audit_events", "system_audit_archives")
    for action in ("UPDATE", "DELETE")
)
