"""父方案调整的冻结来源及结构校验。"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import planning_adjustment_service  # noqa: E402
from app.planning_job_schemas import PlanningAdjustmentInput  # noqa: E402


def _source():
    snapshot = {
        "solution_id": "PL-12345678", "terrain_fingerprint": "terrain-v1",
        "summary": {},
        "detail": {
            "nodes": [{"node_id": node_id} for node_id in ("N1", "N2", "N3")],
            "devices": [{"device_id": "E1", "node_id": "N1"},
                        {"device_id": "E2", "node_id": "N2"},
                        {"device_id": "E3", "node_id": "N3"}],
            "links": [{"node_a_id": "N1", "node_b_id": "N2",
                       "device_a_id": "E1", "device_b_id": "E2"},
                      {"node_a_id": "N2", "node_b_id": "N3",
                       "device_a_id": "E2", "device_b_id": "E3"}],
        },
    }
    plan = SimpleNamespace(
        plan_id="P1", task_id="T1", condition_version="C1",
        resource_revision="R1", input_snapshot={
            "name": "父方案", "stationIds": ["N1", "N3"],
            "demands": [{"id": "D1", "sourceId": "N1", "targetId": "N3"}],
        },
        result_snapshot={
            "snapshot_id": "SNP-PL-12345678",
            "devices": [{"id": "E1", "stationId": "N1", "deviceClass": "HF"}],
        },
        raw_snapshot=snapshot,
    )
    revision = SimpleNamespace(
        task_id="T1", condition_version="C1", resource_revision="R1",
        input_snapshot={**plan.input_snapshot, "name": "更新名称"},
    )
    adjustment = PlanningAdjustmentInput.model_validate({
        "schema_version": 1, "source_plan_id": "P1",
        "source_snapshot_id": "SNP-PL-12345678",
        "manual_override": [{"device_id": "E1", "tx_power_dbm": 0,
                             "antenna_height_m": 0}],
        "manual_paths": [{"demand_id": "D1", "node_path": ["N1", "N2", "N3"]}],
    })
    return plan, revision, adjustment


def test_parent_validation_keeps_zero_and_fixed_topology(monkeypatch):
    plan, revision, adjustment = _source()
    monkeypatch.setattr(planning_adjustment_service, "terrain_fingerprint",
                        lambda: "terrain-v1")
    snapshot, refs = planning_adjustment_service.prepare_parent(plan, revision, adjustment)
    assert snapshot is plan.raw_snapshot
    assert refs == [{"device_id": "E1", "node_id": "N1", "band": "HF"}]
    assert adjustment.manual_override[0].tx_power_dbm == 0


@pytest.mark.parametrize("kind,code", [
    ("source", 1203), ("resource", 1205), ("terrain", 1205),
    ("topology", 1203), ("binding", 1203), ("path", 1001), ("device", 1001),
])
def test_parent_validation_rejects_changed_or_unknown_sources(monkeypatch, kind, code):
    plan, revision, adjustment = _source()
    monkeypatch.setattr(planning_adjustment_service, "terrain_fingerprint",
                        lambda: "terrain-v1")
    if kind == "source":
        plan.result_snapshot["snapshot_id"] = "SNP-other"
    elif kind == "resource":
        plan.resource_revision = "R2"
    elif kind == "terrain":
        plan.raw_snapshot["terrain_fingerprint"] = "terrain-old"
    elif kind == "topology":
        plan.raw_snapshot["detail"]["devices"] = []
        monkeypatch.setattr(planning_adjustment_service, "capture_raw_snapshot",
                            lambda _: None)
    elif kind == "binding":
        plan.raw_snapshot["detail"]["links"][0]["device_a_id"] = ""
        monkeypatch.setattr(planning_adjustment_service, "capture_raw_snapshot",
                            lambda _: None)
    elif kind == "path":
        plan.raw_snapshot["detail"]["links"].pop()
    else:
        plan.result_snapshot["devices"] = []
    with pytest.raises(planning_adjustment_service.AdjustmentError) as error:
        planning_adjustment_service.prepare_parent(plan, revision, adjustment)
    assert error.value.code == code


def test_adjustment_shape_rejects_duplicates_and_empty_override():
    _, _, adjustment = _source()
    body = adjustment.model_dump(mode="json")
    body["manual_override"] = [{"device_id": "E1"}]
    with pytest.raises(ValidationError):
        PlanningAdjustmentInput.model_validate(body)
    body["manual_override"] = [
        {"device_id": "E1", "tx_power_dbm": 0},
        {"device_id": "E1", "tx_power_dbm": 10},
    ]
    with pytest.raises(ValidationError):
        PlanningAdjustmentInput.model_validate(body)


def test_adjusted_result_must_echo_exact_device_and_route_values():
    _, _, adjustment = _source()
    result = {"configuration": {
        "devices": [{"deviceId": "E1", "txPowerDbm": 0,
                     "antennaHeightM": 0}],
        "routes": [{"demandId": "D1", "nodeIds": ["N1", "N2", "N3"],
                    "backup": False}],
    }}
    data = adjustment.model_dump(mode="json")
    planning_adjustment_service.verify_adjusted_result(data, result)
    result["configuration"]["devices"][0]["txPowerDbm"] = 1
    with pytest.raises(ValueError, match="E1"):
        planning_adjustment_service.verify_adjusted_result(data, result)


def test_fixed_parent_recalculates_with_real_topology(monkeypatch):
    from app.planning_result_adapter import adapt_planning_result
    from scripts.planning import sr4_flow

    base = sr4_flow.run(task_id="TS-0001", pop_size=6, generations=2,
                        verbose=False)
    parent = {"detail": {key: base[key] for key in
                         ("nodes", "devices", "links", "optimization")}}
    device = base["devices"][0]
    models = {row["model_id"]: row for row in sr4_flow.load("device_model.csv")}
    band = models[device["model_id"]]["device_class"]
    refs = [{"device_id": device["device_id"], "node_id": device["node_id"],
             "band": band}]
    demand_rows = [row for row in sr4_flow.load("comm_demand.csv")
                   if row["task_id"] == "TS-0001"]
    assert all(row["device_a_id"] and row["device_b_id"] for row in base["links"])
    frontend_result, _ = adapt_planning_result(
        {"solution_id": "PL-TEST0002",
         "summary": {"objectives": base["optimization"]["best"]["objectives"]},
         "detail": {key: base[key] for key in
                    ("nodes", "devices", "links", "optimization", "routes",
                     "frequency", "params", "check")}},
        {"demands": [{"id": row["demand_id"]} for row in demand_rows]},
    )
    assert len(frontend_result["devices"]) == len(base["devices"])
    assert len(frontend_result["configuration"]["devices"]) == len(base["devices"])
    route = next(row for row in base["routes"]["routes"] if row["reachable"])
    path = route["primary"]["node_path"]
    adjustment = {"manual_override": [{"device_id": device["device_id"],
                                       "tx_power_dbm": float(device["tx_power_dbm"])}],
                  "manual_paths": [{"demand_id": route["demand_id"],
                                    "node_path": path}]}

    def no_deployment(*_args, **_kwargs):
        raise AssertionError("人工调整不能重新部署台站")

    monkeypatch.setattr(sr4_flow, "topology_from_deployment", no_deployment)
    child = sr4_flow.run_from_parent(parent, adjustment, refs, "TS-0001", demand_rows)
    assert child["nodes"] == base["nodes"]
    assert child["devices"] == base["devices"]
    assert [row["link_id"] for row in child["links"]] == [
        row["link_id"] for row in base["links"]
    ]
    assert [(row["device_a_id"], row["device_b_id"]) for row in child["links"]] == [
        (row["device_a_id"], row["device_b_id"]) for row in base["links"]
    ]
    chosen = next(row for row in child["routes"]["routes"]
                  if row["demand_id"] == route["demand_id"])
    assert chosen["primary"]["node_path"] == path
    assert child["frequency"]["assignments"]
    assert child["interference"]["analysis"]
    assert next(row for row in child["params"]["params"]
                if row["device_id"] == device["device_id"])["tx_power_dbm"] == float(
                    device["tx_power_dbm"])
