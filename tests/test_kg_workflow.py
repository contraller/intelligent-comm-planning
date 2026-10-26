"""SR6 四步工作流的数据库与 HTTP 契约。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import database, kg, kg_models  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    database.reset_database_state_for_tests()
    monkeypatch.setenv("DATABASE_URL", "sqlite+pysqlite:///" + str(tmp_path / "workflow.sqlite"))
    database.Base.metadata.create_all(database.get_engine())
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "old_graph.json")
    with TestClient(app) as api:
        yield api
    database.reset_database_state_for_tests()


def _ops():
    return [{"op": "add_triple", "head_type": "DeviceModel", "head": "DM-0001",
             "relation": "hasFunction", "tail_type": "Function", "tail": "工作流测试功能",
             "source": "test_kg_workflow.py [CONSTRUCTED]"}]


def _draft(client, request_id="save-1"):
    return client.post("/api/v1/kg/changes", json={
        "request_id": request_id, "actor": "editor", "base_revision": 1,
        "base_version": 1, "note": "补充设备功能", "ops": _ops()})


def test_four_steps_only_publish_changes_current_graph(client):
    before = client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"]
    versions = client.get("/api/v1/kg/versions")
    assert versions.status_code == 200
    assert versions.json()["data"]["items"][0]["triples"] == before
    saved = _draft(client)
    assert saved.status_code == 200
    change_id = saved.json()["data"]["change_id"]
    assert saved.json()["data"]["status"] == "DRAFT"
    assert _draft(client).json() == saved.json()
    assert _draft(client, "save-conflict").status_code == 409

    submitted = client.post(f"/api/v1/kg/changes/{change_id}/submit", json={
        "request_id": "submit-1", "actor": "editor", "base_revision": 2,
        "revision": 1})
    assert submitted.json()["data"]["status"] == "PENDING"
    assert client.post(f"/api/v1/kg/changes/{change_id}/review", json={
        "request_id": "self-review", "actor": "editor", "base_revision": 3,
        "revision": 1, "submission": 1, "approved": True}).status_code == 403
    approved = client.post(f"/api/v1/kg/changes/{change_id}/review", json={
        "request_id": "review-1", "actor": "reviewer", "base_revision": 3,
        "revision": 1, "submission": 1, "approved": True})
    assert approved.json()["data"]["status"] == "APPROVED"
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before

    published = client.post(f"/api/v1/kg/changes/{change_id}/publish", json={
        "request_id": "publish-1", "actor": "publisher", "base_revision": 4,
        "revision": 1})
    assert published.json()["data"]["version"] == 2
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before + 1
    assert client.get("/api/v1/kg/versions/1/snapshot").json()["data"]["version"] == 1
    assert client.get("/api/v1/kg/versions/2/snapshot").json()["data"]["version"] == 2
    versions = client.get("/api/v1/kg/versions").json()["data"]["items"]
    assert [item["version"] for item in versions] == [1, 2]
    assert versions[-1]["triples"] == before + 1
    assert client.get("/api/v1/kg/workspace").json()["data"]["current_version"] == 2
    kg._GRAPH = None
    kg._STATE = None
    assert client.get("/api/v1/kg/stats").json()["data"]["graph"]["triples"] == before + 1
    database.reset_database_state_for_tests()
    kg._GRAPH = None
    assert _draft(client).json() == saved.json()
    assert client.get("/api/v1/kg/workspace").json()["data"]["current_version"] == 2


def test_withdraw_and_review_rejection_preserve_history(client):
    change_id = _draft(client).json()["data"]["change_id"]
    url = f"/api/v1/kg/changes/{change_id}"
    assert client.post(url + "/submit", json={
        "request_id": "submit-1", "actor": "editor", "revision": 1}).status_code == 200
    assert client.post(url + "/withdraw", json={
        "request_id": "withdraw-1", "actor": "editor", "revision": 1}).json()["data"]["status"] == "DRAFT"
    assert client.post(url + "/submit", json={
        "request_id": "submit-2", "actor": "editor", "revision": 1}).status_code == 200
    rejected = client.post(url + "/review", json={
        "request_id": "review-2", "actor": "reviewer", "revision": 1,
        "submission": 2, "approved": False, "opinion": "来源未核实"})
    assert rejected.json()["data"]["status"] == "REJECTED"
    assert client.post(url + "/publish", json={
        "request_id": "publish-rejected", "actor": "publisher", "revision": 1}).status_code == 409
    row = client.get("/api/v1/kg/workspace").json()["data"]["changes"][0]
    assert [item["outcome"] for item in row["submissions"]] == ["WITHDRAWN", "REJECTED"]
    revised = client.put(url, json={"request_id": "revise-1", "actor": "editor",
        "revision": 1, "note": "补充来源后重提", "ops": _ops()})
    assert revised.json()["data"]["status"] == "DRAFT"
    assert revised.json()["data"]["revision"] == 2
    assert client.post(url + "/submit", json={
        "request_id": "submit-3", "actor": "editor", "revision": 2}).json()["data"]["status"] == "PENDING"


def test_rollback_creates_new_version_without_mutating_old_snapshot(client):
    before = client.get("/api/v1/kg/versions/1/snapshot").json()["data"]["snapshot"]
    change_id = _draft(client).json()["data"]["change_id"]
    client.post(f"/api/v1/kg/changes/{change_id}/submit", json={
        "request_id": "submit-1", "actor": "editor", "revision": 1})
    client.post(f"/api/v1/kg/changes/{change_id}/review", json={
        "request_id": "review-1", "actor": "reviewer", "revision": 1,
        "submission": 1, "approved": True})
    client.post(f"/api/v1/kg/changes/{change_id}/publish", json={
        "request_id": "publish-1", "actor": "publisher", "revision": 1})
    rolled = client.post("/api/v1/kg/versions/1/rollback", json={
        "reviewer": "reviewer", "reason": "恢复基线", "current_version": 2})
    assert rolled.json()["data"]["version"] == 3
    assert client.get("/api/v1/kg/versions/3/snapshot").json()["data"]["snapshot"] == before
    assert client.get("/api/v1/kg/versions/2/snapshot").json()["data"]["version"] == 2
    assert [item["version"] for item in client.get(
        "/api/v1/kg/versions").json()["data"]["items"]] == [1, 2, 3]


def test_invalid_draft_body_uses_api_error_envelope(client):
    response = client.post("/api/v1/kg/changes", json={})
    assert response.status_code == 422
    assert response.json()["code"] == 1001
    assert response.json()["data"]
    assert "detail" not in response.json()


def test_invalid_legacy_file_does_not_initialize_database(client):
    kg.STORE_PATH.write_text("{invalid", encoding="utf-8")
    response = client.get("/api/v1/kg/workspace")
    assert response.status_code == 503
    assert response.json()["code"] == 5003
    with database.get_session_factory()() as session:
        assert session.get(kg_models.KgWorkspace, 1) is None
    assert kg.STORE_PATH.read_text(encoding="utf-8") == "{invalid"


def test_entity_metadata_requires_source_and_cannot_change_link_threshold(client):
    client.get("/api/v1/kg/workspace")
    payload = {"request_id": "entity-1", "actor": "editor", "note": "设备说明",
               "ops": [{"op": "upsert_entity", "entity_type": "Function",
                        "name": "人工补充的设备功能", "attrs": {"description": "维护说明"},
                        "source": "test_kg_workflow.py [CONSTRUCTED]"}]}
    result = client.post("/api/v1/kg/changes", json=payload)
    assert result.json()["data"]["status"] == "DRAFT"
    invalid = client.post("/api/v1/kg/changes", json={**payload,
        "request_id": "entity-2", "ops": [{**payload["ops"][0],
            "attrs": {"threshold": 100}}]})
    assert invalid.status_code == 422
    assert invalid.json()["code"] == 1001
