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
import math
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .runtime_store import read_json, write_json
from .planning_w3 import (CODE_BAD_ENUM, CODE_BAD_PARAM, CODE_NO_SOLUTION, CODE_OK,
                          CODE_TASK_NOT_FOUND,
                          _load, _set, _spawn, _terrain, _topology, _nodes, _devices)

_PLANS: dict[str, dict[str, Any]] = {}
_SCENARIOS: dict[str, Any] = {}          # 干扰分析场景，供 adopt 使用
_PLOCK = threading.Lock()
PLAN_DIR = Path(os.environ.get("SR4_PLAN_DIR", Path(__file__).resolve().parents[2] / "data" / "runtime" / "plans"))


def _plan_path(pid: str) -> Path | None:
    if not pid.startswith("PL-") or len(pid) != 11 or not all(c in "0123456789ABCDEF" for c in pid[3:]):
        return None
    return PLAN_DIR / (pid + ".json")


def _get_plan_unlocked(pid: str) -> dict[str, Any] | None:
    p = _PLANS.get(pid)
    path = _plan_path(pid)
    if p is None and path is not None and path.exists():
        p = read_json(path)
        _PLANS[pid] = p
    return p


def _load_plan_files_unlocked() -> None:
    if PLAN_DIR.exists():
        for path in PLAN_DIR.glob("PL-*.json"):
            if _plan_path(path.stem) is not None:
                _get_plan_unlocked(path.stem)


def _new_plan_id() -> str:
    return "PL-%s" % uuid.uuid4().hex[:8].upper()


def _save_plan(kind: str, summary: dict[str, Any], detail: dict[str, Any]) -> str:
    pid = _new_plan_id()
    plan = dict(solution_id=pid, kind=kind, created_at=time.time(),
                confirmed=False, summary=summary, detail=detail)
    with _PLOCK:
        write_json(_plan_path(pid), plan)
        _PLANS[pid] = plan
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

_JAMMER_NUMERIC_DEFAULTS = {
    "elevation_m": 0.0,
    "antenna_height_m": 10.0,
    "bandwidth_khz": 25.0,
    "antenna_gain_dbi": 0.0,
    "azimuth_deg": 0.0,
    "duty_cycle": 1.0,
}


