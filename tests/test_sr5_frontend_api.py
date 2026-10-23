"""新版 SR5 使用真实故障引擎，场景与运行存储于隔离数据库。"""
import base64
import time
from copy import deepcopy

from test_integration_identity_api import workflow_api, headers, switch  # noqa: F401
from test_sr5_plan_api import _create_plan
from app import fault_frontend_service as sr5, kg_frontend_service as sr6, planning_w3
from app.planning_plan_models import PlanningPlan


def seed(factory):
    node, device, link = _create_plan(factory)
    with factory.begin() as session:
        plan = session.get(PlanningPlan, "plan-a")
        plan.result_snapshot = {"snapshot_id": "SNP-formal-a", "devices": [], "metrics": {"connectivityPercent": 100.0},
            "links": [{"id": link, "a": "ND-FORMAL-A", "b": "ND-FORMAL-B", "deviceA": device,
                       "deviceB": "DV-FORMAL-B", "state": "GOOD", "deviceClass": "HF", "frequencyKhz": 7000.0, "backup": False}]}
    return {"name": "构造故障", "description": "非实测", "planId": "plan-a", "faults": [{
        "objectType": "DEVICE", "objectId": device, "faultType": "HW_FAILURE", "symptomIds": [], "occurTime": None, "interferenceId": None}]}


def action(client, action, body, revision=None, key=None):
    revision = revision or client.get("/api/v1/fault/workbench").json()["data"]["revision"]
    return client.post("/api/v1/fault/workbench/actions/"+action, headers=headers(client), json={
        "baseRevision": revision, "requestId": key or f"test-{action}-{time.time_ns()}", **body})


def wait(client, rid, predicate):
    for _ in range(120):
        response = client.get(f"/api/v1/fault/workbench/runs/{rid}/progress")
        assert response.status_code == 200, response.text
        value = response.json()["data"]
        if predicate(value) or value["state"] == "FAILED":
            assert value["state"] != "FAILED", value
            return value
        time.sleep(.05)
    raise AssertionError("等待真实 SR5 阶段超时")


def test_scenario_version_two_step_history_and_exports(workflow_api):
    client, factory = workflow_api
    draft = seed(factory)
    switch(client, "integration-editor")
    context = client.get("/api/v1/fault/workbench").json()["data"]
    assert context["dataOrigin"] == "SAMPLE" and context["sources"]["plans"][0]["canCreate"]
    rev = context["revision"]
    saved = action(client, "save", {"scenarioId": None, "draft": draft}, rev, "save-a")
    assert saved.status_code == 200, saved.text
    scene_id, version_id = saved.json()["data"]["entityIds"]
    assert action(client, "save", {"scenarioId": None, "draft": draft}, rev, "save-a").json() == saved.json()
    assert action(client, "save", {"scenarioId": None, "draft": {**draft, "name": "不同内容"}}, rev, "save-a").status_code == 409
    assert action(client, "save", {"scenarioId": None, "draft": draft}, rev, "stale").status_code == 409
    detail = client.get("/api/v1/fault/workbench/version", params={"scenarioId": scene_id, "versionId": version_id}).json()["data"]
    assert detail["network"]["metrics"]["coveragePercent"] is None
    assert detail["network"]["inputSnapshot"]["devices"][0]["status"] is None
    started = action(client, "submit", {"scenarioVersionId": version_id})
    assert started.status_code == 200, started.text
    rid = started.json()["data"]["objectId"]
    diagnostic = wait(client, rid, lambda p: p["diagnosisReady"])
    assert diagnostic["state"] == "RUNNING" and not diagnostic["impactReady"]
    assert client.get(f"/api/v1/fault/workbench/runs/{rid}/report").status_code == 409
    # 多次 GET 不会偷偷提交第二阶段。
    for _ in range(2):
        assert client.get(f"/api/v1/fault/workbench/runs/{rid}/detail").json()["data"]["run"]["impactTaskId"] is None
    assert action(client, "impact", {"runId": rid}, key="impact-a").status_code == 200
    complete = wait(client, rid, lambda p: p["state"] == "SUCCESS")
    record = client.get(f"/api/v1/fault/workbench/runs/{rid}/report").json()["data"]
    assert record["network"]["id"] == "plan-a" and record["faults"] == draft["faults"]
    assert record["diagnoseTaskId"] != record["impactTaskId"]
    assert record["result"]["summary"] is not None
    for kind, fmt in (("report", "json"), ("report", "docx"), ("report", "pdf"), ("impact", "xlsx"), ("impact", "png")):
        exported = client.get(f"/api/v1/fault/workbench/export/{rid}", params={"kind": kind, "format": fmt})
        assert exported.status_code == 200 and len(exported.content) > 100, exported.text[:300] if exported.status_code != 200 else fmt
    history = client.get("/api/v1/fault/workbench/catalog/history", params={"pageNum": 1, "pageSize": 20}).json()["data"]
    assert history["items"][0]["id"] == rid
    # 清理进程内缓存后仍可从数据库读取同一冻结结果。
    planning_w3._TASKS.clear()
    assert client.get(f"/api/v1/fault/workbench/runs/{rid}/report").json()["data"] == record
    assert action(client, "cancel", {"runId": rid}).status_code == 409


