"""已保存方案历史的只读契约、筛选和重开数据库验证。"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import frontend_integration, planning_plan_service  # noqa: E402
from app.database import Base, DatabaseConfigurationError  # noqa: E402
from app.main import app  # noqa: E402
from app.planning_job_models import PlanningJob  # noqa: E402
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan  # noqa: E402
from app.task_input_models import PlanningTask, PlanningTaskRevision  # noqa: E402


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "current")
    runtime = ROOT / "data/runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    url = f"sqlite:///{(runtime / ('plan_history_' + uuid.uuid4().hex + '.sqlite')).as_posix()}"
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(planning_plan_service, "get_session_factory", lambda: factory)
    yield TestClient(app), factory, engine, url
    engine.dispose()


def seed(factory):
    now = datetime(2026, 10, 23, tzinfo=timezone.utc)
    with factory.begin() as session:
        for task_id in ("T1", "T2"):
            session.add(PlanningTask(task_id=task_id, current_revision_id="R" + task_id,
                                    current_version_no=1, created_at=now, updated_at=now))
        session.flush()
        for task_id in ("T1", "T2"):
            session.add(PlanningTaskRevision(revision_id="R" + task_id, task_id=task_id,
                version_no=1, condition_version="C1", resource_revision="current", context="planning",
                input_snapshot={"name": "当前任务名"}, created_at=now))
        session.flush()
        for index in range(1, 8):
            task_id = "T1" if index < 5 else "T2"
            session.add(PlanningJob(job_id=f"J{index}", request_id=f"run-{index}", request_digest="d",
                task_id=task_id, revision_id="R" + task_id, condition_version="C1", resource_revision="current",
                context="planning", status="SUCCESS", progress=1, stage="完成", created_at=now, updated_at=now))
        session.flush()
        for index in range(1, 8):
            task_id = "T1" if index < 5 else "T2"
            state = "CONFIRMED" if index == 7 else "REFERENCE" if index == 6 else "SAVED"
            session.add(PlanningPlan(plan_id=f"P{index}", request_id=f"save-{index}", request_digest="d",
                task_id=task_id, job_id=f"J{index}", revision_id="R" + task_id, condition_version="C1",
                resource_revision="current", version_no=index, name=f"冻结方案{index}", note="",
                state=state, input_snapshot={"name": "保存时输入"}, result_snapshot={"frozen": index},
                outcome_snapshot={"code": 0}, source="SR4", saved_at=now,
                confirmed_at=now if state == "CONFIRMED" else None))
        session.flush()
        session.add(PlanningCurrentPlan(task_id="T2", plan_id="P7", updated_at=now))


def page(client, **params):
    return client.get("/api/v1/plan/saved-plans", params={"context": "planning", "page_size": 5, **params})


def test_summary_is_lean_paged_and_searchable(api):
    client, factory, engine, _ = api
    assert page(client).json()["data"]["items"] == []
    seed(factory)
    statements = []
    event.listen(engine, "before_cursor_execute", lambda _c, _cu, sql, _p, _ct, _e: statements.append(sql))
    result = page(client).json()["data"]
    assert result["data_origin"] == "SYNTHETIC_INTEGRATION"
    assert result["total"] == 7
    assert [row["plan_id"] for row in result["items"]] == ["P7", "P6", "P5", "P4", "P3"]
    assert set(result["items"][0]) == {"plan_id", "task_id", "name", "version", "state", "current", "source_changed", "saved_at"}
    assert result["items"][0]["current"] is True
    assert all("input_snapshot" not in sql and "result_snapshot" not in sql for sql in statements)
    assert [row["plan_id"] for row in page(client, page=2).json()["data"]["items"]] == ["P2", "P1"]
    for search, total in (("冻结方案1", 1), ("P2", 1), ("J3", 1), ("T1", 4), ("%", 0), ("_", 0)):
        assert page(client, search=search).json()["data"]["total"] == total
    assert page(client, page=3).json()["data"]["items"] == []
    assert page(client, state="REFERENCE").json()["data"]["items"][0]["plan_id"] == "P6"
    assert page(client, state="CONFIRMED", search="不存在").json()["data"]["total"] == 0


@pytest.mark.parametrize("params", [{"context": "gis"}, {"context": ""}, {"page": 0},
    {"page": "1.5"}, {"page_size": 7}, {"state": "ALL"}, {"search": "a" * 121}, {"search": "a\nb"}])
def test_invalid_queries_are_rejected(api, params):
    response = page(api[0], **params)
    assert response.status_code == 422
    assert response.json()["code"] == 1001


def test_mode_gate_and_missing_context(api, monkeypatch):
    client = api[0]
    assert client.get("/api/v1/plan/saved-plans").status_code == 422
    monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO")
    response = page(client)
    assert response.status_code == 401 and response.json()["code"] == 1101


def test_resource_change_only_changes_display_and_never_confirmation(api, monkeypatch):
    client, factory, _, _ = api
    seed(factory)
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "new")
    row = page(client, state="CONFIRMED").json()["data"]["items"][0]
    assert row["state"] == "CONFIRMED" and row["source_changed"] is True and row["current"] is False
    with factory() as session:
        assert session.get(PlanningCurrentPlan, "T2").plan_id == "P7"


def test_reopen_and_detail_ownership(api, monkeypatch):
    client, factory, engine, url = api
    seed(factory)
    engine.dispose()
    reopened = create_engine(url)
    monkeypatch.setattr(planning_plan_service, "get_session_factory", lambda: sessionmaker(bind=reopened, expire_on_commit=False))
    try:
        assert page(client).json()["data"]["total"] == 7
        good = client.get("/api/v1/plans/P7", params={"context": "planning", "task_id": "T2"})
        assert good.json()["data"]["result"] == {"frozen": 7}
        bad = client.get("/api/v1/plans/P7", params={"context": "planning", "task_id": "T1"})
        assert bad.status_code == 404 and bad.json()["code"] == 2001
    finally:
        reopened.dispose()


@pytest.mark.parametrize("error,code", [(DatabaseConfigurationError("missing"), 5001), (SQLAlchemyError("db"), 5002)])
def test_database_failures_keep_business_envelope(api, monkeypatch, error, code):
    def fail():
        raise error
    monkeypatch.setattr(planning_plan_service, "get_session_factory", fail)
    response = page(api[0])
    assert response.status_code == 503 and response.json()["code"] == code
