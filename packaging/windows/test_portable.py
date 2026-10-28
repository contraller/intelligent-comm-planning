"""便携控制入口的边界测试；不连接开发服务或现有数据库。"""
import importlib.util
import json
from pathlib import Path
import re
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


@pytest.mark.parametrize("folder", ("任意目录", "中文 空格(一)", "路径%27 & 括号(二)"))
def test_migration_directory_is_independent_of_folder_name(tmp_path, monkeypatch, folder):
    from alembic.script import ScriptDirectory
    entry = load("launcher")
    app = tmp_path / folder / "app"
    versions = app / "algorithm-service/migrations/versions"
    versions.mkdir(parents=True)
    (versions / "0001.py").write_text("revision='portable_head'\ndown_revision=None\n", encoding="utf-8")
    monkeypatch.setattr(entry, "APP", app)
    config = entry.migration_config()
    assert config.config_file_name is None
    assert ScriptDirectory.from_config(config).get_current_head() == "portable_head"


@pytest.mark.parametrize("folder", ("任意目录", "中文 空格(一)", "路径%27 & 括号(二)"))
def test_sqlite_url_round_trips_literal_directory(tmp_path, monkeypatch, folder):
    from sqlalchemy.engine import make_url
    entry = load("launcher")
    data = tmp_path / folder / "app/data/runtime"
    monkeypatch.setattr(entry, "DATA", data)
    original = list(entry.sys.path)
    try:
        entry.configure(18481, "test-key")
        assert Path(make_url(entry.os.environ["DATABASE_URL"]).database) == data / "r2.sqlite"
    finally:
        entry.sys.path[:] = original


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


@pytest.fixture
def frontend(tmp_path, monkeypatch):
    entry = load("launcher")
    app = tmp_path / "中文 空格%27" / "app"
    monkeypatch.setattr(entry, "APP", app)
    monkeypatch.setattr(entry, "DATA", app / "data/runtime")
    dist = app / "front_design/radio-planning-20261022/dist"
    dist.mkdir(parents=True)

    def write(name, content=""):
        path = dist / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    return entry, dist, write


@pytest.mark.parametrize("html,missing", (
    ('<script type="module" src="./assets/index-UjXR-R3r.js"></script>', "assets/index-UjXR-R3r.js"),
    ('<link rel="stylesheet" href="./assets/main.css">', "assets/main.css"),
    ('<link rel="modulepreload" href="./assets/shared.js">', "assets/shared.js"),
    ('<link rel="icon" href="/icon.png">', "icon.png"),
    ('<img src="/images/logo.png">', "images/logo.png"),
))
def test_frontend_missing_html_reference(frontend, html, missing):
    entry, _, write = frontend
    write("index.html", html)
    with pytest.raises(RuntimeError, match=re.escape(missing)):
        entry.check_frontend_assets()
    assert not entry.DATA.exists()


def test_frontend_requires_index_html(frontend):
    entry, _, _ = frontend
    with pytest.raises(RuntimeError, match="index.html"):
        entry.check_frontend_assets()


@pytest.mark.parametrize("statement", (
    'import "./missing.js";',
    'import value from "./missing.js";',
    'import { value as alias } from "./missing.js";',
    'import * as value from "./missing.js";',
    'export { value } from "./missing.js";',
    'export * from "./missing.js";',
    'const lazy = () => import("./missing.js");',
    'const lazy = () => import(/* preload */ "./missing.js", {with: {type: "json"}});',
    'const lazy = () => import(`./missing.js`);',
))
def test_frontend_checks_transitive_static_and_dynamic_imports(frontend, statement):
    entry, _, write = frontend
    write("index.html", '<script type="module" src="./assets/main.js"></script>')
    write("assets/main.js", 'import "./nested/child.js";')
    write("assets/nested/child.js", statement)
    with pytest.raises(RuntimeError, match="assets/nested/missing.js.*assets/nested/child.js"):
        entry.check_frontend_assets()


