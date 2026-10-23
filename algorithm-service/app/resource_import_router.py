"""资源文件预检和提交均校验专项权限、会话与 CSRF。"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from urllib.parse import quote

from . import integration_identity_service as identity, resource_import_service as service
from .resource_dataset_service import ResourceDatasetError
from .resource_import_schemas import ImportCommit, ImportPreview, ImportTemplate

router = APIRouter(prefix="/api/v1/resource/import", tags=["resource-import"])


def _call(request, action, context=None):
    try:
        identity.require(request, "resources.view")
        actor = identity.require(request, "resources.import", writing=request.method != "GET")
        if (context if context is not None else request.query_params.get("context")) == "gis":
            identity.require(request, "situation.view")
        return action(actor)
    except (identity.IdentityError, ResourceDatasetError) as exc:
        return JSONResponse({"code": exc.code, "message": str(exc), "data": None}, status_code=exc.status)
    except ValidationError:
        return JSONResponse({"code": 1001, "message": "导入字段、类型或大小无效", "data": None}, status_code=422)


@router.get("/template")
def template(request: Request):
    def action(actor):
        if len(request.query_params.multi_items()) != len(set(request.query_params.keys())):
            raise ResourceDatasetError("查询字段不能重复", 1001, 422)
        query = ImportTemplate.model_validate(dict(request.query_params))
        data, mime, name = service.template(query)
        # Header 使用 ASCII 回退名及 UTF-8 扩展，中文模板名不能直接编码 latin-1。
        disposition = 'attachment; filename="resource-template.' + query.format + '"; filename*=UTF-8\'\'' + quote(name, safe="")
        return Response(data, media_type=mime, headers={"Content-Disposition": disposition,
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Resource-Revision": query.revision,
            "X-Data-Origin": "SYNTHETIC_INTEGRATION"})
    return _call(request, action)


@router.post("/preview")
def preview(payload: dict, request: Request):
    return _call(request, lambda actor: {"code": 0, "message": "success", "data": service.preview(ImportPreview.model_validate(payload))}, payload.get("context"))


@router.post("/commit")
def commit(payload: dict, request: Request):
    return _call(request, lambda actor: {"code": 0, "message": "success",
        "data": service.commit(ImportCommit.model_validate(payload), actor["account_id"])}, payload.get("context"))
