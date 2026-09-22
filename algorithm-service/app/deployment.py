"""移动电台部署规划服务层（SR-4.2.1.2）。

需规 SR-4.2 g) 要求「规划与分析类计算采用**异步任务模式**，提交后返回任务标识
并支持计算进度查询与结果回调」，因此本模块用标准库 threading 起后台任务，
提交立即返回 task_id，另提供查询端点。**不引入第三方任务队列**
（国产化部署考虑，见 CLAUDE.md）。

算法核心全部在 scripts/planning/ 下，纯标准库；本层只做参数校验、
任务编排与结果序列化。
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


def _load(rel: str) -> list[dict[str, str]]:
    from datapaths import path as dpath
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _terrain():
    if "terrain" not in _CACHE:
        from terrain import default_terrain
        _CACHE["terrain"] = default_terrain(verbose=False)
    return _CACHE["terrain"]


def _set(tid: str, **kw) -> None:
    with _LOCK:
        _TASKS.setdefault(tid, {}).update(kw)


def _serialize(fm, sol, demands) -> dict[str, Any]:
    from metrics import evaluate
    ev = evaluate(fm, sol, demands=demands)
    deployments = []
    for idx, subtype in sol.added:
        st = fm.stations[idx]
        served = [fm.stations[c].sid for c, (p, _b) in sol.parent_of.items()
                  if p == idx]
        ports = {b: sol.ports.get((idx, b), 0) for b in ("HF", "VUHF")}
        deployments.append(dict(
            site_id=st.sid, lon=round(st.lon, 6), lat=round(st.lat, 6),
            echelon_role=subtype, serves_node_ids=served,
            port_usage={b: "%d/%d" % (ports[b], _cap(subtype, b))
                        for b in ("HF", "VUHF") if _cap(subtype, b)}))
    d = ev.get("demands", {})
    return dict(
        radio_count=sol.count,
        deployments=deployments,
        metrics=dict(
            connectivity=round(ev["connectivity"], 4),
            connected=ev["connected"], unconnected=ev["unconnected"],
            lower_bound=ev["lower_bound"],
            gap=None if ev["gap"] is None else round(ev["gap"], 4),
            proved_optimal=ev["proved_optimal"],
            link_margin_min_db=ev["margin_min"],
            link_margin_median_db=ev["margin_median"],
            ports_saturated="%d/%d" % (ev["ports"]["full"], ev["ports"]["total"]),
            backup_parent_nodes=ev["backup"],
            satisfied_demand_count=d.get("reachable", 0),
            total_demand_count=d.get("total", 0),
            hop_histogram=d.get("hop_hist", {}),
            lateral_shortcut_count=d.get("lateral", 0),
        ),
        # 覆盖率不在指标内：合作方 2026-09-18 答复「以全连通为唯一目标」
        unreachable_demand_ids=d.get("unreachable", [])[:50],
    )


def _cap(subtype: str, band: str) -> int:
    import echelon as E
    return E.capacity(subtype, band)


def _diagnose_payload(fm, sol) -> list[dict[str, Any]]:
    from deployment import diagnose
    return [dict(node_id=x["station"], echelon_role=x["subtype"],
                 reasons=x["reasons"]) for x in diagnose(fm, sol)]


def _run(task_id: str, payload: dict[str, Any]) -> None:
    t0 = time.time()
    try:
        from feasibility import stations_from_nodes
        from deployment import p1_solve, p2_solve, multi_plan, solve_assignment

        _set(task_id, status="RUNNING", stage="加载数据", progress=0.05)
        nodes = _load("node.csv")
        keep = payload.get("existing_node_ids")
        if keep:
            keep = set(keep)
            nodes = [n for n in nodes if n["node_id"] in keep]
        stations = stations_from_nodes(nodes, _load("device.csv"),
                                       _load("device_model.csv"),
                                       _load("antenna_model.csv"))
        sites = _load("candidate_site.csv")
        demands = _load("comm_demand.csv")
        want = payload.get("comm_demand_ids")
        if want:
            want = set(want)
            demands = [d for d in demands if d["demand_id"] in want]

        margin = (payload.get("coverage_target") or {}).get("min_link_margin_db")
        _set(task_id, stage="计算链路可行性矩阵", progress=0.2)

        fm, p1 = p1_solve(stations, sites, _terrain(),
                          margin_min=margin, refine=True)
        base_idx = list(range(len(stations)))
        cand_idx = list(range(len(stations), len(fm.stations)))
        _set(task_id, stage="P1 求解完成", progress=0.6)

        mode = (payload.get("mode") or "MIN_COUNT").upper()
        if mode == "FIXED_COUNT":
            p = int(payload.get("fixed_count") or p1.count)
            sol = p2_solve(fm, base_idx, cand_idx, p)
            sol.lower_bound = p1.lower_bound
            sol.lower_bound_parts = p1.lower_bound_parts
            plans = [dict(name="指定数量 p=%d" % p, sol=sol, note="SR-4.2.1.2 c")]
        else:
            k = int(payload.get("solution_count") or 3)
            plans = multi_plan(fm, base_idx, cand_idx, p1)[:max(1, k)]
        _set(task_id, stage="方案评估", progress=0.85)

        out = []
        for i, pl in enumerate(plans, 1):
            item = _serialize(fm, pl["sol"], demands)
            item.update(solution_id="PL-%04d" % i, name=pl["name"], note=pl["note"])
            out.append(item)

        first = plans[0]["sol"]
        result: dict[str, Any] = dict(solutions=out)
        if first.unconnected:
            result["code"] = 3001
            result["suggestions"] = _diagnose_payload(fm, first)
        _set(task_id, status="SUCCESS", progress=1.0, stage="完成",
             elapsed_s=round(time.time() - t0, 2), result=result)
    except Exception as exc:                       # noqa: BLE001
        _set(task_id, status="FAILED", progress=1.0,
             elapsed_s=round(time.time() - t0, 2),
             error="%s: %s" % (type(exc).__name__, exc))


def submit_deployment(payload: dict[str, Any]) -> dict[str, Any]:
    """提交部署规划任务，立即返回任务标识（SR-4.2 g 异步任务模式）。"""
    task_id = "TK-" + uuid.uuid4().hex[:12]
    _set(task_id, **{"task_id": task_id, "status": "PENDING", "progress": 0.0,
                     "stage": "排队中", "submitted_at": time.time()})
    th = threading.Thread(target=_run, args=(task_id, payload), daemon=True)
    th.start()
    return {"code": 0, "message": "success",
            "data": {"task_id": task_id, "status": "PENDING"}}


def query_deployment(task_id: str) -> dict[str, Any]:
    """查询任务进度与结果。"""
    with _LOCK:
        t = dict(_TASKS.get(task_id) or {})
    if not t:
        return {"code": 4004, "message": "任务不存在", "data": None}
    return {"code": 0, "message": "success", "data": t}


def run_deployment_sync(payload: dict[str, Any], timeout: float = 600.0):
    """同步执行，供测试与离线调用。"""
    r = submit_deployment(payload)
    tid = r["data"]["task_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        q = query_deployment(tid)["data"]
        if q.get("status") in ("SUCCESS", "FAILED"):
            return q
        time.sleep(0.2)
    return {"status": "TIMEOUT", "task_id": tid}
