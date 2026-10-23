"""来源声明路由；写入鉴权与CSRF仍由统一身份服务复核。"""
import json

from fastapi import APIRouter, Depends, Request, Response
from pydantic import TypeAdapter
from sqlalchemy.orm import Session

from . import integration_identity_service as identities, spectrum_source_service as service
from .database import get_db, get_session_factory
from .observation_routes import ObservationRoute, _integer
from .observation_schemas import Identifier, ObservationPage
from .observation_service import ObservationError
from .spectrum_source_schemas import SourceCheck, SourcePage, SourceRevision, SourceSave


def _authorize(request: Request):
    return identities.require(request, "resources.spectrum.edit" if request.method == "POST" else "resources.view", writing=request.method == "POST")


router = APIRouter(prefix="/api/v1/spectrum", route_class=ObservationRoute, dependencies=[Depends(_authorize)])


def _query(request, allowed):
    pairs = list(request.query_params.multi_items())
    if len({key for key, _ in pairs}) != len(pairs) or any(key not in allowed for key, _ in pairs):
        raise ObservationError("来源查询含未知或重复参数", 1001, 422)
    return dict(pairs)


def _id(value):
    return TypeAdapter(Identifier).validate_python(value, strict=True)


def _revision(value):
    return TypeAdapter(SourceRevision).validate_python(value, strict=True)


def _page(values):
    return ObservationPage.model_validate({key: _integer(values[key]) for key in ("page", "page_size") if key in values})


def _ok(value):
    return {"code": 0, "message": "success", "data": value}


@router.get("/sources")
def query_sources(request: Request, session: Session = Depends(get_db)):
    values = _query(request, {"page", "page_size", "search", "enabled"})
    page = _page(values).model_dump()
    if "enabled" in values and values["enabled"] not in ("true", "false"):
        raise ObservationError("启用筛选须为true或false", 1001, 422)
    query = SourcePage.model_validate({**page, "search": values.get("search", ""),
        "enabled": values.get("enabled") == "true" if "enabled" in values else None})
    return _ok(service.query_sources(session, query))


@router.post("/sources")
def save_source(body: SourceSave, request: Request):
    _query(request, set())
    actor = _authorize(request)
    return _ok(service.save_source(body, actor_id=actor["account_id"], factory=get_session_factory()))


@router.get("/source-operations/{request_id}")
def lookup_receipt(request: Request, request_id: str, session: Session = Depends(get_db)):
    values = _query(request, {"operation_type"})
    kind = values.get("operation_type")
    if kind not in ("SOURCE_SAVE", "SOURCE_CHECK"):
        raise ObservationError("须指定来源操作类型", 1001, 422)
    actor = _authorize(request)
    return _ok(service.lookup(session, _id(request_id), kind, actor["account_id"]))


@router.get("/sources/{source_id}")
def get_source(request: Request, source_id: str, session: Session = Depends(get_db)):
    values = _query(request, {"config_revision"})
    return _ok(service.get_version(session, _id(source_id), _revision(values["config_revision"]) if "config_revision" in values else None))


@router.post("/sources/{source_id}/checks")
def check_source(source_id: str, body: SourceCheck, request: Request):
    _query(request, set())
    actor = _authorize(request)
    return _ok(service.check_source(_id(source_id), body, actor_id=actor["account_id"], factory=get_session_factory()))


@router.get("/sources/{source_id}/versions")
def query_versions(request: Request, source_id: str, session: Session = Depends(get_db)):
    page = _page(_query(request, {"page", "page_size"}))
    return _ok(service.history(session, _id(source_id), page.page, page.page_size))


@router.get("/sources/{source_id}/checks")
def query_checks(request: Request, source_id: str, session: Session = Depends(get_db)):
    values = _query(request, {"page", "page_size", "config_revision"})
    page = _page(values)
    return _ok(service.history(session, _id(source_id), page.page, page.page_size, checks=True,
        revision=_revision(values["config_revision"]) if "config_revision" in values else None))


@router.get("/sources/{source_id}/export")
def export_source(request: Request, source_id: str, session: Session = Depends(get_db)):
    values = _query(request, {"config_revision"})
    revision = _revision(values.get("config_revision"))
    payload = service.export_source(session, _id(source_id), revision)
    return Response(json.dumps(payload, ensure_ascii=False, allow_nan=False), media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="spectrum-source-{revision}.json"', "Cache-Control": "no-store"})
