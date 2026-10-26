"""The SR4 integration must bind each run to the saved source snapshot."""
import importlib
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "planning"))
integration = importlib.import_module("app.sr4_integration")


def test_snapshot_versions_and_run_binding(tmp_path, monkeypatch):
    monkeypatch.setattr(integration, "SNAPSHOT_DIR", tmp_path)
    seen = []
    monkeypatch.setattr(integration, "submit_sr4", lambda payload: seen.append(payload) or {
        "code": 0, "message": "success", "data": {"task_id": "tsk-test"}})
    task_id = integration.catalog()["data"]["tasks"][0]["task_id"]
    rows = integration.catalog()["data"]["interference_sources"]
    demands = [row for row in integration.catalog()["data"]["task_demands"]
               if row["task_id"] == task_id]
    first = integration.save_snapshot(task_id, {"expected_snapshot_id": None,
                                                 "interference_sources": rows,
                                                 "task_demands": demands})
    assert first["code"] == 0
    first_id = first["data"]["snapshot_id"]
    assert integration.submit_snapshot({"task_id": task_id, "snapshot_id": first_id})["code"] == 0
    assert seen[-1]["interference_rows"] == rows
    assert seen[-1]["demand_rows"] == demands
    assert seen[-1]["task_id"] == task_id

    changed = [dict(row) for row in rows]
    changed[0]["lon"] = "114.2"
    changed_demands = [dict(row) for row in demands]
    changed_demands[0]["is_mandatory"] = "true"
    second = integration.save_snapshot(task_id, {"expected_snapshot_id": first_id,
                                                  "interference_sources": changed,
                                                  "task_demands": changed_demands})
    assert second["code"] == 0
    assert second["data"]["snapshot_id"] != first_id
    assert integration.submit_snapshot({"task_id": task_id, "snapshot_id": first_id})["code"] == 3003
    assert integration.submit_snapshot({"task_id": task_id,
                                        "snapshot_id": second["data"]["snapshot_id"]})["code"] == 0
    assert seen[-1]["interference_rows"][0]["lon"] == "114.2"
    assert seen[-1]["demand_rows"][0]["is_mandatory"] == "true"
    assert integration.save_snapshot(task_id, {"expected_snapshot_id": first_id,
                                                "interference_sources": rows,
                                                "task_demands": demands})["code"] == 3003


def test_snapshot_rejects_invalid_coordinates(tmp_path, monkeypatch):
    monkeypatch.setattr(integration, "SNAPSHOT_DIR", tmp_path)
    task_id = integration.catalog()["data"]["tasks"][0]["task_id"]
    rows = integration.catalog()["data"]["interference_sources"]
    demands = [row for row in integration.catalog()["data"]["task_demands"]
               if row["task_id"] == task_id]
    rows[0]["lon"] = "nan"
    assert integration.save_snapshot(task_id, {"expected_snapshot_id": None,
                                                "interference_sources": rows,
                                                "task_demands": demands})["code"] == 1001
    assert not list(tmp_path.iterdir())
