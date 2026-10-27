"""第 3 周规划服务层：路由规划 / 频率资源分配 / 电台参数规划。

对应软需 SR-4.2.2.1、SR-4.2.2.2、SR-4.2.3，接口契约见
`docs/design/03_接口文档.md` 2.3 / 2.4 / 2.5。

与部署规划一样走 SR-4.2 g) 要求的**异步任务模式**：提交立即返回 task_id，
另行查询进度与结果。SR4使用标准库子进程隔离，其他入口使用线程。

算法核心全在 `scripts/planning/`（routing / frequency / radio_params /
plan_check），本层只做参数校验、任务编排与结果序列化。
"""
from __future__ import annotations

import csv
import multiprocessing
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .runtime_store import read_json, write_json

REPO_ROOT = Path(__file__).resolve().parents[2]
for _p in (REPO_ROOT / "scripts", REPO_ROOT / "scripts" / "planning"):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

_TASKS: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()
_CACHE: dict[str, Any] = {}
TASK_DIR = Path(os.environ.get("ALGORITHM_TASK_DIR", REPO_ROOT / "data" / "runtime" / "tasks"))
_FINAL_STATES = {"SUCCESS", "FAILED", "CANCELLED"}


class PlanningTaskCancelled(Exception):
    """算法在进度检查点收到取消请求。"""


class PlanningSearchFailed(Exception):
    def __init__(self, outcome):
        super().__init__(outcome["message"])
        self.outcome = outcome


def _budget_outcome(seconds):
    return dict(code=3001, kind="BUDGET_EXHAUSTED", proven_infeasible=False,
                message="计算预算内未找到可行方案，尚未证明无解",
                budget_seconds=seconds,
                reasons=[dict(code="TIME_BUDGET", message="已停止本次规划计算")],
                gap=[dict(objectId="task", field="budget", message="计算预算内未找到可行方案，尚未证明无解")],
                suggestions=["检查任务约束与频率资源后重新提交"])


def _isolated_worker(connection, fn, payload, plan_dir):
    """子进程仅接收冻结输入，不能接收数据库连接或业务回调。"""
    from . import planning_w4
    planning_w4.PLAN_DIR = Path(plan_dir)
    try:
        result = fn(payload, lambda progress, stage: connection.send(
            ("progress", (progress, stage))))
        connection.send(("result", result))
    except Exception as exc:
        outcome = getattr(exc, "outcome", None)
        if isinstance(exc, TimeoutError):
            from sr4_flow import TIME_LIMIT_S
            outcome = _budget_outcome(TIME_LIMIT_S)
        connection.send(("error", {"error": str(exc), "outcome": outcome}))
    finally:
        connection.close()


def _run_isolated(tid, fn, payload, checkpoint, seconds):
    """真正停止CPU进程并join后才允许父线程发布终态。"""
    from . import planning_w4
    ctx = multiprocessing.get_context("spawn")
    receiver, sender = ctx.Pipe(duplex=False)
    process = ctx.Process(target=_isolated_worker,
        args=(sender, fn, payload, str(planning_w4.PLAN_DIR)), daemon=True)
    deadline = time.monotonic() + seconds
    try:
        process.start()
        _set(tid, execution_pid=process.pid)
        sender.close()
        result, received = None, False
        while True:
            checkpoint(None, None)
            if time.monotonic() >= deadline:
                raise PlanningSearchFailed(_budget_outcome(seconds))
            try:
                ready = receiver.poll(.05)
            except (EOFError, OSError):
                break
            if ready:
                try:
                    kind, data = receiver.recv()
                except (EOFError, OSError):
                    break
                if kind == "progress":
                    checkpoint(*data)
                elif kind == "result":
                    result, received = data, True
                elif kind == "error":
                    if data.get("outcome"):
                        raise PlanningSearchFailed(data["outcome"])
                    raise RuntimeError(data["error"])
            elif not process.is_alive():
                break
        if not received or process.exitcode not in (None, 0):
            raise RuntimeError("规划子进程退出，未返回完整结果")
        return result
    finally:
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join()
            process.close()
        receiver.close()
        sender.close()

