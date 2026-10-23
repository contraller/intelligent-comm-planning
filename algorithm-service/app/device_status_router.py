"""可独立装配的 P06 状态快照接口，默认联调权限不扩权。"""
from __future__ import annotations

import re
from fastapi import APIRouter, Body, Request, Response
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.exc import SQLAlchemyError

from . import integration_identity_service as identity
from .database import DatabaseConfigurationError
from .resource_dataset_service import ResourceDatasetError
from .device_configuration_router import _EnvelopeRoute
from .device_configuration_schemas import RequestId, check_request_id
from .task_input_schemas import Identifier
from . import device_status_service as service
from .device_status_schemas import DeviceStatusImport


def require_actor(request, permission, writing=False):
    identity.enabled()
    if not request.cookies.get(identity.COOKIE):
        raise identity.IdentityError("请先建立已认证会话", 1101, 401)
    actor = identity.require(request, "resources.view")
    if request.headers.get("x-session-id") != actor["session_id"]:
        raise identity.IdentityError("请求会话已变化", 1106, 409)
    if writing and not request.headers.get("x-csrf-token", "").isascii():
        raise identity.IdentityError("CSRF 校验失败", 1105, 403)
    identity.require(request, permission, writing=writing)
    return actor


def _query(request, allowed, required=("context",)):
    pairs = list(request.query_params.multi_items())
    result = dict(pairs)
    if len(result) != len(pairs) or set(result) - set(allowed) or set(required) - set(result):
        raise service.DeviceStatusError("查询参数缺失、重复或未约定")
    if "context" in result and result["context"] != "ledger":
        raise service.DeviceStatusError("仅支持 ledger 快照上下文")
    for key, value in result.items():
        if key not in ("context", "page", "page_size", "status_filter"):
            TypeAdapter(Identifier).validate_python(value)
    return result


def _page(query):
    result = {}
    for key, default, maximum in (("page", "1", 9999999999), ("page_size", "20", 100)):
        value = query.get(key, default)
        if not re.fullmatch(r"[0-9]{1,10}", value) or not 1 <= int(value) <= maximum:
            raise service.DeviceStatusError("分页参数无效")
        result[key] = int(value)
    return result


def create_device_status_router(actor_resolver=require_actor):
    result = APIRouter(prefix="/api/v1/device-status", tags=["device-status"], route_class=_EnvelopeRoute)

    def call(request, response, operation, writing=False):
        try:
            actor = actor_resolver(request, "resources.view", writing=False)
            if writing:
                actor = actor_resolver(request, "resources.device.status.import", writing=True)
            if not isinstance(actor, dict) or not actor.get("account_id"):
                raise service.DeviceStatusError("可信身份接线未返回账号", 5001, 503)
            return {"code": 0, "message": "success", "data": operation(actor)}
        except (service.DeviceStatusError, identity.IdentityError, ResourceDatasetError) as exc:
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": None}
        except ValidationError:
            response.status_code = 422
            return {"code": 1001, "message": "设备状态字段无效", "data": None}
        except DatabaseConfigurationError:
            response.status_code = 503
            return {"code": 5001, "message": "数据库配置缺失", "data": None}
        except SQLAlchemyError:
            response.status_code = 503
            return {"code": 5002, "message": "数据库操作失败", "data": None}
        except Exception as exc:
            if getattr(exc, "code", None) not in (1101, 1104, 1105, 1106) or getattr(exc, "status", None) not in (401, 403, 409, 429):
                raise
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": getattr(exc, "data", None)}

    @result.post("/imports")
    def import_status(request: Request, response: Response, payload: dict = Body(...)):
        def operation(actor):
            _query(request, (), ())
            return service.import_snapshot(DeviceStatusImport.model_validate(payload), actor["account_id"])
        return call(request, response, operation, True)

    @result.get("/imports/{request_id}")
    def operation_detail(request_id: str, request: Request, response: Response):
        def operation(actor):
            _query(request, ("context",))
            try:
                key = check_request_id(TypeAdapter(RequestId).validate_python(request_id))
            except ValueError as exc:
                raise service.DeviceStatusError("请求编号无效") from exc
            return service.get_operation(key, actor["account_id"])
        return call(request, response, operation)

    @result.get("/snapshots")
    def snapshots(request: Request, response: Response):
        def operation(actor):
            query = _query(request, ("context", "resource_revision", "page", "page_size"))
            return service.list_snapshots(**_page(query), resource_revision=query.get("resource_revision"))
        return call(request, response, operation)

    @result.get("/snapshots/{snapshot_id}")
    def snapshot(snapshot_id: str, request: Request, response: Response):
        def operation(actor):
            TypeAdapter(Identifier).validate_python(snapshot_id)
            query = _query(request, ("context", "snapshot_revision"), ("context", "snapshot_revision"))
            return service.get_snapshot(snapshot_id, query["snapshot_revision"])
        return call(request, response, operation)

    @result.get("/snapshots/{snapshot_id}/devices")
    def devices(snapshot_id: str, request: Request, response: Response):
        def operation(actor):
            TypeAdapter(Identifier).validate_python(snapshot_id)
            query = _query(request, ("context", "snapshot_revision", "device_id", "status_filter", "page", "page_size"),
                ("context", "snapshot_revision"))
            status = query.get("status_filter", "ALL")
            if status not in ("ALL", "NORMAL", "FAULT", "OFFLINE", "UNKNOWN"):
                raise service.DeviceStatusError("状态筛选值无效")
            return service.query_devices(snapshot_id, query["snapshot_revision"], device_id=query.get("device_id"),
                status_filter=status, **_page(query))
        return call(request, response, operation)

    return result


router = create_device_status_router()
