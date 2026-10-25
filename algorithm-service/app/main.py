"""FastAPI entrypoint for the algorithm service."""
from __future__ import annotations

import os
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from typing import Any

from .candidate_sites import filter_candidate_sites
from .coverage import query_coverage, read_cache, submit_coverage
from .database import DatabaseConfigurationError, check_database_connection, get_session_factory
from .deployment import query_deployment, submit_deployment
from .fault import (archive_scenario, create_report, create_scenario, delete_scenario, export_impact,
                    get_analysis_view, get_impact_nodes, get_scenario, get_suggestions,
                    import_scenarios, list_scenarios,
                    report_path, submit_diagnosis, submit_observation_diagnosis,
                    submit_diagnosis_feedback, submit_impact, update_scenario,
                    validate_scenario)
from .fault_plan_source import FaultPlanSourceError, list_plan_sources
from . import frontend_integration
from . import resource_dataset_service as resource_dataset
from . import resource_maintenance_service
from .resource_export_router import router as resource_export_router
from .resource_import_router import router as resource_import_router
from .resource_workspace_router import router as resource_workspace_router
from .task_file_router import create_task_file_router
from .resource_reset_router import router as resource_reset_router
from .gis_plan_router import router as gis_plan_router
from .frozen_coverage_router import create_frozen_coverage_router
from .interference_frontend_router import router as interference_frontend_router
from .interference_workbench_router import router as interference_workbench_router
from .frequency_resource_router import router as frequency_resource_router
from .device_configuration_router import (router as device_configuration_router,
    create_device_configuration_router)
from .device_status_router import (router as device_status_router,
    create_device_status_router)
from .device_trace_router import (router as device_trace_router,
    create_device_trace_router)
from .observation_routes import router as observation_router
from .spectrum_source_routes import router as spectrum_source_router
from . import resource_read_projection
from .resource_read_query_schemas import (ResourceDeviceReadQuery, ResourceNodeQuery,
    ResourceInterferenceQuery, ResourceMapQuery, ResourceObjectQuery)
from .resource_maintenance_schemas import (AvailabilityChange, AvailabilityPreview,
    ResourceDeviceChanges, ResourceMaintenanceQuery)
from . import gis_frontend_service
from . import integration_identity_service as integration_identity
from .application_identity import install_local_identity
from .local_frontend_boundary import authorize_local_request
from .system_management_schemas import SystemManagementError
from . import fault_frontend_service, kg_frontend_service
from .fault_frontend_schemas import FaultDraft, FaultMutation, FaultPage
from .kg_frontend_schemas import KnowledgeMutation, KnowledgePage
from . import kg
from . import kg_workflow_service
from .kg_schemas import KgDraftRequest, KgTransitionRequest
from .kg_workflow_service import KgWorkflowError
from . import planning_job_service
from . import planning_operation_service
from . import planning_plan_service
from . import sr4_integration
from . import task_input_service
from .planning_job_schemas import PlanningJobCancelRequest, PlanningJobSubmitRequest
from .planning_job_service import PlanningJobError
from .planning_operation_service import OperationError, OperationQuery
from .planning_plan_schemas import (
    PlanningPlanCompareRequest,
    PlanningPlanConfirmRequest,
    PlanningPlanExportRequest,
    PlanningPlanSaveRequest,
)
from .planning_plan_service import PlanningPlanError
from .planning_w3 import (query_task, submit_frequency, submit_plan_check,
                          submit_radio_params, submit_route)
from .planning_w4 import (adopt_countermeasure, compare_plans, confirm_plan,
                          export_plan, get_plan, list_plans, submit_interference,
                          submit_optimize)
from .resource import (list_antenna_models, list_device_models,
                       list_frequency_pool, radio_param_presets)
from .task_input_schemas import (TaskDetailQuery, TaskListQuery, TaskSaveRequest,
                                 TaskValidationRequest)
from .task_input_service import TaskInputError, save_task_input

try:
    from fastapi import FastAPI, HTTPException, Request, Response
    from fastapi.exception_handlers import (http_exception_handler,
                                            request_validation_exception_handler)
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import FileResponse, JSONResponse
    from pydantic import ValidationError
    from sqlalchemy.exc import SQLAlchemyError
    from starlette.exceptions import HTTPException as StarletteHTTPException
except ImportError as exc:  # pragma: no cover - exercised only without runtime deps
    raise RuntimeError(
        "FastAPI is not installed. Run: pip install -r algorithm-service/requirements.txt"
    ) from exc


@asynccontextmanager
async def application_lifespan(application):
    with ExitStack() as ownership:
        worker = coverage = None
        application.state.interference_worker = None
        application.state.frozen_coverage = None
        try:
            enabled = os.environ.get("INTERFERENCE_WORKBENCH_ENABLED", "0")
            coverage_enabled = os.environ.get("FROZEN_COVERAGE_ENABLED", "0")
            if enabled not in ("0", "1") or coverage_enabled not in ("0", "1"):
                raise RuntimeError("后台工作流开关只能为0或1")
            if enabled == "1":
                from .interference_workbench_service import (InterferenceWorkbenchService,
                    start_interference_worker, stop_interference_worker)
                from .interference_replan_service import FrozenPlanningReplanner
                from .interference_workbench_models import InterferenceWorkbenchRun
                from .runtime_ownership import exclusive_runtime_directory
                from sqlalchemy import select
                if not resource_dataset.database_mode():
                    raise RuntimeError("干扰工作流要求显式数据库资源模式")
                factory = get_session_factory()
                from .interference_analysis_engine import runtime_path
                directory = os.environ.get("INTERFERENCE_RUNTIME_DIR")
                if directory is not None and (not directory or not Path(directory).is_absolute()):
                    raise RuntimeError("干扰工作流要求显式绝对运行目录")
                # 多套验收服务各自持锁，不能扫描或恢复另一套环境的作业。
                root = runtime_path(directory)
                ownership.enter_context(exclusive_runtime_directory(root))
                bridge = FrozenPlanningReplanner(factory, runtime_root=root)
                service = InterferenceWorkbenchService(factory, runtime_root=root, replanner=bridge)
                # 先验证表及实际路径，只有拿到进程排他锁才能恢复中断作业。
                with service.transaction() as session:
                    session.execute(select(InterferenceWorkbenchRun).limit(0))
                application.state.interference_recovered_jobs = bridge.recover_interrupted(exclusive_runtime=True)
                application.state.interference_workbench = service
                worker = start_interference_worker(service)
                application.state.interference_worker = worker
            if coverage_enabled == "1":
                from .frozen_coverage_service import create_frozen_coverage_service
                directory = os.environ.get("FROZEN_COVERAGE_RUNTIME_DIR", "")
                if not directory or not Path(directory).is_absolute() or not resource_dataset.database_mode():
                    raise RuntimeError("冻结覆盖要求数据库资源模式及显式绝对运行目录")
                coverage = create_frozen_coverage_service(runtime_root=directory,
                    session_factory=get_session_factory())
                coverage.start()
                application.state.frozen_coverage = coverage
            yield
        finally:
            failures = []
            if coverage is not None:
                try:
                    coverage.close(timeout=10.0)
                except BaseException as exc:
                    failures.append(exc)
            if worker is not None:
                try:
                    dispatcher_stopped = stop_interference_worker(worker, timeout=5)
                    children_stopped = worker.service.replanner.bridge.shutdown(timeout=5)
                    if not dispatcher_stopped or not children_stopped:
                        raise RuntimeError("干扰调度或重算子线程未在检查点停止，不能宣称已安全关服")
                except BaseException as exc:
                    failures.append(exc)
            if failures:
                # 任一线程未停时保留所有权，且仍尝试关停另一模块。
                application.state.interference_runtime_ownership = ownership.pop_all()
                raise failures[0]


