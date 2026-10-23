"""新版回滚锚定当前版并恢复父版；仅服务身份夹具，不代表 LOCAL HTTP。"""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import database, kg, kg_frontend_service as facade, kg_workflow_service as workflow
from app.kg_frontend_schemas import KnowledgeMutation
from app.kg_models import KgAudit, KgChange, KgReceipt, KgSubmission, KgVersion, KgWorkspace
from diagnosis import sr6
from diagnosis.kg_store import KnowledgeGraph
from diagnosis.link_state_kg import LinkStateKnowledge


MODELS = (KgWorkspace, KgVersion, KgChange, KgSubmission, KgAudit, KgReceipt)
SOURCE = "test_kg_frontend_rollback_contract.py [CONSTRUCTED]"


@pytest.fixture
def identities():
    return {"editor": {"account_id": "fixture-editor", "display_name": "构造编辑者", "role_id": "fixture-editor-role",
                       "role_name": "编辑角色", "permissions": ["knowledge.view", "knowledge.edit"]},
            "reviewer": {"account_id": "fixture-reviewer", "display_name": "构造审核者", "role_id": "fixture-reviewer-role",
                         "role_name": "审核角色", "permissions": ["knowledge.view", "knowledge.review", "knowledge.publish", "knowledge.rollback"]}}


@pytest.fixture
def env(tmp_path, monkeypatch, identities):
    assert tmp_path.resolve().is_relative_to((ROOT / "data/runtime/tmp").resolve())
    path = tmp_path / "kg-facade-rollback.sqlite"
    assert not path.exists(), "只允许新 GUID 临时目录中的新 SQLite"
    engine = create_engine("sqlite:///" + str(path))
    database.Base.metadata.create_all(engine, tables=[model.__table__ for model in MODELS])
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    old_path = tmp_path / "absent-legacy-graph.json"
    assert not old_path.exists()
    for module in (database, workflow, facade):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)
    monkeypatch.setattr(kg, "STORE_PATH", old_path)
    for name in ("_GRAPH", "_STATE", "_GRAPH_REVISION"):
        monkeypatch.setattr(kg, name, None)

    def build_small_graph():
        # 只替换 bootstrap 的构造数据来源，保留真实图谱增量审核、冻结和 SQL 工作流。
        graph = KnowledgeGraph("constructed-rollback-contract")
        graph.add_triple(("DeviceModel", "DM-ROLLBACK"), "hasFunction", ("Function", "基线功能"),
                         source=SOURCE, graph="device")
        graph.freeze("构造基线")
        return graph, LinkStateKnowledge()

    monkeypatch.setattr(sr6, "build_graph", build_small_graph)
    try:
        state = workflow.workspace(old_path)
        assert state["current_version"] == 1 and state["revision"] == 1
        yield SimpleNamespace(factory=factory, old_path=old_path, identities=identities)
        assert not old_path.exists(), "数据库工作流不得回写旧图谱文件"
    finally:
        engine.dispose()


def rows(env, model):
    with env.factory() as session:
        return deepcopy([dict(row) for row in session.execute(select(model.__table__).order_by(
            *model.__table__.primary_key.columns)).mappings()])


def database_snapshot(env):
    return {model.__tablename__: rows(env, model) for model in MODELS}


def publish(env):
    state = workflow.workspace(env.old_path)
    version = state["current_version"] + 1
    editor, reviewer = env.identities["editor"], env.identities["reviewer"]
    saved = workflow.save_draft(env.old_path, {"request_id": f"save-{version}", "actor": editor["account_id"],
        "_identity": facade.identity_snapshot(editor), "base_revision": state["revision"],
        "base_version": state["current_version"], "note": f"构造发布 {version}",
        "ops": [{"op": "add_triple", "head_type": "DeviceModel", "head": "DM-ROLLBACK", "relation": "hasFunction",
                 "tail_type": "Function", "tail": f"新增功能 {version}", "source": SOURCE}]})
    for action, identity in (("SUBMIT", editor), ("REVIEW", reviewer), ("PUBLISH", reviewer)):
        saved = workflow.transition(env.old_path, saved["change_id"], {
            "request_id": f"{action.lower()}-{version}", "actor": identity["account_id"],
            "_identity": facade.identity_snapshot(identity), "base_revision": saved["workspace_revision"],
            "revision": saved["revision"], "submission": 1, "approved": True}, action)
    assert saved["version"] == version
    return saved


def rollback_request(env, *, request_id="facade-rollback", version=None, revision=None):
    state = workflow.workspace(env.old_path)
    return KnowledgeMutation(requestId=request_id, actorId=env.identities["reviewer"]["account_id"],
        baseRevision=f"KG-{state['revision'] if revision is None else revision}",
        versionId=f"KGV-{state['current_version'] if version is None else version}", reason="恢复直接父版")


