"""规划写回执的本地归属与原子审计；隔离数据库，不运行 SR4 算法。"""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
import sys
from types import SimpleNamespace
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import local_business_context as local_context
from app import planning_operation_service as operations, planning_plan_service as plans, task_input_service as tasks
from app.database import Base
from app.local_identity_models import LocalIdentitySession
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import LocalIdentityAdapter, LocalIdentityService
from app.permission_registry import SERVER_PERMISSION_REGISTRY
from app.planning_job_models import PlanningJob, PlanningJobCancellation
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan, PlanningPlanConfirmation
from app.planning_plan_schemas import PlanningPlanConfirmRequest, PlanningPlanSaveRequest
from app.system_audit_service import IMMUTABLE_SQLITE_DDL
from app.system_management_models import LocalAccount, LocalCredential, LocalRole, SystemAuditArchive, SystemAuditEvent
from app.system_management_schemas import SystemManagementError
from app.system_management_service import SystemManagementService
from app.task_input_models import PlanningOperationReceipt, PlanningTask, PlanningTaskRevision
from app.task_input_schemas import TaskSaveRequest


PERMISSIONS = frozenset({"planning.view", "planning.execute", "planning.save", "planning.confirm"})
ACTION = {"saveTask": "task.save", "savePlan": "plan.save", "confirm": "plan.confirm",
          "submit": "planning.submit", "cancel": "planning.cancel"}
MODELS = (PlanningTask, PlanningTaskRevision, PlanningOperationReceipt, PlanningJob, PlanningJobCancellation,
          PlanningPlan, PlanningPlanConfirmation, PlanningCurrentPlan, SystemAuditEvent)


def input_data():
    return {"name": "隔离任务", "description": "主体归属验证", "bbox": [113, 36, 116, 39],
        "stationIds": ["N1", "N2"], "presetId": "P1", "frequencyId": "F1",
        "startTime": None, "durationH": None,
        "constraints": {"connectivityPercent": 100, "maxRelayHops": 2, "survivabilityPercent": 90},
        "demands": [{"id": "D1", "sourceId": "N1", "targetId": "N2", "endpointMode": "station",
            "sourceDeviceId": None, "targetDeviceId": None, "preferredClass": None, "service": "数据",
            "priority": "P1", "mandatory": True, "dataVolumeMb": 10, "requiredRateKbps": 64,
            "maxDelayMs": 100, "minReliability": 0.95}]}


