"""正式身份边界的构造输入单元测试，不代表真实身份源已接入。"""
from __future__ import annotations

import copy
from dataclasses import FrozenInstanceError, replace
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app.formal_identity_policy import (
    FormalIdentityPolicyError,
    require_formal_access,
    resolve_formal_session,
    validate_formal_identity,
)
from app.formal_identity_schemas import (
    CONTRACT_VERSION,
    FormalAccessRequest,
    FormalIdentity,
    FormalSessionContext,
)


NOW = 1_700_000_000
ALLOWED = frozenset(("resources.view", "resources.device.edit"))


def dto(**changes):
    return {
        "contract_version": CONTRACT_VERSION,
        "session_id": "fixture-session",
        "account_id": "fixture-account",
        "username": "fixture-user",
        "display_name": "构造主体",
        "role_id": "fixture-role",
        "role_name": "构造角色",
        "permissions": ["resources.view"],
        "identity_revision": "fixture-identity-1",
        "session_generation": "fixture-generation-1",
        "integration_mode": False,
        "data_origin": "FORMAL_VERIFIED",
        **changes,
    }


def context(**changes):
    return FormalSessionContext(**{
        "mode": "FORMAL", "state": "ACTIVE", "data_origin": "FORMAL_VERIFIED",
        "source_reference": "constructed-adapter-reference",
        "identity": validate_formal_identity(dto(), allowed_permissions=ALLOWED),
        "expires_at": NOW + 60, "csrf_token": "fixture-csrf", **changes,
    })


def resolve(value, **changes):
    return resolve_formal_session(value, **{"now": NOW, "allowed_permissions": ALLOWED, **changes})


def require(value, access, **changes):
    return require_formal_access(value, access, **{"now": NOW, "allowed_permissions": ALLOWED, **changes})


def reject(action, code=1001, status=422):
    with pytest.raises(FormalIdentityPolicyError) as caught:
        action()
    assert (caught.value.code, caught.value.status) == (code, status)
    return caught.value


def test_snapshot_is_detached_immutable_and_repeated_calls_are_pure():
    value = dto()
    original = copy.deepcopy(value)
    identity = validate_formal_identity(value, allowed_permissions=ALLOWED)
    current = context(identity=identity)
    assert resolve(current) is identity
    assert require(current, FormalAccessRequest("GET", required_permissions=("resources.view",))) is identity
    assert resolve(current) == resolve(current)
    assert value == original
    value["permissions"].clear()
    assert identity.permissions == ("resources.view",)
    for item, name in ((identity, "session_id"), (current, "mode"), (FormalAccessRequest("GET"), "method")):
        with pytest.raises(FrozenInstanceError):
            setattr(item, name, "changed")


@pytest.mark.parametrize("field", [
    "session_id", "account_id", "username", "display_name", "role_id", "role_name",
    "identity_revision", "session_generation",
])
@pytest.mark.parametrize("value", [None, True, 1, [], {}, "", " ", " a", "a ", "a\n", "a\x00b", "a\x7fb", "\ud800", "x" * 513])
def test_identity_string_fields_are_strict(field, value):
    reject(lambda: validate_formal_identity(dto(**{field: value}), allowed_permissions=ALLOWED))


@pytest.mark.parametrize("value", [
    None, [], "identity", {"session_id": "missing"},
    dto(contract_version="next"), dto(contract_version=None), dto(integration_mode=True),
    dto(integration_mode=0), dto(integration_mode=None), dto(data_origin="SYNTHETIC_INTEGRATION"),
    dto(data_origin="UNKNOWN"), dto(data_origin=None), dto(extra="not-allowed"),
    dto(permissions="resources.view"), dto(permissions=("resources.view",)),
    dto(permissions=["resources.view", "resources.view"]), dto(permissions=["unknown.permission"]),
    dto(permissions=[False]), dto(permissions=[[]]), dto(permissions=[" resources.view"]),
])
def test_invalid_dto_shape_origin_or_permissions(value):
    reject(lambda: validate_formal_identity(value, allowed_permissions=ALLOWED))


@pytest.mark.parametrize("field", ["contract_version", "integration_mode", "data_origin", "permissions"])
def test_missing_explicit_fields_cannot_become_formal(field):
    value = dto()
    del value[field]
    reject(lambda: validate_formal_identity(value, allowed_permissions=ALLOWED))


