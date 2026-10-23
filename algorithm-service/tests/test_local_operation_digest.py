import ast
import hashlib
from pathlib import Path

import pytest

from app.local_operation_digest import bind_local_operation_digest


BODY = "a" * 64
OPERATIONS = ("task.save", "planning.submit", "planning.cancel", "plan.save", "plan.confirm")


def test_exact_local_owner_v1_canonical_bytes():
    raw = (b'{"account_id":"ACC-01","body_digest":"' + BODY.encode("ascii")
           + b'","operation":"task.save","scheme":"local-owner-v1"}')
    result = bind_local_operation_digest(BODY, operation="task.save", account_id="ACC-01")
    assert result == hashlib.sha256(raw).hexdigest()
    assert len(result) == 64
    assert set(result) <= set("0123456789abcdef")
    assert result != BODY


def test_fixed_operation_domains_are_distinct_and_stable():
    results = {bind_local_operation_digest(BODY, operation=op, account_id="ACC-01") for op in OPERATIONS}
    assert len(results) == len(OPERATIONS)
    for op in OPERATIONS:
        assert bind_local_operation_digest(BODY, operation=op, account_id="ACC-01") in results


def test_account_binding_survives_reauthentication_but_not_account_change():
    first = bind_local_operation_digest(BODY, operation="plan.save", account_id="ACC-01")
    assert bind_local_operation_digest(BODY, operation="plan.save", account_id="ACC-01") == first
    assert bind_local_operation_digest(BODY, operation="plan.save", account_id="ACC-02") != first
    assert bind_local_operation_digest("b" * 64, operation="plan.save", account_id="ACC-01") != first


def test_unicode_account_is_exact_utf8_not_ascii_or_normalized():
    raw = ('{"account_id":"本地-甲","body_digest":"' + BODY
           + '","operation":"plan.confirm","scheme":"local-owner-v1"}').encode("utf-8")
    assert bind_local_operation_digest(BODY, operation="plan.confirm", account_id="本地-甲") == hashlib.sha256(raw).hexdigest()
    assert bind_local_operation_digest(BODY, operation="plan.confirm", account_id="é") != bind_local_operation_digest(
        BODY, operation="plan.confirm", account_id="e\u0301")


@pytest.mark.parametrize("account_id", ['ACC:"one,{}', "a" * 120, "甲" * 120, "ACC with space"])
def test_opaque_identifiers_are_not_split_or_truncated(account_id):
    result = bind_local_operation_digest(BODY, operation="planning.submit", account_id=account_id)
    assert len(result) == 64
    if len(account_id) < 120:
        assert result != bind_local_operation_digest(BODY, operation="planning.submit", account_id=account_id + "x")
    else:
        assert result == bind_local_operation_digest(BODY, operation="planning.submit", account_id=account_id)


@pytest.mark.parametrize("body", [None, False, 123, b"a" * 64, [], {}, "", "a" * 63, "a" * 65,
                                  "A" * 64, "g" * 64, "ａ" * 64, "a" * 63 + "\n", " " + BODY])
def test_invalid_body_digest_fails_without_echo(body):
    with pytest.raises(ValueError) as caught:
        bind_local_operation_digest(body, operation="task.save", account_id="ACC-01")
    assert str(caught.value) == "body_digest must be a lowercase SHA-256 hex string"


@pytest.mark.parametrize("operation", [None, False, 123, [], {}, "", "TASK.SAVE", "task.save ",
                                      "task.save\n", "planning.execute", "local-owner-v1", "任务保存"])
def test_unknown_operation_fails_without_echo(operation):
    with pytest.raises(ValueError) as caught:
        bind_local_operation_digest(BODY, operation=operation, account_id="ACC-01")
    assert str(caught.value) == "unsupported local operation"


@pytest.mark.parametrize("account_id", [None, False, 123, [], {}, b"ACC-01", "", " ", "\u3000", "x" * 121,
                                      " ACC", "ACC ", "ACC\n", "ACC\x00x", "ACC\x1fx", "ACC\x7fx", "\ud800", "\udfff"])
def test_invalid_account_fails_with_value_error_not_encoding_type_error(account_id):
    with pytest.raises(ValueError) as caught:
        bind_local_operation_digest(BODY, operation="task.save", account_id=account_id)
    assert str(caught.value) == "invalid trusted local account identifier"


def test_subject_and_operation_cannot_be_positional_or_implicitly_defaulted():
    with pytest.raises(TypeError):
        bind_local_operation_digest(BODY)
    with pytest.raises(TypeError):
        bind_local_operation_digest(BODY, "task.save", "ACC-01")


def test_module_has_only_standard_library_imports():
    source = Path(__file__).parents[1] / "app" / "local_operation_digest.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    imports = {node.module if isinstance(node, ast.ImportFrom) else alias.name
               for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
               for alias in node.names}
    assert imports == {"__future__", "hashlib", "json", "re"}