app = FastAPI(title="短波/超短波智能规划算法服务", version="0.1.0", lifespan=application_lifespan)
# 正式身份在旧联调路由注册前显式安装，配置错误不降级为演示身份。
local_identity_adapter = install_local_identity(app)


def _frontend_device_actor(request, permission, *, writing=False):
    actor = integration_identity.require(request, permission, writing=writing)
    adapter = getattr(request.app.state, "local_identity_adapter", None)
    if adapter is None or adapter.auth_mode != "LOCAL_PASSWORD":
        raise integration_identity.IdentityError("设备正式身份未装配", 5001, 503)
    # 设备受理a2冻结真实认证来源，不把本地账号冒充旧联调principal。
    return {**actor, "authentication_mode": "LOCAL_PASSWORD"}


def _planning_business_kwargs(request, *, job=False):
    adapter = getattr(request.app.state, "local_identity_adapter", None)
    local = getattr(request.app.state, "auth_mode", None) == "LOCAL_PASSWORD" or os.environ.get("AUTH_MODE") == "LOCAL_PASSWORD"
    if not local:
        return {}
    if adapter is None:
        raise SystemManagementError("正式规划身份未装配", 5001, 503)
    from .local_business_context import create_local_business_context
    context = create_local_business_context(request, adapter=adapter)
    # 上下文只传业务事务，不进入请求DTO、持久化快照或算法线程。
    return {"audit_context": context, **({"local_owner": True, "actor_id": context.actor.account_id} if job else {})}


app.include_router(resource_export_router)
app.include_router(resource_import_router)
app.include_router(resource_workspace_router)
app.include_router(resource_reset_router)
app.include_router(create_task_file_router(integration_identity.require))
# 并行模块在此统一挂载；各模块保留自己的严格契约和错误包络。
app.include_router(gis_plan_router)
app.include_router(create_frozen_coverage_router(integration_identity.require))
app.include_router(interference_frontend_router)
app.include_router(interference_workbench_router)
app.include_router(frequency_resource_router)
app.include_router(create_device_configuration_router(_frontend_device_actor)
                   if local_identity_adapter is not None else device_configuration_router)
app.include_router(create_device_status_router(_frontend_device_actor)
                   if local_identity_adapter is not None else device_status_router)
app.include_router(create_device_trace_router(_frontend_device_actor)
                   if local_identity_adapter is not None else device_trace_router)
app.include_router(observation_router)
app.include_router(spectrum_source_router)


def _frontend_workbench_call(response: Response, operation):
    try:
        data = operation()
        return data if isinstance(data, Response) else {"code": 0, "message": "success", "data": data}
    except (integration_identity.IdentityError, FaultPlanSourceError, KgWorkflowError, gis_frontend_service.GisReadError, resource_dataset.ResourceDatasetError) as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except ValidationError as exc:
        response.status_code = 422
        return {"code": 1001, "message": "页面请求字段无效", "data": [
            {"field": ".".join(map(str, e["loc"])), "message": e["msg"]} for e in exc.errors()]}
    except fault_frontend_service.fault.FaultInputError as exc:
        response.status_code = 422
        return {"code": exc.code, "message": str(exc), "data": exc.detail}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}
    except (ValueError, TypeError, KeyError) as exc:
        response.status_code = 422
        return {"code": 1001, "message": "请求内容无效：" + str(exc), "data": None}


@app.middleware("http")
async def resource_dataset_boundary(request: Request, call_next):
    # 懒加载同版快照；不使用资源的健康检查、身份等请求不会读取资源库。
    with resource_dataset.read_scope():
        return await call_next(request)


@app.exception_handler(resource_dataset.ResourceDatasetError)
async def resource_dataset_error(request: Request, exc):
    return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": None})


@app.exception_handler(SystemManagementError)
async def local_business_error(request: Request, exc):
    return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": exc.data})


@app.middleware("http")
async def integration_workflow_boundary(request: Request, call_next):
    # 本地模式先校验所有新版及遗留入口；业务handler仍保留专项权限检查。
    from .system_management_schemas import SystemManagementError
    try:
        authorize_local_request(request)
    except SystemManagementError as exc:
        return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": exc.data})
    except SQLAlchemyError:
        return JSONResponse(status_code=503, content={"code": 5002, "message": "身份数据库不可用", "data": None})
    # 联调模式不能通过旧写入口冒充其他操作者；非联调算法接口保持兼容。
    path = request.url.path
    module = "diagnosis" if path.startswith("/api/v1/fault/") else "knowledge" if path.startswith("/api/v1/kg/") else None
    if module and frontend_integration.integration_enabled() and "/workbench" not in path:
        try:
            integration_identity.require(request, module + ".view")
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                raise integration_identity.IdentityError("联调写操作请使用新版工作区接口")
        except integration_identity.IdentityError as exc:
            return JSONResponse(status_code=exc.status, content={"code": exc.code, "message": str(exc), "data": None})
    return await call_next(request)


@app.get("/api/v1/auth/integration/identities")
def integration_accounts(request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: integration_identity.catalog(request))


@app.post("/api/v1/auth/integration/switch")
def integration_switch(payload: dict[str, Any], request: Request, response: Response):
    def operation():
        if set(payload) != {"accountId"}:
            raise integration_identity.IdentityError("只接受 accountId", 1001, 422)
        return integration_identity.switch(request, response, payload["accountId"])
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/fault/workbench")
def fault_workbench_context(request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: (
        integration_identity.require(request, "diagnosis.view"), fault_frontend_service.context())[1])


@app.get("/api/v1/fault/workbench/sources")
def fault_workbench_sources(request: Request, response: Response, planId: str | None = None):
    return _frontend_workbench_call(response, lambda: (
        integration_identity.require(request, "diagnosis.view"),
        fault_frontend_service.source_detail(planId) if planId else fault_frontend_service.sources())[1])


@app.get("/api/v1/fault/workbench/catalog/{kind}")
def fault_workbench_catalog(kind: str, request: Request, response: Response):
    def operation():
        integration_identity.require(request, "diagnosis.view")
        if kind not in ("scenarios", "history"):
            fault_frontend_service.fail("未知目录")
        return fault_frontend_service.catalog(kind, FaultPage.model_validate(dict(request.query_params)))
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/fault/workbench/version")
def fault_workbench_version(scenarioId: str, versionId: str, request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: (integration_identity.require(request, "diagnosis.view"),
        fault_frontend_service.scenario_version(scenarioId, versionId))[1])