def test_original_integration_response_is_not_formal():
    value = dto(integration_mode=True)
    del value["contract_version"]
    del value["data_origin"]
    reject(lambda: validate_formal_identity(value, allowed_permissions=ALLOWED))


@pytest.mark.parametrize("value", ["x" * 512, "\U0001f600" * 512, "中é", "a\u0085b"])
def test_unicode_scalar_length_and_non_ascii_are_supported(value):
    assert validate_formal_identity(dto(display_name=value), allowed_permissions=ALLOWED).display_name == value


@pytest.mark.parametrize("value", ["\U0001f600" * 513, "\u0085a", "a\u00a0", "\u3000a", "a\u2028", "\udfff"])
def test_unicode_whitespace_surrogates_and_overlong_scalars_rejected(value):
    reject(lambda: validate_formal_identity(dto(display_name=value), allowed_permissions=ALLOWED))


@pytest.mark.parametrize("allowed", [None, set(ALLOWED), list(ALLOWED), frozenset((1,)), frozenset(("",))])
def test_permission_allowlist_must_be_explicit_and_valid(allowed):
    reject(lambda: validate_formal_identity(dto(), allowed_permissions=allowed))


def test_empty_allowlist_and_role_name_never_add_permissions():
    identity = validate_formal_identity(dto(permissions=[], role_name="管理员"), allowed_permissions=frozenset())
    current = context(identity=identity)
    assert resolve(current, allowed_permissions=frozenset()).permissions == ()
    reject(lambda: require(current, FormalAccessRequest("GET", required_permissions=("resources.view",))), 1104, 403)
    reject(lambda: validate_formal_identity(dto(), allowed_permissions=frozenset()))


def test_anonymous_read_is_null_and_protected_access_never_gets_planner():
    anonymous = FormalSessionContext("ANONYMOUS", "ANONYMOUS", "UNKNOWN")
    assert resolve(anonymous) is None
    reject(lambda: require(anonymous, FormalAccessRequest("GET")), 1101, 401)
    assert anonymous.identity is None


@pytest.mark.parametrize("changes", [
    {"state": "ACTIVE"}, {"data_origin": "FORMAL_VERIFIED"}, {"source_reference": "fixture"},
    {"expires_at": NOW}, {"csrf_token": "fixture"},
    {"identity": validate_formal_identity(dto(), allowed_permissions=ALLOWED)},
])
def test_anonymous_context_cannot_carry_identity_facts(changes):
    anonymous = FormalSessionContext("ANONYMOUS", "ANONYMOUS", "UNKNOWN")
    reject(lambda: resolve(replace(anonymous, **changes)))


@pytest.mark.parametrize("changes", [
    {"mode": "INTEGRATION", "data_origin": "SYNTHETIC_INTEGRATION"},
    {"mode": "INTEGRATION"}, {"mode": "UNKNOWN"},
    {"data_origin": "UNKNOWN"}, {"data_origin": "SYNTHETIC_INTEGRATION"},
])
def test_integration_unknown_and_inconsistent_source_do_not_gain_formal_access(changes):
    current = context(**changes)
    reject(lambda: resolve(current), 1101, 401)
    reject(lambda: require(current, FormalAccessRequest("GET")), 1101, 401)


@pytest.mark.parametrize("changes", [
    {"source_reference": None}, {"identity": None}, {"expires_at": None},
    {"state": "UNKNOWN"}, {"state": "ANONYMOUS"}, {"state": "normal"},
    {"mode": []}, {"state": []}, {"data_origin": []},
    {"identity": dto()}, {"source_reference": ""}, {"csrf_token": "\ud800"},
    {"contract_version": "next"}, {"expires_at": True}, {"expires_at": 1.5}, {"expires_at": -1},
])
def test_missing_unknown_or_malformed_facts_never_receive_defaults(changes):
    reject(lambda: resolve(context(**changes)))


@pytest.mark.parametrize("value", [None, {}, dto()])
def test_raw_context_cannot_be_promoted_to_trusted_context(value):
    reject(lambda: resolve(value))


@pytest.mark.parametrize("now", [True, -1, 1.2, None, "1700000000"])
def test_explicit_clock_is_a_strict_nonnegative_integer(now):
    reject(lambda: resolve(context(), now=now))


