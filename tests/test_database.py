"""数据库基础设施与健康检查测试。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = ROOT / "algorithm-service"
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app import database  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def reset_database_state(monkeypatch):
    """每项测试隔离全局 Engine 和环境变量。"""
    database.reset_database_state_for_tests()
    monkeypatch.delenv("DATABASE_URL", raising=False)
    yield
    database.reset_database_state_for_tests()


def test_engine_session_and_connection_check_use_memory_database(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite+pysqlite:///:memory:")
    engine = database.get_engine()
    assert database.check_database_connection(engine) == {
        "status": "ok",
        "dialect": "sqlite",
    }
    with database.get_session_factory()() as session:
        assert isinstance(session, Session)


def test_missing_database_url_does_not_break_regular_health():
    client = TestClient(app)
    assert client.get("/health").json() == {
        "code": 0,
        "message": "success",
        "data": {"status": "ok"},
    }

    response = client.get("/health/database")
    assert response.status_code == 503
    assert response.json() == {
        "code": 5001,
        "message": "DATABASE_URL 未配置",
        "data": {"status": "error"},
    }


def test_database_health_returns_dialect(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite+pysqlite:///:memory:")
    response = TestClient(app).get("/health/database")
    assert response.status_code == 200
    assert response.json() == {
        "code": 0,
        "message": "success",
        "data": {"status": "ok", "dialect": "sqlite"},
    }
