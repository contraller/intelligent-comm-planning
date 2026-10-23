"""Isolated ASGI/MockTransport evidence only; no ports, running API, database or workers."""
import gzip
import json
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from scripts import serve_r2_frontend as host

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setattr(host, "ROOT", tmp_path)
    dist = tmp_path / "data/runtime/r2/bundle-fixture"
    public = tmp_path / "front_design/radio-planning-20261022/public"
    dist.mkdir(parents=True)
    public.mkdir(parents=True)
    (dist / "index.html").write_text("<html>R2 fixture</html>", encoding="utf-8")
    (dist / "app.js").write_text("bundle fixture", encoding="utf-8")
    (public / "app.js").write_text("public must not replace bundle", encoding="utf-8")
    (public / "tiles").mkdir()
    (public / "tiles/tile.mvt").write_bytes(b"MVT fixture")
    (tmp_path / "secret.txt").write_text("PRIVATE fixture", encoding="utf-8")
    return SimpleNamespace(root=tmp_path, dist=dist, public=public)


class RawStream(httpx.AsyncByteStream):
    def __init__(self, chunks, error=None):
        self.chunks, self.error = chunks, error
        self.reads = self.yielded = 0
        self.closed = False

    async def __aiter__(self):
        self.reads += 1
        assert self.reads == 1, "Proxy consumed raw upstream more than once"
        for chunk in self.chunks:
            self.yielded += 1
            yield chunk
        if self.error:
            raise self.error

    async def aclose(self):
        self.closed = True


def reply(body=b"upstream fixture", *, status=200, headers=(), chunks=None, error=None):
    stream = RawStream([body] if chunks is None else chunks, error)
    return httpx.Response(status, headers=headers, stream=stream), stream


@asynccontextmanager
async def client_for(site, handler=None):
    def unexpected(request):
        pytest.fail("Static request unexpectedly reached upstream")

    app = host.create_frontend_app(site.dist, transport=httpx.MockTransport(handler or unexpected))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app, raise_app_exceptions=False),
                                     base_url="http://127.0.0.19:5319", follow_redirects=False) as client:
            yield client, app


def assert_failure(response, status):
    assert response.status_code == status
    assert response.json() == {"code": status, "message": "R2 frontend request failed", "data": None, "request_id": None}
    assert response.headers["cache-control"] == "no-store"


def link_or_skip(link, target, *, directory=False):
    try:
        link.symlink_to(target, target_is_directory=directory)
    except OSError as error:
        if error.winerror == 1314:
            pytest.skip("Windows symlink privilege unavailable")
        raise


def test_limits_are_explicit_and_no_server_is_started_by_import():
    assert host.MAX_REQUEST_BYTES == 24 * 1024 * 1024
    assert host.MAX_RESPONSE_BYTES == 32 * 1024 * 1024
    assert host.API_TARGET == "http://127.0.0.19:8119"


@pytest.mark.parametrize("target", ["http://127.0.0.1:5183", "http://127.0.0.19:5183", "http://localhost:8119",
    "http://127.0.0.19:8119/", "http://127.0.0.19:8119/api/v1", "http://user:secret@127.0.0.19:8119",
    "http://127.0.0.19:8119?target=http://evil.invalid", "https://127.0.0.19:8119", "http://evil.invalid:8119"])
def test_rejects_every_nonfixed_upstream(site, target):
    with pytest.raises(ValueError, match="^Invalid R2 frontend configuration$"):
        host.create_frontend_app(site.dist, target)


@pytest.mark.parametrize("kind", ["relative", "root", "runtime-root", "old", "public", "outside", "missing-index"])
def test_rejects_unsafe_or_incomplete_dist(site, tmp_path, kind):
    candidates = {"relative": Path("data/runtime/r2/bundle-fixture"), "root": site.root,
        "runtime-root": site.root / "data/runtime/r2", "old": site.root / "old_front/dist",
        "public": site.public, "outside": site.root / "unapproved", "missing-index": site.root / "data/runtime/r2/no-index"}
    candidate = candidates[kind]
    if kind not in ("relative", "missing-index"):
        candidate.mkdir(parents=True, exist_ok=True)
        (candidate / "index.html").write_text("Not an approved bundle", encoding="utf-8")
    elif kind == "missing-index":
        candidate.mkdir()
    with pytest.raises(ValueError, match="^Invalid R2 frontend configuration$"):
        host.create_frontend_app(candidate)


