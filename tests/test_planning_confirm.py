import sys
import io
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from openpyxl import load_workbook

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