@app.post("/api/v1/fault/workbench/validate")
def fault_workbench_validate(payload: dict[str, Any], request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: (integration_identity.require(request, "diagnosis.scenario", writing=True),
        fault_frontend_service.validate(FaultDraft.model_validate(payload)), [])[2])


@app.post("/api/v1/fault/workbench/import-preview")
def fault_workbench_import(payload: dict[str, Any], request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: (integration_identity.require(request, "diagnosis.scenario", writing=True),
        fault_frontend_service.import_preview(payload))[1])


@app.post("/api/v1/fault/workbench/actions/{action}")
def fault_workbench_action(action: str, payload: dict[str, Any], request: Request, response: Response):
    def operation():
        permission = {"save": "diagnosis.scenario", "archive": "diagnosis.scenario", "import": "diagnosis.scenario",
                      "submit": "diagnosis.execute", "impact": "diagnosis.execute", "cancel": "diagnosis.execute", "feedback": "knowledge.edit"}.get(action)
        if not permission:
            fault_frontend_service.fail("不支持此工作区操作")
        identity = integration_identity.require(request, permission, writing=True)
        if action == "feedback":
            integration_identity.require(request, "diagnosis.view")
        return fault_frontend_service.mutate(action, FaultMutation.model_validate(payload), identity)
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/fault/workbench/runs/{run_id}/{part}")
def fault_workbench_run(run_id: str, part: str, request: Request, response: Response):
    def operation():
        integration_identity.require(request, "diagnosis.view")
        if part == "report":
            return fault_frontend_service.report(run_id)
        data = fault_frontend_service.view(run_id)
        if part == "progress":
            return {k: data[k] for k in ("id", "dataOrigin", "state", "progress", "phases", "diagnosisReady", "impactReady", "error", "source", "resultVersion")}
        if part == "detail":
            return {k: v for k,v in data.items() if k not in ("result", "id", "resultVersion")}
        if part == "stage":
            stage = request.query_params.get("stage")
            if stage not in ("diagnosis", "impact") or not data["diagnosisReady" if stage == "diagnosis" else "impactReady"]:
                fault_frontend_service.fail("请求阶段尚未就绪", 2002, 409)
            if request.query_params.get("resultVersion") != data["resultVersion"]:
                fault_frontend_service.fail("阶段结果版本已变化，请重新读取", 1203, 409)
            return data["result"]
        fault_frontend_service.fail("未知读取分项")
    return _frontend_workbench_call(response, operation)


def _download_response(data, name):
    content, mime = data
    return Response(content, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})


@app.get("/api/v1/fault/workbench/template")
def fault_workbench_template(planId: str, format: str, request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: (integration_identity.require(request, "diagnosis.scenario"),
        _download_response(fault_frontend_service.template(planId, format), "fault-template."+format))[1])


@app.get("/api/v1/fault/workbench/export/{run_id}")
def fault_workbench_export(run_id: str, kind: str, format: str, request: Request, response: Response, filters: str = ""):
    def operation():
        integration_identity.require(request, "diagnosis.export")
        if kind not in ("report", "impact") or len(filters) > 2000:
            fault_frontend_service.fail("导出参数无效")
        return _download_response(fault_frontend_service.export_file(run_id, kind, format, filters), run_id+"-"+kind+"."+format)
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/kg/workbench")
def knowledge_workbench(request: Request, response: Response):
    return _frontend_workbench_call(response, lambda: kg_frontend_service.metadata(
        identity=integration_identity.require(request, "knowledge.view")))


@app.get("/api/v1/kg/workbench/browse/{kind}")
def knowledge_workbench_browse(kind: str, request: Request, response: Response):
    def operation():
        integration_identity.require(request, "knowledge.view")
        if kind not in ("search", "graph", "entity", "device"):
            kg_frontend_service._fail("未知查询分项")
        return kg_frontend_service.browse(kind, dict(request.query_params))
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/kg/workbench/history/{kind}")
def knowledge_workbench_history(kind: str, request: Request, response: Response):
    def operation():
        integration_identity.require(request, "knowledge.view")
        if kind not in ("changes", "versions", "logs"):
            kg_frontend_service._fail("未知历史分项")
        return kg_frontend_service.history(kind, KnowledgePage.model_validate(dict(request.query_params)))
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/kg/workbench/detail/{kind}/{object_id}")
def knowledge_workbench_detail(kind: str, object_id: str, request: Request, response: Response):
    def operation():
        integration_identity.require(request, "knowledge.view")
        if kind not in ("change", "version"):
            kg_frontend_service._fail("未知详情分项")
        return kg_frontend_service.change_detail(object_id) if kind == "change" else kg_frontend_service.version_detail(object_id)
    return _frontend_workbench_call(response, operation)


@app.post("/api/v1/kg/workbench/actions/{action}")
def knowledge_workbench_action(action: str, payload: dict[str, Any], request: Request, response: Response):
    def operation():
        permission = {"save": "knowledge.edit", "submit": "knowledge.edit", "withdraw": "knowledge.edit",
                      "review": "knowledge.review", "publish": "knowledge.publish", "rollback": "knowledge.rollback"}.get(action)
        if not permission:
            kg_frontend_service._fail("不支持此操作")
        identity = integration_identity.require(request, permission, writing=True)
        return kg_frontend_service.mutate(action, KnowledgeMutation.model_validate(payload), identity)
    return _frontend_workbench_call(response, operation)


@app.exception_handler(StarletteHTTPException)
async def api_http_exception(request: Request, exc: StarletteHTTPException) -> Response:
    if not request.url.path.startswith("/api/v1/"):
        return await http_exception_handler(request, exc)
    # 框架错误沿用业务包络，保留原有 HTTP 状态。
    code = {401: 1101, 403: 1101, 404: 1002, 409: 1203}.get(
        exc.status_code, 5001 if exc.status_code >= 500 else 1001)
    if exc.status_code == 409 and str(exc.detail).startswith("资源版本已变化"):
        code = 1205
    return JSONResponse(status_code=exc.status_code, headers=exc.headers, content={
        "code": code, "message": str(exc.detail), "data": None})


