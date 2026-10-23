"""完整资源编辑 API：隔离 SQLite，校验 canonical、增量、权限与历史。"""
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import sys
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, integration_identity_service as identity
from app import resource_dataset_service as datasets
from app.database import Base
from app.main import app
from app.integration_identity_models import IntegrationSession
from app.planning_plan_models import PlanningPlan
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetOperation, ResourceDatasetVersion
from app.resource_import_parser import BOUNDS

CONTEXT = "/api/v1/resource/edit-context"
SAVE = "/api/v1/resource/workspace/changes"


@pytest.fixture
def workspace_api(monkeypatch, request):
    directory = ROOT / "data/runtime/tmp" / ("workspace-api-" + uuid4().hex)
    directory.mkdir(parents=True, exist_ok=False)
    path = directory / "workspace.sqlite"
    request.node.user_properties.append(("database", str(path)))
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False, "timeout": 30})
    Base.metadata.create_all(engine, tables=[model.__table__ for model in (
        ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation, IntegrationSession, PlanningPlan)])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    for name, module in tuple(sys.modules.items()):
        if name.startswith("app.") and hasattr(module, "get_session_factory"):
            monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setattr(database, "get_engine", lambda: engine)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(path))
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    try:
        baseline = datasets.initialize()
        with TestClient(app) as client:
            yield client, factory, baseline, path
    finally:
        engine.dispose()


def headers(client):
    response = client.get("/api/v1/auth/csrf")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    return {"X-Session-Id": data["session_id"], "X-CSRF-Token": data["csrf_token"]}


def switch(client, account="integration-editor"):
    response = client.post("/api/v1/auth/integration/switch", headers=headers(client), json={"accountId": account})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def counts(factory):
    with factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model))
                     for model in (ResourceDatasetVersion, ResourceDatasetOperation))


def context(client, baseline=None, context="ledger"):
    params = {"context": context}
    if baseline is not None:
        params["revision"] = baseline["revision"]
    response = client.get(CONTEXT, params=params)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def body(baseline, changes=None, request_id="workspace-save", context="ledger"):
    if changes is None:
        changes = {"devices": [{"id": baseline["tables"]["device.csv"][0]["device_id"], "antennaHeightM": 17.125}]}
    return {"context": context, "base_revision": baseline["revision"], "request_id": request_id, "changes": changes}


def save(client, payload):
    return client.post(SAVE, headers=headers(client), json=payload)


def assert_unchanged(factory, baseline, expected=(1, 0)):
    assert counts(factory) == expected
    assert datasets.current()["revision"] == baseline["revision"]
    assert datasets.current()["tables"] == baseline["tables"]


def assert_resource_context_stats(client, snapshot):
    response = client.get("/api/v1/resource/context")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["revision"] == snapshot["revision"]
    stats = data["stats"]
    tables = snapshot["tables"]
    nodes = {row["node_id"]: row for row in tables["node.csv"]}
    models = {row["model_id"]: row for row in tables["device_model.csv"]}
    groups = Counter((models[row["model_id"]]["device_class"], nodes[row["node_id"]].get("mobility"))
                     for row in tables["device.csv"])
    assert set(stats["deployments"]) == {"HF", "VUHF"}
    for kind, total_field in (("HF", "hf"), ("VUHF", "vuhf")):
        actual = stats["deployments"][kind]
        expected = {mode: sum(count for (device_class, mobility), count in groups.items()
                              if device_class == kind and (mobility if mobility in {"FIXED", "VEHICLE", "MANPACK"} else "UNKNOWN") == mode)
                    for mode in ("FIXED", "VEHICLE", "MANPACK", "UNKNOWN")}
        assert actual == expected
        assert all(type(value) is int and value >= 0 for value in actual.values())
        assert sum(actual.values()) == stats[total_field] == sum(expected.values())
    assert stats["hf"] + stats["vuhf"] == stats["devices"] == len(tables["device.csv"])
    assert stats["unknown_alerts"] == sum(row.get("status") not in {"NORMAL", "FAULT", "OFFLINE"}
                                          for row in tables["device.csv"])
    return stats


