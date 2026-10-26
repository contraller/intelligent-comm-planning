"""便携控制入口的边界测试；不连接开发服务或现有数据库。"""
import importlib.util
import json
from pathlib import Path
import socket
import threading
import os
import shutil
import subprocess

import pytest

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location("portable_" + name, HERE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("name", ("../x", "/root", "C:/x", "a/../../x", "a\\..\\x"))
def test_archive_paths_cannot_escape(name):
    assert not load("build_portable").safe_member(name)


def test_valid_archive_path():
    assert load("build_portable").safe_member("Lib/site-packages/a/__init__.py")


def test_state_from_other_directory_is_never_controlled(tmp_path, monkeypatch):
    entry = load("launcher")
    path = tmp_path / "state.json"
    path.write_text(json.dumps({"root": "F:/another-package", "port": 18480, "state": "RUNNING"}), encoding="utf-8")
    monkeypatch.setattr(entry, "STATE", path)
    assert entry.read_state() is None


def test_existing_database_cannot_be_reinitialized_without_key(tmp_path, monkeypatch):
    entry = load("launcher")
    monkeypatch.setattr(entry, "DATA", tmp_path)
    (tmp_path / "r2.sqlite").write_bytes(b"keep-existing")
    with pytest.raises(RuntimeError, match="不会重置"):
        entry.settings()
    assert (tmp_path / "r2.sqlite").read_bytes() == b"keep-existing"
    assert not (tmp_path / "settings.json").exists()


def test_settings_restart_preserves_key_and_accounts(tmp_path, monkeypatch):
    entry = load("launcher")
    monkeypatch.setattr(entry, "DATA", tmp_path)
    first = entry.settings()
    assert first == entry.settings()
    assert len({x["password"] for x in first["accounts"].values()}) == 3
    assert (tmp_path / "首次登录账号.txt").exists()


def test_busy_port_is_not_reused_or_terminated():
    entry = load("launcher")
    with socket.socket() as occupied:
        occupied.bind(("127.0.0.1", 0))
        occupied.listen()
        port = occupied.getsockname()[1]
        listener, chosen = entry.bind_listener(port)
        try:
            assert chosen > port
            assert occupied.fileno() >= 0
        finally:
            listener.close()


def test_configuration_does_not_use_developer_database(tmp_path, monkeypatch):
    entry = load("launcher")
    monkeypatch.setattr(entry, "DATA", tmp_path)
    monkeypatch.setenv("DATABASE_URL", "sqlite:///F:/private/developer.sqlite")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    monkeypatch.setenv("SR5_REPORT_DIR", "F:/private/reports")
    original = list(entry.sys.path)
    try:
        entry.configure(18481, "a-test-key")
        assert entry.os.environ["DATABASE_URL"] == "sqlite:///" + (tmp_path / "r2.sqlite").as_posix()
        assert "FRONTEND_INTEGRATION_DEMO" not in entry.os.environ
        assert entry.os.environ["SR5_REPORT_DIR"] == str(tmp_path / "r2/portable/reports")
        assert entry.os.environ["AUTH_MODE"] == "LOCAL_PASSWORD"
    finally:
        entry.sys.path[:] = original


def test_missing_initialized_database_cannot_create_new_database(tmp_path, monkeypatch):
    entry = load("launcher")
    monkeypatch.setattr(entry, "DATA", tmp_path)
    (tmp_path / "initialized.json").write_text("{}", encoding="utf-8")
    with pytest.raises(RuntimeError, match="数据库缺失"):
        entry.initialize({})
    assert not (tmp_path / "r2.sqlite").exists()


@pytest.mark.parametrize("module", ("app.planning_w3", "app.coverage", "app.deployment"))
def test_running_algorithm_thread_is_not_treated_as_stopped(module):
    entry = load("launcher")
    released = threading.Event()

    def worker():
        released.wait(5)

    worker.__module__ = module
    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    try:
        assert thread in entry.active_algorithm_threads()
    finally:
        released.set()
        thread.join(2)
    assert thread not in entry.active_algorithm_threads()


@pytest.mark.parametrize("name", ("启动系统.cmd", "停止系统.cmd"))
@pytest.mark.skipif(os.name != "nt", reason="Windows 桌面入口")
def test_batch_preserves_failure_code_without_runtime(tmp_path, name):
    entry = tmp_path / name
    shutil.copy2(HERE / name, entry)
    result = subprocess.run([os.environ["COMSPEC"], "/d", "/c", str(entry)], cwd=tmp_path,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
        creationflags=subprocess.CREATE_NO_WINDOW)
    assert result.returncode != 0
