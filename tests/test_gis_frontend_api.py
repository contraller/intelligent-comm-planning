"""新版 GIS 只读目录与展示资料，使用项目实际构造资源。"""
from pathlib import Path
import sys

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app.main import app
from app import frontend_integration, gis_frontend_service, integration_identity_service


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    return TestClient(app)


@pytest.mark.parametrize("part", ["directory", "scene"])
def test_current_resource_projection(client, part):
    revision = frontend_integration.resource_revision()
    response = client.get("/api/v1/resource/gis-" + part, params={"context": "gis", "revision": revision})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["revision"] == revision and data["dataOrigin"] == "SYNTHETIC_INTEGRATION"
    nodes, devices = {row["node_id"] for row in data["nodes"]}, data["devices"]
    models = {row["model_id"] for row in data["models"]}
    assert len(nodes) == len(data["nodes"]) >= 100 and len(devices) >= 100
    assert all(row["node_id"] in nodes and row["model_id"] in models for row in devices)
    if part == "directory":
        assert "tx_power_dbm" not in devices[0]
    else:
        assert data["snapshotId"] == "GIS-RES-" + revision
        assert data["networkState"] == "missing" and "tx_power_dbm" in devices[0]
        assert all(isinstance(row[field], (float, int)) for row in data["models"]
                   for field in ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm"))


@pytest.mark.parametrize("part", ["directory", "scene"])
def test_invalid_context_revision_and_disabled_mode(client, monkeypatch, part):
    path = "/api/v1/resource/gis-" + part
    assert client.get(path, params={"revision": "stale"}).json()["code"] == 1205
    revision = frontend_integration.resource_revision()
    assert client.get(path, params={"revision": revision, "context": "planning"}).status_code == 422
    monkeypatch.delenv("FRONTEND_INTEGRATION_DEMO")
    assert client.get(path, params={"revision": revision}).status_code == 401


def test_read_does_not_create_database_or_algorithm_tasks(client, monkeypatch):
    before = frontend_integration.resource_revision()
    for part in ("directory", "scene"):
        assert client.get("/api/v1/resource/gis-" + part, params={"revision": before}).status_code == 200
    assert frontend_integration.resource_revision() == before
    def deny(*args, **kwargs):
        raise integration_identity_service.IdentityError("无 GIS 权限")
    monkeypatch.setattr(integration_identity_service, "require", deny)
    assert client.get("/api/v1/resource/gis-directory", params={"revision": before}).status_code == 403


def test_reject_mixed_resource_revision(monkeypatch):
    revisions = iter(("r1", "r2"))
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: next(revisions))
    with pytest.raises(gis_frontend_service.GisReadError) as error:
        gis_frontend_service.read("scene", "gis", "r1")
    assert error.value.code == 1205
