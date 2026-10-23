"""三个只读资源追溯接口；POST 预览也不写资源。"""
from fastapi import APIRouter, Body, Request, Response
from pydantic import TypeAdapter, ValidationError
from . import device_trace_service as service
from .device_trace_schemas import RestorePreviewInput
from .device_status_router import require_actor, _query, _page
from .device_status_service import DeviceStatusError
from .device_configuration_router import _EnvelopeRoute
from .device_configuration_schemas import RequestId, check_request_id
from .task_input_schemas import Identifier
from .resource_dataset_service import ResourceDatasetError
from .integration_identity_service import IdentityError


def create_device_trace_router(actor_resolver=require_actor):
    router = APIRouter(prefix="/api/v1/device-traces", tags=["device-traces"], route_class=_EnvelopeRoute)

    def call(request, response, operation, writing=False):
        try:
            actor = actor_resolver(request, "resources.view", writing=False)
            if writing:
                actor = actor_resolver(request, "resources.device.edit", writing=True)
            if not isinstance(actor, dict) or not actor.get("account_id"):
                raise service.DeviceTraceError("可信身份接线未返回账号", 5001, 503)
            return {"code": 0, "message": "success", "data": operation()}
        except (service.DeviceTraceError, DeviceStatusError, ResourceDatasetError, IdentityError) as exc:
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": None}
        except ValidationError:
            response.status_code = 422
            return {"code": 1001, "message": "设备追溯请求无效", "data": None}
        except Exception as exc:
            if getattr(exc, "code", None) not in (1101, 1104, 1105, 1106) or getattr(exc, "status", None) not in (401, 403, 409, 429):
                raise
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": getattr(exc, "data", None)}

    @router.get("/{device_id}/history")
    def history(device_id: str, request: Request, response: Response):
        def operation():
            TypeAdapter(Identifier).validate_python(device_id)
            query = _query(request, ("context", "resource_revision", "page", "page_size"), ("context", "resource_revision"))
            return service.history(device_id, query["resource_revision"], **_page(query))
        return call(request, response, operation)

    @router.get("/{device_id}/operations/{request_id}")
    def detail(device_id: str, request_id: str, request: Request, response: Response):
        def operation():
            TypeAdapter(Identifier).validate_python(device_id)
            try:
                check_request_id(TypeAdapter(RequestId).validate_python(request_id))
            except ValueError as exc:
                raise service.DeviceTraceError("操作编号无效") from exc
            query = _query(request, ("context", "resource_revision"), ("context", "resource_revision"))
            return service.detail(device_id, query["resource_revision"], request_id)
        return call(request, response, operation)

    @router.post("/{device_id}/restore-preview")
    def preview(device_id: str, request: Request, response: Response, payload: dict = Body(...)):
        def operation():
            TypeAdapter(Identifier).validate_python(device_id)
            _query(request, (), ())
            return service.restore_preview(device_id, RestorePreviewInput.model_validate(payload))
        return call(request, response, operation, True)

    return router


router = create_device_trace_router()
