"""对已解压便携包进行串行 HTTP 验收；只使用该包新建库。"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time

import httpx


def verify(root, output):
    data = root / "app/data/runtime"
    if data.exists():
        raise RuntimeError("验收只接受未启动的独立解压副本")
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
    occupied.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    occupied.bind(("127.0.0.1", 18480))
    occupied.listen()
    try:
        run("start")
        first = state()
        assert first["port"] != 18480
        records.append({"case": "FIRST_START_BUSY_PORT", "passed": True, "port": first["port"]})
        config = json.loads((data / "settings.json").read_text(encoding="utf-8"))
        base = f"http://127.0.0.1:{first['port']}"
        passwords = {}

        def verify_identity():
            current = state()
            with httpx.Client(base_url=base, trust_env=False, timeout=5) as client:
                identity = client.get("/__portable/status", headers={"X-Portable-Token": current["token"]})
                assert identity.status_code == 200 and identity.json()["instance"] == current["instance"]

        verify_identity()

        @contextmanager
        def login(role, password=None):
            client = httpx.Client(base_url=base, trust_env=False, headers={"Origin": base}, timeout=40)
            challenge = client.get("/api/v1/auth/csrf").json()["data"]
            account = config["accounts"][role]
            response = client.post("/api/v1/auth/login", headers={"X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""},
                                   json={"username": account["username"], "password": password or passwords.get(role) or account["password"]})
            assert response.status_code == 200, response.text
            try:
                yield client
            finally:
                client.close()

        def mutate(client, method, path, body):
            csrf = client.get("/api/v1/auth/csrf").json()["data"]
            reply = client.request(method, path, headers={"X-CSRF-Token": csrf["csrf_token"], "X-Session-Id": csrf["session_id"] or ""}, json=body)
            assert reply.status_code == 200, reply.text
            return reply.json()["data"]

        with httpx.Client(base_url=base, trust_env=False, timeout=30) as public:
            assert public.get("/").status_code == 200
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
        for role in ("admin", "editor", "reviewer"):
            with login(role) as client:
                new_password = "Aa1!" + secrets.token_urlsafe(22)
                mutate(client, "POST", "/api/v1/auth/password", {"requestId": "portable-test-password-" + role,
                    "currentPassword": config["accounts"][role]["password"], "newPassword": new_password})
                passwords[role] = new_password
        with login("editor") as client:
            resource = client.get("/api/v1/resource/context", params={"context": "planning"})
            assert resource.status_code == 200, resource.text
            revision = resource.json()["data"]["revision"]
            kg = client.get("/api/v1/kg/workbench")
            assert kg.status_code == 200, kg.text
            assert client.get("/api/v1/fault/workbench").status_code == 200
            records.append({"case": "EDITOR_LOGIN_PASSWORD_RESOURCE_SR5_SR6", "passed": True,
                            "resource_revision": revision, "knowledge_version": kg.json()["data"]["workspace"]["currentVersionId"]})
        with login("admin") as client:
            options = client.get("/api/v1/system/options").json()["data"]
            mutate(client, "PUT", "/api/v1/system/parameters/PAR-01", {"baseRevision": options["revision"],
                   "requestId": "portable-persistence-test", "value": 31})
        settings_hash = hashlib.sha256((data / "settings.json").read_bytes()).hexdigest()
        run("start")
        assert state()["pid"] == first["pid"]
        records.append({"case": "REPEATED_START_SAME_PROCESS", "passed": True})
        run("stop")
        assert state()["state"] == "STOPPED"
        assert occupied.fileno() >= 0
        run("start")
        base = f"http://127.0.0.1:{state()['port']}"
        verify_identity()
        assert state()["instance"] != first["instance"]
        assert hashlib.sha256((data / "settings.json").read_bytes()).hexdigest() == settings_hash
        with login("admin") as client:
            values = client.get("/api/v1/system/parameters").json()["data"]["items"]
            assert next(x["value"] for x in values if x["id"] == "PAR-01") == 31
        with login("editor") as client:
            assert client.get("/api/v1/resource/context", params={"context": "planning"}).json()["data"]["revision"] == revision
        records.append({"case": "STOP_RESTART_PRESERVES_DATABASE_ACCOUNT_RESOURCE", "passed": True})
    finally:
        try:
            run("stop")
            run("stop")
            records.append({"case": "STOP_AND_REPEATED_STOP", "passed": True})
        finally:
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
