"""少量真实 scrypt 成本验证；不降低生产参数。"""
import secrets
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from app.local_password_service import N, P, R, hash_password, password_bytes, verify_password
from app.system_management_schemas import SystemManagementError


def test_real_scrypt_random_salts_unicode_and_wrong_password():
    password = "明确Unicode口令-" + secrets.token_urlsafe(20)
    first, second = hash_password(password), hash_password(password)
    assert first != second
    assert (N, R, P) == (131072, 8, 1)
    assert verify_password(password, first)
    assert not verify_password(password + "x", first)
    assert password not in first


@pytest.mark.parametrize("value", [None, False, 1, "short", "x" * 7, "x" * 129, "a" * 8 + "\x00", "a" * 8 + "\ud800"])
def test_invalid_password_rejected_before_hashing(value):
    with pytest.raises(SystemManagementError):
        password_bytes(value)


def test_eight_character_password_hash_and_verify():
    password = "Abcd1234"
    encoded = hash_password(password)
    assert verify_password(password, encoded)
    assert not verify_password("Abcd1235", encoded)


@pytest.mark.parametrize("size", [8, 128])
def test_password_length_boundaries(size):
    assert password_bytes("a" * size) == b"a" * size


def test_password_bytes_preserve_spaces_and_unicode_without_normalization():
    assert password_bytes(" " + "a" * 15 + " ") == (" " + "a" * 15 + " ").encode()
    assert password_bytes("é" + "a" * 15) != password_bytes("e\u0301" + "a" * 15)


@pytest.mark.parametrize("encoded", ["", "scrypt-v9$131072$8$1$bad$bad", "scrypt-v1$999999999$8$1$a$b", "scrypt-v1$131072$8$1$!!!!$!!!!", "x" * 201, None])
def test_damaged_or_unbounded_hash_records_fail_closed(encoded):
    assert not verify_password("a-valid-long-password", encoded)
