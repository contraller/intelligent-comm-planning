"""可独立挂载的配置受理路由；主入口由总集成接入。"""
from __future__ import annotations

import re

from fastapi import APIRouter, Body, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.exc import SQLAlchemyError

from .database import DatabaseConfigurationError
from . import integration_identity_service as identity
from .resource_dataset_service import ResourceDatasetError
from . import device_configuration_service as service
from .device_configuration_schemas import (
    ConfigurationSubmission, ConfigurationValidation, Identifier, RequestId, check_request_id,
)


class _EnvelopeRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def wrapped(request):
            try:
                return await handler(request)
            except RequestValidationError:
                return JSONResponse(status_code=422, content={"code": 1001, "message": "请求 JSON 或字段无效", "data": None})
        return wrapped


router = APIRouter(prefix="/api/v1/device-configurations", tags=["device-configurations"], route_class=_EnvelopeRoute)


def _authorize(request, writing):
    identity.enabled()
    if not request.cookies.get(identity.COOKIE):
        raise identity.IdentityError("请先建立联调会话", 1101, 401)
    actor = identity.require(request, "resources.view")
    if request.headers.get("x-session-id") != actor["session_id"]:
        raise identity.IdentityError("请求会话已变化", 1106, 409)
    if writing:
        # 共享 CSRF 比较只接受 ASCII，非 ASCII 挑战直接按拒绝处理。
        if not request.headers.get("x-csrf-token", "").isascii():
            raise identity.IdentityError("联调 CSRF 校验失败", 1105, 403)
        identity.require(request, "resources.device.edit", writing=True)
    return actor


def _query(request, allowed, required):
    pairs = list(request.query_params.multi_items())
    values = dict(pairs)
    if len(values) != len(pairs) or set(values) - set(allowed) or set(required) - set(values):
        raise service.ConfigurationError("查询参数缺失、重复或未约定")
    if "context" in values and values["context"] != "ledger":
        raise service.ConfigurationError("仅支持 ledger 配置上下文")
    return values


def _identifier(value):
    return TypeAdapter(Identifier).validate_python(value)


def _call(request, response, operation, *, writing=False):
    try:
        actor = _authorize(request, writing)
        return {"code": 0, "message": "success", "data": operation(actor)}
    except (identity.IdentityError, ResourceDatasetError, service.ConfigurationError) as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except ValidationError as exc:
        response.status_code = 422
        return {"code": 1001, "message": "配置请求字段无效", "data": {"issues": [
            {"field": ".".join(map(str, issue["loc"])), "message": issue["msg"]} for issue in exc.errors()
        ]}}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "数据库配置缺失或无效", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "联调会话数据库不可用", "data": None}


@router.get("/context")
def context(request: Request, response: Response):
    def operation(actor):
        query = _query(request, ("context", "device_id", "revision"), ("context", "device_id", "revision"))
        return service.load_context(_identifier(query["revision"]), _identifier(query["device_id"]))
    return _call(request, response, operation)


@router.post("/validate")
def validate(request: Request, response: Response, payload: dict = Body(...)):
    def operation(actor):
        _query(request, (), ())
        return service.validate_request(ConfigurationValidation.model_validate(payload))
    return _call(request, response, operation, writing=True)


@router.post("")
def submit(request: Request, response: Response, payload: dict = Body(...)):
    def operation(actor):
        _query(request, (), ())
        return service.submit_request(ConfigurationSubmission.model_validate(payload), actor)
    return _call(request, response, operation, writing=True)


@router.get("/history")
def history(request: Request, response: Response):
    def operation(actor):
        query = _query(request, ("context", "device_id", "page", "page_size"), ("context",))
        for name, default, maximum in (("page", "1", None), ("page_size", "20", 100)):
            value = query.get(name, default)
            if not re.fullmatch(r"[0-9]{1,10}", value) or int(value) < 1 or maximum and int(value) > maximum:
                raise service.ConfigurationError("分页参数无效")
            query[name] = int(value)
        device_id = _identifier(query["device_id"]) if "device_id" in query else None
        return service.query_history(actor["account_id"], device_id=device_id, page=query["page"], page_size=query["page_size"])
    return _call(request, response, operation)


@router.get("/{request_id}")
def detail(request_id: str, request: Request, response: Response):
    def operation(actor):
        _query(request, ("context",), ("context",))
        try:
            key = check_request_id(TypeAdapter(RequestId).validate_python(request_id))
        except ValueError as exc:
            raise service.ConfigurationError("配置请求编号无效") from exc
        return service.get_request(key, actor["account_id"])
    return _call(request, response, operation)
