"""任务模板和原文件预检的独立路由，由总集成注入可信身份。"""
from __future__ import annotations

from fastapi import APIRouter, Body, Request, Response
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from .database import DatabaseConfigurationError
from .integration_identity_service import IdentityError
from .system_management_schemas import SystemManagementError
from .device_configuration_router import _EnvelopeRoute
from .task_input_service import TaskInputError
from .task_file_parser import TaskFileError
from .task_file_service import (TaskFilePreviewRequest, TaskFileTemplateRequest,
                                preview_task_files, task_file_template)


def create_task_file_router(actor_resolver, *, factory=None):
    router = APIRouter(prefix="/api/v1/task-files", tags=["task-files"], route_class=_EnvelopeRoute)

    def call(request, response, payload, schema, operation):
        try:
            # 两个POST均只读，但仍校验当前会话和CSRF；不授予保存/执行权限。
            actor = actor_resolver(request, "planning.view", writing=True)
            if not isinstance(actor, dict) or not actor.get("account_id"):
                raise TaskInputError(5001, "可信身份接线未返回账号", 503)
            if request.query_params:
                raise TaskInputError(1001, "任务文件接口不接受查询参数", 422)
            value = schema.model_validate(payload)
            if value.context == "gis":
                actor_resolver(request, "situation.view", writing=True)
            return operation(value)
        except ValidationError:
            response.status_code = 422
            return {"code": 1001, "message": "任务文件请求字段无效", "data": None}
        except DatabaseConfigurationError:
            response.status_code = 503
            return {"code": 5001, "message": "数据库配置缺失", "data": None}
        except SQLAlchemyError:
            response.status_code = 503
            return {"code": 5002, "message": "数据库操作失败", "data": None}
        except TaskFileError as exc:
            response.status_code = 422
            return {"code": 1001, "message": str(exc), "data": {"fileCode": exc.code}}
        except (IdentityError, SystemManagementError, TaskInputError) as exc:
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": getattr(exc, "data", None)}

    @router.post("/preview")
    def preview(request: Request, response: Response, payload: dict = Body(...)):
        return call(request, response, payload, TaskFilePreviewRequest,
                    lambda value: {"code": 0, "message": "success", "data": preview_task_files(value, factory=factory)})

    @router.post("/template")
    def template(request: Request, response: Response, payload: dict = Body(...)):
        def download(value):
            file = task_file_template(value)
            name = "task-template.xlsx" if value.format == "xlsx" else value.kind + ".csv"
            return Response(content=file["bytes"], media_type=file["mime"],
                headers={"Content-Disposition": f'attachment; filename="{name}"', "X-Content-Type-Options": "nosniff"})
        return call(request, response, payload, TaskFileTemplateRequest, download)

    return router
