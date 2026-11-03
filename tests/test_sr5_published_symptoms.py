"""已发布知识现象的真实隔离HTTP闭环与版本竞态，不使用现用库。"""
from copy import deepcopy
from threading import Event

from test_integration_identity_api import workflow_api, switch, headers  # noqa: F401
from test_sr5_frontend_api import seed, action, wait
from test_sr6_frontend_api import mutation
from app import fault, fault_frontend_service as workbench
from app.fault_frontend_models import FaultRun
from app import fault_symptom_catalog as catalogs


SOURCE = "isolated symptom workflow test [CONSTRUCTED]"
PHENOMENON = "构造测试：接头松脱时接收信号减弱"


def knowledge_draft(client, label=PHENOMENON, suffix="A"):
    meta = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]
    rows = [("fault", "Fault", "FC-SYM-"+suffix), ("symptom", "Symptom", label),
            ("cause", "Cause", "构造根因：接头松动"+suffix), ("component", "Component", "构造部件：射频接头"+suffix),
            ("solution", "Solution", "构造方案：按规程恢复连接"+suffix),
            ("step", "DiagnosisStep", "01:按规程检查接头并复测"+suffix),
            ("type", "FaultType", "HW_FAILURE"), ("object", "ObjectType", "DEVICE"),
            ("band", "Parameter", "device_class=HF")]
    entities = [{"id": "new:"+key, "name": name, "type": kind,
                 "category": "设备知识" if kind in ("Component", "Parameter") else "故障运维知识",
                 "description": "", "source": SOURCE, "keywords": [], "attributes": [], "modelIds": []}
                for key, kind, name in rows]
    relations = [{"id": "new:relation:"+kind, "head": "new:fault", "type": kind, "tail": "new:"+tail,
                  "weight": None, "source": SOURCE}
                 for kind, tail in [("hasSymptom", "symptom"), ("causedBy", "cause"), ("locatedAt", "component"),
                                    ("resolvedBy", "solution"), ("diagnosedBy", "step"), ("instanceOf", "type"),
                                    ("occursOn", "object"), ("constrainedBy", "band")]]
    return {"baseVersionId": meta["currentVersionId"], "summary": "构造现象闭环"+suffix,
            "entities": entities, "relations": relations}


def save_knowledge(client, draft):
    response = mutation(client, "save", {"draft": draft, "changeId": None, "revision": None})
    assert response.status_code == 200, response.text
    return response.json()["data"]["change"]


def publish(client, change, before_publish=None):
    assert mutation(client, "submit", {"changeId": change["id"], "revision": change["revision"]}).status_code == 200
    switch(client, "integration-reviewer")
    assert mutation(client, "review", {"changeId": change["id"], "revision": change["revision"], "submission": 1, "approved": True}).status_code == 200
    if before_publish:
        before_publish()
    result = mutation(client, "publish", {"changeId": change["id"], "revision": change["revision"]})
    assert result.status_code == 200, result.text
    version = result.json()["data"]["currentVersionId"]
    switch(client, "integration-editor")
    return version


def choices(client):
    response = client.get("/api/v1/fault/workbench")
    assert response.status_code == 200, response.text
    return {row["id"]: row["label"] for row in response.json()["data"]["symptoms"]}


def selected_id(client, name=PHENOMENON):
    found = [key for key, label in choices(client).items() if label == name]
    assert len(found) == 1
    return found[0]


def save_scenario(client, draft, symptom_id):
    draft = deepcopy(draft)
    draft["faults"][0]["symptomIds"] = [symptom_id]
    saved = action(client, "save", {"draft": draft})
    assert saved.status_code == 200, saved.text
    return draft, saved.json()["data"]["entityIds"][1]