def test_invalid_input_import_atomicity_archive_and_no_permissions(workflow_api):
    client, factory = workflow_api
    draft = seed(factory)
    switch(client, "integration-editor")
    invalid = deepcopy(draft)
    invalid["faults"][0]["objectId"] = "unknown-device"
    rev = client.get("/api/v1/fault/workbench").json()["data"]["revision"]
    assert action(client, "import", {"drafts": [draft, invalid]}).status_code == 422
    assert client.get("/api/v1/fault/workbench/catalog/scenarios").json()["data"]["total"] == 0
    assert client.get("/api/v1/fault/workbench").json()["data"]["revision"] == rev
    saved = action(client, "save", {"draft": draft}).json()["data"]
    sid, vid = saved["entityIds"]
    assert action(client, "archive", {"scenarioId": sid, "archived": True}).status_code == 200
    assert action(client, "submit", {"scenarioVersionId": vid}).status_code == 409
    assert client.get("/api/v1/fault/workbench/catalog/scenarios", params={"archived": "true"}).json()["data"]["total"] == 1
    assert action(client, "archive", {"scenarioId": sid, "archived": False}).status_code == 200
    template = client.get("/api/v1/fault/workbench/template", params={"planId": "plan-a", "format": "csv"})
    assert template.status_code == 200
    preview = client.post("/api/v1/fault/workbench/import-preview", headers=headers(client), json={"name": "faults.csv", "planId": "plan-a", "base64": base64.b64encode(template.content).decode()})
    assert preview.status_code == 200 and not preview.json()["data"]["issues"], preview.text
    switch(client, "integration-reviewer")
    assert action(client, "save", {"draft": draft}).status_code == 403


def test_feedback_requires_review_and_only_future_diagnosis_uses_new_knowledge(workflow_api):
    from test_sr6_frontend_api import mutation
    client, factory = workflow_api
    draft = seed(factory)
    switch(client, "integration-editor")
    ctx = client.get("/api/v1/fault/workbench").json()["data"]
    draft["faults"][0]["symptomIds"] = [ctx["symptoms"][0]["id"]]
    saved = action(client, "save", {"draft": draft}).json()["data"]
    vid = saved["entityIds"][1]
    rid = action(client, "submit", {"scenarioVersionId": vid}).json()["data"]["objectId"]
    wait(client, rid, lambda p: p["diagnosisReady"])
    action(client, "impact", {"runId": rid})
    wait(client, rid, lambda p: p["state"] == "SUCCESS")
    old_report = client.get(f"/api/v1/fault/workbench/runs/{rid}/report").json()["data"]
    before = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]["currentVersionId"]
    feedback = {"runId": rid, "feedback": {"result_index": 0, "confirmed_fault_type": "HW_FAILURE",
        "root_cause": "人工构造根因", "fault_component": "构造部件", "solution": "构造处置方案", "diagnosis_steps": ["检查构造现象"]}}
    req_revision = client.get("/api/v1/fault/workbench").json()["data"]["revision"]
    submitted = action(client, "feedback", feedback, req_revision, "feedback-one")
    assert submitted.status_code == 200, submitted.text
    assert action(client, "feedback", feedback, req_revision, "feedback-one").json() == submitted.json()
    cid = submitted.json()["data"]["entityIds"][1]
    change = client.get(f"/api/v1/kg/workbench/detail/change/{cid}").json()["data"]
    assert change["state"] == "DRAFT" and change["content"]["entities"]
    assert client.get("/api/v1/kg/workbench").json()["data"]["workspace"]["currentVersionId"] == before
    assert mutation(client, "submit", {"changeId": cid, "revision": change["revision"]}).status_code == 200
    switch(client, "integration-reviewer")
    assert mutation(client, "review", {"changeId": cid, "revision": change["revision"], "submission": 1, "approved": True}).status_code == 200
    published = mutation(client, "publish", {"changeId": cid, "revision": change["revision"]})
    assert published.status_code == 200, published.text
    assert published.json()["data"]["currentVersionId"] != before
    assert client.get(f"/api/v1/fault/workbench/runs/{rid}/report").json()["data"] == old_report
    switch(client, "integration-editor")
    next_id = action(client, "submit", {"scenarioVersionId": vid}).json()["data"]["objectId"]
    wait(client, next_id, lambda p: p["diagnosisReady"])
    stage = client.get(f"/api/v1/fault/workbench/runs/{next_id}/detail").json()["data"]
    assert stage["run"]["impactTaskId"] is None


def test_terrain_requires_matching_frozen_fingerprint(workflow_api, monkeypatch):
    client, factory = workflow_api
    seed(factory)
    switch(client, "integration-editor")
    path = "/api/v1/fault/workbench/sources?planId=plan-a"
    old = client.get(path).json()["data"]
    assert old["terrain"] is None and old["terrainNotice"]
    monkeypatch.setattr(sr5.planning_adjustment_service, "terrain_fingerprint", lambda: "verified-dem")
    with factory.begin() as session:
        plan = session.get(PlanningPlan, "plan-a")
        plan.raw_snapshot = {**plan.raw_snapshot, "terrain_fingerprint": "verified-dem"}
    matched = client.get(path).json()["data"]
    assert len(matched["terrain"]["sourceSha256"]) == 64 and len(matched["terrain"]["bounds"]) == 4
    assert matched["terrainNotice"] == ""
    monkeypatch.setattr(sr5.planning_adjustment_service, "terrain_fingerprint", lambda: "other-dem")
    changed = client.get(path).json()["data"]
    assert changed["terrain"] is None and changed["terrainNotice"]
    def broken_dem():
        raise ValueError("DEM 元数据损坏")
    monkeypatch.setattr(sr5.planning_adjustment_service, "terrain_fingerprint", broken_dem)
    response = client.get(path)
    assert response.status_code == 200 and response.json()["data"]["terrain"] is None
