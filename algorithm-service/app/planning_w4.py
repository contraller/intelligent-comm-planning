"""第 4 周服务层：多目标优化组网、干扰分析与抗干扰推荐、SR-4 全流程、方案管理。

对应软需 SR-4.2.4、SR-4.2.5、SR-4.2 a/g，接口契约见
`docs/design/03_接口文档.md` 2.6 / 2.7 / 2.8。

异步接口复用第 3 周的任务表与查询端点 `/plan/tasks/{task_id}`；
`/interference/adopt` 按接口文档要求为同步接口。
纯标准库；方案存于进程内（与覆盖缓存一样，持久化方案待与前端约定）。
"""
from __future__ import annotations

import csv
import io
import json
import threading
import time
import uuid
from typing import Any

from .planning_w3 import (CODE_BAD_PARAM, CODE_NO_SOLUTION, CODE_OK, CODE_TASK_NOT_FOUND,
                          _load, _set, _spawn, _terrain, _topology, _nodes, _devices)

_PLANS: dict[str, dict[str, Any]] = {}
_SCENARIOS: dict[str, Any] = {}          # 干扰分析场景，供 adopt 使用
_PLOCK = threading.Lock()


def _new_plan_id() -> str:
    return "PL-%s" % uuid.uuid4().hex[:8].upper()


def _save_plan(kind: str, summary: dict[str, Any], detail: dict[str, Any]) -> str:
    pid = _new_plan_id()
    with _PLOCK:
        _PLANS[pid] = dict(solution_id=pid, kind=kind, created_at=time.time(),
                           confirmed=False, summary=summary, detail=detail)
    return pid


def _w3_state():
    """第 3 周的规划结果（频率、参数、路由），干扰分析与优化的共同底座。"""
    import frequency as FQ
    import radio_params as RP
    import routing
    stations, fm, sol, links = _topology()
    nodes, devices = _nodes(), _devices()
    models, antennas = _load("device_model.csv"), _load("antenna_model.csv")
    ftasks = FQ.tasks_from_nets(links, nodes, devices, models)
    FQ.fill_ranges_by_node(ftasks, links, nodes, devices, models)
    freq = FQ.assign(ftasks, FQ.FreqPool(_load("frequency_resource.csv")))
    freq["link_assignments"] = FQ.expand_to_links(freq, ftasks)
    caps = RP.capabilities_from_tables(stations, devices, models, antennas)
    params = RP.plan(stations, RP.topo_from_links(stations, links), caps, _terrain(),
                     preset="TERRAIN")
    g, _s = routing.graph_from_links(links, _load("link_metric.csv"))
    routes = routing.plan_routes(g, _load("comm_demand.csv"))
    return dict(stations=stations, fm=fm, sol=sol, links=links, terrain=_terrain(),
                frequency=freq, freq_tasks=ftasks, params=params, caps=caps,
                graph=g, routes=routes)


# ─────────────────────────── 多目标优化 ───────────────────────────