def test_frontend_closure_handles_cycles_encoded_paths_and_ignores_orphans(frontend):
    entry, dist, write = frontend
    expected = {
        write("index.html", '<script src="./assets/main.js?v=1&amp;mode=ok#load"></script>'
              '<link rel="stylesheet" href="/assets/main.css?v=1">'
              '<script src="https://example.invalid/external.js"></script>'
              '<img src="data:image/png;base64,AA=="><a href="/tasks">tasks</a>'),
        write("assets/main.js", 'import "./sub/child.mjs"; export {value} from "/assets/shared.js";'),
        write("assets/sub/child.mjs", 'import "../main.js"; import("../lazy\\u002dchunk.js?v=2#load");'),
        write("assets/shared.js", 'export const value = 1;'),
        write("assets/lazy-chunk.js", 'import "./space%20chunk.js";'),
        write("assets/space chunk.js"),
        write("assets/main.css"),
    }
    write("assets/old-orphan.js", 'import "./removed-old-dependency.js";')
    assert set(entry.check_frontend_assets()) == expected
    assert set(entry.check_frontend_assets(dist)) == expected
    assert not entry.DATA.exists()


def test_frontend_ignores_fake_imports_and_nonliteral_dynamic_paths(frontend):
    entry, _, write = frontend
    write("index.html", '<script src="./assets/main.js"></script><!-- <script src="missing.js"> -->')
    write("assets/main.js", '''
        // import "./comment.js";
        /* export * from "./block-comment.js"; */
        const message = 'import("./quoted.js")';
        const template = `import("./template.js")`;
        const expression = /import("regexp.js")/;
        const arrow = () => /import("arrow-regexp.js")/;
        object.import("./method.js"); object ?. import("./optional-method.js");
        import("./prefix-" + name); import(`./${name}.js`);
        import("https://example.invalid/module.js");
    ''')
    assert len(entry.check_frontend_assets()) == 2


def test_frontend_division_does_not_hide_real_dynamic_import(frontend):
    entry, _, write = frontend
    write("index.html", '<script src="./main.js"></script>')
    write("main.js", 'const n = 10 / 2; import("./missing.js"); const m = 20 / 2;')
    with pytest.raises(RuntimeError, match="missing.js"):
        entry.check_frontend_assets()


def test_frontend_regex_quotes_do_not_desynchronize_import_scanner(frontend):
    entry, _, write = frontend
    write("index.html", '<script src="./main.js"></script>')
    write("main.js", '''const regex=/["']/; const host="//"; import("./missing.js");''')
    with pytest.raises(RuntimeError, match="missing.js"):
        entry.check_frontend_assets()


def test_frontend_checks_vite_preload_css(frontend):
    entry, _, write = frontend
    write("index.html", '<script src="./assets/main.js"></script>')
    write("assets/main.js", 'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./lazy.js","./lazy.css"])))=>i.map(i=>d[i]); import("./lazy.js");')
    write("assets/lazy.js")
    with pytest.raises(RuntimeError, match="assets/lazy.css"):
        entry.check_frontend_assets()
    write("assets/lazy.css")
    assert len(entry.check_frontend_assets()) == 4


@pytest.mark.parametrize("reference", ('url("./fonts/missing.woff2")', "url('./fonts/missing.woff2')", 'url(./fonts/missing.woff2)'))
def test_frontend_checks_css_assets_after_js_preload(frontend, reference):
    entry, _, write = frontend
    write("index.html", '<script src="./assets/main.js"></script>')
    write("assets/main.js", 'import "./main.css";')
    write("assets/main.css", '@import "./nested/theme.css";')
    write("assets/nested/theme.css", '@font-face {src:' + reference + '}')
    with pytest.raises(RuntimeError, match="assets/nested/fonts/missing.woff2"):
        entry.check_frontend_assets()
    write("assets/nested/fonts/missing.woff2")
    assert len(entry.check_frontend_assets()) == 5