def test_only_published_symptoms_are_selectable_and_really_drive_kg_and_feedback(workflow_api):
    client, factory = workflow_api
    draft = seed(factory)
    switch(client, "integration-editor")
    original = dict(fault._engine().symptoms)
    assert "SY-0001" in choices(client)
    change = save_knowledge(client, knowledge_draft(client))
    assert PHENOMENON not in choices(client).values()
    version = publish(client, change, before_publish=lambda: _assert_absent(client))
    sid = selected_id(client)
    assert sid.startswith(version+":E-") and dict(fault._engine().symptoms) == original
    draft, vid = save_scenario(client, draft, sid)
    rid = action(client, "submit", {"scenarioVersionId": vid}).json()["data"]["objectId"]
    wait(client, rid, lambda value: value["diagnosisReady"])
    with factory() as session:
        run = session.get(FaultRun, rid)
        raw = run.diagnosis["result"]
        assert raw["knowledge_version"] == int(version[4:])
        assert run.snapshot["symptom_catalog"] == raw["symptom_catalog"]
        result = raw["results"][0]
        branch = next(item for item in result["branches"] if item["source"] == "KG")
        assert branch["root_cause"] == "构造根因：接头松动A"
        assert branch["fault_component"] == "构造部件：射频接头A"
        assert branch["steps"] == ["按规程检查接头并复测A"]
        assert result["fused"]["need_manual_review"] is True
        assert next(item for item in result["branches"] if item["source"] == "ML")["confidence"] is None
    assert action(client, "impact", {"runId": rid}).status_code == 200
    wait(client, rid, lambda value: value["state"] == "SUCCESS")
    report = client.get(f"/api/v1/fault/workbench/runs/{rid}/report")
    assert report.status_code == 200 and report.json()["data"]["faults"] == draft["faults"]
    response = action(client, "feedback", {"runId": rid, "feedback": {"root_cause": "构造反馈根因", "solution": "构造反馈方案", "diagnosis_steps": ["核对构造现象"]}})
    assert response.status_code == 200, response.text
    assert dict(fault._engine().symptoms) == original
    # 同一目录同时服务导入预检、正式场景接口与观测诊断，不能只修选项列表。
    import base64
    import csv
    import io
    from test_sr5_plan_api import _completed
    body = io.StringIO()
    writer = csv.writer(body)
    writer.writerow(workbench.HEADERS)
    writer.writerow(["new-symptom", "新增现象导入", "构造测试", "DEVICE", draft["faults"][0]["objectId"], "HW_FAILURE", sid, "", ""])
    preview = client.post("/api/v1/fault/workbench/import-preview", headers=headers(client), json={"name": "symptom.csv", "planId": "plan-a", "base64": base64.b64encode(body.getvalue().encode()).decode()})
    assert preview.status_code == 200 and not preview.json()["data"]["issues"], preview.text
    imported = action(client, "import", {"drafts": preview.json()["data"]["drafts"]})
    assert imported.status_code == 200, imported.text
    assert fault.validate_scenario({"context": "planning", "task_id": "task-a", "plan_id": "plan-a", "scenario_name": "正式新增现象", "faults": [{"object_type": "DEVICE", "object_id": draft["faults"][0]["objectId"], "fault_type": "HW_FAILURE", "symptom_ids": [sid]}]})["code"] == 0
    engine = fault._engine()
    observed_device = next(did for did, row in engine.devices.items()
                           if engine.models[row["model_id"]]["device_class"] == "HF")
    observation = fault.submit_observation_diagnosis({"scenario_name": "观测新增现象", "faults": [{"object_type": "DEVICE", "object_id": observed_device, "symptom_ids": [sid]}]})
    assert observation["code"] == 0, observation
    observed_result = _completed(client, observation["data"]["task_id"])["data"]
    assert observed_result["knowledge_version"] == int(version[4:])
    assert observed_result["results"][0]["fused"]["root_cause"] == "构造根因：接头松动A"


def _assert_absent(client):
    assert PHENOMENON not in choices(client).values()


def test_rename_keeps_entity_identity_but_expired_option_requires_explicit_reselection(workflow_api):
    client, factory = workflow_api
    draft = seed(factory)
    switch(client, "integration-editor")
    version = publish(client, save_knowledge(client, knowledge_draft(client)))
    old = selected_id(client)
    eid = old.split(":", 1)[1]
    entity = client.get("/api/v1/kg/workbench/browse/entity", params={"versionId": version, "entityId": eid}).json()["data"]["entity"]
    entity["name"] = "构造测试：重命名后的同一接头现象"
    current = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]["currentVersionId"]
    new_version = publish(client, save_knowledge(client, {"baseVersionId": current, "summary": "重命名现象身份测试", "entities": [entity], "relations": []}))
    new = selected_id(client, entity["name"])
    assert new == new_version+":"+eid and old not in choices(client)
    invalid = deepcopy(draft)
    invalid["faults"][0]["symptomIds"] = [old]
    response = client.post("/api/v1/fault/workbench/validate", json=invalid, headers=headers(client))
    assert response.status_code == 409 and "重新选择" in response.json()["message"]
    _, vid = save_scenario(client, draft, new)
    rid = action(client, "submit", {"scenarioVersionId": vid}).json()["data"]["objectId"]
    wait(client, rid, lambda value: value["diagnosisReady"])
    with factory() as session:
        result = session.get(FaultRun, rid).diagnosis["result"]
        assert result["results"][0]["fused"]["root_cause"] == "构造根因：接头松动A"


