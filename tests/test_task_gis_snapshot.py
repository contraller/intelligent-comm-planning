"""冻结任务态势用历史坐标回读，不受当前资源换版或规划草稿影响。"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app.database import Base
from app.main import app
from app import integration_identity_service, resource_dataset_service as datasets, task_gis_service
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from app.task_input_models import PlanningTask, PlanningTaskRevision
from app.planning_job_models import PlanningJob


@pytest.fixture
def world(monkeypatch):
    # 本轮只使用内存数据库，不连接用户运行库。
    engine = create_engine("sqlite+pysqlite:///:memory:", poolclass=StaticPool,
                           connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    monkeypatch.setattr(task_gis_service, "get_session_factory", lambda: factory)
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    _, original = datasets.capture_files()
    changed = deepcopy(original)
    changed["tables"]["node.csv"][0]["lon"] = str(float(original["tables"]["node.csv"][0]["lon"]) + .01)
    first, second = original["tables"]["node.csv"][:2]
    now = datetime.now(timezone.utc)
    data = {"name": "冻结任务一", "description": "测试", "bbox": [113, 36, 116, 39],
            "stationIds": [first["node_id"], second["node_id"]], "presetId": "P1", "frequencyId": "F1",
            "startTime": None, "durationH": None,
            "constraints": {"connectivityPercent": 100, "maxRelayHops": 2, "survivabilityPercent": 90},
            "demands": [{"id": "D1", "sourceId": first["node_id"], "targetId": second["node_id"],
                         "endpointMode": "station", "sourceDeviceId": None, "targetDeviceId": None,
                         "preferredClass": None, "service": "数据", "priority": "P1", "mandatory": True,
                         "dataVolumeMb": 10, "requiredRateKbps": 64, "maxDelayMs": 100, "minReliability": .95}]}
    with factory.begin() as session:
        for revision, content in [("resource-1111111111111111", original), ("resource-2222222222222222", changed)]:
            session.add(ResourceDatasetVersion(revision=revision, content_hash=datasets.content_hash(content),
                        source=datasets.SOURCE, data_origin=datasets.ORIGIN, snapshot=content, created_at=now))
        session.flush()
        session.add(ResourceDatasetCurrent(scope=datasets.SCOPE, revision="resource-2222222222222222"))
        for task_id, revision in [("T1", "TREV-ONE"), ("T2", "TREV-TWO")]:
            session.add(PlanningTask(task_id=task_id, current_revision_id=revision,
                        current_version_no=1, created_at=now, updated_at=now))
            session.flush()
            session.add(PlanningTaskRevision(revision_id=revision, task_id=task_id, version_no=1,
                        condition_version="TCOND-1", resource_revision="resource-1111111111111111",
                        context="planning", input_snapshot=deepcopy(data), created_at=now))
    with TestClient(app) as client:
        yield client, factory, data, original
    engine.dispose()


def read(client, task="T1", revision="TREV-ONE", **params):
    return client.get(f"/api/v1/task-inputs/{task}/gis-snapshot", params={
        "context": "planning", "revision": revision, **params})


def test_changed_current_resources_do_not_replace_frozen_coordinates(world):
    client, factory, data, original = world
    response = read(client)
    assert response.status_code == 200, response.text
    value = response.json()["data"]
    assert value["source_changed"] is True
    assert value["snapshot_id"] == "GIS-TASK-TREV-ONE"
    assert value["task"]["input"] == data
    assert value["task"]["input_version"] == value["task_revision"] == "TREV-ONE"
    assert value["resource_revision"] == value["task"]["resource_revision"]
    assert [row["node_id"] for row in value["nodes"]] == data["stationIds"]
    assert value["nodes"][0]["lon"] == float(original["tables"]["node.csv"][0]["lon"])
    assert "历史冻结任务" in value["message"] and "需求连线" in value["message"]
    with factory() as session:
        assert session.get(ResourceDatasetCurrent, datasets.SCOPE).revision == "resource-2222222222222222"
        assert session.scalar(select(func.count()).select_from(PlanningJob)) == 0
        assert session.scalar(select(func.count()).select_from(ResourceDatasetVersion)) == 2


def test_exact_input_revision_remains_viewable_after_task_resaved(world):
    client, factory, data, _ = world
    with factory.begin() as session:
        newer = deepcopy(data); newer["name"] = "新保存名称"
        session.add(PlanningTaskRevision(revision_id="TREV-NEW", task_id="T1", version_no=2,
            condition_version="TCOND-2", resource_revision="resource-2222222222222222",
            context="planning", input_snapshot=newer, created_at=datetime.now(timezone.utc)))
        task = session.get(PlanningTask, "T1"); task.current_revision_id = "TREV-NEW"; task.current_version_no = 2
    assert read(client).json()["data"]["task"]["input"]["name"] == "冻结任务一"
    latest = read(client, revision="TREV-NEW").json()["data"]
    assert latest["task"]["input"]["name"] == "新保存名称" and latest["source_changed"] is False


@pytest.mark.parametrize("task,revision,context", [("T1", "TREV-TWO", "planning"),
    ("T1", "TREV-MISSING", "planning"), ("T1", "TREV-ONE", "gis"), ("missing", "TREV-ONE", "planning")])
def test_wrong_task_revision_context_never_reads_other_snapshot(world, task, revision, context):
    response = read(world[0], task, revision, context=context)
    assert response.status_code == 404 and response.json()["code"] == 2001


def test_missing_history_is_explicit_not_current_fallback(world):
    client, factory, _, _ = world
    with factory.begin() as session:
        row = session.get(PlanningTaskRevision, "TREV-ONE")
        row.resource_revision = "resource-9999999999999999"
    response = read(client)
    assert response.status_code == 404 and response.json()["code"] == 2004
    assert "当前坐标替代" in response.json()["message"]


def test_missing_node_is_reported_without_zero_or_current_coordinate(world):
    client, factory, data, _ = world
    with factory.begin() as session:
        row = session.get(PlanningTaskRevision, "TREV-ONE")
        value = deepcopy(data); value["stationIds"][0] = "NODE-MISSING"
        value["demands"][0]["sourceId"] = "NODE-MISSING"; row.input_snapshot = value
    value = read(client).json()["data"]
    assert value["missing_node_ids"] == ["NODE-MISSING"]
    assert len(value["nodes"]) == 1 and value["nodes"][0]["node_id"] == data["stationIds"][1]


@pytest.mark.parametrize("params", [{"extra": "1"}, {"context": "other"}, {"revision": ""}])
def test_query_is_strict(world, params):
    response = read(world[0], **params)
    assert response.status_code == 422 and response.json()["code"] == 1001


def test_duplicate_query_body_and_permissions_are_rejected(world, monkeypatch):
    client = world[0]
    url = "/api/v1/task-inputs/T1/gis-snapshot"
    assert client.get(url + "?context=planning&revision=TREV-ONE&revision=TREV-TWO").status_code == 422
    assert client.request("GET", url + "?context=planning&revision=TREV-ONE", json={}).status_code == 422
    original = integration_identity_service.require
    for denied in ["planning.view", "situation.view"]:
        def permission(request, required, denied=denied):
            if required == denied:
                raise integration_identity_service.IdentityError("没有此项查看权限")
            return original(request, required)
        monkeypatch.setattr(integration_identity_service, "require", permission)
        assert read(client).status_code == 403


def test_file_mode_cannot_invent_old_resource_snapshot(world, monkeypatch):
    client, factory, _, original = world
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    monkeypatch.setattr(datasets, "capture_files", lambda: ("resource-2222222222222222", deepcopy(original)))
    response = read(client)
    assert response.status_code == 404 and response.json()["code"] == 2004
