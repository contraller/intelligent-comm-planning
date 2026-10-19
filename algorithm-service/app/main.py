"""FastAPI entrypoint for the algorithm service."""
from __future__ import annotations

import os
from typing import Any

from .candidate_sites import filter_candidate_sites
from .coverage import query_coverage, read_cache, submit_coverage
from .database import DatabaseConfigurationError, check_database_connection
from .deployment import query_deployment, submit_deployment
from .fault import (create_report, create_scenario, delete_scenario, export_impact,
                    get_impact_nodes, get_scenario, get_suggestions, import_scenarios, list_scenarios,
                    report_path, submit_diagnosis, submit_observation_diagnosis,
                    submit_diagnosis_feedback, submit_impact, update_scenario,
                    validate_scenario)
from . import frontend_integration
from . import kg
from . import sr4_integration
from .planning_w3 import (query_task, submit_frequency, submit_plan_check,
                          submit_radio_params, submit_route)
from .planning_w4 import (adopt_countermeasure, compare_plans, confirm_plan,
                          export_plan, get_plan, list_plans, submit_interference,
                          submit_optimize, submit_sr4)
from .resource import (list_antenna_models, list_device_models,
                       list_frequency_pool, radio_param_presets)
from .task_input_schemas import TaskSaveRequest
from .task_input_service import TaskInputError, save_task_input

try:
    from fastapi import FastAPI, HTTPException, Request, Response
    from fastapi.responses import FileResponse
    from pydantic import ValidationError
    from sqlalchemy.exc import SQLAlchemyError
except ImportError as exc:  # pragma: no cover - exercised only without runtime deps
    raise RuntimeError(
        "FastAPI is not installed. Run: pip install -r algorithm-service/requirements.txt"
    ) from exc


app = FastAPI(title="短波/超短波智能规划算法服务", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"code": 0, "message": "success", "data": {"status": "ok"}}


@app.get("/api/v1/auth/session")
def frontend_auth_session(response: Response) -> dict[str, Any]:
    """返回显式开启的固定联调身份；不作为正式认证实现。"""
    if not frontend_integration.integration_enabled():
        response.status_code = 401
        return {"code": 1101, "message": "前端联调身份未启用", "data": None}
    return {"code": 0, "message": "success",
            "data": frontend_integration.session_identity()}


@app.get("/api/v1/auth/csrf")
def frontend_auth_csrf(response: Response) -> dict[str, Any]:
    """为首个任务写接口提供同会话的联调 CSRF 挑战。"""
    if not frontend_integration.integration_enabled():
        response.status_code = 401
        return {"code": 1101, "message": "前端联调身份未启用", "data": None}
    return {"code": 0, "message": "success",
            "data": frontend_integration.csrf_challenge()}


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
                             response: Response) -> dict[str, Any]:
    """保存规划任务输入，并返回数据库中的不可变版本。"""
    try:
        request = TaskSaveRequest.model_validate(payload)
        data = save_task_input(request, task_id)
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


@app.get("/api/v1/plan/tasks/{task_id}")
def plan_task_status(task_id: str) -> dict[str, Any]:
    """第 3 周四个接口共用的任务查询端点。"""
    return query_task(task_id)


# ── SR-3 资源台账（供 SR-2 前端设备配置界面） ──


@app.get("/api/v1/resource/context")
def frontend_resource_context(context: str = "planning") -> dict[str, Any]:
    """返回前端只读资源工作区及稳定资源版本。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    return frontend_integration.resource_context()


@app.get("/api/v1/resource/map")
def frontend_resource_map(revision: str, bbox: str, zoom: float,
                          show_nodes: bool = True,
                          show_interferences: bool = True,
                          context: str = "planning") -> dict[str, Any]:
    """按当前视口返回节点及干扰源；首个联调版本不做聚类。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        bounds = [float(value) for value in bbox.split(",")]
        return frontend_integration.resource_map(
            revision, bounds, zoom, show_nodes, show_interferences)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/resource/nodes")
