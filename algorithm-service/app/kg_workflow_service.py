"""SR6 数据库权威工作区；图谱快照只在发布或回滚时变化。"""
from __future__ import annotations

import copy
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .database import get_session_factory
from .kg_models import KgAudit, KgChange, KgReceipt, KgSubmission, KgVersion, KgWorkspace


class KgWorkflowError(ValueError):
    def __init__(self, message: str, code: int = 1203, status: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _as_version(row: KgVersion) -> dict[str, Any]:
    return {"version": row.version, "at": row.created_at, "note": row.note,
            **row.stats, "parent_version": row.parent_version,
            "restored_from": row.restored_from}


def _as_change(row: KgChange, submissions: list[KgSubmission]) -> dict[str, Any]:
    return {"change_id": row.change_id, "status": row.state, "revision": row.revision,
            "base_version": row.base_version, "ops": copy.deepcopy(row.ops),
            "submitter": row.submitter, "note": row.note, "at": row.created_at,
            "updated_at": row.updated_at,
            "submissions": [{"number": s.number, "revision": s.revision,
                             "ops": s.ops, "at": s.submitted_at, "outcome": s.outcome,
                             "reviewer": s.reviewer, "opinion": s.opinion}
                            for s in submissions if s.change_id == row.change_id]}


def _bootstrap(session: Session, old_path: Path) -> KgWorkspace:
    state = session.get(KgWorkspace, 1)
    if state is not None:
        return state
    from diagnosis.sr6 import add_diagnostic_steps, add_fault_taxonomy, build_graph

    graph, _ = build_graph()
    if old_path.exists():
        try:
            with old_path.open(encoding="utf-8") as stream:
                saved = json.load(stream)
            graph._restore(saved["snapshot"])
            graph.version = saved["version"]
            graph.versions = saved["versions"]
            graph.pending = saved["pending"]
            graph.log = saved["log"]
            if saved.get("schema_revision", 1) < 2:
                add_diagnostic_steps(graph)
            if saved.get("schema_revision", 1) < 3:
                add_fault_taxonomy(graph)
                graph.version += 1
                graph.freeze("Migrate ordered diagnostic steps and fault taxonomy")
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise KgWorkflowError("旧 SR6 图谱文件无法校验或导入", 5003, 503) from exc
    for index, item in enumerate(graph.versions):
        session.add(KgVersion(version=item["version"],
                              parent_version=graph.versions[index - 1]["version"] if index else None,
                              restored_from=None, created_at=item["at"], note=item["note"],
                              snapshot=item["snapshot"], stats=item["stats"]))
    for item in graph.pending:
        status = item.get("status", "PENDING")
        state_name = "PUBLISHED" if status == "APPROVED" else status
        session.add(KgChange(change_id=item["change_id"], state=state_name, revision=1,
                             base_version=graph.version if status == "PENDING" else 1,
                             ops=item["ops"], submitter=item.get("submitter", "legacy"),
                             note=item.get("note", "历史变更"), created_at=item["at"],
                             updated_at=item["at"]))
        session.add(KgSubmission(change_id=item["change_id"], number=1, revision=1,
                                 ops=item["ops"], submitted_at=item["at"], outcome=status))
    for item in graph.log:
        session.add(KgAudit(created_at=item["at"], actor="legacy", action=item["op"],
                            change_id=None, version=item["version"], detail=item["text"]))
    state = KgWorkspace(id=1, current_version=graph.version, revision=1)
    session.add(state)
    session.flush()
    return state


def _current_graph(session: Session, state: KgWorkspace):
    from diagnosis.sr6 import build_graph

    graph, link_state = build_graph()
    version = session.get(KgVersion, state.current_version)
    graph._restore(version.snapshot)
    graph.version = version.version
    graph.versions = [{**_as_version(row), "stats": row.stats, "snapshot": row.snapshot} for row in
                      session.scalars(select(KgVersion).order_by(KgVersion.version))]
    changes = session.scalars(select(KgChange).order_by(KgChange.created_at)).all()
    submissions = session.scalars(select(KgSubmission).order_by(KgSubmission.id)).all()
    graph.pending = [{"change_id": row.change_id, "status": row.state,
                      "ops": row.ops, "submitter": row.submitter, "note": row.note,
                      "at": row.created_at} for row in changes]
    graph.log = [{"at": row.created_at, "op": row.action,
                  "text": row.detail, "version": row.version} for row in
                 session.scalars(select(KgAudit).order_by(KgAudit.id))]
    attrs_by_id = {e["attrs"]["rule_id"]: e["attrs"] for e in graph.entities.values()
                   if e["type"] == "Metric" and "rule_id" in e["attrs"]}
    for rule in link_state.rules:
        attrs = attrs_by_id.get(rule["rule_id"])
        if attrs:
            rule["threshold"] = attrs["threshold"]
            rule["threshold_text"] = attrs["threshold_text"]
    return graph, link_state


def load_graph(old_path: Path):
    with get_session_factory().begin() as session:
        state = _bootstrap(session, old_path)
        return _current_graph(session, state)


def current_revision(old_path: Path) -> int:
    with get_session_factory().begin() as session:
        return _bootstrap(session, old_path).revision


def workspace(old_path: Path) -> dict[str, Any]:
    with get_session_factory().begin() as session:
        state = _bootstrap(session, old_path)
        changes = session.scalars(select(KgChange).order_by(KgChange.created_at)).all()
        submissions = session.scalars(select(KgSubmission).order_by(KgSubmission.id)).all()
        return {"revision": state.revision, "current_version": state.current_version,
                "versions": [_as_version(row) for row in
                             session.scalars(select(KgVersion).order_by(KgVersion.version))],
                "changes": [_as_change(row, submissions) for row in changes],
                "audit": [{"at": row.created_at, "op": row.action, "actor": row.actor,
                           "text": row.detail, "version": row.version} for row in
                          session.scalars(select(KgAudit).order_by(KgAudit.id))]}


def version_snapshot(old_path: Path, version: int) -> dict[str, Any]:
    with get_session_factory().begin() as session:
        _bootstrap(session, old_path)
        row = session.get(KgVersion, version)
        if row is None:
            raise KgWorkflowError("知识版本不存在", 4001, 404)
        return {**_as_version(row), "snapshot": row.snapshot}


def _validate_ops(graph, ops: list[dict[str, Any]]) -> None:
    if not isinstance(ops, list) or not 1 <= len(ops) <= 100 or any(
            not isinstance(op, dict) for op in ops):
        raise KgWorkflowError("ops 必须是 1 到 100 项变更对象", 1001, 422)
    _, errors = graph.submit_update(ops, "validation", "validation")
    if errors:
        raise KgWorkflowError("变更校验未通过: " + "; ".join(errors), 1001, 422)


def _receipt(session: Session, request: dict[str, Any], action: str):
    request_id = request.get("request_id")
    if not request_id:
        return None, None
    digest = hashlib.sha256(json.dumps([action, request], sort_keys=True,
                                       ensure_ascii=False).encode("utf-8")).hexdigest()
    row = session.get(KgReceipt, request_id)
    if row:
        if row.digest != digest:
            raise KgWorkflowError("request_id 已用于其他操作")
        return row.response, digest
    return None, digest


def _finish(session: Session, state: KgWorkspace, request: dict[str, Any],
            digest: str | None, action: str, actor: str, change_id: str | None,
            result: dict[str, Any]) -> dict[str, Any]:
    previous_revision = state.revision
    next_revision = previous_revision + 1
    # 以修订号作条件更新，避免多个请求覆盖当前发布指针。
    updated = session.execute(update(KgWorkspace).where(
        KgWorkspace.id == 1, KgWorkspace.revision == previous_revision).values(
            current_version=state.current_version, revision=next_revision))
    if updated.rowcount != 1:
        raise KgWorkflowError("知识工作区已变化，请重新加载")
    result["workspace_revision"] = next_revision
    session.add(KgAudit(created_at=time.time(), actor=actor, action=action,
                        change_id=change_id, version=state.current_version,
                        detail=result.get("status", action)))
    if digest:
        session.add(KgReceipt(request_id=request["request_id"], digest=digest,
                              response=copy.deepcopy(result)))
    return result


def _check_revision(state: KgWorkspace, request: dict[str, Any]) -> None:
    expected = request.get("base_revision")
    if expected is not None and expected != state.revision:
        raise KgWorkflowError("知识工作区已变化，请重新加载")


def _change(session: Session, change_id: str, request: dict[str, Any],
            required_state: str | tuple[str, ...], state: KgWorkspace) -> KgChange:
    row = session.get(KgChange, change_id)
    if row is None:
        raise KgWorkflowError("知识变更单不存在", 4001, 404)
    allowed = (required_state,) if isinstance(required_state, str) else required_state
    if row.state not in allowed or row.revision != request.get("revision"):
        raise KgWorkflowError("变更状态或修订已变化，请重新加载")
    if row.base_version != state.current_version:
        raise KgWorkflowError("草稿基线已过期，请基于当前发布版新建")
    return row


def save_draft(old_path: Path, request: dict[str, Any], change_id: str | None = None,
               *, submit_now: bool = False) -> dict[str, Any]:
    with get_session_factory().begin() as session:
        state = _bootstrap(session, old_path)
        replay, digest = _receipt(session, request, "SUBMIT" if submit_now else "SAVE")
        if replay is not None:
            return replay
        _check_revision(state, request)
        graph, _ = _current_graph(session, state)
        _validate_ops(graph, request["ops"])
        case_names = {op["head"] for op in request["ops"] if
                      op.get("op") == "add_triple" and op.get("head_type") == "Fault"}
        if case_names:
            for old in session.scalars(select(KgChange).where(
                    KgChange.state.in_(["DRAFT", "PENDING", "APPROVED"]))):
                if old.change_id != change_id and any(op.get("op") == "add_triple" and
                        op.get("head_type") == "Fault" and op.get("head") in case_names
                        for op in old.ops):
                    raise KgWorkflowError("故障案例编号已被未发布变更占用")
        now = time.time()
        if change_id:
            row = _change(session, change_id, request, ("DRAFT", "REJECTED"), state)
            if row.submitter != request["actor"]:
                raise KgWorkflowError("只有作者可修改草稿", 1003, 403)
            row.ops = copy.deepcopy(request["ops"])
            row.note = request["note"]
            row.revision += 1
            row.state = "DRAFT"
            row.updated_at = now
        else:
            if request.get("base_version") not in (None, state.current_version):
                raise KgWorkflowError("草稿基线已过期")
            row = KgChange(change_id="CR-" + uuid.uuid4().hex[:16].upper(),
                           state="DRAFT", revision=1, base_version=state.current_version,
                           ops=copy.deepcopy(request["ops"]), submitter=request["actor"],
                           note=request["note"], created_at=now, updated_at=now)
            session.add(row)
        if submit_now:
            row.state = "PENDING"
            session.add(KgSubmission(change_id=row.change_id, number=1,
                                     revision=row.revision, ops=copy.deepcopy(row.ops),
                                     submitted_at=now, outcome="PENDING"))
        result = {"change_id": row.change_id, "status": row.state,
                  "revision": row.revision, "version": state.current_version}
        return _finish(session, state, request, digest, "SUBMIT" if submit_now else "SAVE",
                       request["actor"], row.change_id, result)


def transition(old_path: Path, change_id: str, request: dict[str, Any],
               action: str) -> dict[str, Any]:
    required = {"SUBMIT": "DRAFT", "WITHDRAW": "PENDING", "REVIEW": "PENDING",
                "PUBLISH": "APPROVED"}[action]
    with get_session_factory().begin() as session:
        state = _bootstrap(session, old_path)
        replay, digest = _receipt(session, request, action)
        if replay is not None:
            return replay
        _check_revision(state, request)
        row = _change(session, change_id, request, required, state)
        actor = request["actor"]
        if action in ("SUBMIT", "WITHDRAW") and actor != row.submitter:
            raise KgWorkflowError("只有作者可送审或撤回", 1003, 403)
        if action in ("REVIEW", "PUBLISH") and actor == row.submitter:
            raise KgWorkflowError("作者不能审核或发布自己的变更", 1003, 403)
        submissions = session.scalars(select(KgSubmission).where(
            KgSubmission.change_id == change_id).order_by(KgSubmission.number)).all()
        now = time.time()
        if action == "SUBMIT":
            graph, _ = _current_graph(session, state)
            _validate_ops(graph, row.ops)
            row.state = "PENDING"
            session.add(KgSubmission(change_id=change_id, number=len(submissions) + 1,
                                     revision=row.revision, ops=copy.deepcopy(row.ops),
                                     submitted_at=now, outcome="PENDING"))
        elif action == "WITHDRAW":
            row.state = "DRAFT"
            submissions[-1].outcome = "WITHDRAWN"
            submissions[-1].reviewer = actor
            submissions[-1].opinion = "作者撤回"
        elif action == "REVIEW":
            if request.get("submission") != submissions[-1].number:
                raise KgWorkflowError("送审记录已变化")
            approved = request.get("approved")
            if not isinstance(approved, bool):
                raise KgWorkflowError("approved 必须为布尔值", 1001, 422)
            if not approved and not str(request.get("opinion") or "").strip():
                raise KgWorkflowError("驳回须填写意见", 1001, 422)
            if approved:
                # 在隔离副本验证整批变更；审核不改变当前发布图谱。
                graph, _ = _current_graph(session, state)
                graph.pending = [{"change_id": change_id, "status": "PENDING",
                                  "ops": copy.deepcopy(row.ops), "note": row.note}]
                try:
                    graph.review(change_id, True, actor)
                except (ValueError, KeyError, TypeError) as exc:
                    raise KgWorkflowError("变更无法应用: " + str(exc), 1001, 422) from exc
            row.state = "APPROVED" if approved else "REJECTED"
            submissions[-1].outcome = row.state
            submissions[-1].reviewer = actor
            submissions[-1].opinion = request.get("opinion", "")
        else:
            graph, _ = _current_graph(session, state)
            graph.pending = [{"change_id": change_id, "status": "PENDING",
                              "ops": copy.deepcopy(row.ops), "note": row.note}]
            try:
                graph.review(change_id, True, actor)
            except (ValueError, KeyError, TypeError) as exc:
                raise KgWorkflowError("变更无法发布: " + str(exc), 1001, 422) from exc
            session.add(KgVersion(version=graph.version, parent_version=state.current_version,
                                  restored_from=None, created_at=now,
                                  note=graph.versions[-1]["note"], snapshot=graph._snapshot(),
                                  stats=graph.versions[-1]["stats"]))
            state.current_version = graph.version
            row.state = "PUBLISHED"
        row.updated_at = now
        result = {"change_id": change_id, "status": row.state, "revision": row.revision,
                  "version": state.current_version}
        return _finish(session, state, request, digest, action, actor, change_id, result)


def rollback(old_path: Path, target_version: int, request: dict[str, Any]) -> dict[str, Any]:
    with get_session_factory().begin() as session:
        state = _bootstrap(session, old_path)
        replay, digest = _receipt(session, request, "ROLLBACK")
        if replay is not None:
            return replay
        _check_revision(state, request)
        if request.get("current_version") != state.current_version:
            raise KgWorkflowError("当前发布版本已变化")
        target = session.get(KgVersion, target_version)
        if target is None:
            raise KgWorkflowError("知识版本不存在", 4001, 404)
        if target.version == state.current_version:
            raise KgWorkflowError("目标版本与当前版本相同")
        current = state.current_version
        new_version = current + 1
        session.add(KgVersion(version=new_version, parent_version=current,
                              restored_from=target_version, created_at=time.time(),
                              note="恢复版本 %d：%s" % (target_version, request["reason"]),
                              snapshot=copy.deepcopy(target.snapshot),
                              stats=copy.deepcopy(target.stats)))
        state.current_version = new_version
        result = {"version": new_version, "restored_from": target_version,
                  "entities": target.stats["entities"], "triples": target.stats["triples"]}
        return _finish(session, state, request, digest, "ROLLBACK", request["actor"],
                       None, result)
