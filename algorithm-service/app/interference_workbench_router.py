"""R2 专用装配边界：身份及worker由主入口注入，路由不隐式启动工作。"""
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from . import integration_identity_service as identity
from .interference_frontend_router import SceneEmptyQuery, _nonfinite, _pairs, _query, identifier
from .interference_workbench_schemas import (
    AdoptionCancel, AdoptionSubmit, ContextQuery, OperationQuery, PreviewQuery,
    RunCancel, RunQuery, RunSubmit, SourceQuery, TaskQuery,
)
from .interference_workbench_service import WorkbenchError

router = APIRouter(prefix="/api/v1/interference/workbench", tags=["interference-workbench"])


def _reply(request, action, *, writing=False, adoption=False):
    try:
        permissions = ("planning.view", "situation.view")
        if writing:
            permissions += ("planning.execute",)
        if adoption:
            permissions += ("planning.save",)
        if writing and not request.headers.get("x-csrf-token", "").isascii():
            raise WorkbenchError("CSRF校验失败", 1105, 403)
        authorize = getattr(request.app.state, "authorize_interference", None)
        if authorize is None:
            actor = None
            for permission in permissions:
                actor = identity.require(request, permission, writing=writing)
        else:
            actor = authorize(request, permissions, writing)
        if not isinstance(actor, dict) or not actor.get("account_id") or not set(permissions).issubset(actor.get("permissions", ())):
            raise WorkbenchError("服务端身份没有授予所需权限", 1103, 403)
        service = getattr(request.app.state, "interference_workbench", None)
        if service is None:
            raise WorkbenchError("干扰工作流未装配", 5003, 503)
        return {"code": 0, "message": "ok", "data": action(service, actor)}
    except (WorkbenchError, identity.IdentityError) as exc:
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": None})
    except (ValidationError, ValueError, UnicodeError):
        return JSONResponse(status_code=422, content={"code": 1001, "message": "干扰工作流请求不符合契约", "data": None})


def _path(value):
    return identifier.validate_python(value)


def _body(raw, request, model):
    _query(request, SceneEmptyQuery)
    return model.model_validate(json.loads(raw, object_pairs_hook=_pairs, parse_constant=_nonfinite))


@router.get("")
def context(request: Request):
    return _reply(request, lambda service, actor: service.context(_query(request, ContextQuery), actor))


@router.get("/sources")
def sources(request: Request):
    return _reply(request, lambda service, actor: service.sources(_query(request, SourceQuery)))


@router.post("/runs")
async def submit_run(request: Request):
    raw = await request.body()
    return await run_in_threadpool(_reply, request,
        lambda service, actor: service.submit_run(_body(raw, request, RunSubmit), actor), writing=True)


@router.get("/runs")
def runs(request: Request):
    return _reply(request, lambda service, actor: service.runs(_query(request, RunQuery)))


@router.get("/runs/{run_id}/progress")
def progress(run_id: str, request: Request):
    return _reply(request, lambda service, actor: service.progress(_path(run_id), _query(request, TaskQuery)))


@router.get("/runs/{run_id}")
def detail(run_id: str, request: Request):
    return _reply(request, lambda service, actor: service.detail(_path(run_id), _query(request, TaskQuery)))


@router.get("/runs/{run_id}/measures/{measure_id}/preview")
def preview(run_id: str, measure_id: str, request: Request):
    def action(service, actor):
        # HTTP查询字符串只对明确整数键转换，不放宽正文的StrictInt。
        values = {}
        for key, value in request.query_params.multi_items():
            if key in values:
                raise ValueError("重复查询字段")
            if key == "expected_run_version":
                if not value.isascii() or not value.isdigit() or value.startswith("0"):
                    raise ValueError("版本必须为正整数")
                value = int(value)
            values[key] = value
        return service.preview(_path(run_id), _path(measure_id), PreviewQuery.model_validate(values))
    return _reply(request, action)


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str, request: Request):
    raw = await request.body()
    return await run_in_threadpool(_reply, request,
        lambda service, actor: service.cancel_run(_path(run_id), _body(raw, request, RunCancel), actor), writing=True)


@router.post("/adoptions")
async def adopt(request: Request):
    raw = await request.body()
    return await run_in_threadpool(_reply, request,
        lambda service, actor: service.replanner.submit(_body(raw, request, AdoptionSubmit), actor), writing=True, adoption=True)


@router.get("/adoptions/{adoption_id}")
def adoption(adoption_id: str, request: Request):
    return _reply(request, lambda service, actor: service.replanner.detail(_path(adoption_id), _query(request, TaskQuery)))


@router.post("/adoptions/{adoption_id}/cancel")
async def cancel_adoption(adoption_id: str, request: Request):
    raw = await request.body()
    return await run_in_threadpool(_reply, request,
        lambda service, actor: service.replanner.cancel(_path(adoption_id), _body(raw, request, AdoptionCancel), actor),
        writing=True, adoption=True)


@router.get("/operations/{request_id}")
def operation(request_id: str, request: Request):
    return _reply(request, lambda service, actor: service.operation(_path(request_id), _query(request, OperationQuery), actor))
