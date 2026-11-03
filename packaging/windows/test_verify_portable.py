"""便携验收器的新模式契约；全部HTTP/启停为隔离替身，不连接现用端口。"""
import importlib.util
import json
from pathlib import Path
import subprocess

import httpx
import pytest

HERE = Path(__file__).resolve().parent
BASE = "http://127.0.0.1:18481"
PERMISSIONS = ["situation.view", "resources.view", "planning.view", "diagnosis.view", "knowledge.view",
               "knowledge.edit", "knowledge.review", "knowledge.publish", "knowledge.rollback",
               "system.view", "system.accounts", "system.roles", "system.parameters", "system.logs"]


def load(monkeypatch):
    monkeypatch.syspath_prepend(str(HERE))
    spec = importlib.util.spec_from_file_location("verify_portable_contract", HERE / "verify_portable.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def identity():
    return {"account_id": "local-test-user", "session_id": "test-session", "auth_source": "LOCAL_SINGLE_USER",
            "single_user_mode": True, "allow_self_review": True, "integration_mode": False,
            "data_origin": "FORMAL_VERIFIED", "permissions": list(PERMISSIONS)}


def capabilities():
    return {"authMode": "LOCAL_SINGLE_USER", "initialized": True, "passwordChangeRequired": False,
            "capabilities": {"passwordMaintenance": False, "automaticLocalSession": True,
                             "unifiedPermissions": True, "selfReview": True}}


def reply(data, status=200, code=0, **kwargs):
    return httpx.Response(status, json={"code": code, "data": data}, **kwargs)


@pytest.mark.parametrize("failure", [None, "password-mode", "self-review", "partial-permissions", "duplicate-permissions", "no-cookie", "integration"])
def test_unified_session_requires_real_cookie_source_and_all_registered_permissions(monkeypatch, failure):
    verifier = load(monkeypatch)
    seen = []

    def respond(request):
        seen.append((request.method, request.url.path))
        if request.url.path.endswith("/capabilities"):
            value = capabilities()
            if failure == "password-mode":
                value["authMode"] = "LOCAL_PASSWORD"
            return reply(value)
        if request.url.path.endswith("/session"):
            value = identity()
            if failure == "self-review":
                value["allow_self_review"] = False
            if failure == "partial-permissions":
                value["permissions"] = value["permissions"][:-1]
            if failure == "duplicate-permissions":
                value["permissions"].append(PERMISSIONS[0])
            if failure == "integration":
                value["integration_mode"] = True
            return reply(value, headers={} if failure == "no-cookie" else {
                "Set-Cookie": "radio_local_session=fixture-cookie; Path=/; HttpOnly; SameSite=strict"})
        if request.url.path.endswith("/options"):
            return reply({"permissions": [{"code": code} for code in PERMISSIONS]})
        pytest.fail("不允许验收器调用密码登录、改密或其它接口")

    with httpx.Client(base_url=BASE, transport=httpx.MockTransport(respond)) as client:
        if failure:
            with pytest.raises(AssertionError):
                verifier.verify_unified_session(client)
        else:
            assert verifier.verify_unified_session(client)["account_id"] == "local-test-user"
    assert all(method == "GET" for method, _ in seen)
    assert not any(path.endswith(("/login", "/password")) for _, path in seen)


def test_existing_runtime_is_rejected_before_static_process_or_http_operations(tmp_path, monkeypatch):
    verifier = load(monkeypatch)
    target = tmp_path / "existing-portable"
    data = target / "app/data/runtime"
    data.mkdir(parents=True)
    preserved = data / "settings.json"
    preserved.write_bytes(b"preserve-existing-runtime")

    def forbidden(*args, **kwargs):
        pytest.fail("已有运行目录必须在任何服务或HTTP操作前拒绝")

    monkeypatch.setattr(verifier.subprocess, "run", forbidden)
    monkeypatch.setattr(verifier.httpx, "Client", forbidden)
    monkeypatch.setattr(verifier, "check_frontend_assets", forbidden)
    with pytest.raises(RuntimeError, match="未启动的独立解压副本"):
        verifier.verify(target, tmp_path / "must-not-write.json")
    assert preserved.read_bytes() == b"preserve-existing-runtime"
    assert not (tmp_path / "must-not-write.json").exists()


@pytest.mark.parametrize("preferred_already_busy", [False, True])
def test_complete_verifier_uses_automatic_session_and_never_changes_passwords(tmp_path, monkeypatch, preferred_already_busy):
    verifier = load(monkeypatch)
    target = tmp_path / "fresh-portable"
    dist = target / "app/front_design/radio-planning-20261022/dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text('<script type="module" src="./main.js"></script>', encoding="utf-8")
    (dist / "main.js").write_text("export const ready=true;", encoding="utf-8")
    data = target / "app/data/runtime"
    output = tmp_path / "verification.json"
    state = {"running": False, "pid": 1000, "instance": 0, "parameter": 30, "revision": 1}
    requests = []
    actions = []
    original_client = httpx.Client
    monkeypatch.setenv("DATABASE_URL", "original-development-value")

    class ReservedSocket:
        def __init__(self):
            self.closed = False
        def setsockopt(self, *args):
            pass
        def bind(self, address):
            assert address == ("127.0.0.1", 18480)
            if preferred_already_busy:
                raise OSError("fixture: preferred port unavailable")
        def listen(self):
            pass
        def fileno(self):
            return -1 if self.closed else 42
        def close(self):
            self.closed = True

    monkeypatch.setattr(verifier.socket, "socket", ReservedSocket)

    def run(arguments, **kwargs):
        assert arguments[0] == str(target / "runtime/python/python.exe")
        assert kwargs["cwd"] == target
        action = arguments[3]
        actions.append(action)
        data.mkdir(parents=True, exist_ok=True)
        settings = data / "settings.json"
        if not settings.exists():
            settings.write_bytes(b'{"request_key":"fixture-preserved-key","accounts":{"original":"unchanged"}}')
        if action == "start" and not state["running"]:
            state.update(running=True, pid=state["pid"]+1, instance=state["instance"]+1)
        elif action == "stop":
            state["running"] = False
        current = {"root": str(target), "port": 18481, "pid": state["pid"], "token": "fixture-control",
                   "instance": str(state["instance"]), "state": "RUNNING" if state["running"] else "STOPPED"}
        (data / "service.json").write_text(json.dumps(current), encoding="utf-8")
        (data / "访问地址.txt").write_text(BASE+"/?v=reload-"+"a"*24+"#/situation\n", encoding="utf-8")
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(verifier.subprocess, "run", run)

    def respond(request):
        path = request.url.path
        requests.append((request.method, path))
        assert request.url.port == 18481
        if path == "/":
            return httpx.Response(200, content=(dist / "index.html").read_bytes(), headers={"content-type": "text/html", "cache-control": "no-store, no-cache"})
        if path == "/main.js":
            return httpx.Response(200, text="fixture", headers={"content-type": "text/javascript"})
        if path == "/__portable/status":
            assert request.headers["X-Portable-Token"] == "fixture-control"
            return httpx.Response(200, json={"instance": str(state["instance"])})
        if path == "/__portable/stop":
            return httpx.Response(403, json={"error": "forbidden"})
        if path == "/health":
            return reply({"status": "ok"})
        if path == "/health/workers":
            return reply({"interference": "running", "frozen_coverage": "running"})
        if path == "/maps/sr4-terrain.png":
            return httpx.Response(200, content=b"\x89PNG\r\n\x1a\nfixture")
        if path in ("/maps/sr4-terrain.json", "/maps/demo-roads-tiles/manifest.json"):
            return httpx.Response(200, json={})
        if path.endswith("/auth/capabilities"):
            return reply(capabilities())
        if path.endswith("/auth/session"):
            return reply(identity(), headers={"Set-Cookie": "radio_local_session=fixture-cookie; Path=/; HttpOnly; SameSite=strict"})
        if path.endswith("/auth/csrf"):
            return reply({"csrf_token": "fixture-csrf", "session_id": "test-session"})
        if path.endswith("/system/options"):
            return reply({"revision": "SYS-"+str(state["revision"]), "permissions": [{"code": code} for code in PERMISSIONS]})
        if path.endswith("/system/parameters/PAR-01") and request.method == "PUT":
            if request.headers.get("Origin") != BASE:
                return reply(None, 403, 1105)
            if request.headers.get("X-Session-Id") != "test-session":
                return reply(None, 409, 1106)
            if request.headers.get("X-CSRF-Token") != "fixture-csrf":
                return reply(None, 403, 1105)
            body = json.loads(request.content)
            state["parameter"], state["revision"] = body["value"], state["revision"]+1
            return reply({"changed": True})
        if path.endswith("/system/parameters"):
            return reply({"items": [{"id": "PAR-01", "value": state["parameter"]}]})
        if path.endswith("/resource/context"):
            return reply({"revision": "frozen-resource-revision"})
        if path.endswith("/kg/workbench"):
            return reply({"workspace": {"currentVersionId": "KGV-1"}})
        if path.endswith("/fault/workbench"):
            return reply({})
        pytest.fail("验收器请求了未授权的接口："+path)

    monkeypatch.setattr(verifier.httpx, "Client", lambda **kwargs: original_client(transport=httpx.MockTransport(respond), **kwargs))
    verifier.verify(target, output)
    evidence = json.loads(output.read_text(encoding="utf-8"))
    assert len(evidence["cases"]) == 9 and all(row["passed"] for row in evidence["cases"])
    assert "LOCAL_UNIFIED_AUTOMATIC_SESSION_FULL_PERMISSIONS_RESOURCE_SR5_SR6" in {row["case"] for row in evidence["cases"]}
    assert not any(path.endswith(("/auth/login", "/auth/password")) for _, path in requests)
    assert (data / "settings.json").read_bytes() == b'{"request_key":"fixture-preserved-key","accounts":{"original":"unchanged"}}'
    assert state["parameter"] == 31 and not state["running"]
    assert actions == ["start", "start", "stop", "start", "stop", "stop"]
    assert verifier.os.environ["DATABASE_URL"] == "original-development-value"
