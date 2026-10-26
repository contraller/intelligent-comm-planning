"""独立联调身份及失效、越权验证。"""
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import database, fault, fault_frontend_service as sr5, fault_plan_source, frontend_integration, integration_identity_service as identities, kg, kg_frontend_service as sr6, kg_workflow_service, planning_w3
from app.main import app
from app.database import Base


def headers(client):
    value = client.get("/api/v1/auth/csrf").json()["data"]
    return {"X-Session-Id": value["session_id"], "X-CSRF-Token": value["csrf_token"]}


def switch(client, account):
    response = client.post("/api/v1/auth/integration/switch", json={"accountId": account}, headers=headers(client))
    assert response.status_code == 200, response.text
    return response.json()["data"]


@pytest.fixture
def workflow_api(monkeypatch, tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "workflow.sqlite"), connect_args={"timeout": 30})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
    for module in (database, fault, sr5, fault_plan_source, identities, sr6, kg_workflow_service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "resource-v1")
    monkeypatch.setattr(planning_w3, "TASK_DIR", tmp_path / "tasks")
    monkeypatch.setattr(fault, "REPORT_DIR", tmp_path / "reports")
    monkeypatch.setattr(fault, "_ENGINE", None)
    monkeypatch.setattr(kg, "STORE_PATH", tmp_path / "kg.json")
    monkeypatch.setattr(kg, "_GRAPH", None)
    monkeypatch.setattr(kg, "_STATE", None)
    with TestClient(app) as client:
        yield client, factory
    engine.dispose()


def test_distinct_identities_csrf_and_disabled_mode(workflow_api, monkeypatch):
    client, _ = workflow_api
    identity = client.get("/api/v1/auth/session").json()["data"]
    assert identity["account_id"] == "integration-planner"
    assert client.get("/api/v1/fault/workbench").status_code == 403
    assert client.post("/api/v1/auth/integration/switch", json={"accountId": "integration-editor"}).status_code == 409
    editor = switch(client, "integration-editor")
    assert "knowledge.edit" in editor["permissions"] and "knowledge.review" not in editor["permissions"]
    stale = headers(client)
    reviewer = switch(client, "integration-reviewer")
    assert "knowledge.review" in reviewer["permissions"] and "knowledge.edit" not in reviewer["permissions"]
    assert editor["session_id"] != reviewer["session_id"]
    assert client.post("/api/v1/auth/integration/switch", headers=stale, json={"accountId": "integration-editor"}).status_code == 409
    assert client.post("/api/v1/auth/integration/switch", headers={**headers(client), "X-CSRF-Token": "wrong"}, json={"accountId": "integration-editor"}).status_code == 403
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    assert client.get("/api/v1/auth/integration/identities").status_code == 401
    assert client.get("/api/v1/kg/workbench").status_code == 401


def test_legacy_writes_cannot_bypass_workbench_permissions(workflow_api):
    client, _ = workflow_api
    switch(client, "integration-editor")
    response = client.post("/api/v1/kg/changes", headers=headers(client), json={"actor": "someone-else"})
    assert response.status_code == 403
    assert "工作区" in response.json()["message"]
