"""规划任务保存接口的数据库行为测试。"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.database import Base  # noqa: E402
from app.main import app  # noqa: E402
from app import frontend_integration, task_input_models, task_input_service  # noqa: E402
from app.planning_job_models import PlanningJob  # noqa: E402


def sample_input() -> dict:
    return {
        "name": "测试通信任务", "description": "接口验证", "bbox": [113, 36, 116, 39],
        "stationIds": ["N1", "N2"], "presetId": "P1", "frequencyId": "F1",
        "startTime": None, "durationH": None,
        "constraints": {"connectivityPercent": 100, "maxRelayHops": 2, "survivabilityPercent": 90},
        "demands": [{
            "id": "D1", "sourceId": "N1", "targetId": "N2", "endpointMode": "station",
            "sourceDeviceId": None, "targetDeviceId": None, "preferredClass": None,
            "service": "数据", "priority": "P1", "mandatory": True, "dataVolumeMb": 10,
            "requiredRateKbps": 64, "maxDelayMs": 100, "minReliability": 0.95,
        }],
    }


def request(request_id: str, expected_revision: str | None = None) -> dict:
    return {
        "context": "planning", "task_id": "T1", "expected_revision": expected_revision,
        "resource_revision": "r1", "request_id": request_id, "input": sample_input(),
    }


@pytest.fixture
def api(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    # 测试内存库复用 ORM 元数据；正式库仅由 Alembic 管理。
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(task_input_service, "get_session_factory", lambda: factory)
    yield TestClient(app), factory
    engine.dispose()


def save(client: TestClient, body: dict):
    return client.put("/api/v1/task-inputs/T1", json=body)


def counts(factory: sessionmaker[Session]) -> tuple[int, int, int]:
    with factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model)) for model in (
            task_input_models.PlanningTask, task_input_models.PlanningTaskRevision,
            task_input_models.PlanningOperationReceipt,
        ))


@pytest.mark.parametrize("solution_count", [1, 40])
def test_save_accepts_current_solution_count_limits(api, solution_count):
    client, _factory = api
    body = request("save-limited")
    body["input"]["deploymentSolve"] = {"mode": "MIN_COUNT", "fixedCount": None, "solutionCount": solution_count}
    assert save(client, body).status_code == 200


def test_excess_solution_count_rejected_without_writing(api, monkeypatch):
    client, factory = api
    body = request("save-over-limit")
    body["input"]["deploymentSolve"] = {"mode": "MIN_COUNT", "fixedCount": None, "solutionCount": 41}
    reply = save(client, body)
    assert reply.status_code == 422
    assert reply.json()["code"] == 1001
    assert reply.json()["data"][0]["field"] == "deploymentSolve.solutionCount"
    assert counts(factory) == (0, 0, 0)
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "r1")
    monkeypatch.setattr(frontend_integration, "task_reference_catalog", lambda: {
        "node_ids": {"N1", "N2"}, "devices": {
            "E1": {"node_id": "N1", "device_class": "HF"},
            "E2": {"node_id": "N2", "device_class": "HF"}}})
    check = client.post("/api/v1/task-inputs/validate", json={key: value for key, value in body.items() if key != "request_id"})
    assert check.status_code == 200
    assert check.json()["data"]["valid"] is False
    assert any(row["field"] == "deploymentSolve.solutionCount" for row in check.json()["data"]["issues"])
    assert counts(factory) == (0, 0, 0)


def test_create_update_and_name_only_keeps_condition_version(api):
    client, factory = api
    first = save(client, request("save-1"))
    assert first.status_code == 200
    first_data = first.json()["data"]
    assert first_data["task_id"] == "T1"
    assert first_data["revision"] == first_data["input_version"]
    assert first_data["resource_revision"] == "r1"
    assert first_data["active_job_id"] is None
    second_request = request("save-2", first_data["revision"])
    second_request["input"]["name"] = "改名后的任务"
    second = save(client, second_request)
    assert second.status_code == 200
    second_data = second.json()["data"]
    assert second_data["revision"] != first_data["revision"]
    assert second_data["condition_version"] == first_data["condition_version"]
    third_request = request("save-3", second_data["revision"])
    third_request["input"]["demands"][0]["minReliability"] = 0
    third = save(client, third_request)
    assert third.status_code == 200
    assert third.json()["data"]["condition_version"] != second_data["condition_version"]
    assert counts(factory) == (1, 3, 3)


def test_noop_save_keeps_version_and_creates_receipt(api):
    client, factory = api
    first = save(client, request("save-1")).json()["data"]
    second = save(client, request("save-2", first["revision"]))
    assert second.status_code == 200
    assert second.json()["data"] == first
    assert counts(factory) == (1, 1, 2)


def test_task_list_search_pagination_and_context(api):
    client, _factory = api
    for task_id, name, context in (
            ("T1", "第一通信任务", "planning"),
            ("T2", "第二通信任务", "planning"),
            ("G1", "GIS 任务", "gis")):
        body = request("save-" + task_id)
        body["task_id"] = task_id
        body["context"] = context
        body["input"]["name"] = name
        assert client.put(f"/api/v1/task-inputs/{task_id}", json=body).status_code == 200
    page = client.get("/api/v1/task-inputs", params={
        "context": "planning", "page": 1, "page_size": 5,
    })
    assert page.status_code == 200
    data = page.json()["data"]
    assert data["total"] == 2
    assert data["page"] == 1 and data["page_size"] == 5
    assert {row["task_id"] for row in data["items"]} == {"T1", "T2"}
    assert all(row["revision"] == row["input_version"] for row in data["items"])
    assert client.get("/api/v1/task-inputs", params={
        "context": "planning", "page": 2, "page_size": 5,
    }).json()["data"]["items"] == []
    searched = client.get("/api/v1/task-inputs", params={
        "context": "planning", "page": 1, "page_size": 10, "search": "第二",
    }).json()["data"]
    assert searched["total"] == 1 and searched["items"][0]["task_id"] == "T2"
    by_id = client.get("/api/v1/task-inputs", params={
        "context": "planning", "page": 1, "page_size": 10, "search": "T1",
    }).json()["data"]
    assert by_id["total"] == 1 and by_id["items"][0]["task_id"] == "T1"
    gis = client.get("/api/v1/task-inputs", params={
        "context": "gis", "page": 1, "page_size": 10,
    }).json()["data"]
    assert gis["total"] == 1 and gis["items"][0]["task_id"] == "G1"


def test_task_detail_reads_current_version_and_hides_other_context(api):
    client, _factory = api
    first = save(client, request("save-1")).json()["data"]
    changed = request("save-2", first["revision"])
    changed["input"]["name"] = "最新任务版本"
    latest = save(client, changed).json()["data"]
    detail = client.get("/api/v1/task-inputs/T1", params={"context": "planning"})
    assert detail.status_code == 200
    assert detail.json()["data"] == latest
    assert client.get("/api/v1/task-inputs/T1", params={
        "context": "gis",
    }).status_code == 404
    missing = client.get("/api/v1/task-inputs/T2", params={"context": "planning"})
    assert missing.status_code == 404 and missing.json()["code"] == 2001


def test_task_detail_and_list_return_recent_persisted_job(api):
    client, factory = api
    saved = save(client, request("save-1")).json()["data"]
    now = datetime.now(timezone.utc)
    with factory.begin() as session:
        session.add(PlanningJob(
            job_id="J1", request_id="submit-1", request_digest="digest",
            task_id="T1", revision_id=saved["revision"],
            condition_version=saved["condition_version"],
            resource_revision=saved["resource_revision"], context="planning",
            parent_plan_id=None, adjustment=None, status="SUCCESS",
            progress=1.0, stage="完成", error=None,
            created_at=now, updated_at=now,
        ))
    detail = client.get("/api/v1/task-inputs/T1", params={"context": "planning"})
    assert detail.json()["data"]["active_job_id"] == "J1"
    page = client.get("/api/v1/task-inputs", params={
        "context": "planning", "page": 1, "page_size": 10,
    })
    assert page.json()["data"]["items"][0]["active_job_id"] == "J1"


@pytest.mark.parametrize("params", [
    {"context": "planning", "page": 0, "page_size": 10},
    {"context": "planning", "page": 1, "page_size": 7},
    {"context": "other", "page": 1, "page_size": 10},
    {"context": "planning", "page": 1, "page_size": 10, "search": "x" * 121},
])
def test_task_list_rejects_invalid_query(api, params):
    response = api[0].get("/api/v1/task-inputs", params=params)
    assert response.status_code == 422 and response.json()["code"] == 1001


def test_task_validation_returns_current_task_without_writing(api, monkeypatch):
    client, factory = api
    saved = save(client, request("save-1")).json()["data"]
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "r1")
    monkeypatch.setattr(frontend_integration, "task_reference_catalog", lambda: {
        "node_ids": {"N1", "N2", "N3"},
        "devices": {"E1": {"node_id": "N1", "device_class": "HF"},
                    "E2": {"node_id": "N2", "device_class": "HF"}},
    })
    body = {"context": "planning", "task_id": "T1",
            "expected_revision": "older-revision", "resource_revision": "r1",
            "input": sample_input()}
    valid = client.post("/api/v1/task-inputs/validate", json=body)
    assert valid.status_code == 200
    assert valid.json()["data"] == {"valid": True, "issues": [], "task": saved}
    assert counts(factory) == (1, 1, 1)

    body["input"]["stationIds"][1] = "N3"
    body["input"]["demands"][0]["targetId"] = "N3"
    invalid = client.post("/api/v1/task-inputs/validate", json=body)
    assert invalid.status_code == 200
    assert invalid.json()["data"]["valid"] is False
    assert any(issue["objectId"] == "N3" and issue["field"] == "stationIds"
               for issue in invalid.json()["data"]["issues"])
    assert counts(factory) == (1, 1, 1)


def test_task_validation_checks_device_los_and_structure(api, monkeypatch):
    client, _factory = api
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "r1")
    monkeypatch.setattr(frontend_integration, "task_reference_catalog", lambda: {
        "node_ids": {"N1", "N2"},
        "devices": {"E1": {"node_id": "N1", "device_class": "HF"},
                    "E2": {"node_id": "N2", "device_class": "VUHF"}},
    })
    body = {"context": "planning", "task_id": "T1", "expected_revision": None,
            "resource_revision": "r1", "input": sample_input()}
    demand = body["input"]["demands"][0]
    demand.update(endpointMode="device", sourceDeviceId="E1",
                  targetDeviceId="E2", preferredClass="HF")
    result = client.post("/api/v1/task-inputs/validate", json=body)
    assert result.status_code == 200
    assert any(issue["field"] == "preferredClass"
               for issue in result.json()["data"]["issues"])
    demand["targetDeviceId"] = "E3"
    result = client.post("/api/v1/task-inputs/validate", json=body)
    assert any(issue["field"] == "devices" for issue in result.json()["data"]["issues"])
    demand["targetDeviceId"] = "E2"
    demand["preferredClass"] = None
    body["input"]["deploymentConstraints"] = {
        "maxSlopeDeg": None, "elevationRangeM": None,
        "allowedLandcover": None, "roadMaxDistanceM": None,
        "minSiteSpacingM": None, "losRequiredNodeIds": ["MISSING"],
        "gridStepM": None, "forcedInclude": [],
        "forcedExcludePolygons": [],
    }
    result = client.post("/api/v1/task-inputs/validate", json=body)
    assert any(issue["field"] == "deploymentConstraints.losRequiredNodeIds"
               for issue in result.json()["data"]["issues"])
    body["input"]["demands"][0]["minReliability"] = 1.5
    malformed = client.post("/api/v1/task-inputs/validate", json=body)
    assert malformed.status_code == 200
    assert malformed.json()["data"]["valid"] is False
    assert any(issue["objectId"] == "D1" and "minReliability" in issue["field"]
               for issue in malformed.json()["data"]["issues"])


def test_task_validation_uses_real_resource_snapshot(api):
    client, _factory = api
    default = frontend_integration.planning_preset_catalog()["data"]["items"][0]["defaults"]
    body = {"context": "planning", "task_id": "T-REAL",
            "expected_revision": None,
            "resource_revision": frontend_integration.resource_revision(),
            "input": default}
    checked = client.post("/api/v1/task-inputs/validate", json=body)
    assert checked.status_code == 200
    assert checked.json()["data"] == {"valid": True, "issues": [], "task": None}
    body["resource_revision"] = "stale"
    stale = client.post("/api/v1/task-inputs/validate", json=body)
    assert stale.status_code == 409 and stale.json()["code"] == 1205


def test_stale_revision_and_existing_task_without_revision(api):
    client, factory = api
    first = save(client, request("save-1")).json()["data"]
    for body in (request("save-2"), request("save-3", "stale")):
        response = save(client, body)
        assert response.status_code == 409
        assert response.json()["code"] == 1203
        assert response.json()["data"]["actual"] == first["revision"]
    assert counts(factory) == (1, 1, 1)


def test_idempotent_replay_returns_original_snapshot(api):
    client, factory = api
    body = request("save-1")
    first = save(client, body).json()["data"]
    updated = request("save-2", first["revision"])
    updated["input"]["name"] = "新名称"
    assert save(client, updated).status_code == 200
    replay = save(client, body)
    assert replay.status_code == 200
    assert replay.json()["data"] == first
    changed = request("save-1")
    changed["input"]["name"] = "重用编号的不同请求"
    conflict = save(client, changed)
    assert conflict.status_code == 409
    assert conflict.json()["code"] == 1204
    assert counts(factory) == (1, 2, 2)


@pytest.mark.parametrize("change", ["path", "field", "reliability", "date", "control", "unknown"])
def test_invalid_input_does_not_write(api, change):
    client, factory = api
    body = request("invalid")
    path = "/api/v1/task-inputs/T1"
    if change == "path":
        path = "/api/v1/task-inputs/T2"
    elif change == "field":
        body["input"]["stationIds"] = ["N1", "N1"]
    elif change == "reliability":
        body["input"]["demands"][0]["minReliability"] = 1.1
    elif change == "date":
        body["input"]["startTime"] = "2026-02-30T09:00:00+08:00"
    elif change == "control":
        body["input"]["description"] = "无效\u0001说明"
    else:
        body["input"]["unexpected"] = True
    response = client.put(path, json=body)
    assert response.status_code == 422
    assert response.json()["code"] == 1001
    assert counts(factory) == (0, 0, 0)


def test_failed_transaction_leaves_no_partial_rows(api, monkeypatch):
    client, factory = api

    def fail_condition(_input):
        raise RuntimeError("模拟版本计算失败")

    monkeypatch.setattr(task_input_service, "_condition_signature", fail_condition)
    with pytest.raises(RuntimeError, match="模拟版本计算失败"):
        save(client, request("save-1"))
    assert counts(factory) == (0, 0, 0)
