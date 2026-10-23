"""独立只读路由；由总集成挂载，不修改主入口。"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from . import integration_identity_service as identities, observation_service as service
from .database import DatabaseConfigurationError, get_db
from .observation_schemas import ObservationPage, ObservationSelection
from .resource_dataset_service import ResourceDatasetError


class ObservationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def enveloped(request):
            try:
                return await handler(request)
            except (service.ObservationError, identities.IdentityError, ResourceDatasetError) as exc:
                return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": None})
            except (ValidationError, RequestValidationError):
                return JSONResponse(status_code=422, content={"code": 1001, "message": "观测查询参数无效", "data": None})
            except DatabaseConfigurationError:
                return JSONResponse(status_code=503, content={"code": 5001, "message": "观测数据库未配置", "data": None})
            except SQLAlchemyError:
                return JSONResponse(status_code=503, content={"code": 5002, "message": "观测存储不可用，请检查集成迁移", "data": None})

        return enveloped


def _authorize(request: Request):
    identities.require(request, "situation.view")


router = APIRouter(prefix="/api/v1/observations/spectrum", route_class=ObservationRoute,
    dependencies=[Depends(_authorize)])


def _query(request: Request, allowed: set[str]) -> dict[str, str]:
    pairs = list(request.query_params.multi_items())
    if any(key not in allowed for key, _ in pairs) or len({key for key, _ in pairs}) != len(pairs):
        raise service.ObservationError("观测查询含未知或重复参数", 1001, 422)
    return dict(pairs)


def _integer(value: str) -> int:
    if not re.fullmatch(r"[0-9]{1,16}", value):
        raise service.ObservationError("查询索引和页码须为非负整数", 1001, 422)
    number = int(value)
    if number > 9007199254740991:
        raise service.ObservationError("查询整数超出精确表示范围", 1001, 422)
    return number


def _page(values):
    return ObservationPage.model_validate({key: _integer(values[key]) for key in ("page", "page_size") if key in values})


def _selection(dataset_id, values):
    return ObservationSelection.model_validate({"dataset_id": dataset_id, "dataset_revision": values.get("dataset_revision")})


def _ok(data):
    return {"code": 0, "message": "success", "data": data}


@router.get("/context")
def get_context(request: Request, session: Session = Depends(get_db)):
    values = _query(request, {"dataset_id", "dataset_revision"})
    if values and set(values) != {"dataset_id", "dataset_revision"}:
        raise service.ObservationError("观测集编号与版本须成对提供", 1001, 422)
    selected = _selection(values["dataset_id"], values) if values else None
    return _ok(service.context(session, selected.dataset_id if selected else None, selected.dataset_revision if selected else None))


@router.get("/datasets")
def get_datasets(request: Request, session: Session = Depends(get_db)):
    page = _page(_query(request, {"page", "page_size"}))
    return _ok(service.datasets(session, page.page, page.page_size))


@router.get("/datasets/{dataset_id}/frames")
def get_frames(request: Request, dataset_id: str, session: Session = Depends(get_db)):
    values = _query(request, {"dataset_revision", "page", "page_size"})
    selected, page = _selection(dataset_id, values), _page(values)
    return _ok(service.frames(session, selected.dataset_id, selected.dataset_revision, page.page, page.page_size))


@router.get("/datasets/{dataset_id}/frames/{index}")
def get_frame(request: Request, dataset_id: str, index: str, session: Session = Depends(get_db)):
    selected = _selection(dataset_id, _query(request, {"dataset_revision"}))
    return _ok(service.frame(session, selected.dataset_id, selected.dataset_revision, _integer(index)))