@app.exception_handler(RequestValidationError)
async def api_request_validation(request: Request, exc: RequestValidationError) -> Response:
    if not request.url.path.startswith("/api/v1/"):
        return await request_validation_exception_handler(request, exc)
    issues = [{"field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
              for issue in exc.errors()]
    return JSONResponse(status_code=422, content={
        "code": 1001, "message": "请求参数校验失败", "data": issues})


@app.get("/health")
def health() -> dict[str, Any]:
    return {"code": 0, "message": "success", "data": {"status": "ok"}}


@app.get("/health/workers")
def worker_health(response: Response):
    worker = getattr(app.state, "interference_worker", None)
    coverage = getattr(app.state, "frozen_coverage", None)
    coverage_health = {"state": "disabled"} if coverage is None else coverage.status()
    coverage_state = coverage_health.get("state")
    if coverage_state not in ("disabled", "running", "failed"):
        coverage_state = "failed"
    states = {"interference": "disabled" if worker is None else
              "running" if worker.thread.is_alive() and worker.error is None else "failed",
              "frozen_coverage": coverage_state}
    healthy = "failed" not in states.values()
    if not healthy:
        response.status_code = 503
    return {"code": 0 if healthy else 5002, "message": "success" if healthy else "后台工作流不可用",
            "data": states}


def frontend_auth_session(response: Response, request: Request) -> dict[str, Any]:
    """返回显式开启的固定联调身份；不作为正式认证实现。"""
    if not frontend_integration.integration_enabled():
        response.status_code = 401
        return {"code": 1101, "message": "前端联调身份未启用", "data": None}
    return _frontend_workbench_call(response, lambda: integration_identity.current(request))


def frontend_auth_csrf(response: Response, request: Request) -> dict[str, Any]:
    """为首个任务写接口提供同会话的联调 CSRF 挑战。"""
    if not frontend_integration.integration_enabled():
        response.status_code = 401
        return {"code": 1101, "message": "前端联调身份未启用", "data": None}
    return _frontend_workbench_call(response, lambda: integration_identity.challenge(request))


if local_identity_adapter is None:
    app.add_api_route("/api/v1/auth/session", frontend_auth_session, methods=["GET"])
    app.add_api_route("/api/v1/auth/csrf", frontend_auth_csrf, methods=["GET"])


@app.get("/health/database")
def database_health(response: Response) -> dict[str, Any]:
    """检查数据库连接；失败不影响普通健康检查和服务启动。"""
    try:
        return {"code": 0, "message": "success", "data": check_database_connection()}
    except DatabaseConfigurationError as exc:
        response.status_code = 503
        return {"code": 5001, "message": str(exc), "data": {"status": "error"}}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库连接失败", "data": {"status": "error"}}


@app.put("/api/v1/task-inputs/{task_id}")
def save_planning_task_input(task_id: str, payload: dict[str, Any],
                             response: Response, http_request: Request) -> dict[str, Any]:
    """保存规划任务输入，并返回数据库中的不可变版本。"""
    try:
        request = TaskSaveRequest.model_validate(payload)
        data = save_task_input(request, task_id, **_planning_business_kwargs(http_request))
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": task_id,
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "任务输入校验失败", "data": issues}
    except TaskInputError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.get("/api/v1/task-inputs")
def list_planning_task_inputs(response: Response, context: str | None = None,
                              page: str = "1", page_size: str = "10",
                              search: str = "") -> dict[str, Any]:
    """分页读取当前任务输入版本。"""
    try:
        query = TaskListQuery.model_validate({
            "context": context, "page": page, "page_size": page_size,
            "search": search,
        })
        data = task_input_service.list_task_inputs(query)
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": "task-inputs",
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "任务列表参数校验失败", "data": issues}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/task-inputs/validate")
def validate_planning_task_input(payload: dict[str, Any],
                                 response: Response) -> dict[str, Any]:
    """返回保存或导入前的只读校验问题，不修改任务版本。"""
    try:
        request = TaskValidationRequest.model_validate(payload)
        data = task_input_service.validate_task_input(request)
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": str(payload.get("task_id") or "task"),
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "任务校验参数无效", "data": issues}
    except TaskInputError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.get("/api/v1/task-inputs/{task_id}")
def get_planning_task_input(task_id: str, response: Response,
                            context: str | None = None) -> dict[str, Any]:
    """按任务编号读取数据库当前版本。"""
    try:
        query = TaskDetailQuery.model_validate({"task_id": task_id, "context": context})
        data = task_input_service.get_task_input(query.task_id, query.context)
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": task_id,
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "任务详情参数校验失败", "data": issues}
    except TaskInputError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.get("/api/v1/planning-operations/{request_id}")
def planning_operation_receipt(request_id: str, response: Response, http_request: Request,
                               context: str | None = None,
                               task_id: str | None = None,
                               kind: str | None = None) -> dict[str, Any]:
    """供前端在写请求超时后按原请求编号核实持久化结果。"""
    try:
        query = OperationQuery.model_validate({
            "request_id": request_id, "context": context,
            "task_id": task_id, "kind": kind,
        })
        data = planning_operation_service.query_operation(query, **_planning_business_kwargs(http_request))
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": request_id,
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "回执查询参数校验失败", "data": issues}
    except OperationError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/plan/candidate-sites")
def candidate_sites(payload: dict[str, Any]) -> dict[str, Any]:
    return filter_candidate_sites(payload)


@app.post("/api/v1/plan/deployment")
def plan_deployment(payload: dict[str, Any]) -> dict[str, Any]:
    """移动电台部署规划（SR-4.2.1.2）。

    按 SR-4.2 g) 采用异步任务模式：立即返回 task_id，
    计算进度与结果由 GET /api/v1/plan/deployment/{task_id} 查询。
    """
    return submit_deployment(payload)


@app.get("/api/v1/plan/deployment/{task_id}")
def plan_deployment_status(task_id: str) -> dict[str, Any]:
    return query_deployment(task_id)


@app.post("/api/v1/plan/coverage")
def plan_coverage(payload: dict[str, Any]) -> dict[str, Any]:
    """覆盖范围计算（SR-1.1.2.6.2）。命中缓存则直接返回。"""
    return submit_coverage(payload)


@app.get("/api/v1/plan/coverage/{task_id}")
def plan_coverage_status(task_id: str) -> dict[str, Any]:
    return query_coverage(task_id)


@app.get("/api/v1/plan/coverage/cache/{cache_key}")
def plan_coverage_cache(cache_key: str) -> dict[str, Any]:
    """前端只读入口：SR-1.1.2.6.2 c 要求覆盖图层读规划模块的计算结果缓存，
    不独立发起实时全网计算。"""
    return read_cache(cache_key)


# ── SR-4.2.2 / SR-4.2.3 第 3 周规划接口（异步，统一用 /plan/tasks/{id} 查询） ──


@app.get("/api/v1/plan/jobs")
def list_planning_jobs(response: Response, context: str | None = None,
                       page: str = "1", page_size: str = "10",
                       search: str = "") -> dict[str, Any]:
    """分页读取冻结作业历史，仅开放规划场景。"""
    try:
        query = TaskListQuery.model_validate({
            "context": context, "page": page, "page_size": page_size,
            "search": search,
        })
        if query.context != "planning":
            response.status_code = 422
            return {"code": 1001, "message": "context 只能是 planning", "data": None}
        data = planning_job_service.list_planning_jobs(query)
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": "plan/jobs",
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "作业列表参数校验失败", "data": issues}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/plan/route")
def plan_route(payload: dict[str, Any]) -> dict[str, Any]:
    """路由规划（SR-4.2.2.1）。三策略 + 备用路由 + 人工指定路径。"""
    return submit_route(payload)


@app.post("/api/v1/plan/frequency")
def plan_frequency(payload: dict[str, Any]) -> dict[str, Any]:
    """频率资源分配（SR-4.2.2.2）。默认按网系粒度分配。"""
    return submit_frequency(payload)


@app.post("/api/v1/plan/radio-params")
def plan_radio_params(payload: dict[str, Any]) -> dict[str, Any]:
    """电台参数规划（SR-4.2.3）。返回三套预选配置的对比与优选。"""
    return submit_radio_params(payload)


