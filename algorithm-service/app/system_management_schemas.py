"""系统管理专用契约；不接受客户端提交的操作者或成功证明。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints, ValidationError

Text = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=120)]
Name = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=40)]
Username = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_.-]{2,31}$")]
ADMIN_PERMISSIONS = frozenset(("system.view", "system.accounts", "system.roles", "system.parameters", "system.logs", "system.reset"))


class SystemManagementError(ValueError):
    def __init__(self, message: str, code: int = 1001, status: int = 422, *, reason: str = "", data=None):
        super().__init__(message)
        self.code, self.status = code, status
        self.data = data if data is not None else ({"reason": reason} if reason else None)


@dataclass(frozen=True, slots=True)
class SystemActor:
    account_id: str
    session_id: str
    identity_revision: str
    permissions: frozenset[str]
    auth_source: str = "LOCAL_PASSWORD"
    authenticated_at: int = 0


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class Mutation(StrictRequest):
    baseRevision: Text
    requestId: Text


class AccountProfile(StrictRequest):
    name: Name
    department: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=60)]
    roleId: Text


class NewAccountProfile(AccountProfile):
    username: Username


class AccountCreate(Mutation):
    account: NewAccountProfile
    initialPassword: SecretStr = Field(repr=False)


class AccountUpdate(Mutation):
    account: AccountProfile


class AccountState(Mutation):
    enabled: bool


class AccountPassword(Mutation):
    newPassword: SecretStr = Field(repr=False)
    operatorPassword: SecretStr = Field(repr=False)


class RoleProfile(StrictRequest):
    name: Name
    description: Annotated[str, StringConstraints(strict=True, max_length=200)]
    permissions: list[Text]


class RoleSave(Mutation):
    role: RoleProfile


class ParameterSave(Mutation):
    value: int | str


class ParameterReset(Mutation):
    parameterIds: list[Text] = Field(min_length=1, max_length=3)
    reason: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=200)]
    confirm: Literal["RESTORE_PARAMETER_DEFAULTS"]


class AuditArchive(StrictRequest):
    baseAuditRevision: Text
    requestId: Text
    throughSequence: int = Field(ge=0)
    reason: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=200)]
    confirm: Literal["ARCHIVE_LOG_VIEW"]


T = TypeVar("T", bound=StrictRequest)


def parse_request(schema: type[T], value: object) -> T:
    try:
        return schema.model_validate(value)
    except ValidationError as error:
        # Pydantic 的默认 errors() 含 input；认证/管理路径只返回字段及错误类型。
        issues = [{"field": ".".join(map(str, item["loc"])), "type": item["type"]}
                  for item in error.errors(include_input=False, include_context=False, include_url=False)]
        raise SystemManagementError("请求字段无效", data={"fields": issues}) from None


def safe_text(value: object, *, maximum: int = 120, empty: bool = False) -> str:
    if (type(value) is not str or len(value) > maximum or (not value and not empty)
            or value != value.strip() or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise SystemManagementError("文本字段无效")
    return value
