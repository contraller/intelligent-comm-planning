"""显式标源导入与只读查询路由；由总集成挂载，不修改主入口。"""
from __future__ import annotations

import re
import json

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from . import integration_identity_service as identities, observation_service as service
from .database import DatabaseConfigurationError, get_db, get_session_factory
from .observation_schemas import Identifier, ObservationPage, ObservationSelection, ObservationImportPreview, ObservationImportCommand
from pydantic import TypeAdapter
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


def _import_actor(request: Request):
    return identities.require(request, "situation.observation.import", writing=request.method == "POST")


async def _public_body(request, model):
    _query(request, set())
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > service.MAX_PUBLIC_FILE_BYTES:
            raise service.ObservationError("观测JSON请求超过2MiB保护限制", 1001, 413)

    def unique_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("重复JSON字段")
            value[key] = item
        return value

    try:
        value = json.loads(payload.decode("utf-8-sig"), object_pairs_hook=unique_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("非有限数字")))
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise service.ObservationError("观测JSON编码、字段或数值无效", 1001, 422) from exc
    return model.model_validate(value)


@router.post("/import-preview")
async def preview_import(request: Request, actor: dict = Depends(_import_actor)):
    body = await _public_body(request, ObservationImportPreview)
    if body.file.schemaVersion == 2:
        identities.require(request, "resources.view")
    return _ok(service.preview_import(body.file, factory=get_session_factory()))


@router.post("/imports")
async def import_dataset(request: Request, actor: dict = Depends(_import_actor)):
    body = await _public_body(request, ObservationImportCommand)
    if body.file.schemaVersion == 2:
        identities.require(request, "resources.view")
    return _ok(service.import_file(body, actor_id=actor["account_id"], factory=get_session_factory()))


@router.get("/imports/{request_id}")
def get_import_receipt(request: Request, request_id: str, actor: dict = Depends(_import_actor), session: Session = Depends(get_db)):
    values = _query(request, {"include_device_status_ref"})
    request_id = TypeAdapter(Identifier).validate_python(request_id, strict=True)
    return _ok(service.import_receipt(session, request_id, actor["account_id"], _include_ref(values)))


def _include_ref(values):
    value = values.get("include_device_status_ref", "false")
    if value not in ("true", "false"):
        raise service.ObservationError("关联投影开关须为true或false", 1001, 422)
    return value == "true"


@router.get("/datasets/{dataset_id}/device-status-ref")
def get_device_status_ref(request: Request, dataset_id: str, session: Session = Depends(get_db)):
    selected = _selection(dataset_id, _query(request, {"dataset_revision"}))
    return _ok(service.device_status_ref(session, selected.dataset_id, selected.dataset_revision))


@router.get("/datasets/{dataset_id}/export")
def export_dataset(request: Request, dataset_id: str, session: Session = Depends(get_db)):
    values = _query(request, {"dataset_revision", "include_device_status_ref"})
    selected = _selection(dataset_id, values)
    raw = service.export_dataset(session, selected.dataset_id, selected.dataset_revision, _include_ref(values))
    return Response(raw, media_type="application/json", headers={"Content-Disposition":
        f'attachment; filename="spectrum-observation-{selected.dataset_revision}.json"', "Cache-Control": "no-store"})
