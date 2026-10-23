"""任务文件独立路由/真实只读任务预检；不连接运行库或启动主服务。"""
from __future__ import annotations

import base64
import copy
import csv
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import frontend_integration, resource_dataset_service, task_input_service
from app.database import Base
from app.task_file_parser import build_task_template
from app.task_file_router import create_task_file_router
from app.task_file_service import _row_issue
from app.task_input_models import PlanningTask, PlanningTaskRevision, PlanningOperationReceipt
from app.task_input_schemas import TaskSaveRequest


def task_input():
    return {"name": "文件接口验证", "description": "构造测试，非实测", "bbox": [113, 36, 116, 39],
        "stationIds": ["N1", "N2"], "presetId": "P1", "frequencyId": "F1", "startTime": None, "durationH": None,
        "constraints": {"connectivityPercent": 100, "maxRelayHops": 2, "survivabilityPercent": 90},
        "demands": [{"id": "D1", "sourceId": "N1", "targetId": "N2", "endpointMode": "station",
            "sourceDeviceId": None, "targetDeviceId": None, "preferredClass": None, "service": "数据",
            "priority": "P1", "mandatory": True, "dataVolumeMb": 0, "requiredRateKbps": 64,
            "maxDelayMs": 100, "minReliability": 0}]}


def payload(format="csv", value=None):
    value = copy.deepcopy(value or task_input())
    kinds = ("task_scenarios", "task_links") if format == "csv" else ("task_scenarios",)
    files = [build_task_template(format, kind, value) for kind in kinds]
    return {"context": "planning", "task_id": "T1", "expected_revision": None, "resource_revision": "R1", "input": value,
        "files": [{"name": file["name"], "bytes_base64": base64.b64encode(file["bytes"]).decode("ascii")} for file in files]}


@pytest.fixture
def api(monkeypatch):
    engine = create_engine("sqlite+pysqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "R1")
    monkeypatch.setattr(frontend_integration, "task_reference_catalog", lambda: {"node_ids": {"N1", "N2"},
        "devices": {"E1": {"node_id": "N1", "device_class": "HF"}, "E2": {"node_id": "N2", "device_class": "HF"}}})
    monkeypatch.setattr(resource_dataset_service, "database_mode", lambda: False)
    calls = []
    def actor(request, permission, writing=False):
        calls.append((permission, writing))
        if request.headers.get("x-test-denied"):
            raise task_input_service.TaskInputError(1104, "无权限", 403)
        return {"account_id": "unit-file-editor"}
    app = FastAPI()
    app.include_router(create_task_file_router(actor, factory=factory))
    with TestClient(app) as client:
        yield client, factory, calls
    engine.dispose()


def counts(factory):
    with factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model)) for model in (PlanningTask, PlanningTaskRevision, PlanningOperationReceipt))


@pytest.mark.parametrize("format", ["csv", "xlsx"])
def test_preview_uses_raw_file_and_real_validation_without_writes(api, format):
    client, factory, calls = api
    body = payload(format)
    response = client.post("/api/v1/task-files/preview", json=body)
    assert response.status_code == 200, response.text
    value = response.json()["data"]
    assert value["input"]["demands"][0]["minReliability"] == 0
    assert value["input"]["demands"][0]["dataVolumeMb"] == 0
    assert value["issues"] == [] and value["taskId"] == "TASK-NEW"
    assert value["taskRevision"] is None and value["existing"] is False
    assert value["requestContext"] == {"context": "planning", "taskId": "T1", "taskRevision": None, "resourceRevision": "R1"}
    assert len(value["signature"]) == 64 and counts(factory) == (0, 0, 0)
    assert calls == [("planning.view", True)]


@pytest.mark.parametrize("format", ["csv", "xlsx"])
def test_template_returns_attachment_not_mock_or_write(api, format):
    client, factory, _ = api
    response = client.post("/api/v1/task-files/template", json={"context": "gis", "format": format, "kind": "task_links", "input": task_input()})
    assert response.status_code == 200, response.text
    assert "attachment" in response.headers["content-disposition"]
    assert response.content.startswith(b"PK\x03\x04" if format == "xlsx" else b"demand_id,task_id,")
    assert counts(factory) == (0, 0, 0)


def test_existing_task_uses_saved_revision_and_saved_before_image(api):
    client, factory, _ = api
    original = task_input()
    original["name"] = "已保存名称"
    original["demands"][0]["needBackup"] = True
    saved = task_input_service.save_task_input(TaskSaveRequest.model_validate({"context": "planning", "task_id": "TASK-NEW",
        "expected_revision": None, "resource_revision": "R1", "request_id": "unit-file-save", "input": original}), "TASK-NEW", factory=factory)
    before = counts(factory)
    response = client.post("/api/v1/task-files/preview", json=payload())
    assert response.status_code == 200, response.text
    value = response.json()["data"]
    assert value["existing"] is True and value["taskRevision"] == saved["revision"]
    assert any(row["field"] == "name" and row["before"] == "已保存名称" for row in value["differences"])
    assert any("路由条件" in note and "清空" in note for note in value["notes"])
    assert counts(factory) == before