def task_request(request_id, revision=None, *, name="隔离任务", context="planning"):
    return TaskSaveRequest.model_validate({"context": context, "task_id": "T1", "expected_revision": revision,
        "resource_revision": "RES1", "request_id": request_id, "input": {**input_data(), "name": name}})


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    monkeypatch.setattr(plans.frontend_integration, "resource_revision", lambda: "RES1")
    engine = create_engine("sqlite:///" + str(tmp_path / "ownership.sqlite"))
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        for ddl in IMMUTABLE_SQLITE_DDL:
            connection.exec_driver_sql(ddl)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    clock = [2_000_000_000]
    system = SystemManagementService(session_factory=factory, permission_registry=SERVER_PERMISSION_REGISTRY,
        request_key=b"isolated-planning-owner-test-key-32", clock=lambda: clock[0])
    adapter = LocalIdentityAdapter(service=LocalIdentityService(system_service=system,
        settings=LocalIdentitySettings(frozenset({"http://127.0.0.1:8811"}), allow_insecure_loopback=True)))
    application = SimpleNamespace(state=SimpleNamespace(local_identity_adapter=adapter))

    def add_session(account, suffix=""):
        token = "isolated-cookie-" + account + suffix
        with factory.begin() as session:
            session.add(LocalIdentitySession(token_hash=sha256(token.encode()).hexdigest(),
                session_id="SID-" + account + suffix, account_id="ACC-" + account, generation="GEN-" + account + suffix,
                identity_revision=1, csrf="isolated-csrf-" + account + suffix, created_at=clock[0], last_seen=clock[0],
                expires_at=clock[0] + 20_000, revoked=False))

    with factory.begin() as session:
        session.add(LocalRole(id="ROLE-TEST", name="隔离角色", description="非生产", permissions=sorted(PERMISSIONS)))
        session.flush()
        for account in ("A", "B"):
            session.add(LocalAccount(id="ACC-" + account, username="owner_" + account.lower(), name="主体" + account,
                department="隔离测试", role_id="ROLE-TEST", enabled=True, identity_revision=1, last_login=None))
        session.flush()
        for account in ("A", "B"):
            session.add(LocalCredential(account_id="ACC-" + account, password_hash="not-used-by-seeded-session",
                must_change_password=False, revision=1, changed_at=clock[0]))
    for account in ("A", "B"):
        add_session(account)

    def context(account="A", *, method="POST", suffix=""):
        # 显式种入已认证会话，但仍经过真实 adapter 和上下文构造器，不替代登录验收。
        headers = {"cookie": "radio_local_session=isolated-cookie-" + account + suffix,
            "origin": "http://127.0.0.1:8811", "x-session-id": "SID-" + account + suffix,
            "x-csrf-token": "isolated-csrf-" + account + suffix}
        request = Request({"type": "http", "method": method, "scheme": "http", "server": ("127.0.0.1", 8811),
            "path": "/api/v1/planning-operations/test", "query_string": b"", "app": application,
            "client": ("127.0.0.1", 1), "headers": [(key.encode(), value.encode()) for key, value in headers.items()]})
        return local_context.create_local_business_context(request, adapter=adapter)

    e = SimpleNamespace(engine=engine, factory=factory, clock=clock, context=context, add_session=add_session)
    e.saved = tasks.save_task_input(task_request("bootstrap"), "T1", factory, audit_context=context())
    now = datetime.now(timezone.utc)
    with factory.begin() as session:
        session.add(PlanningJob(job_id="J1", request_id="seed-job", request_digest="0" * 64, task_id="T1",
            revision_id=e.saved["revision"], condition_version=e.saved["condition_version"], resource_revision="RES1",
            context="planning", parent_plan_id=None, adjustment=None, status="SUCCESS", progress=1, stage="隔离结果",
            error=None, created_at=now, updated_at=now))
    monkeypatch.setattr(plans, "_job_result", lambda payload, factory: {"input": e.saved["input"],
        "result": {"constructed": True}, "outcome": {"code": 0}, "source_changed": False})
    yield e
    engine.dispose()


def counts(e):
    with e.factory() as session:
        return tuple(session.scalar(select(func.count()).select_from(model)) for model in MODELS)


def operation(e, kind):
    if kind == "saveTask":
        payload = task_request("task-save", e.saved["revision"], name="修改名称")
        run = lambda owner: tasks.save_task_input(payload, "T1", e.factory, audit_context=owner)
        service, replay, base = tasks, "_replay", tasks._request_digest(payload)
    elif kind == "savePlan":
        payload = PlanningPlanSaveRequest.model_validate({"context": "planning", "task_id": "T1", "job_id": "J1",
            "expected_revision": e.saved["revision"], "request_id": "plan-save", "name": "隔离方案", "note": ""})
        run = lambda owner: plans.save_planning_plan(payload, e.factory, audit_context=owner)
        service, replay, base = plans, "_replay", plans._digest(payload)
    else:
        saved = operation(e, "savePlan").run(e.context())
        payload = PlanningPlanConfirmRequest.model_validate({"context": "planning", "task_id": "T1",
            "expected_revision": saved["revision"], "request_id": "plan-confirm"})
        run = lambda owner: plans.confirm_planning_plan(saved["plan_id"], payload, e.factory, audit_context=owner)
        service, replay, base = plans, "_confirmation_replay", plans._confirmation_digest(saved["plan_id"], payload)
    return SimpleNamespace(kind=kind, payload=payload, run=run, service=service, replay=replay, base=base)


