"""可独立挂载的 GIS 方案路由；主入口接线由总集成完成。"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.exc import SQLAlchemyError

from . import gis_plan_service as service, integration_identity_service as identity
from .database import DatabaseConfigurationError
from .gis_plan_schemas import GisPathQuery, GisPlanQuery
from .resource_dataset_service import ResourceDatasetError
from .task_input_schemas import Identifier


router = APIRouter(prefix="/api/v1/gis/plans", tags=["GIS frozen plans"])
_identifier = TypeAdapter(Identifier)


def _respond(request, plan_id, kind, link_id=None):
    try:
        identity.require(request, "situation.view")
        if request.headers.get("content-length", "0") != "0" or request.headers.get("transfer-encoding"):
            raise service.GisPlanError("只读查询不接受请求体", 1001, 422)
        pairs = list(request.query_params.multi_items())
        if len({key for key, _ in pairs}) != len(pairs):
            raise service.GisPlanError("查询字段不得重复", 1001, 422)
        query_type = GisPathQuery if kind == "paths" else GisPlanQuery
        query = query_type.model_validate(dict(pairs))
        _identifier.validate_python(plan_id)
        if kind != "network" and query.snapshot_id is None:
            raise service.GisPlanError("详情查询必须提供快照标识", 1001, 422)
        if kind == "network":
            data = service.network(plan_id, query.task_id, query.snapshot_id)
        elif kind == "links":
            _identifier.validate_python(link_id)
            data = service.link_detail(plan_id, query.task_id, query.snapshot_id, link_id)
        else:
            data = service.paths(plan_id, query.task_id, query.snapshot_id, query.demand_id)
        return {"code": 0, "message": "success", "data": data}
    except (service.GisPlanError, identity.IdentityError, ResourceDatasetError) as exc:
        return JSONResponse({"code": exc.code, "message": str(exc), "data": None}, status_code=exc.status)
    except ValidationError:
        return JSONResponse({"code": 1001, "message": "GIS 查询参数无效", "data": None}, status_code=422)
    except DatabaseConfigurationError:
        return JSONResponse({"code": 5001, "message": "数据库未配置", "data": None}, status_code=503)
    except SQLAlchemyError:
        return JSONResponse({"code": 5002, "message": "数据库读取失败", "data": None}, status_code=503)


@router.get("/{plan_id}/network")
def network(request: Request, plan_id: str):
    return _respond(request, plan_id, "network")


@router.get("/{plan_id}/links/{link_id}")
def link_detail(request: Request, plan_id: str, link_id: str):
    return _respond(request, plan_id, "links", link_id)


@router.get("/{plan_id}/paths")
def paths(request: Request, plan_id: str):
    return _respond(request, plan_id, "paths")
