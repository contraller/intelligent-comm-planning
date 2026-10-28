import sys
import io
import hashlib
import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from openpyxl import load_workbook
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "planning"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app.main import app
from app import planning_w4 as planning
from app import planning_w3
from app import coverage
from app.runtime_store import write_json
from app.planning_w4 import _PLANS, _save_plan
from app import planning_plan_service as plans
from app.database import Base
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan, PlanningPlanConfirmation
from app.planning_plan_schemas import PlanningPlanConfirmRequest
from app.system_management_models import SystemAuditEvent
from app.task_input_models import PlanningTask, PlanningTaskRevision


@pytest.fixture
def quality_plan(monkeypatch):
    """只使用内存数据库和冻结构造结果，不启动算法或接触运行库。"""
    monkeypatch.setenv("AUTH_MODE", "OFF")
    monkeypatch.setattr(plans.frontend_integration, "resource_revision", lambda: "RES-RISK")
    engine = create_engine("sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(plans, "get_session_factory", lambda: factory)
    now = datetime.now(timezone.utc)
    frozen_input = {"demands": [{"id": "D1", "sourceId": "N1", "targetId": "N2",
        "requiredRateKbps": 64, "mandatory": True}]}
    result = {"snapshot_id": "SNP-PL-RISK", "metrics": {"connectivityPercent": 50,
        "survivabilityPercent": 40, "totalRadiatedPowerW": 100},
        "checks": [{"id": key, "label": label, "passed": False, "detail": label + "未达标"}
            for key, label in (("connectivity", "连通率"), ("survivability", "抗毁率"),
                              ("relay", "中继跳数"), ("frequency", "频率冲突"))]}
    raw = {"solution_id": "PL-RISK", "summary": {"check_passed": False}, "detail": {
        "nodes": [{"node_id": "N1"}, {"node_id": "N2"}],
        "devices": [{"device_id": "E1", "node_id": "N1"}, {"device_id": "E2", "node_id": "N2"}],
        "links": [{"link_id": "L1", "node_a_id": "N1", "node_b_id": "N2", "device_a_id": "E1", "device_b_id": "E2"}],
        "routes": {"routes": [{"demand_id": "D1", "primary": {"node_path": ["N1", "N2"], "link_path": ["L1"]}, "backup": None}]}}}
    outcome = {"code": 3001, "message": "硬约束未满足", "suggestions": ["调整方案"],
        "gap": [{"objectId": "D1", "field": "connectivity", "message": "通联未满足"},
                {"objectId": "L1", "field": "frequency", "message": "频率冲突"}]}
    with factory.begin() as session:
        session.add(PlanningTask(task_id="T-RISK", current_revision_id="R-RISK",
            current_version_no=1, created_at=now, updated_at=now))
        session.flush()
        session.add(PlanningTaskRevision(revision_id="R-RISK", task_id="T-RISK", version_no=1,
            condition_version="C-RISK", resource_revision="RES-RISK", context="planning",
            input_snapshot=frozen_input, created_at=now))
        session.flush()
        session.add(PlanningJob(job_id="J-RISK", request_id="submit-risk", request_digest="seed",
            task_id="T-RISK", revision_id="R-RISK", condition_version="C-RISK", resource_revision="RES-RISK",
            context="planning", parent_plan_id=None, adjustment=None, status="SUCCESS", progress=1,
            stage="完成", created_at=now, updated_at=now))
        session.flush()
        session.add(PlanningPlan(plan_id="P-RISK", request_id="save-risk", request_digest="seed",
            task_id="T-RISK", job_id="J-RISK", revision_id="R-RISK", condition_version="C-RISK",
            resource_revision="RES-RISK", parent_plan_id=None, adjustment=None, version_no=1,
            name="未达标方案", note="", state="REFERENCE", input_snapshot=frozen_input,
            result_snapshot=result, raw_snapshot=raw, outcome_snapshot=outcome, source="SR4", saved_at=now))
    yield factory
    engine.dispose()


def risk_request(**changes):
    return PlanningPlanConfirmRequest.model_validate({"context": "planning", "task_id": "T-RISK",
        "expected_revision": "R-RISK", "request_id": "confirm-risk", **changes})


def test_quality_risk_requires_explicit_confirmation_and_returns_all_failures(quality_plan):
    with pytest.raises(plans.PlanningPlanError) as error:
        plans.confirm_planning_plan("P-RISK", risk_request(), quality_plan)
    assert error.value.code == 3001
    assert len(error.value.data["checks"]) == 4
    assert len(error.value.data["gap"]) == 2
    assert error.value.data["requires_quality_risk_confirmation"] is True
    with quality_plan() as session:
        assert session.get(PlanningPlan, "P-RISK").state == "REFERENCE"
        assert session.get(PlanningCurrentPlan, "T-RISK") is None
        assert session.get(PlanningPlanConfirmation, "confirm-risk") is None


@pytest.mark.parametrize("outcome_code", [3001, 3002])
def test_explicit_quality_confirmation_preserves_results_and_replays(quality_plan, outcome_code):
    with quality_plan.begin() as session:
        row = session.get(PlanningPlan, "P-RISK")
        row.outcome_snapshot = {**row.outcome_snapshot, "code": outcome_code}
        original = deepcopy((row.result_snapshot, row.raw_snapshot, row.outcome_snapshot, row.input_snapshot))
    request = risk_request(accept_quality_risk=True)
    confirmed = plans.confirm_planning_plan("P-RISK", request, quality_plan)
    assert confirmed["state"] == "CONFIRMED" and confirmed["current"]
    assert confirmed["quality_risk_confirmation"]["accepted"] is True
    assert confirmed["quality_risk_confirmation"]["request_id"] == request.request_id
    assert confirmed["quality_risk_confirmation"]["outcome_code"] == outcome_code
    assert plans.confirm_planning_plan("P-RISK", request, quality_plan) == confirmed
    assert plans.get_planning_plan("P-RISK", "T-RISK", quality_plan) == confirmed
    assert plans.list_planning_plans("T-RISK", 1, 10, factory=quality_plan)["items"] == [confirmed]
    with quality_plan() as session:
        row = session.get(PlanningPlan, "P-RISK")
        assert (row.result_snapshot, row.raw_snapshot, row.outcome_snapshot, row.input_snapshot) == original
        events = session.scalars(select(SystemAuditEvent)).all()
        assert len(events) == 1 and events[0].action == "plan.confirm.quality-risk"
        assert events[0].changes["result_hash"] == plans._quality_result_hash(row)
    with pytest.raises(plans.PlanningPlanError) as conflict:
        plans.confirm_planning_plan("P-RISK", risk_request(), quality_plan)
    assert conflict.value.code == 1204


@pytest.mark.parametrize("value", ["true", "false", 1, 0, None])
def test_quality_acceptance_does_not_coerce_client_values(value):
    with pytest.raises(ValidationError):
        risk_request(accept_quality_risk=value)


@pytest.mark.parametrize("changed,expected", [
    ("resource", 1205), ("revision", 1203), ("task", 2001), ("job", 1203),
    ("raw", 1203), ("snapshot", 1203), ("parent", 1203), ("unknown", 1203),
    ("metric", 1203), ("origin", 1203), ("broken_checks", 1203),
])
def test_quality_acceptance_cannot_bypass_non_quality_guards(quality_plan, changed, expected):
    with quality_plan.begin() as session:
        row = session.get(PlanningPlan, "P-RISK")
        if changed == "resource": row.resource_revision = "OLD"
        elif changed == "job": session.get(PlanningJob, "J-RISK").status = "RUNNING"
        elif changed == "raw": row.raw_snapshot = None
        elif changed == "snapshot": row.result_snapshot = {**row.result_snapshot, "snapshot_id": "OTHER"}
        elif changed == "parent":
            row.parent_plan_id = "MISSING"
            session.get(PlanningJob, "J-RISK").parent_plan_id = "MISSING"
        elif changed == "unknown":
            checks = deepcopy(row.result_snapshot["checks"]); checks[0]["passed"] = None
            row.result_snapshot = {**row.result_snapshot, "checks": checks}
        elif changed == "metric": row.result_snapshot = {**row.result_snapshot, "metrics": {}}
        elif changed == "origin": row.source = "UNTRUSTED"
        elif changed == "broken_checks": row.result_snapshot = {**row.result_snapshot, "checks": [None]}
    request = risk_request(accept_quality_risk=True, **({"expected_revision": "OLD"} if changed == "revision"
        else {"task_id": "OTHER"} if changed == "task" else {}))
    with pytest.raises(plans.PlanningPlanError) as error:
        plans.confirm_planning_plan("P-RISK", request, quality_plan)
    assert error.value.code == expected
    with quality_plan() as session:
        assert session.get(PlanningPlan, "P-RISK").state == "REFERENCE"
        assert session.get(PlanningCurrentPlan, "T-RISK") is None
        assert session.get(PlanningPlanConfirmation, request.request_id) is None


def test_legacy_confirmation_digest_and_receipt_remain_compatible(quality_plan):
    body = {"context": "planning", "task_id": "T-RISK", "expected_revision": "R-RISK",
            "request_id": "legacy-confirm", "plan_id": "P-RISK"}
    legacy_digest = hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True,
        separators=(",", ":")).encode("utf-8")).hexdigest()
    request = risk_request(request_id="legacy-confirm")
    assert plans._confirmation_digest("P-RISK", request) == legacy_digest
    assert plans._confirmation_digest("P-RISK", risk_request(request_id="legacy-confirm", accept_quality_risk=False)) == legacy_digest
    with quality_plan.begin() as session:
        row = session.get(PlanningPlan, "P-RISK")
        row.state = "CONFIRMED"; row.confirmed_at = datetime.now(timezone.utc)
        row.outcome_snapshot = {"code": 0}
        row.result_snapshot = {**row.result_snapshot, "checks": [{**c, "passed": True} for c in row.result_snapshot["checks"]]}
        session.add(PlanningCurrentPlan(task_id="T-RISK", plan_id="P-RISK", updated_at=row.confirmed_at))
        session.add(PlanningPlanConfirmation(request_id=request.request_id, request_digest=legacy_digest,
            plan_id="P-RISK", task_id="T-RISK", revision_id="R-RISK", created_at=row.confirmed_at))
    assert plans.confirm_planning_plan("P-RISK", request, quality_plan)["current"] is True


