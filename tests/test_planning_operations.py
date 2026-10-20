"""规划写操作回执的真实 HTTP 与持久化读取测试。"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.database import Base  # noqa: E402
from app.main import app  # noqa: E402
from app import planning_operation_service, task_input_service  # noqa: E402
from app.planning_job_models import PlanningJob, PlanningJobCancellation  # noqa: E402
from app.planning_plan_models import PlanningPlan, PlanningPlanConfirmation  # noqa: E402
from app.task_input_models import (PlanningOperationReceipt, PlanningTask,
                                   PlanningTaskRevision)  # noqa: E402


@pytest.fixture
def api(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    with factory.begin() as session:
        session.add(PlanningTask(task_id="T1", current_revision_id="R1",
                                 current_version_no=1, created_at=now, updated_at=now))
        session.flush()
        session.add(PlanningTaskRevision(
            revision_id="R1", task_id="T1", version_no=1,
            condition_version="C1", resource_revision="RES1",
            context="planning", input_snapshot={}, created_at=now,
        ))
        session.flush()
        session.add(PlanningOperationReceipt(
            request_id="save-task", request_digest="digest", operation="saveTask",
            task_id="T1", revision_id="R1", state="SUCCEEDED",
            message="任务已保存", created_at=now,
        ))
        session.add(PlanningJob(
            job_id="J1", request_id="submit", request_digest="digest",
            task_id="T1", revision_id="R1", condition_version="C1",
            resource_revision="RES1", context="planning", parent_plan_id=None,
            adjustment=None, status="FAILED", progress=1.0, stage="计算结束",
            error="算法未达标", created_at=now, updated_at=now,
        ))
        session.flush()
        session.add(PlanningJobCancellation(
            request_id="cancel", request_digest="digest", job_id="J1",
            task_id="T1", revision_id="R1", outcome_status="FAILED", created_at=now,
        ))
        session.add(PlanningPlan(
            plan_id="P1", request_id="save-plan", request_digest="digest",
            task_id="T1", job_id="J1", revision_id="R1",
            condition_version="C1", resource_revision="RES1",
            parent_plan_id=None, adjustment=None, version_no=1,
            name="测试方案", note="", state="CONFIRMED", input_snapshot={},
            result_snapshot={}, raw_snapshot=None, outcome_snapshot={},
            source="SR4", saved_at=now, confirmed_at=now,
        ))
        session.flush()
        session.add(PlanningPlanConfirmation(
            request_id="confirm", request_digest="digest", plan_id="P1",
            task_id="T1", revision_id="R1", created_at=now,
        ))
    monkeypatch.setattr(planning_operation_service, "get_session_factory", lambda: factory)
    monkeypatch.setattr(task_input_service, "get_session_factory", lambda: factory)
    yield TestClient(app)
    engine.dispose()


@pytest.mark.parametrize("kind,request_id,entity_id", [
    ("saveTask", "save-task", "T1"), ("submit", "submit", "J1"),
    ("cancel", "cancel", "J1"), ("savePlan", "save-plan", "P1"),
    ("confirm", "confirm", "P1"),
])
def test_receipt_reads_each_persisted_operation(api, kind, request_id, entity_id):
    response = api.get(f"/api/v1/planning-operations/{request_id}", params={
        "context": "planning", "task_id": "T1", "kind": kind,
    })
    assert response.status_code == 200
    assert response.json()["data"] == {
        "request_id": request_id, "task_id": "T1", "kind": kind,
        "state": "SUCCEEDED", "entity_id": entity_id,
        "message": response.json()["data"]["message"],
    }
    assert response.json()["data"]["message"]


def test_receipt_tracks_write_success_not_algorithm_result(api):
    response = api.get("/api/v1/planning-operations/submit", params={
        "context": "planning", "task_id": "T1", "kind": "submit",
    })
    assert response.json()["data"]["state"] == "SUCCEEDED"
    assert response.json()["data"]["entity_id"] == "J1"


def test_saved_task_can_be_recovered_by_request_id(api):
    task_input = {
        "name": "回执测试", "description": "", "bbox": [113, 36, 116, 39],
        "stationIds": ["N1", "N2"], "presetId": "P1", "frequencyId": "F1",
        "constraints": {"connectivityPercent": 100, "maxRelayHops": 2,
                        "survivabilityPercent": 90},
        "demands": [{
            "id": "D1", "sourceId": "N1", "targetId": "N2",
            "service": "数据", "priority": "P1", "mandatory": True,
            "dataVolumeMb": 10, "requiredRateKbps": 64,
            "maxDelayMs": 100, "minReliability": 0.95,
        }],
    }
    saved = api.put("/api/v1/task-inputs/T2", json={
        "context": "planning", "task_id": "T2", "expected_revision": None,
        "resource_revision": "RES1", "request_id": "save-live",
        "input": task_input,
    })
    assert saved.status_code == 200
    receipt = api.get("/api/v1/planning-operations/save-live", params={
        "context": "planning", "task_id": "T2", "kind": "saveTask",
    })
    assert receipt.status_code == 200
    assert receipt.json()["data"]["state"] == "SUCCEEDED"
    assert receipt.json()["data"]["entity_id"] == "T2"


def test_missing_receipt_is_not_found_without_false_failure(api):
    response = api.get("/api/v1/planning-operations/unknown", params={
        "context": "planning", "task_id": "T1", "kind": "saveTask",
    })
    assert response.status_code == 200
    assert response.json()["data"] == {
        "request_id": "unknown", "task_id": "T1", "kind": "saveTask",
        "state": "NOT_FOUND", "entity_id": None,
        "message": "没有此请求回执",
    }


@pytest.mark.parametrize("request_id,task_id,kind,context,code,status", [
    ("save-task", "OTHER", "saveTask", "planning", 1204, 409),
    ("submit", "T1", "saveTask", "planning", 1204, 409),
    ("submit", "T1", "submit", "gis", 1001, 422),
    ("save-task", "T1", "saveTask", "gis", 1204, 409),
    ("unknown", "T1", "wrong", "planning", 1001, 422),
    ("unknown", "", "saveTask", "planning", 1001, 422),
])
def test_receipt_rejects_wrong_owner_kind_or_query(
        api, request_id, task_id, kind, context, code, status):
    response = api.get(f"/api/v1/planning-operations/{request_id}", params={
        "context": context, "task_id": task_id, "kind": kind,
    })
    assert response.status_code == status
    assert response.json()["code"] == code
    assert response.json()["data"] is None or code == 1001
