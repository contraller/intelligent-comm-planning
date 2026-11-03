"""对已解压便携包进行串行 HTTP 验收；只使用该包新建库。"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.parse import parse_qs, quote, urlsplit

import httpx

from launcher import check_frontend_assets, controlled_frontend_version


def verify_start_url(root, state):
    url = (root / "app/data/runtime/访问地址.txt").read_text(encoding="utf-8").strip()
    parsed = urlsplit(url)
    assert parsed.scheme == "http" and parsed.netloc == f"127.0.0.1:{state['port']}"
    assert parsed.path == "/" and parsed.fragment == "/situation"
    query = parse_qs(parsed.query, keep_blank_values=True)
    assert set(query) == {"v"} and len(query["v"]) == 1
    expected = controlled_frontend_version(root)
    if expected is not None:
        assert query["v"][0] == expected
    else:
        import re
        assert re.fullmatch(r"reload-[0-9a-f]{24}", query["v"][0])
    return url


def _data(response):
    assert response.status_code == 200, f"HTTP验收请求失败：{response.status_code}"
    value = response.json()
    assert value.get("code") == 0, f"HTTP验收业务失败：{value.get('code')}"
    return value["data"]


def verify_unified_session(client):
    """服务端签发真实自动会话，并提供已登记全部权限；不密码登录或更改账号。"""
    capabilities = _data(client.get("/api/v1/auth/capabilities"))
    assert capabilities["authMode"] == "LOCAL_SINGLE_USER" and capabilities["initialized"] is True
    assert capabilities["passwordChangeRequired"] is False
    assert capabilities["capabilities"]["passwordMaintenance"] is False
    assert all(capabilities["capabilities"].get(key) is True
               for key in ("automaticLocalSession", "unifiedPermissions", "selfReview"))
    response = client.get("/api/v1/auth/session")
    identity = _data(response)
    assert identity["auth_source"] == "LOCAL_SINGLE_USER" and identity["single_user_mode"] is True
    assert identity["allow_self_review"] is True and identity["integration_mode"] is False
    assert identity["data_origin"] == "FORMAL_VERIFIED"
    assert client.cookies.get("radio_local_session")
    assert "HttpOnly" in response.headers.get("set-cookie", "")
    assert "SameSite=strict" in response.headers.get("set-cookie", "")
    assert identity["account_id"] and identity["session_id"]
    options = _data(client.get("/api/v1/system/options"))
    permissions = identity["permissions"]
    assert len(permissions) == len(set(permissions))
    assert set(permissions) == {row["code"] for row in options["permissions"]}
    assert {"situation.view", "resources.view", "planning.view", "diagnosis.view", "knowledge.view",
            "knowledge.edit", "knowledge.review", "knowledge.publish", "knowledge.rollback",
            "system.view", "system.accounts", "system.roles", "system.parameters", "system.logs"} <= set(permissions)
    return identity


def verify_write_protection(client, base):
    """新模式仍在服务端拒绝错误CSRF、来源及会话绑定。"""
    options = _data(client.get("/api/v1/system/options"))
    challenge = _data(client.get("/api/v1/auth/csrf"))
    headers = {"Origin": base, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": challenge["session_id"]}
    body = {"baseRevision": options["revision"], "requestId": "portable-rejected-write", "value": 31}
    for changed, expected in (({"X-CSRF-Token": "wrong"}, 1105),
                              ({"X-Session-Id": "different-session"}, 1106),
                              ({"Origin": "http://127.0.0.1:1"}, 1105)):
        response = client.put("/api/v1/system/parameters/PAR-01", headers={**headers, **changed}, json=body)
        assert response.status_code in (403, 409) and response.json().get("code") == expected


def verify_frontend_http(client, dist):
    """只请求当前入口依赖闭包；拒绝 404 和把 JS/CSS 错回成 HTML 的情况。"""
    dist = Path(dist).resolve()
    assets = check_frontend_assets(dist)
    for asset in assets:
        relative = asset.relative_to(dist).as_posix()
        path = "/" if relative == "index.html" else "/" + quote(relative, safe="/")
        response = client.get(path)
        if response.status_code != 200:
            raise RuntimeError(f"前端资源 HTTP 校验失败：{path}，状态码 {response.status_code}")
        expected = {".html": {"text/html"}, ".js": {"text/javascript", "application/javascript"},
                    ".mjs": {"text/javascript", "application/javascript"}, ".css": {"text/css"}}.get(asset.suffix.lower())
        if expected and response.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in expected:
            raise RuntimeError("前端资源 HTTP 类型不符：" + path)
        if asset.suffix.lower() == ".html":
            cache = response.headers.get("cache-control", "").lower()
            if "no-store" not in cache or "no-cache" not in cache:
                raise RuntimeError("HTML入口缺少禁止缓存响应头：" + path)
    return len(assets)


def verify(root, output):
    data = root / "app/data/runtime"
    if data.exists():
        raise RuntimeError("验收只接受未启动的独立解压副本")
    static = root / "app/front_design/radio-planning-20261022/dist"
    check_frontend_assets(static)  # 在首次初始化和任何服务操作之前失败。
    launcher, python = root / "launcher.py", root / "runtime/python/python.exe"
    records = []

    def run(action):
        result = subprocess.run([str(python), "-B", str(launcher), action, "--no-browser"], cwd=root,
                                capture_output=True, text=True, encoding="utf-8", timeout=210)
        assert result.returncode == 0, result.stderr + result.stdout
        return result

    def state():
        return json.loads((data / "service.json").read_text(encoding="utf-8"))

    # 将开发环境变量故意污染，证实包入口只使用解压目录。
    original_database = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = "sqlite:///F:/must-not-be-opened/development.sqlite"
    occupied = socket.socket()
    try:
        occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        occupied.bind(("127.0.0.1", 18480))
        occupied.listen()
    except OSError:
        # 该端口可能已由用户实例持有；只验证新副本自行避让，不连接或停止占用者。
        occupied.close()
        occupied = None
    try:
        run("start")
        first = state()
        assert first["port"] != 18480
        entry_url = verify_start_url(root, first)
        records.append({"case": "FIRST_START_BUSY_PORT", "passed": True, "port": first["port"]})
        base = f"http://127.0.0.1:{first['port']}"

        def verify_identity():
            current = state()
            with httpx.Client(base_url=base, trust_env=False, timeout=5) as client:
                identity = client.get("/__portable/status", headers={"X-Portable-Token": current["token"]})
                assert identity.status_code == 200 and identity.json()["instance"] == current["instance"]

        verify_identity()

        @contextmanager
        def local_session():
            client = httpx.Client(base_url=base, trust_env=False, headers={"Origin": base}, timeout=40)
            try:
                verify_unified_session(client)
                yield client
            finally:
                client.close()

        def mutate(client, method, path, body):
            csrf = client.get("/api/v1/auth/csrf").json()["data"]
            reply = client.request(method, path, headers={"X-CSRF-Token": csrf["csrf_token"], "X-Session-Id": csrf["session_id"] or ""}, json=body)
            return _data(reply)

        with httpx.Client(base_url=base, trust_env=False, timeout=30) as public:
            assets = verify_frontend_http(public, static)
            records.append({"case": "FRONTEND_ASSET_CLOSURE_HTTP", "passed": True, "assets": assets})
            entry = public.get(entry_url.split("#", 1)[0])
            assert entry.status_code == 200 and entry.content == (static / "index.html").read_bytes()
            cache = entry.headers.get("cache-control", "").lower()
            assert "no-store" in cache and "no-cache" in cache
            records.append({"case": "VERSIONED_ENTRY_AND_HTML_NO_CACHE", "passed": True})
            assert public.get("/health").json()["code"] == 0
            workers = public.get("/health/workers").json()["data"]
            assert workers == {"interference": "running", "frozen_coverage": "running"}
            terrain = public.get("/maps/sr4-terrain.json")
            image = public.get("/maps/sr4-terrain.png")
            assert terrain.status_code == image.status_code == 200
            assert image.content.startswith(b"\x89PNG\r\n\x1a\n")
            assert public.get("/maps/demo-roads-tiles/manifest.json").status_code == 200
            assert public.post("/__portable/stop").status_code == 403
            records.append({"case": "STATIC_DEM_ROADS_WORKERS_AND_STOP_AUTH", "passed": True,
                            "terrain_image_sha256": hashlib.sha256(image.content).hexdigest(), "workers": workers})
        with local_session() as client:
            verify_write_protection(client, base)
            records.append({"case": "LOCAL_SINGLE_USER_CSRF_ORIGIN_SESSION_BINDING", "passed": True})
            resource = client.get("/api/v1/resource/context", params={"context": "planning"})
            assert resource.status_code == 200, resource.text
            revision = resource.json()["data"]["revision"]
            kg = client.get("/api/v1/kg/workbench")
            assert kg.status_code == 200, kg.text
            assert client.get("/api/v1/fault/workbench").status_code == 200
            records.append({"case": "LOCAL_UNIFIED_AUTOMATIC_SESSION_FULL_PERMISSIONS_RESOURCE_SR5_SR6", "passed": True,
                            "resource_revision": revision, "knowledge_version": kg.json()["data"]["workspace"]["currentVersionId"]})
            options = client.get("/api/v1/system/options").json()["data"]
            mutate(client, "PUT", "/api/v1/system/parameters/PAR-01", {"baseRevision": options["revision"],
                   "requestId": "portable-persistence-test", "value": 31})
        settings_hash = hashlib.sha256((data / "settings.json").read_bytes()).hexdigest()
        run("start")
        assert state()["pid"] == first["pid"]
        records.append({"case": "REPEATED_START_SAME_PROCESS", "passed": True})
        run("stop")
        assert state()["state"] == "STOPPED"
        assert occupied is None or occupied.fileno() >= 0
        run("start")
        base = f"http://127.0.0.1:{state()['port']}"
        verify_start_url(root, state())
        verify_identity()
        assert state()["instance"] != first["instance"]
        assert hashlib.sha256((data / "settings.json").read_bytes()).hexdigest() == settings_hash
        with local_session() as client:
            values = client.get("/api/v1/system/parameters").json()["data"]["items"]
            assert next(x["value"] for x in values if x["id"] == "PAR-01") == 31
            assert client.get("/api/v1/resource/context", params={"context": "planning"}).json()["data"]["revision"] == revision
        records.append({"case": "STOP_RESTART_PRESERVES_DATABASE_ACCOUNT_RESOURCE", "passed": True})
    finally:
        try:
            run("stop")
            run("stop")
            records.append({"case": "STOP_AND_REPEATED_STOP", "passed": True})
        finally:
            if occupied is not None:
                occupied.close()
            if original_database is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = original_database
            output.write_text(json.dumps({"method": "EXTRACTED_PORTABLE_REAL_HTTP", "directory": str(root), "cases": records},
                                         ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(records), "evidence": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    verify(args.directory.resolve(), args.output.resolve())