def _do_optimize(payload, tick):
    import multi_objective as MO
    st = _w3_state()
    tick(0.3, "构造优化问题")
    demands = _load("comm_demand.csv")
    want = set(payload.get("mandatory_demand_ids") or [])
    if want:
        # 前端指定了必要通联：以请求为准覆盖数据里的 is_mandatory
        demands = [dict(d, is_mandatory="true" if d["demand_id"] in want else "false")
                   for d in demands]
    hc = payload.get("hard_constraints") or {}
    cons = dict(MO.DEFAULT_CONSTRAINTS)
    for k in cons:
        if k in hc:
            cons[k] = hc[k]
    pb = MO.Problem(st["fm"], st["sol"], demands, st["caps"],
                    locked_links=payload.get("locked_links") or (),
                    locked_relays=payload.get("locked_relay_sites") or (),
                    survivability_threshold=cons["survivability_threshold"])
    tick(0.4, "NSGA-II 求解")
    gens = int(payload.get("generations", 40))
    res = MO.optimize(pb, constraints=cons, pop_size=int(payload.get("pop_size", 40)),
                      generations=gens, pareto_size=int(payload.get("pareto_size", 10)),
                      progress=lambda g, n: tick(0.4 + 0.5 * g / n, "第 %d/%d 代" % (g, n)))
    sols = [MO.describe(pb, e, res["constraints"], rank=k)
            for k, e in enumerate(res["solutions"], start=1)]
    for s_ in sols:
        allp = all(v["pass"] for v in s_["constraint_check"].values())
        s_["feasible"] = allp
        # 摘要里带上可行标记：无可行解时返回的是「离约束最近」的解，
        # 也会存成方案供对比，但前端列表必须能区分出来
        s_["solution_id"] = _save_plan("NETWORK_OPTIMIZE",
                                       dict(s_["objectives"], feasible=allp), s_)
    out = dict(feasible=res["feasible"], pareto_solutions=sols,
               tradeoff=[MO.describe(pb, e, res["constraints"]) for e in res["tradeoff"]],
               comparison=MO.compare(sols),
               critical_bridges=[dict(subtree_root=r, mandatory_cut=c)
                                 for c, r in pb.critical_bridges],
               evaluations=res["evaluations"], constraints=res["constraints"],
               infeasible_reason=None, suggestions=[])
    if not res["feasible"]:
        inf = res["infeasible"]
        out["infeasible_reason"] = "；".join(inf["conflicting_constraints"])
        out["suggestions"] = inf["suggestions"]
        out["best_achievable"] = inf["best_achievable"]
        out["_code"], out["_message"] = CODE_NO_SOLUTION, "给定硬约束下未找到可行解"
    return out