def frontend_resource_nodes(revision: str, page: int = 1, page_size: int = 10,
                            search: str = "", parent_id: str | None = None,
                            context: str = "planning") -> dict[str, Any]:
    """返回资源树使用的节点分页。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        return frontend_integration.resource_page(
            "node", revision, page, page_size, search, parent_id=parent_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/resource/devices")
def frontend_resource_devices(revision: str, page: int = 1, page_size: int = 10,
                              search: str = "", node_id: str | None = None,
                              context: str = "planning") -> dict[str, Any]:
    """返回资源台账或节点详情使用的设备分页。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        return frontend_integration.resource_page(
            "device", revision, page, page_size, search, node_id=node_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/resource/interference-sources")
def frontend_resource_interferences(revision: str, page: int = 1,
                                    page_size: int = 10, search: str = "",
                                    context: str = "planning") -> dict[str, Any]:
    """返回地图资源树使用的干扰源分页。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        return frontend_integration.resource_page(
            "interference", revision, page, page_size, search)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/resource/nodes/{node_id}")
def frontend_resource_node(node_id: str, revision: str,
                           context: str = "planning") -> dict[str, Any]:
    """读取任务输入引用的单个节点。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        return frontend_integration.resource_object("node", node_id, revision)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="resource node not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/resource/devices/{device_id}")