def query(e, spec, owner):
    return operations.query_operation(operations.OperationQuery(context="planning", task_id="T1",
        kind=spec.kind, request_id=spec.payload.request_id), e.factory, audit_context=owner)


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_local_binding_replay_and_query_are_account_specific(env, kind):
    e, spec = env, operation(env, kind)
    owner = e.context()
    result = spec.run(owner)
    before = counts(e)
    assert spec.run(e.context()) == result and counts(e) == before
    with e.factory() as session:
        record = operations._record(session, kind, spec.payload.request_id)
        assert record.request_digest == owner.digest(spec.base, operation=ACTION[kind]) != spec.base
        proof = session.scalar(select(SystemAuditEvent).where(SystemAuditEvent.request_id == spec.payload.request_id))
        assert proof.actor["id"] == "ACC-A" and proof.action == ACTION[kind] and proof.module == "planning"
        assert proof.changes == {"ownerProofVersion": "local-owner-v1", "context": "planning", "task_id": "T1", "revision_id": record.revision_id}
    with pytest.raises((tasks.TaskInputError, plans.PlanningPlanError)) as error:
        spec.run(e.context("B"))
    assert error.value.code == 1204
    assert query(e, spec, e.context(method="GET"))["state"] == "SUCCEEDED"
    with pytest.raises(SystemManagementError) as error:
        query(e, spec, e.context("B", method="GET"))
    assert error.value.code == 1104 and counts(e) == before
    e.add_session("A", "-new")
    assert spec.run(e.context(suffix="-new")) == result


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_local_missing_or_fake_context_never_uses_legacy_digest(env, kind):
    spec = operation(env, kind)
    before = counts(env)
    for owner in (None, {"actor": "ACC-A"}):
        with pytest.raises(SystemManagementError):
            spec.run(owner)
    assert counts(env) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_nonlocal_keeps_legacy_digest_and_local_does_not_adopt_old_receipts(env, monkeypatch, kind):
    e, spec = env, operation(env, kind)
    monkeypatch.setenv("AUTH_MODE", "OFF")
    result = spec.run(None)
    with e.factory() as session:
        assert operations._record(session, kind, spec.payload.request_id).request_digest == spec.base
    assert spec.run(None) == result
    assert query(e, spec, None)["state"] == "SUCCEEDED"
    monkeypatch.setenv("AUTH_MODE", "INTEGRATION")
    assert spec.run(None) == result
    assert query(e, spec, None)["state"] == "SUCCEEDED"
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    before = counts(e)
    with pytest.raises((tasks.TaskInputError, plans.PlanningPlanError)):
        spec.run(e.context())
    with pytest.raises(SystemManagementError):
        query(e, spec, e.context(method="GET"))
    if kind != "saveTask":
        assert plans.get_planning_plan(result["plan_id"], "T1", e.factory)["plan_id"] == result["plan_id"]
    assert counts(e) == before


@pytest.mark.parametrize("kind,skip", [("saveTask", 0), ("saveTask", 1), ("savePlan", 0), ("savePlan", 1), ("confirm", 0)])
def test_every_fast_replay_path_checks_proof_without_duplicate_audit(env, monkeypatch, kind, skip):
    e, spec = env, operation(env, kind)
    expected = spec.run(e.context())
    original, calls = getattr(spec.service, spec.replay), []

    def replay(*args):
        calls.append(1)
        return None if len(calls) <= skip else original(*args)

    monkeypatch.setattr(spec.service, spec.replay, replay)
    before = counts(e)
    assert spec.run(e.context()) == expected and len(calls) == skip + 1 and counts(e) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
@pytest.mark.parametrize("expired", [False, True])
def test_integrity_winner_replay_rechecks_current_session_and_proof(env, monkeypatch, kind, expired):
    e, spec = env, operation(env, kind)
    expected = spec.run(e.context())
    original, calls = getattr(spec.service, spec.replay), []
    failure = IntegrityError("isolated concurrent winner", {}, RuntimeError("unique"))
    threshold = 2 if kind == "savePlan" else 1

    def replay(*args):
        calls.append(1)
        if len(calls) < threshold:
            return None
        if len(calls) == threshold:
            if expired:
                e.clock[0] += 2_000
            raise failure
        return original(*args)

    owner, before = e.context(), counts(e)
    monkeypatch.setattr(spec.service, spec.replay, replay)
    if expired:
        with pytest.raises(SystemManagementError) as error:
            spec.run(owner)
        assert error.value.code == 1102
    else:
        assert spec.run(owner) == expected
    assert counts(e) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_integrity_without_committed_winner_is_not_hidden(env, monkeypatch, kind):
    e, spec = env, operation(env, kind)
    original, calls = getattr(spec.service, spec.replay), []
    failure = IntegrityError("isolated business failure", {}, RuntimeError("not a winner"))
    threshold = 2 if kind == "savePlan" else 1

    def replay(*args):
        calls.append(1)
        if len(calls) == threshold:
            raise failure
        return original(*args)

    monkeypatch.setattr(spec.service, spec.replay, replay)
    before = counts(e)
    with pytest.raises(IntegrityError) as error:
        spec.run(e.context())
    assert error.value is failure and counts(e) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_integrity_recovery_rejects_body_bound_receipt_without_owner_proof(env, monkeypatch, kind):
    e, spec = env, operation(env, kind)
    owner = e.context()
    monkeypatch.setenv("AUTH_MODE", "OFF")
    spec.run(None)
    # 隔离库模拟不完整历史回执；即使摘要已绑定主体，也不能补认缺失的不可变证明。
    with e.factory.begin() as session:
        operations._record(session, kind, spec.payload.request_id).request_digest = owner.digest(spec.base, operation=ACTION[kind])
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    original, calls = getattr(spec.service, spec.replay), []
    threshold = 2 if kind == "savePlan" else 1

    def replay(*args):
        calls.append(1)
        if len(calls) < threshold:
            return None
        if len(calls) == threshold:
            raise IntegrityError("isolated incomplete winner", {}, RuntimeError("missing proof"))
        return original(*args)

    monkeypatch.setattr(spec.service, spec.replay, replay)
    before = counts(e)
    with pytest.raises(SystemManagementError) as error:
        spec.run(owner)
    assert error.value.code == 1104 and counts(e) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
