"""覆盖结果服务层（SR-1.1.2.6.2、SR-4.2.1 扩展流 1）。

SR-1.1.2.6.2 c) 原文：「覆盖数据读取**规划模块的计算结果缓存**，
不独立发起实时全网计算」——因此本层必须提供**可供前端只读的缓存**，
前端不得触发实时全网计算。

缓存策略：进程内按 (台站集合指纹, 频段, 参数) 缓存；
覆盖计算耗时约 0.26 s/站，全网 132 站约 34 s，因此走异步任务，
算完落缓存，前端按 key 读。重启即失效（当前为演示级实现，
持久化方案待与前端外包方确认落盘位置与失效策略）。
"""
from __future__ import annotations

import csv
import hashlib
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
_CACHE: dict[str, dict[str, Any]] = {}
_LOCK = threading.Lock()
_ENV: dict[str, Any] = {}


def _load(rel: str) -> list[dict[str, str]]:
    from datapaths import path as dpath
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def _env():
    if "terrain" not in _ENV:
        from terrain import default_terrain, BBOX
        from feasibility import stations_from_nodes
        _ENV["terrain"] = default_terrain(verbose=False)
        _ENV["bbox"] = BBOX
        _ENV["stations"] = stations_from_nodes(
            _load("node.csv"), _load("device.csv"),
            _load("device_model.csv"), _load("antenna_model.csv"))
    return _ENV


def _key(node_ids, band, params) -> str:
    raw = "|".join(sorted(node_ids)) + "|" + band + "|" + repr(sorted(params.items()))
    return "CV-" + hashlib.sha1(raw.encode()).hexdigest()[:16]


def _set(tid: str, **kw) -> None:
    with _LOCK:
        _TASKS.setdefault(tid, {}).update(kw)


def _run(tid: str, node_ids, band, params) -> None:
    t0 = time.time()
    try:
        import viewshed
        import echelon as E
        env = _env()
        terrain, bbox = env["terrain"], env["bbox"]
        sel = [s for s in env["stations"]
               if (not node_ids or s.sid in set(node_ids)) and s.has(band)]
        radius = float(params.get("radius_m") or 60000.0)
        cell = float(params.get("cell_m") or 250.0)
        mmin = float(params.get("margin_min_db") or 6.0)

        per_station, union = [], {}
        lat_c = (bbox[1] + bbox[3]) / 2
        import math
        mlon = 111320.0 * max(0.2, math.cos(math.radians(lat_c)))
        # 规划区栅格尺寸。台站在边缘时覆盖会溢出规划区，
        # 溢出的格子不能计入覆盖率——否则分子含区外面积、分母只有区内，
        # 会算出「覆盖 92% 却有 4672 km² 盲区」这种自相矛盾的结果。
        nx = int((bbox[2] - bbox[0]) * mlon / 1000.0)
        ny = int((bbox[3] - bbox[1]) * 111320.0 / 1000.0)
        for k, st in enumerate(sel, 1):
            if band == E.VUHF:
                r = viewshed.vuhf_coverage(terrain, st, radius_m=radius,
                                           cell_m=cell, margin_min=mmin)
                item = dict(node_id=st.sid, lon=round(st.lon, 6),
                            lat=round(st.lat, 6), shape="IRREGULAR",
                            area_km2=round(r.area_km2(), 1),
                            note="地形遮蔽后的不规则边界，未用扇形/圆形近似")
                # 并到全局 1 km 栅格
                for (gx, gy) in r.cells:
                    lon = st.lon + gx * cell / mlon
                    lat = st.lat + gy * cell / 111320.0
                    ux = int((lon - bbox[0]) * mlon / 1000.0)
                    uy = int((lat - bbox[1]) * 111320.0 / 1000.0)
                    if 0 <= ux < nx and 0 <= uy < ny:   # 只计规划区内
                        union[(ux, uy)] = True
            else:
                f = float(params.get("freq_khz") or 5000.0)
                r = viewshed.hf_coverage_rings(terrain, st, freq_khz=f)
                item = dict(node_id=st.sid, lon=round(st.lon, 6),
                            lat=round(st.lat, 6), shape="RINGS",
                            rings=[dict(inner_km=round(a / 1000, 1),
                                        outer_km=round(b / 1000, 1), note=n)
                                   for a, b, n in r.rings if b > a],
                            note="短波按跳距与静区呈现环带形态")
            per_station.append(item)
            _set(tid, progress=round(0.1 + 0.8 * k / max(1, len(sel)), 2),
                 stage="覆盖计算 %d/%d" % (k, len(sel)))

        result: dict[str, Any] = dict(band=band, station_count=len(sel),
                                      stations=per_station)
        if band == E.VUHF:
            _set(tid, stage="盲区识别", progress=0.95)
            zones = viewshed.blind_zones(set(union), bbox, cell_m=1000.0)
            result["union_area_km2"] = len(union)
            result["planning_area_km2"] = nx * ny
            result["coverage_ratio_note"] = (
                "仅作态势呈现与盲区标注之用，**不是优化目标**"
                "（合作方 2026-09-18：以全连通为唯一目标）")
            result["blind_zones"] = [
                dict(area_km2=round(a, 1),
                     center=dict(lon=round(c[0], 5), lat=round(c[1], 5)),
                     suggestion="该区域无台站可覆盖，若有任务站点落入，"
                                "需在附近增设 Ⅲ 机动站（唯一带超短波的可部署类型）")
                for a, _blob, c in zones[:10]]
        cache_key = _key(node_ids or [], band, params)
        with _LOCK:
            _CACHE[cache_key] = dict(result=result, at=time.time())
        _set(tid, status="SUCCESS", progress=1.0, stage="完成",
             elapsed_s=round(time.time() - t0, 2),
             cache_key=cache_key, result=result)
    except Exception as exc:                        # noqa: BLE001
        _set(tid, status="FAILED", progress=1.0,
             elapsed_s=round(time.time() - t0, 2),
             error="%s: %s" % (type(exc).__name__, exc))


