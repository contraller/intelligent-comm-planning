"""真实本地凭据、正式会话及服务端同步 CSRF，不接受联调身份。"""
from __future__ import annotations

from dataclasses import asdict
from functools import lru_cache
import hashlib
import ipaddress
import secrets
import uuid

from sqlalchemy import func, select

from .formal_identity_policy import require_formal_access
from .formal_identity_schemas import FormalAccessRequest, FormalIdentity, FormalSessionContext
from .local_identity_models import LocalIdentityChallenge, LocalIdentitySession, LocalIdentityThrottle
from .local_identity_schemas import LocalIdentitySettings, LocalLogin, OwnPassword
from .local_password_service import MAX_PASSWORD_SCALARS, MIN_PASSWORD_SCALARS, hash_password, verify_password
from .system_audit_service import append_system_audit
from .system_management_models import LocalAccount, LocalCredential, LocalRole, SystemOperation, SystemState
from .system_management_schemas import SystemActor, SystemManagementError, parse_request

SESSION_COOKIE = "radio_local_session"
CHALLENGE_COOKIE = "radio_local_challenge"


class LocalIdentityAdapter:
    """供公共入口注入的可信 principal 协议；构造不安装、不开户、不改变联调开关。"""
    auth_mode = "LOCAL_PASSWORD"

    def __init__(self, *, service: "LocalIdentityService"):
        self.service = service

    def current(self, request) -> dict | None:
        return self.service.session(request)

    def require(self, request, permission: str | None = None, *, writing=False) -> dict:
        return self.service.require_identity(request, permission, writing=writing)

    def require_actor(self, request, permission: str | None = None, *, writing=False) -> SystemActor:
        return self.service.require(request, permission, writing=writing)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@lru_cache(maxsize=1)
def _unknown_account_hash():
    return hash_password(secrets.token_urlsafe(32))