@app.post("/api/v1/plan/check")
def plan_check_route(payload: dict[str, Any]) -> dict[str, Any]:
    """方案冲突校验（SR-4.2 c）。"""
    return submit_plan_check(payload)


@app.get("/api/v1/plan/tasks/{job_id}")
def plan_task_status(job_id: str, response: Response,
                     task_id: str | None = None,
                     context: str | None = None) -> dict[str, Any]:
    """查询版本化 SR4 作业，并兼容原有第 3 周异步任务。"""
    if context not in {None, "planning"}:
        response.status_code = 422
        return {"code": 1001, "message": "context 只能是 planning",
                "data": None, "request_id": None}
    try:
        result = planning_job_service.query_planning_job(job_id, task_id)
    except PlanningJobError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data,
                "request_id": None}
    except DatabaseConfigurationError:
        if task_id is None:
            return query_task(job_id)
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None,
                "request_id": None}
    except SQLAlchemyError:
        if task_id is None:
            return query_task(job_id)
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None,
                "request_id": None}
    if result is not None:
        return result
    if task_id is None:
        return query_task(job_id)
    response.status_code = 404
    return {"code": 2001, "message": "规划作业不存在", "data": None,
            "request_id": None}


@app.delete("/api/v1/tasks/{job_id}")
def cancel_plan_task(job_id: str, payload: dict[str, Any],
                     response: Response, http_request: Request) -> dict[str, Any]:
    """取消版本化 SR4 作业，返回前端可直接读取的完整作业。"""
    try:
        request = PlanningJobCancelRequest.model_validate(payload)
        return planning_job_service.cancel_planning_job(job_id, request, **_planning_business_kwargs(http_request, job=True))
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": str(payload.get("task_id") or job_id),
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "取消作业参数校验失败", "data": issues,
                "request_id": payload.get("request_id")}
    except PlanningJobError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data,
                "request_id": payload.get("request_id")}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None,
                "request_id": payload.get("request_id")}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None,
                "request_id": payload.get("request_id")}


# ── SR-3 资源台账（供 SR-2 前端设备配置界面） ──