# 业务错误码，与接口文档 1.3 一致
CODE_OK = 0
CODE_BAD_PARAM = 1001
CODE_BAD_ENUM = 1003
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
        nodes, devices = _load("node.csv"), _load("device.csv")
        models, antennas = _load("device_model.csv"), _load("antenna_model.csv")
        stations = stations_from_nodes(nodes, devices, models, antennas)
        fm, sol, links, nodes_x, devices_x = topology_from_deployment(
            stations, _terrain(), nodes, devices, models, _load("candidate_site.csv"))
        stations = stations + [fm.stations[i] for i, _s in sol.added]
        _CACHE["topo"] = (stations, fm, sol, links)
        _CACHE["nodes_x"], _CACHE["devices_x"] = nodes_x, devices_x
    return _CACHE["topo"]


def _nodes():
    _topology()
    return _CACHE["nodes_x"]


def _devices():
    _topology()
    return _CACHE["devices_x"]


def _set(tid: str, **kw) -> dict[str, Any]:
    with _LOCK:
        if _TASKS.get(tid, {}).get("status") in _FINAL_STATES:
            return dict(_TASKS[tid])
        _TASKS.setdefault(tid, {}).update(kw)
        write_json(TASK_DIR / (tid + ".json"), _TASKS[tid])
        return dict(_TASKS[tid])


def _process_alive(pid):
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            # 无权限不能当作已停止，只有无效PID可确认不存在。
            return ctypes.get_last_error() != 87
        try:
            code = ctypes.c_ulong()
            if not kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)):
                return True
            return code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def get_task_record(task_id: str) -> dict[str, Any]:
    with _LOCK:
        task = _TASKS.get(task_id)
        if (task is None or (task.get("status") not in _FINAL_STATES
                and task.get("owner_pid") != os.getpid())) and task_id.startswith("tsk-") and len(task_id) == 16 and all(
                char in "0123456789abcdef" for char in task_id[4:]):
            path = TASK_DIR / (task_id + ".json")
            if path.exists():
                task = read_json(path)
                _TASKS[task_id] = task
        if (task and task.get("status") not in _FINAL_STATES and task.get("owner_pid")
                and not _process_alive(task["owner_pid"])):
            if not task.get("execution_pid") or _process_alive(task["execution_pid"]):
                # 不能因监督者丢失就释放活动作业锁；遗留进程仍可能占用CPU。
                task["stage"] = "监督进程已退出，计算进程尚未确认停止"
            else:
                task.update(status="FAILED", progress=1.0, stage="运行进程已退出",
                    error="服务中断，运行进程已退出且没有完整结果", execution_stopped=True,
                    finished_at=time.time())
                write_json(TASK_DIR / (task_id + ".json"), task)
        return dict(task or {})


def cancellation_requested(task_id: str) -> bool:
    return (TASK_DIR / (task_id + ".cancel.json")).exists()


def cancel_task(task_id: str) -> dict[str, Any]:
    """只记录取消意图；执行者退出后才能发布CANCELLED。"""
    with _LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            path = TASK_DIR / (task_id + ".json")
            task = read_json(path) if path.exists() else {"task_id": task_id}
            _TASKS[task_id] = task
        if task.get("status") not in _FINAL_STATES:
            write_json(TASK_DIR / (task_id + ".cancel.json"), {"cancel_requested": True})
            # 没有运行记录的待派发作业也保留意图，不能伪称执行已停止。
            task.setdefault("status", "PENDING")
            task.update(cancel_requested=True, stage="取消已受理，等待计算退出")
        return dict(task)


