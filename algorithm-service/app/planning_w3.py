"""第 3 周规划服务层：路由规划 / 频率资源分配 / 电台参数规划。

对应软需 SR-4.2.2.1、SR-4.2.2.2、SR-4.2.3，接口契约见
`docs/design/03_接口文档.md` 2.3 / 2.4 / 2.5。

与部署规划一样走 SR-4.2 g) 要求的**异步任务模式**：提交立即返回 task_id，
另行查询进度与结果。纯标准库 threading，不引入任务队列。

算法核心全在 `scripts/planning/`（routing / frequency / radio_params /
plan_check），本层只做参数校验、任务编排与结果序列化。
"""
from __future__ import annotations

import csv
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
for _p in (REPO_ROOT / "scripts", REPO_ROOT / "scripts" / "planning"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

_TASKS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()
_CACHE: dict[str, Any] = {}

# 业务错误码，与接口文档 1.3 一致
CODE_OK = 0
CODE_BAD_PARAM = 1001
CODE_TASK_NOT_FOUND = 2001
CODE_TASK_RUNNING = 2002
CODE_TASK_FAILED = 2003
CODE_NO_SOLUTION = 3001
CODE_FREQ_SHORTAGE = 3002


def _load(rel: str) -> list[dict[str, str]]:
    from datapaths import path as dpath
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _terrain():
    if "terrain" not in _CACHE:
        from terrain import default_terrain
        _CACHE["terrain"] = default_terrain(verbose=False)
    return _CACHE["terrain"]


def _topology(force: bool = False):
    """规划拓扑（第 2 周部署结果重建），缓存复用。"""
    if force or "topo" not in _CACHE:
        from feasibility import stations_from_nodes
        from plan_pipeline import topology_from_deployment
        stations = stations_from_nodes(_load("node.csv"), _load("device.csv"),
                                       _load("device_model.csv"),
                                       _load("antenna_model.csv"))
        fm, sol, links = topology_from_deployment(stations, _terrain())
        _CACHE["topo"] = (stations, fm, sol, links)
    return _CACHE["topo"]


def _set(tid: str, **kw) -> None:
    with _LOCK:
        _TASKS.setdefault(tid, {}).update(kw)


def _spawn(kind: str, payload: dict[str, Any], fn) -> dict[str, Any]:
    tid = "tsk-%s" % uuid.uuid4().hex[:12]
    _set(tid, task_id=tid, kind=kind, status="PENDING", progress=0.0,
         stage="排队中", submitted_at=time.time(), result=None, error=None)

    def _worker():
        try:
            _set(tid, status="RUNNING", progress=0.05, stage="加载数据")
            data = fn(payload, lambda p, s: _set(tid, progress=p, stage=s))
            _set(tid, status="SUCCEEDED", progress=1.0, stage="完成",
                 result=data, finished_at=time.time())
        except Exception as exc:                     # noqa: BLE001
            _set(tid, status="FAILED", progress=1.0, stage="失败",
                 error="%s: %s" % (type(exc).__name__, exc),
                 finished_at=time.time())

    threading.Thread(target=_worker, daemon=True).start()
    return {"code": CODE_OK, "message": "success",
            "data": {"task_id": tid, "estimated_sec": 5}}


def query_task(task_id: str) -> dict[str, Any]:
    """三个接口共用的任务查询端点。"""
    with _LOCK:
        t = dict(_TASKS.get(task_id) or {})
    if not t:
        return {"code": CODE_TASK_NOT_FOUND, "message": "任务不存在或已过期", "data": None}
    if t["status"] == "FAILED":
        return {"code": CODE_TASK_FAILED, "message": "计算失败",
                "data": {"task_id": task_id, "error_detail": t.get("error")}}
    if t["status"] != "SUCCEEDED":
        return {"code": CODE_TASK_RUNNING, "message": "计算中",
                "data": {"task_id": task_id, "status": t["status"],
                         "progress": t["progress"], "stage": t["stage"]}}
    data = dict(t["result"] or {})
    data["task_id"] = task_id
    code, msg = CODE_OK, "success"
    if data.get("_code"):
        code, msg = data.pop("_code"), data.pop("_message", "success")
    return {"code": code, "message": msg, "data": data}


# ---------------------------------------------------------------- 路由规划

def _do_route(payload, tick):
    import routing
    stations, fm, sol, links = _topology()
    tick(0.35, "建路由图")
    metrics = _load("link_metric.csv")
    g, _skipped = routing.graph_from_links(links, metrics)
    demands = _load("comm_demand.csv")
    want = payload.get("demands")
    if want:
        by_id = {d["demand_id"]: d for d in demands}
        picked = []
        for w in want:
            d = by_id.get(w["demand_id"])
            if d is None:
                continue
            d = dict(d)
            if w.get("strategy"):
                d["strategy"] = w["strategy"]
            picked.append(d)
        demands = picked or demands
    strategy = payload.get("strategy", "MAX_RELIABILITY")
    if strategy not in routing.STRATEGIES:
        raise ValueError("strategy 只能是 %s" % "/".join(routing.STRATEGIES))
    tick(0.55, "求主用与备用路由")
    res = routing.plan_routes(g, demands, default_strategy=strategy,
                              manual_paths=payload.get("manual_paths"),
                              need_backup=payload.get("need_backup", True))
    tick(0.9, "汇总")
    out = dict(routes=res["routes"],
               unreachable_demand_ids=res["unreachable_demand_ids"],
               summary=dict(
                   total=len(res["routes"]),
                   reachable=sum(1 for r in res["routes"] if r["reachable"]),
                   with_backup=sum(1 for r in res["routes"] if r.get("backup")),
                   node_disjoint=sum(1 for r in res["routes"]
                                     if r.get("backup_type") == "NODE_DISJOINT")))
    if res["unreachable_demand_ids"]:
        out["_code"] = CODE_NO_SOLUTION
        out["_message"] = "部分通联需求无可达路由"
        out["suggestions"] = ["对不可达需求调用增设中继建议接口",
                             "或放宽链路余量门限后重跑部署规划"]
    return out


def submit_route(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("ROUTE", payload or {}, _do_route)


# ---------------------------------------------------------------- 频率分配

def _do_frequency(payload, tick):
    import frequency as FQ
    stations, fm, sol, links = _topology()
    nodes, devices = _load("node.csv"), _load("device.csv")
    models = _load("device_model.csv")
    tick(0.3, "构造分配对象")
    gran = (payload.get("granularity") or "NET").upper()
    builder = FQ.tasks_from_nets if gran == "NET" else FQ.tasks_from_links
    tasks = builder(links, nodes, devices, models)
    FQ.fill_ranges_by_node(tasks, links, nodes, devices, models)
    flt = payload.get("freq_pool_filter") or {}
    pool = FQ.FreqPool(_load("frequency_resource.csv"),
                       device_class=flt.get("device_class"),
                       freq_range_khz=flt.get("freq_range_khz"),
                       exclude_freq_ids=flt.get("exclude_freq_ids") or ())
    tick(0.6, "Dsatur 着色与冲突消解")
    res = FQ.assign(tasks, pool, manual=payload.get("manual_assignments"))
    tick(0.9, "摊开到链路")
    res["link_assignments"] = FQ.expand_to_links(res, tasks)
    res["granularity"] = gran
    if any(g["shortage"] > 0 for g in res["gap"].values()) or not res["conflict_free"]:
        res["_code"] = CODE_FREQ_SHORTAGE
        res["_message"] = "频率资源不足或存在无法完全避免的冲突"
    return res


def submit_frequency(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("FREQUENCY", payload or {}, _do_frequency)


# ---------------------------------------------------------------- 电台参数

def _do_radio_params(payload, tick):
    import radio_params as RP
    stations, fm, sol, links = _topology()
    devices, models = _load("device.csv"), _load("device_model.csv")
    antennas = _load("antenna_model.csv")
    tick(0.3, "装配设备可动范围")
    caps = RP.capabilities_from_tables(stations, devices, models, antennas)
    topo = RP.topo_from_links(stations, links)
    presets = payload.get("presets") or list(RP.PRESETS)
    tick(0.5, "逐套预选配置求解")
    results = []
    for pid in presets:
        if pid not in RP.PRESETS:
            raise ValueError("未知的预选配置 %s，可选 %s" % (pid, list(RP.PRESETS)))
        results.append(RP.plan(stations, topo, caps, _terrain(), preset=pid,
                               fade_margin_db=payload.get("fade_margin_db"),
                               manual_override=payload.get("manual_override")))
    rows = RP.compare_plans(results)
    best = RP.recommend(rows)
    chosen = next(r for r in results if r["preset"] == best["preset"])
    tick(0.9, "生成升级建议")
    out = dict(presets=RP.preset_list(), comparison=rows,
               recommended=best["preset"], plans=results,
               chosen=chosen,
               upgrade_advice=RP.upgrade_advice(chosen, caps))
    if chosen["summary"]["failed"]:
        out["_code"] = CODE_NO_SOLUTION
        out["_message"] = "部分链路参数到顶仍未达衰落余量要求"
    return out


def submit_radio_params(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("RADIO_PARAMS", payload or {}, _do_radio_params)


# ---------------------------------------------------------------- 方案校验

def _do_plan_check(payload, tick):
    import frequency as FQ
    import plan_check
    import radio_params as RP
    import routing
    stations, fm, sol, links = _topology()
    nodes, devices = _load("node.csv"), _load("device.csv")
    models, antennas = _load("device_model.csv"), _load("antenna_model.csv")
    tick(0.25, "路由")
    g, _s = routing.graph_from_links(links, _load("link_metric.csv"))
    routes = routing.plan_routes(g, _load("comm_demand.csv"))
    tick(0.5, "频率")
    tasks = FQ.tasks_from_nets(links, nodes, devices, models)
    FQ.fill_ranges_by_node(tasks, links, nodes, devices, models)
    freq = FQ.assign(tasks, FQ.FreqPool(_load("frequency_resource.csv")))
    tick(0.75, "参数")
    caps = RP.capabilities_from_tables(stations, devices, models, antennas)
    topo = RP.topo_from_links(stations, links)
    params = RP.plan(stations, topo, caps, _terrain(),
                     preset=payload.get("preset", "TERRAIN"))
    tick(0.9, "交叉校验")
    chk = plan_check.check(freq_result=freq, freq_tasks=tasks,
                           param_result=params, route_result=routes,
                           links=links, nodes=nodes, caps=caps)
    return chk


def submit_plan_check(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("PLAN_CHECK", payload or {}, _do_plan_check)