@app.get("/api/v1/resource/context")
def frontend_resource_context(context: str = "planning") -> dict[str, Any]:
    """返回前端只读资源工作区及稳定资源版本。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    return frontend_integration.resource_context()


@app.get("/api/v1/resource/gis-directory")
def frontend_gis_directory(request: Request, response: Response, revision: str, context: str = "gis"):
    return _frontend_workbench_call(response, lambda: (
        integration_identity.require(request, "situation.view"),
        gis_frontend_service.read("directory", context, revision))[1])


@app.get("/api/v1/resource/maintenance-context")
def frontend_resource_maintenance_context(request: Request, response: Response):
    def operation():
        integration_identity.require(request, "resources.view")
        integration_identity.require(request, "resources.device.edit")
        if len(request.query_params) != len(request.query_params.multi_items()):
            raise ValueError("查询参数不能重复")
        return resource_maintenance_service.context(ResourceMaintenanceQuery.model_validate(dict(request.query_params)))
    return _frontend_workbench_call(response, operation)


@app.post("/api/v1/resource/changes")
def frontend_resource_changes(request: Request, response: Response, payload: dict[str, Any]):
    def operation():
        identity = integration_identity.require(request, "resources.device.edit", writing=True)
        integration_identity.require(request, "resources.view")
        return resource_maintenance_service.save(ResourceDeviceChanges.model_validate(payload), identity["account_id"])
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/resource/gis-scene")
def frontend_gis_scene(request: Request, response: Response, revision: str, context: str = "gis"):
    return _frontend_workbench_call(response, lambda: (
        integration_identity.require(request, "situation.view"),
        gis_frontend_service.read("scene", context, revision))[1])


@app.post("/api/v1/resource/device-availability/preview")
def frontend_availability_preview(request: Request, response: Response, payload: dict[str, Any]):
    def operation():
        integration_identity.require(request, "resources.view")
        integration_identity.require(request, "resources.device.availability", writing=True)
        return resource_maintenance_service.availability_preview(AvailabilityPreview.model_validate(payload))
    return _frontend_workbench_call(response, operation)


@app.post("/api/v1/resource/device-availability")
def frontend_device_availability(request: Request, response: Response, payload: dict[str, Any]):
    def operation():
        integration_identity.require(request, "resources.view")
        actor = integration_identity.require(request, "resources.device.availability", writing=True)
        return resource_maintenance_service.set_availability(AvailabilityChange.model_validate(payload), actor["account_id"])
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/resource/map")
def frontend_resource_map(request: Request, response: Response):
    """视口筛选和聚合基于同一资源版本，拒绝静默忽略查询条件。"""
    return _resource_read_call(request, response, ResourceMapQuery, resource_read_projection.query_map)


def _resource_read_call(request, response, schema, action):
    def operation():
        if len(request.query_params) != len(request.query_params.multi_items()):
            raise ValueError("资源查询参数不能重复")
        query = schema.model_validate(dict(request.query_params))
        permission = {"ledger": "resources.view", "gis": "situation.view", "planning": "planning.view"}[query.context]
        integration_identity.require(request, permission)
        return action(query)
    return _frontend_workbench_call(response, operation)


@app.get("/api/v1/resource/nodes")
def frontend_resource_nodes(request: Request, response: Response):
    """节点关联筛选完成后分页；聚合成员号不得跨版本使用。"""
    return _resource_read_call(request, response, ResourceNodeQuery, resource_read_projection.query_nodes)


@app.get("/api/v1/resource/devices")
def frontend_resource_devices(request: Request, response: Response):
    """完整集合先筛选排序再分页；不再静默忽略页面传入条件。"""
    return _resource_read_call(request, response, ResourceDeviceReadQuery, resource_read_projection.query_devices)


@app.get("/api/v1/resource/interference-sources")
def frontend_resource_interferences(request: Request, response: Response):
    return _resource_read_call(request, response, ResourceInterferenceQuery, resource_read_projection.query_interferences)


@app.get("/api/v1/resource/nodes/{node_id}")
def frontend_resource_node(node_id: str, request: Request, response: Response):
    return _resource_read_call(request, response, ResourceObjectQuery,
        lambda query: resource_read_projection.query_object("node", node_id, query))


@app.get("/api/v1/resource/devices/{device_id}")
def frontend_resource_device(device_id: str, request: Request, response: Response):
    return _resource_read_call(request, response, ResourceObjectQuery,
        lambda query: resource_read_projection.query_object("device", device_id, query))


@app.get("/api/v1/resource/interference-sources/{interference_id}")
def frontend_resource_interference(interference_id: str, request: Request, response: Response):
    return _resource_read_call(request, response, ResourceObjectQuery,
        lambda query: resource_read_projection.query_object("interference", interference_id, query))


@app.get("/api/v1/resource/device-models")
def resource_device_models(device_class: str | None = None,
                           context: str | None = None,
                           revision: str | None = None,
                           ids: str | None = None) -> dict[str, Any]:
    """电台型号台账。含枚举取值与「该字段是否参与算法」的标注。"""
    if context in {"ledger", "gis", "planning"} and revision:
        try:
            return frontend_integration.resource_dictionary("model", ids, revision)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return list_device_models({"device_class": device_class})


@app.get("/api/v1/resource/antenna-models")
def resource_antenna_models(device_class: str | None = None,
                            context: str | None = None,
                            revision: str | None = None,
                            ids: str | None = None) -> dict[str, Any]:
    """天线型号台账。"""
    if context in {"ledger", "gis", "planning"} and revision:
        try:
            return frontend_integration.resource_dictionary("antenna", ids, revision)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    return list_antenna_models({"device_class": device_class})


@app.get("/api/v1/resource/frequency-pool")
def resource_frequency_pool(device_class: str | None = None,
                            context: str | None = None) -> dict[str, Any]:
    """频率资源池（SR-4.2.2.2 b 的展示面）。"""
    if context in {"ledger", "gis", "planning"}:
        return frontend_integration.planning_frequency_catalog()
    return list_frequency_pool({"device_class": device_class})


@app.get("/api/v1/resource/param-presets")
def resource_param_presets(context: str | None = None) -> dict[str, Any]:
    """三套预选参数配置（甲方指标「预选配置 ≥3 种」）。"""
    if context in {"ledger", "gis", "planning"}:
        return frontend_integration.planning_preset_catalog()
    return radio_param_presets()


# ── SR-4.2.4 / SR-4.2.5 / SR-4 全流程（第 4 周；异步任务同样用 /plan/tasks/{id} 查询） ──


@app.post("/api/v1/plan/network-optimize")
def plan_network_optimize(payload: dict[str, Any]) -> dict[str, Any]:
    """多目标优化组网（SR-4.2.4）。自研 NSGA-II，返回非支配解集与权衡曲线。"""
    return submit_optimize(payload)


@app.post("/api/v1/interference/analyze")
def interference_analyze(payload: dict[str, Any]) -> dict[str, Any]:
    """干扰影响分析与抗干扰推荐（SR-4.2.5）。"""
    return submit_interference(payload)


@app.post("/api/v1/interference/adopt")
def interference_adopt(payload: dict[str, Any]) -> dict[str, Any]:
    """采纳一条抗干扰措施（同步）。body: {analysis_id, countermeasure_id}"""
    return adopt_countermeasure(payload)


@app.post("/api/v1/plan/sr4-flow")
def plan_sr4_flow(payload: dict[str, Any], response: Response, http_request: Request) -> dict[str, Any]:
    """SR-4 全流程：部署 → 路由 → 频率/功率 → 优化 → 闭环重做 → 干扰分析。"""
    # 兼容旧调用方的枚举错误反馈；正式提交参数由下方版本化模型校验。
    if "preset" in payload and payload["preset"] not in {
            "TERRAIN", "MISSION", "INTERFERENCE"}:
        return {"code": 1003, "message": "preset 取值非法", "data": None}
    if "strategy" in payload and payload["strategy"] not in {
            "SHORTEST_PATH", "MIN_DELAY", "MAX_RELIABILITY"}:
        return {"code": 1003, "message": "strategy 取值非法", "data": None}
    try:
        request = PlanningJobSubmitRequest.model_validate(payload)
        data = planning_job_service.submit_planning_job(request, **_planning_business_kwargs(http_request, job=True))
        response.status_code = 202
        return {"code": 0, "message": "计算任务已提交", "data": data,
                "request_id": request.request_id}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": str(payload.get("task_id") or "task"),
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "SR4 提交参数校验失败", "data": issues,
                "request_id": payload.get("request_id")}
    except PlanningJobError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data,
                "request_id": payload.get("request_id")}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None,
                "request_id": payload.get("request_id")}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None,
                "request_id": payload.get("request_id")}


def _require_sr4_demo() -> None:
    if os.environ.get("SR4_INTEGRATION_DEMO") != "1":
        raise HTTPException(status_code=403, detail="SR4 integration demo is disabled")


@app.get("/api/v1/integration/sr4/catalog")
def sr4_integration_catalog() -> dict[str, Any]:
    _require_sr4_demo()
    return sr4_integration.catalog()


@app.get("/api/v1/integration/sr4/snapshots/{task_id}")
def sr4_integration_snapshot(task_id: str) -> dict[str, Any]:
    _require_sr4_demo()
    return sr4_integration.get_snapshot(task_id)


@app.put("/api/v1/integration/sr4/snapshots/{task_id}")
def sr4_integration_save(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    _require_sr4_demo()
    return sr4_integration.save_snapshot(task_id, payload)


@app.post("/api/v1/integration/sr4/runs")
def sr4_integration_run(payload: dict[str, Any]) -> dict[str, Any]:
    _require_sr4_demo()
    return sr4_integration.submit_snapshot(payload)


# ── 方案管理（接口文档 2.8） ──


@app.post("/api/v1/plans")
def plans_save(payload: dict[str, Any], response: Response, http_request: Request) -> dict[str, Any]:
    """保存版本化 SR4 作业结果，供方案列表和后续确认使用。"""
    try:
        request = PlanningPlanSaveRequest.model_validate(payload)
        data = planning_plan_service.save_planning_plan(request, **_planning_business_kwargs(http_request))
        return {"code": 0, "message": "方案版本已保存", "data": data,
                "request_id": request.request_id}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": str(payload.get("job_id") or "plan"),
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "方案保存参数校验失败", "data": issues,
                "request_id": payload.get("request_id")}
    except PlanningPlanError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data,
                "request_id": payload.get("request_id")}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None,
                "request_id": payload.get("request_id")}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None,
                "request_id": payload.get("request_id")}


@app.get("/api/v1/plan/saved-plans")
def saved_plan_history(response: Response, request: Request, context: str | None = None,
                       page: int = 1, page_size: int = 10,
                       search: str | None = None, state: str | None = None) -> dict[str, Any]:
    """项目方案目录由服务端规划查看权限约束，不冒充按个人隔离。"""
    try:
        integration_identity.require(request, "planning.view")
        # GIS目录保留实际页面上下文，额外校验GIS查看权，不借规划上下文绕权。
        if context == "gis":
            integration_identity.require(request, "situation.view")
    except integration_identity.IdentityError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    if context not in ("planning", "gis"):
        response.status_code = 422
        return {"code": 1001, "message": "context 只能是 planning 或 gis", "data": None}
    try:
        data = planning_plan_service.list_saved_plan_history(page, page_size, search, state)
        return {"code": 0, "message": "success", "data": data}
    except PlanningPlanError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.get("/api/v1/plans")
def plans_list(response: Response, task_id: str | None = None,
               context: str | None = None, page: int = 1, page_size: int = 10,
               search: str | None = None) -> dict[str, Any]:
    if task_id is None:
        return list_plans()
    if context != "planning":
        response.status_code = 422
        return {"code": 1001, "message": "context 只能是 planning", "data": None}
    try:
        data = planning_plan_service.list_planning_plans(
            task_id, page, page_size, search
        )
        return {"code": 0, "message": "success", "data": data}
    except PlanningPlanError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.get("/api/v1/plans/{solution_id}")
def plans_get(solution_id: str, response: Response, request: Request,
              task_id: str | None = None,
              context: str | None = None) -> dict[str, Any]:
    if task_id is None:
        return get_plan(solution_id)
    if context not in ("planning", "gis"):
        response.status_code = 422
        return {"code": 1001, "message": "context 只能是 planning 或 gis", "data": None}
    # GIS深链读取同一冻结方案，沿用目录的双查看权限，不借规划上下文绕权。
    if context == "gis":
        try:
            integration_identity.require(request, "planning.view")
            integration_identity.require(request, "situation.view")
        except integration_identity.IdentityError as exc:
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": None}
    try:
        data = planning_plan_service.get_planning_plan(solution_id, task_id)
        return {"code": 0, "message": "success", "data": data}
    except PlanningPlanError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/plans/compare")
def plans_compare(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    """对比版本化方案；旧格式继续返回算法摘要。"""
    if "context" not in payload and "task_id" not in payload:
        ids = payload.get("solution_ids")
        if not isinstance(ids, list) or not ids or any(
                not isinstance(item, str) or not item.strip() for item in ids):
            response.status_code = 422
            return {"code": 1001, "message": "solution_ids 须为非空方案编号列表", "data": None}
        return compare_plans(payload)
    try:
        request = PlanningPlanCompareRequest.model_validate(payload)
        data = planning_plan_service.compare_planning_plans(request)
        return {"code": 0, "message": "success", "data": data}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": payload.get("task_id", ""),
                   "field": ".".join(map(str, issue["loc"])),
                   "message": issue["msg"]} for issue in exc.errors()]
        return {"code": 1001, "message": "方案对比参数校验失败", "data": issues}
    except PlanningPlanError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/plans/{solution_id}/confirm")
def plans_confirm(solution_id: str, response: Response, http_request: Request,
                  payload: dict[str, Any] | None = None) -> dict[str, Any]:
    if payload is None:
        return confirm_plan(solution_id)
    try:
        request = PlanningPlanConfirmRequest.model_validate(payload)
        data = planning_plan_service.confirm_planning_plan(solution_id, request, **_planning_business_kwargs(http_request))
        return {"code": 0, "message": "方案已确认", "data": data,
                "request_id": request.request_id}
    except ValidationError as exc:
        response.status_code = 422
        issues = [{"objectId": solution_id,
                   "field": ".".join(map(str, issue["loc"])), "message": issue["msg"]}
                  for issue in exc.errors()]
        return {"code": 1001, "message": "方案确认参数校验失败", "data": issues,
                "request_id": payload.get("request_id")}
    except PlanningPlanError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": exc.data,
                "request_id": payload.get("request_id")}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None,
                "request_id": payload.get("request_id")}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None,
                "request_id": payload.get("request_id")}


@app.get("/api/v1/plans/{solution_id}/export")
def plans_export(solution_id: str, response: Response, format: str = "json",
                 context: str | None = None, task_id: str | None = None) -> Any:
    if context is not None or task_id is not None:
        try:
            request = PlanningPlanExportRequest.model_validate({
                "context": context, "task_id": task_id, "format": format,
            })
            data = planning_plan_service.export_planning_plan(solution_id, request)
            if request.format == "xlsx":
                return Response(
                    content=data,
                    media_type=("application/vnd.openxmlformats-officedocument."
                                "spreadsheetml.sheet"),
                    headers={"Content-Disposition":
                             f'attachment; filename="plan-{solution_id}.xlsx"'},
                )
            return {"code": 0, "message": "success", "data": data}
        except ValidationError as exc:
            response.status_code = 422
            issues = [{"objectId": solution_id,
                       "field": ".".join(map(str, issue["loc"])),
                       "message": issue["msg"]} for issue in exc.errors()]
            return {"code": 1001, "message": "方案导出参数校验失败", "data": issues}
        except PlanningPlanError as exc:
            response.status_code = exc.status
            return {"code": exc.code, "message": str(exc), "data": exc.data}
        except DatabaseConfigurationError:
            response.status_code = 503
            return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
        except SQLAlchemyError:
            response.status_code = 503
            return {"code": 5002, "message": "数据库操作失败", "data": None}

    result = export_plan(solution_id, format)
    if result["code"] == 0 and result["data"]["format"] == "xlsx":
        return Response(content=result["data"]["content"],
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": 'attachment; filename="plan.xlsx"'})
    return result


# SR-5 fault diagnosis. Analysis tasks share the established task state endpoint.


@app.get("/api/v1/fault/plan-sources")
def fault_plan_sources(response: Response, task_id: str | None = None) -> dict[str, Any]:
    try:
        return {"code": 0, "message": "success", "data": list_plan_sources(task_id)}
    except FaultPlanSourceError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


def _fault_scenario_call(response: Response, operation) -> dict[str, Any]:
    try:
        return operation()
    except FaultPlanSourceError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/fault/scenarios/validate")
def fault_scenario_validate(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: validate_scenario(payload))


@app.post("/api/v1/fault/scenarios/import")
async def fault_scenario_import(request: Request, response: Response,
                                context: str | None = None, task_id: str | None = None,
                                plan_id: str | None = None) -> dict[str, Any]:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        from .fault import import_scenarios_file
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            return {"code": 1001, "message": "缺少上传文件 file", "data": None}
        contents = await upload.read()
        return _fault_scenario_call(response, lambda: import_scenarios_file(
            upload.filename, contents, context=context, task_id=task_id, plan_id=plan_id))
    payload = await request.json()
    return _fault_scenario_call(response, lambda: import_scenarios(payload))


@app.get("/api/v1/fault/scenarios")
def fault_scenario_list(response: Response, context: str | None = None,
                        task_id: str | None = None,
                        include_archived: bool = False) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: list_scenarios(context, task_id, include_archived))


@app.post("/api/v1/fault/scenarios")
def fault_scenario_create(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: create_scenario(payload))


@app.get("/api/v1/fault/scenarios/{scenario_id}")
def fault_scenario_get(scenario_id: str, response: Response,
                       context: str | None = None, task_id: str | None = None,
                       version_id: str | None = None) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: get_scenario(
        scenario_id, context, task_id, version_id))


@app.put("/api/v1/fault/scenarios/{scenario_id}")
def fault_scenario_update(scenario_id: str, payload: dict[str, Any],
                          response: Response) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: update_scenario(scenario_id, payload))


@app.post("/api/v1/fault/scenarios/{scenario_id}/archive")
def fault_scenario_archive(scenario_id: str, payload: dict[str, Any],
                           response: Response) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: archive_scenario(scenario_id, payload))


@app.delete("/api/v1/fault/scenarios/{scenario_id}")
def fault_scenario_delete(scenario_id: str, response: Response,
                          context: str | None = None,
                          task_id: str | None = None) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: delete_scenario(scenario_id, context, task_id))


@app.post("/api/v1/fault/diagnose")
def fault_diagnose(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    try:
        return submit_diagnosis(payload)
    except FaultPlanSourceError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.post("/api/v1/fault/diagnose/observations")
def fault_diagnose_observations(payload: dict[str, Any]) -> dict[str, Any]:
    return submit_observation_diagnosis(payload)


@app.post("/api/v1/fault/diagnoses/{task_id}/feedback")
def fault_diagnosis_feedback(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return submit_diagnosis_feedback(task_id, payload)


@app.post("/api/v1/fault/impact")
def fault_impact(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    try:
        return submit_impact(payload)
    except FaultPlanSourceError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


@app.get("/api/v1/fault/impact/{task_id}/nodes")
def fault_impact_nodes(task_id: str, node_role: str | None = None,
                       region: str | None = None) -> dict[str, Any]:
    return get_impact_nodes(task_id, node_role, region)


@app.get("/api/v1/fault/tasks/{task_id}")
def fault_task_status(task_id: str) -> dict[str, Any]:
    return query_task(task_id)


@app.get("/api/v1/fault/analyses/{diagnose_task_id}")
def fault_analysis_view(diagnose_task_id: str, response: Response, task_id: str | None = None,
                        impact_task_id: str | None = None) -> dict[str, Any]:
    return _fault_scenario_call(response, lambda: get_analysis_view(
        diagnose_task_id, task_id, impact_task_id))


@app.get("/api/v1/fault/suggestions")
def fault_suggestions(diagnose_task_id: str, impact_task_id: str | None = None) -> dict[str, Any]:
    return get_suggestions(diagnose_task_id, impact_task_id)


@app.post("/api/v1/fault/report")
def fault_report(payload: dict[str, Any]) -> dict[str, Any]:
    return create_report(payload)


@app.get("/api/v1/fault/impact/{task_id}/export")
def fault_impact_export(task_id: str, format: str = "xlsx"):
    result = export_impact(task_id, format)
    if result is None:
        return {"code": 1001, "message": "影响任务不存在、未完成或导出格式不支持", "data": None}
    content, media_type = result
    return Response(content=content, media_type=media_type,
                    headers={"Content-Disposition": 'attachment; filename="impact.%s"' % format})


@app.get("/api/v1/files/{filename}")
def fault_file_download(filename: str):
    path = report_path(filename)
    if path is None:
        return {"code": 1002, "message": "文件不存在", "data": None}
    return FileResponse(path, filename=filename)


@app.get("/api/v1/kg/stats")
def kg_stats(response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, kg.stats)


def _kg_workflow_call(response: Response, operation) -> dict[str, Any]:
    try:
        return {"code": 0, "message": "success", "data": operation()}
    except KgWorkflowError as exc:
        response.status_code = exc.status
        return {"code": exc.code, "message": str(exc), "data": None}
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except SQLAlchemyError:
        response.status_code = 503
        return {"code": 5002, "message": "数据库操作失败", "data": None}


def _kg_existing_call(response: Response, operation) -> dict[str, Any]:
    """旧 SR6 路径保持原包络，同时把新存储异常转换为 HTTP 错误。"""
    try:
        return operation()
    except DatabaseConfigurationError:
        response.status_code = 503
        return {"code": 5001, "message": "DATABASE_URL 未配置", "data": None}
    except (SQLAlchemyError, KgWorkflowError) as exc:
        response.status_code = exc.status if isinstance(exc, KgWorkflowError) else 503
        return {"code": exc.code if isinstance(exc, KgWorkflowError) else 5002,
                "message": str(exc) if isinstance(exc, KgWorkflowError) else "数据库操作失败",
                "data": None}


@app.get("/api/v1/kg/workspace")
def kg_workspace(response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.workspace(kg.STORE_PATH))


@app.get("/api/v1/kg/versions/{version}/snapshot")
def kg_version_snapshot(version: int, response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.version_snapshot(
        kg.STORE_PATH, version))


@app.post("/api/v1/kg/changes")
def kg_save_draft(payload: KgDraftRequest, response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.save_draft(
        kg.STORE_PATH, payload.model_dump()))


@app.put("/api/v1/kg/changes/{change_id}")
def kg_update_draft(change_id: str, payload: KgDraftRequest,
                    response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.save_draft(
        kg.STORE_PATH, payload.model_dump(), change_id))


@app.post("/api/v1/kg/changes/{change_id}/submit")
def kg_submit_change(change_id: str, payload: KgTransitionRequest,
                     response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.transition(
        kg.STORE_PATH, change_id, payload.model_dump(), "SUBMIT"))


@app.post("/api/v1/kg/changes/{change_id}/withdraw")
def kg_withdraw_change(change_id: str, payload: KgTransitionRequest,
                       response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.transition(
        kg.STORE_PATH, change_id, payload.model_dump(), "WITHDRAW"))


@app.post("/api/v1/kg/changes/{change_id}/review")
def kg_review_change(change_id: str, payload: KgTransitionRequest,
                     response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.transition(
        kg.STORE_PATH, change_id, payload.model_dump(), "REVIEW"))


@app.post("/api/v1/kg/changes/{change_id}/publish")
def kg_publish_change(change_id: str, payload: KgTransitionRequest,
                      response: Response) -> dict[str, Any]:
    return _kg_workflow_call(response, lambda: kg_workflow_service.transition(
        kg.STORE_PATH, change_id, payload.model_dump(), "PUBLISH"))


@app.post("/api/v1/kg/updates/{change_id}/publish")
def kg_publish_update(change_id: str, payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.publish(change_id, payload))


@app.get("/api/v1/kg/entity/{entity_id}")
def kg_entity(entity_id: str, response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.entity(entity_id))


@app.get("/api/v1/kg/search")
def kg_search(q: str, response: Response, type: str | None = None, limit: int = 20) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.search(q, type, limit))


@app.get("/api/v1/kg/triples")
def kg_triples(response: Response, graph: str | None = None, relation: str | None = None,
               source: str | None = None, entity: str | None = None,
               offset: int = 0, limit: int = 100) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.triples(graph, relation, source, entity, offset, limit))


@app.get("/api/v1/kg/quality")
def kg_quality(response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, kg.quality)


@app.post("/api/v1/kg/query")
def kg_query(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.query(payload))


@app.post("/api/v1/kg/infer")
def kg_infer(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.infer(payload))


@app.post("/api/v1/kg/fault-cases")
def kg_submit_fault_case(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.submit_fault_case(payload))


@app.get("/api/v1/kg/fault-cases")
def kg_fault_cases(response: Response, include_pending: bool = True) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.fault_cases(include_pending))


@app.get("/api/v1/kg/device/{model_id}/knowledge")
def kg_device_knowledge(model_id: str, response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.device_knowledge(model_id))


@app.post("/api/v1/kg/link-state/evaluate")
def kg_evaluate_link_state(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.evaluate_link_state(payload))


@app.post("/api/v1/kg/updates")
def kg_submit_update(payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.submit(payload))


@app.get("/api/v1/kg/updates")
def kg_pending_updates(response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, kg.pending)


@app.post("/api/v1/kg/updates/{change_id}/review")
def kg_review_update(change_id: str, payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.review(change_id, payload))


@app.get("/api/v1/kg/versions")
def kg_versions(response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, kg.versions)


@app.get("/api/v1/kg/audit")
def kg_audit(response: Response, limit: int = 50) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.audit(limit))


@app.post("/api/v1/kg/versions/{version}/rollback")
def kg_rollback(version: int, payload: dict[str, Any], response: Response) -> dict[str, Any]:
    return _kg_existing_call(response, lambda: kg.rollback(version, payload))