def frontend_resource_device(device_id: str, revision: str,
                             context: str = "planning") -> dict[str, Any]:
    """读取任务输入引用的单个设备及其显示关联。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        return frontend_integration.resource_object("device", device_id, revision)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="resource device not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/v1/resource/interference-sources/{interference_id}")
def frontend_resource_interference(interference_id: str, revision: str,
                                   context: str = "planning") -> dict[str, Any]:
    """读取地图或任务引用的单个干扰源。"""
    if context not in {"ledger", "gis", "planning"}:
        raise HTTPException(status_code=422, detail="invalid resource context")
    try:
        return frontend_integration.resource_object("interference", interference_id, revision)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="interference source not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


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
def plan_sr4_flow(payload: dict[str, Any]) -> dict[str, Any]:
    """SR-4 全流程：部署 → 路由 → 频率/功率 → 优化 → 闭环重做 → 干扰分析。"""
    return submit_sr4(payload)


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


@app.get("/api/v1/plans")
def plans_list() -> dict[str, Any]:
    return list_plans()


@app.get("/api/v1/plans/{solution_id}")
def plans_get(solution_id: str) -> dict[str, Any]:
    return get_plan(solution_id)


@app.post("/api/v1/plans/compare")
def plans_compare(payload: dict[str, Any]) -> dict[str, Any]:
    """多方案横向对比。body: {solution_ids: [...]}"""
    return compare_plans(payload)


@app.post("/api/v1/plans/{solution_id}/confirm")
def plans_confirm(solution_id: str) -> dict[str, Any]:
    return confirm_plan(solution_id)


@app.get("/api/v1/plans/{solution_id}/export")
def plans_export(solution_id: str, format: str = "json") -> Any:
    result = export_plan(solution_id, format)
    if result["code"] == 0 and result["data"]["format"] == "xlsx":
        return Response(content=result["data"]["content"],
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": 'attachment; filename="plan.xlsx"'})
    return result


# SR-5 fault diagnosis. Analysis tasks share the established task state endpoint.


@app.post("/api/v1/fault/scenarios/validate")
def fault_scenario_validate(payload: dict[str, Any]) -> dict[str, Any]:
    return validate_scenario(payload)


@app.post("/api/v1/fault/scenarios/import")
async def fault_scenario_import(request: Request) -> dict[str, Any]:
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        from .fault import import_scenarios_file
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            return {"code": 1001, "message": "缺少上传文件 file", "data": None}
        return import_scenarios_file(upload.filename, await upload.read())
    return import_scenarios(await request.json())


@app.get("/api/v1/fault/scenarios")
def fault_scenario_list() -> dict[str, Any]:
    return list_scenarios()


@app.post("/api/v1/fault/scenarios")
def fault_scenario_create(payload: dict[str, Any]) -> dict[str, Any]:
    return create_scenario(payload)


@app.get("/api/v1/fault/scenarios/{scenario_id}")
def fault_scenario_get(scenario_id: str) -> dict[str, Any]:
    return get_scenario(scenario_id)


@app.put("/api/v1/fault/scenarios/{scenario_id}")
def fault_scenario_update(scenario_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return update_scenario(scenario_id, payload)


@app.delete("/api/v1/fault/scenarios/{scenario_id}")
def fault_scenario_delete(scenario_id: str) -> dict[str, Any]:
    return delete_scenario(scenario_id)


@app.post("/api/v1/fault/diagnose")
def fault_diagnose(payload: dict[str, Any]) -> dict[str, Any]:
    return submit_diagnosis(payload)


@app.post("/api/v1/fault/diagnose/observations")
def fault_diagnose_observations(payload: dict[str, Any]) -> dict[str, Any]:
    return submit_observation_diagnosis(payload)


@app.post("/api/v1/fault/diagnoses/{task_id}/feedback")
def fault_diagnosis_feedback(task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return submit_diagnosis_feedback(task_id, payload)


@app.post("/api/v1/fault/impact")
def fault_impact(payload: dict[str, Any]) -> dict[str, Any]:
    return submit_impact(payload)


@app.get("/api/v1/fault/impact/{task_id}/nodes")
def fault_impact_nodes(task_id: str, node_role: str | None = None,
                       region: str | None = None) -> dict[str, Any]:
    return get_impact_nodes(task_id, node_role, region)


@app.get("/api/v1/fault/tasks/{task_id}")
def fault_task_status(task_id: str) -> dict[str, Any]:
    return query_task(task_id)


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
def kg_stats() -> dict[str, Any]:
    return kg.stats()


@app.get("/api/v1/kg/entity/{entity_id}")
def kg_entity(entity_id: str) -> dict[str, Any]:
    return kg.entity(entity_id)


@app.get("/api/v1/kg/search")
def kg_search(q: str, type: str | None = None, limit: int = 20) -> dict[str, Any]:
    return kg.search(q, type, limit)


@app.get("/api/v1/kg/triples")
def kg_triples(graph: str | None = None, relation: str | None = None,
               source: str | None = None, entity: str | None = None,
               offset: int = 0, limit: int = 100) -> dict[str, Any]:
    return kg.triples(graph, relation, source, entity, offset, limit)


@app.get("/api/v1/kg/quality")
def kg_quality() -> dict[str, Any]:
    return kg.quality()


@app.post("/api/v1/kg/query")
def kg_query(payload: dict[str, Any]) -> dict[str, Any]:
    return kg.query(payload)


@app.post("/api/v1/kg/infer")
def kg_infer(payload: dict[str, Any]) -> dict[str, Any]:
    return kg.infer(payload)


@app.post("/api/v1/kg/fault-cases")
def kg_submit_fault_case(payload: dict[str, Any]) -> dict[str, Any]:
    return kg.submit_fault_case(payload)


@app.get("/api/v1/kg/fault-cases")
def kg_fault_cases(include_pending: bool = True) -> dict[str, Any]:
    return kg.fault_cases(include_pending)


@app.get("/api/v1/kg/device/{model_id}/knowledge")
def kg_device_knowledge(model_id: str) -> dict[str, Any]:
    return kg.device_knowledge(model_id)


@app.post("/api/v1/kg/link-state/evaluate")
def kg_evaluate_link_state(payload: dict[str, Any]) -> dict[str, Any]:
    return kg.evaluate_link_state(payload)


@app.post("/api/v1/kg/updates")
def kg_submit_update(payload: dict[str, Any]) -> dict[str, Any]:
    return kg.submit(payload)


@app.get("/api/v1/kg/updates")
def kg_pending_updates() -> dict[str, Any]:
    return kg.pending()


@app.post("/api/v1/kg/updates/{change_id}/review")
def kg_review_update(change_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return kg.review(change_id, payload)


@app.get("/api/v1/kg/versions")
def kg_versions() -> dict[str, Any]:
    return kg.versions()


@app.get("/api/v1/kg/audit")
def kg_audit(limit: int = 50) -> dict[str, Any]:
    return kg.audit(limit)


@app.post("/api/v1/kg/versions/{version}/rollback")
def kg_rollback(version: int, payload: dict[str, Any]) -> dict[str, Any]:
    return kg.rollback(version, payload)
