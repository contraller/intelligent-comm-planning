"""防止交付入口重新依赖归档前端；不运行或维护归档代码。"""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def delivery_module():
    spec = importlib.util.spec_from_file_location("delivery_boundary", ROOT / "scripts/serve_delivery.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_latest_frontend_is_only_delivery_path():
    module = delivery_module()
    assert module.FRONTEND_DIST == ROOT / "front_design/radio-planning-20261022/dist"
    assert (ROOT / "old_front/README.md").is_file()
    assert not (ROOT / "front_design/radio-planning").exists()
    assert not (ROOT / "scripts/gen_w1w3_demo.py").exists()
    pipeline = (ROOT / "scripts/update_replacement_demo.py").read_text(encoding="utf-8")
    assert "gen_w1w3_demo.py" not in pipeline


def test_delivery_refuses_missing_database(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        delivery_module().create_delivery_app()


@pytest.mark.parametrize("url", ["sqlite:///:memory:", "sqlite:///relative.sqlite", "sqlite:///F:/work/project2026-1/data/runtime/not-created-by-delivery.sqlite"])
def test_delivery_refuses_implicit_or_missing_sqlite(monkeypatch, url):
    monkeypatch.setenv("DATABASE_URL", url)
    with pytest.raises(RuntimeError, match="已存在数据库"):
        delivery_module().create_delivery_app()


def test_active_backend_has_no_legacy_frontend_dependency():
    forbidden = ("front_design/radio-planning/", "front_design\\radio-planning\\", "W1-W3算法演示.html", "gen_w1w3_demo", "old_front/")
    for path in (ROOT / "algorithm-service/app").rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        assert not any(value in source for value in forbidden), str(path)
