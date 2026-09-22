"""阶段六 HTTP 接口层（SR-4.2.1.2 移动电台数量与位置规划）。

纯标准库实现（http.server），满足 CLAUDE.md「纯标准库、禁止第三方依赖」硬约束；
与算法核心 scripts/planning 解耦，仅通过 deployment_service 调用。

实现的接口（对齐 docs/03_接口文档.md v0.1）：
  POST /api/v1/plan/deployment      → 202 + {task_id, estimated_sec}
  GET  /api/v1/tasks/{task_id}      → 任务进度（status/progress/stage）
  GET  /api/v1/tasks/{task_id}/result → 规划结果（solutions / blind_zones）
  DELETE /api/v1/tasks/{task_id}    → 取消任务

统一响应包络：{code, message, data, request_id}
业务错误码：0 成功 / 1001 参数错误 / 2001 任务不存在 / 2002 计算中 /
           2003 计算失败 / 3001 无可行解（带 suggestions）。
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, Optional
from urllib.parse import urlparse

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
for p in (_ROOT, os.path.join(_ROOT, "scripts"), _HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from deployment_service import run_plan   # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone(
        timezone(offset=timedelta_hours(8))
    ).isoformat()


def timedelta_hours(h: int):
    from datetime import timedelta
    return timedelta(hours=h)


class TaskStore:
    """线程安全的异步任务登记表。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._tasks: Dict[str, dict] = {}

    def create(self, body: dict) -> str:
        task_id = "tsk-" + uuid.uuid4().hex[:12]
        with self._lock:
            self._tasks[task_id] = {
                "task_id": task_id,
                "task_type": "DEPLOYMENT_PLAN",
                "status": "PENDING",
                "progress": 0.0,
                "stage": "已提交，等待调度",
                "submit_time": _now_iso(),
                "estimated_remain_sec": None,
                "error_detail": None,
                "result": None,
                "body": body,
            }
        return task_id

    def get(self, task_id: str) -> Optional[dict]:
        with self._lock:
            return self._tasks.get(task_id)

    def update(self, task_id: str, **kw):
        with self._lock:
            t = self._tasks.get(task_id)
            if t:
                t.update(kw)

    def set_progress(self, task_id: str, progress: float, stage: str):
        with self._lock:
            t = self._tasks.get(task_id)
            if t:
                t["progress"] = progress
                t["stage"] = stage

    def delete(self, task_id: str):
        with self._lock:
            self._tasks.pop(task_id, None)


STORE = TaskStore()


def _worker(task_id: str):
    """后台线程：执行规划并回写进度/结果。"""
    task = STORE.get(task_id)
    if not task:
        return
    STORE.update(task_id, status="RUNNING")
    body = task["body"]
    try:
        def progress(p, msg):
            STORE.set_progress(task_id, p, msg)

        data = run_plan(body, progress=progress)
        if data.get("infeasible"):
            STORE.update(task_id, status="SUCCESS", progress=1.0,
                         stage="无可行解", result={
                             "infeasible": True,
                             "solutions": data["solutions"],
                             "blind_zones": data["blind_zones"],
                             "blind_summary": data["blind_summary"],
                             "suggestions": data["suggestions"],
                         })
        else:
            STORE.update(task_id, status="SUCCESS", progress=1.0, stage="完成",
                         result={
                             "solutions": data["solutions"],
                             "blind_zones": data["blind_zones"],
                             "blind_summary": data["blind_summary"],
                         })
    except Exception as e:  # noqa: BLE001
        STORE.update(task_id, status="FAILED", progress=1.0,
                     stage="计算失败", error_detail=str(e))


def _envelope(code: int, message: str, data, request_id: str) -> bytes:
    body = {"code": code, "message": message, "data": data, "request_id": request_id}
    return json.dumps(body, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: bytes, http_status: int = 200):
        self.send_response(http_status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _req_id(self):
        return "req-" + uuid.uuid4().hex[:12]

    def do_POST(self):
        parsed = urlparse(self.path)
        rid = self._req_id()
        if parsed.path == "/api/v1/plan/deployment":
            try:
                body = self._read_json()
            except Exception:
                self._send(200, _envelope(1001, "请求体不是合法 JSON", None, rid))
                return
            if not (body.get("device_model_id")):
                self._send(200, _envelope(1001, "缺少必填参数 device_model_id", None, rid))
                return
            task_id = STORE.create(body)
            threading.Thread(target=_worker, args=(task_id,), daemon=True).start()
            payload = _envelope(0, "success",
                                {"task_id": task_id, "estimated_sec": 60},
                                rid)
            self._send(200, payload, http_status=202)
            return
        self._send(200, _envelope(1001, f"未知路径 {parsed.path}", None, rid))

    def do_GET(self):
        parsed = urlparse(self.path)
        rid = self._req_id()
        parts = [p for p in parsed.path.split("/") if p]
        # /api/v1/tasks/{id} 或 /api/v1/tasks/{id}/result
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "v1" and parts[2] == "tasks":
            task_id = parts[3] if len(parts) > 3 else None
            if not task_id:
                self._send(200, _envelope(1001, "缺少 task_id", None, rid))
                return
            task = STORE.get(task_id)
            if not task:
                self._send(200, _envelope(2001, "任务不存在或已过期", None, rid))
                return
            if len(parts) >= 5 and parts[4] == "result":
                if task["status"] == "RUNNING" or task["status"] == "PENDING":
                    self._send(200, _envelope(2002, "任务仍在计算中", None, rid))
                    return
                if task["status"] == "FAILED":
                    self._send(200, _envelope(2003, "任务计算失败",
                                              {"error_detail": task["error_detail"]}, rid))
                    return
                result = task["result"] or {}
                if result.get("infeasible"):
                    self._send(200, _envelope(3001, "约束过严，无可行解",
                                              result, rid))
                    return
                self._send(200, _envelope(0, "success", result, rid))
                return
            # 进度查询
            self._send(200, _envelope(0, "success", {
                "task_id": task["task_id"],
                "task_type": task["task_type"],
                "status": task["status"],
                "progress": task["progress"],
                "stage": task["stage"],
                "submit_time": task["submit_time"],
                "estimated_remain_sec": task.get("estimated_remain_sec"),
                "error_detail": task["error_detail"],
            }, rid))
            return
        self._send(200, _envelope(1001, f"未知路径 {parsed.path}", None, rid))

    def do_DELETE(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        rid = self._req_id()
        if len(parts) >= 4 and parts[0] == "api" and parts[1] == "v1" and parts[2] == "tasks":
            task_id = parts[3]
            task = STORE.get(task_id)
            if not task:
                self._send(200, _envelope(2001, "任务不存在或已过期", None, rid))
                return
            STORE.delete(task_id)
            self._send(200, _envelope(0, "success", {"task_id": task_id, "cancelled": True}, rid))
            return
        self._send(200, _envelope(1001, f"未知路径 {parsed.path}", None, rid))

    def log_message(self, fmt, *args):
        sys.stderr.write("[http] " + (fmt % args) + "\n")


def make_server(host: str = "127.0.0.1", port: int = 8080) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="部署规划 HTTP 服务（阶段六）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    srv = make_server(args.host, args.port)
    print(f"部署规划服务已启动： http://{args.host}:{args.port}/api/v1/plan/deployment")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