def test_risk_confirmed_plan_remains_available_to_formal_diagnosis(quality_plan, monkeypatch):
    from app import fault_plan_source
    monkeypatch.setattr(fault_plan_source, "get_session_factory", lambda: quality_plan)
    plans.confirm_planning_plan("P-RISK", risk_request(accept_quality_risk=True), quality_plan)
    source = fault_plan_source.load_plan_source("T-RISK", "P-RISK")
    assert source["meta"]["state"] == "CONFIRMED"
    assert source["solution"]["summary"]["check_passed"] is False
    assert source["network"]["nodes"][0]["node_id"] == "N1"


def test_risk_audit_failure_rolls_back_pointer_and_confirmation(quality_plan, monkeypatch):
    from app import system_audit_service
    from app.system_management_schemas import SystemManagementError
    from sqlalchemy.exc import SQLAlchemyError
    def fail(*args, **kwargs):
        raise SQLAlchemyError("构造审计失败")
    monkeypatch.setattr(system_audit_service, "append_system_audit", fail)
    with pytest.raises(SystemManagementError) as error:
        plans.confirm_planning_plan("P-RISK", risk_request(accept_quality_risk=True), quality_plan)
    assert error.value.code == 5002
    with quality_plan() as session:
        assert session.get(PlanningPlan, "P-RISK").state == "REFERENCE"
        assert session.get(PlanningCurrentPlan, "T-RISK") is None
        assert session.get(PlanningPlanConfirmation, "confirm-risk") is None


