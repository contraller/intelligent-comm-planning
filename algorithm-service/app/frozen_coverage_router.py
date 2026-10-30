"""冻结覆盖专用路由工厂；主入口注入require及显式生命周期service。"""
import json
import os
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from starlette.concurrency import run_in_threadpool

from .frozen_coverage_service import CoverageServiceError, _id
from . import integration_identity_service as identity
from .system_management_schemas import SystemManagementError
from .frozen_coverage_bandwidth_schemas import BandwidthSelectionInput
from .frozen_coverage_bandwidth_service import selection_id


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _RequestError(ValueError):
    pass


class _Anchor(_Strict):
    task_id: str
    snapshot_id: str

    @field_validator("task_id", "snapshot_id")
    @classmethod
    def identifiers(cls, value):
        return _id(value)


class _Submit(_Anchor):
    request_id: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    bandwidth_selection_id: str | None = None

    @field_validator("bandwidth_selection_id")
    @classmethod
    def selection_identifier(cls, value):
        return selection_id(value)

    @field_validator("request_id")
    @classmethod
    def request_identifier(cls, value):
        return _id(value)


class _Cache(_Anchor):
    context: Literal["planning", "gis"] = "planning"
    parameters: str = "{}"
    bandwidth_selection_id: str | None = None
    engine_version: Literal["V01-1", "V01-2", "V01-3", "V01-4", "V01-5", "V01-6"] | None = None

    @field_validator("bandwidth_selection_id")
    @classmethod
    def selection_identifier(cls, value):
        return selection_id(value)


class _BandwidthRead(_Anchor):
    context: Literal["planning", "gis"] = "planning"


class _Latest(_BandwidthRead):
    engine_version: Literal["V01-1", "V01-2", "V01-3", "V01-4", "V01-5", "V01-6"] | None = None


class _Job(_Anchor):
    plan_id: str
    context: Literal["planning", "gis"] = "planning"


class _Cancel(_Anchor):
    plan_id: str
    request_id: str

    @field_validator("plan_id", "request_id")
    @classmethod
    def identifiers_extra(cls, value):
        return _id(value)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise _RequestError("重复字段")
        result[key] = value
    return result


def _json(raw):
    def invalid(_):
        raise _RequestError("非有限数值")

    try:
        value = json.loads(raw, object_pairs_hook=_pairs, parse_constant=invalid)
    except (json.JSONDecodeError, UnicodeError, RecursionError) as exc:
        raise _RequestError("无效JSON结构") from exc
    if not isinstance(value, dict):
        raise _RequestError("必须为JSON对象")
    return value


async def _raw(request, limit=16384):
    parts, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise _RequestError("覆盖请求超过专用大小限额")
        parts.append(chunk)
    return b"".join(parts)