def rollback(env, request):
    return facade.mutate("rollback", request, env.identities["reviewer"])


@pytest.mark.parametrize("publish_count", [1, 2])
def test_published_current_version_rolls_back_to_its_parent_as_new_immutable_version(env, publish_count):
    for _ in range(publish_count):
        publish(env)
    old = rows(env, KgVersion)
    current, target = old[-1], old[-2]
    assert current["parent_version"] == target["version"]
    assert current["snapshot"] != target["snapshot"]
    historical_views = {row["version"]: facade.version_detail(f"KGV-{row['version']}") for row in old}
    request = rollback_request(env)
    result = rollback(env, request)
    new_version = current["version"] + 1
    assert result["currentVersionId"] == result["objectId"] == result["entityId"] == f"KGV-{new_version}"
    assert result["changed"] is True
    state = workflow.workspace(env.old_path)
    assert state["current_version"] == new_version and result["revision"] == f"KG-{state['revision']}"
    versions = rows(env, KgVersion)
    assert versions[:-1] == old
    restored = versions[-1]
    assert restored["version"] == new_version and restored["parent_version"] == current["version"]
    assert restored["restored_from"] == target["version"]
    assert restored["snapshot"] == target["snapshot"] and restored["stats"] == target["stats"]
    assert restored["frontend_metadata"]["actor"] == facade.identity_snapshot(env.identities["reviewer"])
    detail = facade.version_detail(result["currentVersionId"])
    assert detail["kind"] == "ROLLBACK" and detail["parentId"] == request.versionId
    assert detail["restoredFromVersionId"] == f"KGV-{target['version']}"
    graph, _ = workflow.load_graph(env.old_path)
    assert graph.version == new_version and graph._snapshot() == target["snapshot"]
    for version, view in historical_views.items():
        assert facade.version_detail(f"KGV-{version}") == view
    audits = [row for row in rows(env, KgAudit) if row["action"] == "ROLLBACK"]
    assert len(audits) == 1 and audits[0]["version"] == new_version
    assert audits[0]["identity_snapshot"] == facade.identity_snapshot(env.identities["reviewer"])


def test_same_request_keeps_original_anchor_after_rollback_and_later_publication(env):
    publish(env)
    request = rollback_request(env)
    original_request = request.model_dump()
    first = rollback(env, request)
    before = database_snapshot(env)
    assert rollback(env, request) == first and database_snapshot(env) == before
    assert request.model_dump() == original_request
    assert request.versionId == "KGV-2" and first["currentVersionId"] == "KGV-3"
    for updates in ({"versionId": "KGV-3"}, {"baseRevision": first["revision"]}, {"reason": "不同原因"}):
        with pytest.raises(workflow.KgWorkflowError) as changed_anchor:
            rollback(env, request.model_copy(update=updates))
        assert (changed_anchor.value.code, changed_anchor.value.status) == (1203, 409)
        assert database_snapshot(env) == before
    publish(env)
    later = database_snapshot(env)
    assert workflow.workspace(env.old_path)["current_version"] == 4
    assert rollback(env, request) == first
    assert database_snapshot(env) == later
    with env.factory() as session:
        receipt = session.get(KgReceipt, request.requestId)
        assert receipt.response["version"] == 3 and receipt.response["restored_from"] == 1
    assert len([row for row in rows(env, KgAudit) if row["action"] == "ROLLBACK"]) == 1


@pytest.mark.parametrize("case,code,status", [("stale_current", 1203, 409), ("no_parent", 1203, 409),
                                              ("unknown_version", 4001, 404)])
def test_invalid_current_anchor_is_rejected_without_receipt_or_history_changes(env, case, code, status):
    if case == "stale_current":
        publish(env)
        rollback(env, rollback_request(env, request_id="advance-current"))
        request = rollback_request(env, request_id="stale-current", version=2)
    else:
        request = rollback_request(env, version=999 if case == "unknown_version" else 1)
    before = database_snapshot(env)
    with pytest.raises(workflow.KgWorkflowError) as rejected:
        rollback(env, request)
    assert (rejected.value.code, rejected.value.status) == (code, status)
    assert database_snapshot(env) == before
    with env.factory() as session:
        assert session.get(KgReceipt, request.requestId) is None


def test_stale_workspace_revision_cannot_rollback_even_if_current_version_matches(env):
    publish(env)
    request = rollback_request(env, revision=1)
    assert request.versionId == "KGV-2"
    before = database_snapshot(env)
    with pytest.raises(workflow.KgWorkflowError) as stale:
        rollback(env, request)
    assert (stale.value.code, stale.value.status) == (1203, 409)
    assert database_snapshot(env) == before
