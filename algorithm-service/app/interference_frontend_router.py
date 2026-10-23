"""P03 独立路由；主入口及迁移由总集成注册。"""
import json
import re
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError
from starlette.concurrency import run_in_threadpool

from . import integration_identity_service as identity
from . import interference_frontend_service as service
from .interference_frontend_schemas import PathIdentifier, SceneDetailQuery, ScenePage, SceneReceiptQuery, SceneSave
from .task_input_schemas import InputModel

router = APIRouter(prefix="/api/v1/interference", tags=["interference-scenes"])
identifier = TypeAdapter(PathIdentifier)


class SceneEmptyQuery(InputModel):
    pass


def _reply(action):
    try:
        return {"code": 0, "message": "ok", "data": action()}
    except (identity.IdentityError, service.InterferenceSceneError) as exc:
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": None})
    except (ValidationError, ValueError, UnicodeError):
        return JSONResponse(status_code=422, content={"code": 1001, "message": "干扰场景请求不符合契约", "data": None})


def _query(request, model, *, history=False):
    values = {}
    for key, value in request.query_params.multi_items():
        if key in values or history and key == "search":
            raise ValueError("重复或非法查询字段")
        if key in ("page", "page_size"):
            if not re.fullmatch(r"[1-9][0-9]*", value):
                raise ValueError("分页必须为正整数")
            value = int(value)
        values[key] = value
    return model.model_validate(values)


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("JSON 字段重复")
        result[key] = value
    return result


def _nonfinite(value):
    raise ValueError("非有限 JSON 数值")


@router.put("/scenes/{scene_id}")
async def save(scene_id: str, request: Request):
    # 先捕获传输体，权限与结构验证均在持久化服务之前执行。
    raw = await request.body()

    def action():
        if not request.headers.get("x-csrf-token", "").isascii():
            service.fail("CSRF 校验失败", 1105, 403)
        actor = identity.require(request, "planning.save", writing=True)
        identifier.validate_python(scene_id)
        _query(request, SceneEmptyQuery)
        payload = SceneSave.model_validate(json.loads(raw, object_pairs_hook=_pairs, parse_constant=_nonfinite))
        return service.save_scene(scene_id, payload, actor["account_id"])
    return await run_in_threadpool(_reply, action)


@router.get("/scenes")
def listing(request: Request):
    def action():
        identity.require(request, "planning.view")
        return service.list_scenes(_query(request, ScenePage))
    return _reply(action)


@router.get("/scenes/{scene_id}/versions")
def versions(scene_id: str, request: Request):
    def action():
        identity.require(request, "planning.view")
        identifier.validate_python(scene_id)
        return service.scene_versions(scene_id, _query(request, ScenePage, history=True))
    return _reply(action)


@router.get("/scenes/{scene_id}")
def detail(scene_id: str, request: Request):
    def action():
        identity.require(request, "planning.view")
        identifier.validate_python(scene_id)
        return service.scene_detail(scene_id, _query(request, SceneDetailQuery))
    return _reply(action)


@router.get("/scene-operations/{request_id}")
def receipt(request_id: str, request: Request):
    def action():
        actor = identity.require(request, "planning.view")
        identifier.validate_python(request_id)
        return service.scene_receipt(request_id, _query(request, SceneReceiptQuery), actor["account_id"])
    return _reply(action)