def test_latest_frontend_dist_is_the_only_other_accepted_directory(site):
    dist = site.public.parent / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("latest fixture", encoding="utf-8")
    app = host.create_frontend_app(dist)
    assert app.routes[-1].app.all_directories == [str(dist), str(site.public)]
    assert app.routes[-1].app.follow_symlink is False


@pytest.mark.parametrize("kind", ["bundle", "index", "public"])
def test_rejects_symlinked_roots_or_index_escape(site, kind):
    if kind == "bundle":
        outside = site.root / "unapproved"
        outside.mkdir()
        (outside / "index.html").write_text("PRIVATE", encoding="utf-8")
        candidate = site.dist.parent / "outside-link"
        link_or_skip(candidate, outside, directory=True)
    elif kind == "index":
        (site.dist / "index.html").unlink()
        link_or_skip(site.dist / "index.html", site.root / "secret.txt")
        candidate = site.dist
    else:
        site.public.rename(site.public.parent / "original-public")
        link_or_skip(site.public, site.root, directory=True)
        candidate = site.dist
    with pytest.raises(ValueError, match="^Invalid R2 frontend configuration$"):
        host.create_frontend_app(candidate)


async def test_only_two_static_roots_bundle_first_and_public_tiles_not_copied(site):
    async with client_for(site) as (client, app):
        assert (await client.get("/")).text == "<html>R2 fixture</html>"
        assert (await client.get("/app.js")).text == "bundle fixture"
        assert (await client.get("/tiles/tile.mvt")).content == b"MVT fixture"
        assert (await client.head("/app.js")).content == b""
        assert app.routes[-1].app.all_directories == [str(site.dist), str(site.public)]
        for path in ("/secret.txt", "/old_front/index.html", "/%2e%2e/%2e%2e/secret.txt", "/missing.js"):
            assert_failure(await client.get(path), 404)
        assert_failure(await client.post("/app.js", content=b"x"), 405)
    assert not (site.dist / "tiles").exists()
    assert app.state.proxy_client.is_closed


async def test_nested_file_and_directory_symlinks_cannot_escape_either_static_root(site):
    link_or_skip(site.dist / "leak.txt", site.root / "secret.txt")
    link_or_skip(site.public / "leak-dir", site.root, directory=True)
    async with client_for(site) as (client, _):
        assert_failure(await client.get("/leak.txt"), 404)
        assert_failure(await client.get("/leak-dir/secret.txt"), 404)


async def test_static_root_replaced_by_symlink_after_creation_is_rejected(site):
    async with client_for(site) as (client, _):
        site.dist.rename(site.dist.parent / "original-bundle")
        link_or_skip(site.dist, site.root, directory=True)
        assert_failure(await client.get("/secret.txt"), 404)


async def test_proxy_preserves_request_body_query_auth_origin_and_repeated_cookie_headers(site):
    seen = []
    upstream, stream = reply(b'{"code":0,"data":null}', headers=[("content-type", "application/json"),
        ("set-cookie", "sid=one; HttpOnly; SameSite=Strict; Path=/"), ("set-cookie", "nonce=two; Path=/"),
        ("connection", "keep-alive, X-Upstream-Hop"), ("x-upstream-hop", "not-forwarded"), ("keep-alive", "timeout=5")])

    def handler(request):
        seen.append(request)
        return upstream

    async with client_for(site, handler) as (client, _):
        result = await client.post("/api/v1/resource/import/preview?context=gis&name=a%2Fb&tag=1&tag=2", content=b"original bytes",
            headers={"Origin": "http://127.0.0.19:5319", "Cookie": "sid=fixture; csrf=fixture", "X-Session-Id": "session-fixture",
                "X-CSRF-Token": "nonce-fixture", "Content-Type": "application/json", "Connection": "X-Client-Hop",
                "X-Client-Hop": "not-forwarded", "X-Forwarded-Host": "evil.invalid", "Host": "untrusted.invalid"})
    assert result.status_code == 200
    request = seen[0]
    assert str(request.url) == host.API_TARGET + "/api/v1/resource/import/preview?context=gis&name=a%2Fb&tag=1&tag=2"
    assert request.content == b"original bytes"
    assert request.method == "POST"
    for name, value in (("origin", "http://127.0.0.19:5319"), ("cookie", "sid=fixture; csrf=fixture"),
                        ("x-session-id", "session-fixture"), ("x-csrf-token", "nonce-fixture")):
        assert request.headers[name] == value
    assert request.headers["host"] == "127.0.0.19:8119"
    assert request.headers["accept-encoding"] == "identity"
    assert request.headers["content-length"] == str(len(request.content))
    assert "x-client-hop" not in request.headers and "x-forwarded-host" not in request.headers
    assert "connection" not in request.headers
    assert "x-upstream-hop" not in result.headers and "keep-alive" not in result.headers
    assert result.headers.get_list("set-cookie") == ["sid=one; HttpOnly; SameSite=Strict; Path=/", "nonce=two; Path=/"]
    assert stream.reads == 1 and stream.closed