def create_frozen_coverage_router(authorize):
    router = APIRouter(prefix="/api/v1/planning-coverages", tags=["frozen-coverage"])

    async def call(request, model, action, *, writing=False):
        try:
            permissions = ["planning.view"] + (["planning.execute"] if writing else [])
            actor = None
            for permission in permissions:
                current = authorize(request, permission, writing=writing)
                if not isinstance(current, dict) or not current.get("account_id") or permission not in current.get("permissions", []):
                    raise CoverageServiceError("服务端身份未授予所需权限", 1103, 403)
                if actor is not None and (current["account_id"], current.get("session_id")) != (actor["account_id"], actor.get("session_id")):
                    raise CoverageServiceError("覆盖请求身份已变化", 1106, 409)
                actor = current
            if writing and not request.headers.get("x-csrf-token", "").isascii():
                raise CoverageServiceError("CSRF无效", 1105, 403)
            raw = await _raw(request, 128 * 1024 if model is BandwidthSelectionInput else 16384)
            if writing:
                if request.query_params:
                    raise _RequestError("写请求不接受查询参数")
                parsed = model.model_validate(_json(raw))
            else:
                if raw:
                    raise _RequestError("读请求不接受正文")
                parsed = model.model_validate(_pairs(request.query_params.multi_items()))
                if parsed.context == "gis":
                    current = authorize(request, "situation.view", writing=False)
                    if not isinstance(current, dict) or "situation.view" not in current.get("permissions", []):
                        raise CoverageServiceError("GIS覆盖读取缺少权限", 1103, 403)
                    if (current.get("account_id"), current.get("session_id")) != (actor["account_id"], actor.get("session_id")):
                        raise CoverageServiceError("GIS覆盖读取身份或会话已变化", 1106, 409)
                    permissions.append("situation.view")
            service = getattr(request.app.state, "frozen_coverage", None)
            if service is None:
                raise CoverageServiceError("冻结覆盖服务未装配", 5003, 503)
            def execute():
                # body读取和threadpool排队以后重新校验；可信上下文只留在业务读取线程。
                for permission in permissions:
                    current = authorize(request, permission, writing=writing)
                    if (not isinstance(current, dict) or (current.get("account_id"), current.get("session_id"))
                            != (actor["account_id"], actor.get("session_id")) or permission not in current.get("permissions", [])):
                        raise CoverageServiceError("覆盖请求身份或会话已变化", 1106, 409)
                context = None
                local = getattr(request.app.state, "auth_mode", None) == "LOCAL_PASSWORD" or os.environ.get("AUTH_MODE") == "LOCAL_PASSWORD"
                if local:
                    adapter = getattr(request.app.state, "local_identity_adapter", None)
                    if adapter is None:
                        raise SystemManagementError("覆盖正式身份未装配", 5001, 503)
                    from .local_business_context import create_local_business_context
                    context = create_local_business_context(request, adapter=adapter)
                    if (context.actor.account_id, context.actor.session_id) != (actor["account_id"], actor.get("session_id")):
                        raise SystemManagementError("覆盖可信业务身份已变化", 1106, 409)
                return action(service, parsed, actor["account_id"], context)

            result = await run_in_threadpool(execute)
            data, status = result if writing and model in (_Submit, BandwidthSelectionInput) else (result, 200)
            return JSONResponse(status_code=status, content={"code": 0, "message": "success", "data": data})
        except (CoverageServiceError, identity.IdentityError, SystemManagementError) as exc:
            return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": getattr(exc, "data", None)})
        except (ValidationError, _RequestError):
            return JSONResponse(status_code=422, content={"code": 1001, "message": "冻结覆盖请求不符合契约", "data": None})

    @router.get("/jobs/{job_id}")
    async def job(job_id: str, request: Request):
        return await call(request, _Job, lambda service, query, actor, context: service.get_job(job_id,
            actor_id=actor, audit_context=context, **query.model_dump(exclude={"context"})))

    @router.post("/jobs/{job_id}/cancel")
    async def cancel(job_id: str, request: Request):
        return await call(request, _Cancel,
                          lambda service, body, actor, context: service.cancel(job_id, body.model_dump(), actor, audit_context=context), writing=True)

    @router.post("/{plan_id}/compute")
    async def compute(plan_id: str, request: Request):
        return await call(request, _Submit,
                          lambda service, body, actor, context: service.submit(_id(plan_id), body.model_dump(exclude_none=True), actor, audit_context=context), writing=True)

    @router.get("/{plan_id}/cache")
    async def cache(plan_id: str, request: Request):
        return await call(request, _Cache, lambda service, query, actor, context: service.cache(_id(plan_id),
            query.task_id, query.snapshot_id, _json(query.parameters),
            bandwidth_selection_id=query.bandwidth_selection_id, engine_version=query.engine_version, audit_context=context))

    @router.get("/{plan_id}/latest-cache")
    async def latest_cache(plan_id: str, request: Request):
        return await call(request, _Latest, lambda service, query, actor, context: service.latest_cache(
            _id(plan_id), query.task_id, query.snapshot_id, engine_version=query.engine_version, audit_context=context))

    @router.get("/{plan_id}/bandwidth-options")
    async def bandwidth_options(plan_id: str, request: Request):
        return await call(request, _BandwidthRead, lambda service, query, actor, context: service.bandwidth_options(
            _id(plan_id), query.task_id, query.snapshot_id, audit_context=context))

    @router.post("/{plan_id}/bandwidth-selections")
    async def save_bandwidth_selection(plan_id: str, request: Request):
        return await call(request, BandwidthSelectionInput, lambda service, body, actor, context:
            service.save_bandwidth_selection(_id(plan_id), body.model_dump(), actor, audit_context=context), writing=True)

    @router.get("/{plan_id}/bandwidth-selections/{saved_id}")
    async def get_bandwidth_selection(plan_id: str, saved_id: str, request: Request):
        return await call(request, _BandwidthRead, lambda service, query, actor, context: service.get_bandwidth_selection(
            _id(plan_id), query.task_id, query.snapshot_id, selection_id(saved_id), audit_context=context))

    return router
