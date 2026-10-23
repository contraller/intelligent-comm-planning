"""独立系统路由；主会话提供真实 authorize，不在本模块挂载公共入口。"""
from typing import Any

from fastapi import APIRouter, Body, Request, Response
from sqlalchemy.exc import SQLAlchemyError

from .system_audit_service import append_system_audit
from .system_management_schemas import SystemManagementError


def _query(request):
    if len(request.query_params.multi_items()) != len(set(request.query_params.keys())):
        raise SystemManagementError("查询字段不能重复")
    values = dict(request.query_params)
    for key in ("pageNum", "pageSize"):
        if key in values:
            if not values[key].isascii() or not values[key].isdecimal() or len(values[key]) > 9:
                raise SystemManagementError("分页参数无效")
            values[key] = int(values[key])
    for key in ("enabled", "includeArchived"):
        if key in values:
            if values[key] not in ("true", "false"):
                raise SystemManagementError("布尔查询字段无效")
            values[key] = values[key] == "true"
    return values


def create_system_management_router(*, authorize, service) -> APIRouter:
    router = APIRouter(prefix="/api/v1/system", tags=["local-system-management"])

    def invoke(response, call):
        response.headers["Cache-Control"] = "no-store"
        try:
            return {"code": 0, "message": "success", "data": call()}
        except SystemManagementError as error:
            response.status_code = error.status
            return {"code": error.code, "message": str(error), "data": error.data}
        except SQLAlchemyError:
            response.status_code = 503
            return {"code": 5002, "message": "系统数据库不可用", "data": None}

    def list_endpoint(kind, permission):
        def endpoint(request: Request, response: Response):
            return invoke(response, lambda: service.read(kind, authorize(request, permission), query=_query(request)))
        return endpoint

    def detail_endpoint(kind, permission):
        def endpoint(object_id: str, request: Request, response: Response):
            return invoke(response, lambda: service.read(kind, authorize(request, permission), object_id=object_id, query=_query(request)))
        return endpoint

    def mutation_endpoint(action, permission, *, detail=False):
        def run(request, response, body, object_id=""):
            def operation():
                actor = None
                try:
                    actor = authorize(request, permission, writing=True)
                    return service.execute(action, actor, body, object_id=object_id)
                except SystemManagementError as error:
                    if actor is None:
                        try:
                            actor = authorize(request)
                        except SystemManagementError:
                            pass
                    # 失败审计独立提交；不记录请求体，不以客户端结果作为依据。
                    try:
                        with service.factory() as session, session.begin():
                            append_system_audit(session, actor, now=int(service.clock()), action=action,
                                outcome="DENIED" if error.status in (401, 403) else "FAILED", error_code=str(error.code))
                    except (SQLAlchemyError, SystemManagementError):
                        pass
                    raise
            return invoke(response, operation)

        if detail:
            def endpoint(object_id: str, request: Request, response: Response, body: Any = Body(...)):
                return run(request, response, body, object_id)
        else:
            def endpoint(request: Request, response: Response, body: Any = Body(...)):
                return run(request, response, body)
        return endpoint

    def runtime_endpoint(request: Request, response: Response):
        def operation():
            actor = authorize(request, None)
            if request.query_params:
                raise SystemManagementError("运行参数不接受查询字段")
            return service.runtime_parameters(actor)
        return invoke(response, operation)

    router.add_api_route("/runtime-parameters", runtime_endpoint, methods=["GET"])
    router.add_api_route("/options", list_endpoint("options", "system.view"), methods=["GET"])
    for kind, permission in (("accounts", "system.accounts"), ("roles", "system.roles"), ("parameters", "system.parameters"), ("logs", "system.logs")):
        router.add_api_route("/" + kind, list_endpoint(kind, permission), methods=["GET"])
        router.add_api_route("/" + kind + "/{object_id}", detail_endpoint(kind, permission), methods=["GET"])
    router.add_api_route("/operations/{object_id}", detail_endpoint("operations", None), methods=["GET"])
    for path, action, permission, method, detail in (
        ("/accounts", "account.create", "system.accounts", "POST", False),
        ("/accounts/{object_id}", "account.update", "system.accounts", "PUT", True),
        ("/accounts/{object_id}/state", "account.state", "system.accounts", "POST", True),
        ("/accounts/{object_id}/password", "account.password", "system.accounts", "POST", True),
        ("/roles", "role.create", "system.roles", "POST", False),
        ("/roles/{object_id}", "role.update", "system.roles", "PUT", True),
        ("/parameters/{object_id}", "parameter.save", "system.parameters", "PUT", True),
        ("/actions/reset-parameters", "parameter.reset", "system.parameters", "POST", False),
        ("/actions/archive-logs", "logs.archive", "system.logs", "POST", False),
    ):
        router.add_api_route(path, mutation_endpoint(action, permission, detail=detail), methods=[method])
    return router
