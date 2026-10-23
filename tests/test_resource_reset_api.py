"""资源恢复 API：复用工作区隔离库，权限仅由测试 fixture 授予。"""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256

import pytest
from sqlalchemy import create_engine, select, update
from sqlalchemy.orm import sessionmaker

from test_resource_workspace_api import (
    ROOT, body, counts, headers, new_device, new_interference, new_node,
    save, switch, workspace_api,
)
from app import database, integration_identity_service as identity
from app import resource_dataset_service as datasets
from app.planning_plan_models import PlanningPlan
from app.resource_dataset_models import ResourceDatasetOperation, ResourceDatasetVersion

RESET = "/api/v1/resource/reset"
RESET_ACTOR = "reset-test-operator"


@pytest.fixture
def reset_api(workspace_api, monkeypatch):
    permissions = [*identity.CATALOG["integration-editor"][2], "resources.reset"]
    monkeypatch.setitem(identity.CATALOG, RESET_ACTOR, ("恢复测试账号", "EDITOR", permissions))
    client, factory, baseline, path = workspace_api
    assert path.is_relative_to(ROOT / "data/runtime")
    account = switch(client, RESET_ACTOR)
    assert {"resources.view", "resources.reset"} <= set(account["permissions"])
    return client, factory, baseline, path


def payload(snapshot, request_id="reset-request"):
    return {"base_revision": snapshot["revision"], "request_id": request_id}


def reset(client, request, **kwargs):
    return client.post(RESET, headers=headers(client), json=request, **kwargs)


def assert_failure(response, status, code):
    assert response.status_code == status, response.text
    data = response.json()
    assert set(data) == {"code", "message", "data"}
    assert data["code"] == code and data["data"] is None and data["message"]


def rows(factory, model, key):
    with factory() as session:
        return {row[key]: deepcopy(dict(row))
                for row in session.execute(select(model.__table__)).mappings()}


def history(factory):
    return {"versions": rows(factory, ResourceDatasetVersion, "revision"),
            "operations": rows(factory, ResourceDatasetOperation, "request_id"),
            "plans": rows(factory, PlanningPlan, "plan_id")}


def assert_preserved(factory, previous):
    current = history(factory)
    for category, originals in previous.items():
        assert originals.items() <= current[category].items()


def assert_unchanged(factory, snapshot, previous):
    assert history(factory) == previous
    current = datasets.current()
    assert current["revision"] == snapshot["revision"]
    assert current["tables"] == snapshot["tables"]


def source_hashes(baseline):
    return {name: sha256((ROOT / value["path"]).read_bytes()).hexdigest()
            for name, value in baseline["source_files"].items()}


def forbid_file_capture(monkeypatch):
    def forbidden():
        pytest.fail("恢复必须读取数据库初始快照，不得重新导入源文件")
    monkeypatch.setattr(datasets, "capture_files", forbidden)


def edit_device(client, snapshot, request_id, height):
    identifier = snapshot["tables"]["device.csv"][0]["device_id"]
    response = save(client, body(snapshot, {"devices": [{"id": identifier, "antennaHeightM": height}]}, request_id))
    assert response.status_code == 200, response.text
    assert response.json()["data"]["receipt"]["changed"] is True
    return datasets.current()


def test_initial_reset_is_noop_with_one_receipt_and_replays(reset_api, monkeypatch):
    client, factory, baseline, _ = reset_api
    before, files = history(factory), source_hashes(baseline)
    forbid_file_capture(monkeypatch)
    request = payload(baseline, "initial-noop")
    response = reset(client, request)
    assert response.status_code == 200, response.text
    assert response.json() == {"code": 0, "message": "success", "data": {
        "objectId": "resource-reset", "changed": False, "revision": baseline["revision"],
        "readRevision": baseline["revision"], "affectedIds": [], "warnings": [],
        "restoredFromRevision": baseline["revision"],
    }}
    assert counts(factory) == (1, 1)
    assert_preserved(factory, before)
    assert datasets.current()["tables"] == baseline["tables"]
    receipt = rows(factory, ResourceDatasetOperation, "request_id")["initial-noop"]
    assert receipt["actor_id"] == RESET_ACTOR and receipt["base_revision"] == baseline["revision"]
    assert reset(client, request).json() == response.json()
    assert counts(factory) == (1, 1) and source_hashes(baseline) == files