def seed(baseline, mutate):
    def apply(snapshot):
        mutate(snapshot["tables"])
        return True, {"object_id": "isolated-fixture", "affected_ids": [], "warnings": []}

    datasets.commit_device_change(baseline["revision"], "fixture-" + uuid4().hex,
                                 datasets.content_hash({"fixture": uuid4().hex}), "test-fixture", apply)
    return datasets.current()


def new_node(identifier="MANUAL-NODE"):
    return {"id": identifier, "name": "手工节点", "echelon": "II", "subtype": "II_FIXED",
            "role": "FIXED_STATION", "parentIds": [], "mobility": "FIXED", "classes": ["HF", "VUHF"],
            "coordinate": [(BOUNDS[0] + BOUNDS[2]) / 2, (BOUNDS[1] + BOUNDS[3]) / 2],
            "elevationM": None, "region": "联调区域", "remark": "", "relayCapable": True,
            "key": False, "status": None, "alert": None, "origin": "MANUAL"}


def new_device(baseline, station_id=None, identifier="MANUAL-DEVICE"):
    existing = baseline["tables"]["device.csv"][0]
    model = next(row for row in baseline["tables"]["device_model.csv"] if row["model_id"] == existing["model_id"])
    return {"id": identifier, "stationId": station_id or existing["node_id"], "modelId": existing["model_id"],
            "antennaId": existing["antenna_id"], "antennaHeightM": 8.5, "txPowerDbm": float(model["tx_power_max_dbm"]) - 1,
            "workFreqKhz": None, "tiltDeg": None, "azimuthDeg": None, "installedAt": "",
            "availability": "ACTIVE", "status": None, "alert": None, "origin": "MANUAL"}


def new_interference(identifier="MANUAL-INTERFERENCE"):
    return {"id": identifier, "name": "手工干扰源", "coordinate": new_node()["coordinate"],
            "elevationM": None, "antennaHeightM": 0, "centerFreqKhz": 1500, "bandwidthKhz": 10,
            "txPowerDbm": -10, "antennaGainDbi": None, "interferenceType": "NOISE", "patternType": None,
            "azimuthDeg": None, "dutyCycle": None, "active": False, "origin": "MANUAL", "status": None, "alert": None}


@pytest.mark.parametrize("view", ["ledger", "gis"])
def test_context_contains_complete_canonical_references_without_writes(workspace_api, view):
    client, factory, baseline, _ = workspace_api
    data = context(client, baseline, view)
    resources = data["resources"]
    assert data["revision"] == data["baseRevision"] == resources["version"] == baseline["revision"]
    assert data["validationSource"] == resources
    assert data["resourceMeta"] == data["meta"]
    assert data["stations"] == resources["stations"] and data["models"] == resources["models"]
    assert data["antennas"] == resources["antennas"]
    assert resources["source"] == datasets.SOURCE
    station_ids = {row["id"] for row in resources["stations"]}
    model_ids = {row["id"] for row in resources["models"]}
    antenna_ids = {row["id"] for row in resources["antennas"]}
    assert len(station_ids) == len(baseline["tables"]["node.csv"])
    assert len(resources["devices"]) == len(baseline["tables"]["device.csv"])
    assert len(resources["interferences"]) == len(baseline["tables"]["interference_source.csv"])
    for device in resources["devices"]:
        assert device["stationId"] in station_ids and device["modelId"] in model_ids and device["antennaId"] in antenna_ids
        assert "station_id" not in device and "model_id" not in device
    assert all(parent in station_ids for row in resources["stations"] for parent in row["parentIds"])
    assert data["situation"]["links"] == data["situation"]["candidateLinks"] == []
    assert data["impact"]["linkIds"] == []
    assert_resource_context_stats(client, baseline)
    assert_unchanged(factory, baseline)


