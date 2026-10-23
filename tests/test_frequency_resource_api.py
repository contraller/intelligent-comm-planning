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
from sqlalchemy import create_engine, func, select
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
from app.frequency_resource_schemas import FrequencyDisableChange
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
            identity.READ + ["resources.frequency.disable"]))
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