def test_frontend_css_ignores_comments_strings_data_and_fragments(frontend):
    entry, _, write = frontend
    write("index.html", '<link rel="stylesheet" href="./main.css">')
    write("main.css", '''/* url("./comment.png") */
        .icon {content: 'url("./string.png")'; background: url(data:image/png;base64,AA==); filter:url(#filter)}''')
    assert len(entry.check_frontend_assets()) == 2


@pytest.mark.parametrize("reference", ("../../outside.js", "/../outside.js", "%2e%2e/%2e%2e/outside.js"))
def test_frontend_never_reads_references_outside_dist(frontend, reference):
    entry, dist, write = frontend
    write("index.html", '<script src="./assets/main.js"></script>')
    write("assets/main.js", 'import "' + reference + '";')
    (dist.parent / "outside.js").write_text("do not read", encoding="utf-8")
    with pytest.raises(RuntimeError, match="引用越界"):
        entry.check_frontend_assets()


@pytest.mark.parametrize("running", (False, True))
def test_start_preflight_precedes_user_data_and_existing_instance(frontend, monkeypatch, running):
    entry, _, write = frontend
    write("index.html", '<script src="./assets/index-UjXR-R3r.js"></script>')
    entry.DATA.mkdir(parents=True)
    preserved = {name: (entry.DATA / name) for name in ("r2.sqlite", "settings.json", "service.json")}
    for path in preserved.values():
        path.write_bytes(b"keep-existing-user-data")
    called = []

    def forbidden(*args, **kwargs):
        pytest.fail("preflight must finish before data, process, or browser operations")

    def available():
        called.append("available")
        return {"port": 18480} if running else None

    monkeypatch.setattr(entry, "available_state", available)
    monkeypatch.setattr(entry, "secure_data_directory", forbidden)
    monkeypatch.setattr(entry, "initialize", forbidden)
    monkeypatch.setattr(entry, "control", forbidden)
    monkeypatch.setattr(entry.subprocess, "Popen", forbidden)
    monkeypatch.setattr(entry.os, "startfile", forbidden, raising=False)
    with pytest.raises(RuntimeError, match="index-UjXR-R3r.js"):
        entry.start()
    assert called == []
    assert {path.name: path.read_bytes() for path in entry.DATA.iterdir()} == {
        name: b"keep-existing-user-data" for name in preserved
    }


def test_direct_serve_preflight_precedes_data_directory_creation(frontend, monkeypatch):
    entry, _, write = frontend
    write("index.html", '<script src="./missing.js"></script>')

    def forbidden():
        pytest.fail("must not prepare data for incomplete frontend")

    monkeypatch.setattr(entry, "secure_data_directory", forbidden)
    with pytest.raises(RuntimeError, match="missing.js"):
        entry.serve()
    assert not entry.DATA.exists()


@pytest.mark.parametrize("failure", (None, "404", "html-fallback"))
def test_http_verifies_only_current_asset_closure(frontend, failure):
    import httpx
    entry, dist, write = frontend
    write("index.html", '<script src="./assets/main.js"></script>')
    write("assets/main.js", 'import("./lazy.js");')
    write("assets/lazy.js")
    write("assets/orphan.js", 'import "./old-missing.js";')
    requested = []

    def respond(request):
        path = request.url.path
        requested.append(path)
        status, mime = 200, "text/html" if path == "/" else "text/javascript"
        if path == "/assets/lazy.js":
            if failure == "404":
                status = 404
            if failure == "html-fallback":
                mime = "text/html"
        return httpx.Response(status, text="fixture", headers={"content-type": mime})

    verifier = load("verify_portable")
    with httpx.Client(base_url="http://portable.invalid", transport=httpx.MockTransport(respond)) as client:
        if failure:
            with pytest.raises(RuntimeError, match="lazy.js"):
                verifier.verify_frontend_http(client, dist)
        else:
            assert verifier.verify_frontend_http(client, dist) == 3
            assert set(requested) == {"/", "/assets/main.js", "/assets/lazy.js"}
    assert "/assets/orphan.js" not in requested
    assert not entry.DATA.exists()
