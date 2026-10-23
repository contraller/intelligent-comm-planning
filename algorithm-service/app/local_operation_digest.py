"""绑定已验证的本地主体；调用方负责权限检查，LOCAL不得回退旧摘要。"""
from __future__ import annotations

import hashlib
import json
import re


_OPERATIONS = frozenset({
    "task.save", "planning.submit", "planning.cancel", "plan.save", "plan.confirm",
})


def bind_local_operation_digest(body_digest: str, *, operation: str, account_id: str) -> str:
    """account_id仅接受调用方可信actor的ID，不接收客户端自报身份。"""
    if type(body_digest) is not str or re.fullmatch(r"[0-9a-f]{64}", body_digest) is None:
        raise ValueError("body_digest must be a lowercase SHA-256 hex string")
    if type(operation) is not str or operation not in _OPERATIONS:
        raise ValueError("unsupported local operation")
    if (type(account_id) is not str or not 1 <= len(account_id) <= 120
            or account_id != account_id.strip()
            or any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF
                   for char in account_id)):
        raise ValueError("invalid trusted local account identifier")
    raw = json.dumps({
        "scheme": "local-owner-v1", "operation": operation,
        "account_id": account_id, "body_digest": body_digest,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()
