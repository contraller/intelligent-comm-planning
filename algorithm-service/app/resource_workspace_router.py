"""完整资源编辑上下文与增量保存入口。"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import integration_identity_service as identity, resource_workspace_service as service
from .resource_dataset_service import ResourceDatasetError
from .resource_workspace_schemas import WorkspaceChanges, WorkspaceQuery

router = APIRouter(prefix="/api/v1/resource", tags=["resource-workspace"])


def _call(request, action):
    try:
        identity.require(request, "resources.view")
        return {"code": 0, "message": "success", "data": action()}
    except (identity.IdentityError, ResourceDatasetError) as exc:
        return JSONResponse({"code": exc.code, "message": str(exc), "data": None}, status_code=exc.status)
    except ValidationError:
        return JSONResponse({"code": 1001, "message": "资源编辑字段无效", "data": None}, status_code=422)


@router.get("/edit-context")
def context(request: Request):
    def action():
        if len(request.query_params.multi_items()) != len(set(request.query_params.keys())):
            raise ResourceDatasetError("查询字段不能重复", 1001, 422)
        query = WorkspaceQuery.model_validate(dict(request.query_params))
        if query.context == "gis":
            identity.require(request, "situation.view")
        return service.context(query)
    return _call(request, action)


@router.post("/workspace/changes")
def changes(payload: dict, request: Request):
    def action():
        query = WorkspaceChanges.model_validate(payload)
        if query.context == "gis":
            identity.require(request, "situation.view")
        # 不把资源新增权限当作任意设备参数或观测写权限。
        keys = {key for key, value in query.changes.items() if value}
        needed = set()
        if keys & {"newStations", "newDevices", "newInterferences", "newCandidateLinks"}:
            needed.add("resources.create")
        if keys & {"stations", "devices", "interferences", "candidateLinks"} or not needed:
            needed.add("resources.workspace.edit")
        for permission in needed:
            identity.require(request, permission, writing=True)
        actor = identity.require(request, writing=True)
        return service.save(query, actor["account_id"])
    return _call(request, action)
