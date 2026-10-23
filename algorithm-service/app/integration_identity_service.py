"""独立联调身份、会话和服务端权限检查。"""
from __future__ import annotations

import hashlib
import secrets
import time

from fastapi import Request, Response

from . import frontend_integration as baseline
from .database import get_session_factory
from .integration_identity_models import IntegrationSession

COOKIE = "radio_integration_session"
READ = ["planning.view", "resources.view", "situation.view", "diagnosis.view", "knowledge.view"]
CATALOG = {
    "integration-planner": ("联调规划员", "PLANNER", baseline.session_identity()["permissions"]),
    # 频点停用使用专项权限，不开放整库编辑。
    "integration-editor": ("联调编辑者", "EDITOR", READ + ["resources.device.edit", "resources.device.availability", "resources.frequency.disable", "diagnosis.scenario", "diagnosis.execute", "diagnosis.export", "knowledge.edit"]),
    "integration-reviewer": ("联调审核者", "REVIEWER", READ + ["diagnosis.export", "knowledge.review", "knowledge.publish", "knowledge.rollback"]),
}


class IdentityError(ValueError):
    def __init__(self, message: str, code: int = 1104, status: int = 403):
        super().__init__(message)
        self.code, self.status = code, status


def enabled() -> None:
    if not baseline.integration_enabled():
        raise IdentityError("联调模式未开启", 1101, 401)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def current(request: Request) -> dict:
    enabled()
    token = request.cookies.get(COOKIE)
    if not token:
        return {**baseline.session_identity(), "integration_mode": True}
    with get_session_factory()() as session:
        row = session.get(IntegrationSession, _digest(token))
        if row is None or not row.active or row.expires_at <= time.time():
            raise IdentityError("联调会话已失效，请重新读取身份", 1106, 409)
        account = row.account_id
        name, role, permissions = CATALOG[account]
        return {"session_id": row.session_id, "account_id": account, "username": account,
                "display_name": name, "role_id": "integration-" + role.lower(),
                "role_name": name, "permissions": permissions,
                "identity_revision": "integration-workflow-v2",
                "session_generation": row.session_id, "integration_mode": True}


def challenge(request: Request) -> dict:
    identity = current(request)
    token = request.cookies.get(COOKIE)
    if not token:
        return baseline.csrf_challenge()
    with get_session_factory()() as session:
        row = session.get(IntegrationSession, _digest(token))
        return {"csrf_token": row.csrf, "session_id": identity["session_id"]}


def require(request: Request, permission: str | None = None, *, writing=False) -> dict:
    identity = current(request)
    supplied = request.headers.get("x-session-id")
    if writing or supplied:
        if supplied != identity["session_id"]:
            raise IdentityError("请求会话已变化", 1106, 409)
    if writing and not secrets.compare_digest(request.headers.get("x-csrf-token", ""), challenge(request)["csrf_token"]):
        raise IdentityError("联调 CSRF 校验失败", 1105, 403)
    if permission and permission not in identity["permissions"]:
        raise IdentityError("当前联调身份无此操作权限")
    return identity


def catalog(request: Request) -> dict:
    identity = current(request)
    return {"accounts": [{"id": key, "name": value[0], "role": value[1]} for key, value in CATALOG.items()],
            "currentId": identity["account_id"], "dataOrigin": "SYNTHETIC_INTEGRATION"}


def switch(request: Request, response: Response, account_id: str) -> dict:
    require(request, writing=True)
    if account_id not in CATALOG:
        raise IdentityError("未知联调身份", 1001, 422)
    token, sid, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    with get_session_factory().begin() as session:
        old = request.cookies.get(COOKIE)
        if old and (row := session.get(IntegrationSession, _digest(old))):
            row.active = False
        session.add(IntegrationSession(token_hash=_digest(token), session_id=sid,
                    account_id=account_id, csrf=csrf, active=True, expires_at=time.time() + 43200))
    response.set_cookie(COOKIE, token, httponly=True, samesite="strict", secure=request.url.scheme == "https", max_age=43200, path="/")
    name, role, permissions = CATALOG[account_id]
    return {"session_id": sid, "account_id": account_id, "username": account_id,
            "display_name": name, "role_id": "integration-" + role.lower(), "role_name": name,
            "permissions": permissions, "identity_revision": "integration-workflow-v2",
            "session_generation": sid, "integration_mode": True}
