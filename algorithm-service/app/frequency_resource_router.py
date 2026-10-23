"""可独立挂载的频点路由；权限与异常包络不依赖主入口接线。"""
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import frequency_resource_service as service
from . import integration_identity_service as identity
from . import resource_dataset_service as datasets
from .database import DatabaseConfigurationError
from .frequency_resource_schemas import (
    FrequencyDisableChange, FrequencyDisableValidation, FrequencyResourceQuery,
)
from sqlalchemy.exc import SQLAlchemyError


router = APIRouter(prefix="/api/v1/resource/frequency-resources", tags=["frequency-resources"])


def _bad_request():
    raise datasets.ResourceDatasetError("频点请求结构不符合停用契约", 1001, 422)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _bad_request()
        result[key] = value
    return result


async def _body(request):
    if request.query_params:
        _bad_request()
    try:
        value = json.loads(await request.body(), object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError, RecursionError):
        _bad_request()
    if not isinstance(value, dict):
        _bad_request()
    return value


async def _call(request: Request, model, action, *, writing=False):
    try:
        identity.require(request, "resources.view")
        if writing and not request.headers.get("x-csrf-token", "").isascii():
            raise identity.IdentityError("联调 CSRF 校验失败", 1105, 403)
        actor = identity.require(request, "resources.frequency.disable", writing=True) if writing else None
        if writing:
            value = await _body(request)
        else:
            pairs = list(request.query_params.multi_items())
            if len({key for key, _ in pairs}) != len(pairs) or await request.body():
                _bad_request()
            value = dict(pairs)
        parsed = model.model_validate(value)
        data = action(parsed, actor["account_id"]) if model is FrequencyDisableChange else action(parsed)
        return {"code": 0, "message": "success", "data": data}
    except ValidationError:
        return JSONResponse(status_code=422, content={"code": 1001, "message": "频点请求字段校验失败", "data": None})
    except (identity.IdentityError, datasets.ResourceDatasetError) as error:
        return JSONResponse(status_code=error.status, content={"code": error.code, "message": str(error), "data": None})
    except DatabaseConfigurationError:
        return JSONResponse(status_code=503, content={"code": 5001, "message": "DATABASE_URL 未配置", "data": None})
    except SQLAlchemyError:
        return JSONResponse(status_code=503, content={"code": 5002, "message": "资源数据库不可用", "data": None})


@router.get("")
async def load_frequency_resources(request: Request):
    return await _call(request, FrequencyResourceQuery, service.load)


@router.post("/disable/validate")
async def validate_frequency_disable(request: Request):
    return await _call(request, FrequencyDisableValidation, service.validate_disable, writing=True)


@router.post("/disable")
async def disable_frequency_resources(request: Request):
    return await _call(request, FrequencyDisableChange, service.disable, writing=True)
