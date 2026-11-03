"""启动入口版本查询与HTML缓存策略；不启动后台、不读取现用实例。"""
import importlib.util
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.serve_delivery import DeliveryStaticFiles


def launcher():
    spec = importlib.util.spec_from_file_location("portable_entry_cache", Path(__file__).with_name("launcher.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_start_opens_versioned_gis_url_and_preserves_credentials(tmp_path, monkeypatch):
    entry = launcher()
    root = tmp_path / "fresh-package"
    data = root / "app/data/runtime"
    data.mkdir(parents=True)
    version = "LOCAL-20261103-" + "a"*12
    (root / "package-manifest.json").write_text(json.dumps({"controlled_version": version, "content_snapshot_sha256": "a"*64}), encoding="utf-8")
    (data / "settings.json").write_bytes(b"private-runtime-must-not-be-read")
    monkeypatch.setattr(entry, "ROOT", root)
    monkeypatch.setattr(entry, "DATA", data)
    monkeypatch.setattr(entry, "check_frontend_assets", lambda: ())
    monkeypatch.setattr(entry, "secure_data_directory", lambda: None)
    monkeypatch.setattr(entry, "available_state", lambda: {"port": 18481, "pid": 1001})
    opened = []
    monkeypatch.setattr(entry.os, "startfile", opened.append, raising=False)
    original_read = Path.read_text
    def read(path, *args, **kwargs):
        assert path.name not in ("settings.json", "首次登录账号.txt"), "入口版本不得读取凭据"
        return original_read(path, *args, **kwargs)
    monkeypatch.setattr(Path, "read_text", read)
    entry.start()
    expected = f"http://127.0.0.1:18481/?v={version}#/situation"
    assert opened == [expected]
    assert (data / "访问地址.txt").read_text(encoding="utf-8").strip() == expected
    assert (data / "settings.json").read_bytes() == b"private-runtime-must-not-be-read"


@pytest.mark.parametrize("manifest", [None, "not-json", "[]", "{}",
    json.dumps({"controlled_version": "LOCAL-20261103-"+"a"*12, "content_snapshot_sha256": "b"*64}),
    json.dumps({"controlled_version": "LOCAL-20261103-bad&token=private", "content_snapshot_sha256": "a"*64})])
def test_missing_or_invalid_public_manifest_uses_fresh_safe_cache_bust(tmp_path, monkeypatch, manifest):
    entry = launcher()
    monkeypatch.setattr(entry, "ROOT", tmp_path)
    if manifest is not None:
        (tmp_path / "package-manifest.json").write_text(manifest, encoding="utf-8")
    first, second = entry.frontend_entry_url(18481), entry.frontend_entry_url(18481)
    assert first != second
    parsed = urlsplit(first)
    assert parsed.netloc == "127.0.0.1:18481" and parsed.fragment == "/situation"
    query = parse_qs(parsed.query)
    assert set(query) == {"v"} and re.fullmatch(r"reload-[0-9a-f]{24}", query["v"][0])


@pytest.fixture
def static_app(tmp_path):
    (tmp_path / "index.html").write_text('<script src="./main.js"></script>', encoding="utf-8")
    (tmp_path / "main.js").write_text("export const value=1;", encoding="utf-8")
    app = FastAPI()
    @app.get("/api/test")
    def api():
        return {"ok": True}
    app.mount("/", DeliveryStaticFiles(directory=str(tmp_path), html=True))
    with TestClient(app) as client:
        yield client, tmp_path


@pytest.mark.parametrize("path", ["/", "/?v=LOCAL-20261103-aaaaaaaaaaaa", "/index.html"])
def test_html_always_returns_current_content_with_no_store_even_with_old_etag(static_app, path):
    client, directory = static_app
    first = client.get(path)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"
    assert first.headers["pragma"] == "no-cache" and first.headers["expires"] == "0"
    conditional = client.get(path, headers={"If-None-Match": first.headers["etag"], "If-Modified-Since": first.headers["last-modified"]})
    assert conditional.status_code == 200 and conditional.content == first.content
    (directory / "index.html").write_text("<main>new controlled entry</main>", encoding="utf-8")
    latest = client.get(path, headers={"If-None-Match": first.headers["etag"]})
    assert latest.status_code == 200 and latest.text == "<main>new controlled entry</main>"


def test_html_head_is_not_cached_and_script_api_policies_are_preserved(static_app):
    client, _ = static_app
    head = client.head("/index.html")
    assert head.status_code == 200 and head.content == b"" and "no-store" in head.headers["cache-control"]
    script = client.get("/main.js")
    assert "no-store" not in script.headers.get("cache-control", "")
    assert client.get("/main.js", headers={"If-None-Match": script.headers["etag"]}).status_code == 304
    assert "cache-control" not in client.get("/api/test").headers
