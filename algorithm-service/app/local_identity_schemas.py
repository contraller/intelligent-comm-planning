"""正式本地认证请求；敏感值不进入 repr 或错误数据。"""
from dataclasses import dataclass

from pydantic import Field, SecretStr

from .system_management_schemas import StrictRequest, Text, Username


class LocalLogin(StrictRequest):
    username: Username
    password: SecretStr = Field(repr=False)


class OwnPassword(StrictRequest):
    requestId: Text
    currentPassword: SecretStr = Field(repr=False)
    newPassword: SecretStr = Field(repr=False)


class EmptyRequest(StrictRequest):
    pass


@dataclass(frozen=True, slots=True)
class LocalIdentitySettings:
    allowed_origins: frozenset[str]
    allow_insecure_loopback: bool = False
    absolute_seconds: int = 8 * 3600
    idle_seconds: int = 30 * 60
    challenge_seconds: int = 300
    failure_window_seconds: int = 300
    maximum_failures: int = 5
    lockout_seconds: int = 300
    maximum_client_buckets: int = 512

    def __post_init__(self):
        from urllib.parse import urlsplit
        if type(self.allow_insecure_loopback) is not bool:
            raise ValueError("回环例外必须使用显式布尔配置")
        if type(self.allowed_origins) is not frozenset or not self.allowed_origins:
            raise ValueError("必须显式配置允许的同源地址")
        for origin in self.allowed_origins:
            parsed = urlsplit(origin)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("同源地址配置无效")
        for value in (self.absolute_seconds, self.idle_seconds, self.challenge_seconds,
                      self.failure_window_seconds, self.maximum_failures, self.lockout_seconds, self.maximum_client_buckets):
            if type(value) is not int or value <= 0:
                raise ValueError("认证期限及限流必须为正整数")
