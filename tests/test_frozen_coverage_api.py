"""授权注入API契约，不冒充LOCAL登录或主现场DEM计算。"""
import json
from pathlib import Path
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from test_frozen_coverage_engine import scenario, SMALL
from test_frozen_coverage_service import context, BODY, ACTOR, QUERY, synthetic_result, terminal
import app

# 旧并行树缺P05共享模块时只读复用真实类型，不复制代码或伪造异常类。
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
if not (ROOT / "algorithm-service/app/system_management_schemas.py").is_file():
    shared = next(parent / "algorithm-service/app" for parent in ROOT.parents
                  if (parent / "algorithm-service/app/system_management_schemas.py").is_file())
    app.__path__.append(str(shared))

from app.frozen_coverage_router import create_frozen_coverage_router
from app.integration_identity_service import IdentityError
from app.system_management_schemas import SystemManagementError


PREFIX = "/api/v1/planning-coverages"
ANCHOR = {k: QUERY[k] for k in ("plan_id", "task_id", "snapshot_id")}
CACHE = {"task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "parameters": json.dumps(SMALL)}


@pytest.fixture
def api(context, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "OFF")
    service = context.make(engine=synthetic_result)
    service.start()
    state = {"actor": ACTOR, "session": "S1", "permissions": {"planning.view", "planning.execute", "situation.view"},
             "calls": [], "after": None}

    def require(request, permission, *, writing=False):
        state["calls"].append((permission, writing))
        if state["after"]:
            state["after"](permission, writing, len(state["calls"]))
        if permission not in state["permissions"]:
            raise IdentityError("unit denied", 1103, 403)
        if writing and request.headers.get("x-csrf-token") != "UNIT-CSRF":
            raise IdentityError("unit csrf", 1105, 403)
        return {"account_id": state["actor"], "session_id": state["session"], "permissions": sorted(state["permissions"])}

    application = FastAPI()
    application.state.auth_mode = "OFF"
    application.state.frozen_coverage = service
    application.include_router(create_frozen_coverage_router(require))
    with TestClient(application) as client:
        yield client, service, state


def submit(client, body=None):
    return client.post(PREFIX + "/P1/compute", json=BODY if body is None else body,
                       headers={"x-csrf-token": "UNIT-CSRF"})


def selection_request(client, body=None):
    return client.post(PREFIX + "/P1/bandwidth-selections", json=body if body is not None else {
        "task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "request_id": "RX-SELECT",
        "choices": [{"device_id": "D1", "rx_bandwidth_khz": 25}]}, headers={"x-csrf-token": "UNIT-CSRF"})


def test_rx_bandwidth_api_selection_compute_cache_job_and_shared_gis_read(api):
    client, service, state = api
    q = {"task_id": "T1", "snapshot_id": "SNP-PL-UNIT"}
    before = client.get(PREFIX + "/P1/bandwidth-options", params=q).json()["data"]
    assert before["current_selection"] is None and before["devices"][0]["options_khz"] == [25]
    created = selection_request(client)
    assert created.status_code == 201
    saved = created.json()["data"]
    assert selection_request(client).status_code == 200
    body = {**BODY, "bandwidth_selection_id": saved["selection_id"]}
    response = submit(client, body)
    assert response.status_code == 202
    job = response.json()["data"]
    assert terminal(service, job["job_id"])["state"] == "SUCCESS"
    assert job["bandwidth_selection_hash"] == saved["selection_hash"]
    state["actor"] = "ANOTHER-READER"
    state["permissions"] = {"planning.view", "situation.view"}
    options = client.get(PREFIX + "/P1/bandwidth-options", params={**q, "context": "gis"})
    assert options.status_code == 200 and options.json()["data"]["current_selection"] == saved
    restored = client.get(PREFIX + "/P1/bandwidth-selections/" + saved["selection_id"], params={**q, "context": "gis"})
    assert restored.status_code == 200 and restored.json()["data"] == saved
    cached = client.get(PREFIX + "/P1/cache", params={**CACHE, "context": "gis", "bandwidth_selection_id": saved["selection_id"]})
    assert cached.status_code == 200 and cached.json()["data"]["state"] == "HIT"
    assert cached.json()["data"]["result"]["provenance"]["bandwidth_selection_hash"] == saved["selection_hash"]
    assert client.get(PREFIX + "/jobs/" + job["job_id"], params=ANCHOR).status_code == 403
    assert selection_request(client).status_code == 403
    state["permissions"].remove("situation.view")
    assert client.get(PREFIX + "/P1/bandwidth-options", params={**q, "context": "gis"}).status_code == 403


@pytest.mark.parametrize("value", [True, None, "25", 0, -1, 3])
def test_rx_bandwidth_api_invalid_choices_do_not_persist(api, value):
    client, service, _ = api
    body = dict(task_id="T1", snapshot_id="SNP-PL-UNIT", request_id="BAD-RX",
                choices=[{"device_id": "D1", "rx_bandwidth_khz": value}])
    result = selection_request(client, body)
    assert result.status_code == 422 and result.json()["code"] == 1001
    assert not service.bandwidth.root.exists()


@pytest.mark.parametrize("raw", [
    '{"task_id":"T1","snapshot_id":"SNP-PL-UNIT","request_id":"X","choices":[{"device_id":"D1","rx_bandwidth_khz":NaN}]}',
    '{"task_id":"T1","snapshot_id":"SNP-PL-UNIT","request_id":"X","choices":[{"device_id":"D1","device_id":"D2","rx_bandwidth_khz":25}]}',
])
def test_rx_bandwidth_api_duplicate_json_keys_and_nan_rejected(api, raw):
    client, service, _ = api
    response = client.post(PREFIX + "/P1/bandwidth-selections", content=raw,
                           headers={"content-type": "application/json", "x-csrf-token": "UNIT-CSRF"})
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert not service.bandwidth.root.exists()


def test_rx_bandwidth_api_324_choices_over_16k_and_separate_128k_limit(api, context):
    client, service, _ = api
    choices = []
    for index in range(324):
        did = ("RX-" + str(index) + "-").ljust(100, "X")
        context.source["raw_snapshot"]["detail"]["devices"].append(dict(device_id=did, node_id="N1", model_id="M1", antenna_id="A1"))
        choices.append({"device_id": did, "rx_bandwidth_khz": 25})
    body = dict(task_id="T1", snapshot_id="SNP-PL-UNIT", request_id="RX-324", choices=choices)
    raw = json.dumps(body)
    assert 16 * 1024 < len(raw.encode()) < 128 * 1024
    response = selection_request(client, body)
    assert response.status_code == 201 and len(response.json()["data"]["choices"]) == 324
    files = list(service.bandwidth.root.glob("FBS-*.json"))
    for path, content in (("/P1/bandwidth-selections", raw + " " * (128 * 1024)),
                          ("/P1/compute", json.dumps(BODY) + " " * (16 * 1024))):
        response = client.post(PREFIX + path, content=content,
                               headers={"content-type": "application/json", "x-csrf-token": "UNIT-CSRF"})
        assert response.status_code == 422 and response.json()["code"] == 1001
    assert list(service.bandwidth.root.glob("FBS-*.json")) == files and not service._requests


def test_compute_accepted_poll_cache_and_replay(api):
    client, service, state = api
    accepted = submit(client)
    assert accepted.status_code == 202 and accepted.json()["code"] == 0
    jid = accepted.json()["data"]["job_id"]
    assert terminal(service, jid)["state"] == "SUCCESS"
    queried = client.get(PREFIX + "/jobs/" + jid, params=ANCHOR)
    assert queried.status_code == 200 and queried.json()["data"]["state"] == "SUCCESS"
    response = client.get(PREFIX + "/P1/cache", params=CACHE)
    assert response.json()["data"]["state"] == "HIT" and response.json()["data"]["result"]["provenance"]["test_only"]
    assert submit(client).status_code == 200
    assert ("planning.execute", True) in state["calls"]


def test_read_miss_never_starts_algorithm_or_requires_execute(api):
    client, service, state = api
    state["permissions"] = {"planning.view"}
    service.engine = lambda *a, **k: pytest.fail("GET must not compute")
    assert client.get(PREFIX + "/P1/cache", params=CACHE).json()["data"]["state"] == "MISS"
    assert not service._active and not service._requests
    assert submit(client).status_code == 403


def test_gis_requires_both_permissions_and_same_session(api):
    client, _, state = api
    state["permissions"] = {"planning.view"}
    assert client.get(PREFIX + "/P1/cache", params={**CACHE, "context": "gis"}).status_code == 403
    state["permissions"].add("situation.view")

    def changed(permission, writing, count):
        if permission == "situation.view":
            state["session"] = "OTHER-SESSION"

    state["after"] = changed
    response = client.get(PREFIX + "/P1/cache", params={**CACHE, "context": "gis"})
    assert response.status_code in (403, 409) and response.json()["code"] in (1103, 1106)


@pytest.mark.parametrize("error", [IdentityError("session gone", 1102, 401),
    SystemManagementError("account revoked", 1102, 401, data={"reason": "SESSION_REVOKED"}),
    SystemManagementError("owner denied", 1104, 403, data={"reason": "NOT_OWNER"})])
def test_typed_identity_failure_after_threadpool_gap_preserves_envelope(api, error):
    client, service, state = api

    def revoke(permission, writing, count):
        if count == 2:
            raise error

    state["after"] = revoke
    response = client.get(PREFIX + "/P1/cache", params=CACHE)
    assert response.status_code == error.status
    assert response.json() == {"code": error.code, "message": str(error), "data": getattr(error, "data", None)}
    assert not service._active


def test_system_typed_error_inside_service_not_misclassified_as_1001(api, monkeypatch):
    client, service, _ = api

    def denied(*a, **k):
        raise SystemManagementError("owner proof missing", 1104, 403, data={"reason": "NOT_OWNER"})

    monkeypatch.setattr(service, "cache", denied)
    response = client.get(PREFIX + "/P1/cache", params=CACHE)
    assert response.status_code == 403 and response.json()["code"] == 1104
    assert response.json()["data"] == {"reason": "NOT_OWNER"}


@pytest.mark.parametrize("failure", [RuntimeError, ValueError])
def test_unknown_programming_error_is_not_broadly_caught(api, monkeypatch, failure):
    client, service, _ = api

    def unexpected(*a, **k):
        raise failure("unit unexpected programming error")

    monkeypatch.setattr(service, "cache", unexpected)
    with pytest.raises(failure, match="unexpected programming"):
        client.get(PREFIX + "/P1/cache", params=CACHE)


def test_csrf_missing_and_no_permission_cannot_create_job(api):
    client, service, state = api
    assert client.post(PREFIX + "/P1/compute", json=BODY).json()["code"] == 1105
    state["permissions"].remove("planning.view")
    assert submit(client).status_code == 403
    assert not service._requests


@pytest.mark.parametrize("body", [{**BODY, "actor_id": ACTOR}, {**BODY, "parameters": None},
    {**BODY, "parameters": {"cell_m": True}}, {**BODY, "parameters": {"bad": 1}}, {**BODY, "task_id": ""},
    {"task_id": "T1", "request_id": "X"}, {**BODY, "request_id": "bad\nrequest"}])
def test_strict_compute_body(api, body):
    client, service, _ = api
    response = submit(client, body)
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert not service._requests


@pytest.mark.parametrize("raw", ['{"task_id":"T1","task_id":"OTHER"}', '{"parameters":{"x":NaN}}', '[]', '{} trailing'])
def test_duplicate_or_nonfinite_raw_json_rejected(api, raw):
    client, _, _ = api
    response = client.post(PREFIX + "/P1/compute", content=raw,
                           headers={"content-type": "application/json", "x-csrf-token": "UNIT-CSRF"})
    assert response.status_code == 422 and response.json()["code"] == 1001


@pytest.mark.parametrize("query", [{**CACHE, "extra": "x"}, {**CACHE, "context": "other"},
    {**CACHE, "parameters": "[]"}, {**CACHE, "parameters": '{"cell_m":NaN}'},
    [("task_id", "T1"), ("task_id", "OTHER"), ("snapshot_id", "SNP-PL-UNIT")]])
def test_strict_cache_query(api, query):
    client, _, _ = api
    response = client.get(PREFIX + "/P1/cache", params=query)
    assert response.status_code == 422 and response.json()["code"] == 1001


def test_job_actor_and_anchor_enforced(api):
    client, service, state = api
    accepted = submit(client).json()["data"]
    terminal(service, accepted["job_id"])
    path = PREFIX + "/jobs/" + accepted["job_id"]
    assert client.get(path, params={**ANCHOR, "snapshot_id": "WRONG"}).json()["code"] == 1205
    state["actor"] = "OTHER"
    assert client.get(path, params=ANCHOR).status_code == 403


def test_cancel_endpoint_after_completion_is_honest_terminal(api):
    client, service, _ = api
    accepted = submit(client).json()["data"]
    terminal(service, accepted["job_id"])
    response = client.post(PREFIX + "/jobs/" + accepted["job_id"] + "/cancel",
        json={**ANCHOR, "request_id": "CANCEL-1"}, headers={"x-csrf-token": "UNIT-CSRF"})
    assert response.status_code == 200 and response.json()["data"]["state"] == "SUCCESS"
    assert response.json()["data"]["cancel_requested"] is False


def test_unwired_service_and_local_adapter_fail_closed(api):
    client, _, _ = api
    del client.app.state.frozen_coverage
    assert client.get(PREFIX + "/P1/cache", params=CACHE).json()["code"] == 5003
    client.app.state.frozen_coverage = object()
    client.app.state.auth_mode = "LOCAL_PASSWORD"
    response = client.get(PREFIX + "/P1/cache", params=CACHE)
    assert response.status_code == 503 and response.json()["code"] == 5001


def test_v4_cache_version_query_does_not_expand_compute_or_selection_body(api):
    client, service, _ = api
    accepted = submit(client).json()["data"]
    assert terminal(service, accepted["job_id"])["state"] == "SUCCESS"
    default = client.get(PREFIX + "/P1/cache", params=CACHE).json()["data"]
    explicit = client.get(PREFIX + "/P1/cache", params={**CACHE, "engine_version": "V01-6"}).json()["data"]
    assert explicit == default and default["state"] == "HIT"
    assert default["anchor"]["engine_version"] == "V01-6"
    assert default["result"]["schema_version"] == 2 and default["result"]["summary"]["eligible"] == 0
    assert default["result"]["status"] == "NOT_APPLICABLE"
    for version in ("V01-1", "V01-2", "V01-3", "V01-4", "V01-5"):
        response = client.get(PREFIX + "/P1/cache", params={**CACHE, "engine_version": version})
        assert response.status_code == 200 and response.json()["data"]["state"] == "MISS"
        assert response.json()["data"]["anchor"]["engine_version"] == version
    assert submit(client, {**BODY, "request_id": "ILLEGAL", "engine_version": "V01-3"}).status_code == 422
    body = {"task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "request_id": "ILLEGAL", "choices": [], "profile_id": "X"}
    assert selection_request(client, body).status_code == 422


@pytest.mark.parametrize("version", ["V01-7", "", "null"])
def test_v4_unknown_cache_engine_query_rejected(api, version):
    client, _, _ = api
    response = client.get(PREFIX + "/P1/cache", params={**CACHE, "engine_version": version})
    assert response.status_code == 422 and response.json()["code"] == 1001
