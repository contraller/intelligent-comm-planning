"""FastAPI entrypoint for the algorithm service."""
from __future__ import annotations

from typing import Any

from .candidate_sites import filter_candidate_sites
from .coverage import query_coverage, read_cache, submit_coverage
from .deployment import query_deployment, submit_deployment
from .planning_w3 import (query_task, submit_frequency, submit_plan_check,
                          submit_radio_params, submit_route)
from .planning_w4 import (adopt_countermeasure, compare_plans, confirm_plan,
                          export_plan, get_plan, list_plans, submit_interference,
                          submit_optimize, submit_sr4)
from .resource import (list_antenna_models, list_device_models,
                       list_frequency_pool, radio_param_presets)

try:
    from fastapi import FastAPI
except ImportError as exc:  # pragma: no cover - exercised only without runtime deps
    raise RuntimeError(
        "FastAPI is not installed. Run: pip install -r algorithm-service/requirements.txt"
    ) from exc


app = FastAPI(title="短波/超短波智能规划算法服务", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"code": 0, "message": "success", "data": {"status": "ok"}}


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


@app.get("/api/v1/resource/device-models")
def resource_device_models(device_class: str | None = None) -> dict[str, Any]:
    """电台型号台账。含枚举取值与「该字段是否参与算法」的标注。"""
    return list_device_models({"device_class": device_class})


@app.get("/api/v1/resource/antenna-models")
def resource_antenna_models(device_class: str | None = None) -> dict[str, Any]:
    """天线型号台账。"""
    return list_antenna_models({"device_class": device_class})


@app.get("/api/v1/resource/frequency-pool")
def resource_frequency_pool(device_class: str | None = None) -> dict[str, Any]:
    """频率资源池（SR-4.2.2.2 b 的展示面）。"""
    return list_frequency_pool({"device_class": device_class})


@app.get("/api/v1/resource/param-presets")
def resource_param_presets() -> dict[str, Any]:
    """三套预选参数配置（甲方指标「预选配置 ≥3 种」）。"""
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
def plans_export(solution_id: str, format: str = "json") -> dict[str, Any]:
    return export_plan(solution_id, format)