def submit_coverage(payload: dict[str, Any]) -> dict[str, Any]:
    """提交覆盖计算任务。命中缓存则立即返回结果，不重算。"""
    node_ids = payload.get("node_ids") or []
    band = (payload.get("band") or "VUHF").upper()
    params = {k: payload[k] for k in
              ("radius_m", "cell_m", "margin_min_db", "freq_khz") if k in payload}
    ck = _key(node_ids, band, params)
    with _LOCK:
        hit = _CACHE.get(ck)
    if hit:
        return {"code": 0, "message": "success",
                "data": {"status": "SUCCESS", "from_cache": True,
                         "cache_key": ck, "result": hit["result"]}}
    tid = "CT-" + uuid.uuid4().hex[:12]
    _set(tid, **{"task_id": tid, "status": "PENDING", "progress": 0.0,
                 "stage": "排队中"})
    threading.Thread(target=_run, args=(tid, node_ids, band, params),
                     daemon=True).start()
    return {"code": 0, "message": "success",
            "data": {"task_id": tid, "status": "PENDING", "cache_key": ck}}


def query_coverage(task_id: str) -> dict[str, Any]:
    with _LOCK:
        t = dict(_TASKS.get(task_id) or {})
    if not t:
        return {"code": 4004, "message": "任务不存在", "data": None}
    return {"code": 0, "message": "success", "data": t}


def read_cache(cache_key: str) -> dict[str, Any]:
    """前端只读入口（SR-1.1.2.6.2 c：读缓存，不发起实时全网计算）。"""
    with _LOCK:
        hit = _CACHE.get(cache_key)
    if not hit:
        return {"code": 4004, "message": "缓存未命中，请先提交覆盖计算任务",
                "data": None}
    return {"code": 0, "message": "success",
            "data": {"cache_key": cache_key, "computed_at": hit["at"],
                     "result": hit["result"]}}


def run_coverage_sync(payload, timeout=900.0):
    r = submit_coverage(payload)["data"]
    if r.get("status") == "SUCCESS":
        return r
    tid = r["task_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        q = query_coverage(tid)["data"]
        if q.get("status") in ("SUCCESS", "FAILED"):
            return q
        time.sleep(0.3)
    return {"status": "TIMEOUT"}
