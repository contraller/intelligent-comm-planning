"""使用现有 OpenSSL scrypt，不生成默认口令，不允许记录密码或摘要。"""
from __future__ import annotations

import base64
import hashlib
import secrets
import threading

from .system_management_schemas import SystemManagementError

N, R, P, DKLEN = 131072, 8, 1, 32
MAXMEM = 256 * 1024 * 1024
MIN_PASSWORD_SCALARS = 8
MAX_PASSWORD_SCALARS = 128
_SLOTS = threading.BoundedSemaphore(2)


def password_bytes(password: object) -> bytes:
    if (type(password) is not str or not MIN_PASSWORD_SCALARS <= len(password) <= MAX_PASSWORD_SCALARS
            or "\x00" in password or any(0xD800 <= ord(c) <= 0xDFFF for c in password)):
        raise SystemManagementError("密码须为8至128个字符，不能含无效编码")
    value = password.encode("utf-8")
    if len(value) > 1024:
        raise SystemManagementError("密码编码超出允许长度")
    return value


def _derive(password: bytes, salt: bytes) -> bytes:
    if not _SLOTS.acquire(blocking=False):
        raise SystemManagementError("密码验证繁忙，请稍后重试", 5002, 503)
    try:
        return hashlib.scrypt(password, salt=salt, n=N, r=R, p=P, dklen=DKLEN, maxmem=MAXMEM)
    except (ValueError, MemoryError):
        raise SystemManagementError("密码验证资源不可用", 5002, 503) from None
    finally:
        _SLOTS.release()


def hash_password(password: str) -> str:
    value, salt = password_bytes(password), secrets.token_bytes(16)
    result = _derive(value, salt)
    return "$".join(("scrypt-v1", str(N), str(R), str(P), base64.b64encode(salt).decode("ascii"), base64.b64encode(result).decode("ascii")))


def verify_password(password: str, encoded: str) -> bool:
    try:
        value = password_bytes(password)
        if type(encoded) is not str or len(encoded) > 200:
            return False
        version, n, r, p, salt_text, digest_text = encoded.split("$")
        if (version, n, r, p) != ("scrypt-v1", str(N), str(R), str(P)):
            return False
        salt = base64.b64decode(salt_text, validate=True)
        digest = base64.b64decode(digest_text, validate=True)
        if len(salt) != 16 or len(digest) != DKLEN:
            return False
    except (ValueError, TypeError, SystemManagementError):
        return False
    return secrets.compare_digest(_derive(value, salt), digest)