@pytest.mark.parametrize("changes,code,status", [
    ({"expires_at": NOW}, 1102, 401), ({"expires_at": NOW - 1}, 1102, 401),
    ({"state": "EXPIRED"}, 1102, 401), ({"state": "REVOKED"}, 1102, 401),
    ({"state": "DISABLED"}, 1103, 403),
    ({"state": "DISABLED", "expires_at": NOW - 1}, 1103, 403),
])
def test_expiration_revocation_and_disabled_status(changes, code, status):
    reject(lambda: resolve(context(**changes)), code, status)


def test_identity_snapshot_is_revalidated_inside_context():
    identity = context().identity
    for changes in ({"integration_mode": True}, {"data_origin": "UNKNOWN"}, {"permissions": ("unknown",)}, {"permissions": ["resources.view"]}):
        reject(lambda: resolve(context(identity=replace(identity, **changes))))


@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_reads_allow_no_binding_but_check_any_supplied_binding(method):
    current = context(csrf_token=None)
    assert require(current, FormalAccessRequest(method)) is current.identity
    assert require(current, FormalAccessRequest(method, session_id="fixture-session", session_generation="fixture-generation-1")) is current.identity
    reject(lambda: require(current, FormalAccessRequest(method, session_id="old-session")), 1106, 409)
    reject(lambda: require(current, FormalAccessRequest(method, session_generation="old-generation")), 1106, 409)


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_every_write_needs_current_session_and_csrf(method):
    current = context()
    good = FormalAccessRequest(method, session_id="fixture-session", csrf_token="fixture-csrf")
    assert require(current, good) is current.identity
    for access in (replace(good, session_id=None), replace(good, session_id="old"), replace(good, session_generation="old")):
        reject(lambda: require(current, access), 1106, 409)
    for access in (replace(good, csrf_token=None), replace(good, csrf_token="wrong")):
        reject(lambda: require(current, access), 1105, 403)
    reject(lambda: require(context(csrf_token=None), good), 1105, 403)


@pytest.mark.parametrize("token", ["令牌-甲é", "\U0001f600" * 512, "ascii-token"])
def test_csrf_uses_utf8_bytes_without_non_ascii_type_errors(token):
    current = context(csrf_token=token)
    request = FormalAccessRequest("POST", session_id="fixture-session", csrf_token=token)
    assert require(current, request) is current.identity
    error = reject(lambda: require(current, replace(request, csrf_token="令牌-乙")), 1105, 403)
    assert token not in str(error)
    assert token not in repr(current)
    assert token not in repr(request)


def test_csrf_is_not_unicode_normalized_and_surrogates_have_mapped_errors():
    request = FormalAccessRequest("POST", session_id="fixture-session", csrf_token="e\u0301")
    reject(lambda: require(context(csrf_token="é"), request), 1105, 403)
    reject(lambda: require(context(), replace(request, csrf_token="\ud800")))


@pytest.mark.parametrize("value", [
    None, {}, FormalAccessRequest("get"), FormalAccessRequest("OPTIONS"), FormalAccessRequest([]),
    FormalAccessRequest("GET", session_id=0), FormalAccessRequest("GET", session_generation=""),
    FormalAccessRequest("POST", csrf_token=True), FormalAccessRequest("GET", required_permissions=["resources.view"]),
    FormalAccessRequest("GET", required_permissions=("resources.view", "resources.view")),
    FormalAccessRequest("GET", required_permissions=([],)),
])
def test_request_structure_rejects_invalid_values_without_unmapped_exceptions(value):
    reject(lambda: require(context(), value))


def test_all_requested_permissions_must_be_known_and_held():
    current = context()
    for required in (("resources.view", "resources.device.edit"), ("not.registered",)):
        reject(lambda: require(current, FormalAccessRequest("GET", required_permissions=required)), 1104, 403)
    identity = validate_formal_identity(dto(permissions=list(ALLOWED)), allowed_permissions=ALLOWED)
    assert require(context(identity=identity), FormalAccessRequest("GET", required_permissions=tuple(ALLOWED))) is identity


def test_session_binding_precedes_csrf_and_permission_rejection():
    request = FormalAccessRequest("POST", session_id="old", csrf_token="wrong", required_permissions=("not.registered",))
    reject(lambda: require(context(), request), 1106, 409)
    reject(lambda: require(context(), replace(request, session_id="fixture-session")), 1105, 403)
