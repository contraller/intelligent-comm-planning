"""R2 isolated acceptance entry, not a production web deployment or auth certification."""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
from http.cookiejar import CookieJar, DefaultCookiePolicy
import os
from pathlib import Path

import httpx
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parents[1]
API_TARGET = "http://127.0.0.19:8119"
MAX_REQUEST_BYTES = 24 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
HOP_HEADERS = {b"connection", b"keep-alive", b"proxy-authenticate", b"proxy-authorization",
               b"te", b"trailer", b"transfer-encoding", b"upgrade", b"proxy-connection"}


def failure(status):
    return JSONResponse({"code": status, "message": "R2 frontend request failed", "data": None,
                         "request_id": None}, status_code=status, headers={"Cache-Control": "no-store"})


def end_headers(raw, exclude=()):
    blocked = HOP_HEADERS | {b"content-length"} | set(exclude)
    for key, value in raw:
        if key.lower() == b"connection":
            blocked.update(token.strip().lower() for token in value.split(b","))
    return [(key.lower(), value) for key, value in raw if key.lower() not in blocked]


def content_length(values):
    if not values:
        return None
    if len(values) != 1 or len(values[0]) > 20 or not values[0].isascii() or not values[0].isdigit():
        raise ValueError("Invalid length")
    return int(values[0])


class NoCookies(DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        return False


class FrontendFiles(StaticFiles):
    def __init__(self, dist, public):
        super().__init__(directory=str(dist), html=False, follow_symlink=False)
        self.all_directories = [str(dist), str(public)]

    async def get_response(self, path, scope):
        if any(Path(root).resolve() != Path(root) for root in self.all_directories):
            raise HTTPException(404)
        return await super().get_response("index.html" if path in ("", ".") else path, scope)


def create_frontend_app(dist, api_target=API_TARGET, *, transport: httpx.AsyncBaseTransport | None = None):
    root = ROOT.resolve()
    runtime, frontend = root / "data/runtime/r2", root / "front_design/radio-planning-20261022"

    def allowed(path):
        return path == frontend / "dist" or path != runtime and path.is_relative_to(runtime)

    try:
        supplied = Path(dist)
        if api_target != API_TARGET or not supplied.is_absolute():
            raise ValueError()
        supplied = Path(os.path.abspath(supplied))
        resolved, public = supplied.resolve(strict=True), frontend / "public"
        if (not allowed(supplied) or not allowed(resolved) or not resolved.is_dir()
                or not public.is_dir() or public.resolve(strict=True) != public
                or not (resolved / "index.html").is_file()
                or not (resolved / "index.html").resolve(strict=True).is_relative_to(resolved)):
            raise ValueError()
    except (OSError, RuntimeError, ValueError):
        raise ValueError("Invalid R2 frontend configuration") from None

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(transport=transport, trust_env=False, follow_redirects=False,
                                     cookies=CookieJar(policy=NoCookies()), timeout=httpx.Timeout(30, connect=5)) as client:
            client.headers.clear()
            app.state.proxy_client = client
            yield

    async def proxy(request: Request):
        path = request.scope["path"]
        if "\\" in path or any(part in (".", "..") for part in path.split("/")):
            return failure(400)
        try:
            declared = content_length(request.headers.getlist("content-length"))
        except ValueError:
            return failure(400)
        if declared is not None and declared > MAX_REQUEST_BYTES:
            return failure(413)
        body = bytearray()
        try:
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                    return failure(413)
                body.extend(chunk)
        except ClientDisconnect:
            return failure(400)
        raw_path = request.scope.get("raw_path", path.encode("utf-8"))
        query = request.scope["query_string"]
        url = httpx.URL(API_TARGET).copy_with(raw_path=raw_path + (b"?" + query if query else b""))
        headers = end_headers(request.headers.raw, {b"host", b"accept-encoding", b"forwarded",
                              b"x-forwarded-for", b"x-forwarded-host", b"x-forwarded-proto"})
        headers.append((b"accept-encoding", b"identity"))
        try:
            async with request.app.state.proxy_client.stream(request.method, url, headers=headers,
                                                              content=bytes(body)) as upstream:
                bodyless = request.method == "HEAD" or upstream.status_code in (204, 304)
                try:
                    declared = content_length(upstream.headers.get_list("content-length"))
                except ValueError:
                    return failure(502)
                if not bodyless and declared is not None and declared > MAX_RESPONSE_BYTES:
                    return failure(502)
                output = bytearray()
                # Read raw bytes once: decoding first would corrupt gzip headers and size accounting.
                async for chunk in upstream.aiter_raw():
                    if len(output) + len(chunk) > MAX_RESPONSE_BYTES:
                        return failure(502)
                    output.extend(chunk)
                result = Response(b"" if bodyless else bytes(output), status_code=upstream.status_code)
                result.raw_headers = end_headers(upstream.headers.raw)
                if upstream.status_code not in (204, 304) and not bodyless:
                    result.raw_headers.append((b"content-length", str(len(output)).encode("ascii")))
                elif upstream.status_code != 204 and declared is not None:
                    result.raw_headers.append((b"content-length", str(declared).encode("ascii")))
                return result
        except httpx.TimeoutException:
            return failure(504)
        except httpx.HTTPError:
            return failure(502)

    async def error_handler(request, error):
        return failure(error.status_code if isinstance(error, HTTPException) else 500)

    methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    routes = [Route(path, proxy, methods=methods) for path in
              ("/api/v1", "/api/v1/{path:path}", "/health", "/health/workers")]
    routes.append(Mount("/", FrontendFiles(resolved, public)))
    return Starlette(routes=routes, lifespan=lifespan,
                     exception_handlers={HTTPException: error_handler, Exception: error_handler})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", required=True)
    args = parser.parse_args()
    try:
        app = create_frontend_app(args.dist)
    except ValueError:
        parser.error("Invalid R2 frontend configuration")
    import uvicorn
    uvicorn.run(app, host="127.0.0.19", port=5319, access_log=False, proxy_headers=False)


if __name__ == "__main__":
    main()
