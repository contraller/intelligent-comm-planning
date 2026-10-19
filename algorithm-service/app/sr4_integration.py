"""Versioned demo inputs for the SR4 algorithm, scoped to task and interference rows."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from .runtime_store import read_json, write_json
from .planning_w4 import submit_sr4

_LOCK = threading.Lock()
SNAPSHOT_DIR = Path(os.environ.get(
    "SR4_SNAPSHOT_DIR", Path(__file__).resolve().parents[2] / "data" / "runtime" / "sr4_snapshots"))
DATA_FILES = ("node.csv", "device.csv", "device_model.csv", "antenna_model.csv",
              "task_scenario.csv", "comm_demand.csv", "frequency_resource.csv",
              "interference_source.csv", "link_metric.csv", "candidate_site.csv")


def _load(name: str) -> list[dict[str, str]]:
    import csv
    from datapaths import path
    with open(path(name), encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _dataset_revision() -> str:
    from datapaths import path
    from terrain import DEM_HEADER, LC_HEADER
    digest = hashlib.sha256()
    for name in DATA_FILES:
        digest.update(name.encode())
        digest.update(Path(path(name)).read_bytes())
    for name in (DEM_HEADER, LC_HEADER):
        digest.update(Path(name).read_bytes())
    return digest.hexdigest()[:16]


def _terrain_source_sha256() -> str:
    from terrain import DEM_HEADER
    return json.loads(Path(DEM_HEADER).read_text(encoding="utf-8"))["source_sha256"]


def _task(task_id: str) -> dict[str, str] | None:
    if not re.fullmatch(r"TS-\d{4}", task_id):
        return None
    return next((row for row in _load("task_scenario.csv") if row["task_id"] == task_id), None)


def _path(task_id: str) -> Path:
    return SNAPSHOT_DIR / (task_id + ".json")


def catalog() -> dict[str, Any]:
    return {"code": 0, "message": "success", "data": {
        "tasks": _load("task_scenario.csv"),
        "task_demands": _load("comm_demand.csv"),
        "interference_sources": _load("interference_source.csv"),
        "dataset_revision": _dataset_revision(),
        "terrain_source_sha256": _terrain_source_sha256(),
    }}


def get_snapshot(task_id: str) -> dict[str, Any]:
    if not _task(task_id):
        return _error(1001, "Unknown task")
    path = _path(task_id)
    with _LOCK:
        row = read_json(path) if path.exists() else None
    return {"code": 0, "message": "success", "data": row}


def _error(code: int, message: str) -> dict[str, Any]:
    return {"code": code, "message": message, "data": None}


def _validate_sources(rows: Any) -> list[dict[str, Any]] | None:
    if not isinstance(rows, list) or len(rows) > 100:
        return None
    result = []
    ids = set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        rid = row.get("interference_id")
        if not isinstance(rid, str) or not re.fullmatch(r"IF-[A-Za-z0-9-]{1,32}", rid) or rid in ids:
            return None
        ids.add(rid)
        try:
            numbers = {key: float(row[key]) for key in ("lon", "lat", "center_freq_khz",
                "bandwidth_khz", "tx_power_dbm", "antenna_height_m", "antenna_gain_dbi",
                "azimuth_deg", "duty_cycle")}
        except (KeyError, TypeError, ValueError):
            return None
        if not all(math.isfinite(value) for value in numbers.values()):
            return None
        if not (105 <= numbers["lon"] <= 120 and 28 <= numbers["lat"] <= 42
                and 1000 <= numbers["center_freq_khz"] <= 600000
                and 0 < numbers["bandwidth_khz"] <= 100000
                and -100 <= numbers["tx_power_dbm"] <= 100
                and 0 <= numbers["antenna_height_m"] <= 1000
                and 0 < numbers["duty_cycle"] <= 1):
            return None
        if row.get("active") not in ("true", "false", True, False):
            return None
        clean = dict(row)
        clean["active"] = str(row["active"]).lower()
        result.append(clean)
    return result


def _validate_demands(task_id: str, rows: Any) -> list[dict[str, Any]] | None:
    originals = {row["demand_id"]: row for row in _load("comm_demand.csv")
                 if row["task_id"] == task_id}
    if not isinstance(rows, list) or len(rows) != len(originals):
        return None
    result = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        demand_id = row.get("demand_id")
        base = originals.get(demand_id)
        if base is None or demand_id in seen:
            return None
        seen.add(demand_id)
        for key in ("task_id", "src_node_id", "dst_node_id"):
            if row.get(key) != base[key]:
                return None
        if row.get("priority") not in ("P1", "P2", "P3") or row.get("is_mandatory") not in ("true", "false", True, False):
            return None
        try:
            rate = float(row["required_rate_kbps"])
            reliability = float(row["min_reliability"])
        except (KeyError, TypeError, ValueError):
            return None
        if not (math.isfinite(rate) and 0 < rate <= 1000000 and math.isfinite(reliability)
                and 0 < reliability <= 1):
            return None
        clean = dict(base)
        for key in ("priority", "required_rate_kbps", "min_reliability"):
            clean[key] = row[key]
        clean["is_mandatory"] = str(row["is_mandatory"]).lower()
        result.append(clean)
    return result


def save_snapshot(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    task = _task(task_id)
    if task is None:
        return _error(1001, "Unknown task")
    rows = _validate_sources(payload.get("interference_sources"))
    if rows is None:
        return _error(1001, "Invalid interference source rows")
    demands = _validate_demands(task_id, payload.get("task_demands"))
    if demands is None:
        return _error(1001, "Invalid task demand rows")
    expected = payload.get("expected_snapshot_id")
    if expected is not None and not isinstance(expected, str):
        return _error(1001, "Invalid expected snapshot")
    with _LOCK:
        path = _path(task_id)
        current = read_json(path) if path.exists() else None
        if expected != (current["snapshot_id"] if current else None):
            return _error(3003, "Snapshot changed; reload before saving")
        snapshot = {
            "snapshot_id": "SR4-" + uuid.uuid4().hex[:12],
            "task_id": task_id,
            "task": task,
            "dataset_revision": _dataset_revision(),
            "interference_sources": rows,
            "task_demands": demands,
        }
        write_json(path, snapshot)
    return {"code": 0, "message": "success", "data": snapshot}


def submit_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    task_id = payload.get("task_id")
    snapshot_id = payload.get("snapshot_id")
    if not isinstance(task_id, str) or not _task(task_id):
        return _error(1001, "Unknown task")
    with _LOCK:
        path = _path(task_id)
        snapshot = read_json(path) if path.exists() else None
    if snapshot is None or snapshot["snapshot_id"] != snapshot_id:
        return _error(3003, "Snapshot changed; save or reload before running")
    if "task_demands" not in snapshot:
        return _error(3003, "Snapshot predates task versioning; save it again")
    if snapshot["dataset_revision"] != _dataset_revision():
        return _error(3003, "Source dataset changed; save a new snapshot")
    return submit_sr4({
        "task_id": task_id,
        "snapshot_id": snapshot_id,
        "interference_rows": snapshot["interference_sources"],
        "demand_rows": snapshot["task_demands"],
        "preset": payload.get("preset", "TERRAIN"),
        "strategy": payload.get("strategy", "MAX_RELIABILITY"),
    })
