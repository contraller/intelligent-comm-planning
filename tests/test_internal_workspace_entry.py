"""隔离入口配置与资产边界；不启动服务，不连接原库。"""
import base64
import importlib.util
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def entry(monkeypatch, tmp_path):
    name = "r4_workspace_entry_fixture"
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/serve_internal_workspace.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    runtime = tmp_path / "data/runtime/r2/r4-test"
    database = tmp_path / "data/runtime/tmp/r4-test/workspace.sqlite"
    runtime.mkdir(parents=True)
    database.parent.mkdir(parents=True)
    database.write_bytes(b"entry-test-only-not-a-live-database")
    key_file = runtime / "private.json"
    key_file.write_text(json.dumps({"identity_request_key": base64.b64encode(b"k" * 32).decode()}),
                        encoding="utf-8")
    return module, runtime, database, key_file


def read(entry, **changes):
    module, runtime, database, key_file = entry
    values = dict(runtime_root=str(runtime), database_url="sqlite:///" + database.as_posix(),
                  key_file=str(key_file))
    values.update(changes)
    return module.read_workspace(**values)


def test_only_explicit_matching_new_workspace_is_accepted(entry):
    module, runtime, database, key_file = entry
    before = database.read_bytes()
    config = read(entry)
    assert config.runtime == runtime
    assert database.read_bytes() == before
    assert key_file.exists()
    assert module.HOST == "127.0.0.22"
    assert (module.API_PORT, module.FRONTEND_PORT) == (8122, 5322)


def test_coverage_profile_uses_another_fixed_pair_without_changing_r4_default(entry):
    module, *_ = entry
    config = read(entry)
    module.select_profile("coverage")
    env = module.workspace_environment(config)
    assert (module.HOST, module.API_PORT, module.FRONTEND_PORT) == ("127.0.0.23", 8123, 5323)
    assert env["VITE_BACKEND_PROXY_TARGET"] == "http://127.0.0.23:8123"
    assert env["LOCAL_IDENTITY_ALLOWED_ORIGINS"] == '["http://127.0.0.23:5323", "http://127.0.0.23:8123"]'
    assert env["INTERNAL_WORKSPACE_PROFILE"] == "coverage"
    module.select_profile("r4")
    assert (module.HOST, module.API_PORT, module.FRONTEND_PORT) == ("127.0.0.22", 8122, 5322)
    with pytest.raises(ValueError):
        module.select_profile("external")


def test_acceptance_profile_cannot_share_existing_runtime_ports(entry):
    module, *_ = entry
    module.select_profile("acceptance")
    environment = module.workspace_environment(read(entry))
    assert (module.HOST, module.API_PORT, module.FRONTEND_PORT) == ("127.0.0.24", 8124, 5324)
    assert environment["VITE_BACKEND_PROXY_TARGET"] == "http://127.0.0.24:8124"
    assert json.loads(environment["LOCAL_IDENTITY_ALLOWED_ORIGINS"]) == [
        "http://127.0.0.24:5324", "http://127.0.0.24:8124"]
    assert environment["INTERNAL_WORKSPACE_PROFILE"] == "acceptance"


@pytest.mark.parametrize("relative", ["data/runtime/r2.sqlite", "data/runtime/sr56_integration_20261023.sqlite",
    "data/runtime/tmp/not-r4/workspace.sqlite", "data/runtime/tmp/r4-other/workspace.sqlite"])
def test_rejects_old_or_unrelated_database(entry, relative):
    module, *_ = entry
    database = module.ROOT / relative
    database.parent.mkdir(parents=True, exist_ok=True)
    database.write_bytes(b"protected-fixture")
    with pytest.raises(ValueError, match="内部入口配置无效"):
        read(entry, database_url="sqlite:///" + database.as_posix())
    assert database.read_bytes() == b"protected-fixture"


@pytest.mark.parametrize("url", ["sqlite:///:memory:", "sqlite:///relative.sqlite",
    "postgresql://example.invalid/test", "sqlite:///missing.sqlite"])
def test_rejects_implicit_or_other_database_engine(entry, url):
    with pytest.raises(ValueError, match="内部入口配置无效"):
        read(entry, database_url=url)


def test_missing_database_is_not_created(entry):
    _, _, database, _ = entry
    missing = database.with_name("not-created.sqlite")
    with pytest.raises(ValueError, match="内部入口配置无效"):
        read(entry, database_url="sqlite:///" + missing.as_posix())
    assert not missing.exists()


