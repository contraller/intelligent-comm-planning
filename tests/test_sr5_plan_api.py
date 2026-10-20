"""SR5 正式诊断使用数据库当前确认的 SR4 方案。"""
from __future__ import annotations

import json
import sys
import time
from copy import deepcopy
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

from app import fault, fault_plan_source, kg, planning_w3  # noqa: E402
from app.database import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.planning_job_models import PlanningJob  # noqa: E402
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan  # noqa: E402
from app.fault_scenario_models import FaultScenarioVersion  # noqa: E402
from app.task_input_models import PlanningTask, PlanningTaskRevision  # noqa: E402


@pytest.fixture
def api(monkeypatch, tmp_path):
    engine = create_engine("sqlite+pysqlite:///:memory:",
                           connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(fault_plan_source, "get_session_factory", lambda: factory)
    monkeypatch.setattr(fault, "get_session_factory", lambda: factory)
    monkeypatch.setattr(fault_plan_source.frontend_integration, "resource_revision",
                        lambda: "resource-v1")
    monkeypatch.setattr(planning_w3, "TASK_DIR", tmp_path / "tasks")
    monkeypatch.setattr(fault, "STORE_PATH", tmp_path / "scenarios.json")
    monkeypatch.setattr(fault, "REPORT_DIR", tmp_path / "reports")
    monkeypatch.setattr(fault, "_SCENARIOS", None)
    monkeypatch.setattr(fault, "_ENGINE", None)
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "graph.json")
    monkeypatch.setattr(kg, "_GRAPH", None)
    monkeypatch.setattr(kg, "_STATE", None)
    with TestClient(app) as client:
        yield client, factory
    engine.dispose()


def _create_plan(factory, *, task_id="task-a", plan_id="plan-a", state="CONFIRMED",
                 current=True, resource_revision="resource-v1", raw=True):
    now = datetime.now(timezone.utc)
    node_a, node_b, device_id, link_id = "ND-FORMAL-A", "ND-FORMAL-B", "DV-FORMAL-A", "LK-FORMAL"
    detail = {
        "nodes": [
            {"node_id": node_a, "node_name": "测试节点 A", "lon": "114.0", "lat": "37.0",
             "node_role": "FIXED_STATION", "device_class": "HF"},
            {"node_id": node_b, "node_name": "测试节点 B", "lon": "114.1", "lat": "37.1",
             "node_role": "FIXED_STATION", "device_class": "HF"},
        ],
        "devices": [{"device_id": device_id, "node_id": node_a,
                     "model_id": "DM-0004", "device_class": "HF"},
                    {"device_id": "DV-FORMAL-B", "node_id": node_b,
                     "model_id": "DM-0004", "device_class": "HF"}],
        "links": [{"link_id": link_id, "node_a_id": node_a, "node_b_id": node_b,
                   "device_a_id": device_id, "device_b_id": "DV-FORMAL-B", "device_class": "HF",
                   "is_backup": "false"}],
        "routes": {"routes": [{"demand_id": "demand-a", "primary": {
            "node_path": [node_a, node_b], "link_path": [link_id]}, "backup": None}]},
    }
    with factory.begin() as session:
        session.add(PlanningTask(task_id=task_id, current_revision_id=f"rev-{task_id}",
                                 current_version_no=1, created_at=now, updated_at=now))
        session.add(PlanningTaskRevision(revision_id=f"rev-{task_id}", task_id=task_id,
                                         version_no=1, condition_version="condition-v1",
                                         resource_revision=resource_revision, context="planning",
                                         input_snapshot={}, created_at=now))
        session.add(PlanningJob(job_id=f"job-{task_id}", request_id=f"run-{task_id}",
                                request_digest="digest", task_id=task_id,
                                revision_id=f"rev-{task_id}", condition_version="condition-v1",
                                resource_revision=resource_revision, context="planning",
                                parent_plan_id=None, adjustment=None, status="SUCCESS",
                                progress=1.0, stage="完成", error=None,
                                created_at=now, updated_at=now))
        session.add(PlanningPlan(plan_id=plan_id, request_id=f"save-{task_id}",
                                 request_digest="digest", task_id=task_id,
                                 job_id=f"job-{task_id}", revision_id=f"rev-{task_id}",
                                 condition_version="condition-v1",
                                 resource_revision=resource_revision, parent_plan_id=None,
                                 adjustment=None, version_no=1, name="正式方案", note="",
                                 state=state, input_snapshot={"demands": [{
                                     "id": "demand-a", "requiredRateKbps": 128.0,
                                     "mandatory": True}]}, result_snapshot={},
                                 raw_snapshot={"summary": {"check_passed": True},
                                               "detail": detail} if raw else None,
                                 outcome_snapshot={}, source="SR4", saved_at=now,
                                 confirmed_at=now if state == "CONFIRMED" else None))
        if current:
            session.add(PlanningCurrentPlan(task_id=task_id, plan_id=plan_id,
                                            updated_at=now))
    return node_a, device_id, link_id


