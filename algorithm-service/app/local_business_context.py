"""仅由已安装本地适配器创建的请求上下文；在业务事务内复核会话。"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import hmac

from sqlalchemy import select
from sqlalchemy.orm import Session

from .local_identity_models import LocalIdentitySession
from .local_identity_service import LocalIdentityAdapter, LocalIdentityService, SESSION_COOKIE
from .local_operation_digest import bind_local_operation_digest
from .system_audit_service import PreparedAudit, append_business_audit, prepare_audit
from .system_management_models import LocalAccount, LocalCredential, LocalRole, SystemAuditEvent
from .system_management_schemas import SystemActor, SystemManagementError, safe_text


_SEAL = object()
_PROOF_VERSION = "local-owner-v1"
_PERMISSIONS = {"task.save": "planning.execute", "planning.submit": "planning.execute",
                "planning.cancel": "planning.execute", "plan.save": "planning.save", "plan.confirm": "planning.confirm"}


def _operation(operation):
    if type(operation) is not str or operation not in _PERMISSIONS:
        raise SystemManagementError("不支持的本地业务操作")
    return _PERMISSIONS[operation]


def _equal(left, right):
    if type(left) is not str or type(right) is not str:
        return False
    try:
        return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))
    except UnicodeError:
        return False


@dataclass(frozen=True, slots=True, init=False, repr=False)
class LocalBusinessContext:
    actor: SystemActor
    _service: LocalIdentityService = field(repr=False)
    _engine: object = field(repr=False)
    _token_hash: str = field(repr=False)
    _generation: str = field(repr=False)
    _header_session: str | None = field(repr=False)
    _csrf: str | None = field(repr=False)
    _writing: bool = field(repr=False)
    _seal: object = field(repr=False)
    _tickets: dict = field(repr=False, compare=False)

    def __init__(self, *args, **kwargs):
        raise TypeError("use create_local_business_context with the installed adapter")

    def _trusted(self):
        if getattr(self, "_seal", None) is not _SEAL:
            raise SystemManagementError("本地业务上下文不可用", 1101, 401)

    def _authenticate(self, session, permission):
        self._trusted()
        transaction = (session.get_nested_transaction() or session.get_transaction()) if isinstance(session, Session) else None
        if not isinstance(session, Session) or not session.is_active or transaction is None or not transaction.is_active:
            raise SystemManagementError("业务身份复核需要调用方活动事务", 5001, 503)
        bind = session.get_bind()
        if getattr(bind, "engine", bind) is not self._engine:
            raise SystemManagementError("业务事务与本地身份数据库不一致", 5001, 503)
        permission = safe_text(permission)
        now = int(self._service.clock())
        with session.no_autoflush:
            # populate_existing避免同一Session已缓存的旧会话绕过撤销/改密检查。
            row = session.get(LocalIdentitySession, self._token_hash, populate_existing=True)
            if (row is None or row.revoked or row.expires_at <= now
                    or row.last_seen + self._service.settings.idle_seconds <= now
                    or row.created_at > now or row.last_seen > now):
                raise SystemManagementError("本地会话已过期或撤销", 1102, 401)
            if (row.account_id != self.actor.account_id or row.session_id != self.actor.session_id
                    or row.generation != self._generation or row.created_at != self.actor.authenticated_at):
                raise SystemManagementError("本地业务会话绑定已变化", 1106, 409)
            account = session.get(LocalAccount, row.account_id, populate_existing=True)
            credential = session.get(LocalCredential, row.account_id, populate_existing=True)
            if account is None or not account.enabled:
                raise SystemManagementError("本地账号已停用", 1103, 403)
            role = session.get(LocalRole, account.role_id, populate_existing=True)
            if (role is None or credential is None or row.identity_revision != account.identity_revision
                    or str(row.identity_revision) != self.actor.identity_revision):
                raise SystemManagementError("本地会话权限或凭据已变更", 1102, 401)
            if credential.must_change_password:
                raise SystemManagementError("请先维护本人密码", 1104, 403, reason="PASSWORD_CHANGE_REQUIRED")
            if self._writing:
                if not _equal(self._header_session, row.session_id):
                    raise SystemManagementError("本地请求会话绑定已变化", 1106, 409)
                if not _equal(self._csrf, row.csrf):
                    raise SystemManagementError("业务请求CSRF校验失败", 1105, 403)
            self._service.system.check_actor(session, self.actor, permission)

    def prepare(self, session: Session, permission: str) -> PreparedAudit:
        self._authenticate(session, permission)
        if not self._writing and permission in _PERMISSIONS.values():
            raise SystemManagementError("只读请求不能准备业务写入", 1105, 403)
        ticket = prepare_audit(session, actor=self.actor, permission=permission, check_actor=self._service.system.check_actor)
        self._tickets[id(ticket)] = (ticket, permission)
        return ticket

    def digest(self, body_digest: str, *, operation: str) -> str:
        self._trusted()
        try:
            return bind_local_operation_digest(body_digest, operation=operation, account_id=self.actor.account_id)
        except ValueError:
            raise SystemManagementError("本地业务请求摘要无效") from None

    def append_owner(self, session: Session, prepared: PreparedAudit, *, operation: str, request_id: str,
                     object_id: str, changed: bool = True, changes: dict | None = None, summary: str | None = None) -> str:
        required = _operation(operation)
        self._authenticate(session, required)
        issued = self._tickets.get(id(prepared))
        if not self._writing or issued is None or issued[0] is not prepared or issued[1] != required:
            raise SystemManagementError("业务审计票据不属于当前上下文或权限", 5001, 503)
        if type(changed) is not bool or changes is not None and type(changes) is not dict:
            raise SystemManagementError("业务审计结果格式无效")
        if changes is not None and "ownerProofVersion" in changes:
            raise SystemManagementError("业务审计归属字段由服务端生成")
        metadata = {**(changes or {}), "ownerProofVersion": _PROOF_VERSION}
        defaults = {"planning.submit": "规划作业已受理，尚未完成", "planning.cancel": "取消请求已受理，尚待终态确认"}
        if summary is None:
            summary = defaults.get(operation, "业务请求已确认") if changed else "业务请求已确认，内容未变化"
        self._tickets.pop(id(prepared))
        return append_business_audit(session, prepared, now=int(self._service.clock()), module="planning", action=operation,
            request_id=safe_text(request_id), object_id=safe_text(object_id), outcome="SUCCESS" if changed else "UNCHANGED",
            changes=metadata, summary=summary)

    def require_owner(self, session: Session, *, operation: str, request_id: str, object_id: str) -> None:
        _operation(operation)
        self._authenticate(session, "planning.view")
        request_id, object_id = safe_text(request_id), safe_text(object_id)
        with session.no_autoflush:
            rows = session.scalars(select(SystemAuditEvent).where(SystemAuditEvent.module == "planning",
                SystemAuditEvent.action == operation, SystemAuditEvent.request_id == request_id,
                SystemAuditEvent.object_id == object_id, SystemAuditEvent.outcome.in_(("SUCCESS", "UNCHANGED"))).limit(2)).all()
        if len(rows) > 1:
            raise SystemManagementError("业务归属证明不唯一", 5002, 503)
        row = rows[0] if rows else None
        if (row is None or type(row.actor) is not dict or set(row.actor) != {"id", "name", "roleId", "roleName"}
                or not all(type(value) is str and value for value in row.actor.values())
                or row.actor["id"] != self.actor.account_id or type(row.changes) is not dict
                or row.changes.get("ownerProofVersion") != _PROOF_VERSION):
            raise SystemManagementError("当前本地账号无此业务归属证明", 1104, 403)
        if row.error_code:
            raise SystemManagementError("业务归属证明状态不一致", 5002, 503)


def create_local_business_context(request, *, adapter: LocalIdentityAdapter) -> LocalBusinessContext:
    installed = getattr(getattr(getattr(request, "app", None), "state", None), "local_identity_adapter", None)
    if adapter is not installed or not isinstance(adapter, LocalIdentityAdapter) or not isinstance(adapter.service, LocalIdentityService):
        raise SystemManagementError("需要已安装的正式本地身份适配器", 1101, 401)
    writing = request.method != "GET"
    actor = adapter.require_actor(request, writing=writing)
    token = request.cookies.get(SESSION_COOKIE)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with adapter.service.factory() as session:
        row = session.get(LocalIdentitySession, token_hash)
        if row is None:
            raise SystemManagementError("本地会话已失效", 1102, 401)
        generation = row.generation
        bind = session.get_bind()
    context = object.__new__(LocalBusinessContext)
    for name, value in {"actor": actor, "_service": adapter.service, "_engine": getattr(bind, "engine", bind),
            "_token_hash": token_hash, "_generation": generation, "_header_session": request.headers.get("x-session-id"),
            "_csrf": request.headers.get("x-csrf-token"), "_writing": writing, "_seal": _SEAL, "_tickets": {}}.items():
        object.__setattr__(context, name, value)
    return context
