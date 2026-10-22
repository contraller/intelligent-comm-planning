"""首个前端任务保存闭环的接口契约测试。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import frontend_integration, task_input_models, task_input_service  # noqa: E402
from app.database import Base  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(task_input_service, "get_session_factory", lambda: factory)
    yield TestClient(app), factory
    engine.dispose()


def test_integration_identity_is_explicitly_gated(monkeypatch):
    monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO", raising=False)
    response = TestClient(app).get("/api/v1/auth/session")
    assert response.status_code == 401
    assert response.json()["code"] == 1101


def test_frontend_initialization_contract(api):
    client, _ = api
    identity = client.get("/api/v1/auth/session")
    assert identity.status_code == 200
    assert {"planning.view", "planning.execute"}.issubset(
        identity.json()["data"]["permissions"])

    csrf = client.get("/api/v1/auth/csrf").json()["data"]
    assert csrf == {
        "csrf_token": frontend_integration.CSRF_TOKEN,
        "session_id": frontend_integration.SESSION_ID,
    }

    context = client.get("/api/v1/resource/context", params={"context": "planning"})
    assert context.status_code == 200
    workspace = context.json()["data"]
    assert workspace["stats"]["nodes"] >= 50
    assert workspace["stats"]["devices"] >= 100
    active_dem = json.loads((ROOT / "data/raw/dem/dem_current.json").read_text(
        encoding="utf-8"))
    assert workspace["terrain"] == {
        "source_sha256": active_dem["source_sha256"],
        "bbox": active_dem["bbox"],
        "source": active_dem["source"],
    }

    presets = client.get(
        "/api/v1/resource/param-presets", params={"context": "planning"}
    ).json()["data"]
    frequencies = client.get(
        "/api/v1/resource/frequency-pool", params={"context": "planning"}
    ).json()["data"]
    assert presets["revision"] == frequencies["revision"]
    assert len(presets["items"]) == 3
    frequency_ids = {item["id"] for item in frequencies["items"]}
    assert all(item["defaults"]["frequencyId"] in frequency_ids
               for item in presets["items"])

    query = {
        "context": "planning",
        "revision": workspace["revision"],
        "bbox": ",".join(map(str, workspace["bounds"])),
        "zoom": 9,
        "show_nodes": True,
        "show_interferences": False,
    }
    frame = client.get("/api/v1/resource/map", params=query)
    assert frame.status_code == 200
    assert frame.json()["data"]["total_nodes"] == workspace["stats"]["nodes"]

    node_page = client.get("/api/v1/resource/nodes", params={
        "context": "planning", "revision": workspace["revision"],
        "page": 1, "page_size": 10, "search": "", "sort": "id",
    })
    assert node_page.status_code == 200
    assert len(node_page.json()["data"]["items"]) == 10
    assert node_page.json()["data"]["total"] == workspace["stats"]["nodes"]

    for node_id in presets["items"][0]["defaults"]["stationIds"]:
        detail = client.get(
            f"/api/v1/resource/nodes/{node_id}",
            params={"context": "planning", "revision": workspace["revision"]},
        )
        assert detail.status_code == 200
        assert detail.json()["data"]["item"]["node_id"] == node_id


def test_missing_dem_only_disables_terrain(api, monkeypatch, tmp_path):
    client, _ = api
    monkeypatch.setattr(frontend_integration, "REPO_ROOT", tmp_path)
    response = client.get("/api/v1/resource/context", params={"context": "planning"})
    assert response.status_code == 200
    assert response.json()["data"]["terrain"] is None
    assert response.json()["data"]["stats"]["nodes"] >= 50


def test_resource_errors_use_api_envelope(api, monkeypatch):
    client, _ = api
    invalid_context = client.get("/api/v1/resource/context", params={"context": "wrong"})
    assert invalid_context.status_code == 422
    assert invalid_context.json() == {
        "code": 1001, "message": "invalid resource context", "data": None}

    revision = client.get("/api/v1/resource/context").json()["data"]["revision"]
    query = {"revision": revision, "bbox": "wrong", "zoom": 8}
    invalid_bbox = client.get("/api/v1/resource/map", params=query)
    assert invalid_bbox.status_code == 422
    assert invalid_bbox.json()["code"] == 1001
    malformed_bbox = client.get("/api/v1/resource/map", params={
        **query, "bbox": "115,38,114,37"})
    assert malformed_bbox.status_code == 422
    assert malformed_bbox.json()["code"] == 1001

    stale = client.get("/api/v1/resource/map", params={
        **query, "revision": "old", "bbox": "114,37,115,38"})
    assert stale.status_code == 409
    assert stale.json()["code"] == 1205

    missing_query = client.get("/api/v1/resource/map")
    assert missing_query.status_code == 422
    assert missing_query.json()["code"] == 1001
    assert missing_query.json()["data"]

    missing_node = client.get("/api/v1/resource/nodes/absent", params={"revision": revision})
    assert missing_node.status_code == 404
    assert missing_node.json()["code"] == 1002

    monkeypatch.delenv("SR4_INTEGRATION_DEMO", raising=False)
    disabled = client.get("/api/v1/integration/sr4/catalog")
    assert disabled.status_code == 403
    assert disabled.json()["code"] == 1101

    wrong_method = client.post("/api/v1/resource/context")
    assert wrong_method.status_code == 405
    assert wrong_method.json()["code"] == 1001
    assert client.get("/nonexistent").json() == {"detail": "Not Found"}


def test_click_save_task_contract_persists_revision(api):
    client, factory = api
    workspace = client.get(
        "/api/v1/resource/context", params={"context": "planning"}
    ).json()["data"]
    preset = client.get(
        "/api/v1/resource/param-presets", params={"context": "planning"}
    ).json()["data"]["items"][0]
    request_id = "frontend-save-request-1"
    task_id = "frontend-task-1"
    payload = {
        "context": "planning",
        "task_id": task_id,
        "expected_revision": None,
        "resource_revision": workspace["revision"],
        "request_id": request_id,
        "input": preset["defaults"],
    }
    response = client.put(
        f"/api/v1/task-inputs/{task_id}",
        headers={
            "X-Session-Id": frontend_integration.SESSION_ID,
            "X-CSRF-Token": frontend_integration.CSRF_TOKEN,
        },
        json=payload,
    )
    assert response.status_code == 200
    saved = response.json()["data"]
    assert saved["task_id"] == task_id
    assert saved["resource_revision"] == workspace["revision"]
    assert saved["input"] == preset["defaults"]
    assert saved["active_job_id"] is None

    with factory() as session:
        assert session.scalar(select(func.count()).select_from(
            task_input_models.PlanningTask)) == 1
        assert session.scalar(select(func.count()).select_from(
            task_input_models.PlanningTaskRevision)) == 1
        assert session.scalar(select(func.count()).select_from(
            task_input_models.PlanningOperationReceipt)) == 1


def test_validation_error_is_frontend_issue_array(api):
    client, _ = api
    response = client.put(
        "/api/v1/task-inputs/bad-task",
        json={"context": "planning", "task_id": "bad-task"},
    )
    assert response.status_code == 422
    issues = response.json()["data"]
    assert isinstance(issues, list) and issues
    assert set(issues[0]) == {"objectId", "field", "message"}