def test_restore_creates_new_version_and_preserves_history_sources_and_plan(reset_api, monkeypatch):
    client, factory, baseline, _ = reset_api
    files = source_hashes(baseline)
    node = new_node("RESET-NEW-NODE")
    identifier = baseline["tables"]["device.csv"][0]["device_id"]
    original_node = baseline["tables"]["node.csv"][0]["node_id"]
    changes = {
        "stations": [{"id": original_node, "name": "恢复前修改的节点"}],
        "devices": [{"id": identifier, "antennaHeightM": 17.125}],
        "newStations": [node],
        "newDevices": [new_device(baseline, node["id"], "RESET-NEW-DEVICE")],
        "newInterferences": [new_interference("RESET-NEW-INTERFERENCE")],
    }
    response = save(client, body(baseline, changes, "edit-before-reset", "gis"))
    assert response.status_code == 200, response.text
    changed = datasets.current()
    assert changed["revision"] != baseline["revision"]
    # 此行仅检验历史保留，不作为已运行或已确认的规划方案。
    with factory.begin() as session:
        session.add(PlanningPlan(plan_id="RESET-RETAINED-PLAN", request_id="retained-plan-request",
            request_digest="a" * 64, task_id="retained-task", job_id="retained-job", revision_id="retained-input",
            condition_version="retained-condition", resource_revision=changed["revision"],
            parent_plan_id=None, adjustment=None, version_no=1, name="恢复后保留的历史", note="隔离测试记录",
            state="SAVED", input_snapshot={"resource_revision": changed["revision"]},
            result_snapshot={"fixture": True}, raw_snapshot=None, outcome_snapshot={"fixture": True},
            source="SYNTHETIC_INTEGRATION", saved_at=datetime.now(timezone.utc), confirmed_at=None))
    before = history(factory)
    forbid_file_capture(monkeypatch)
    request = payload(changed, "restore-modified")
    response = reset(client, request)
    assert response.status_code == 200, response.text
    receipt = response.json()["data"]
    assert receipt["objectId"] == "resource-reset" and receipt["changed"] is True
    assert receipt["revision"] == receipt["readRevision"]
    assert receipt["revision"] not in (baseline["revision"], changed["revision"])
    assert receipt["restoredFromRevision"] == baseline["revision"]
    assert receipt["affectedIds"] == sorted([identifier, original_node, "RESET-NEW-NODE",
                                             "RESET-NEW-DEVICE", "RESET-NEW-INTERFERENCE"])
    assert receipt["warnings"] == []
    current = datasets.current()
    assert current["revision"] == receipt["revision"]
    assert current["tables"] == baseline["tables"] and current["source_files"] == baseline["source_files"]
    assert current["change"]["parent_revision"] == changed["revision"]
    assert current["change"]["request_id"] == "restore-modified"
    assert current["change"]["actor_id"] == RESET_ACTOR
    assert counts(factory) == (3, 2)
    assert_preserved(factory, before)
    assert source_hashes(baseline) == files
    plan = history(factory)["plans"]["RESET-RETAINED-PLAN"]
    assert plan["resource_revision"] == changed["revision"] != current["revision"]
    noop = reset(client, payload(current, "restored-already"))
    assert noop.status_code == 200, noop.text
    assert noop.json()["data"] == {**receipt, "changed": False, "affectedIds": []}
    assert counts(factory) == (3, 3)


def test_original_reset_replays_after_later_edit_and_connection_reopen(reset_api, monkeypatch):
    client, factory, baseline, path = reset_api
    changed = edit_device(client, baseline, "edit-first", 17.125)
    request = payload(changed, "frozen-reset")
    first = reset(client, request)
    assert first.status_code == 200, first.text
    restored = datasets.current()
    latest = edit_device(client, restored, "edit-after-reset", 18.125)
    before = history(factory)
    assert reset(client, request).json() == first.json()
    assert_unchanged(factory, latest, before)
    reopened = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False})
    replacement = sessionmaker(bind=reopened, expire_on_commit=False)
    try:
        for module in (database, datasets, identity):
            monkeypatch.setattr(module, "get_session_factory", lambda: replacement)
        monkeypatch.setattr(database, "get_engine", lambda: reopened)
        forbid_file_capture(monkeypatch)
        assert reset(client, request).json() == first.json()
        assert_unchanged(factory, latest, before)
    finally:
        reopened.dispose()
    assert counts(factory) == (4, 3)


def test_stale_reset_and_changed_request_or_actor_are_conflicts_without_writes(reset_api, monkeypatch):
    client, factory, baseline, _ = reset_api
    changed = edit_device(client, baseline, "edit-stale-base", 17.125)
    before = history(factory)
    assert_failure(reset(client, payload(baseline, "new-stale-reset")), 409, 1205)
    assert_unchanged(factory, changed, before)
    request = payload(changed, "same-reset-id")
    first = reset(client, request)
    assert first.status_code == 200, first.text
    current, before = datasets.current(), history(factory)
    assert_failure(reset(client, payload(current, "same-reset-id")), 409, 1206)
    assert_unchanged(factory, current, before)
    monkeypatch.setitem(identity.CATALOG, "reset-test-other", ("另一测试账号", "EDITOR", ["resources.view", "resources.reset"]))
    switch(client, "reset-test-other")
    assert_failure(reset(client, request), 409, 1206)
    assert_unchanged(factory, current, before)


