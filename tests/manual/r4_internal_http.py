"""R4显式隔离准备与真实HTTP验证；不替换原库，不输出口令或会话。"""
from __future__ import annotations

import argparse
import base64
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "algorithm-service"))
sys.path.insert(0, str(ROOT / "scripts"))
ORIGIN = "http://127.0.0.22:5322"
API = "http://127.0.0.22:8122"


def write_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)


def prepare():
    """显式新建本轮库；只读提取R3冻结资源和输入，绝不连接原库写事务。"""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from app import resource_dataset_service as datasets
    from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
    from app.permission_registry import SERVER_PERMISSION_REGISTRY
    from app.system_management_service import SystemManagementService

    name = "r4-" + uuid.uuid4().hex
    runtime = ROOT / "data/runtime/r2" / name
    database = ROOT / "data/runtime/tmp" / name / "workspace.sqlite"
    runtime.mkdir(parents=True, exist_ok=False)
    database.parent.mkdir(parents=True, exist_ok=False)
    private = {"identity_request_key": base64.b64encode(secrets.token_bytes(32)).decode(),
               "accounts": {key: {"username": "r4_" + key,
                  "password": "R4!Aa1-" + secrets.token_urlsafe(24),
                  "initial_password": "R4!Bb2-" + secrets.token_urlsafe(24)}
                  for key in ("admin", "editor", "reviewer")}}
    write_new(runtime / "private.json", private)
    url = "sqlite:///" + database.as_posix()
    os.environ["DATABASE_URL"] = url
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    config = Config(str(ROOT / "algorithm-service/alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "algorithm-service/migrations"))
    command.upgrade(config, "head")
    manifest = json.loads((ROOT / "data/runtime/r3-final-verified-1792816282826/manifest.json").read_text(encoding="utf-8"))
    source = ROOT / "data/runtime/r2.sqlite"
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
        row = original.execute("SELECT snapshot, content_hash, source, data_origin FROM resource_dataset_versions WHERE revision=?",
                               (manifest["resource_revision"],)).fetchone()
        task = original.execute("SELECT input_snapshot FROM planning_task_revisions WHERE revision_id=?",
                                (manifest["revision"],)).fetchone()
    if row is None or task is None:
        raise RuntimeError("R3冻结来源不存在；未改用其他资源冒充同场景")
    snapshot = json.loads(row[0])
    datasets._validate_snapshot(snapshot)
    if datasets.content_hash(snapshot) != manifest["resource_content_hash"] or row[1] != manifest["resource_content_hash"]:
        raise RuntimeError("R3冻结资源摘要不一致")
    engine = create_engine(url)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        with factory.begin() as session:
            session.add(ResourceDatasetVersion(revision=manifest["resource_revision"], content_hash=row[1],
                source=row[2], data_origin=row[3], snapshot=snapshot, created_at=datetime.now(timezone.utc)))
            session.flush()
            session.add(ResourceDatasetCurrent(scope=datasets.SCOPE, revision=manifest["resource_revision"]))
        service = SystemManagementService(session_factory=factory, permission_registry=SERVER_PERMISSION_REGISTRY,
            request_key=base64.b64decode(private["identity_request_key"]))
        account = private["accounts"]["admin"]
        service.initialize(username=account["username"], password=account["password"], name="内部验收管理员", department="独立构造联调")
    finally:
        engine.dispose()
    write_new(runtime / "baseline-input.json", json.loads(task[0]))
    public = {"runtime_root": str(runtime), "database_url": url, "key_file": str(runtime / "private.json"),
              "frontend": ORIGIN, "api": API, "resource_revision": manifest["resource_revision"],
              "resource_content_hash": row[1], "source_method": "READ_ONLY_R3_FROZEN_RESOURCE_AND_TASK",
              "data_origin": "SYNTHETIC_INTEGRATION", "old_databases_modified": False}
    write_new(runtime / "workspace.json", public)
    print(json.dumps(public, ensure_ascii=False))


class Probe:
    def __init__(self, runtime, account, records):
        import httpx
        self.runtime, self.records = runtime, records
        self.client = httpx.Client(base_url=ORIGIN, trust_env=False, timeout=90, follow_redirects=False)
        self.account = account

    def call(self, method, path, body=None, *, expected=(200,), code=0, params=None):
        headers = {}
        if method not in ("GET", "HEAD"):
            csrf = self.client.get("/api/v1/auth/csrf").json()["data"]
            headers = {"Origin": ORIGIN, "X-CSRF-Token": csrf["csrf_token"], "X-Session-Id": csrf["session_id"] or ""}
        response = self.client.request(method, path, json=body, params=params, headers=headers)
        is_json = "application/json" in response.headers.get("content-type", "")
        value = response.json() if is_json else None
        self.records.append({"method": method, "path": path, "parameters": params,
            "request_body": self.redacted(body),
            "status": response.status_code, "code": (value or {}).get("code"),
            "expected_status": list(expected), "passed": response.status_code in expected and
               (code is None or is_json and value.get("code") == code)})
        if not self.records[-1]["passed"]:
            raise AssertionError({"request": path, "status": response.status_code,
                                  "message": (value or {}).get("message"), "data": (value or {}).get("data")})
        return (value["data"] if isinstance(value, dict) and "data" in value else value) if is_json else response

    @staticmethod
    def redacted(value):
        if isinstance(value, dict):
            return {key: "[REDACTED]" if any(word in key.casefold() for word in
                ("password", "secret", "csrf", "token")) else Probe.redacted(item)
                for key, item in value.items()}
        if isinstance(value, list):
            return [Probe.redacted(item) for item in value]
        return value

    def login(self, *, initial=False):
        return self.call("POST", "/api/v1/auth/login", {"username": self.account["username"],
            "password": self.account["initial_password" if initial else "password"]})

    def close(self):
        self.client.close()


def provision(runtime, private, records):
    from app.permission_registry import SERVER_PERMISSION_REGISTRY
    admin = Probe(runtime, private["accounts"]["admin"], records)
    admin.login()
    try:
        existing = admin.call("GET", "/api/v1/system/accounts", params={"pageNum": 1, "pageSize": 50})
        usernames = {row["username"] for row in existing["items"]}
        for key in ("editor", "reviewer"):
            account = private["accounts"][key]
            if account["username"] in usernames:
                continue
            permissions = ([row["code"] for row in SERVER_PERMISSION_REGISTRY if not row["code"].startswith("system.")
                and row["code"] not in ("knowledge.review", "knowledge.publish", "knowledge.rollback", "knowledge.reset")]
                if key == "editor" else ["situation.view", "resources.view", "planning.view", "diagnosis.view",
                                         "knowledge.view", "knowledge.review", "knowledge.publish", "knowledge.rollback"])
            options = admin.call("GET", "/api/v1/system/options")
            role = admin.call("POST", "/api/v1/system/roles", {"baseRevision": options["revision"],
                "requestId": "r4-role-" + key, "role": {"name": "内部验收" + ("编辑者" if key == "editor" else "审核者"),
                "description": "独立构造联调，非默认生产身份", "permissions": permissions}})
            options = admin.call("GET", "/api/v1/system/options")
            admin.call("POST", "/api/v1/system/accounts", {"baseRevision": options["revision"], "requestId": "r4-account-" + key,
                "account": {"username": account["username"], "name": "内部验收" + key, "department": "独立构造联调", "roleId": role["objectId"]},
                "initialPassword": account["initial_password"]})
            user = Probe(runtime, account, records)
            try:
                user.login(initial=True)
                user.call("POST", "/api/v1/auth/password", {"requestId": "r4-own-password-" + key,
                    "currentPassword": account["initial_password"], "newPassword": account["password"]})
            finally:
                user.close()
    finally:
        admin.close()


def smoke(runtime, private, records):
    provision(runtime, private, records)
    editor = Probe(runtime, private["accounts"]["editor"], records)
    try:
        editor.login()
        workers = editor.call("GET", "/health/workers")
        assert workers == {"interference": "running", "frozen_coverage": "running"}, workers
        context = editor.call("GET", "/api/v1/resource/context", params={"context": "planning"})
        assert context["revision"] == json.loads((runtime / "workspace.json").read_text(encoding="utf-8"))["resource_revision"]
        editor.call("GET", "/api/v1/task-inputs", params={"context": "planning", "page": 1, "page_size": 10})
        editor.call("GET", "/api/v1/task-inputs", params={"context": "planning", "page_size": 7}, expected=(422,), code=1001)
        terrain = editor.call("GET", "/maps/sr4-terrain.json", code=None)
        assert isinstance(terrain, dict)
        image = editor.call("GET", "/maps/sr4-terrain.png", code=None)
        assert image.content.startswith(b"\x89PNG\r\n\x1a\n")
        editor.call("GET", "/maps/does-not-exist.json", expected=(404,), code=None)
        editor.call("GET", "/api/v1/kg/workbench")
    finally:
        editor.close()


def run_plan(runtime, private, records):
    editor = Probe(runtime, private["accounts"]["editor"], records)
    try:
        editor.login()
        context = editor.call("GET", "/api/v1/resource/context", params={"context": "planning"})
        body = json.loads((runtime / "baseline-input.json").read_text(encoding="utf-8"))
        presets = editor.call("GET", "/api/v1/resource/param-presets", params={"context": "planning"})
        original_bbox = list(body["bbox"])
        # 新全网验收任务显式选当前完整规划区，旧冻结任务输入文件不改写。
        body["bbox"] = next(row["defaults"]["bbox"] for row in presets["items"] if row["id"] == body["presetId"])
        body["name"] = "R4全网实际频点页面联调"
        task_id, rid = "r4-network-" + uuid.uuid4().hex[:12], uuid.uuid4().hex
        saved = editor.call("PUT", "/api/v1/task-inputs/" + task_id, {"context": "planning", "task_id": task_id,
            "expected_revision": None, "resource_revision": context["revision"], "request_id": "r4-save-" + rid, "input": body})
        submit = {"context": "planning", "request_id": "r4-submit-" + rid, "task_id": task_id,
                  "expected_revision": saved["revision"], "input_version": saved["input_version"],
                  "condition_version": saved["condition_version"], "resource_revision": saved["resource_revision"], "parent_plan_id": None}
        job = editor.call("POST", "/api/v1/plan/sr4-flow", submit, expected=(202,))
        write_new(runtime / (task_id + "-submitted.json"), {"task": saved, "job": job,
            "scope": {"original_saved_bbox": original_bbox, "explicit_new_task_bbox": body["bbox"],
                      "old_task_modified": False}})
        deadline = time.monotonic() + 360
        while time.monotonic() < deadline:
            job = editor.call("GET", "/api/v1/plan/tasks/" + job["job_id"], params={"context": "planning", "task_id": task_id}, code=None)
            if job["status"] in ("SUCCESS", "FAILED", "CANCELLED"):
                break
            time.sleep(2)
        write_new(runtime / (task_id + "-terminal.json"), job)
        assert job["status"] == "SUCCESS", job.get("error")
        assert job["outcome"]["code"] == 0, job["outcome"]
        result = job["result"]
        plan = editor.call("POST", "/api/v1/plans", {"context": "planning", "request_id": "r4-plan-" + rid,
            "task_id": task_id, "expected_revision": saved["revision"], "job_id": job["job_id"],
            "name": body["name"], "note": "构造联调、非生产非实测；真实HTTP完整DEM重新计算"})
        confirmed = editor.call("POST", "/api/v1/plans/" + plan["plan_id"] + "/confirm", {"context": "planning",
            "request_id": "r4-confirm-" + rid, "task_id": task_id, "expected_revision": saved["revision"]})
        readback = editor.call("GET", "/api/v1/plans/" + plan["plan_id"], params={"context": "planning", "task_id": task_id})
        assert confirmed["state"] == readback["state"] == "CONFIRMED"
        write_new(runtime / (task_id + "-confirmed.json"), readback)
        return {"task_id": task_id, "plan_id": plan["plan_id"], "state": readback["state"],
                "metrics": result.get("metrics"), "outcome": job["outcome"]}
    finally:
        editor.close()


def knowledge(runtime, private, records):
    editor = Probe(runtime, private["accounts"]["editor"], records)
    try:
        editor.login()
        metadata = editor.call("GET", "/api/v1/kg/workbench")
        version = metadata["workspace"]["currentVersionId"]
        params = {"versionId": version, "categories": "设备知识", "type": "Manufacturer",
                  "search": "哈里斯公同", "pageNum": 1, "pageSize": 10}
        similar = editor.call("GET", "/api/v1/kg/workbench/browse/search", params=params)
        assert similar["code"] == 4001 and similar["items"] == [] and similar["similar"]
        assert similar == editor.call("GET", "/api/v1/kg/workbench/browse/search", params=params)
        assert all(set(row) == {"id", "name", "category", "type"} for row in similar["similar"])
        for row in similar["similar"]:
            entity = editor.call("GET", "/api/v1/kg/workbench/browse/entity", params={"versionId": version, "entityId": row["id"]})
            assert entity["entity"]["id"] == row["id"] and entity["versionId"] == version
        for search in ("紫色月球烘焙器", "DV-unknown-999999"):
            result = editor.call("GET", "/api/v1/kg/workbench/browse/search", params={**params, "search": search})
            assert result["code"] == 4001 and result["items"] == result["similar"] == []
        exact = editor.call("GET", "/api/v1/kg/workbench/browse/search", params={**params, "search": "哈里斯公司"})
        assert exact["code"] == 0 and exact["items"] and exact["similar"] == []
        editor.call("GET", "/api/v1/kg/workbench/browse/search", params={**params, "versionId": "invalid"}, expected=(422,), code=1001)
        return {"version_id": version, "recommendations": similar["similar"], "method": "DETERMINISTIC_RULES_NOT_ML"}
    finally:
        editor.close()


def matrix(runtime, private, records):
    """通过正式异步接口对比已冻结条件；无解与无效请求分别验证。"""
    editor = Probe(runtime, private["accounts"]["editor"], records)
    results = []
    try:
        editor.login()
        resource = editor.call("GET", "/api/v1/resource/context", params={"context": "planning"})
        catalog = editor.call("GET", "/api/v1/resource/param-presets", params={"context": "planning"})
        defaults = next(row["defaults"] for row in catalog["items"] if row["id"] == "balanced")
        conditions = dict(maxSlopeDeg=None, elevationRangeM=None, allowedLandcover=None, roadMaxDistanceM=None,
            minSiteSpacingM=None, losRequiredNodeIds=[], gridStepM=None, forcedInclude=[], forcedExcludePolygons=[])
        base = json.loads((runtime / "baseline-input.json").read_text(encoding="utf-8"))
        base["bbox"] = defaults["bbox"]
        for kind in ("forced-outside", "fixed-zero", "western-half"):
            value = deepcopy(base)
            value["name"] = "R4参数对比-" + kind
            if kind == "forced-outside":
                value["deploymentConstraints"] = {**conditions, "forcedInclude": [
                    {"lon": value["bbox"][2] + .01, "lat": (value["bbox"][1] + value["bbox"][3]) / 2}]}
            elif kind == "fixed-zero":
                value["deploymentSolve"] = {"mode": "FIXED_COUNT", "fixedCount": 0, "solutionCount": 1}
            else:
                value["bbox"][2] = (value["bbox"][0] + value["bbox"][2]) / 2
            rid = uuid.uuid4().hex
            task_id = "r4-" + kind + "-" + rid[:8]
            task = editor.call("PUT", "/api/v1/task-inputs/" + task_id, {"context": "planning", "task_id": task_id,
                "expected_revision": None, "resource_revision": resource["revision"], "request_id": "r4-task-" + rid, "input": value})
            request = {"context": "planning", "request_id": "r4-job-" + rid, "task_id": task_id,
                "expected_revision": task["revision"], "input_version": task["input_version"],
                "condition_version": task["condition_version"], "resource_revision": task["resource_revision"], "parent_plan_id": None}
            job = editor.call("POST", "/api/v1/plan/sr4-flow", request, expected=(202,))
            editor.call("POST", "/api/v1/plan/sr4-flow", {**request, "expected_revision": "TREV-stale"}, expected=(409,), code=None)
            deadline = time.monotonic() + 360
            while time.monotonic() < deadline:
                job = editor.call("GET", "/api/v1/plan/tasks/" + job["job_id"], params={"context": "planning", "task_id": task_id}, code=None)
                if job["status"] in ("SUCCESS", "FAILED", "CANCELLED"):
                    break
                time.sleep(2)
            write_new(runtime / (task_id + "-terminal.json"), job)
            item = {"case": kind, "task_id": task_id, "job_id": job["job_id"], "status": job["status"]}
            if kind == "forced-outside":
                assert job["status"] == "FAILED" and "强制" in str(job.get("error")), job
                item["error"] = job["error"]
            else:
                assert job["status"] == "SUCCESS", job.get("error")
                details = job["result"]["result_details"]
                item.update(outcome=job["outcome"], metrics=job["result"]["metrics"],
                    candidates=details["candidateScreening"]["deployableCount"], deployment=details["deploymentSummary"])
                if kind == "fixed-zero":
                    assert details["deploymentSummary"]["actualCount"] == 0
                    assert details["deploymentSummary"]["countSatisfied"] is True
                else:
                    assert 0 < details["candidateScreening"]["deployableCount"] < 1032
                    assert details["candidateScreening"]["rejectedStats"]["outside_bbox"] > 0
                saved = editor.call("POST", "/api/v1/plans", {"context": "planning", "request_id": "r4-variant-plan-" + rid,
                    "task_id": task_id, "expected_revision": task["revision"], "job_id": job["job_id"], "name": value["name"],
                    "note": "参数对比实跑，非实测；按实际约束结果保存"})
                item["plan_id"] = saved["plan_id"]
                if job["outcome"]["code"] != 0:
                    assert saved["state"] == "REFERENCE"
                    editor.call("POST", "/api/v1/plans/" + saved["plan_id"] + "/confirm", {"context": "planning",
                        "request_id": "r4-reject-confirm-" + rid, "task_id": task_id,
                        "expected_revision": task["revision"]}, expected=(409,), code=None)
            results.append(item)
        return results
    finally:
        editor.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "smoke", "plan", "knowledge", "matrix"))
    parser.add_argument("--runtime-root")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
        return
    if not args.runtime_root:
        parser.error("请求验证须显式指定本轮运行目录")
    from serve_internal_workspace import read_workspace
    runtime = Path(args.runtime_root)
    manifest = json.loads((runtime / "workspace.json").read_text(encoding="utf-8"))
    read_workspace(str(runtime), manifest["database_url"], manifest["key_file"])
    private = json.loads(Path(manifest["key_file"]).read_text(encoding="utf-8"))
    records, result, error, completed = [], None, None, False
    try:
        operation = {"smoke": smoke, "plan": run_plan, "knowledge": knowledge, "matrix": matrix}[args.action]
        result = operation(runtime, private, records)
        completed = True
    except BaseException as exc:
        error = {"type": type(exc).__name__, "detail": str(exc)}
        raise
    finally:
        output = runtime / (args.action + "-http-" + uuid.uuid4().hex[:8] + ".json")
        write_new(output, {"method": "REAL_HTTP_LOCAL_PASSWORD", "requests": records, "result": result, "error": error,
                           "completed": completed,
                           "all_requests_passed": completed and bool(records) and all(row["passed"] for row in records) and error is None})
        print(json.dumps({"evidence": str(output), "requests": len(records), "success": completed and error is None}, ensure_ascii=False))


if __name__ == "__main__":
    main()