def _interference_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Resolve built-in IDs or validate a complete front-end supplied source list.

    ``interference_sources`` is an override, including an empty list. This makes
    map editing deterministic: the front end submits exactly what is currently
    drawn instead of depending on server-side preset state.
    """
    if "interference_sources" not in payload:
        rows = _load("interference_source.csv")
        ids = set(payload.get("interference_ids") or [])
        if ids:
            rows = [dict(r, active="true" if r["interference_id"] in ids else "false")
                    for r in rows]
        return rows

    raw = payload.get("interference_sources")
    if not isinstance(raw, list):
        raise ValueError("interference_sources 必须是数组")
    rows, seen = [], set()
    for pos, source in enumerate(raw, start=1):
        if not isinstance(source, dict):
            raise ValueError("第 %d 个干扰源必须是对象" % pos)
        row = dict(source)
        jid = str(row.get("interference_id") or "IF-USER-%04d" % pos).strip()
        if not jid or jid in seen:
            raise ValueError("干扰源编号为空或重复：%s" % jid)
        seen.add(jid)
        row["interference_id"] = jid
        row["name"] = str(row.get("name") or jid)
        for key in ("lon", "lat", "center_freq_khz", "tx_power_dbm"):
            try:
                value = float(row[key])
            except (KeyError, TypeError, ValueError):
                raise ValueError("干扰源 %s 缺少有效字段 %s" % (jid, key)) from None
            if not math.isfinite(value):
                raise ValueError("干扰源 %s 的 %s 必须是有限数值" % (jid, key))
            row[key] = value
        if not (-180 <= row["lon"] <= 180 and -90 <= row["lat"] <= 90):
            raise ValueError("干扰源 %s 经纬度越界" % jid)
        if row["center_freq_khz"] <= 0:
            raise ValueError("干扰源 %s 中心频率必须大于 0" % jid)
        for key, default in _JAMMER_NUMERIC_DEFAULTS.items():
            try:
                value = float(row.get(key, default))
            except (TypeError, ValueError):
                raise ValueError("干扰源 %s 的 %s 必须是数值" % (jid, key)) from None
            if not math.isfinite(value):
                raise ValueError("干扰源 %s 的 %s 必须是有限数值" % (jid, key))
            row[key] = value
        if row["bandwidth_khz"] <= 0 or row["antenna_height_m"] <= 0:
            raise ValueError("干扰源 %s 的带宽和天线高度必须大于 0" % jid)
        if not 0 < row["duty_cycle"] <= 1:
            raise ValueError("干扰源 %s 的占空比必须在 (0, 1]" % jid)
        row["interference_type"] = str(row.get("interference_type") or "NOISE").upper()
        row["pattern_type"] = str(row.get("pattern_type") or "OMNI").upper()
        if row["pattern_type"] not in ("OMNI", "DIRECTIONAL"):
            raise ValueError("干扰源 %s 的 pattern_type 只能是 OMNI/DIRECTIONAL" % jid)
        row["active"] = "true" if str(row.get("active", "true")).lower() == "true" else "false"
        rows.append(row)
    return rows

def _do_interference(payload, tick):
    import interference as IF
    st = _w3_state()
    tick(0.35, "构造干扰场景")
    jam = _interference_rows(payload)
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
        _SCENARIOS[sid] = dict(
            scenario=sc,
            countermeasures=out.get("countermeasures", []),
            routes=json.loads(json.dumps(st["routes"]["routes"])),
        )
    out["analysis_id"] = sid
    return out


def submit_interference(payload: dict[str, Any]) -> dict[str, Any]:
    return _spawn("INTERFERENCE", payload or {}, _do_interference)


def _apply_route_changes(routes: list[dict[str, Any]], detail: dict[str, Any]) -> dict[str, Any]:
    """Apply a ROUTE_REBUILD result to the current analysis-session route set."""
    by_id = {row["demand_id"]: dict(row) for row in routes}
    order = [row["demand_id"] for row in routes]
    for row in detail.get("rerouted", []):
        did = row.get("demand_id")
        if not did:
            continue
        if did not in by_id:
            order.append(did)
        by_id[did] = dict(row)
    for did in detail.get("still_unreachable", []):
        old = by_id.get(did, {})
        if did not in by_id:
            order.append(did)
        by_id[did] = dict(demand_id=did, strategy=old.get("strategy", "MAX_RELIABILITY"),
                          reachable=False, primary=None, backup=None, backup_type="NONE",
                          single_point_risks=[])
    current = [by_id[did] for did in order]
    reachable = [row for row in current if row.get("reachable")]
    return dict(
        routes=current,
        summary=dict(
            total=len(current),
            reachable=len(reachable),
            unreachable=len(current) - len(reachable),
            with_backup=sum(bool(row.get("backup")) for row in reachable),
            node_disjoint=sum(row.get("backup_type") == "NODE_DISJOINT" for row in reachable),
        ),
    )


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
    if cm.get("type") == "ROUTE_REBUILD":
        route_state = _apply_route_changes(rec.get("routes", []), cm.get("detail") or {})
        with _PLOCK:
            rec["routes"] = route_state["routes"]
        res["route_state"] = route_state
    res["elapsed_s"] = round(time.time() - t0, 3)
    return {"code": CODE_OK, "message": "success", "data": res}


# ─────────────────────────── SR-4 全流程 ───────────────────────────

def _do_sr4(payload, tick):
    import sr4_flow
    tick(0.1, "全流程执行中")
    if payload.get("parent_snapshot") is not None:
        # 人工调整沿用父方案节点、设备和链路，仅重算下游规划结果。
        o = sr4_flow.run_from_parent(
            parent_snapshot=payload["parent_snapshot"],
            adjustment=payload["adjustment"],
            device_refs=payload["manual_device_refs"],
            task_id=payload.get("task_id"),
            demand_rows=payload.get("demand_rows") or [],
            preset=payload.get("preset", "TERRAIN"),
            strategy=payload.get("strategy", "MAX_RELIABILITY"),
            constraints=payload.get("hard_constraints"),
            interference_rows=payload.get("interference_rows"), progress=tick,
            resource_rows=payload.get("resource_rows"),
        )
    else:
        o = sr4_flow.run(task_id=payload.get("task_id"),
                         preset=payload.get("preset", "TERRAIN"),
                         strategy=payload.get("strategy", "MAX_RELIABILITY"),
                         constraints=payload.get("hard_constraints"), verbose=False,
                         survivability_scope=payload.get("survivability_scope", "NETWORK"),
                         interference_rows=payload.get("interference_rows"),
                         demand_rows=payload.get("demand_rows"), progress=tick,
                         resource_rows=payload.get("resource_rows"))
    # 完整但未达标的候选仍允许作为参考查看；只有没有候选结果才进入失败终态。
    if not o["optimization"].get("best"):
        from .planning_w3 import PlanningSearchFailed
        optimization = o["optimization"]
        exhausted = (optimization.get("actual_search") or {}).get("budget_exhausted", False)
        labels = {"mandatory_e2e_connectivity": "必要通联连通率", "survivability": "抗毁性",
            "max_relay_hops": "最大中继跳数", "plan_check": "方案校验",
            "device_binding": "物理设备绑定", "deployment_input": "部署输入约束"}
        raise PlanningSearchFailed(dict(code=CODE_NO_SOLUTION,
            kind="BUDGET_EXHAUSTED" if exhausted else "SEARCH_NOT_FOUND",
            proven_infeasible=False,
            message="计算预算内未找到可行方案，尚未证明无解",
            reasons=[dict(code=str(key), message="候选方案未满足" + labels.get(str(key), "硬约束"))
                     for key in (optimization.get("infeasible") or {}).get("conflicting_constraints", [])],
            gap=[dict(objectId=payload.get("task_id") or "task", field="constraints",
                      message="候选方案未满足" + labels.get(str(key), "硬约束"))
                 for key in (optimization.get("infeasible") or {}).get("conflicting_constraints", [])],
            suggestions=(optimization.get("infeasible") or {}).get("suggestions", [])))
    b = o["optimization"]["best"]
    summary = dict(task_id=o["task_id"], total_s=round(o["total_s"], 2),
                   within_limit=o["within_limit"], objectives=b["objectives"],
                   feasible=o["optimization"]["feasible"],
                   frequency_conflicts=len(o["frequency"]["conflicts"]),
                   check_passed=o["check"]["passed"],
                   affected_links=o["interference"]["analysis"]["summary"]["affected_links"],
                   snapshot_id=payload.get("snapshot_id"))
    if payload.get("resource_revision") is not None:
        summary["resource_revision"] = payload["resource_revision"]
    detail = dict(steps=[dict(stage=n, seconds=round(t, 3)) for n, t in o["steps"]],
                  optimization=o["optimization"], routes=o["routes"],
                  frequency=o["frequency"], params=o["params"], check=o["check"],
                  interference=o["interference"], links=o["links"], nodes=o["nodes"],
                  devices=o.get("devices", []))
    tick(0.99, "正在保存方案")
    pid = _save_plan("SR4_FLOW", summary, detail)
    return dict(solution_id=pid, summary=summary,
                steps=detail["steps"], optimization=o["optimization"],
                check=o["check"]["summary"])


def submit_sr4(payload: dict[str, Any], *, job_id: str | None = None,
               on_update=None) -> dict[str, Any]:
    import radio_params as RP
    import routing
    from sr4_flow import TIME_LIMIT_S
    payload = payload or {}
    scope = payload.get("survivability_scope", "NETWORK")
    if scope not in ("NETWORK", "TASK"):
        return {"code": CODE_BAD_ENUM,
                "message": "survivability_scope 只能取 NETWORK / TASK，收到 %r" % scope,
                "data": None}
    preset = payload.get("preset", "TERRAIN")
    if not isinstance(preset, str) or preset not in RP.PRESETS:
        return {"code": CODE_BAD_ENUM, "message": "preset 只能是 %s" % "/".join(RP.PRESETS),
                "data": None}
    if payload.get("strategy", "MAX_RELIABILITY") not in routing.STRATEGIES:
        return {"code": CODE_BAD_ENUM, "message": "strategy 只能是 %s" % "/".join(routing.STRATEGIES),
                "data": None}
    return _spawn("SR4_FLOW", payload, _do_sr4,
                  task_id=job_id, on_update=on_update, isolated_budget_s=TIME_LIMIT_S)


# ─────────────────────────── 方案管理（接口文档 2.8）───────────────────────────

def list_plans(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    with _PLOCK:
        _load_plan_files_unlocked()
        items = [dict(solution_id=p["solution_id"], kind=p["kind"],
                      created_at=p["created_at"], confirmed=p["confirmed"],
                      summary=p["summary"]) for p in _PLANS.values()]
    items.sort(key=lambda x: -x["created_at"])
    return {"code": CODE_OK, "message": "success", "data": {"total": len(items), "items": items}}


def get_plan(pid: str) -> dict[str, Any]:
    with _PLOCK:
        p = _get_plan_unlocked(pid)
    if p is None:
        return {"code": CODE_TASK_NOT_FOUND, "message": "方案不存在", "data": None}
    return {"code": CODE_OK, "message": "success", "data": p}


def compare_plans(payload: dict[str, Any]) -> dict[str, Any]:
    """多方案横向对比（SR-4.2.4 扩展 3）。只比对象里都有的数值指标。"""
    ids = payload.get("solution_ids") or []
    with _PLOCK:
        ps = [_get_plan_unlocked(i) for i in ids]
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
        p = _get_plan_unlocked(pid)
        if p is None:
            return {"code": CODE_TASK_NOT_FOUND, "message": "方案不存在", "data": None}
        eligibility = {"SR4_FLOW": "check_passed", "NETWORK_OPTIMIZE": "feasible"}
        required = eligibility.get(p["kind"])
        if required is None or p["summary"].get(required) is not True:
            return {"code": CODE_NO_SOLUTION, "message": "方案未通过校验，不可确认",
                    "data": {"solution_id": pid, "kind": p["kind"],
                             "required_check": required, "confirmed": False}}
        if p["confirmed"]:
            return {"code": CODE_OK, "message": "success",
                    "data": {"solution_id": pid, "confirmed": True}}
        p = dict(p, confirmed=True, confirmed_at=time.time())
        write_json(_plan_path(pid), p)
        _PLANS[pid] = p
    return {"code": CODE_OK, "message": "success",
            "data": {"solution_id": pid, "confirmed": True}}


def export_plan(pid: str, fmt: str = "json") -> dict[str, Any]:
    """Export a saved plan as JSON, CSV or an XLSX workbook."""
    with _PLOCK:
        p = _get_plan_unlocked(pid)
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
    if fmt == "xlsx":
        from openpyxl import Workbook
        book = Workbook()
        summary = book.active
        summary.title = "Summary"
        summary.append(["field", "value"])
        for key, value in p["summary"].items():
            summary.append([key, json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value])
        details = book.create_sheet("Details")
        details.append(["path", "value"])

        def add_rows(path, value):
            if isinstance(value, dict):
                for key, item in value.items():
                    add_rows(f"{path}.{key}", item)
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    add_rows(f"{path}[{index}]", item)
            else:
                details.append([path, value if value is None or isinstance(value, (str, int, float, bool))
                                else str(value)])

        add_rows("detail", p["detail"])
        output = io.BytesIO()
        book.save(output)
        return {"code": CODE_OK, "message": "success",
                "data": {"format": "xlsx", "content": output.getvalue()}}
    return {"code": CODE_BAD_PARAM, "message": "仅支持 json / csv / xlsx", "data": None}