@pytest.mark.parametrize("source_status", ["", "UNKNOWN"])
def test_unknown_status_and_optional_numbers_project_to_null(workspace_api, source_status):
    client, factory, baseline, _ = workspace_api

    def mutate(tables):
        tables["node.csv"][0].update(status=source_status, elevation_m="")
        tables["device.csv"][0].update(status=source_status, work_freq_khz="", tilt_deg="", azimuth_deg="")

    baseline = seed(baseline, mutate)
    expected = counts(factory)
    data = context(client, baseline)
    node, device = data["resources"]["stations"][0], data["resources"]["devices"][0]
    assert node["status"] is node["alert"] is node["elevationM"] is None
    assert device["status"] is device["alert"] is device["workFreqKhz"] is device["tiltDeg"] is device["azimuthDeg"] is None
    assert device["currentWorkMode"] is None
    read = client.get("/api/v1/resource/context")
    assert read.status_code == 200, read.text
    stats = read.json()["data"]["stats"]
    expected_unknown = sum(row.get("status") in ("", "UNKNOWN", None) for row in baseline["tables"]["device.csv"])
    assert stats["unknown_alerts"] == expected_unknown
    assert stats["alerts"] == sum(row.get("status") in ("FAULT", "OFFLINE") for row in baseline["tables"]["device.csv"])
    assert_unchanged(factory, baseline, expected)


def test_existing_three_device_parameters_and_node_interference_patch_are_atomic(workspace_api):
    client, factory, baseline, _ = workspace_api
    switch(client)
    device = baseline["tables"]["device.csv"][0]
    model = next(row for row in baseline["tables"]["device_model.csv"] if row["model_id"] == device["model_id"])
    node, interference = baseline["tables"]["node.csv"][0], baseline["tables"]["interference_source.csv"][0]
    changes = {"stations": [{"id": node["node_id"], "name": "编辑节点名", "elevationM": None, "remark": "已编辑"}],
               "devices": [{"id": device["device_id"], "antennaHeightM": 17.125,
                            "txPowerDbm": float(model["tx_power_max_dbm"]) - 1, "workFreqKhz": float(model["freq_min_khz"])}],
               "interferences": [{"id": interference["interference_id"], "name": "编辑干扰源", "active": False, "dutyCycle": None}]}
    response = save(client, body(baseline, changes))
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    receipt, result = data["receipt"], data["result"]
    assert receipt["changed"] and receipt["revision"] == receipt["readRevision"] == result["resources"]["version"]
    assert receipt["revision"] != baseline["revision"]
    assert receipt["affectedIds"] == sorted([device["device_id"], node["node_id"], interference["interference_id"]])
    assert receipt["objectId"] == "resource-workspace"
    current = datasets.current()
    assert current["tables"]["node.csv"][0]["node_name"] == "编辑节点名"
    assert current["tables"]["node.csv"][0]["elevation_m"] == ""
    assert current["tables"]["device.csv"][0]["antenna_height_m"] == "17.125"
    assert current["tables"]["device.csv"][0]["status"] == device["status"]
    assert current["tables"]["interference_source.csv"][0]["active"] == "false"
    assert "origin" not in current["tables"]["device.csv"][0]
    assert current["source_files"] == baseline["source_files"]
    with factory() as session:
        assert datasets._decode(session.get(ResourceDatasetVersion, baseline["revision"]))["tables"] == baseline["tables"]
    assert counts(factory) == (2, 1)