def test_custom_interference_sources_override_presets():
    rows = planning._interference_rows({
        "interference_ids": ["IF-0001"],
        "interference_sources": [{
            "interference_id": "IF-USER-0001",
            "name": "地图标绘源",
            "lon": 114.2,
            "lat": 37.1,
            "center_freq_khz": 465906.2,
            "bandwidth_khz": 25,
            "tx_power_dbm": 50,
            "active": True,
        }],
    })
    assert len(rows) == 1
    assert rows[0]["interference_id"] == "IF-USER-0001"
    assert rows[0]["active"] == "true"
    assert rows[0]["pattern_type"] == "OMNI"
    assert rows[0]["duty_cycle"] == 1.0


def test_custom_interference_source_validation():
    try:
        planning._interference_rows({"interference_sources": [{
            "lon": 114.2, "lat": 37.1, "center_freq_khz": 0, "tx_power_dbm": 50,
        }]})
    except ValueError as exc:
        assert "中心频率" in str(exc)
    else:
        raise AssertionError("zero center frequency should be rejected")


def test_route_rebuild_updates_current_route_state():
    routes = [{
        "demand_id": "CD-0001", "strategy": "MAX_RELIABILITY", "reachable": True,
        "primary": {"node_path": ["A", "B"]}, "backup": None,
        "backup_type": "NONE", "single_point_risks": [],
    }, {
        "demand_id": "CD-0002", "strategy": "MAX_RELIABILITY", "reachable": True,
        "primary": {"node_path": ["C", "D"]}, "backup": None,
        "backup_type": "NONE", "single_point_risks": [],
    }]
    rebuilt = {
        "demand_id": "CD-0001", "strategy": "MAX_RELIABILITY", "reachable": True,
        "primary": {"node_path": ["A", "E", "B"]},
        "backup": {"node_path": ["A", "F", "B"]},
        "backup_type": "NODE_DISJOINT", "single_point_risks": [],
    }
    state = planning._apply_route_changes(
        routes, {"rerouted": [rebuilt], "still_unreachable": ["CD-0002"]})
    assert state["routes"][0]["primary"]["node_path"] == ["A", "E", "B"]
    assert state["routes"][1]["reachable"] is False
    assert state["summary"] == {
        "total": 2, "reachable": 1, "unreachable": 1,
        "with_backup": 1, "node_disjoint": 1,
    }


