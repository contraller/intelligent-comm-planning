"""任务冻结态势只读查询，查询与当前资源写入彼此独立。"""
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError, TypeAdapter
from sqlalchemy.exc import SQLAlchemyError

from . import integration_identity_service as identity, task_gis_service as service
from .database import DatabaseConfigurationError
from .resource_dataset_service import ResourceDatasetError
from .task_input_schemas import Identifier
from .task_input_service import TaskInputError

router = APIRouter(prefix="/api/v1/task-inputs", tags=["GIS frozen tasks"])
_identifier = TypeAdapter(Identifier)


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context: Literal["gis", "planning"]
    revision: Identifier


@router.get("/{task_id}/gis-snapshot")
def get_snapshot(request: Request, task_id: str):
    try:
        identity.require(request, "situation.view")
        identity.require(request, "planning.view")
        if request.headers.get("content-length", "0") != "0" or request.headers.get("transfer-encoding"):
            return JSONResponse({"code": 1001, "message": "只读任务查询不接受请求体", "data": None}, status_code=422)
        pairs = list(request.query_params.multi_items())
        if len({key for key, _ in pairs}) != len(pairs):
            return JSONResponse({"code": 1001, "message": "查询字段不得重复", "data": None}, status_code=422)
        query = Query.model_validate(dict(pairs))
        _identifier.validate_python(task_id)
        data = service.snapshot(task_id, query.revision, query.context)
        return {"code": 0, "message": "success", "data": data}
    except (TaskInputError, ResourceDatasetError, identity.IdentityError) as exc:
        return JSONResponse({"code": exc.code, "message": str(exc), "data": getattr(exc, "data", None)}, status_code=exc.status)
    except ValidationError:
        return JSONResponse({"code": 1001, "message": "任务态势查询参数无效", "data": None}, status_code=422)
    except DatabaseConfigurationError:
        return JSONResponse({"code": 5001, "message": "DATABASE_URL 未配置", "data": None}, status_code=503)
    except SQLAlchemyError:
        return JSONResponse({"code": 5002, "message": "任务冻结态势读取失败", "data": None}, status_code=503)