def test_frontend_acceptance_worker_publish_rollback_and_reused_eid_stay_frozen(workflow_api, monkeypatch):
    client, factory = workflow_api
    draft = seed(factory)
    switch(client, "integration-editor")
    version = publish(client, save_knowledge(client, knowledge_draft(client)))
    old = selected_id(client)
    _, vid = save_scenario(client, draft, old)
    original_launch = workbench._launch
    monkeypatch.setattr(workbench, "_launch", lambda *args: None)
    accepted = action(client, "submit", {"scenarioVersionId": vid})
    assert accepted.status_code == 200, accepted.text
    rid = accepted.json()["data"]["objectId"]
    switch(client, "integration-reviewer")
    rolled = mutation(client, "rollback", {"versionId": version, "reason": "构造竞态回滚"})
    assert rolled.status_code == 200, rolled.text
    switch(client, "integration-editor")
    assert old not in choices(client)
    original_spawn = fault._spawn
    ready, release = Event(), Event()
    def gate(kind, payload, work, **kwargs):
        def paused(data, tick):
            ready.set()
            assert release.wait(20), "测试未释放诊断worker"
            return work(data, tick)
        return original_spawn(kind, payload, paused, **kwargs)
    monkeypatch.setattr(fault, "_spawn", gate)
    original_launch("diagnosis", rid)
    assert ready.wait(10)
    try:
        fresh = publish(client, save_knowledge(client, knowledge_draft(client, "构造测试：另一个新增现象", "B")))
        new = selected_id(client, "构造测试：另一个新增现象")
        # 序号回退后的新实体可能复用同一个E编号，但版本化选项绝不相同。
        assert new.split(":", 1)[1] == old.split(":", 1)[1] and new != old
        invalid = deepcopy(draft); invalid["faults"][0]["symptomIds"] = [old]
        rejected = action(client, "save", {"draft": invalid})
        assert rejected.status_code == 409 and "重新选择" in rejected.json()["message"]
    finally:
        release.set()
    wait(client, rid, lambda value: value["diagnosisReady"])
    with factory() as session:
        raw = session.get(FaultRun, rid).diagnosis["result"]
        assert raw["knowledge_version"] == int(version[4:])
        assert raw["results"][0]["fused"]["root_cause"] == "构造根因：接头松动A"
    monkeypatch.setattr(fault, "_spawn", original_spawn)
    monkeypatch.setattr(workbench, "_launch", original_launch)
    assert action(client, "impact", {"runId": rid}).status_code == 200
    wait(client, rid, lambda value: value["state"] == "SUCCESS")
    report = client.get(f"/api/v1/fault/workbench/runs/{rid}/report")
    assert report.status_code == 200 and "版本："+version[4:] in " ".join(report.json()["data"]["result"]["notes"])
    response = action(client, "feedback", {"runId": rid, "feedback": {"root_cause": "构造反馈", "solution": "构造方案", "diagnosis_steps": []}})
    assert response.status_code == 422 and response.json()["code"] == 1203 and "版本已变化" in response.json()["message"]


def test_original_sy_alias_uses_original_entity_after_rename_not_recreated_same_name():
    from diagnosis.sr5 import FaultEngine
    engine = FaultEngine()
    baseline = engine.graph._snapshot()
    sid = next(iter(engine.symptoms)); old_label = engine.symptoms[sid]
    eid = engine.graph.get("Symptom", old_label)
    current = deepcopy(baseline)
    current["entities"][eid]["name"] = "重命名后的原现象"
    engine.graph._restore(current)
    duplicate = engine.graph.add_entity("Symptom", old_label)
    labels, bindings = catalogs.catalog_from_snapshots(engine.graph._snapshot(), baseline, engine.symptoms, 9)
    assert labels[sid] == "重命名后的原现象" and bindings[sid] == eid
    assert labels["KGV-9:"+duplicate] == old_label
    assert engine.symptoms[sid] == old_label
    assert engine.for_symptom_catalog(labels, bindings).symptoms is not engine.symptoms