def test_new_node_device_interference_are_manual_active_and_unknown(workspace_api):
    client, factory, baseline, _ = workspace_api
    switch(client)
    node = new_node()
    changes = {"newStations": [node], "newDevices": [new_device(baseline, node["id"])], "newInterferences": [new_interference()]}
    response = save(client, body(baseline, changes, context="gis"))
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    resources = data["result"]["resources"]
    station = next(row for row in resources["stations"] if row["id"] == node["id"])
    device = next(row for row in resources["devices"] if row["id"] == "MANUAL-DEVICE")
    interference = next(row for row in resources["interferences"] if row["id"] == "MANUAL-INTERFERENCE")
    assert station["status"] is station["alert"] is device["status"] is device["alert"] is None
    assert station["origin"] == device["origin"] == interference["origin"] == "MANUAL"
    assert device["availability"] == "ACTIVE" and device["stationId"] == node["id"]
    assert device["workFreqKhz"] is device["tiltDeg"] is device["azimuthDeg"] is None
    current = datasets.current()
    assert current["tables"]["node.csv"][-1]["status"] == current["tables"]["device.csv"][-1]["status"] == ""
    assert len(current["tables"]["node.csv"]) == len(baseline["tables"]["node.csv"]) + 1
    assert data["receipt"]["affectedIds"] == sorted([node["id"], "MANUAL-DEVICE", "MANUAL-INTERFERENCE"])
    assert context(client, current)["resources"] == resources
    stats = assert_resource_context_stats(client, current)
    original_unknown = sum(row.get("status") not in {"NORMAL", "FAULT", "OFFLINE"}
                           for row in baseline["tables"]["device.csv"])
    assert stats["unknown_alerts"] == original_unknown + 1
    assert_unchanged(factory, current, (2, 1))


@pytest.mark.parametrize("key,field,value", [
    ("devices", "status", None), ("devices", "status", "NORMAL"), ("devices", "alert", False),
    ("devices", "availability", "OFF_SHELF"), ("devices", "modelId", "other"),
    ("devices", "stationId", "other"), ("devices", "antennaId", "other"),
    ("devices", "installedAt", ""), ("devices", "tiltDeg", 0), ("devices", "azimuthDeg", 0),
    ("devices", "ports", []), ("devices", "currentWorkMode", "FM"), ("devices", "antenna_height_m", 1),
    ("stations", "parentIds", []), ("stations", "classes", ["HF"]), ("stations", "mobility", "FIXED"),
    ("stations", "echelon", "I"), ("stations", "status", None), ("stations", "key", False),
    ("interferences", "origin", "IMPORT"), ("interferences", "unknownField", True),
])
def test_readonly_and_unsupported_fields_are_422_without_write(workspace_api, key, field, value):
    client, factory, baseline, _ = workspace_api
    switch(client)
    table, identifier = {"devices": ("device.csv", "device_id"), "stations": ("node.csv", "node_id"),
                         "interferences": ("interference_source.csv", "interference_id")}[key]
    changes = {key: [{"id": baseline["tables"][table][0][identifier], field: value}]}
    response = save(client, body(baseline, changes))
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert_unchanged(factory, baseline)


@pytest.mark.parametrize("key", ["ports", "mode", "candidateLinks", "newCandidateLinks", "importedCandidateLinks", "availability", "models", "devices_extra"])
def test_unsupported_change_categories_are_explicit_422(workspace_api, key):
    client, factory, baseline, _ = workspace_api
    switch(client)
    response = save(client, body(baseline, {key: []}))
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert_unchanged(factory, baseline)


@pytest.mark.parametrize("field,value", [
    ("antennaHeightM", None), ("antennaHeightM", True), ("antennaHeightM", -1),
    ("antennaHeightM", "10"), ("txPowerDbm", None), ("txPowerDbm", 9999),
    ("workFreqKhz", False), ("workFreqKhz", 0), ("workFreqKhz", 999999999),
    ("antennaHeightM", float("nan")), ("txPowerDbm", float("inf")), ("workFreqKhz", -float("inf")),
])
def test_numeric_type_range_null_and_nonfinite_are_rejected(workspace_api, field, value):
    client, factory, baseline, _ = workspace_api
    switch(client)
    payload = body(baseline, {"devices": [{"id": baseline["tables"]["device.csv"][0]["device_id"], field: value}]})
    response = client.post(SAVE, headers={**headers(client), "Content-Type": "application/json"}, content=json.dumps(payload))
    assert response.status_code == 422 and response.json()["code"] == 1001, response.text
    assert_unchanged(factory, baseline)