@pytest.mark.parametrize("integrity", [False, True])
def test_audit_failure_after_insert_rolls_back_business_receipt_and_audit(env, monkeypatch, kind, integrity):
    e, spec = env, operation(env, kind)
    original = local_context.append_business_audit
    failure = IntegrityError("isolated audit constraint", {}, RuntimeError("audit")) if integrity else SQLAlchemyError("isolated audit failure")

    def append(*args, **kwargs):
        original(*args, **kwargs)
        raise failure

    monkeypatch.setattr(local_context, "append_business_audit", append)
    before = counts(e)
    with pytest.raises(SystemManagementError) as error:
        spec.run(e.context())
    assert error.value.code == 5002 and error.value.__cause__ is failure and counts(e) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_read_context_cannot_replay_write_even_with_matching_owner(env, kind):
    e, spec = env, operation(env, kind)
    spec.run(e.context())
    before = counts(e)
    with pytest.raises(SystemManagementError) as error:
        spec.run(e.context(method="GET"))
    assert error.value.code == 1105 and counts(e) == before


@pytest.mark.parametrize("field", ["context", "task_id", "revision_id"])
def test_query_and_replay_reject_mismatched_frozen_proof_metadata(env, monkeypatch, field):
    e, spec = env, operation(env, "saveTask")
    original = local_context.LocalBusinessContext.append_owner

    def append(self, session, prepared, **kwargs):
        kwargs["changes"] = {**kwargs["changes"], field: "wrong"}
        return original(self, session, prepared, **kwargs)

    monkeypatch.setattr(local_context.LocalBusinessContext, "append_owner", append)
    spec.run(e.context())
    before = counts(e)
    for call in (lambda: query(e, spec, e.context(method="GET")), lambda: spec.run(e.context())):
        with pytest.raises(SystemManagementError) as error:
            call()
        assert error.value.code == 1204
    assert counts(e) == before


def test_unchanged_task_and_already_current_confirmation_still_get_atomic_proofs(env):
    e = env
    revision = e.saved["revision"]
    result = tasks.save_task_input(task_request("unchanged", revision), "T1", e.factory, audit_context=e.context())
    assert result["revision"] == revision
    confirmation = operation(e, "confirm")
    result = confirmation.run(e.context())
    payload = confirmation.payload.model_copy(update={"request_id": "confirm-unchanged"})
    plans.confirm_planning_plan(result["plan_id"], payload, e.factory, audit_context=e.context())
    with e.factory() as session:
        for request_id in ("unchanged", "confirm-unchanged"):
            assert session.scalar(select(SystemAuditEvent.outcome).where(SystemAuditEvent.request_id == request_id)) == "UNCHANGED"
        assert session.get(PlanningPlanConfirmation, "confirm-unchanged") is not None


def test_gis_task_proof_uses_frozen_context_and_replays_without_new_audit(env):
    e = env
    payload = task_request("gis-save", context="gis").model_copy(update={"task_id": "T-GIS"})
    expected = tasks.save_task_input(payload, "T-GIS", e.factory, audit_context=e.context())
    before = counts(e)
    assert tasks.save_task_input(payload, "T-GIS", e.factory, audit_context=e.context()) == expected
    result = operations.query_operation(operations.OperationQuery(context="gis", task_id="T-GIS",
        kind="saveTask", request_id=payload.request_id), e.factory, audit_context=e.context(method="GET"))
    assert result["state"] == "SUCCEEDED" and result["entity_id"] == "T-GIS" and counts(e) == before
    with e.factory() as session:
        proof = session.scalar(select(SystemAuditEvent).where(SystemAuditEvent.request_id == payload.request_id))
        assert proof.changes["context"] == "gis" and proof.changes["revision_id"] == expected["revision"]


