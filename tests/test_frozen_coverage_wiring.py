"""覆盖服务入口装配桩；真实缓存、身份与DEM证据另行记录。"""
from pathlib import Path
from types import SimpleNamespace
import sys

from fastapi import Response
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "algorithm-service"))
from app import main, frozen_coverage_service


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("INTERFERENCE_WORKBENCH_ENABLED", "0")
    monkeypatch.setenv("FROZEN_COVERAGE_ENABLED", "0")
    monkeypatch.delenv("FROZEN_COVERAGE_RUNTIME_DIR", raising=False)
    monkeypatch.setattr(main.resource_dataset, "database_mode", lambda: True)
    monkeypatch.setattr(main, "get_session_factory", lambda: "explicit-factory")
    return SimpleNamespace(state=SimpleNamespace()), tmp_path


@pytest.mark.anyio
async def test_disabled_does_not_construct_service(isolated, monkeypatch):
    app, _ = isolated
    def denied(**kwargs):
        pytest.fail("默认关闭不能创建目录或服务")
    monkeypatch.setattr(frozen_coverage_service, "create_frozen_coverage_service", denied)
    async with main.application_lifespan(app):
        assert app.state.frozen_coverage is None


@pytest.mark.anyio
async def test_explicit_service_start_and_close(isolated, monkeypatch):
    app, path = isolated
    calls = []
    service = SimpleNamespace(start=lambda: calls.append("start"),
        close=lambda **kwargs: calls.append(("close", kwargs)))
    def factory(**kwargs):
        assert kwargs == {"runtime_root": str(path), "session_factory": "explicit-factory"}
        return service
    monkeypatch.setenv("FROZEN_COVERAGE_ENABLED", "1")
    monkeypatch.setenv("FROZEN_COVERAGE_RUNTIME_DIR", str(path))
    monkeypatch.setattr(frozen_coverage_service, "create_frozen_coverage_service", factory)
    async with main.application_lifespan(app):
        assert app.state.frozen_coverage is service
        assert calls == ["start"]
    assert calls == ["start", ("close", {"timeout": 10.0})]


@pytest.mark.anyio
@pytest.mark.parametrize("directory", [None, "relative/path"])
async def test_enabled_rejects_implicit_or_relative_directory(isolated, monkeypatch, directory):
    app, _ = isolated
    monkeypatch.setenv("FROZEN_COVERAGE_ENABLED", "1")
    if directory is not None:
        monkeypatch.setenv("FROZEN_COVERAGE_RUNTIME_DIR", directory)
    with pytest.raises(RuntimeError, match="显式绝对运行目录"):
        async with main.application_lifespan(app):
            pytest.fail("无效配置不得进入服务")


@pytest.mark.anyio
async def test_start_failure_still_closes_partial_service(isolated, monkeypatch):
    app, path = isolated
    calls = []
    def fail():
        raise RuntimeError("test-start")
    service = SimpleNamespace(start=fail, close=lambda **kw: calls.append(kw))
    monkeypatch.setenv("FROZEN_COVERAGE_ENABLED", "1")
    monkeypatch.setenv("FROZEN_COVERAGE_RUNTIME_DIR", str(path))
    monkeypatch.setattr(frozen_coverage_service, "create_frozen_coverage_service", lambda **kw: service)
    with pytest.raises(RuntimeError, match="test-start"):
        async with main.application_lifespan(app):
            pass
    assert calls == [{"timeout": 10.0}]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def test_routes_registered_once():
    # FastAPI延迟装配include_router；从实际OpenAPI核对完整路径及方法。
    paths = {path: set(methods) for path, methods in main.app.openapi()["paths"].items()
             if path.startswith("/api/v1/planning-coverages")}
    assert paths == {
        "/api/v1/planning-coverages/jobs/{job_id}": {"get"},
        "/api/v1/planning-coverages/jobs/{job_id}/cancel": {"post"},
        "/api/v1/planning-coverages/{plan_id}/compute": {"post"},
        "/api/v1/planning-coverages/{plan_id}/cache": {"get"},
    }


@pytest.mark.parametrize("status,expected", [("running", 200), ("failed", 503), ("disabled", 200)])
def test_health_reports_both_modules(monkeypatch, status, expected):
    monkeypatch.setattr(main.app.state, "interference_worker", None, raising=False)
    monkeypatch.setattr(main.app.state, "frozen_coverage", SimpleNamespace(status=lambda: {"state": status}), raising=False)
    response = Response()
    result = main.worker_health(response)
    assert response.status_code == expected
    assert result["data"] == {"interference": "disabled", "frozen_coverage": status}
