"""新版图谱的分层查询、独立审核发布和回滚。"""
import time
from copy import deepcopy

from test_integration_identity_api import workflow_api, headers, switch  # noqa: F401


def mutation(client, action, body, *, request_id=None, actor=None, revision=None):
    who = client.get("/api/v1/auth/session").json()["data"]
    meta = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]
    return client.post("/api/v1/kg/workbench/actions/"+action, headers=headers(client), json={
        "actorId": actor or who["account_id"], "baseRevision": revision or meta["revision"],
        "requestId": request_id or f"kg-{action}-{time.time_ns()}", **body})


def test_browse_paging_and_workflow_publish_rollback(workflow_api):
    client, _ = workflow_api
    switch(client, "integration-editor")
    meta = client.get("/api/v1/kg/workbench").json()["data"]
    initial = meta["workspace"]["currentVersionId"]
    query = {"versionId": initial, "categories": "设备知识,网络态势知识,故障运维知识", "pageNum": 1, "pageSize": 20}
    found = client.get("/api/v1/kg/workbench/browse/search", params=query)
    assert found.status_code == 200, found.text
    assert found.json()["data"]["total"] > 100
    models = client.get("/api/v1/kg/workbench/browse/search", params={**query, "type": "DeviceModel"}).json()["data"]
    eid = models["items"][0]["id"]
    detail = client.get("/api/v1/kg/workbench/browse/entity", params={"versionId": initial, "entityId": eid}).json()["data"]
    entity = deepcopy(detail["entity"])
    entity.update(description="联调说明 " + str(time.time_ns()), source="手工构造联调，非实测", principleFlow={"steps": [{"title": "测试步骤", "description": "结构化说明文本"}, {"title": "输出", "description": ""}]})
    draft = {"baseVersionId": initial, "summary": "验证页面修改持久化", "entities": [entity], "relations": []}
    payload = {"draft": draft, "changeId": None, "revision": None}
    old_revision = meta["workspace"]["revision"]
    save = mutation(client, "save", payload, request_id="kg-save", revision=old_revision)
    assert save.status_code == 200, save.text
    receipt = save.json()["data"]
    cid = receipt["entityId"]
    assert mutation(client, "save", payload, request_id="kg-save", revision=old_revision).json() == save.json()
    assert mutation(client, "save", payload, request_id="different", revision=old_revision).status_code == 409
    change = receipt["change"]
    assert change["content"]["entities"][0]["principleFlow"] == entity["principleFlow"]
    submitted = mutation(client, "submit", {"changeId": cid, "revision": change["revision"]})
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["data"]["change"]["state"] == "PENDING"
    assert mutation(client, "review", {"changeId": cid, "revision": change["revision"], "submission": 1, "approved": True}).status_code == 403
    assert mutation(client, "publish", {"changeId": cid, "revision": change["revision"]}).status_code == 403
    switch(client, "integration-reviewer")
    assert mutation(client, "review", {"changeId": cid, "revision": change["revision"], "submission": 1, "approved": True}, actor="integration-editor").status_code == 403
    approved = mutation(client, "review", {"changeId": cid, "revision": change["revision"], "submission": 1, "approved": True})
    assert approved.status_code == 200, approved.text
    assert client.get("/api/v1/kg/workbench").json()["data"]["workspace"]["currentVersionId"] == initial
    published = mutation(client, "publish", {"changeId": cid, "revision": change["revision"]})
    assert published.status_code == 200, published.text
    current = published.json()["data"]["currentVersionId"]
    assert current != initial
    after = client.get("/api/v1/kg/workbench/browse/entity", params={"versionId": current, "entityId": eid}).json()["data"]["entity"]
    assert after["description"] == entity["description"] and after["principleFlow"] == entity["principleFlow"]
    old = client.get("/api/v1/kg/workbench/browse/entity", params={"versionId": initial, "entityId": eid}).json()["data"]["entity"]
    assert old["description"] != entity["description"]
    rollback = mutation(client, "rollback", {"versionId": initial, "reason": "联调验证回滚保留历史"})
    assert rollback.status_code == 200, rollback.text
    assert rollback.json()["data"]["currentVersionId"] not in (initial, current)
    assert client.get("/api/v1/kg/workbench/history/versions", params={"pageNum": 1, "pageSize": 20}).json()["data"]["total"] >= 3
    assert client.get("/api/v1/kg/workbench/history/logs", params={"pageNum": 1, "pageSize": 20}).json()["data"]["total"] >= 5


def test_missing_entities_pagination_and_invalid_drafts(workflow_api):
    client, _ = workflow_api
    switch(client, "integration-editor")
    vid = client.get("/api/v1/kg/workbench").json()["data"]["workspace"]["currentVersionId"]
    assert client.get("/api/v1/kg/workbench/browse/entity", params={"versionId": vid, "entityId": "not-found"}).status_code == 404
    assert client.get("/api/v1/kg/workbench/history/changes", params={"pageNum": 0}).status_code == 422
    assert mutation(client, "save", {"draft": {"baseVersionId": vid, "summary": "空变更", "entities": [], "relations": []}}).status_code == 422
    assert mutation(client, "rollback", {"versionId": vid, "reason": "越权"}).status_code == 403