def test_route_measure_rebuilds_primary_and_backup_around_interference():
    import interference
    import routing

    graph = routing.RouteGraph()
    for lid, a, b in (("L-BAD", "A", "B"), ("L-AC", "A", "C"),
                      ("L-CB", "C", "B"), ("L-AD", "A", "D"), ("L-DB", "D", "B")):
        graph.add_link(lid, a, b, "VUHF", 20, 1000, 8)
    graph.seal_band_switches()
    routes = {"routes": [{
        "demand_id": "CD-1", "strategy": "MAX_RELIABILITY", "reachable": True,
        "primary": {"node_path": ["A", "B"], "link_path": ["L-BAD"]},
        "backup": None, "backup_type": "NONE", "single_point_risks": [],
    }]}
    measure, reasons = interference._route_measure(
        None, SimpleNamespace(link_id="L-BAD"), (graph, routes), {"L-BAD"})
    rebuilt = measure["detail"]["rerouted"][0]
    assert reasons == []
    assert "L-BAD" not in rebuilt["primary"]["link_path"]
    assert rebuilt["backup"] is not None
    assert rebuilt["backup_type"] == "NODE_DISJOINT"


def test_confirm_requires_successful_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(planning, "PLAN_DIR", tmp_path)
    ids = []
    try:
        with TestClient(app) as client:
            for kind, summary, expected in (
                ("SR4_FLOW", {"check_passed": False}, 3001),
                ("SR4_FLOW", {}, 3001),
                ("NETWORK_OPTIMIZE", {"feasible": False}, 3001),
                ("SR4_FLOW", {"check_passed": True}, 0),
                ("NETWORK_OPTIMIZE", {"feasible": True}, 0),
            ):
                pid = _save_plan(kind, summary, {})
                ids.append(pid)
                response = client.post(f"/api/v1/plans/{pid}/confirm").json()
                assert response["code"] == expected
                assert _PLANS[pid]["confirmed"] is (expected == 0)
                if expected:
                    assert "confirmed_at" not in _PLANS[pid]
                else:
                    timestamp = _PLANS[pid]["confirmed_at"]
                    assert client.post(f"/api/v1/plans/{pid}/confirm").json()["code"] == 0
                    assert _PLANS[pid]["confirmed_at"] == timestamp
                    _PLANS.pop(pid)
                    restored = client.get(f"/api/v1/plans/{pid}").json()["data"]
                    assert restored["confirmed"] is True
                    assert restored["confirmed_at"] == timestamp
    finally:
        for pid in ids:
            _PLANS.pop(pid, None)