def test_reference_failure_retains_row_issue_and_no_writes(api):
    client, factory, _ = api
    value = task_input(); value["stationIds"].append("N3")
    response = client.post("/api/v1/task-files/preview", json=payload(value=value))
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert result["input"] is None
    assert any(row["objectId"] == "N3" and row["sheet"] == "task_scenarios" and row["row"] == 2 for row in result["issues"])
    assert counts(factory) == (0, 0, 0)


@pytest.mark.parametrize("change", [{"resource_revision": "old"}, {"files": [{"name": "input.xlsx", "bytes_base64": "bad-base64"}]}, {"extra": True}])
def test_conflict_or_bad_input_is_failure_not_success(api, change):
    client, factory, _ = api
    response = client.post("/api/v1/task-files/preview", json={**payload(), **change})
    assert response.status_code == (409 if "resource_revision" in change else 422)
    assert response.json()["code"] != 0 and counts(factory) == (0, 0, 0)


def test_resource_change_during_read_rejects_preview(api, monkeypatch):
    client, factory, _ = api
    calls = []
    def revision():
        calls.append(1)
        return "R1" if len(calls) == 1 else "R2"
    monkeypatch.setattr(frontend_integration, "resource_revision", revision)
    response = client.post("/api/v1/task-files/preview", json=payload())
    assert response.status_code == 409 and response.json()["code"] == 1205
    assert counts(factory) == (0, 0, 0)


def test_authorization_query_and_json_errors_are_envelopes(api):
    client, factory, _ = api
    for path, kwargs, status in [
        ("/preview", {"json": payload(), "headers": {"x-test-denied": "1"}}, 403),
        ("/preview?context=gis", {"json": payload()}, 422),
        ("/preview", {"content": b"not-json", "headers": {"Content-Type": "application/json"}}, 422),
        ("/template", {"json": {"context": "planning", "format": "pdf", "input": task_input()}}, 422),
    ]:
        response = client.post("/api/v1/task-files" + path, **kwargs)
        assert response.status_code == status
        assert set(response.json()) == {"code", "message", "data"}
    assert counts(factory) == (0, 0, 0)


def test_signature_binds_original_file_and_context(api):
    client, _, _ = api
    body = payload()
    first = client.post("/api/v1/task-files/preview", json=body).json()["data"]["signature"]
    body["files"][0]["name"] = "renamed.csv"
    second = client.post("/api/v1/task-files/preview", json=body).json()["data"]["signature"]
    assert first != second


def test_deployment_issue_uses_physical_task_row_even_if_task_and_demand_ids_match(api):
    client, factory, _ = api
    value = task_input()
    value["demands"][0]["id"] = "TASK-NEW"
    value["deploymentConstraints"] = {"maxSlopeDeg": 0, "elevationRangeM": None, "allowedLandcover": None,
        "roadMaxDistanceM": None, "minSiteSpacingM": None, "losRequiredNodeIds": ["N3"],
        "gridStepM": None, "forcedInclude": [], "forcedExcludePolygons": []}
    body = payload(value=value)
    file = body["files"][0]
    rows = list(csv.reader(io.StringIO(base64.b64decode(file["bytes_base64"]).decode("utf-8-sig"))))
    target = io.StringIO(newline="")
    csv.writer(target).writerows([rows[0], [], [], *rows[1:]])
    file["bytes_base64"] = base64.b64encode(target.getvalue().encode("utf-8")).decode("ascii")
    response = client.post("/api/v1/task-files/preview", json=body)
    assert response.status_code == 200, response.text
    issues = response.json()["data"]["issues"]
    assert any(row["field"] == "deploymentConstraints.losRequiredNodeIds" and row["sheet"] == "task_scenarios" and row["row"] == 4 for row in issues)
    assert counts(factory) == (0, 0, 0)


def test_nonfinite_defaults_fail_as_validation_not_internal_error(api):
    client, factory, _ = api
    body = payload()
    body["input"]["bbox"][0] = float("nan")
    response = client.post("/api/v1/task-files/preview", content=json.dumps(body), headers={"Content-Type": "application/json"})
    assert response.status_code == 422 and response.json()["code"] == 1001
    assert counts(factory) == (0, 0, 0)


def test_task_root_errors_do_not_alias_a_same_named_demand():
    for field in ("", "stationIds", "bbox.0"):
        value = _row_issue({"objectId": "TASK-NEW", "field": field, "message": "invalid task"}, {"TASK-NEW": 2}, 4)
        assert (value["sheet"], value["row"]) == ("task_scenarios", 4)