@pytest.mark.parametrize("change", [
    {"stations": [{"name": ""}]}, {"stations": [{"name": None}]},
    {"stations": [{"coordinate": None}]}, {"stations": [{"coordinate": [True, 37]}]},
    {"stations": [{"coordinate": [0, 0]}]}, {"interferences": [{"active": 1}]},
    {"interferences": [{"centerFreqKhz": 0}]}, {"interferences": [{"dutyCycle": 2}]},
    {"interferences": [{"patternType": "DIRECTIONAL", "azimuthDeg": None}]},
])
def test_node_and_interference_validation_reuses_parser(workspace_api, change):
    client, factory, baseline, _ = workspace_api
    switch(client)
    key = next(iter(change))
    table, field = ("node.csv", "node_id") if key == "stations" else ("interference_source.csv", "interference_id")
    change = deepcopy(change)
    change[key][0]["id"] = baseline["tables"][table][0][field]
    response = save(client, body(baseline, change))
    assert response.status_code == 422, response.text
    assert_unchanged(factory, baseline)


@pytest.mark.parametrize("mutation", ["duplicate", "new_duplicate", "cross_category_duplicate", "unknown", "list_type", "row_type", "extra_root", "empty_changes"])
def test_duplicates_structure_and_unknown_fields_do_not_write(workspace_api, mutation):
    client, factory, baseline, _ = workspace_api
    switch(client)
    payload = body(baseline)
    if mutation == "duplicate":
        payload["changes"]["devices"] *= 2
    elif mutation == "new_duplicate":
        payload["changes"] = {"newDevices": [new_device(baseline)] * 2}
    elif mutation == "cross_category_duplicate":
        payload["changes"]["newDevices"] = [new_device(baseline, identifier=payload["changes"]["devices"][0]["id"])]
    elif mutation == "unknown":
        payload["changes"]["devices"][0]["unknown"] = 1
    elif mutation == "list_type":
        payload["changes"]["devices"] = {}
    elif mutation == "row_type":
        payload["changes"]["devices"] = [True]
    elif mutation == "extra_root":
        payload["actor_id"] = "admin"
    else:
        payload["changes"] = {}
    response = save(client, payload)
    assert response.status_code == 422, response.text
    assert_unchanged(factory, baseline)


@pytest.mark.parametrize("kind,field,value", [
    ("newStations", "status", "NORMAL"), ("newStations", "alert", False), ("newStations", "origin", "SOURCE"),
    ("newDevices", "status", "OFFLINE"), ("newDevices", "alert", False), ("newDevices", "origin", "IMPORT"),
    ("newDevices", "availability", "OFF_SHELF"), ("newDevices", "modelId", "missing-model"),
    ("newDevices", "stationId", "missing-node"), ("newDevices", "antennaId", "missing-antenna"),
    ("newStations", "parentIds", ["MANUAL-NODE"]), ("newStations", "classes", ["UHF"]),
    ("newInterferences", "origin", "IMPORT"), ("newInterferences", "alert", True),
])
def test_new_resources_cannot_forge_state_or_invalid_references(workspace_api, kind, field, value):
    client, factory, baseline, _ = workspace_api
    switch(client)
    row = {"newStations": new_node(), "newDevices": new_device(baseline), "newInterferences": new_interference()}[kind]
    row[field] = value
    response = save(client, body(baseline, {kind: [row]}))
    assert response.status_code == 422, response.text
    assert_unchanged(factory, baseline)


def test_mixed_batch_is_atomic_when_later_device_fails(workspace_api):
    client, factory, baseline, _ = workspace_api
    switch(client)
    changes = {"stations": [{"id": baseline["tables"]["node.csv"][0]["node_id"], "name": "不得部分保存"}],
               "devices": [{"id": baseline["tables"]["device.csv"][0]["device_id"], "txPowerDbm": 9999}],
               "newInterferences": [new_interference()]}
    response = save(client, body(baseline, changes))
    assert response.status_code == 422
    assert_unchanged(factory, baseline)


