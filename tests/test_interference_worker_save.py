"""LOCAL后台采纳保存：真实隔离身份/小样本算法，不代表生产库或浏览器验收。"""
from contextlib import contextmanager
from copy import deepcopy
import os
import secrets
import time
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, event, func, select
from sqlalchemy.exc import SQLAlchemyError

from test_interference_adoption import _native_dispatch_case, _native_runtime
from test_interference_analysis_engine import frozen_sample
from test_interference_workbench_api import scene_api
from app import planning_job_service as jobs, planning_plan_service as plans
from app import system_audit_service as audit
from app.interference_analysis_engine import AnalysisInputError, digest
from app.interference_replan_service import FrozenPlanningReplanner
from app.interference_workbench_models import (
    InterferenceWorkbenchAdoption as Adoption, InterferenceWorkbenchOperation as Operation,
    InterferenceWorkbenchRun as Run,
)
from app.interference_workbench_schemas import AdoptionSubmit
from app.interference_workbench_service import InterferenceWorkbenchService, WorkbenchError
from app.local_identity_models import LocalIdentitySession
from app.local_identity_router import create_local_identity_router
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import LocalIdentityAdapter, LocalIdentityService
from app.local_password_service import hash_password
from app.permission_registry import SERVER_PERMISSION_REGISTRY
from app.planning_job_models import PlanningJob
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan
from app.planning_plan_schemas import PlanningPlanSaveRequest
from app.system_management_models import (
    LocalAccount, LocalCredential, LocalRole, SystemAuditEvent, SystemState,
)
from app.system_management_schemas import SystemManagementError
from app.system_management_service import SystemManagementService
from app.task_input_models import PlanningTask, PlanningTaskRevision


ACCOUNT = "integration-planner"  # 兼容既有UNIT helper；此处实际建LOCAL账号并真密码登录。
ROLE = "ROLE-LOCAL-WORKER-SAVE"
PERMISSIONS = {"planning.view", "situation.view", "planning.execute", "planning.save"}
ORIGIN = "http://127.0.0.1:8819"  # TestClient ASGI内存调用，不启动socket。
MODELS = (PlanningTask, PlanningTaskRevision, PlanningJob, PlanningPlan, PlanningCurrentPlan,
          Run, Adoption, Operation, LocalAccount, LocalRole, SystemAuditEvent)


def snapshot(factory):
    with factory() as session:
        return {model.__tablename__: [
            {column.name: deepcopy(getattr(row, column.name)) for column in model.__table__.columns}
            for row in session.scalars(select(model).order_by(*model.__table__.primary_key.columns))
        ] for model in MODELS}


@contextmanager
def no_writes(case):
    before, writes = snapshot(case.factory), []
    engine = case.factory.kw["bind"]

    def inspect_sql(conn, cursor, statement, parameters, context, executemany):
        verb = statement.lstrip().split(None, 1)[0].upper()
        if verb in {"INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER"}:
            writes.append(verb)

    event.listen(engine, "before_cursor_execute", inspect_sql)
    try:
        yield
    finally:
        event.remove(engine, "before_cursor_execute", inspect_sql)
        assert writes == [], "拒绝/重放不得产生附带数据库写入"
        assert snapshot(case.factory) == before


