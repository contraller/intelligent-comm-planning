"""正式身份边界的数据对象；只表达可信适配器提供的事实。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


CONTRACT_VERSION = "formal-identity-boundary-0.1"


@dataclass(frozen=True, slots=True)
class FormalIdentity:
    session_id: str
    account_id: str
    username: str
    display_name: str
    role_id: str
    role_name: str
    permissions: tuple[str, ...]
    identity_revision: str
    session_generation: str
    contract_version: str = CONTRACT_VERSION
    integration_mode: Literal[False] = False
    data_origin: Literal["FORMAL_VERIFIED"] = "FORMAL_VERIFIED"


@dataclass(frozen=True, slots=True)
class FormalSessionContext:
    """仅由服务端适配器构造，来源标记本身不是身份验证证据。"""

    mode: Literal["ANONYMOUS", "FORMAL", "INTEGRATION", "UNKNOWN"]
    state: Literal["ANONYMOUS", "ACTIVE", "EXPIRED", "DISABLED", "REVOKED", "UNKNOWN"]
    data_origin: Literal["FORMAL_VERIFIED", "SYNTHETIC_INTEGRATION", "UNKNOWN"]
    source_reference: str | None = None
    identity: FormalIdentity | None = None
    expires_at: int | None = None
    csrf_token: str | None = field(default=None, repr=False)
    contract_version: str = CONTRACT_VERSION


@dataclass(frozen=True, slots=True)
class FormalAccessRequest:
    method: Literal["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
    session_id: str | None = None
    session_generation: str | None = None
    csrf_token: str | None = field(default=None, repr=False)
    required_permissions: tuple[str, ...] = ()