def _spawn(kind: str, payload: dict[str, Any], fn, *, task_id: str | None = None,
           on_update=None, isolated_budget_s: float | None = None) -> dict[str, Any]:
    if payload.get("callback_url") not in (None, ""):
        return {"code": CODE_BAD_PARAM, "message": "callback_url 尚未支持，请使用任务查询接口轮询",
                "data": None}
    tid = task_id or "tsk-%s" % uuid.uuid4().hex[:12]

    def publish(**fields):
        state = _set(tid, **fields)
        if on_update is not None:
            on_update(state)
        return state

    initial = publish(task_id=tid, kind=kind, status="PENDING", progress=0.0,
                      stage="排队中", submitted_at=time.time(), result=None, error=None,
                      owner_pid=os.getpid())

    def checkpoint(progress, stage) -> None:
        if cancellation_requested(tid):
            raise PlanningTaskCancelled()
        if progress is not None:
            if publish(progress=progress, stage=stage)["status"] == "CANCELLED":
                raise PlanningTaskCancelled()

    def _worker():
        try:
            checkpoint(None, None)
            if publish(status="RUNNING", progress=0.05, stage="加载数据")["status"] == "CANCELLED":
                return
            data = (fn(payload, checkpoint) if isolated_budget_s is None else
                    _run_isolated(tid, fn, payload, checkpoint, isolated_budget_s))
            checkpoint(None, None)
            publish(status="SUCCESS", progress=1.0, stage="完成",
                    result=data, finished_at=time.time())
        except PlanningTaskCancelled:
            publish(status="CANCELLED", stage="已取消", error=None,
                    execution_stopped=True, finished_at=time.time())
        except PlanningSearchFailed as exc:
            publish(status="FAILED", progress=1.0, stage=exc.outcome["message"],
                    error=str(exc), outcome=exc.outcome, finished_at=time.time())
        except Exception as exc:                     # noqa: BLE001
            publish(status="FAILED", progress=1.0, stage="失败",
                    error="%s: %s" % (type(exc).__name__, exc),
                    finished_at=time.time())

    if initial["status"] not in _FINAL_STATES:
        threading.Thread(target=_worker, daemon=True).start()
    return {"code": CODE_OK, "message": "success",
            "data": {"task_id": tid, "estimated_sec": 5}}


def query_task(task_id: str) -> dict[str, Any]:
    """三个接口共用的任务查询端点。"""
    t = get_task_record(task_id)
    if not t:
        return {"code": CODE_TASK_NOT_FOUND, "message": "任务不存在或已过期", "data": None}
    if t["status"] == "FAILED":
        outcome = t.get("outcome") or {}
        return {"code": outcome.get("code", CODE_TASK_FAILED),
                "message": outcome.get("message", "计算失败"),
                "data": {"task_id": task_id, "status": "FAILED",
                         "outcome": outcome or None, "error_detail": t.get("error")}}
    if t["status"] == "CANCELLED":
        return {"code": CODE_OK, "message": "计算已取消",
                "data": {"task_id": task_id, "status": "CANCELLED",
                         "progress": t.get("progress", 0), "stage": "已取消"}}
    if t["status"] != "SUCCESS":
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
    import routing
    payload = payload or {}
    strategies = [payload.get("strategy", "MAX_RELIABILITY")]
    demands = payload.get("demands") or []
    if not isinstance(demands, list) or any(not isinstance(row, dict) for row in demands):
        return {"code": CODE_BAD_PARAM, "message": "demands 必须是对象列表", "data": None}
    strategies.extend(row["strategy"] for row in demands if row.get("strategy") is not None)
    if any(strategy not in routing.STRATEGIES for strategy in strategies):
        return {"code": CODE_BAD_ENUM, "message": "strategy 只能是 %s" % "/".join(routing.STRATEGIES),
                "data": None}
    return _spawn("ROUTE", payload, _do_route)


# ---------------------------------------------------------------- 频率分配

def _do_frequency(payload, tick):
    import frequency as FQ
    stations, fm, sol, links = _topology()
    nodes, devices = _nodes(), _devices()
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
    payload = payload or {}
    if str(payload.get("granularity") or "NET").upper() not in ("NET", "LINK"):
        return {"code": CODE_BAD_ENUM, "message": "granularity 只能是 NET / LINK", "data": None}
    return _spawn("FREQUENCY", payload, _do_frequency)


# ---------------------------------------------------------------- 电台参数

def _do_radio_params(payload, tick):
    import radio_params as RP
    stations, fm, sol, links = _topology()
    devices, models = _devices(), _load("device_model.csv")
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
    import radio_params as RP
    payload = payload or {}
    presets = payload.get("presets") or list(RP.PRESETS)
    if not isinstance(presets, list) or any(not isinstance(preset, str) or preset not in RP.PRESETS
                                             for preset in presets):
        return {"code": CODE_BAD_ENUM, "message": "presets 只能包含 %s" % "/".join(RP.PRESETS),
                "data": None}
    return _spawn("RADIO_PARAMS", payload, _do_radio_params)


# ---------------------------------------------------------------- 方案校验

def _do_plan_check(payload, tick):
    import frequency as FQ
    import plan_check
    import radio_params as RP
    import routing
    stations, fm, sol, links = _topology()
    nodes, devices = _nodes(), _devices()
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