def test_numeric_equivalent_and_empty_changes_are_noops_without_source_origin_key(workspace_api):
    client, factory, baseline, _ = workspace_api

    def mutate(tables):
        tables["device.csv"][0]["antenna_height_m"] = "9"
        tables["device.csv"][0]["work_freq_khz"] = ""

    baseline = seed(baseline, mutate)
    before = counts(factory)
    switch(client)
    identifier = baseline["tables"]["device.csv"][0]["device_id"]
    for index, changes in enumerate(({"devices": [{"id": identifier, "antennaHeightM": 9.0, "workFreqKhz": None}]},
                                     {"stations": [], "devices": []})):
        response = save(client, body(baseline, changes, request_id="noop-" + str(index)))
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["receipt"]["changed"] is False and data["receipt"]["affectedIds"] == []
        assert data["receipt"]["revision"] == baseline["revision"]
    assert datasets.current()["tables"] == baseline["tables"]
    assert "origin" not in datasets.current()["tables"]["device.csv"][0]
    assert counts(factory) == (before[0], before[1] + 2)


def test_nullable_frequency_can_be_cleared_without_default_values(workspace_api):
    client, factory, baseline, _ = workspace_api
    existing = baseline["tables"]["device.csv"][0]
    model = next(row for row in baseline["tables"]["device_model.csv"] if row["model_id"] == existing["model_id"])
    baseline = seed(baseline, lambda tables: tables["device.csv"][0].update(work_freq_khz=model["freq_min_khz"]))
    switch(client)
    response = save(client, body(baseline, {"devices": [{"id": existing["device_id"], "workFreqKhz": None}]}))
    assert response.status_code == 200, response.text
    assert response.json()["data"]["receipt"]["device"]["workFreqKhz"] is None
    assert datasets.current()["tables"]["device.csv"][0]["work_freq_khz"] == ""


@pytest.mark.parametrize("remark", ["~rp~literal", '~rp~"原文"'])
def test_workspace_literal_escape_prefix_is_not_decoded_as_external_csv(workspace_api, remark):
    client, factory, baseline, _ = workspace_api
    switch(client)
    identifier = baseline["tables"]["node.csv"][0]["node_id"]
    response = save(client, body(baseline, {"stations": [{"id": identifier, "remark": remark}]}))
    assert response.status_code == 200, response.text
    assert datasets.current()["tables"]["node.csv"][0]["remark"] == remark


def test_replay_is_frozen_after_later_version_and_reopened_connection(workspace_api, monkeypatch):
    client, factory, baseline, path = workspace_api
    switch(client)
    request = body(baseline, request_id="first-workspace")
    response = save(client, request)
    assert response.status_code == 200, response.text
    first = response.json()["data"]
    assert first["receipt"]["warnings"]
    assert all(set(warning) == {"sheet", "row", "objectId", "field", "message"}
               for warning in first["receipt"]["warnings"])
    assert first["receipt"]["warnings"] == first["result"]["warnings"]
    current = datasets.current()
    second_request = body(current, {"devices": [{"id": current["tables"]["device.csv"][0]["device_id"], "antennaHeightM": 18.125}]}, "second-workspace")
    second = save(client, second_request).json()["data"]
    assert first["receipt"]["revision"] != second["receipt"]["revision"]
    assert save(client, request).json()["data"] == first
    reopened = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False})
    replacement = sessionmaker(bind=reopened, expire_on_commit=False)
    try:
        for module in (database, datasets, identity):
            monkeypatch.setattr(module, "get_session_factory", lambda: replacement)
        assert save(client, request).json()["data"] == first
        assert datasets.current()["revision"] == second["receipt"]["revision"]
    finally:
        reopened.dispose()
    assert first["receipt"]["device"]["antennaHeightM"] == 17.125
    assert first["receipt"]["device"] in first["result"]["resources"]["devices"]
    assert counts(factory) == (3, 2)


