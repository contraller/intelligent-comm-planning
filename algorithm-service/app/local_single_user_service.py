"""受控回环环境的统一使用入口；真实会话、全权限和可追溯来源。"""
from __future__ import annotations

import ipaddress
import secrets
import uuid

from sqlalchemy import select

from .local_identity_models import LocalIdentitySession
from .local_identity_service import CHALLENGE_COOKIE, SESSION_COOKIE, LocalIdentityService, _digest
from .local_password_service import hash_password
from .system_audit_service import append_system_audit
from .system_management_models import LocalAccount, LocalCredential, LocalRole
from .system_management_schemas import SystemActor, SystemManagementError

SINGLE_ACCOUNT_ID = "ACC-LOCAL-SINGLE-USER"
SINGLE_ROLE_ID = "ROLE-LOCAL-SINGLE-USER"
SINGLE_USERNAME = "local_single_user"
SINGLE_ROLE_DESCRIPTION = "受控本地单用户入口；由运行模式管理"


class LocalSingleUserService(LocalIdentityService):
    auth_mode = "LOCAL_SINGLE_USER"

    def _transport(self, request):
        super()._transport(request)
        try:
            local = ipaddress.ip_address(request.url.hostname).is_loopback
            peer = request.client is not None and ipaddress.ip_address(request.client.host).is_loopback
        except ValueError:
            local = peer = False
        origin = str(request.url.replace(path="", query="", fragment="")).rstrip("/")
        if (not local or not peer or origin not in self.settings.allowed_origins
                or request.headers.get("sec-fetch-site") in ("cross-site", "same-site")
                or request.headers.get("origin") not in (None, *self.settings.allowed_origins)):
            raise SystemManagementError("统一使用入口仅允许受控本机同源访问", 1105, 403)

    def capabilities(self, request=None):
        if request is not None:
            self._transport(request)
        result = super().capabilities(request)
        return {**result, "authMode": self.auth_mode, "passwordChangeRequired": False,
                "capabilities": {"passwordMaintenance": False, "anonymousRecovery": False,
                                 "automaticLocalSession": True, "unifiedPermissions": True, "selfReview": True}}

    def _load(self, request, *, touch=True):
        context, row, credential = super()._load(request, touch=touch)
        if (context.identity.account_id != SINGLE_ACCOUNT_ID or context.identity.role_id != SINGLE_ROLE_ID
                or frozenset(context.identity.permissions) != frozenset(self.system.registry)):
            raise SystemManagementError("会话不属于当前本地统一入口", 1102, 401)
        return context, row, credential

    def session(self, request):
        result = super().session(request)
        return ({**result, "auth_source": self.auth_mode, "single_user_mode": True, "allow_self_review": True}
                if result is not None else None)

    def _managed_account(self, session, now):
        state = self.system._state(session)
        account, role = session.get(LocalAccount, SINGLE_ACCOUNT_ID), session.get(LocalRole, SINGLE_ROLE_ID)
        if account is None and role is None:
            if session.scalar(select(LocalAccount).where(LocalAccount.username == SINGLE_USERNAME)) is not None:
                raise SystemManagementError("本地统一入口名称冲突，请保留原数据并检查配置", 5001, 503)
            role = LocalRole(id=SINGLE_ROLE_ID, name="本地全部功能", description=SINGLE_ROLE_DESCRIPTION,
                             permissions=sorted(self.system.registry))
            session.add(role)
            session.flush()
            account = LocalAccount(id=SINGLE_ACCOUNT_ID, username=SINGLE_USERNAME, name="本地使用者", department="本机",
                                   role_id=SINGLE_ROLE_ID, enabled=True, identity_revision=1, last_login=None)
            session.add(account)
            session.flush()
            # 随机不可恢复凭据只满足现有账号完整性；免登录会话不验证或导出该值。
            session.add(LocalCredential(account_id=SINGLE_ACCOUNT_ID, password_hash=hash_password(secrets.token_urlsafe(48)),
                                        must_change_password=False, revision=1, changed_at=now))
            state.revision += 1
            append_system_audit(session, None, now=now, action="auth.local_identity.create", object_id=SINGLE_ACCOUNT_ID,
                                changes={"authSource": self.auth_mode, "unifiedPermissions": True, "selfReview": True})
        elif (account is None or role is None or account.username != SINGLE_USERNAME or account.role_id != SINGLE_ROLE_ID
              or not account.enabled or role.description != SINGLE_ROLE_DESCRIPTION
              or set(role.permissions) != set(self.system.registry)
              or session.get(LocalCredential, SINGLE_ACCOUNT_ID) is None):
            raise SystemManagementError("本地统一入口记录不完整或权限目录已变化，请保留数据并检查配置", 5001, 503)
        return account

    def browser_session(self, request, response):
        self._transport(request)
        if request.cookies.get(SESSION_COOKIE):
            try:
                return self.session(request)
            except SystemManagementError as error:
                if error.code != 1102:
                    raise
        now = int(self.clock())
        with self.factory() as session, session.begin():
            self.system._lock(session)
            account = self._managed_account(session, now)
            token, sid = secrets.token_urlsafe(32), uuid.uuid4().hex
            session.add(LocalIdentitySession(token_hash=_digest(token), session_id=sid, generation=uuid.uuid4().hex,
                account_id=account.id, identity_revision=account.identity_revision, csrf=secrets.token_urlsafe(32),
                created_at=now, last_seen=now, expires_at=now + self.settings.absolute_seconds, revoked=False))
            account.last_login = now
            actor = SystemActor(account.id, sid, str(account.identity_revision), frozenset(self.system.registry),
                                auth_source=self.auth_mode, authenticated_at=now)
            append_system_audit(session, actor, now=now, action="auth.local_session", object_id=account.id,
                                changes={"authSource": self.auth_mode, "unifiedPermissions": True, "selfReview": True})
        self._cookie(request, response, SESSION_COOKIE, token, self.settings.absolute_seconds)
        response.delete_cookie(CHALLENGE_COOKIE, path="/")
        # 新Cookie只有响应之后才进入浏览器；用数据库记录构造相同可信身份，无客户端身份输入。
        from dataclasses import asdict
        from .formal_identity_schemas import FormalIdentity
        with self.factory() as session:
            row = session.get(LocalIdentitySession, _digest(token))
            value = asdict(FormalIdentity(sid, SINGLE_ACCOUNT_ID, SINGLE_USERNAME, "本地使用者", SINGLE_ROLE_ID,
                           "本地全部功能", tuple(sorted(self.system.registry)), str(row.identity_revision), row.generation))
        return {**value, "permissions": list(value["permissions"]), "auth_source": self.auth_mode,
                "single_user_mode": True, "allow_self_review": True}

    def login(self, request, response, body):
        self._transport(request)
        raise SystemManagementError("当前使用本地统一入口，请重新读取会话", 1104, 403)

    def change_password(self, request, response, body):
        self.require(request, writing=True)
        raise SystemManagementError("本地统一入口无需维护登录密码", 1104, 403)
