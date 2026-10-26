"""P03 独立应用测试：只在本树新建临时库，保留库和证据。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys
import threading
from urllib.parse import quote

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, func, select, update
from sqlalchemy.exc import ArgumentError, OperationalError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, integration_identity_service as identity
from app import interference_frontend_service as service, resource_dataset_service as datasets
from app.database import Base
from app.interference_frontend_models import InterferenceScene, InterferenceSceneReceipt, InterferenceSceneVersion
from app.interference_frontend_router import router
from app.interference_frontend_schemas import SceneSave
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from app.task_input_models import PlanningTask, PlanningTaskRevision

MODELS = (InterferenceScene, InterferenceSceneVersion, InterferenceSceneReceipt)
BASE = "/api/v1/interference"


def application():
    app = FastAPI()
    app.include_router(router)

    @app.exception_handler(identity.IdentityError)
    async def identity_error(request, exc):
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": None})

    @app.get("/api/v1/auth/csrf")
    def challenge(request: Request):
        return {"code": 0, "message": "ok", "data": identity.challenge(request)}

    @app.post("/api/v1/auth/integration/switch")
    async def switch(request: Request, response: Response):
        body = await request.json()
        return {"code": 0, "message": "ok", "data": identity.switch(request, response, body["accountId"])}

    return app


def bind(factory, monkeypatch):
    for module in (database, identity, datasets, service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)


def seed(factory, baseline, task_id="T1", plan_id="P1", plan_no=1, current=True):
    stamp = datetime.now(timezone.utc)
    revision_id, job_id = "REV-" + plan_id, "JOB-" + plan_id
    input_data = {"demands": [{"id": "C1", "requiredRateKbps": 64, "mandatory": True}]}
    raw = {"solution_id": "PL-" + plan_id, "summary": {}, "terrain_fingerprint": None, "detail": {
        "nodes": [{"node_id": "N1"}, {"node_id": "N2"}],
        "devices": [{"device_id": "D1", "node_id": "N1", "status": None}, {"device_id": "D2", "node_id": "N2"}],
        "links": [{"link_id": "L1", "node_a_id": "N1", "node_b_id": "N2", "device_a_id": "D1", "device_b_id": "D2"}],
        "routes": {"routes": [{"demand_id": "C1", "primary": {"node_path": ["N1", "N2"], "link_path": ["L1"]}, "backup": None}]},
    }}
    with factory.begin() as session:
        if session.get(PlanningTask, task_id) is None:
            session.add(PlanningTask(task_id=task_id, current_revision_id=revision_id,
                current_version_no=1, created_at=stamp, updated_at=stamp))
            session.flush()
        session.add(PlanningTaskRevision(revision_id=revision_id, task_id=task_id, version_no=plan_no,
            condition_version="COND-1", resource_revision=baseline["revision"], context="planning",
            input_snapshot=input_data, created_at=stamp))
        session.flush()
        session.add(PlanningJob(job_id=job_id, request_id="job-request-" + plan_id, request_digest="a" * 64,
            task_id=task_id, revision_id=revision_id, condition_version="COND-1", resource_revision=baseline["revision"],
            context="planning", status="SUCCESS", progress=100, stage="构造测试结果", created_at=stamp, updated_at=stamp))
        session.flush()
        session.add(PlanningPlan(plan_id=plan_id, request_id="plan-request-" + plan_id, request_digest="b" * 64,
            task_id=task_id, job_id=job_id, revision_id=revision_id, condition_version="COND-1",
            resource_revision=baseline["revision"], version_no=plan_no, name="测试方案", note="构造来源",
            state="CONFIRMED", input_snapshot=input_data, result_snapshot={}, raw_snapshot=raw,
            outcome_snapshot={}, source="SR4", saved_at=stamp, confirmed_at=stamp))
        session.flush()
        if current:
            pointer = session.get(PlanningCurrentPlan, task_id)
            if pointer:
                pointer.plan_id = plan_id
            else:
                session.add(PlanningCurrentPlan(task_id=task_id, plan_id=plan_id, updated_at=stamp))
    return raw


@pytest.fixture
def api(tmp_path, monkeypatch):
    assert tmp_path.resolve().is_relative_to((ROOT / "data/runtime/tmp").resolve()), "使用本树内新 GUID basetemp"
    path = tmp_path / "p03.sqlite"
    assert not path.exists()
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False, "timeout": 10})

    @event.listens_for(engine, "connect")
    def foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    bind(factory, monkeypatch)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    baseline = datasets.initialize(factory)
    raw = seed(factory, baseline)
    with TestClient(application()) as client:
        yield client, factory, baseline, path, raw
    engine.dispose()


def headers(client):
    challenge = client.get("/api/v1/auth/csrf").json()["data"]
    return {"X-Session-Id": challenge["session_id"], "X-CSRF-Token": challenge["csrf_token"]}


def body(api, request_id="R1", **changes):
    baseline = api[2]
    return {"request_id": request_id, "task_id": "T1", "plan_id": "P1", "plan_version": "V1",
            "resource_revision": baseline["revision"], "base_scene_version_id": None,
            "name": "场景甲", "note": "构造测试场景", "interference_ids": ["IF-0001", "IF-0002"], **changes}


def save(api, payload=None, scene_id="SC1", extra_headers=None):
    client = api[0]
    return client.put(BASE + "/scenes/" + quote(scene_id, safe=""), json=payload or body(api),
                      headers=extra_headers if extra_headers is not None else headers(client))


def data(response):
    assert response.status_code == 200, response.text
    assert response.json()["code"] == 0
    return response.json()["data"]


def counts(factory):
    with factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model)) for model in MODELS)


def read(api, scene_id="SC1", **query):
    return api[0].get(BASE + "/scenes/" + quote(scene_id, safe=""), params={"task_id": "T1", **query})


def test_create_update_noop_and_immutable_history(api):
    client, factory, baseline, _, raw = api
    original_resources = deepcopy(datasets.current())
    first = data(save(api))
    first_version = data(read(api))["version"]
    assert first["changed"] and first["version_no"] == 1
    assert first_version["plan_snapshot"]["raw_snapshot"] == raw
    assert first_version["interference_sources"][0]["source_row"] == baseline["tables"]["interference_source.csv"][0]
    assert first_version["plan_snapshot"]["raw_snapshot"]["detail"]["devices"][0]["status"] is None
    update_body = body(api, "R2", base_scene_version_id=first["version_id"], name="场景乙")
    second = data(save(api, update_body))
    assert second["changed"] and second["version_no"] == 2
    noop = data(save(api, {**update_body, "request_id": "R3", "base_scene_version_id": second["version_id"]}))
    assert noop["changed"] is False and noop["version_id"] == second["version_id"]
    assert data(read(api, version_id=first["version_id"]))["version"] == first_version
    assert data(read(api))["version"]["previous_version_id"] == first["version_id"]
    history = data(client.get(BASE + "/scenes/SC1/versions", params={"task_id": "T1"}))
    assert [v["version_no"] for v in history["items"]] == [2, 1]
    assert counts(factory) == (1, 2, 3)
    assert datasets.current() == original_resources


def test_durable_replay_after_resource_plan_and_scene_change(api, monkeypatch):
    client, factory, baseline, path, _ = api
    receipt = data(save(api))
    before = data(read(api))["version"]
    seed(factory, baseline, plan_id="P2", plan_no=2)
    with factory.begin() as session:
        session.execute(update(ResourceDatasetCurrent).values(scope="temporarily-unavailable"))
    # 新连接、新 Session 工厂验证落盘重放，不依赖进程内字典或当前来源。
    reopened = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False})
    new_factory = sessionmaker(bind=reopened, expire_on_commit=False)
    bind(new_factory, monkeypatch)
    try:
        assert data(save(api)) == receipt
        assert data(client.get(BASE + "/scene-operations/R1", params={"task_id": "T1", "scene_id": "SC1"})) == receipt
        historical = data(read(api, version_id=receipt["version_id"]))
        assert historical["version"] == before
        assert historical["source_state"]["state"] == "UNKNOWN"
    finally:
        reopened.dispose()


def test_historical_source_and_empty_selection(api):
    first = data(save(api, body(api, interference_ids=[])))
    version = data(read(api))["version"]
    assert version["source_count"] == 0 and version["interference_sources"] == []
    seed(api[1], api[2], plan_id="P2", plan_no=2)
    detail = data(read(api, version_id=first["version_id"]))
    assert detail["version"] == version and detail["source_state"]["state"] == "HISTORICAL"
    assert save(api, body(api, "R2", base_scene_version_id=first["version_id"])).json()["code"] == 1203


def test_noop_saves_keep_previous_timestamp(api):
    first = data(save(api))
    before = data(read(api))["version"]
    result = data(save(api, body(api, "R2", base_scene_version_id=first["version_id"], interference_ids=["IF-0002", "IF-0001"])))
    assert not result["changed"]
    assert data(read(api))["version"] == before
    assert counts(api[1]) == (1, 1, 2)


@pytest.mark.parametrize("patch", [
    {"request_id": ""}, {"request_id": "a/b"}, {"request_id": "a\\b"}, {"name": " "}, {"name": " x"},
    {"name": "x" * 61}, {"note": None}, {"note": "x" * 501}, {"interference_ids": ["IF-0001"] * 2},
    {"interference_ids": [1]}, {"interference_ids": None}, {"interference_ids": ["missing"]},
    {"plan_version": "V0"}, {"plan_version": 1}, {"actor_id": "admin"}, {"base_scene_version_id": "x" * 41},
])
def test_invalid_body_never_writes(api, patch):
    response = save(api, body(api, **patch))
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(api[1]) == (0, 0, 0)


@pytest.mark.parametrize("raw", [b'{"request_id":"a","request_id":"b"}', b'{"name":NaN}', b'{"note":Infinity}', b'[]', b'{', b'\xff'])
def test_malformed_json_never_writes(api, raw):
    result = api[0].put(BASE + "/scenes/SC1", content=raw, headers=headers(api[0]))
    assert result.status_code == 422 and result.json()["code"] == 1001
    assert counts(api[1]) == (0, 0, 0)


@pytest.mark.parametrize("query", [
    {"page": "0"}, {"page": "1.0"}, {"page": "true"}, {"page_size": "101"}, {"unknown": "x"},
    [("task_id", "T1"), ("task_id", "T2")], {"search": "x" * 121},
])
def test_strict_query(api, query):
    params = {"task_id": "T1", **query} if isinstance(query, dict) else query
    result = api[0].get(BASE + "/scenes", params=params)
    assert result.status_code == 422 and result.json()["code"] == 1001


def test_missing_body_field_and_query_forbidden_on_put(api):
    payload = body(api)
    payload.pop("base_scene_version_id")
    assert save(api, payload).status_code == 422
    response = api[0].put(BASE + "/scenes/SC1?task_id=T1", json=body(api), headers=headers(api[0]))
    assert response.status_code == 422 and counts(api[1]) == (0, 0, 0)


def test_directory_literal_search_paging_and_gets_do_not_write(api, monkeypatch):
    client, factory, _, _, _ = api
    receipt = data(save(api, body(api, name="a%_b")))
    data(save(api, body(api, "R2", name="other"), scene_id="SC2"))
    before = counts(factory)

    def forbidden(*args, **kwargs):
        raise AssertionError("GET 不得重新冻结资源、初始化或启动计算")

    monkeypatch.setattr(service, "_source_content", forbidden)
    monkeypatch.setattr(datasets, "current", forbidden)
    monkeypatch.setattr(datasets, "initialize", forbidden)
    result = data(client.get(BASE + "/scenes", params={"task_id": "T1", "search": "%_"}))
    assert result["total"] == 1 and result["items"][0]["scene_id"] == "SC1"
    assert "plan_snapshot" not in result["items"][0]
    assert data(client.get(BASE + "/scenes", params={"task_id": "T1", "page": 9}))["items"] == []
    assert data(client.get(BASE + "/scenes", params={"task_id": "T2"}))["total"] == 0
    data(read(api, version_id=receipt["version_id"]))
    data(client.get(BASE + "/scenes/SC1/versions", params={"task_id": "T1"}))
    data(client.get(BASE + "/scene-operations/R1", params={"task_id": "T1", "scene_id": "SC1"}))
    assert counts(factory) == before


def test_version_task_scene_and_receipt_ownership(api):
    client, factory, baseline, _, _ = api
    receipt = data(save(api))
    second = data(save(api, body(api, "R2"), scene_id="SC2"))
    for path, params in [
        ("/scenes/SC1", {"task_id": "T2"}),
        ("/scenes/SC1", {"task_id": "T1", "version_id": second["version_id"]}),
        ("/scenes/SC1/versions", {"task_id": "T2"}),
        ("/scene-operations/R1", {"task_id": "T2", "scene_id": "SC1"}),
        ("/scene-operations/R1", {"task_id": "T1", "scene_id": "SC2"}),
        ("/scene-operations/missing", {"task_id": "T1", "scene_id": "SC1"}),
    ]:
        result = client.get(BASE + path, params=params)
        assert result.status_code == 404 and result.json()["data"] is None
    seed(factory, baseline, task_id="T2", plan_id="P2")
    cross = save(api, body(api, "R3", task_id="T2", plan_id="P2", base_scene_version_id=receipt["version_id"]))
    assert cross.status_code == 404
    assert save(api, body(api, "R1", note="different")).json()["code"] == 1206
    assert save(api, body(api, "R1"), scene_id="SC2").json()["code"] == 1206


def test_actual_permissions_csrf_session_and_mode(api, monkeypatch):
    client = api[0]
    assert save(api, extra_headers={}).json()["code"] == 1106
    assert save(api, extra_headers={**headers(client), "X-CSRF-Token": "bad"}).json()["code"] == 1105
    # HTTP header Unicode bytes are decoded as latin-1; must still reject, never crash compare_digest.
    assert save(api, extra_headers={**headers(client), "X-CSRF-Token": b'\xc3\xa9'}).json()["code"] == 1105
    switched = data(client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-editor"}, headers=headers(client)))
    assert "planning.save" not in switched["permissions"]
    assert save(api).json()["code"] == 1104
    data(client.get(BASE + "/scenes", params={"task_id": "T1"}))
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    response = client.get(BASE + "/scenes", params={"task_id": "T1"})
    assert response.status_code == 401 and response.json()["code"] == 1101
    assert counts(api[1]) == (0, 0, 0)


def test_cross_actor_receipt_hidden_and_key_conflict(api, monkeypatch):
    receipt = data(save(api))
    client = api[0]
    # 仅换测试会话的真实 account_id，权限仍来自现有目录，不替换 require。
    original = identity.CATALOG["integration-planner"]
    monkeypatch.setitem(identity.CATALOG, "test-planner-two", original)
    data(client.post("/api/v1/auth/integration/switch", json={"accountId": "test-planner-two"}, headers=headers(client)))
    assert client.get(BASE + "/scene-operations/R1", params={"task_id": "T1", "scene_id": "SC1"}).status_code == 404
    assert save(api).json()["code"] == 1206
    assert counts(api[1]) == (1, 1, 1)
    assert receipt["actor_id"] == "integration-planner"


@pytest.mark.parametrize("mutation,expected", [
    ("state", 1203), ("version", 1203), ("raw", 1203), ("route", 1203),
    ("resource", 1205), ("wrong-plan", 2001),
])
def test_source_validation_is_atomic(api, mutation, expected):
    payload = body(api)
    with api[1].begin() as session:
        plan = session.get(PlanningPlan, "P1")
        if mutation == "state":
            plan.state = "SAVED"
        elif mutation == "version":
            payload["plan_version"] = "V2"
        elif mutation == "raw":
            plan.raw_snapshot = None
        elif mutation == "route":
            raw = deepcopy(plan.raw_snapshot)
            raw["detail"]["routes"]["routes"][0]["primary"]["link_path"] = ["missing"]
            plan.raw_snapshot = raw
        elif mutation == "resource":
            payload["resource_revision"] = "resource-outdated"
        else:
            payload["plan_id"] = "missing"
    response = save(api, payload)
    assert response.json()["code"] == expected
    assert counts(api[1]) == (0, 0, 0)


def test_version_compare_and_swap_and_no_failed_receipts(api):
    first = data(save(api))
    assert save(api, body(api, "R2")).json()["code"] == 1203
    assert save(api, body(api, "R3", base_scene_version_id="missing")).json()["code"] == 1203
    assert counts(api[1]) == (1, 1, 1)
    assert api[0].get(BASE + "/scene-operations/R2", params={"task_id": "T1", "scene_id": "SC1"}).status_code == 404
    assert data(read(api))["version"]["version_id"] == first["version_id"]


def test_same_request_concurrency_and_conflicting_edits(api):
    payload = SceneSave.model_validate(body(api))
    barrier = threading.Barrier(2)

    def submit(value):
        barrier.wait(timeout=10)
        try:
            return service.save_scene("SC1", value, "integration-planner")
        except service.InterferenceSceneError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, replay = list(pool.map(submit, [payload, payload]))
    assert first == replay and counts(api[1]) == (1, 1, 1)
    edits = [SceneSave.model_validate(body(api, "edit-" + name, name=name, base_scene_version_id=first["version_id"])) for name in ("one", "two")]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(submit, edits))
    assert sum(isinstance(r, dict) for r in results) == 1 and 1203 in results
    assert counts(api[1]) == (1, 2, 2)


def test_source_read_and_scene_write_use_same_locked_transaction(api, monkeypatch):
    seed(api[1], api[2], plan_id="P2", plan_no=2, current=False)
    competing = create_engine("sqlite:///" + str(api[3]), connect_args={"timeout": 0})
    original = service._source_content
    checks = []

    def inspect_transaction(session, payload):
        assert session.in_transaction()
        content = original(session, payload)
        # 来源已读、场景尚未写时，另一连接也不能切换确认指针。
        with competing.connect() as connection:
            with pytest.raises(OperationalError) as error:
                connection.exec_driver_sql("UPDATE planning_current_plans SET plan_id='P2' WHERE task_id='T1'")
            assert (error.value.orig.sqlite_errorcode & 255) == 5
            connection.rollback()
        checks.append(content["plan_snapshot"]["plan_id"])
        return content

    monkeypatch.setattr(service, "_source_content", inspect_transaction)
    try:
        receipt = data(save(api))
        assert checks == ["P1"]
        with competing.begin() as connection:
            connection.exec_driver_sql("UPDATE planning_current_plans SET plan_id='P2' WHERE task_id='T1'")
        assert data(read(api))["source_state"]["state"] == "HISTORICAL"
        assert data(save(api)) == receipt
    finally:
        competing.dispose()


def test_frozen_raw_snapshot_does_not_read_mutated_plan(api):
    first = data(save(api))
    before = data(read(api))["version"]
    with api[1].begin() as session:
        plan = session.get(PlanningPlan, "P1")
        changed = deepcopy(plan.raw_snapshot)
        changed["summary"]["new_field"] = "修改后的原记录"
        plan.raw_snapshot = changed
    assert data(read(api, version_id=first["version_id"]))["version"] == before


def test_failure_after_version_insert_rolls_back_all_rows(api):
    def reject(mapper, connection, target):
        raise RuntimeError("测试事务失败")

    event.listen(InterferenceSceneReceipt, "before_insert", reject)
    try:
        with pytest.raises(RuntimeError, match="测试事务失败"):
            service.save_scene("SC1", SceneSave.model_validate(body(api)), "integration-planner")
    finally:
        event.remove(InterferenceSceneReceipt, "before_insert", reject)
    assert counts(api[1]) == (0, 0, 0)
    assert data(save(api))["version_no"] == 1


def test_frozen_content_and_pointer_corruption_refuse_success(api):
    first = data(save(api))
    with api[1].begin() as session:
        row = session.get(InterferenceSceneVersion, first["version_id"])
        broken = deepcopy(row.snapshot)
        broken["note"] = "tampered"
        session.execute(update(InterferenceSceneVersion).where(InterferenceSceneVersion.version_id == row.version_id).values(snapshot=broken))
    assert read(api).json()["code"] == 5002
    assert api[0].get(BASE + "/scenes", params={"task_id": "T1"}).json()["code"] == 5002
    assert save(api).json()["code"] == 5002


def test_orm_versions_and_receipts_reject_updates(api):
    receipt = data(save(api))
    for model, key, field in [(InterferenceSceneVersion, receipt["version_id"], "name"),
                              (InterferenceSceneReceipt, "R1", "actor_id")]:
        with api[1]() as session:
            setattr(session.get(model, key), field, "changed")
            with pytest.raises(ValueError, match="不可修改"):
                session.commit()
            session.rollback()


@pytest.mark.parametrize("configuration_error", [database.DatabaseConfigurationError, ArgumentError])
def test_no_schema_auto_creation_and_database_configuration(api, monkeypatch, tmp_path, configuration_error):
    missing = create_engine("sqlite:///" + str(tmp_path / "new-unmigrated.sqlite"))
    factory = sessionmaker(bind=missing)
    bind(factory, monkeypatch)
    try:
        assert api[0].get(BASE + "/scenes", params={"task_id": "T1"}).json()["code"] == 5003
        with missing.connect() as connection:
            assert connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").all() == []
    finally:
        missing.dispose()

    def unconfigured():
        raise configuration_error("test")

    monkeypatch.setattr(service, "get_session_factory", unconfigured)
    result = api[0].get(BASE + "/scenes", params={"task_id": "T1"})
    assert result.status_code == 503 and result.json()["code"] == 5001


def test_encoded_single_path_segment_and_no_analysis_routes(api):
    scene_id = "场景:#?%"
    receipt = data(save(api, scene_id=scene_id))
    assert data(read(api, scene_id=scene_id))["version"]["version_id"] == receipt["version_id"]
    paths = {r.path for r in router.routes}
    assert all("analyze" not in p and "adopt" not in p and "runs" not in p for p in paths)