def _completed(client, task_id):
    for _ in range(100):
        response = client.get(f"/api/v1/fault/tasks/{task_id}")
        if response.json()["code"] != 2002:
            return response.json()
        time.sleep(0.01)
    pytest.fail("SR5 任务未完成")


def test_confirmed_plan_diagnosis_uses_frozen_network_and_scenario(api):
    client, factory = api
    node_id, device_id, link_id = _create_plan(factory)
    example = deepcopy(fault._engine().default_scenarios[0]["faults"][0])
    example.update(object_type="DEVICE", object_id=device_id, fault_type="HW_FAILURE")
    created = client.post("/api/v1/fault/scenarios", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_name": "冻结故障场景", "faults": [example]}).json()["data"]
    sid, version_id = created["scenario_id"], created["version_id"]

    sources = client.get("/api/v1/fault/plan-sources", params={"task_id": "task-a"})
    assert sources.status_code == 200
    assert sources.json()["data"]["items"][0]["plan_id"] == "plan-a"
    missing_mode = client.post("/api/v1/fault/diagnose", json={
        "task_id": "task-a", "plan_id": "plan-a", "scenario_id": sid})
    assert missing_mode.json()["code"] == 1001
    missing_plan = client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "scenario_id": sid})
    assert missing_plan.status_code == 422
    assert missing_plan.json()["code"] == 1001
    submitted = client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_id": sid, "scenario_version_id": version_id,
        "request_id": "diagnose-a"})
    assert submitted.json()["code"] == 0
    diagnosed = _completed(client, submitted.json()["data"]["task_id"])
    assert diagnosed["code"] == 0
    assert diagnosed["data"]["network_solution_id"] == "plan-a"
    assert diagnosed["data"]["scenario_version_id"] == version_id
    assert diagnosed["data"]["results"][0]["fault_object"]["object_id"] == device_id

    with factory.begin() as session:
        version = session.get(FaultScenarioVersion, version_id)
        version.snapshot = {"scenario_name": "已变更", "faults": [{**example, "object_id": "DV-INVALID"}]}
        session.delete(session.get(PlanningCurrentPlan, "task-a"))
    wrong_impact = client.post("/api/v1/fault/impact", json={
        "diagnose_task_id": submitted.json()["data"]["task_id"],
        "task_id": "task-a", "plan_id": "other-plan", "request_id": "impact-wrong"})
    assert wrong_impact.json()["code"] == 1001
    impact = client.post("/api/v1/fault/impact", json={
        "diagnose_task_id": submitted.json()["data"]["task_id"],
        "task_id": "task-a", "plan_id": "plan-a", "request_id": "impact-a"})
    assert impact.json()["code"] == 0
    affected = _completed(client, impact.json()["data"]["task_id"])
    assert affected["code"] == 0
    assert affected["data"]["network_solution_id"] == "plan-a"
    assert affected["data"]["affected_links"][0]["link_id"] == link_id
    assert any(row["node_id"] == node_id for row in affected["data"]["affected_nodes"])
    report = client.post("/api/v1/fault/report", json={
        "diagnose_task_id": submitted.json()["data"]["task_id"],
        "impact_task_id": impact.json()["data"]["task_id"], "format": "json"}).json()
    content = json.loads(client.get(report["data"]["report_url"]).content)
    assert content["scenario"]["faults"][0]["object_id"] == device_id


@pytest.mark.parametrize("state,current,revision,raw,expected", [
    ("SAVED", True, "resource-v1", True, 1203),
    ("CONFIRMED", False, "resource-v1", True, 2001),
    ("CONFIRMED", True, "resource-old", True, 1205),
    ("CONFIRMED", True, "resource-v1", False, 1203),
])
def test_formal_diagnosis_rejects_ineligible_plan(api, state, current, revision, raw, expected):
    client, factory = api
    _create_plan(factory, state=state, current=current, resource_revision=revision, raw=raw)
    response = client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_id": "FS-0001", "request_id": "invalid-plan"})
    assert response.json()["code"] == expected
    assert response.status_code in {404, 409}


def test_formal_diagnosis_rejects_cross_task_and_impact_mismatch(api):
    client, factory = api
    _create_plan(factory)
    response = client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "other-task", "plan_id": "plan-a",
        "scenario_id": "FS-0001", "request_id": "cross-task"})
    assert response.status_code == 404
    assert response.json()["code"] == 2001
    assert client.get("/api/v1/fault/plan-sources", params={"task_id": "other-task"}).json()["data"]["items"] == []


def test_formal_diagnosis_rejects_broken_route_snapshot(api):
    client, factory = api
    _create_plan(factory)
    with factory.begin() as session:
        plan = session.get(PlanningPlan, "plan-a")
        raw = deepcopy(plan.raw_snapshot)
        raw["detail"]["routes"]["routes"][0]["primary"]["link_path"] = ["LK-MISSING"]
        plan.raw_snapshot = raw
    response = client.post("/api/v1/fault/diagnose", json={
        "context": "planning", "task_id": "task-a", "plan_id": "plan-a",
        "scenario_id": "FS-0001", "request_id": "broken-route"})
    assert response.status_code == 409
    assert response.json()["code"] == 1203
