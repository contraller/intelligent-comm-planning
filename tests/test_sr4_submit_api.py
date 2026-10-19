"""版本化 SR4 作业提交接口测试。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import frontend_integration, planning_job_models  # noqa: E402
from app import planning_job_service, task_input_service  # noqa: E402
from app.database import Base  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(task_input_service, "get_session_factory", lambda: factory)
    monkeypatch.setattr(planning_job_service, "get_session_factory", lambda: factory)
    calls = []

    def fake_submit(payload, *, job_id, on_update):
        calls.append((payload, job_id))
        on_update({"status": "PENDING", "progress": 0.0,
                   "stage": "排队中", "error": None})
        return {"code": 0, "message": "success",
                "data": {"task_id": job_id, "estimated_sec": 5}}

    monkeypatch.setattr(planning_job_service.planning_w4, "submit_sr4", fake_submit)
    yield TestClient(app), factory, calls
    engine.dispose()


def _save_task(client: TestClient, task_id: str = "frontend-task-1",
               demand_id: str | None = None) -> dict:
    workspace = client.get(
        "/api/v1/resource/context", params={"context": "planning"}
    ).json()["data"]
    preset = client.get(
        "/api/v1/resource/param-presets", params={"context": "planning"}
    ).json()["data"]["items"][0]
    if demand_id is not None:
        preset["defaults"]["demands"][0]["id"] = demand_id
    response = client.put(f"/api/v1/task-inputs/{task_id}", json={
        "context": "planning",
        "task_id": task_id,
        "expected_revision": None,
        "resource_revision": workspace["revision"],
        "request_id": f"save-{task_id}",
        "input": preset["defaults"],
    })
    assert response.status_code == 200
    return response.json()["data"]


def _submit(saved: dict, request_id: str = "submit-1") -> dict:
    return {
        "context": "planning",
        "request_id": request_id,
        "task_id": saved["task_id"],
        "expected_revision": saved["revision"],
        "input_version": saved["input_version"],
        "condition_version": saved["condition_version"],
        "resource_revision": saved["resource_revision"],
        "parent_plan_id": None,
    }


def test_submit_saved_task_returns_frontend_job_and_starts_real_entry(api):
    client, factory, calls = api
    saved = _save_task(client)
    response = client.post("/api/v1/plan/sr4-flow", json=_submit(saved))
    assert response.status_code == 202
    body = response.json()
    assert body["code"] == 0
    assert body["request_id"] == "submit-1"
    job = body["data"]
    assert job["task_id"] == saved["task_id"]
    assert job["revision"] == saved["revision"]
    assert job["input_version"] == saved["input_version"]
    assert job["condition_version"] == saved["condition_version"]
    assert job["resource_revision"] == saved["resource_revision"]
    assert job["input"] == saved["input"]
    assert job["status"] == "PENDING"
    assert job["progress"] == 0
    assert job["result"] is None and job["outcome"] is None
    assert len(job["phases"]) == 5
    assert len(calls) == 1
    algorithm_payload, job_id = calls[0]
    assert job_id == job["job_id"]
    assert algorithm_payload["task_id"] == saved["task_id"]
    assert algorithm_payload["preset"] == "TERRAIN"
    assert algorithm_payload["hard_constraints"] == {
        "mandatory_e2e_connectivity": 1.0,
        "survivability_threshold": 0.9,
        "max_relay_hops": 2,
    }
    assert algorithm_payload["demand_rows"][0]["demand_id"] == "DEMAND-01"
    assert algorithm_payload["demand_rows"][0]["task_id"] == saved["task_id"]
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(
            planning_job_models.PlanningJob)) == 1


def test_submit_is_idempotent_and_blocks_second_active_job(api):
    client, _, calls = api
    saved = _save_task(client)
    request = _submit(saved)
    first = client.post("/api/v1/plan/sr4-flow", json=request)
    replay = client.post("/api/v1/plan/sr4-flow", json=request)
    assert replay.status_code == 202
    assert replay.json()["data"]["job_id"] == first.json()["data"]["job_id"]
    assert len(calls) == 1

    conflict = dict(request, condition_version="TCOND-different")
    reused = client.post("/api/v1/plan/sr4-flow", json=conflict)
    assert reused.status_code == 409
    assert reused.json()["code"] == 1204

    another = client.post(
        "/api/v1/plan/sr4-flow", json=_submit(saved, "submit-2")
    )
    assert another.status_code == 409
    assert another.json()["code"] == 2002
    assert another.json()["data"]["job_id"] == first.json()["data"]["job_id"]


def test_submit_rejects_stale_task_and_resource_versions(api, monkeypatch):
    client, _, calls = api
    saved = _save_task(client)
    stale = _submit(saved)
    stale["expected_revision"] = "TREV-stale"
    response = client.post("/api/v1/plan/sr4-flow", json=stale)
    assert response.status_code == 409
    assert response.json()["code"] == 1203

    monkeypatch.setattr(frontend_integration, "resource_revision",
                        lambda: "resource-new-version")
    changed = client.post(
        "/api/v1/plan/sr4-flow", json=_submit(saved, "submit-resource-changed")
    )
    assert changed.status_code == 409
    assert changed.json()["code"] == 1205
    assert calls == []


def test_submit_rejects_adjustment_and_unknown_fields(api):
    client, _, calls = api
    saved = _save_task(client)
    adjusted = _submit(saved)
    adjusted["adjustment"] = {"manual_override": []}
    response = client.post("/api/v1/plan/sr4-flow", json=adjusted)
    assert response.status_code == 422
    assert response.json()["code"] == 1001

    unknown = _submit(saved, "submit-extra")
    unknown["unexpected"] = True
    invalid = client.post("/api/v1/plan/sr4-flow", json=unknown)
    assert invalid.status_code == 422
    assert invalid.json()["code"] == 1001
    assert invalid.json()["data"][0]["field"] == "unexpected"
    assert calls == []


def test_submit_rejects_demand_id_owned_by_another_task(api):
    client, _, calls = api
    saved = _save_task(client, demand_id="CD-0001")
    response = client.post("/api/v1/plan/sr4-flow", json=_submit(saved))
    assert response.status_code == 422
    assert response.json()["code"] == 1001
    assert "CD-0001" in response.json()["message"]
    assert calls == []