class LocalIdentityService:
    def __init__(self, *, system_service, settings: LocalIdentitySettings):
        self.system, self.settings = system_service, settings
        self.factory, self.clock = system_service.factory, system_service.clock
        # 随机虚拟凭据只用于不存在账号的等成本验证，不创建任何账户或默认密码。
        self._dummy_hash = _unknown_account_hash()

    def capabilities(self, request=None):
        with self.factory() as session:
            state = session.get(SystemState, 1)
            initialized = bool(state and state.initialized)
        required = False
        if request is not None and request.cookies.get(SESSION_COOKIE):
            try:
                _, _, credential = self._load(request, touch=False)
                required = credential.must_change_password
            except SystemManagementError:
                pass
        return dict(authMode="LOCAL_PASSWORD", initialized=initialized, passwordPolicy=dict(minScalars=MIN_PASSWORD_SCALARS, maxScalars=MAX_PASSWORD_SCALARS),
                    capabilities=dict(passwordMaintenance=True, anonymousRecovery=False), passwordChangeRequired=required)

    def _transport(self, request):
        if request.url.scheme == "https":
            return
        try:
            loopback = ipaddress.ip_address(request.url.hostname).is_loopback
        except ValueError:
            loopback = False
        if not (self.settings.allow_insecure_loopback and loopback):
            raise SystemManagementError("本地认证需要HTTPS或显式隔离回环配置", 1105, 403)

    def _origin(self, request):
        self._transport(request)
        if request.headers.get("origin") not in self.settings.allowed_origins or request.headers.get("sec-fetch-site") in ("cross-site", "same-site"):
            raise SystemManagementError("认证同源校验失败", 1105, 403)

    def _client_key(self, request):
        # 不信任客户端 X-Forwarded-For；代理识别由主会话的可信部署适配处理。
        peer = request.client.host if request.client else "unknown"
        return self.system.fingerprint("auth.client", "anonymous", {"peer": peer})

    def _challenge_key(self, request, token):
        return self.system.fingerprint("auth.challenge", "anonymous", {"peer": self._client_key(request), "binding": token})

    def _cookie(self, request, response, name, value, seconds):
        response.set_cookie(name, value, httponly=True, secure=request.url.scheme == "https",
                            samesite="strict", max_age=seconds, path="/")

    def _load(self, request, *, touch=True):
        self._transport(request)
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            raise SystemManagementError("需要正式本地登录", 1101, 401)
        if len(token) > 128:
            raise SystemManagementError("本地会话已失效", 1102, 401)
        now = int(self.clock())
        with self.factory() as session, session.begin():
            row = session.get(LocalIdentitySession, _digest(token))
            if row is None or row.revoked or row.expires_at <= now or row.last_seen + self.settings.idle_seconds <= now:
                raise SystemManagementError("本地会话已过期或撤销", 1102, 401)
            account = session.get(LocalAccount, row.account_id)
            credential = session.get(LocalCredential, row.account_id)
            if account is None or not account.enabled:
                raise SystemManagementError("本地账号已停用", 1103, 403)
            role = session.get(LocalRole, account.role_id)
            if role is None or credential is None or row.identity_revision != account.identity_revision:
                raise SystemManagementError("本地会话权限或凭据已变更", 1102, 401)
            identity = FormalIdentity(session_id=row.session_id, account_id=account.id, username=account.username,
                display_name=account.name, role_id=role.id, role_name=role.name, permissions=tuple(role.permissions),
                identity_revision=str(account.identity_revision), session_generation=row.generation)
            context = FormalSessionContext("FORMAL", "ACTIVE", "FORMAL_VERIFIED", source_reference="LOCAL_PASSWORD",
                identity=identity, expires_at=row.expires_at, csrf_token=row.csrf)
            if touch:
                row.last_seen = now
            session.flush()
            session.expunge(row)
            session.expunge(credential)
            return context, row, credential

    def session(self, request):
        self._transport(request)
        if not request.cookies.get(SESSION_COOKIE):
            return None
        context, _, _ = self._load(request)
        value = asdict(context.identity)
        value["permissions"] = list(value["permissions"])
        return value

    def require(self, request, permission: str | None = None, *, writing=False) -> SystemActor:
        context, row, credential = self._load(request)
        if writing:
            self._origin(request)
        try:
            identity = require_formal_access(context, FormalAccessRequest(
                request.method if writing else "GET", request.headers.get("x-session-id"),
                csrf_token=request.headers.get("x-csrf-token"), required_permissions=(permission,) if permission else ()),
                now=int(self.clock()), allowed_permissions=frozenset(self.system.registry))
        except ValueError as error:
            raise SystemManagementError(str(error), getattr(error, "code", 1001), getattr(error, "status", 422)) from None
        if credential.must_change_password and permission is not None:
            raise SystemManagementError("请先维护本人密码", 1104, 403, reason="PASSWORD_CHANGE_REQUIRED")
        return SystemActor(identity.account_id, identity.session_id, identity.identity_revision,
                           frozenset(identity.permissions), authenticated_at=row.created_at)

    def require_identity(self, request, permission: str | None = None, *, writing=False) -> dict:
        """供仍使用 dict 身份的宿主装配；不能绕过正式 require 检查。"""
        self.require(request, permission, writing=writing)
        return self.session(request)

    def challenge(self, request, response):
        self._transport(request)
        if request.cookies.get(SESSION_COOKIE):
            context, _, _ = self._load(request)
            return {"csrf_token": context.csrf_token, "session_id": context.identity.session_id}
        now = int(self.clock())
        with self.factory() as session, session.begin():
            self.system._lock(session)
            previous = request.cookies.get(CHALLENGE_COOKIE, "")
            if len(previous) > 128:
                previous = ""
            row = session.get(LocalIdentityChallenge, self._challenge_key(request, previous)) if previous else None
            if row and not row.used and row.expires_at > now and previous and secrets.compare_digest(row.token_hash, _digest(previous)):
                return {"csrf_token": row.csrf, "session_id": None}
            if row is None:
                # 已用/过期挑战是短期安全缓存，可原位复用；不删除记录或共用其他浏览器的有效挑战。
                row = session.scalar(select(LocalIdentityChallenge).where(LocalIdentityChallenge.used.is_(True) | (LocalIdentityChallenge.expires_at <= now)).limit(1))
                if row is None and session.scalar(select(func.count()).select_from(LocalIdentityChallenge)) >= self.settings.maximum_client_buckets:
                    raise SystemManagementError("认证挑战容量已满", 5002, 503)
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            if row is None:
                row = LocalIdentityChallenge(client_key=self._challenge_key(request, token))
                session.add(row)
            else:
                row.client_key = self._challenge_key(request, token)
            row.token_hash, row.csrf, row.used, row.expires_at = _digest(token), csrf, False, now + self.settings.challenge_seconds
            self._cookie(request, response, CHALLENGE_COOKIE, token, self.settings.challenge_seconds)
            return {"csrf_token": csrf, "session_id": None}

    def _throttle(self, session, key, now):
        row = session.get(LocalIdentityThrottle, key)
        if row is None:
            if session.scalar(select(func.count()).select_from(LocalIdentityThrottle)) >= self.settings.maximum_client_buckets * 2:
                raise SystemManagementError("认证限流容量已满", 5002, 503)
            row = LocalIdentityThrottle(key=key, failures=0, window_start=now, blocked_until=0)
            session.add(row)
        if row.blocked_until <= now and row.window_start + self.settings.failure_window_seconds <= now:
            row.failures, row.window_start, row.blocked_until = 0, now, 0
        return row

    def login(self, request, response, body):
        self._origin(request)
        value = parse_request(LocalLogin, body)
        if request.cookies.get(SESSION_COOKIE):
            self._load(request, touch=False)
            raise SystemManagementError("浏览器已有正式会话", 1107, 409)
        now, client = int(self.clock()), self._client_key(request)
        failure = None
        with self.factory() as session, session.begin():
            self.system._lock(session)
            self.system._state(session)
            token = request.cookies.get(CHALLENGE_COOKIE, "")
            challenge = session.get(LocalIdentityChallenge, self._challenge_key(request, token)) if token and len(token) <= 128 else None
            supplied = request.headers.get("x-csrf-token", "")
            if (challenge is None or challenge.used or challenge.expires_at <= now or not token
                    or not secrets.compare_digest(challenge.token_hash, _digest(token))
                    or not secrets.compare_digest(challenge.csrf.encode("utf-8"), supplied.encode("utf-8"))
                    or request.headers.get("x-session-id", "") != ""):
                raise SystemManagementError("匿名登录挑战无效", 1105, 403)
            challenge.used = True
            account = session.scalar(select(LocalAccount).where(LocalAccount.username == value.username))
            credential = session.get(LocalCredential, account.id) if account else None
            rows = [self._throttle(session, "peer:" + client, now)]
            if account:
                rows.append(self._throttle(session, "account:" + account.id, now))
            if any(row.blocked_until > now for row in rows):
                failure = SystemManagementError("认证请求过于频繁，请稍后重试", 1101, 429, reason="THROTTLED")
            else:
                valid = verify_password(value.password.get_secret_value(), credential.password_hash if credential else self._dummy_hash)
                if not valid or not account or not account.enabled or not credential:
                    for row in rows:
                        row.failures += 1
                        if row.failures >= self.settings.maximum_failures:
                            row.blocked_until = now + self.settings.lockout_seconds
                    failure = SystemManagementError("账号或密码无效", 1101, 401)
            if failure:
                append_system_audit(session, None, now=now, action="auth.login", outcome="DENIED", error_code="1101")
            else:
                for row in rows:
                    row.failures, row.blocked_until, row.window_start = 0, 0, now
                role = session.get(LocalRole, account.role_id)
                token, sid = secrets.token_urlsafe(32), uuid.uuid4().hex
                row = LocalIdentitySession(token_hash=_digest(token), session_id=sid, generation=uuid.uuid4().hex,
                    account_id=account.id, identity_revision=account.identity_revision, csrf=secrets.token_urlsafe(32),
                    created_at=now, last_seen=now, expires_at=now + self.settings.absolute_seconds, revoked=False)
                session.add(row)
                account.last_login = now
                actor = SystemActor(account.id, sid, str(account.identity_revision), frozenset(role.permissions), authenticated_at=now)
                append_system_audit(session, actor, now=now, action="auth.login", object_id=account.id)
                identity = FormalIdentity(sid, account.id, account.username, account.name, role.id, role.name,
                    tuple(role.permissions), str(account.identity_revision), row.generation)
                result = asdict(identity)
                result["permissions"] = list(identity.permissions)
        if failure:
            raise failure
        self._cookie(request, response, SESSION_COOKIE, token, self.settings.absolute_seconds)
        response.delete_cookie(CHALLENGE_COOKIE, path="/")
        return result

    def logout(self, request, response):
        self._origin(request)
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            try:
                actor = self.require(request, writing=True)
            except SystemManagementError as error:
                if error.code not in (1102, 1103):
                    raise
            else:
                with self.factory() as session, session.begin():
                    self.system._lock(session)
                    row = session.get(LocalIdentitySession, _digest(token))
                    row.revoked = True
                    append_system_audit(session, actor, now=int(self.clock()), action="auth.logout", object_id=actor.account_id)
        response.delete_cookie(SESSION_COOKIE, path="/")
        response.delete_cookie(CHALLENGE_COOKIE, path="/")
        return None

    def change_password(self, request, response, body):
        actor = self.require(request, writing=True)
        value = parse_request(OwnPassword, body)
        fingerprint = self.system.fingerprint("auth.password", actor.account_id, {
            "current": value.currentPassword.get_secret_value(), "new": value.newPassword.get_secret_value(), "requestId": value.requestId})
        with self.factory() as session, session.begin():
            self.system._lock(session)
            self.system.check_actor(session, actor)
            previous = session.scalar(select(SystemOperation).where(SystemOperation.actor_id == actor.account_id, SystemOperation.request_id == value.requestId))
            if previous:
                if not secrets.compare_digest(previous.fingerprint, fingerprint):
                    raise SystemManagementError("请求编号复用内容不同", 1206, 409)
                return previous.result
            credential = session.get(LocalCredential, actor.account_id)
            throttle = self._throttle(session, "account:" + actor.account_id, int(self.clock()))
            if throttle.blocked_until > int(self.clock()):
                raise SystemManagementError("认证请求过于频繁", 1101, 429, reason="THROTTLED")
            if not verify_password(value.currentPassword.get_secret_value(), credential.password_hash):
                # 失败计数需要独立提交，不能随异常回滚；由下方失败分支统一处理。
                failed = True
                throttle.failures += 1
                if throttle.failures >= self.settings.maximum_failures:
                    throttle.blocked_until = int(self.clock()) + self.settings.lockout_seconds
                append_system_audit(session, actor, now=int(self.clock()), action="auth.password", outcome="DENIED", error_code="1101")
            else:
                failed = False
                encoded = hash_password(value.newPassword.get_secret_value())
                credential.password_hash, credential.changed_at, credential.must_change_password = encoded, int(self.clock()), False
                credential.revision += 1
                account = session.get(LocalAccount, actor.account_id)
                account.identity_revision += 1
                state = self.system._state(session)
                state.revision += 1
                throttle.failures, throttle.blocked_until = 0, 0
                for row in session.scalars(select(LocalIdentitySession).where(LocalIdentitySession.account_id == actor.account_id)):
                    row.revoked = True
                append_system_audit(session, actor, now=int(self.clock()), action="auth.password", object_id=actor.account_id, request_id=value.requestId)
                result = dict(operationId="OP-" + uuid.uuid4().hex, objectId=actor.account_id, revision=self.system.revision(state), changed=True, reauthenticationRequired=True)
                session.add(SystemOperation(id=result["operationId"], actor_id=actor.account_id, request_id=value.requestId,
                    action="auth.password", fingerprint=fingerprint, permission="", result=result, created_at=int(self.clock())))
        if failed:
            raise SystemManagementError("当前密码无效", 1101, 401)
        response.delete_cookie(SESSION_COOKIE, path="/")
        return result