def test_completed_task_survives_memory_reset(tmp_path, monkeypatch):
    monkeypatch.setattr(planning_w3, "TASK_DIR", tmp_path)
    tid = "tsk-012345abcdef"
    planning_w3._set(tid, task_id=tid, kind="SR4_FLOW", status="SUCCESS",
                     result={"solution_id": "PL-TEST"})
    planning_w3._TASKS.pop(tid)
    result = planning_w3.query_task(tid)
    assert result["code"] == 0
    assert result["data"]["solution_id"] == "PL-TEST"
    planning_w3._TASKS.pop(tid, None)


def test_coverage_cache_and_task_survive_memory_reset(tmp_path, monkeypatch):
    monkeypatch.setattr(coverage, "COVERAGE_DIR", tmp_path / "cache")
    monkeypatch.setattr(coverage, "COVERAGE_TASK_DIR", tmp_path / "tasks")
    key = coverage._key(["ND-0001"], "HF", {})
    entry = {"result": {"band": "HF", "station_count": 1}, "at": 123.0}
    write_json(coverage.COVERAGE_DIR / (key + ".json"), entry)
    coverage._CACHE.pop(key, None)
    assert coverage.read_cache(key)["data"]["result"]["station_count"] == 1
    tid = "CT-012345abcdef"
    coverage._set(tid, task_id=tid, status="SUCCESS", result=entry["result"])
    coverage._TASKS.pop(tid)
    assert coverage.query_coverage(tid)["data"]["result"] == entry["result"]
    coverage._CACHE.pop(key, None)
    coverage._TASKS.pop(tid, None)


def test_plan_xlsx_export(tmp_path, monkeypatch):
    monkeypatch.setattr(planning, "PLAN_DIR", tmp_path)
    pid = _save_plan("SR4_FLOW", {"check_passed": True},
                     {"links": [{"link_id": "LK-0001"}]})
    try:
        with TestClient(app) as client:
            response = client.get(f"/api/v1/plans/{pid}/export", params={"format": "xlsx"})
        assert response.status_code == 200
        assert response.content.startswith(b"PK")
        book = load_workbook(io.BytesIO(response.content), read_only=True)
        assert ["check_passed", True] in [list(row) for row in book["Summary"].values]
        assert ["detail.links[0].link_id", "LK-0001"] in [list(row) for row in book["Details"].values]
        book.close()
    finally:
        _PLANS.pop(pid, None)


def test_invalid_planning_enums_fail_before_task_creation():
    cases = [
        ("/api/v1/plan/route", {"strategy": "UNKNOWN"}),
        ("/api/v1/plan/route", {"demands": [{"demand_id": "CD-0001", "strategy": "UNKNOWN"}]}),
        ("/api/v1/plan/frequency", {"granularity": "UNKNOWN"}),
        ("/api/v1/plan/radio-params", {"presets": ["UNKNOWN"]}),
        ("/api/v1/plan/sr4-flow", {"preset": "UNKNOWN"}),
        ("/api/v1/plan/sr4-flow", {"strategy": "UNKNOWN"}),
    ]
    with TestClient(app) as client:
        for path, payload in cases:
            response = client.post(path, json=payload).json()
            assert response["code"] == 1003
            assert response["data"] is None
        unsupported = client.post("/api/v1/plan/route", json={
            "callback_url": "https://example.invalid/callback"}).json()
        assert unsupported["code"] == 1001
        assert "callback_url" in unsupported["message"]