def test_noop_cross_context_cannot_issue_inconsistent_owner_proof(env):
    e = env
    before = counts(e)
    with pytest.raises(tasks.TaskInputError) as error:
        tasks.save_task_input(task_request("wrong-context", e.saved["revision"], context="gis"),
            "T1", e.factory, audit_context=e.context())
    assert error.value.code == 1204 and counts(e) == before


@pytest.mark.parametrize("kind", ["submit", "cancel"])
def test_job_owner_proof_contract_is_consumed_without_changing_jobservice(env, kind):
    e, owner = env, env.context()
    request_id = "seed-job" if kind == "submit" else "seed-cancel"
    with e.factory.begin() as session:
        prepared = owner.prepare(session, "planning.execute")
        if kind == "cancel":
            session.add(PlanningJobCancellation(request_id=request_id, request_digest="1" * 64, job_id="J1",
                task_id="T1", revision_id=e.saved["revision"], outcome_status="SUCCESS", created_at=datetime.now(timezone.utc)))
        owner.append_owner(session, prepared, operation=ACTION[kind], request_id=request_id, object_id="J1",
            changes={"context": "planning", "task_id": "T1", "revision_id": e.saved["revision"]})
    spec = SimpleNamespace(kind=kind, payload=SimpleNamespace(request_id=request_id))
    assert query(e, spec, e.context(method="GET"))["entity_id"] == "J1"
    with pytest.raises(SystemManagementError):
        query(e, spec, e.context("B", method="GET"))


def test_archived_proof_remains_visible_to_owner_query_without_new_audit(env):
    e, spec = env, operation(env, "saveTask")
    spec.run(e.context())
    with e.factory.begin() as session:
        through = session.scalar(select(func.max(SystemAuditEvent.sequence)))
        session.add(SystemAuditArchive(id="ARCH-TEST", through_sequence=through, actor_id="ACC-A", time=e.clock[0], reason="仅归档视图"))
    before = counts(e)
    assert query(e, spec, e.context(method="GET"))["state"] == "SUCCEEDED" and counts(e) == before


def test_not_found_query_still_checks_context_and_live_session(env):
    e = env
    spec = SimpleNamespace(kind="saveTask", payload=SimpleNamespace(request_id="never-written"))
    before = counts(e)
    with pytest.raises(SystemManagementError):
        query(e, spec, None)
    assert query(e, spec, e.context(method="GET"))["state"] == "NOT_FOUND"
    owner = e.context(method="GET")
    e.clock[0] += 2_000
    with pytest.raises(SystemManagementError) as error:
        query(e, spec, owner)
    assert error.value.code == 1102 and counts(e) == before


def test_orphan_and_duplicate_owner_proofs_fail_closed(env):
    e, spec = env, operation(env, "saveTask")
    spec.run(e.context())
    owner = e.context()
    with e.factory.begin() as session:
        for request_id in ("orphan-proof", spec.payload.request_id):
            prepared = owner.prepare(session, "planning.execute")
            owner.append_owner(session, prepared, operation="task.save", request_id=request_id, object_id="T1",
                changes={"context": "planning", "task_id": "T1", "revision_id": e.saved["revision"]})
    before = counts(e)
    orphan = SimpleNamespace(kind="saveTask", payload=SimpleNamespace(request_id="orphan-proof"))
    with pytest.raises(operations.OperationError) as error:
        query(e, orphan, e.context(method="GET"))
    assert error.value.code == 5002
    for call in (lambda: query(e, spec, e.context(method="GET")), lambda: spec.run(e.context())):
        with pytest.raises(SystemManagementError) as error:
            call()
        assert error.value.code == 5002
    assert counts(e) == before


@pytest.mark.parametrize("kind", ["saveTask", "savePlan", "confirm"])
def test_real_revocation_before_fast_replay_is_rejected(env, kind):
    e, spec = env, operation(env, kind)
    spec.run(e.context())
    owner = e.context()
    with e.factory.begin() as session:
        session.get(LocalIdentitySession, sha256(b"isolated-cookie-A").hexdigest()).revoked = True
    before = counts(e)
    with pytest.raises(SystemManagementError) as error:
        spec.run(owner)
    assert error.value.code == 1102 and counts(e) == before
