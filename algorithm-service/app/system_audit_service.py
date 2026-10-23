"""只追加的服务端审计及归档视图；不接收浏览器自证成功。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import re
from typing import Callable
import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session, SessionTransaction

from .system_management_models import LocalAccount, LocalRole, SystemAuditArchive, SystemAuditEvent
from .system_management_schemas import SystemActor, SystemManagementError, safe_text

_SECRET = ("password", "credential", "csrf", "cookie", "token", "digest", "salt", "secret")
_TICKETS = "p05_prepared_audit_tickets"
_SNAPSHOT_KEYS = ("id", "name", "roleId", "roleName")


@dataclass(frozen=True, slots=True, repr=False)
class PreparedAudit:
    _session: Session
    _transaction: SessionTransaction
    _snapshot: tuple[str, str, str, str]
    _token: object


def _active_transaction(session: Session) -> SessionTransaction:
    if not isinstance(session, Session) or not session.is_active:
        raise SystemManagementError("审计需要调用方的活动事务", 5001, 503)
    transaction = session.get_nested_transaction() or session.get_transaction()
    if transaction is None or not transaction.is_active:
        raise SystemManagementError("审计需要调用方的活动事务", 5001, 503)
    return transaction


def _snapshot_copy(snapshot: dict | None) -> dict | None:
    if snapshot is None:
        return None
    if type(snapshot) is not dict or set(snapshot) != set(_SNAPSHOT_KEYS):
        raise SystemManagementError("审计身份快照无效", 5001, 503)
    return {key: safe_text(snapshot[key], maximum=40 if key in ("name", "roleName") else 120) for key in _SNAPSHOT_KEYS}


def prepare_audit(session: Session, *, actor: SystemActor, permission: str, check_actor: Callable) -> PreparedAudit:
    transaction = _active_transaction(session)
    if not callable(check_actor):
        raise SystemManagementError("审计身份检查未配置", 5001, 503)
    if type(actor) is not SystemActor or actor.auth_source != "LOCAL_PASSWORD":
        raise SystemManagementError("审计需要正式本地主体", 1101, 401)
    permission = safe_text(permission)
    with session.no_autoflush:
        check_actor(session, actor, permission)
        snapshot = _snapshot_copy(actor_snapshot(session, actor))
    token = object()
    tickets = session.info.setdefault(_TICKETS, set())
    # Session复用时只清理已结束事务的内存票据，不触碰数据库历史。
    tickets.difference_update(item for item in tuple(tickets) if not item[0].is_active)
    tickets.add((transaction, token))
    return PreparedAudit(session, transaction, tuple(snapshot[key] for key in _SNAPSHOT_KEYS), token)


def append_business_audit(session: Session, prepared: PreparedAudit, *, now: int, module: str, action: str,
                          object_id: str = "", request_id: str | None = None, outcome: str = "SUCCESS",
                          error_code: str = "", changes: dict | None = None, summary: str | None = None) -> str:
    transaction = _active_transaction(session)
    if (type(prepared) is not PreparedAudit or prepared._session is not session
            or prepared._transaction is not transaction):
        raise SystemManagementError("审计票据不属于当前事务", 5001, 503)
    ticket = (transaction, prepared._token)
    tickets = session.info.get(_TICKETS, set())
    if ticket not in tickets:
        raise SystemManagementError("审计票据已消费或不可用", 5001, 503)
    # 即使浅复制票据也只消费一次；追加失败必须由调用方回滚整个事务。
    tickets.remove(ticket)
    if type(now) is not int or now < 0:
        raise SystemManagementError("审计时间无效")
    row = append_system_audit(session, None, now=now, module=safe_text(module, maximum=40), action=action,
        object_id=object_id, request_id=request_id, outcome=outcome, error_code=error_code, changes=changes,
        snapshot=dict(zip(_SNAPSHOT_KEYS, prepared._snapshot)), summary=summary)
    return row.id


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
    if type(value) is float and not math.isfinite(value):
        raise SystemManagementError("审计不能包含非有限JSON数字")
    if value is None or type(value) in (bool, int, float):
        return value
    if type(value) is str:
        return safe_text(value, maximum=500, empty=True)
    raise SystemManagementError("审计变更字段无效")


def append_system_audit(session, actor: SystemActor | None, *, now: int, action: str,
                        object_id: str = "", request_id: str | None = None,
                        outcome: str = "SUCCESS", error_code: str = "", changes: dict | None = None,
                        snapshot: dict | None = None, module: str | None = None,
                        summary: str | None = None) -> SystemAuditEvent:
    if outcome not in ("SUCCESS", "FAILED", "DENIED", "UNCHANGED"):
        raise SystemManagementError("审计结果无效")
    if changes is not None and type(changes) is not dict:
        raise SystemManagementError("审计变更必须为对象")
    frozen_actor = _snapshot_copy(snapshot if snapshot is not None else actor_snapshot(session, actor))
    row = SystemAuditEvent(id="AUD-" + uuid.uuid4().hex, time=now,
        actor=frozen_actor, module=safe_text(module, maximum=40) if module else "auth" if action.startswith("auth.") else "system",
        action=safe_text(action, maximum=80), object_id=safe_text(object_id, empty=True),
        request_id=safe_text(request_id) if request_id is not None else None,
        outcome=outcome, error_code=safe_text(error_code, maximum=40, empty=True),
        summary=safe_text(summary, maximum=500) if summary is not None else {"SUCCESS": "请求已完成", "FAILED": "请求失败", "DENIED": "请求被拒绝", "UNCHANGED": "内容未变化"}[outcome],
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
