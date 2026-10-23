"""不签发身份、不读取外部状态的正式会话纯策略。"""
from __future__ import annotations

from dataclasses import fields
from secrets import compare_digest

from .formal_identity_schemas import (
    CONTRACT_VERSION,
    FormalAccessRequest,
    FormalIdentity,
    FormalSessionContext,
)


class FormalIdentityPolicyError(ValueError):
    def __init__(self, message: str, code: int = 1001, status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status


_IDENTITY_FIELDS = frozenset(item.name for item in fields(FormalIdentity))
_STRING_FIELDS = (
    "session_id", "account_id", "username", "display_name", "role_id", "role_name",
    "identity_revision", "session_generation",
)
_MODES = frozenset(("ANONYMOUS", "FORMAL", "INTEGRATION", "UNKNOWN"))
_STATES = frozenset(("ANONYMOUS", "ACTIVE", "EXPIRED", "DISABLED", "REVOKED", "UNKNOWN"))
_ORIGINS = frozenset(("FORMAL_VERIFIED", "SYNTHETIC_INTEGRATION", "UNKNOWN"))
_METHODS = frozenset(("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"))
_READ_METHODS = frozenset(("GET", "HEAD"))


def _valid_string(value: object) -> bool:
    return (
        type(value) is str
        and 1 <= len(value) <= 512
        and value == value.strip()
        and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)
    )


def _invalid(field_name: str) -> None:
    raise FormalIdentityPolicyError(f"正式身份边界字段无效：{field_name}")


def _optional_string(value: object, field_name: str) -> None:
    if value is not None and not _valid_string(value):
        _invalid(field_name)


def _integer(value: object) -> bool:
    return type(value) is int and value >= 0


def _allowed_permissions(value: object) -> None:
    if type(value) is not frozenset or any(not _valid_string(p) for p in value):
        _invalid("allowed_permissions")


def _permission_sequence(value: object, sequence_type: type) -> None:
    if type(value) is not sequence_type or any(not _valid_string(p) for p in value):
        _invalid("permissions")
    if len(value) != len(set(value)):
        _invalid("permissions")


def validate_formal_identity(
    value: object, *, allowed_permissions: frozenset[str]
) -> FormalIdentity:
    _allowed_permissions(allowed_permissions)
    if type(value) is FormalIdentity:
        payload = {item.name: getattr(value, item.name) for item in fields(FormalIdentity)}
        _permission_sequence(payload["permissions"], tuple)
    elif type(value) is dict and value.keys() == _IDENTITY_FIELDS:
        payload = value
        _permission_sequence(payload["permissions"], list)
    else:
        _invalid("identity")

    if payload["contract_version"] != CONTRACT_VERSION or type(payload["contract_version"]) is not str:
        _invalid("contract_version")
    if payload["integration_mode"] is not False or payload["data_origin"] != "FORMAL_VERIFIED":
        _invalid("identity_origin")
    if type(payload["data_origin"]) is not str:
        _invalid("data_origin")
    for name in _STRING_FIELDS:
        if not _valid_string(payload[name]):
            _invalid(name)
    if any(p not in allowed_permissions for p in payload["permissions"]):
        _invalid("permissions")
    if type(value) is FormalIdentity:
        return value
    return FormalIdentity(**{**payload, "permissions": tuple(payload["permissions"])})


def _context_structure(context: FormalSessionContext) -> None:
    if type(context) is not FormalSessionContext:
        _invalid("context")
    if type(context.contract_version) is not str or context.contract_version != CONTRACT_VERSION:
        _invalid("contract_version")
    for name, choices in (("mode", _MODES), ("state", _STATES), ("data_origin", _ORIGINS)):
        value = getattr(context, name)
        if type(value) is not str or value not in choices:
            _invalid(name)
    for name in ("source_reference", "csrf_token"):
        _optional_string(getattr(context, name), name)
    if context.identity is not None and type(context.identity) is not FormalIdentity:
        _invalid("identity")
    if context.expires_at is not None and not _integer(context.expires_at):
        _invalid("expires_at")


def resolve_formal_session(
    context: FormalSessionContext, *, now: int, allowed_permissions: frozenset[str]
) -> FormalIdentity | None:
    _allowed_permissions(allowed_permissions)
    if not _integer(now):
        _invalid("now")
    _context_structure(context)
    if context.mode == "ANONYMOUS":
        if (
            context.state != "ANONYMOUS" or context.data_origin != "UNKNOWN"
            or any(value is not None for value in (
                context.source_reference, context.identity, context.expires_at, context.csrf_token
            ))
        ):
            _invalid("anonymous_context")
        return None
    if context.mode != "FORMAL" or context.data_origin != "FORMAL_VERIFIED":
        raise FormalIdentityPolicyError("联调或未知来源不能作为正式身份", 1101, 401)
    if (
        context.source_reference is None or context.identity is None or context.expires_at is None
        or context.state not in ("ACTIVE", "EXPIRED", "DISABLED", "REVOKED")
    ):
        _invalid("formal_context")
    if context.state == "DISABLED":
        raise FormalIdentityPolicyError("正式身份已停用", 1103, 403)
    if context.state in ("EXPIRED", "REVOKED") or context.expires_at <= now:
        raise FormalIdentityPolicyError("正式会话已过期或撤销", 1102, 401)
    return validate_formal_identity(context.identity, allowed_permissions=allowed_permissions)


def require_formal_access(
    context: FormalSessionContext, access: FormalAccessRequest,
    *, now: int, allowed_permissions: frozenset[str]
) -> FormalIdentity:
    if type(access) is not FormalAccessRequest:
        _invalid("access")
    if type(access.method) is not str or access.method not in _METHODS:
        _invalid("method")
    for name in ("session_id", "session_generation", "csrf_token"):
        _optional_string(getattr(access, name), name)
    _permission_sequence(access.required_permissions, tuple)
    identity = resolve_formal_session(context, now=now, allowed_permissions=allowed_permissions)
    if identity is None:
        raise FormalIdentityPolicyError("正式访问需要已验证身份", 1101, 401)
    writing = access.method not in _READ_METHODS
    if (
        (writing or access.session_id is not None) and access.session_id != identity.session_id
        or access.session_generation is not None and access.session_generation != identity.session_generation
    ):
        raise FormalIdentityPolicyError("正式会话关联或代次已变化", 1106, 409)
    if writing:
        # 字符串已排除孤立代理项；UTF-8 字节比较明确支持非 ASCII 令牌。
        if (
            context.csrf_token is None or access.csrf_token is None
            or not compare_digest(context.csrf_token.encode("utf-8"), access.csrf_token.encode("utf-8"))
        ):
            raise FormalIdentityPolicyError("正式会话 CSRF 校验失败", 1105, 403)
    if any(p not in allowed_permissions or p not in identity.permissions for p in access.required_permissions):
        raise FormalIdentityPolicyError("正式身份无所需权限", 1104, 403)
    return identity
