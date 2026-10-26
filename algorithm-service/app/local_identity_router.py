"""正式本地认证专用 router；由主会话选择装配，不自动激活。"""
from typing import Any

from fastapi import APIRouter, Body, Request, Response
from sqlalchemy.exc import SQLAlchemyError

from .local_identity_schemas import EmptyRequest
from .local_identity_service import CHALLENGE_COOKIE, SESSION_COOKIE
from .system_management_schemas import SystemManagementError, parse_request


def create_local_identity_router(*, service) -> APIRouter:
    router = APIRouter(prefix="/api/v1/auth", tags=["local-identity"])

    def call(response, action):
        response.headers["Cache-Control"] = "no-store"
        try:
            return {"code": 0, "message": "success", "data": action()}
        except SystemManagementError as error:
            response.status_code = error.status
            if error.code in (1102, 1103):
                response.delete_cookie(SESSION_COOKIE, path="/")
            if error.status == 429:
                response.headers["Retry-After"] = str(service.settings.lockout_seconds)
            return {"code": error.code, "message": str(error), "data": error.data}
        except SQLAlchemyError:
            response.status_code = 503
            return {"code": 5002, "message": "本地认证数据库不可用", "data": None}

    @router.get("/capabilities")
    def capabilities(request: Request, response: Response):
        return call(response, lambda: service.capabilities(request))

    @router.get("/session")
    def session(request: Request, response: Response):
        return call(response, lambda: service.session(request))

    @router.get("/csrf")
    def csrf(request: Request, response: Response):
        return call(response, lambda: service.challenge(request, response))

    @router.post("/login")
    def login(request: Request, response: Response, body: Any = Body(...)):
        return call(response, lambda: service.login(request, response, body))

    @router.post("/logout")
    def logout(request: Request, response: Response, body: Any = Body(...)):
        def action():
            parse_request(EmptyRequest, body)
            return service.logout(request, response)
        return call(response, action)

    @router.post("/password")
    def password(request: Request, response: Response, body: Any = Body(...)):
        return call(response, lambda: service.change_password(request, response, body))

    return router
