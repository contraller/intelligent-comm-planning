"""规划作业历史目录的接口与持久化验证。"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


ROOT = Path(__file__).resolve().parents[2]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import planning_job_service  # noqa: E402
from app.database import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.planning_job_models import PlanningJob  # noqa: E402
from app.task_input_models import PlanningTask, PlanningTaskRevision  # noqa: E402


@pytest.fixture
def persisted_api(monkeypatch):
    runtime = ROOT / "data" / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    database_path = runtime / f"planning_job_history_{uuid.uuid4().hex}.sqlite"
    url = f"sqlite:///{database_path.as_posix()}"
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(planning_job_service, "get_session_factory", lambda: factory)
    yield TestClient(app), factory, url, engine
    engine.dispose()


def seed(factory):
    now = datetime(2026, 10, 22, 9, 0, tzinfo=timezone.utc)
    with factory.begin() as session:
        session.add(PlanningTask(task_id="T1", current_revision_id="R2",
                                 current_version_no=2, created_at=now, updated_at=now))
        session.add(PlanningTask(task_id="T2", current_revision_id="R3",
                                 current_version_no=1, created_at=now, updated_at=now))
        session.flush()
        for revision_id, task_id, version, name in (
            ("R1", "T1", 1, "原始任务"),
            ("R2", "T1", 2, "已改名任务"),
            ("R3", "T2", 1, "第二任务"),
        ):
            session.add(PlanningTaskRevision(
                revision_id=revision_id, task_id=task_id, version_no=version,
                condition_version="C1", resource_revision="demo", context="planning",
                input_snapshot={"name": name}, created_at=now,
            ))
        session.flush()
        for index, revision_id, task_id, status in (
            (1, "R1", "T1", "SUCCESS"),
            (2, "R3", "T2", "FAILED"),
            (3, "R2", "T1", "PENDING"),
        ):
            session.add(PlanningJob(
                job_id=f"J{index}", request_id=f"run-{index}",
                request_digest="digest", task_id=task_id, revision_id=revision_id,
                condition_version="C1", resource_revision="demo", context="planning",
                parent_plan_id=None, adjustment=None, status=status, progress=0.0,
                stage="测试", error=None, created_at=now + timedelta(minutes=index),
                updated_at=now + timedelta(minutes=index),
            ))


def page(client, **params):
    return client.get("/api/v1/plan/jobs", params={
        "context": "planning", "page": 1, "page_size": 5, **params,
    })


def test_history_is_paged_searchable_and_uses_frozen_name(persisted_api):
    client, factory, _url, _engine = persisted_api
    assert page(client).json()["data"] == {
        "items": [], "total": 0, "page": 1, "page_size": 5,
        "data_origin": "SYNTHETIC_INTEGRATION",
    }
    seed(factory)
    first = page(client).json()["data"]
    assert first["total"] == 3
    assert [row["job_id"] for row in first["items"]] == ["J3", "J2", "J1"]
    assert first["items"][-1]["name"] == "原始任务"
    assert first["items"][-1]["created_at"].endswith("+00:00")
    assert page(client, search="原始").json()["data"]["items"][0]["job_id"] == "J1"
    assert page(client, search="J2").json()["data"]["total"] == 1
    assert page(client, search="T1").json()["data"]["total"] == 2
    assert page(client, page=2).json()["data"]["items"] == []
    assert page(client, search="%").json()["data"]["total"] == 0


@pytest.mark.parametrize("params", [
    {"context": "gis"}, {"context": "other"}, {"context": ""},
    {"page": 0}, {"page_size": 7}, {"search": "x" * 121},
])
def test_history_rejects_invalid_query(persisted_api, params):
    client = persisted_api[0]
    response = page(client, **params)
    assert response.status_code == 422
    assert response.json()["code"] == 1001


def test_history_survives_new_database_connection(persisted_api, monkeypatch):
    client, factory, url, engine = persisted_api
    seed(factory)
    engine.dispose()
    reopened = create_engine(url)
    monkeypatch.setattr(planning_job_service, "get_session_factory", lambda: sessionmaker(
        bind=reopened, expire_on_commit=False))
    result = page(client).json()["data"]
    assert result["total"] == 3
    assert result["items"][-1]["name"] == "原始任务"
    reopened.dispose()