def submit_optimize(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("NETWORK_OPTIMIZE", payload or {}, _do_optimize)


# ─────────────────────────── 干扰分析 ───────────────────────────

def _do_interference(payload, tick):
    import interference as IF
    st = _w3_state()
    tick(0.35, "构造干扰场景")
    jam = _load("interference_source.csv")
    ids = set(payload.get("interference_ids") or [])
    if ids:
        jam = [dict(r, active="true" if r["interference_id"] in ids else "false") for r in jam]
    sc = IF.scenario_from_plan(st, jam)
    tick(0.5, "计算受扰链路、节点与影响区域")
    ana = IF.analyze(sc, area=True, area_cell_m=float(payload.get("area_cell_m", 3000.0)))
    out = {k: v for k, v in ana.items() if k != "_states"}
    if payload.get("recommend", True):
        tick(0.8, "生成抗干扰措施")
        cms, unresolved, review = IF.recommend(
            sc, ana, freq_ctx=IF.FreqContext(st["freq_tasks"], st["frequency"]["assignments"]),
            caps=st["caps"], route_ctx=(st["graph"], st["routes"]),
            candidate_rows=_load("candidate_site.csv"))
        for k, c in enumerate(cms, start=1):
            c["countermeasure_id"] = "CM-%03d" % k
        out.update(countermeasures=cms, unresolved=unresolved, measure_review=review)
    sid = "IA-%s" % uuid.uuid4().hex[:8].upper()
    with _PLOCK:
        _SCENARIOS[sid] = dict(scenario=sc, countermeasures=out.get("countermeasures", []))
    out["analysis_id"] = sid
    return out


def submit_interference(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("INTERFERENCE", payload or {}, _do_interference)


def adopt_countermeasure(payload: dict[str, Any]) -> dict[str, Any]:
    """`POST /interference/adopt` —— 同步。采纳某条措施，更新场景并返回改动后概况。"""
    import interference as IF
    aid, cid = payload.get("analysis_id"), payload.get("countermeasure_id")
    with _PLOCK:
        rec = _SCENARIOS.get(aid)
    if rec is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "分析结果不存在或已过期", "data": None}
    cm = next((c for c in rec["countermeasures"] if c.get("countermeasure_id") == cid), None)
    if cm is None:
        return {"code": CODE_BAD_PARAM, "message": "措施 %s 不存在" % cid, "data": None}
    t0 = time.time()
    res = IF.adopt(rec["scenario"], cm)
    res["elapsed_s"] = round(time.time() - t0, 3)
    return {"code": CODE_OK, "message": "success", "data": res}


# ─────────────────────────── SR-4 全流程 ───────────────────────────

def _do_sr4(payload, tick):
    import sr4_flow
    tick(0.1, "全流程执行中")
    o = sr4_flow.run(task_id=payload.get("task_id"),
                     preset=payload.get("preset", "TERRAIN"),
                     strategy=payload.get("strategy", "MAX_RELIABILITY"),
                     constraints=payload.get("hard_constraints"), verbose=False)
    b = o["optimization"]["best"]
    summary = dict(task_id=o["task_id"], total_s=round(o["total_s"], 2),
                   within_limit=o["within_limit"], objectives=b["objectives"],
                   feasible=o["optimization"]["feasible"],
                   frequency_conflicts=len(o["frequency"]["conflicts"]),
                   check_passed=o["check"]["passed"],
                   affected_links=o["interference"]["analysis"]["summary"]["affected_links"])
    detail = dict(steps=[dict(stage=n, seconds=round(t, 3)) for n, t in o["steps"]],
                  optimization=o["optimization"], routes=o["routes"],
                  frequency=o["frequency"], params=o["params"], check=o["check"],
                  interference=o["interference"], links=o["links"])
    pid = _save_plan("SR4_FLOW", summary, detail)
    return dict(solution_id=pid, summary=summary,
                steps=detail["steps"], optimization=o["optimization"],
                check=o["check"]["summary"])


def submit_sr4(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("SR4_FLOW", payload or {}, _do_sr4)


# ─────────────────────────── 方案管理（接口文档 2.8）───────────────────────────

def list_plans(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    with _PLOCK:
        items = [dict(solution_id=p["solution_id"], kind=p["kind"],
                      created_at=p["created_at"], confirmed=p["confirmed"],
                      summary=p["summary"]) for p in _PLANS.values()]
    items.sort(key=lambda x: -x["created_at"])
    return {"code": CODE_OK, "message": "success", "data": {"total": len(items), "items": items}}


def get_plan(pid: str) -> dict[str, Any]:
    with _PLOCK:
        p = _PLANS.get(pid)
    if p is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "方案不存在", "data": None}
    return {"code": CODE_OK, "message": "success", "data": p}


def compare_plans(payload: dict[str, Any]) -> dict[str, Any]:
    """多方案横向对比（SR-4.2.4 扩展 3）。只比对象里都有的数值指标。"""
    ids = payload.get("solution_ids") or []
    with _PLOCK:
        ps = [_PLANS.get(i) for i in ids]
    missing = [i for i, p in zip(ids, ps) if p is None]
    if missing:
        return {"code": CODE_TASK_NOT_FOUND, "message": "方案不存在：%s" % missing, "data": None}
    rows = []
    for p in ps:
        flat = {}
        for k, v in p["summary"].items():
            if isinstance(v, dict):
                for k2, v2 in v.items():
                    if isinstance(v2, (int, float)) and not isinstance(v2, bool):
                        flat["%s.%s" % (k, k2)] = v2
            elif isinstance(v, (int, float)) and not isinstance(v, bool):
                flat[k] = v
        rows.append(dict(solution_id=p["solution_id"], kind=p["kind"], metrics=flat))
    return {"code": CODE_OK, "message": "success", "data": {"rows": rows}}


def confirm_plan(pid: str) -> dict[str, Any]:
    with _PLOCK:
        p = _PLANS.get(pid)
        if p is None:
            return {"code": CODE_TASK_NOT_FOUND, "message": "方案不存在", "data": None}
        p["confirmed"] = True
        p["confirmed_at"] = time.time()
    return {"code": CODE_OK, "message": "success",
            "data": {"solution_id": pid, "confirmed": True}}


def export_plan(pid: str, fmt: str = "json") -> dict[str, Any]:
    """导出。json 与 csv 两种；**xlsx 未实现**——纯标准库约束下需手写
    Office Open XML，待与前端确认确有需要再做（接口文档 2.8 列了 xlsx）。"""
    with _PLOCK:
        p = _PLANS.get(pid)
    if p is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "方案不存在", "data": None}
    fmt = (fmt or "json").lower()
    if fmt == "json":
        return {"code": CODE_OK, "message": "success",
                "data": {"format": "json", "content": json.dumps(p, ensure_ascii=False,
                                                                 default=str)}}
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["key", "value"])
        for k, v in p["summary"].items():
            w.writerow([k, json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v])
        return {"code": CODE_OK, "message": "success",
                "data": {"format": "csv", "content": buf.getvalue()}}
    return {"code": CODE_BAD_PARAM, "message": "暂只支持 json / csv；xlsx 待定", "data": None}