@pytest.mark.parametrize("directory", ["data/runtime/r2", "data/runtime/r2/not-r4", "old_front/r4-test"])
def test_rejects_shared_runtime_or_old_frontend(entry, directory):
    module, *_ = entry
    path = module.ROOT / directory
    path.mkdir(parents=True, exist_ok=True)
    with pytest.raises(ValueError, match="内部入口配置无效"):
        read(entry, runtime_root=str(path))


@pytest.mark.parametrize("value", [{}, [], {"identity_request_key": "invalid"},
    {"identity_request_key": base64.b64encode(b"short").decode()}])
def test_invalid_secret_is_rejected_without_echo(entry, value):
    *_, key_file = entry
    key_file.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError, match="^内部入口配置无效") as error:
        read(entry)
    assert "invalid" not in str(error.value)


def test_secret_cannot_be_loaded_outside_own_runtime(entry):
    module, *_ = entry
    outside = module.ROOT / "private.json"
    outside.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError):
        read(entry, key_file=str(outside))


def test_direct_factory_cannot_bypass_cli_or_reuse_ambient_configuration(entry):
    module, *_ = entry
    with pytest.raises(RuntimeError, match="未连接数据库"):
        module.create_workspace_app()
    with pytest.raises(RuntimeError, match="未连接数据库"):
        module.create_workspace_app(read(entry))


def test_environment_keeps_all_stores_in_own_runtime_and_demo_off(entry):
    module, runtime, *_ = entry
    before = dict(module.os.environ)
    environment = module.workspace_environment(read(entry))
    assert dict(module.os.environ) == before
    assert environment["AUTH_MODE"] == "LOCAL_PASSWORD"
    assert environment["FRONTEND_INTEGRATION_DEMO"] == "0"
    assert environment["SR4_INTEGRATION_DEMO"] == "0"
    for name in ("INTERFERENCE_RUNTIME_DIR", "FROZEN_COVERAGE_RUNTIME_DIR", "COVERAGE_CACHE_DIR", "COVERAGE_TASK_DIR", "ALGORITHM_TASK_DIR",
                 "SR4_PLAN_DIR", "SR4_SNAPSHOT_DIR", "SR5_STORE_PATH", "SR5_REPORT_DIR", "SR6_STORE_PATH",
                 "TEMP", "TMP"):
        assert Path(environment[name]).is_relative_to(runtime)
    assert json.loads(environment["LOCAL_IDENTITY_ALLOWED_ORIGINS"]) == [
        "http://127.0.0.22:5322", "http://127.0.0.22:8122"]


def test_frontend_uses_current_sources_and_strict_same_origin_map_proxy():
    source = (ROOT / "scripts/internal_workspace_frontend.mjs").read_text(encoding="utf-8")
    assert "radio-planning-20261022" in source
    assert "old_front/" not in source
    assert "createServer" in source and "strictPort: true" in source
    assert "'/maps'" in source and "'/fonts'" in source
    assert "publicDir: false" in source
    assert "cacheDir: path.join(runtime" in source
    assert "copyFile" not in source and "build(" not in source


def test_interrupted_manual_probe_cannot_record_success(entry, monkeypatch):
    module, runtime, _, key_file = entry
    config = read(entry)
    (runtime / "workspace.json").write_text(json.dumps({"database_url": config.database_url,
        "key_file": str(key_file)}), encoding="utf-8")
    spec = importlib.util.spec_from_file_location("r4_manual_probe_fixture", ROOT / "tests/manual/r4_internal_http.py")
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    monkeypatch.setitem(sys.modules, "serve_internal_workspace", module)
    monkeypatch.setattr(sys, "argv", ["r4_internal_http.py", "knowledge", "--runtime-root", str(runtime)])

    def interrupted(_runtime, _private, records):
        records.append({"passed": True})
        raise KeyboardInterrupt()

    monkeypatch.setattr(probe, "knowledge", interrupted)
    with pytest.raises(KeyboardInterrupt):
        probe.main()
    evidence = [json.loads(path.read_text(encoding="utf-8")) for path in runtime.glob("knowledge-http-*.json")]
    assert len(evidence) == 1
    assert evidence[0]["completed"] is False
    assert evidence[0]["all_requests_passed"] is False
    assert evidence[0]["error"]["type"] == "KeyboardInterrupt"
