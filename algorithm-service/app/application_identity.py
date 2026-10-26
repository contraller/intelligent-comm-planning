"""公共入口显式安装工厂；不开户、不建表，不在配置失败时回退到联调。"""
from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
import re
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from .system_management_schemas import SystemManagementError

if TYPE_CHECKING:
    from .local_identity_schemas import LocalIdentitySettings
    from .local_identity_service import LocalIdentityAdapter


def _invalid(field: str):
    # 不链接底层解析异常，防止其repr或traceback回显原始配置值。
    raise SystemManagementError("本地身份配置无效：" + field, 5001, 503, reason="IDENTITY_CONFIGURATION") from None


def _mode() -> str:
    demo = os.environ.get("FRONTEND_INTEGRATION_DEMO") == "1"
    mode = os.environ.get("AUTH_MODE", "INTEGRATION" if demo else "OFF")
    if mode not in ("OFF", "INTEGRATION", "LOCAL_PASSWORD"):
        _invalid("AUTH_MODE")
    if mode == "LOCAL_PASSWORD" and demo or mode == "INTEGRATION" and not demo:
        _invalid("AUTH_MODE/FRONTEND_INTEGRATION_DEMO")
    return mode


def _origin(value: object, allow_loopback: bool) -> str:
    field = "LOCAL_IDENTITY_ALLOWED_ORIGINS"
    if (type(value) is not str or not value or len(value) > 512 or not value.isascii()
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)):
        _invalid(field)
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
    except (TypeError, ValueError):
        _invalid(field)
    if (parsed.scheme not in ("http", "https") or not host or parsed.username is not None
            or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
            or port is not None and not 1 <= port <= 65535 or "%" in host):
        _invalid(field)
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
        labels = host.split(".")
        if (len(host) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
                or re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*", host)):
            _invalid(field)
        canonical_host = host
    else:
        canonical_host = "[" + address.compressed + "]" if address.version == 6 else str(address)
    default_port = 443 if parsed.scheme == "https" else 80
    canonical = parsed.scheme + "://" + canonical_host + (":" + str(port) if port is not None and port != default_port else "")
    if value != canonical or parsed.scheme == "http" and not (allow_loopback and address is not None and address.is_loopback):
        _invalid(field)
    return value


def _settings(explicit):
    from .local_identity_schemas import LocalIdentitySettings
    if explicit is not None:
        if not isinstance(explicit, LocalIdentitySettings):
            _invalid("settings")
        settings = explicit
    else:
        flag = os.environ.get("LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK", "0")
        if flag not in ("0", "1"):
            _invalid("LOCAL_IDENTITY_ALLOW_INSECURE_LOOPBACK")
        try:
            values = json.loads(os.environ.get("LOCAL_IDENTITY_ALLOWED_ORIGINS", ""))
        except (ValueError, TypeError):
            _invalid("LOCAL_IDENTITY_ALLOWED_ORIGINS")
        if type(values) is not list or not 1 <= len(values) <= 64 or any(type(v) is not str for v in values):
            _invalid("LOCAL_IDENTITY_ALLOWED_ORIGINS")
        if len(set(values)) != len(values):
            _invalid("LOCAL_IDENTITY_ALLOWED_ORIGINS")
        origins = frozenset(_origin(v, flag == "1") for v in values)
        settings = LocalIdentitySettings(allowed_origins=origins, allow_insecure_loopback=flag == "1")
    if not 1 <= len(settings.allowed_origins) <= 64:
        _invalid("LOCAL_IDENTITY_ALLOWED_ORIGINS")
    for origin in settings.allowed_origins:
        _origin(origin, settings.allow_insecure_loopback)
    return settings


def _key(explicit):
    if explicit is not None:
        if type(explicit) is not bytes or len(explicit) < 32:
            _invalid("request_key")
        return explicit
    encoded = os.environ.get("LOCAL_IDENTITY_REQUEST_KEY", "")
    try:
        key = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError, binascii.Error):
        _invalid("LOCAL_IDENTITY_REQUEST_KEY")
    if len(key) < 32 or base64.b64encode(key).decode("ascii") != encoded:
        _invalid("LOCAL_IDENTITY_REQUEST_KEY")
    return key


def install_local_identity(app, *, session_factory=None, settings: LocalIdentitySettings | None = None,
                           request_key: bytes | None = None) -> LocalIdentityAdapter | None:
    mode = _mode()
    if getattr(app.state, "local_identity_adapter", None) is not None:
        _invalid("local_identity_adapter重复安装")
    if mode != "LOCAL_PASSWORD":
        # main的公共分流应尊重显式OFF，不能只凭DEMO开关继续返回联调身份。
        app.state.auth_mode = mode
        return None
    local_settings, secret = _settings(settings), _key(request_key)
    from .database import DatabaseConfigurationError, get_session_factory
    from .local_identity_router import create_local_identity_router
    from .local_identity_service import LocalIdentityAdapter, LocalIdentityService
    from .permission_registry import SERVER_PERMISSION_REGISTRY
    from .system_management_router import create_system_management_router
    from .system_management_service import SystemManagementService
    from sqlalchemy.exc import SQLAlchemyError

    try:
        factory = session_factory if session_factory is not None else get_session_factory()
    except (DatabaseConfigurationError, SQLAlchemyError, TypeError, ValueError):
        _invalid("DATABASE_URL/session_factory")
    if not callable(factory):
        _invalid("session_factory")
    system = SystemManagementService(session_factory=factory, permission_registry=SERVER_PERMISSION_REGISTRY, request_key=secret)
    local = LocalIdentityService(system_service=system, settings=local_settings)

    class InstalledAdapter(LocalIdentityAdapter):
        @property
        def delegate(self) -> LocalIdentityAdapter:
            return self

    adapter = InstalledAdapter(service=local)
    auth_router = create_local_identity_router(service=local)
    system_router = create_system_management_router(authorize=adapter.require_actor, service=system)
    expected = {route.path for router in (auth_router, system_router) for route in router.routes}
    if any(getattr(route, "path", None) in expected for route in app.routes):
        _invalid("local路由顺序或重复路径")
    app.include_router(auth_router)
    app.include_router(system_router)
    app.state.local_identity_adapter = adapter
    app.state.system_management = system
    app.state.auth_mode = mode
    return adapter
