"""资源恢复需要明确的当前版本、请求号和独立权限。"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import integration_identity_service as identity
from . import resource_reset_service as service
from .resource_dataset_service import ResourceDatasetError
from .task_input_schemas import Identifier, InputModel

router = APIRouter(prefix="/api/v1/resource", tags=["resource-reset"])


class ResourceReset(InputModel):
    base_revision: Identifier
    request_id: Identifier


@router.post("/reset")
def restore(body: dict, request: Request):
    try:
        identity.require(request, "resources.view")
        actor = identity.require(request, "resources.reset", writing=True)
        if request.query_params:
            raise ResourceDatasetError("资源恢复不接受查询字段", 1001, 422)
        query = ResourceReset.model_validate(body)
        data = service.restore(query.base_revision, query.request_id, actor["account_id"])
        return {"code": 0, "message": "success", "data": data}
    except (identity.IdentityError, ResourceDatasetError) as error:
        return JSONResponse({"code": error.code, "message": str(error), "data": None}, status_code=error.status)
    except ValidationError:
        return JSONResponse({"code": 1001, "message": "资源恢复字段无效", "data": None}, status_code=422)