@pytest.fixture
def local_api(scene_api, monkeypatch):
    """保留旧fixture的tmp库/资源种子；只给本测试应用安装真实LOCAL认证。"""
    client, factory, _, _, _ = scene_api
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    password = secrets.token_urlsafe(32)
    with factory.begin() as session:
        session.add(SystemState(id=1, initialized=True, revision=1, epoch="local-worker-save-test"))
        session.add(LocalRole(id=ROLE, name="后台保存隔离角色", description="显式测试种子", permissions=sorted(PERMISSIONS)))
        session.flush()
        session.add(LocalAccount(id=ACCOUNT, username="worker_local", name="真实LOCAL测试主体",
            department="隔离验证", role_id=ROLE, enabled=True, identity_revision=1, last_login=None))
        session.flush()
        session.add(LocalCredential(account_id=ACCOUNT, password_hash=hash_password(password),
            must_change_password=False, revision=1, changed_at=int(time.time())))
    system = SystemManagementService(session_factory=factory, permission_registry=SERVER_PERMISSION_REGISTRY,
        request_key=secrets.token_bytes(32))
    identity = LocalIdentityService(system_service=system, settings=LocalIdentitySettings(
        allowed_origins=frozenset({ORIGIN}), allow_insecure_loopback=True))
    # 去掉fixture自身的DEMO auth路由，避免同路径先匹配旧csrf；不改生产router。
    client.app.router.routes[:] = [route for route in client.app.router.routes
                                  if not getattr(route, "path", "").startswith("/api/v1/auth/")]
    client.app.include_router(create_local_identity_router(service=identity))
    client.app.state.local_identity_adapter = LocalIdentityAdapter(service=identity)
    client.app.state.auth_mode = "LOCAL_PASSWORD"
    client.base_url = ORIGIN
    client.headers["Origin"] = ORIGIN
    challenge = client.get("/api/v1/auth/csrf").json()["data"]
    response = client.post("/api/v1/auth/login", json={"username": "worker_local", "password": password},
        headers={"X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
    assert response.status_code == 200 and response.json()["code"] == 0
    actor = response.json()["data"]
    assert actor["account_id"] == ACCOUNT and actor["integration_mode"] is False
    assert actor["data_origin"] == "FORMAL_VERIFIED"
    return SimpleNamespace(scene_api=scene_api, factory=factory, actor=actor)


@pytest.fixture
def worker_case(local_api, _native_runtime, frozen_sample, monkeypatch, request):
    """复用真实W3/W4两节点样本；Run/措施/受理回执为显式UNIT构造材料。"""
    mode = getattr(request, "param", "valid")
    factory = local_api.factory
    real_submit = jobs.submit_interference_replan
    accepted = []

    def submit(payload, *args, **kwargs):
        # 仅在既有helper的正确调用前补受理原件，原来的三个非法反例仍走真实拒绝。
        if (not accepted and payload["actor_id"] == ACCOUNT and payload["task_id"] == "T1"
                and payload["change_set"]["type"] == "FREQ_ADJUST"):
            with factory.begin() as session:
                row = session.get(Adoption, payload["adoption_id"])
                run = session.get(Run, row.run_id)
                scene = run.source_snapshot["scene"]
                body = AdoptionSubmit(request_id="LOCAL-ACCEPT-UNIT", task_id=row.task_id,
                    run_id=row.run_id, measure_id=row.measure_id, expected_run_version=run.run_version,
                    plan_id=run.plan_id, plan_version=scene["plan_version"], resource_revision=run.resource_revision,
                    scene_version_id=run.scene_version_id, snapshot_hash=scene["snapshot_hash"])
                service = InterferenceWorkbenchService(factory)

                def receipt(value, changed=True):
                    fingerprint = digest({"operation": "ADOPT_MEASURE", "actor": ACCOUNT, "body": value.model_dump()})
                    return service._receipt(session, value, "ADOPT_MEASURE", local_api.actor, row, fingerprint, changed,
                        {"adoption_id": row.adoption_id, "planning_request_id": row.planning_request_id,
                         "planning_job_id": None, "plan_id": None})

                if mode != "missing":
                    original = receipt(body, changed=mode != "unchanged")
                    operation = next(item for item in session.new if isinstance(item, Operation))
                    if mode == "bad-hash":
                        operation.receipt_hash = "0" * 64
                    elif mode == "wrong-object-type":
                        operation.object_type = "RUN"
                        operation.receipt = {**original, "object_type": "RUN"}
                        operation.receipt_hash = digest(operation.receipt)
                    elif mode == "wrong-status":
                        operation.receipt = {**original, "status": "SUCCEEDED"}
                        operation.receipt_hash = digest(operation.receipt)
                    if mode == "duplicate":
                        receipt(body.model_copy(update={"request_id": "LOCAL-ACCEPT-DUPLICATE"}))
                accepted.append(body.request_id)
        return real_submit(payload, *args, **kwargs)

    monkeypatch.setattr(jobs, "submit_interference_replan", submit)
    job_module, _, proof, parent_raw, resource, engine = _native_dispatch_case(
        local_api.scene_api, frozen_sample, monkeypatch, "FREQ_ADJUST", accepted_receipt=False)
    assert accepted == ["LOCAL-ACCEPT-UNIT"]
    assert os.environ["AUTH_MODE"] == "LOCAL_PASSWORD" and os.environ["FRONTEND_INTEGRATION_DEMO"] == "0"
    result = job_module.query_planning_job(proof["planning_job_id"], "T1", factory)["data"]
    assert result["status"] == "SUCCESS" and result["saved_plan_id"] is None
    assert result["outcome"]["code"] == 3001 and result["outcome"]["gap"]
    payload = PlanningPlanSaveRequest(context="planning", request_id="interference-save-" + proof["adoption_id"],
        task_id="T1", expected_revision="REV-P1", job_id=proof["planning_job_id"],
        name="干扰措施重算 FREQ_ADJUST", note="冻结场景算法预测；非实测。来源采纳：" + proof["adoption_id"])
    return SimpleNamespace(factory=factory, proof=proof, payload=payload, runtime=_native_runtime,
        job=result, parent_raw=parent_raw, resource=resource, engine=engine, receipt_mode=mode)


def save(case, *, payload=None, proof=None, runtime=None):
    assert os.environ["AUTH_MODE"] == "LOCAL_PASSWORD"
    return plans.save_planning_plan(payload if payload is not None else case.payload, case.factory,
        _interference_request=proof if proof is not None else deepcopy(case.proof),
        _runtime_root=runtime if runtime is not None else case.runtime)


def worker_audits(case):
    with case.factory() as session:
        return list(session.scalars(select(SystemAuditEvent).where(
            SystemAuditEvent.action == "interference.plan.save").order_by(SystemAuditEvent.sequence)))


def assert_saved(case, plan):
    assert plan["state"] == "REFERENCE" and plan["current"] is False
    assert plan["result"] == case.job["result"] and plan["outcome"] == case.job["outcome"]
    assert plan["outcome"]["code"] == 3001 and plan["outcome"]["gap"]
    rows = worker_audits(case)
    assert len(rows) == 1
    audit_row = rows[0]
    assert audit_row.module == "interference" and audit_row.outcome == "SUCCESS" and not audit_row.error_code
    assert audit_row.object_id == plan["plan_id"] and audit_row.request_id == case.payload.request_id
    assert audit_row.changes == {"adoption_id": case.proof["adoption_id"], "run_id": case.proof["interference_origin"]["run_id"],
        "accepted_request_id": "LOCAL-ACCEPT-UNIT", "job_id": case.payload.job_id, "parent_plan_id": "P1",
        "task_id": "T1", "revision_id": "REV-P1"}
    with case.factory() as session:
        account, role = session.get(LocalAccount, ACCOUNT), session.get(LocalRole, ROLE)
        assert audit_row.actor == {"id": account.id, "name": account.name, "roleId": role.id, "roleName": role.name}
        assert session.scalar(select(func.count()).select_from(PlanningPlan).where(PlanningPlan.job_id == case.payload.job_id)) == 1
        assert session.get(PlanningPlan, plan["plan_id"]).confirmed_at is None
        assert session.get(PlanningCurrentPlan, "T1").plan_id == "P1"
        assert session.get(PlanningPlan, "P1").raw_snapshot == case.parent_raw
        assert session.scalar(select(func.count()).select_from(SystemAuditEvent).where(
            SystemAuditEvent.action == "plan.save", SystemAuditEvent.object_id == plan["plan_id"])) == 0
    assert "ownerProofVersion" not in audit_row.changes


def test_local_plain_save_still_requires_context(worker_case):
    case = worker_case
    with no_writes(case), pytest.raises(SystemManagementError, match="缺少可信业务上下文") as rejected:
        plans.save_planning_plan(case.payload, case.factory)
    assert (rejected.value.code, rejected.value.status) == (5001, 503)


@pytest.mark.parametrize("field", ["source", "actor", "task", "job", "planning-request", "measure", "change", "origin"])
def test_worker_save_rejects_unbound_request_without_writes(worker_case, field):
    case, proof = worker_case, deepcopy(worker_case.proof)
    if field == "source":
        proof["source"]["scene"]["plan_snapshot"]["plan_id"] = "FOREIGN-PARENT"
    elif field == "actor":
        proof["actor_id"] = "FOREIGN-ACTOR"
    elif field == "task":
        proof["task_id"] = "FOREIGN-TASK"
    elif field == "job":
        proof["planning_job_id"] = "FOREIGN-JOB"
    elif field == "planning-request":
        proof["planning_request_id"] = "FOREIGN-REQUEST"
    elif field == "measure":
        proof["measure"]["measure_id"] = "FOREIGN-MEASURE"
    elif field == "change":
        proof["change_set"]["detail"]["to_freq_khz"] += 1
    else:
        proof["interference_origin"]["actor_id"] = "FOREIGN-ACTOR"
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        save(case, proof=proof)
    assert (rejected.value.code, rejected.value.status) == (1203, 409)


@pytest.mark.parametrize("field,value", [("request_id", "OTHER-SAVE"), ("task_id", "OTHER-TASK"),
    ("job_id", "OTHER-JOB"), ("expected_revision", "OTHER-REV"), ("name", "OTHER-NAME")])
def test_worker_save_requires_fixed_payload(worker_case, field, value):
    case = worker_case
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        save(case, payload=case.payload.model_copy(update={field: value}))
    assert (rejected.value.code, rejected.value.status) == (1203, 409)


@pytest.mark.parametrize("where", ["outside-r2", "other-r2-subtree"])
def test_worker_save_rejects_wrong_runtime(worker_case, tmp_path, where):
    case = worker_case
    runtime = tmp_path / "outside" if where == "outside-r2" else case.runtime / "other"
    expected = AnalysisInputError if where == "outside-r2" else jobs.PlanningJobError
    with no_writes(case), pytest.raises(expected) as rejected:
        save(case, runtime=runtime)
    if where == "other-r2-subtree":
        assert (rejected.value.code, rejected.value.status) == (5001, 503)


@pytest.mark.parametrize("worker_case", ["missing", "unchanged", "bad-hash", "duplicate", "wrong-object-type", "wrong-status"], indirect=True)
def test_worker_save_requires_one_valid_original_receipt(worker_case):
    case = worker_case
    with no_writes(case), pytest.raises((plans.PlanningPlanError, WorkbenchError)) as rejected:
        save(case)
    expected = (5002, 503) if case.receipt_mode == "bad-hash" else (1203, 409)
    assert (rejected.value.code, rejected.value.status) == expected


@pytest.mark.parametrize("unavailable", ["missing-account", "disabled", "planning.view", "situation.view", "planning.execute", "planning.save"])
def test_worker_save_requires_current_real_local_account(worker_case, unavailable):
    case = worker_case
    with case.factory.begin() as session:
        if unavailable == "missing-account":
            session.execute(delete(LocalIdentitySession).where(LocalIdentitySession.account_id == ACCOUNT))
            session.execute(delete(LocalCredential).where(LocalCredential.account_id == ACCOUNT))
            session.delete(session.get(LocalAccount, ACCOUNT))
        elif unavailable == "disabled":
            session.get(LocalAccount, ACCOUNT).enabled = False
        else:
            session.get(LocalRole, ROLE).permissions = sorted(PERMISSIONS - {unavailable})
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        save(case)
    assert (rejected.value.code, rejected.value.status) == (1104, 403)


def test_worker_save_never_revives_failed_adoption(worker_case):
    case = worker_case
    with case.factory.begin() as session:
        row = session.get(Adoption, case.proof["adoption_id"])
        row.state, row.error = "FAILED", "UNIT既有终态，不可重置"
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        save(case)
    assert (rejected.value.code, rejected.value.status) == (1203, 409)


def test_worker_local_reference_saved_and_audited_once(worker_case):
    case = worker_case
    plan = save(case)
    assert_saved(case, plan)
    with no_writes(case):
        assert save(case) == plan
    assert_saved(case, plan)


def test_worker_replay_revalidates_request_and_permissions(worker_case):
    case = worker_case
    plan = save(case)
    bad = deepcopy(case.proof)
    bad["actor_id"] = "FOREIGN-ACTOR"
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        save(case, proof=bad)
    assert rejected.value.code == 1203
    with case.factory.begin() as session:
        session.get(LocalRole, ROLE).permissions = sorted(PERMISSIONS - {"planning.save"})
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        save(case)
    assert (rejected.value.code, rejected.value.status) == (1104, 403)
    with case.factory.begin() as session:
        session.get(LocalRole, ROLE).permissions = sorted(PERMISSIONS)
    assert_saved(case, plan)


def test_worker_write_transaction_rechecks_revoked_permission(worker_case, monkeypatch):
    case = worker_case
    real_result = plans._job_result

    def revoke_between_transactions(*args, **kwargs):
        result = real_result(*args, **kwargs)
        with case.factory.begin() as session:
            session.get(LocalRole, ROLE).permissions = sorted(PERMISSIONS - {"planning.save"})
        return result

    monkeypatch.setattr(plans, "_job_result", revoke_between_transactions)
    before_plans = snapshot(case.factory)[PlanningPlan.__tablename__]
    with pytest.raises(plans.PlanningPlanError) as rejected:
        save(case)
    assert (rejected.value.code, rejected.value.status) == (1104, 403)
    assert snapshot(case.factory)[PlanningPlan.__tablename__] == before_plans
    assert worker_audits(case) == []


def test_worker_audit_failure_rolls_back_plan_and_allows_same_request(worker_case, monkeypatch):
    case = worker_case
    real_append = audit.append_system_audit

    def fail_after_insert(*args, **kwargs):
        real_append(*args, **kwargs)
        raise SQLAlchemyError("UNIT审计插入后故障")

    before = snapshot(case.factory)
    with monkeypatch.context() as patch:
        patch.setattr(audit, "append_system_audit", fail_after_insert)
        with pytest.raises(SQLAlchemyError, match="UNIT审计插入后故障"):
            save(case)
    assert snapshot(case.factory) == before
    assert_saved(case, save(case))


def test_bridge_saved_replay_cannot_bypass_local_authorization(worker_case):
    case = worker_case
    bridge = FrozenPlanningReplanner(case.factory, runtime_root=case.runtime)
    original = bridge.poll(deepcopy(case.proof))
    assert original["state"] == "SUCCESS"
    with case.factory.begin() as session:
        session.get(LocalAccount, ACCOUNT).enabled = False
    with no_writes(case), pytest.raises(plans.PlanningPlanError) as rejected:
        bridge.poll(deepcopy(case.proof))
    assert (rejected.value.code, rejected.value.status) == (1104, 403)


def test_large_worker_snapshot_reads_resource_in_same_transaction(worker_case, monkeypatch):
    """构造存储填充触发真实SQLite spill；不冒称完整DEM或性能测试。"""
    import sqlite3
    case = worker_case
    engine = case.factory.kw["bind"]
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA journal_mode=DELETE").scalar().lower() == "delete"
        connection.commit()

    def small_cache(dbapi, record, proxy):
        cursor = dbapi.cursor()
        cursor.execute("PRAGMA cache_size=8")
        cursor.execute("PRAGMA cache_spill=ON")
        cursor.close()

    inserted, resource_reads, blocked = [], [], []
    def trace(connection, cursor, statement, parameters, context, executemany):
        sql = statement.lower().lstrip()
        if sql.startswith("insert into planning_plans"):
            inserted.append(connection)
            # 写事务尚未提交时，独立只读连接确实被排他锁阻断。
            other = sqlite3.connect("file:" + str(engine.url.database) + "?mode=ro", uri=True, timeout=.05)
            try:
                try:
                    other.execute("select revision from resource_dataset_current limit 1").fetchone()
                except sqlite3.OperationalError as error:
                    assert "locked" in str(error).lower()
                    blocked.append(True)
            finally:
                other.close()
        if inserted and sql.startswith("select") and "resource_dataset_" in sql:
            resource_reads.append(connection)

    real_capture = plans.planning_adjustment_service.capture_raw_snapshot
    real_revision = plans.frontend_integration.resource_revision
    def capture(result):
        raw = deepcopy(real_capture(result))
        raw["unit_storage_padding"] = "x" * (3 * 1024 * 1024)
        return raw
    def revision():
        assert not inserted, "持大快照写锁时不能经全局工厂另开连接读取资源"
        return real_revision()

    event.listen(engine, "checkout", small_cache)
    event.listen(engine, "after_cursor_execute", trace)
    try:
        monkeypatch.setattr(plans.planning_adjustment_service, "capture_raw_snapshot", capture)
        monkeypatch.setattr(plans.frontend_integration, "resource_revision", revision)
        saved = save(case)
    finally:
        event.remove(engine, "after_cursor_execute", trace)
        event.remove(engine, "checkout", small_cache)
    assert blocked == [True] and len(inserted) == 1
    assert resource_reads and all(connection is inserted[0] for connection in resource_reads)
    assert saved["source_changed"] is False
    assert_saved(case, saved)


@pytest.mark.parametrize("fault", ["missing-pointer", "bad-hash"])
def test_worker_dto_rejects_broken_current_resource_without_partial_save(worker_case, fault):
    from app import resource_dataset_service as datasets
    from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
    case = worker_case
    with case.factory.begin() as session:
        pointer = session.get(ResourceDatasetCurrent, datasets.SCOPE)
        original = session.get(ResourceDatasetVersion, pointer.revision)
        bad_id = "resource-0000000000000000"
        if fault == "missing-pointer":
            # 保留外键门禁；只在隔离夹具移除当前指针，不制造非法悬挂外键。
            session.delete(pointer)
        else:
            session.add(ResourceDatasetVersion(revision=bad_id, content_hash="0" * 64,
                source=original.source, data_origin=original.data_origin, snapshot=deepcopy(original.snapshot),
                created_at=original.created_at))
            session.flush()
            pointer.revision = bad_id
    before = snapshot(case.factory)
    with pytest.raises(datasets.ResourceDatasetError):
        save(case)
    assert snapshot(case.factory) == before
    assert worker_audits(case) == []