async def test_shared_client_never_replays_another_browsers_upstream_cookie(site):
    seen = []

    def handler(request):
        seen.append(request.headers.get("cookie"))
        return reply(headers=[("set-cookie", "sid=server-secret; Path=/; HttpOnly")])[0]

    async with client_for(site, handler) as (client, app):
        first = await client.get("/api/v1/auth/session", headers={"Cookie": "sid=browser-one"})
        # Switch browser fixture without carrying its own cookie jar into the next request.
        client.cookies.clear()
        second = await client.get("/api/v1/auth/session")
        await client.get("/api/v1/auth/session", headers={"Cookie": "sid=browser-two"})
        assert len(app.state.proxy_client.cookies) == 0
    assert first.headers.get_list("set-cookie") == ["sid=server-secret; Path=/; HttpOnly"]
    assert second.status_code == 200
    assert seen == ["sid=browser-one", None, "sid=browser-two"]


@pytest.mark.parametrize("headers", [[("content-length", "-1")], [("content-length", "invalid")],
    [("content-length", "1"), ("content-length", "1")]])
async def test_malformed_request_lengths_are_generic_errors_before_upstream(site, headers):
    async with client_for(site) as (client, _):
        assert_failure(await client.post("/api/v1/resource/changes", content=b"x", headers=headers), 400)


@pytest.mark.parametrize("path", ["/api/v1", "/api/v1/auth/session", "/health", "/health/workers"])
async def test_only_explicit_proxy_paths_reach_fixed_api(site, path):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return reply()[0]

    async with client_for(site, handler) as (client, _):
        assert (await client.get(path)).status_code == 200
        for denied in ("/api/v10", "/health/", "/health/workers/", "/health/workers/extra", "/health/anything", "/proxy?url=http://evil.invalid"):
            assert_failure(await client.get(denied), 404)
        assert_failure(await client.get("/api/v1/%2e%2e/health"), 400)
    assert seen == [host.API_TARGET + path]


async def test_compressed_download_is_raw_single_consumption_with_exact_length_and_cookies(site, monkeypatch):
    packed = gzip.compress(b"CSV fixture," * 10000)
    monkeypatch.setattr(host, "MAX_RESPONSE_BYTES", len(packed))
    upstream, stream = reply(chunks=[packed[:10], packed[10:]], headers=[("content-type", "text/csv; charset=utf-8"),
        ("content-encoding", "gzip"), ("content-length", str(len(packed))),
        ("content-disposition", "attachment; filename=resource.csv; filename*=UTF-8''resource.csv"),
        ("set-cookie", "a=1; Path=/"), ("set-cookie", "b=2; Path=/"), ("x-request-id", "download-fixture")])
    async with client_for(site, lambda request: upstream) as (client, _):
        async with client.stream("GET", "/api/v1/resource/import/template") as result:
            raw = b"".join([part async for part in result.aiter_raw()])
    assert raw == packed and gzip.decompress(raw) == b"CSV fixture," * 10000
    assert result.headers["content-length"] == str(len(packed))
    assert result.headers["content-encoding"] == "gzip"
    assert result.headers["content-type"] == "text/csv; charset=utf-8"
    assert result.headers["content-disposition"].startswith("attachment;")
    assert result.headers["x-request-id"] == "download-fixture"
    assert result.headers.get_list("set-cookie") == ["a=1; Path=/", "b=2; Path=/"]
    assert stream.reads == 1 and stream.closed


async def test_twenty_mib_business_download_fits_actual_response_limit(site):
    upstream, stream = reply(chunks=[b"x" * (1024 * 1024)] * 20, headers=[("content-type", "application/octet-stream")])
    async with client_for(site, lambda request: upstream) as (client, _):
        result = await client.get("/api/v1/files/fixture")
    assert result.status_code == 200 and len(result.content) == 20 * 1024 * 1024
    assert result.headers["content-length"] == str(len(result.content))
    assert stream.reads == 1 and stream.closed


