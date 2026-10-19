"""规划任务保存接口的数据库行为测试。"""
from __future__ import annotations

import sys
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
from app import task_input_models, task_input_service  # noqa: E402


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