@pytest.mark.parametrize("account", ["integration-planner", "integration-editor", "integration-reviewer"])
def test_existing_accounts_do_not_gain_reset_permission(reset_api, account):
    client, factory, baseline, _ = reset_api
    assert "resources.reset" not in identity.CATALOG[account][2]
    switch(client, account)
    before = history(factory)
    assert_failure(reset(client, payload(baseline)), 403, 1104)
    assert_unchanged(factory, baseline, before)


def test_reset_permission_alone_does_not_replace_view_permission(reset_api, monkeypatch):
    client, factory, baseline, _ = reset_api
    name, role, _ = identity.CATALOG[RESET_ACTOR]
    monkeypatch.setitem(identity.CATALOG, RESET_ACTOR, (name, role, ["resources.reset"]))
    before = history(factory)
    assert_failure(reset(client, payload(baseline)), 403, 1104)
    assert_unchanged(factory, baseline, before)


@pytest.mark.parametrize("case,status,code", [
    ("missing-session", 409, 1106), ("missing-csrf", 403, 1105),
    ("bad-csrf", 403, 1105), ("stale-session", 409, 1106),
])
def test_csrf_and_session_rejection_never_resets(reset_api, case, status, code):
    client, factory, baseline, _ = reset_api
    supplied = headers(client)
    if case == "missing-session":
        supplied.pop("X-Session-Id")
    elif case == "missing-csrf":
        supplied.pop("X-CSRF-Token")
    elif case == "bad-csrf":
        supplied["X-CSRF-Token"] = "bad-token"
    else:
        switch(client, RESET_ACTOR)
    before = history(factory)
    response = client.post(RESET, headers=supplied, json=payload(baseline))
    assert_failure(response, status, code)
    assert_unchanged(factory, baseline, before)


@pytest.mark.parametrize("field,value", [
    ("request_id", None), ("request_id", 7), ("request_id", ""), ("request_id", "has space"),
    ("request_id", "control\n"), ("request_id", "x" * 121),
    ("base_revision", None), ("base_revision", 7), ("base_revision", ""), ("base_revision", "bad\tversion"),
    ("actor_id", "admin"), ("force", True), ("hard_delete", True),
    ("restore_from", {"tables": {}}), ("source_files", {}), ("changes", {}), ("context", "gis"),
])
def test_strict_body_rejects_invalid_ids_and_injected_fields(reset_api, field, value):
    client, factory, baseline, _ = reset_api
    before = history(factory)
    response = reset(client, {**payload(baseline), field: value})
    assert_failure(response, 422, 1001)
    assert_unchanged(factory, baseline, before)


@pytest.mark.parametrize("missing", ["base_revision", "request_id"])
def test_required_fields_cannot_be_omitted(reset_api, missing):
    client, factory, baseline, _ = reset_api
    request = payload(baseline)
    request.pop(missing)
    before = history(factory)
    assert_failure(reset(client, request), 422, 1001)
    assert_unchanged(factory, baseline, before)


def test_query_injection_and_non_object_json_are_rejected(reset_api):
    client, factory, baseline, _ = reset_api
    before = history(factory)
    for query in ({"force": "true"}, {"base_revision": baseline["revision"]}, [("request_id", "one"), ("request_id", "two")]):
        assert_failure(reset(client, payload(baseline), params=query), 422, 1001)
    for request in ([], [payload(baseline)], "reset"):
        response = reset(client, request)
        assert response.status_code == 422, response.text
        failure = response.json()
        assert set(failure) == {"code", "message", "data"}
        assert failure["code"] == 1001 and failure["message"]
        # 框架级结构校验沿用统一问题列表，路由内部校验才返回 data=null。
        assert isinstance(failure["data"], list) and failure["data"]
        assert all(set(issue) == {"field", "message"} and issue["field"] == "body" and issue["message"]
                   for issue in failure["data"])
    assert_unchanged(factory, baseline, before)


def test_corrupt_initial_snapshot_cannot_fall_back_to_files(reset_api, monkeypatch):
    client, factory, baseline, _ = reset_api
    current = edit_device(client, baseline, "edit-before-damaged-baseline", 17.125)
    with factory.begin() as session:
        session.execute(update(ResourceDatasetVersion).where(
            ResourceDatasetVersion.revision == baseline["revision"]).values(content_hash="0" * 64))
    before = history(factory)
    forbid_file_capture(monkeypatch)
    assert_failure(reset(client, payload(current)), 503, 5002)
    assert_unchanged(factory, current, before)
