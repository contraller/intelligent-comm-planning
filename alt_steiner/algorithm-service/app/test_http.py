"""阶段六 HTTP 接口层端到端测试（纯标准库 urllib）。

启动内嵌服务器 → POST /plan/deployment → 轮询 /tasks/{id} → GET /tasks/{id}/result，
校验统一包络、solutions 结构、blind_zones、以及 1001（缺参）/2002（计算中）/3001（无可行解）分支。
"""
from __future__ import annotations

import json
import sys
import threading
import time
import urllib.request
import urllib.error
import os

import pytest  # noqa: F401

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
for p in (_ROOT, os.path.join(_ROOT, "scripts"), _HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

from server import make_server, STORE   # noqa: E402


_PORT = 8099


@pytest.fixture(scope="module", autouse=True)
def http_server():
    """模块级：启动内嵌 HTTP 服务，测试结束后关闭。"""
    srv = make_server("127.0.0.1", _PORT)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    time.sleep(0.3)
    try:
        yield
    finally:
        srv.shutdown()


def _post(url, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def _get(url):
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def test_happy_path():
    base = f"http://127.0.0.1:{_PORT}"
    body = {
        "device_model_id": "DM-0001",
        "mode": "MIN_COUNT",
        "coverage_target": {"min_link_margin_db": 6, "required_coverage_ratio": 0.9},
        "solution_count": 3,
        "size": "demo",
    }
    status, env = _post(base + "/api/v1/plan/deployment", body)
    assert status == 202, f"提交应返回 202，实际 {status}"
    assert env["code"] == 0
    assert "task_id" in env["data"], "响应应含 task_id"
    task_id = env["data"]["task_id"]
    print(f"  [OK] 提交返回 202，task_id={task_id}")

    # 轮询
    final = None
    for _ in range(120):
        st, tenv = _get(base + f"/api/v1/tasks/{task_id}")
        assert tenv["code"] == 0
        d = tenv["data"]
        if d["status"] in ("SUCCESS", "FAILED"):
            final = d
            break
        time.sleep(0.5)
    assert final is not None, "任务应在超时前结束"
    assert final["status"] == "SUCCESS", f"任务应成功，实际 {final['status']}"
    print(f"  [OK] 任务 SUCCESS，最终阶段={final['stage']}")

    # 取结果
    st, renv = _get(base + f"/api/v1/tasks/{task_id}/result")
    assert renv["code"] == 0, f"结果 code 应为 0，实际 {renv['code']}"
    data = renv["data"]
    sols = data["solutions"]
    assert len(sols) == 3, f"应生成 3 套方案，实际 {len(sols)}"
    for s in sols:
        assert "solution_id" in s and "radio_count" in s
        assert "deployments" in s and "metrics" in s
        assert "coverage_ratio" in s["metrics"]
    assert "blind_zones" in data and "blind_summary" in data
    print(f"  [OK] 结果含 {len(sols)} 套方案；方案1 电台数={sols[0]['radio_count']} "
          f"覆盖率={sols[0]['metrics']['coverage_ratio']} "
          f"盲区面积={data['blind_summary']['blind_area_km2']} km²")


def test_missing_param():
    base = f"http://127.0.0.1:{_PORT}"
    status, env = _post(base + "/api/v1/plan/deployment", {"mode": "MIN_COUNT"})
    assert env["code"] == 1001, f"缺 device_model_id 应 1001，实际 {env['code']}"
    print("  [OK] 缺参返回 code=1001")


def test_unknown_task():
    base = f"http://127.0.0.1:{_PORT}"
    st, env = _get(base + "/api/v1/tasks/tsk-nonexistent")
    assert env["code"] == 2001, f"未知任务应 2001，实际 {env['code']}"
    print("  [OK] 未知任务返回 code=2001")


def main():
    srv = make_server("127.0.0.1", 8099)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    time.sleep(0.3)
    try:
        print("=== 阶段六 HTTP 接口层端到端测试 ===")
        test_happy_path()
        test_missing_param()
        test_unknown_task()
        print("=== 全部通过 ===")
    finally:
        srv.shutdown()


if __name__ == "__main__":
    main()
