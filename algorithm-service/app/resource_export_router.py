"""资源文件独立路由，POST 预检和下载均核验当前会话及 CSRF。"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from . import integration_identity_service as identity, resource_export_service as service
from .resource_dataset_service import ResourceDatasetError
from .resource_export_schemas import ResourceExportRequest

router = APIRouter(prefix="/api/v1/resource/export", tags=["resource-export"])


def _call(request, payload, download):
    try:
        identity.require(request, "resources.view", writing=True)
        query = ResourceExportRequest.model_validate(payload)
        if not download:
            return {"code": 0, "message": "success", "data": service.preview(query)}
        data, mime, name = service.export_file(query)
        return Response(data, media_type=mime, headers={"Content-Disposition": 'attachment; filename="' + name + '"',
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Resource-Revision": query.revision,
            "X-Data-Origin": "SYNTHETIC_INTEGRATION"})
    except (identity.IdentityError, ResourceDatasetError) as exc:
        return JSONResponse({"code": exc.code, "message": str(exc), "data": None}, status_code=exc.status)
    except ValidationError:
        return JSONResponse({"code": 1001, "message": "导出字段或范围无效", "data": None}, status_code=422)


@router.post("/preview")
def preview(payload: dict, request: Request):
    return _call(request, payload, False)


@router.post("")
def export(payload: dict, request: Request):
    return _call(request, payload, True)
