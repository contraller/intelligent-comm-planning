"""为 SR5 提供数据库中已确认的 SR4 冻结方案。"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from . import frontend_integration
from .database import get_session_factory
from .planning_plan_models import PlanningCurrentPlan, PlanningPlan


class FaultPlanSourceError(ValueError):
    def __init__(self, code: int, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _snapshot(plan: PlanningPlan) -> dict[str, Any]:
    raw = plan.raw_snapshot
    detail = raw.get("detail") if isinstance(raw, dict) else None
    if not isinstance(detail, dict) or any(
        not isinstance(detail.get(key), list) or not detail[key]
        for key in ("nodes", "devices", "links")
    ) or not isinstance(detail.get("routes"), dict) or not isinstance(
        detail["routes"].get("routes"), list
    ) or not detail["routes"]["routes"]:
        raise FaultPlanSourceError(1203, "方案缺少完整冻结拓扑，请重新运行并保存 SR4 方案", 409)
    if plan.source != "SR4" or not isinstance(raw.get("summary"), dict):
        raise FaultPlanSourceError(1203, "方案不是完整的 SR4 冻结结果", 409)
    input_data = plan.input_snapshot
    demands = input_data.get("demands") if isinstance(input_data, dict) else None
    if not isinstance(demands, list) or not demands:
        raise FaultPlanSourceError(1203, "方案缺少冻结通联需求", 409)
    try:
        nodes = {row["node_id"]: row for row in detail["nodes"]}
        devices = {row["device_id"]: row for row in detail["devices"]}
        links = {row["link_id"]: row for row in detail["links"]}
        demand_ids = {row["id"] for row in demands}
        if any(not ids or len(ids) != len(rows) or not all(
            isinstance(key, str) and key for key in ids
        ) for ids, rows in ((nodes, detail["nodes"]), (devices, detail["devices"]),
                            (links, detail["links"]), (demand_ids, demands))):
            raise ValueError("编号缺失或重复")
        if any(row["node_id"] not in nodes for row in devices.values()):
            raise ValueError("设备所属节点不存在")
        for link in links.values():
            if link["node_a_id"] not in nodes or link["node_b_id"] not in nodes:
                raise ValueError("链路端点不存在")
            if str(link.get("is_available", "true")).lower() != "false":
                for side in ("a", "b"):
                    device = devices.get(link.get(f"device_{side}_id"))
                    if device is None or device["node_id"] != link[f"node_{side}_id"]:
                        raise ValueError("可用链路缺少设备绑定")
        for route in detail["routes"]["routes"]:
            if route["demand_id"] not in demand_ids:
                raise ValueError("路由引用的需求不存在")
            for path in (route.get("primary"), route.get("backup")):
                if path:
                    node_path, link_path = path["node_path"], path["link_path"]
                    if (not node_path or len(node_path) != len(link_path) + 1
                            or not set(node_path) <= nodes.keys()
                            or not set(link_path) <= links.keys()):
                        raise ValueError("路由引用的节点或链路不存在")
                    if any({a, b} != {links[lid]["node_a_id"], links[lid]["node_b_id"]}
                           for a, b, lid in zip(node_path, node_path[1:], link_path)):
                        raise ValueError("路由节点顺序与链路端点不一致")
        network = {
            "nodes": deepcopy(detail["nodes"]),
            "devices": deepcopy(detail["devices"]),
            "links": deepcopy(detail["links"]),
            "demands": [{
                "demand_id": row["id"],
                "required_rate_kbps": row["requiredRateKbps"],
                "is_mandatory": "true" if row["mandatory"] else "false",
            } for row in demands],
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise FaultPlanSourceError(1203, "方案冻结拓扑引用不完整，请重新生成 SR4 方案", 409) from exc
    return {
        "meta": {
            "task_id": plan.task_id,
            "plan_id": plan.plan_id,
            "revision": plan.revision_id,
            "resource_revision": plan.resource_revision,
            "name": plan.name,
            "version": f"V{plan.version_no}",
            "state": plan.state,
        },
        "network": network,
        "solution": {
            "solution_id": plan.plan_id,
            "kind": "SR4_FLOW",
            "summary": deepcopy(raw.get("summary") or {}),
            "detail": deepcopy(detail),
        },
    }


def load_plan_source(task_id: str | None, plan_id: str | None = None,
                     *, require_current: bool = True) -> dict[str, Any]:
    """提交时检查当前方案；后续影响分析可回读同一冻结版本。"""
    if not task_id or not isinstance(task_id, str):
        raise FaultPlanSourceError(1001, "task_id 必填", 422)
    with get_session_factory()() as session:
        pointer = session.get(PlanningCurrentPlan, task_id)
        if require_current:
            if pointer is None:
                raise FaultPlanSourceError(2001, "当前任务没有已确认的 SR4 方案", 404)
            if plan_id is not None and plan_id != pointer.plan_id:
                raise FaultPlanSourceError(1203, "所选方案不是任务的当前确认方案", 409)
            plan_id = pointer.plan_id
        if not isinstance(plan_id, str) or not plan_id:
            raise FaultPlanSourceError(1001, "plan_id 必填", 422)
        plan = session.get(PlanningPlan, plan_id)
        if plan is None or plan.task_id != task_id:
            raise FaultPlanSourceError(2001, "规划方案不存在或不属于该任务", 404)
        if plan.state != "CONFIRMED":
            raise FaultPlanSourceError(1203, "仅已确认的 SR4 方案可用于正式诊断", 409)
        if require_current and plan.resource_revision != frontend_integration.resource_revision():
            raise FaultPlanSourceError(1205, "方案资源版本已变化，请重新规划并确认", 409)
        return _snapshot(plan)


def list_plan_sources(task_id: str | None) -> dict[str, Any]:
    try:
        source = load_plan_source(task_id)
    except FaultPlanSourceError as exc:
        if exc.code == 1001:
            raise
        return {"items": [], "total": 0, "reason": str(exc)}
    return {"items": [source["meta"]], "total": 1, "reason": None}