@pytest.mark.parametrize("declared", [True, False])
async def test_request_body_limit_rejects_declared_and_streamed_overflow_before_upstream(site, monkeypatch, declared):
    monkeypatch.setattr(host, "MAX_REQUEST_BYTES", 8)
    yielded = []

    async def body():
        for chunk in (b"12345", b"6789", b"must not read"):
            yielded.append(chunk)
            yield chunk

    async with client_for(site) as (client, _):
        result = await client.post("/api/v1/resource/import/commit", content=b"123456789" if declared else body())
    assert_failure(result, 413)
    assert yielded == ([] if declared else [b"12345", b"6789"])


async def test_request_body_exact_limit_is_forwarded(site, monkeypatch):
    monkeypatch.setattr(host, "MAX_REQUEST_BYTES", 8)
    seen = []

    def handler(request):
        seen.append(request.content)
        return reply()[0]

    async with client_for(site, handler) as (client, _):
        assert (await client.post("/api/v1/resource/changes", content=b"12345678")).status_code == 200
    assert seen == [b"12345678"]


@pytest.mark.parametrize("mode", ["declared", "streamed", "gzip", "invalid-length"])
async def test_response_limit_and_bad_length_fail_closed_without_partial_or_sensitive_body(site, monkeypatch, mode):
    monkeypatch.setattr(host, "MAX_RESPONSE_BYTES", 8)
    headers = [("content-length", "9")] if mode == "declared" else []
    if mode == "gzip":
        headers = [("content-encoding", "gzip"), ("set-cookie", "private=must-not-leak")]
    if mode == "invalid-length":
        headers = [("content-length", "invalid")]
    upstream, stream = reply(chunks=[b"12345", b"6789", b"private configuration"], headers=headers)
    async with client_for(site, lambda request: upstream) as (client, _):
        result = await client.get("/api/v1/files/fixture")
    assert_failure(result, 502)
    assert "set-cookie" not in result.headers
    assert stream.reads == (0 if mode in ("declared", "invalid-length") else 1)
    assert stream.yielded == (0 if mode in ("declared", "invalid-length") else 2)
    assert stream.closed


@pytest.mark.parametrize("status,method,length", [(200, "HEAD", "100"), (204, "GET", None), (304, "GET", "100")])
async def test_bodyless_response_semantics(site, status, method, length):
    upstream, stream = reply(body=b"", status=status, headers=[] if length is None else [("content-length", length)])
    async with client_for(site, lambda request: upstream) as (client, _):
        result = await client.request(method, "/api/v1/resource/context")
    assert result.status_code == status and result.content == b""
    assert result.headers.get("content-length") == length
    assert stream.reads == 1 and stream.closed


@pytest.mark.parametrize("kind,expected", [("timeout", 504), ("connect", 502), ("read", 502), ("read-timeout", 504)])
async def test_transport_failures_are_generic_envelopes_and_not_retried(site, kind, expected, caplog):
    seen = []
    stream = None

    def handler(request):
        nonlocal stream
        seen.append(request)
        if kind == "timeout":
            raise httpx.ReadTimeout("PRIVATE cookie=secret target=config", request=request)
        if kind == "connect":
            raise httpx.ConnectError("PRIVATE config", request=request)
        error_type = httpx.ReadTimeout if kind == "read-timeout" else httpx.ReadError
        upstream, stream = reply(chunks=[b"partial private"], error=error_type("PRIVATE credentials", request=request))
        return upstream

    async with client_for(site, handler) as (client, _):
        result = await client.post("/api/v1/resource/changes", content=b"PRIVATE body", headers={"Cookie": "secret=fixture"})
    assert_failure(result, expected)
    assert len(seen) == 1
    assert "PRIVATE" not in result.text and "secret=fixture" not in caplog.text
    if stream:
        assert stream.reads == 1 and stream.closed


async def test_upstream_business_error_and_redirect_are_not_rewritten_or_followed(site):
    seen = []
    payload = {"code": 1104, "message": "fixture denied", "data": None, "request_id": "fixture-trace"}

    def handler(request):
        seen.append(request)
        if len(seen) == 1:
            return reply(json.dumps(payload).encode(), status=403, headers=[("content-type", "application/json")])[0]
        return reply(status=307, headers=[("location", "http://evil.invalid/private")])[0]

    async with client_for(site, handler) as (client, _):
        result = await client.get("/api/v1/resource/context")
        assert result.status_code == 403 and result.json() == payload
        redirect = await client.get("/api/v1/resource/context")
        assert redirect.status_code == 307
    assert len(seen) == 2 and all(str(request.url).startswith(host.API_TARGET + "/api/v1/") for request in seen)
