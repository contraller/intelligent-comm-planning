"""R5独立LOCAL环境的真实规划、覆盖和性能验证；不操作原运行库。"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).parent))
import r4_internal_http as shared

# 仅切换本手工验证进程中的请求目标，不改变R4服务或配置。
shared.ORIGIN = "http://127.0.0.23:5323"
shared.API = "http://127.0.0.23:8123"
PARAMETERS = {"radius_m": 60000, "cell_m": 5000, "az_step_deg": 10, "hour": 12}
DECLARED_CHOICES = {"DM-0005": 3, "DM-0007": 3, "DM-0013": 25, "DM-0014": 25}


def coverage(runtime, private, records, task_id, plan_id):
    editor = shared.Probe(runtime, private["accounts"]["editor"], records)
    try:
        editor.login()
        plan = editor.call("GET", "/api/v1/plans/" + plan_id,
                           params={"task_id": task_id, "context": "planning"})
        snapshot_id = plan["result"]["snapshot_id"]
        query = {"task_id": task_id, "snapshot_id": snapshot_id, "context": "planning"}
        prefix = "/api/v1/planning-coverages/" + plan_id
        options = editor.call("GET", prefix + "/bandwidth-options", params=query)
        choices = []
        for row in options["devices"]:
            if row["state"] != "SELECTION_REQUIRED":
                continue
            value = DECLARED_CHOICES.get(row["model_id"])
            if value not in row["options_khz"]:
                raise AssertionError("当前型号未有本轮显式测试选值声明：" + row["model_id"])
            choices.append({"device_id": row["device_id"], "rx_bandwidth_khz": value})
        rid = "r5-bw-" + uuid.uuid4().hex
        body = {"task_id": task_id, "snapshot_id": snapshot_id, "request_id": rid, "choices": choices}
        selection = editor.call("POST", prefix + "/bandwidth-selections", body, expected=(201,))
        assert editor.call("POST", prefix + "/bandwidth-selections", body) == selection
        assert editor.call("GET", prefix + "/bandwidth-selections/" + selection["selection_id"], params=query) == selection
        if choices:
            invalid = {**body, "request_id": "r5-invalid-" + uuid.uuid4().hex,
                       "choices": [{**choices[0], "rx_bandwidth_khz": -1}]}
            editor.call("POST", prefix + "/bandwidth-selections", invalid, expected=(422,), code=1001)
        request = {"task_id": task_id, "snapshot_id": snapshot_id, "request_id": "r5-compute-" + uuid.uuid4().hex,
                   "parameters": PARAMETERS, "bandwidth_selection_id": selection["selection_id"]}
        started = time.monotonic()
        job = editor.call("POST", prefix + "/compute", request, expected=(202,))
        original_id = job["job_id"]
        assert editor.call("POST", prefix + "/compute", request)["job_id"] == original_id
        deadline = started + 360
        while time.monotonic() < deadline:
            job = editor.call("GET", "/api/v1/planning-coverages/jobs/" + original_id,
                params={**query, "plan_id": plan_id})
            if job["state"] not in ("PENDING", "RUNNING"):
                break
            time.sleep(1)
        elapsed = time.monotonic() - started
        assert job["state"] == "SUCCESS", job
        cache_query = {**query, "parameters": json.dumps(PARAMETERS), "bandwidth_selection_id": selection["selection_id"]}
        hit = editor.call("GET", prefix + "/cache", params=cache_query)
        assert hit["state"] == "HIT" and hit["anchor"]["engine_version"] == "V01-4"
        result = hit["result"]
        summary = result["summary"]
        assert result["schema_version"] == 2
        assert summary["total"] == summary["eligible"] + summary["skipped"]
        assert summary["eligible"] == summary["complete"] + summary["unavailable"]
        assert summary["skipped"] == sum(row["status"] == "SKIPPED" for row in result["devices"])
        assert all(not row["computations"] for row in result["devices"] if row["status"] == "SKIPPED")
        assert hit["bandwidth_selection_hash"] == selection["selection_hash"]
        shared.write_new(runtime / ("r5-coverage-" + original_id + ".json"), hit)
        return {"task_id": task_id, "plan_id": plan_id, "job_id": original_id,
            "selection_id": selection["selection_id"], "selection_hash": selection["selection_hash"],
            "choices": len(choices), "declared_model_choices_khz": DECLARED_CHOICES,
            "result_status": result["status"], "summary": summary, "elapsed_s": round(elapsed, 3),
            "parameters": PARAMETERS, "metrics": plan["result"]["metrics"],
            "supplemented_devices": sum(row.get("bandwidth_provenance") is not None for row in result["devices"]),
            "cache_query": cache_query}
    finally:
        editor.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "smoke", "plan", "coverage"))
    parser.add_argument("--runtime-root")
    parser.add_argument("--task-id")
    parser.add_argument("--plan-id")
    args = parser.parse_args()
    if args.action == "prepare":
        shared.prepare()
        return
    if not args.runtime_root:
        parser.error("须显式指定本轮独立目录")
    from serve_internal_workspace import read_workspace
    runtime = Path(args.runtime_root)
    manifest = json.loads((runtime / "workspace.json").read_text(encoding="utf-8"))
    read_workspace(str(runtime), manifest["database_url"], manifest["key_file"])
    if manifest["frontend"] != shared.ORIGIN or manifest["api"] != shared.API:
        parser.error("不是本轮独立coverage运行环境")
    private = json.loads(Path(manifest["key_file"]).read_text(encoding="utf-8"))
    if args.action == "coverage" and not (args.task_id and args.plan_id):
        parser.error("覆盖须显式绑定任务和方案")
    records, result, error, completed = [], None, None, False
    try:
        if args.action == "coverage":
            result = coverage(runtime, private, records, args.task_id, args.plan_id)
        else:
            result = {"smoke": shared.smoke, "plan": shared.run_plan}[args.action](runtime, private, records)
        completed = True
    except BaseException as exc:
        error = {"type": type(exc).__name__, "detail": str(exc)}
        raise
    finally:
        output = runtime / ("r5-" + args.action + "-http-" + uuid.uuid4().hex[:8] + ".json")
        shared.write_new(output, {"method": "REAL_HTTP_LOCAL_PASSWORD", "requests": records,
            "result": result, "error": error, "completed": completed,
            "all_requests_passed": completed and bool(records) and all(row["passed"] for row in records)})
        print(json.dumps({"evidence": str(output), "requests": len(records), "success": completed}, ensure_ascii=False))


if __name__ == "__main__":
    main()