def test_stale_context_idempotency_conflict_and_other_actor(workspace_api, monkeypatch):
    client, factory, baseline, _ = workspace_api
    switch(client)
    request = body(baseline)
    first = save(client, request)
    assert first.status_code == 200, first.text
    assert save(client, request).json() == first.json()
    stale = save(client, {**request, "request_id": "stale-workspace"})
    assert stale.status_code == 409 and stale.json()["code"] == 1205
    assert client.get(CONTEXT, params={"context": "ledger", "revision": baseline["revision"]}).json()["code"] == 1205
    conflict = deepcopy(request)
    conflict["changes"]["devices"][0]["antennaHeightM"] = 19.125
    assert save(client, conflict).json()["code"] == 1206
    monkeypatch.setitem(identity.CATALOG, "other-workspace-editor", ("另一编辑者", "EDITOR", list(identity.CATALOG["integration-editor"][2])))
    switch(client, "other-workspace-editor")
    response = save(client, request)
    assert response.status_code == 409 and response.json()["code"] == 1206
    assert counts(factory) == (2, 1)


@pytest.mark.parametrize("excluded,creating", [("resources.create", True), ("resources.workspace.edit", False)])
def test_create_and_existing_edit_permissions_are_separate(workspace_api, monkeypatch, excluded, creating):
    client, factory, baseline, _ = workspace_api
    name, role, permissions = identity.CATALOG["integration-editor"]
    monkeypatch.setitem(identity.CATALOG, "integration-editor", (name, role, [item for item in permissions if item != excluded]))
    switch(client)
    changes = {"newDevices": [new_device(baseline)]} if creating else body(baseline)["changes"]
    assert save(client, body(baseline, changes)).status_code == 403
    mixed = {**body(baseline)["changes"], "newDevices": [new_device(baseline)]}
    assert save(client, body(baseline, mixed)).status_code == 403
    assert_unchanged(factory, baseline)


def test_permissions_csrf_session_expiry_and_context_query_strictness(workspace_api, monkeypatch):
    client, factory, baseline, _ = workspace_api
    switch(client, "integration-reviewer")
    assert save(client, body(baseline)).status_code == 403
    switch(client)
    assert client.post(SAVE, json=body(baseline)).status_code == 409
    assert client.post(SAVE, headers={**headers(client), "X-CSRF-Token": "bad"}, json=body(baseline)).status_code == 403
    for params in ({"context": "other"}, {"context": "ledger", "unknown": "x"}, [("context", "ledger"), ("context", "gis")]):
        assert client.get(CONTEXT, params=params).status_code == 422
    assert context(client)["revision"] == baseline["revision"]
    last_headers = headers(client)
    switch(client)
    assert client.post(SAVE, headers=last_headers, json=body(baseline)).status_code == 409
    last_headers = headers(client)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert client.post(SAVE, headers=last_headers, json=body(baseline)).status_code == 401
    assert client.get(CONTEXT, params={"context": "ledger"}).status_code == 401
    assert_unchanged(factory, baseline)


def test_unknown_target_is_404_and_transaction_failure_rolls_back(workspace_api, monkeypatch):
    client, factory, baseline, _ = workspace_api
    switch(client)
    assert save(client, body(baseline, {"devices": [{"id": "missing-device", "antennaHeightM": 1}]})).status_code == 404
    original = datasets._validate_snapshot

    def reject_changed(snapshot):
        original(snapshot)
        if "change" in snapshot:
            raise datasets.ResourceDatasetError("隔离测试模拟快照校验失败")

    monkeypatch.setattr(datasets, "_validate_snapshot", reject_changed)
    assert save(client, body(baseline)).status_code == 503
    assert_unchanged(factory, baseline)
