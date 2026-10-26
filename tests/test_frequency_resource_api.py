"""频点独立路由和本树临时库测试；临时授权不进入生产身份目录。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from pathlib import Path
from types import SimpleNamespace
import sys
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import frontend_integration as frontend
from app import frequency_resource_service as service
from app import integration_identity_service as identity
from app import planning_job_models, task_input_models
from app import resource_dataset_service as datasets, resource_maintenance_service as maintenance
from app.database import Base, DatabaseConfigurationError
from app.frequency_resource_router import router
from app.frequency_resource_schemas import FrequencyDisableChange, FrequencyChangesChange
from app.integration_identity_models import IntegrationSession
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetOperation, ResourceDatasetVersion
from app.resource_maintenance_schemas import AvailabilityChange, ResourceDeviceChanges

PREFIX = "/api/v1/resource/frequency-resources"
ACTOR = "p04-test-writer"


@pytest.fixture
def frequency_api(tmp_path, monkeypatch):
    path = tmp_path / "frequency.sqlite"
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False, "timeout": 30})
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    # 只在测试内增加独立身份；真实 require、会话记录和 CSRF 仍全部执行。
    for account in (ACTOR, "p04-test-other"):
        monkeypatch.setitem(identity.CATALOG, account, ("频点测试授权身份", "EDITOR",
            identity.READ + ["resources.frequency.disable", "resources.frequency.maintain"]))
    # 此模块的拒绝分支显式撤权；主入口编辑者的新授权另由总集成测试验证。
    name, role, permissions = identity.CATALOG["integration-editor"]
    monkeypatch.setitem(identity.CATALOG, "integration-editor", (name, role,
        [value for value in permissions if value != "resources.frequency.disable"]))
    for module in (datasets, identity):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    Base.metadata.create_all(engine)
    baseline = datasets.initialize()
    with factory.begin() as session:
        for account in (ACTOR, "p04-test-other", "integration-editor", "integration-reviewer"):
            session.add(IntegrationSession(token_hash=hashlib.sha256(account.encode()).hexdigest(),
                session_id="session-" + account, account_id=account, csrf="csrf-" + account,
                active=True, expires_at=time.time() + 3600))
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, factory=factory, baseline=baseline, path=path, monkeypatch=monkeypatch)
    engine.dispose()


def authorize(fixture, actor=ACTOR):
    fixture.client.cookies.set(identity.COOKIE, actor)
    return {"X-Session-Id": "session-" + actor, "X-CSRF-Token": "csrf-" + actor}


def query(fixture, **patch):
    return {"context": "ledger", "revision": fixture.baseline["revision"], **patch}


def body(fixture, **patch):
    return {"context": "ledger", "base_revision": fixture.baseline["revision"],
        "request_id": "frequency-disable-1", "ids": ["FQ-0002", "FQ-0003"], **patch}


def preview(fixture, **patch):
    return {**query(fixture), "ids": ["FQ-0002", "FQ-0003"], **patch}


def post(fixture, payload=None, *, validation=False):
    return fixture.client.post(PREFIX + ("/disable/validate" if validation else "/disable"),
        json=payload if payload is not None else body(fixture), headers=authorize(fixture))


def counts(fixture):
    with fixture.factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model))
            for model in (ResourceDatasetVersion, ResourceDatasetOperation))


def seed_variant(fixture, change):
    snapshot = {key: deepcopy(fixture.baseline[key]) for key in
        ("schema_version", "tables", "source_files", "source_updated_at")}
    change(snapshot)
    digest = datasets.content_hash(snapshot)
    revision = "resource-" + digest[:16]
    with fixture.factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=revision, snapshot=snapshot, content_hash=digest,
            source=datasets.SOURCE, data_origin=datasets.ORIGIN, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = revision
    return revision


def test_read_and_validation_are_read_only_and_preserve_unknown(frequency_api):
    f = frequency_api
    revision = seed_variant(f, lambda snapshot: snapshot["tables"]["frequency_resource.csv"][1].update(
        bandwidth_khz="", channel_no="", occupied_by="", reuse_min_distance_m="", adjacent_guard_khz=""))
    before = counts(f)
    response = f.client.get(PREFIX, params=query(f, revision=revision))
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["revision"] == data["base_revision"] == revision
    assert data["data_origin"] == datasets.ORIGIN and data["source"] == datasets.SOURCE
    assert len(data["items"]) == 105 and not data["items"][0]["is_available"]
    assert all(data["items"][1][key] is None for key in (
        "bandwidth_khz", "channel_no", "occupied_by", "reuse_min_distance_m", "adjacent_guard_khz"))
    selected = ["FQ-0002", "FQ-0001"]
    for _ in range(2):
        response = post(f, preview(f, revision=revision, ids=selected), validation=True)
        assert response.status_code == 200, response.text
        result = response.json()["data"]
        assert result["selected_ids"] == sorted(selected)
        assert result["would_disable"] == ["FQ-0002"] and result["unchanged"] == ["FQ-0001"]
        assert result["impact"] == {"resource_revision_will_change": True, "historical_resources_preserved": True,
            "saved_plans_require_recompute": True, "link_impact": "UNKNOWN"}
    assert counts(f) == before and datasets.current()["revision"] == revision


@pytest.mark.parametrize("validation", [False, True])
def test_permissions_csrf_and_session_are_enforced(frequency_api, validation):
    f = frequency_api
    payload = preview(f) if validation else body(f)
    path = PREFIX + ("/disable/validate" if validation else "/disable")
    assert f.client.post(path, json=payload).json()["code"] == 1106
    default_headers = {"X-Session-Id": frontend.SESSION_ID, "X-CSRF-Token": frontend.CSRF_TOKEN}
    assert f.client.post(path, json=payload, headers=default_headers).json()["code"] == 1104
    for actor in ("integration-editor", "integration-reviewer"):
        response = f.client.post(path, json=payload, headers=authorize(f, actor))
        assert response.status_code == 403 and response.json()["code"] == 1104
    headers = authorize(f)
    for patch, code in (({"X-CSRF-Token": "bad"}, 1105), ({"X-Session-Id": "old"}, 1106)):
        assert f.client.post(path, json=payload, headers={**headers, **patch}).json()["code"] == code
    unicode_headers = [(key.encode("ascii"), value.encode("utf-8")) for key, value in headers.items()
        if key != "X-CSRF-Token"] + [(b"X-CSRF-Token", "非法令牌".encode("utf-8"))]
    response = f.client.post(path, json=payload, headers=unicode_headers)
    assert response.status_code == 403 and response.json()["code"] == 1105
    f.client.cookies.set(identity.COOKIE, "unknown-token")
    assert f.client.get(PREFIX, params=query(f)).json()["code"] == 1106
    headers = authorize(f)
    f.monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    for method in ("get", "post"):
        response = f.client.get(PREFIX, params=query(f)) if method == "get" else f.client.post(path, json=payload, headers=headers)
        assert response.status_code == 401 and response.json()["code"] == 1101
    assert counts(f) == (1, 0)


@pytest.mark.parametrize("patch", [
    {"ids": []}, {"ids": ["FQ-0002", "FQ-0002"]}, {"ids": [str(i) for i in range(51)]},
    {"ids": [1]}, {"ids": [True]}, {"ids": [None]}, {"ids": "FQ-0002"}, {"ids": ["bad id"]},
    {"context": "gis"}, {"base_revision": "old"}, {"base_revision": 123},
    {"request_id": ""}, {"request_id": "x" * 121}, {"actor_id": "admin"},
    {"is_available": True}, {"center_freq_khz": 3100}, {"items": []}, {"data_origin": "REAL"},
])
def test_invalid_save_fields_do_not_write(frequency_api, patch):
    f = frequency_api
    response = post(f, body(f, **patch))
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert response.json()["data"] is None and counts(f) == (1, 0)


@pytest.mark.parametrize("payload", [[], None, True, "bad", {"context": "ledger"},
    {"context": "ledger", "revision": "old", "ids": ["FQ-0002"]}])
def test_invalid_validation_body_has_own_error_envelope(frequency_api, payload):
    f = frequency_api
    response = f.client.post(PREFIX + "/disable/validate", json=payload, headers=authorize(f))
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(f) == (1, 0)


@pytest.mark.parametrize("raw", [b'{"context":', b'{"context":"ledger","context":"ledger"}', b'\xff'])
def test_malformed_and_duplicate_json_keys_rejected(frequency_api, raw):
    f = frequency_api
    response = f.client.post(PREFIX + "/disable", content=raw,
        headers={**authorize(f), "Content-Type": "application/json"})
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(f) == (1, 0)


def test_get_rejects_extra_duplicate_query_or_body_and_post_query(frequency_api):
    f = frequency_api
    cases = [list(query(f).items()) + [("revision", f.baseline["revision"])],
        query(f, actor_id="admin"), query(f, revision="invalid"), {"context": "ledger"}]
    for params in cases:
        assert f.client.get(PREFIX, params=params).json()["code"] == 1001
    assert f.client.request("GET", PREFIX, params=query(f), content=b"{}").json()["code"] == 1001
    response = f.client.post(PREFIX + "/disable?ignored=1", json=body(f), headers=authorize(f))
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(f) == (1, 0)


def test_unknown_frequency_rolls_back_entire_batch(frequency_api):
    f = frequency_api
    for validation in (False, True):
        payload = preview(f, ids=["FQ-0002", "missing"]) if validation else body(f, ids=["FQ-0002", "missing"])
        response = post(f, payload, validation=validation)
        assert response.status_code == 404 and response.json()["code"] == 1002
    assert counts(f) == (1, 0) and datasets.current()["tables"] == f.baseline["tables"]


def test_atomic_save_readback_history_and_csv_bytes(frequency_api):
    f = frequency_api
    original_files = {name: path.read_bytes() for name, path in frontend.DATA_FILES.items()}
    receipt = post(f, body(f, ids=["FQ-0003", "FQ-0001", "FQ-0002"])).json()["data"]
    assert receipt["changed"] and receipt["revision"] != f.baseline["revision"]
    assert receipt["read_revision"] == receipt["revision"]
    assert receipt["updated"] == receipt["affected_ids"] == ["FQ-0002", "FQ-0003"]
    assert receipt["unchanged"] == ["FQ-0001"]
    expected = deepcopy(f.baseline["tables"])
    for row in expected["frequency_resource.csv"]:
        if row["freq_id"] in receipt["updated"]:
            row["is_available"] = "false"
    current = datasets.current()
    assert current["tables"] == expected and current["source_files"] == f.baseline["source_files"]
    assert {name: path.read_bytes() for name, path in frontend.DATA_FILES.items()} == original_files
    with f.factory() as session:
        assert session.get(ResourceDatasetVersion, f.baseline["revision"]).snapshot["tables"] == f.baseline["tables"]
        operation = session.get(ResourceDatasetOperation, receipt["request_id"])
        assert operation.actor_id == ACTOR and operation.receipt == receipt
    for validation in (False, True):
        response = post(f, preview(f), validation=True) if validation else f.client.get(PREFIX, params=query(f))
        assert response.status_code == 409 and response.json()["code"] == 1205
    read = f.client.get(PREFIX, params=query(f, revision=receipt["read_revision"])).json()["data"]
    assert all(not item["is_available"] for item in read["items"] if item["freq_id"] in receipt["selected_ids"])
    catalog = frontend.planning_frequency_catalog()["data"]
    assert catalog["revision"] == "catalog-" + receipt["revision"]
    disabled = next(row for row in catalog["frequency_resources"] if row["freq_id"] == "FQ-0002")
    assert disabled["is_available"] is False
    from planning.frequency import FreqPool
    # 算法资源池的真实过滤逻辑，未运行 SR4 优化或假称其已通过。
    pool = FreqPool(datasets.algorithm_tables(receipt["revision"])["frequency_resource.csv"])
    assert not set(receipt["selected_ids"]) & {row["freq_id"] for row in pool.channels}
    with pytest.raises(datasets.ResourceDatasetError) as error:
        datasets.algorithm_tables(f.baseline["revision"])
    assert error.value.code == 1205 and counts(f) == (2, 1)


def test_no_change_partial_and_replay_after_later_write(frequency_api):
    f = frequency_api
    noop = post(f, body(f, ids=["FQ-0001"], request_id="noop")).json()["data"]
    assert not noop["changed"] and noop["revision"] == f.baseline["revision"]
    assert noop["updated"] == [] and noop["unchanged"] == ["FQ-0001"] and counts(f) == (1, 1)
    request = body(f, ids=["FQ-0002", "FQ-0001"])
    receipt = post(f, request).json()["data"]
    assert post(f, {**request, "ids": list(reversed(request["ids"]))}).json()["data"] == receipt
    later = post(f, body(f, base_revision=receipt["revision"], request_id="later", ids=["FQ-0003"])).json()["data"]
    assert post(f, request).json()["data"] == receipt
    assert post(f, body(f, base_revision=later["revision"], request_id="still-disabled", ids=request["ids"])).json()["data"]["changed"] is False
    assert post(f, {**request, "request_id": "stale-new-id"}).json()["code"] == 1205
    assert post(f, {**request, "ids": ["FQ-0004"]}).json()["code"] == 1206
    response = f.client.post(PREFIX + "/disable", json=request, headers=authorize(f, "p04-test-other"))
    assert response.status_code == 409 and response.json()["code"] == 1206
    assert counts(f) == (3, 4)


def test_restart_replays_persistent_receipt(frequency_api):
    f = frequency_api
    request = body(f)
    receipt = post(f, request).json()["data"]
    engine = create_engine("sqlite:///" + str(f.path))
    try:
        f.monkeypatch.setattr(datasets, "get_session_factory", lambda: sessionmaker(bind=engine))
        assert datasets.current()["revision"] == receipt["revision"]
        assert service.disable(FrequencyDisableChange.model_validate(request), ACTOR) == receipt
    finally:
        engine.dispose()


@pytest.mark.parametrize("other_kind", ["frequency", "same-request", "parameters", "availability"])
def test_shared_revision_concurrency_has_one_winner(frequency_api, other_kind):
    f = frequency_api
    barrier = threading.Barrier(2)
    def worker(index):
        barrier.wait(timeout=10)
        try:
            if index == 0 or other_kind in ("frequency", "same-request"):
                request = body(f, request_id="same" if other_kind == "same-request" else f"frequency-{index}",
                    ids=["FQ-0002"] if other_kind == "same-request" or index == 0 else ["FQ-0003"])
                return service.disable(FrequencyDisableChange.model_validate(request), ACTOR)
            common = {"context": "ledger", "base_revision": f.baseline["revision"], "request_id": "device-write"}
            if other_kind == "parameters":
                return maintenance.save(ResourceDeviceChanges.model_validate({**common,
                    "devices": [{"id": "DV-0001", "antenna_height_m": 12.25}]}), ACTOR)
            return maintenance.set_availability(AvailabilityChange.model_validate({**common,
                "ids": ["DV-0001"], "availability": "OFF_SHELF"}), ACTOR)
        except datasets.ResourceDatasetError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, (0, 1)))
    if other_kind == "same-request":
        assert isinstance(results[0], dict) and results[0] == results[1]
    else:
        assert sum(isinstance(value, dict) for value in results) == 1 and 1205 in results
    assert counts(f) == (2, 1)


def test_request_ids_share_device_namespace(frequency_api):
    f = frequency_api
    receipt = maintenance.set_availability(AvailabilityChange.model_validate({"context": "ledger",
        "base_revision": f.baseline["revision"], "request_id": "shared-request", "ids": ["DV-0001"],
        "availability": "OFF_SHELF"}), ACTOR)
    response = post(f, body(f, request_id="shared-request", base_revision=receipt["revision"]))
    assert response.status_code == 409 and response.json()["code"] == 1206
    assert counts(f) == (2, 1)


@pytest.mark.parametrize("field,value", [("is_available", "unknown"), ("center_freq_khz", "NaN"),
    ("center_freq_khz", ""), ("bandwidth_khz", "-1"), ("channel_no", "1.5"),
    ("adjacent_guard_khz", "inf"), ("device_class", "unknown")])
def test_corrupt_selected_frequency_does_not_write(frequency_api, field, value):
    f = frequency_api
    revision = seed_variant(f, lambda snapshot: snapshot["tables"]["frequency_resource.csv"][1].update({field: value}))
    before = counts(f)
    responses = [f.client.get(PREFIX, params=query(f, revision=revision)),
        post(f, preview(f, revision=revision), validation=True), post(f, body(f, base_revision=revision))]
    assert all(response.status_code == 503 and response.json()["code"] == 5002 for response in responses)
    assert counts(f) == before and datasets.current()["revision"] == revision


def test_file_mode_missing_baseline_and_database_fail_closed(frequency_api):
    f = frequency_api
    f.monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    assert post(f).json()["code"] == 5003
    assert f.client.get(PREFIX, params=query(f)).json()["code"] == 5003
    f.monkeypatch.setenv("RESOURCE_DATASET_MODE", "invalid")
    assert post(f).json()["code"] == 5001
    f.monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    empty_engine = create_engine("sqlite://")
    try:
        Base.metadata.create_all(empty_engine)
        # 仅服务级检查，不开启访问空内存库的第二线程。
        empty_factory = sessionmaker(bind=empty_engine)
        f.monkeypatch.setattr(datasets, "get_session_factory", lambda: empty_factory)
        with pytest.raises(datasets.ResourceDatasetError) as error:
            service.disable(FrequencyDisableChange.model_validate(body(f)), ACTOR)
        assert error.value.code == 5003
    finally:
        empty_engine.dispose()
    assert counts(f) == (1, 0)


@pytest.mark.parametrize("exception,code", [(DatabaseConfigurationError("not configured"), 5001),
    (SQLAlchemyError("unavailable"), 5002)])
def test_database_errors_have_no_file_fallback(frequency_api, exception, code):
    f = frequency_api
    def unavailable():
        raise exception
    f.monkeypatch.setattr(datasets, "get_session_factory", unavailable)
    for response in (f.client.get(PREFIX, params=query(f)), post(f), post(f, preview(f), validation=True)):
        assert response.status_code == 503 and response.json()["code"] == code
        assert response.json()["data"] is None
    assert counts(f) == (1, 0)


def test_old_task_and_plan_are_rejected_without_rewriting_history(frequency_api):
    from app import planning_job_service, planning_plan_service, task_input_service
    from app.planning_job_schemas import PlanningJobSubmitRequest
    from app.planning_plan_models import PlanningPlan
    from app.planning_plan_schemas import PlanningPlanConfirmRequest
    from app.task_input_schemas import TaskSaveRequest
    f = frequency_api
    task_id = "p04-constructed-task"
    task = task_input_service.save_task_input(TaskSaveRequest.model_validate({
        "context": "planning", "task_id": task_id, "expected_revision": None,
        "resource_revision": f.baseline["revision"], "request_id": "p04-save-task",
        "input": frontend.planning_preset_catalog()["data"]["items"][0]["defaults"],
    }), task_id, factory=f.factory)
    stamp = datetime.now(timezone.utc)
    raw = {"source": "CONSTRUCTED_TEST_ONLY", "resource_revision": f.baseline["revision"]}
    with f.factory.begin() as session:
        session.add(planning_job_models.PlanningJob(job_id="p04-test-job", request_id="constructed-job",
            request_digest="a" * 64, task_id=task_id, revision_id=task["revision"],
            condition_version=task["condition_version"], resource_revision=task["resource_revision"],
            context="planning", parent_plan_id=None, adjustment=None, status="SUCCESS", progress=1,
            stage="构造测试记录，非算法实跑", error=None, created_at=stamp, updated_at=stamp))
        session.flush()
        session.add(PlanningPlan(plan_id="p04-constructed-plan", request_id="constructed-plan",
            request_digest="b" * 64, task_id=task_id, job_id="p04-test-job", revision_id=task["revision"],
            condition_version=task["condition_version"], resource_revision=task["resource_revision"],
            parent_plan_id=None, adjustment=None, version_no=1, name="构造版本失效测试", note="非真实规划结果",
            state="SAVED", input_snapshot=task["input"], result_snapshot=deepcopy(raw), raw_snapshot=deepcopy(raw),
            outcome_snapshot={"source": "CONSTRUCTED_TEST_ONLY"}, source="CONSTRUCTED_TEST_ONLY", saved_at=stamp))
    post(f)
    submission = PlanningJobSubmitRequest.model_validate({"context": "planning", "request_id": "stale-submit",
        "task_id": task_id, "expected_revision": task["revision"], "input_version": task["input_version"],
        "condition_version": task["condition_version"], "resource_revision": task["resource_revision"], "parent_plan_id": None})
    with pytest.raises(planning_job_service.PlanningJobError) as error:
        planning_job_service.submit_planning_job(submission, factory=f.factory)
    assert error.value.code == 1205
    confirmation = PlanningPlanConfirmRequest.model_validate({"context": "planning", "request_id": "stale-confirm",
        "task_id": task_id, "expected_revision": task["revision"]})
    with pytest.raises(planning_plan_service.PlanningPlanError) as error:
        planning_plan_service.confirm_planning_plan("p04-constructed-plan", confirmation, factory=f.factory)
    assert error.value.code == 1205
    with f.factory() as session:
        plan = session.get(PlanningPlan, "p04-constructed-plan")
        assert plan.state == "SAVED" and plan.raw_snapshot == raw and plan.result_snapshot == raw
        revision = session.get(task_input_models.PlanningTaskRevision, task["revision"])
        assert revision.resource_revision == f.baseline["revision"] and revision.input_snapshot == task["input"]


def test_r2_query_filters_complete_snapshot_before_paging(frequency_api):
    f = frequency_api
    params = {**query(f), "device_class": "HF", "availability": "AVAILABLE", "page_size": 5,
        "min_khz": 3000, "max_khz": 15000}
    expected = [row for row in f.baseline["tables"]["frequency_resource.csv"] if row["device_class"] == "HF"
        and row["is_available"] == "true" and 3000 <= float(row["center_freq_khz"]) <= 15000]
    expected.sort(key=lambda row: row["freq_id"])
    headers = authorize(f)
    for number in (1, 2, 999):
        response = f.client.get(PREFIX + "/query", params={**params, "page": number}, headers=headers)
        assert response.status_code == 200, response.text
        value = response.json()["data"]
        assert value["page"] == number and value["page_size"] == 5 and value["total"] == len(expected)
        assert [row["freq_id"] for row in value["items"]] == [row["freq_id"] for row in expected[(number - 1) * 5:number * 5]]
        assert value["revision"] == value["base_revision"] == f.baseline["revision"]
        assert value["content_hash"] == f.baseline["content_hash"] and value["data_origin"] == datasets.ORIGIN
    response = f.client.get(PREFIX + "/query", params={**query(f), "search": "禁用", "availability": "DISABLED"}, headers=headers)
    assert response.status_code == 200
    assert all(not row["is_available"] and "禁用" in (row["note"] or "") for row in response.json()["data"]["items"])
    assert counts(f) == (1, 0)


@pytest.mark.parametrize("patch", [{"page": 0}, {"page": "1.0"}, {"page_size": 7}, {"page_size": "true"},
    {"min_khz": "nan"}, {"max_khz": "inf"}, {"min_khz": 0}, {"min_khz": 5000, "max_khz": 3000},
    {"device_class": "ALL"}, {"availability": "FAULT"}, {"search": "x" * 121}, {"search": "\n"}, {"extra": 1}])
def test_r2_invalid_query_has_no_writes(frequency_api, patch):
    f = frequency_api
    response = f.client.get(PREFIX + "/query", params={**query(f), **patch}, headers=authorize(f))
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert counts(f) == (1, 0)


def test_r2_query_binding_and_stale_version(frequency_api):
    f = frequency_api
    assert f.client.get(PREFIX + "/query", params=query(f)).json()["code"] == 1106
    headers = authorize(f)
    duplicate = [*query(f).items(), ("page", "1"), ("page", "2")]
    assert f.client.get(PREFIX + "/query", params=duplicate, headers=headers).json()["code"] == 1001
    saved = post(f).json()["data"]
    assert f.client.get(PREFIX + "/query", params=query(f), headers=headers).json()["code"] == 1205
    response = f.client.get(PREFIX + "/query", params=query(f, revision=saved["revision"]), headers=headers)
    assert response.status_code == 200


def test_r2_original_operation_and_history_do_not_follow_current_revision(frequency_api):
    f = frequency_api
    first_body = body(f, request_id="request/原始%_one")
    first = post(f, first_body).json()["data"]
    post(f, body(f, base_revision=first["revision"], request_id="requestX_other", ids=["FQ-0004"]))
    headers = authorize(f)
    response = f.client.get(PREFIX + "/operations/request%2F%E5%8E%9F%E5%A7%8B%25_one", params={"context": "ledger"}, headers=headers)
    assert response.status_code == 200, response.text
    value = response.json()["data"]
    assert value["request_id"] == first_body["request_id"] and value["receipt"] == first
    assert value["operation"] == "FREQUENCY_DISABLE" and datetime.fromisoformat(value["created_at"]).tzinfo
    value = f.client.get(PREFIX + "/operations", params={"context": "ledger", "search": "%_", "page_size": 5}, headers=headers).json()["data"]
    assert value["total"] == 1 and value["items"][0]["request_id"] == first_body["request_id"]
    assert value["items"][0]["selected_count"] == value["items"][0]["updated_count"] == 2
    assert value["items"][0]["unchanged_count"] == 0
    page = f.client.get(PREFIX + "/operations", params={"context": "ledger", "page": 99}, headers=headers).json()["data"]
    assert page["items"] == [] and page["total"] == 2
    assert counts(f) == (3, 2)


def test_r2_operations_hide_foreign_and_nonfrequency_receipts(frequency_api):
    f = frequency_api
    saved = post(f).json()["data"]
    device = maintenance.set_availability(AvailabilityChange.model_validate({"context": "ledger",
        "base_revision": saved["revision"], "request_id": "device-only", "ids": ["DV-0001"], "availability": "OFF_SHELF"}), ACTOR)
    before = counts(f)
    for request_id in ("device-only", "missing"):
        response = f.client.get(PREFIX + "/operations/" + request_id, params={"context": "ledger"}, headers=authorize(f))
        assert response.status_code == 404 and response.json()["code"] == 1002
    response = f.client.get(PREFIX + "/operations/" + saved["request_id"], params={"context": "ledger"}, headers=authorize(f, "p04-test-other"))
    assert response.status_code == 404
    empty = f.client.get(PREFIX + "/operations", params={"context": "ledger"}, headers=authorize(f, "p04-test-other")).json()["data"]
    assert empty["total"] == 0 and empty["items"] == []
    own = f.client.get(PREFIX + "/operations", params={"context": "ledger"}, headers=authorize(f)).json()["data"]
    assert own["total"] == 1 and own["items"][0]["request_id"] == saved["request_id"]
    assert counts(f) == before and datasets.current()["revision"] == device["revision"]


def test_r2_history_search_is_case_sensitive_literal(frequency_api):
    f = frequency_api
    saved = post(f, body(f, request_id="Case%_Only")).json()["data"]
    for search, expected in (("case", 0), ("Case", 1), ("%_", 1), ("%X", 0)):
        response = f.client.get(PREFIX + "/operations", params={"context": "ledger", "search": search}, headers=authorize(f))
        assert response.status_code == 200, response.text
        page = response.json()["data"]
        assert page["total"] == len(page["items"]) == expected
        if expected:
            assert page["items"][0]["request_id"] == saved["request_id"]
    assert counts(f) == (2, 1)


def test_r2_corrupt_receipt_is_not_empty_success(frequency_api):
    f = frequency_api
    saved = post(f).json()["data"]
    corrupt = {**saved, "updated": [], "affected_ids": []}
    # 故意绕过 ORM 不可变事件模拟已有存储损坏，不删除或改写有效业务记录。
    with f.factory.begin() as session:
        session.execute(update(ResourceDatasetOperation).where(ResourceDatasetOperation.request_id == saved["request_id"]).values(receipt=corrupt))
    for path in ("/operations", "/operations/" + saved["request_id"]):
        response = f.client.get(PREFIX + path, params={"context": "ledger"}, headers=authorize(f))
        assert response.status_code == 503 and response.json()["code"] == 5002


def m3_add(key="FQ-M3", **fields):
    return {"kind": "ADD", "freq_id": key, "item": {"device_class": "HF", "center_freq_khz": 4000,
        "bandwidth_khz": None, "channel_no": None, "reuse_min_distance_m": None,
        "adjacent_guard_khz": None, "note": None, **fields}}


def m3_body(f, changes=None, **fields):
    return {"context": "ledger", "base_revision": f.baseline["revision"], "request_id": "m3-request",
        "changes": [m3_add()] if changes is None else changes, **fields}


def m3_post(f, value=None, *, validation=False, actor=ACTOR):
    value = value or m3_body(f)
    if validation:
        value = {"context": value["context"], "revision": value["base_revision"], "changes": value["changes"]}
    return f.client.post(PREFIX + ("/changes/validate" if validation else "/changes"), json=value, headers=authorize(f, actor))


def test_m3_add_preview_enable_noop_and_original_history(frequency_api):
    f = frequency_api
    previewed = m3_post(f, validation=True).json()["data"]
    assert previewed["items"][0]["before"] is None and previewed["items"][0]["after"]["is_available"] is False
    assert previewed["impact"]["link_impact"] == "UNKNOWN" and counts(f) == (1, 0)
    added = m3_post(f).json()["data"]
    assert added["object_id"] == "resource-frequency-changes" and added["items"][0]["occupied_by"] is None
    assert added["items"][0]["bandwidth_khz"] is None and added["items"][0]["note"] is None
    request = m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-M3"}], base_revision=added["revision"], request_id="m3-enable")
    enabled = m3_post(f, request).json()["data"]
    assert enabled["items"][0]["is_available"] is True and enabled["changed"]
    noop = m3_post(f, {**request, "base_revision": enabled["revision"], "request_id": "m3-enable-noop"}).json()["data"]
    assert not noop["changed"] and noop["revision"] == enabled["revision"] and counts(f) == (3, 3)
    assert m3_post(f).json()["data"] == added
    assert datasets.current()["source_files"] == f.baseline["source_files"]
    original = f.client.get(PREFIX + "/operations/m3-request", params={"context": "ledger"}, headers=authorize(f)).json()["data"]
    assert original["operation"] == "FREQUENCY_CHANGES" and original["receipt"] == added
    history = f.client.get(PREFIX + "/operations", params={"context": "ledger"}, headers=authorize(f)).json()["data"]
    assert history["total"] == 3 and all(row["operation"] == "FREQUENCY_CHANGES" for row in history["items"])


def test_m3_enable_requires_ancestor_proof_not_original_reserved_false(frequency_api):
    f = frequency_api
    rejected = m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-0001"}])
    for validation in (True, False):
        response = m3_post(f, rejected, validation=validation)
        assert response.status_code == 422 and response.json()["code"] == 1001
    disabled = post(f, body(f, ids=["FQ-0002"])).json()["data"]
    enabled = m3_post(f, m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-0002"}], base_revision=disabled["revision"])).json()["data"]
    assert enabled["changed"] and enabled["items"][0]["is_available"] is True
    assert counts(f) == (3, 2)


def test_m3_unrelated_branch_add_is_not_enable_proof(frequency_api):
    f = frequency_api
    added = m3_post(f).json()["data"]
    source_row = next(row for row in datasets.current()["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-M3")
    # 构造无祖先关系的资源分支，不能把另一分支 ADD 回执当当前启用证明。
    revision = seed_variant(f, lambda snapshot: snapshot["tables"]["frequency_resource.csv"].append(dict(source_row)))
    response = m3_post(f, m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-M3"}], base_revision=revision, request_id="branch-enable"))
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(f) == (3, 1) and added["revision"] != revision


def test_m3_patch_null_note_noop_and_canonical_actor_bound_replay(frequency_api):
    f = frequency_api
    changes = [{"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"center_freq_khz": 4500, "bandwidth_khz": None, "note": "本地录入"}},
        m3_add("FQ-M3-B")]
    request = m3_body(f, changes)
    saved = m3_post(f, request).json()["data"]
    assert saved["items"][0]["note"].startswith(service.CONSTRUCTED_NOTE)
    assert saved["items"][0]["occupied_by"] == service._item(next(row for row in f.baseline["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-0002"))["occupied_by"]
    assert m3_post(f, {**request, "changes": list(reversed(changes))}).json()["data"] == saved
    assert m3_post(f, request, actor="p04-test-other").json()["code"] == 1206
    patch = [{"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"center_freq_khz": 4500, "bandwidth_khz": None}}]
    noop = m3_post(f, m3_body(f, patch, base_revision=saved["revision"], request_id="patch-noop")).json()["data"]
    assert not noop["changed"] and noop["revision"] == saved["revision"]
    assert m3_post(f, {**request, "changes": [m3_add("different")]}).json()["code"] == 1206
    assert m3_post(f, m3_body(f, request_id="stale")).json()["code"] == 1205
    assert counts(f) == (2, 2)


@pytest.mark.parametrize("change", [m3_add(center_freq_khz=1), m3_add(bandwidth_khz=1000000),
    m3_add(center_freq_khz=True), m3_add(channel_no=1.5), m3_add(occupied_by="DV-0001"),
    {"kind": "PATCH", "freq_id": "FQ-0002", "fields": {}},
    {"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"center_freq_khz": None}},
    {"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"is_available": True}},
    {"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"device_class": "VUHF"}},
    {"kind": "ENABLE", "freq_id": "FQ-0001", "proof": "trusted"}, m3_add("FQ-0002")])
def test_m3_invalid_changes_are_atomic(frequency_api, change):
    f = frequency_api
    for validation in (True, False):
        response = m3_post(f, m3_body(f, [m3_add("FQ-M3-GOOD"), change]), validation=validation)
        assert response.status_code == 422 and response.json()["code"] == 1001, response.text
        assert counts(f) == (1, 0) and datasets.current()["tables"] == f.baseline["tables"]


def test_m3_model_union_keeps_gaps_and_checks_known_bandwidth(frequency_api):
    f = frequency_api
    def ranges(snapshot):
        models = snapshot["tables"]["device_model.csv"]
        for i, row in enumerate(model for model in models if model["device_class"] == "HF"):
            row["freq_min_khz"], row["freq_max_khz"] = ("3000", "4000") if i == 0 else ("5000", "6000")
    revision = seed_variant(f, ranges)
    for frequency, bandwidth, success in ((4500, None, False), (3500, 200, True), (4000, None, True), (4000, 1, False)):
        response = m3_post(f, m3_body(f, [m3_add(center_freq_khz=frequency, bandwidth_khz=bandwidth)], base_revision=revision), validation=True)
        assert response.status_code == (200 if success else 422), response.text
    assert counts(f) == (2, 0)


def test_m3_permission_and_csrf_are_not_inherited_from_disable(frequency_api):
    f = frequency_api
    name, role, permissions = identity.CATALOG[ACTOR]
    f.monkeypatch.setitem(identity.CATALOG, ACTOR, (name, role, [p for p in permissions if p != "resources.frequency.maintain"]))
    for validation in (True, False):
        assert m3_post(f, validation=validation).json()["code"] == 1104
    f.monkeypatch.setitem(identity.CATALOG, ACTOR, (name, role, permissions))
    headers = authorize(f); headers["X-CSRF-Token"] = "wrong"
    response = f.client.post(PREFIX + "/changes", json=m3_body(f), headers=headers)
    assert response.json()["code"] == 1105 and counts(f) == (1, 0)


def test_m3_shares_revision_lock_with_device_writer(frequency_api):
    f = frequency_api
    barrier = threading.Barrier(2)
    def worker(index):
        barrier.wait(timeout=30)
        try:
            if index == 0:
                return service.commit_changes(FrequencyChangesChange.model_validate(m3_body(f)), ACTOR)
            return maintenance.set_availability(AvailabilityChange.model_validate({"context": "ledger", "base_revision": f.baseline["revision"],
                "request_id": "m3-device", "ids": ["DV-0001"], "availability": "OFF_SHELF"}), ACTOR)
        except datasets.ResourceDatasetError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(worker, (0, 1)))
    assert sum(isinstance(value, dict) for value in results) == 1 and 1205 in results
    assert counts(f) == (2, 1)


def test_m3_corrupt_ancestor_receipt_fails_closed(frequency_api):
    f = frequency_api
    disabled = post(f, body(f, ids=["FQ-0002"])).json()["data"]
    with f.factory.begin() as session:
        session.execute(update(ResourceDatasetOperation).where(ResourceDatasetOperation.request_id == disabled["request_id"])
            .values(receipt={**disabled, "updated": []}))
    response = m3_post(f, m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-0002"}], base_revision=disabled["revision"]))
    assert response.status_code == 503 and response.json()["code"] == 5002
    assert counts(f) == (2, 1)


def test_m3_disabled_proof_survives_intervening_changes_without_approving_reserved_points(frequency_api):
    f = frequency_api
    disabled = post(f, body(f, ids=["FQ-0002"])).json()["data"]
    patched = m3_post(f, m3_body(f, [{"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"note": "构造变更"}}],
        base_revision=disabled["revision"], request_id="intervening-patch")).json()["data"]
    enabled = m3_post(f, m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-0002"}], base_revision=patched["revision"])).json()["data"]
    assert enabled["changed"] and enabled["items"][0]["is_available"] is True
    assert counts(f) == (4, 3)


def test_m3_reserved_root_is_not_approved_by_later_true_value(frequency_api):
    f = frequency_api
    def constructed_invalid_writer(snapshot):
        # 仅模拟其他写者产生的错误状态，不能把它当来源频率授权。
        next(row for row in snapshot["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-0001")["is_available"] = "true"
        return True, {"object_id": "CONSTRUCTED_TEST_ONLY"}
    changed = datasets.commit_device_change(f.baseline["revision"], "constructed-invalid", "b" * 64, ACTOR, constructed_invalid_writer)
    disabled = post(f, body(f, ids=["FQ-0001"], base_revision=changed["revision"])).json()["data"]
    response = m3_post(f, m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-0001"}], base_revision=disabled["revision"]))
    assert response.status_code == 422 and response.json()["code"] == 1001 and counts(f) == (3, 2)


def test_m3_patch_and_enable_preserve_unmodified_raw_fields(frequency_api):
    f = frequency_api
    def exact_numbers(snapshot):
        row = next(row for row in snapshot["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-0002")
        row["center_freq_khz"] = "4500.000"
        row["channel_no"] = "0.00"
    revision = seed_variant(f, exact_numbers)
    original = dict(next(row for row in datasets.current()["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-0002"))
    patched = m3_post(f, m3_body(f, [{"kind": "PATCH", "freq_id": "FQ-0002", "fields": {"note": "精确字段测试"}}], base_revision=revision)).json()["data"]
    current = next(row for row in datasets.current()["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-0002")
    assert {key: value for key, value in current.items() if key != "note"} == {key: value for key, value in original.items() if key != "note"}
    disabled = post(f, body(f, ids=["FQ-0002"], base_revision=patched["revision"])).json()["data"]
    enabled = m3_post(f, m3_body(f, [{"kind": "ENABLE", "freq_id": "FQ-0002"}], base_revision=disabled["revision"], request_id="raw-enable")).json()["data"]
    current = next(row for row in datasets.current()["tables"]["frequency_resource.csv"] if row["freq_id"] == "FQ-0002")
    assert current["center_freq_khz"] == "4500.000" and current["channel_no"] == "0.00" and enabled["changed"]
