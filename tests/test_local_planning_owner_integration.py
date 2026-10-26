"""五类 LOCAL 回执联动；资源/worker 为构造材料，不运行 SR4 或验收 DEM。"""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import secrets
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import database, frontend_integration, local_business_context
from app import planning_job_service as jobs, planning_operation_service as operations
from app import planning_plan_service as plans, resource_dataset_service, task_input_service as tasks
from app.database import Base
from app.local_identity_router import create_local_identity_router
from app.local_identity_schemas import LocalIdentitySettings
from app.local_identity_service import LocalIdentityAdapter, LocalIdentityService, SESSION_COOKIE
from app.local_password_service import hash_password
from app.permission_registry import SERVER_PERMISSION_REGISTRY
from app.planning_job_models import PlanningJob, PlanningJobCancellation
from app.planning_job_schemas import PlanningJobCancelRequest, PlanningJobSubmitRequest
from app.planning_plan_models import PlanningCurrentPlan, PlanningPlan, PlanningPlanConfirmation
from app.planning_plan_schemas import PlanningPlanConfirmRequest, PlanningPlanSaveRequest
from app.system_audit_service import IMMUTABLE_SQLITE_DDL
from app.system_management_models import LocalAccount, LocalCredential, LocalRole, SystemAuditEvent, SystemState
from app.system_management_schemas import SystemManagementError
from app.system_management_service import SystemManagementService
from app.task_input_models import PlanningOperationReceipt, PlanningTask, PlanningTaskRevision
from app.task_input_schemas import TaskSaveRequest


PERMISSIONS = {"planning.view", "planning.execute", "planning.save", "planning.confirm"}
ACTIONS = {"saveTask": "task.save", "submit": "planning.submit", "cancel": "planning.cancel",
           "savePlan": "plan.save", "confirm": "plan.confirm"}
MODELS = (PlanningTask, PlanningTaskRevision, PlanningOperationReceipt, PlanningJob,
          PlanningJobCancellation, PlanningPlan, PlanningPlanConfirmation, PlanningCurrentPlan, SystemAuditEvent)


def task_request():
    return TaskSaveRequest.model_validate({"context": "planning", "task_id": "OWNER-TASK",
        "expected_revision": None, "resource_revision": "OWNER-RES", "request_id": "owner-task-save",
        "input": {"name": "构造任务", "description": "五类回执联动", "bbox": [113, 36, 116, 39],
            "stationIds": ["N1", "N2"], "presetId": "balanced", "frequencyId": "F1",
            "startTime": None, "durationH": None,
            "constraints": {"connectivityPercent": 100, "maxRelayHops": 2, "survivabilityPercent": 90},
            "demands": [{"id": "COMM1", "sourceId": "N1", "targetId": "N2", "endpointMode": "station",
                "service": "数据", "priority": "P1", "mandatory": True, "dataVolumeMb": 10,
                "requiredRateKbps": 64, "maxDelayMs": 100, "minReliability": 0.95}]}})


def raw_worker_plan(solution_id):
    return {"solution_id": solution_id, "summary": {"objectives": {"e2e_connectivity": 1, "survivability": 1}},
        "detail": {"nodes": [{"node_id": node, "lon": 114 + index * 0.1, "lat": 37}
                              for index, node in enumerate(("N1", "N2"))],
            "links": [{"link_id": "L1", "node_a_id": "N1", "node_b_id": "N2", "device_class": "HF",
                       "device_a_id": "D1", "device_b_id": "D2", "is_available": True, "link_state": "GOOD"}],
            "routes": {"routes": [{"demand_id": "COMM1", "reachable": True,
                "primary": {"node_path": ["N1", "N2"], "link_path": ["L1"]}}]},
            "frequency": {"link_assignments": [{"link_id": "L1", "freq_khz": 7000}], "conflicts": []},
            "optimization": {"best": {"constraint_check": {key: {"pass": True, "value": 1, "required": 1}
                for key in ("mandatory_e2e_connectivity", "survivability", "max_relay_hops")}}},
            "check": {"issues": []}}}


@pytest.fixture
def env(tmp_path, monkeypatch):
    assert tmp_path.resolve().is_relative_to((ROOT / "data/runtime/tmp").resolve())
    path = tmp_path / "local-planning-owner.sqlite"
    assert not path.exists(), "集成验证只使用新 GUID 下的新库"
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "0")
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    engine = create_engine("sqlite:///" + str(path))
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        for ddl in IMMUTABLE_SQLITE_DDL:
            connection.exec_driver_sql(ddl)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    for module in (database, tasks, jobs, plans, operations, resource_dataset_service):
        monkeypatch.setattr(module, "get_session_factory", lambda: factory)

    # 只隔离资源输入与算法执行/文件来源，保留真实 payload 校验、结果适配及全部业务事务。
    devices = [{"device_id": "D" + str(index), "node_id": node, "model_id": "M1",
                "tx_power_dbm": 30, "antenna_height_m": 2} for index, node in enumerate(("N1", "N2"), 1)]
    tables = {"comm_demand.csv": [], "device.csv": devices,
              "device_model.csv": [{"model_id": "M1", "model_name": "构造型号", "device_class": "HF"}]}
    monkeypatch.setattr(frontend_integration, "resource_revision", lambda: "OWNER-RES")
    monkeypatch.setattr(frontend_integration, "resource_object", lambda kind, object_id, revision: {"id": object_id})
    monkeypatch.setattr(frontend_integration, "planning_frequency_catalog", lambda: {"data": {"items": [{"id": "F1"}]}})
    monkeypatch.setattr(frontend_integration, "task_reference_catalog", lambda: {
        "node_ids": {"N1", "N2"}, "devices": {row["device_id"]: {**row, "availability": "ACTIVE"} for row in devices}})
    monkeypatch.setattr(jobs.planning_w4, "_load", lambda name: deepcopy(tables[name]))
    monkeypatch.setattr(plans.planning_adjustment_service, "terrain_fingerprint", lambda: None)
    records, callbacks, submissions, cancellations = {}, {}, [], []

    def submit_worker(payload, *, job_id, on_update):
        assert payload["task_id"] == "OWNER-TASK" and payload["demand_rows"][0]["demand_id"] == "COMM1"
        submissions.append(job_id)
        callbacks[job_id] = on_update
        records[job_id] = {"status": "PENDING", "progress": 0, "stage": "显式 worker 桩"}
        on_update(deepcopy(records[job_id]))
        return {"code": 0, "data": {"task_id": job_id}}

    def cancel_worker(job_id):
        cancellations.append(job_id)
        return deepcopy(records[job_id])

    def checkpoint(job_id, status):
        records[job_id].update(status=status, progress=1, stage="显式 worker 检查点")
        if status == "SUCCESS":
            records[job_id]["result"] = {"solution_id": "PL-OWNER-" + job_id}
        callbacks[job_id](deepcopy(records[job_id]))

    monkeypatch.setattr(jobs.planning_w4, "submit_sr4", submit_worker)
    monkeypatch.setattr(jobs.planning_w3, "get_task_record", lambda job_id: deepcopy(records.get(job_id)))
    monkeypatch.setattr(jobs.planning_w3, "cancel_task", cancel_worker)
    monkeypatch.setattr(jobs.planning_w4, "get_plan", lambda solution_id: {"code": 0, "data": raw_worker_plan(solution_id)})

    clock = 2_000_000_000
    system = SystemManagementService(session_factory=factory, permission_registry=SERVER_PERMISSION_REGISTRY,
        request_key=secrets.token_bytes(32), clock=lambda: clock)
    passwords = {account: secrets.token_urlsafe(32) for account in ("A", "B")}
    with factory.begin() as session:
        session.add(SystemState(id=1, initialized=True, revision=1, epoch="owner-integration"))
        session.add(LocalRole(id="OWNER-ROLE", name="构造同权限角色", description="非生产", permissions=sorted(PERMISSIONS)))
        session.flush()
        for account in passwords:
            session.add(LocalAccount(id="OWNER-" + account, username="owner-" + account.lower(), name="主体" + account,
                department="隔离验证", role_id="OWNER-ROLE", enabled=True, identity_revision=1))
        session.flush()
        for account, password in passwords.items():
            session.add(LocalCredential(account_id="OWNER-" + account, password_hash=hash_password(password),
                must_change_password=False, revision=1, changed_at=clock))
    origin = "http://127.0.0.23:8823"
    identity = LocalIdentityService(system_service=system, settings=LocalIdentitySettings(
        allowed_origins=frozenset({origin}), allow_insecure_loopback=True))
    application = FastAPI()
    application.include_router(create_local_identity_router(service=identity))
    adapter = LocalIdentityAdapter(service=identity)
    application.state.local_identity_adapter = adapter
    clients, headers = {}, {}
    for account, password in passwords.items():
        client = TestClient(application, base_url=origin)
        clients[account] = client
        challenge = client.get("/api/v1/auth/csrf").json()["data"]
        login = client.post("/api/v1/auth/login", json={"username": "owner-" + account.lower(), "password": password},
            headers={"Origin": origin, "X-CSRF-Token": challenge["csrf_token"], "X-Session-Id": ""})
        assert login.status_code == 200, login.text
        challenge = client.get("/api/v1/auth/csrf").json()["data"]
        headers[account] = {"origin": origin, "cookie": SESSION_COOKIE + "=" + client.cookies.get(SESSION_COOKIE),
            "x-session-id": challenge["session_id"], "x-csrf-token": challenge["csrf_token"]}

    def context(account="A", *, method="POST"):
        request = Request({"type": "http", "method": method, "scheme": "http", "server": ("127.0.0.23", 8823),
            "path": "/owner-integration", "query_string": b"", "client": ("testclient", 50000), "app": application,
            "headers": [(key.encode(), value.encode()) for key, value in headers[account].items()]})
        return local_business_context.create_local_business_context(request, adapter=adapter)

    try:
        yield SimpleNamespace(factory=factory, engine=engine, context=context, checkpoint=checkpoint,
            submissions=submissions, cancellations=cancellations)
    finally:
        for client in clients.values():
            client.close()
        engine.dispose()


def snapshot(env, *, ignore_job_poll_time=False):
    with env.factory() as session:
        rows = {model.__tablename__: [dict(row) for row in session.execute(select(model.__table__).order_by(
            *model.__table__.primary_key.columns)).mappings()] for model in MODELS}
    if ignore_job_poll_time:
        # 公共取消回放会真实轮询 worker，允许刷新时间，但不忽略作业状态或证明变化。
        for row in rows[PlanningJob.__tablename__]:
            row.pop("updated_at")
    return rows


def step(env, kind, payload, *, job_id=None, plan_id=None):
    def invoke(owner):
        if kind == "saveTask":
            return tasks.save_task_input(payload, payload.task_id, env.factory, audit_context=owner)
        if kind in ("submit", "cancel"):
            kwargs = {} if owner is None else {"actor_id": owner.actor.account_id, "local_owner": True, "audit_context": owner}
            return (jobs.submit_planning_job(payload, env.factory, **kwargs) if kind == "submit" else
                    jobs.cancel_planning_job(job_id, payload, env.factory, **kwargs))
        if kind == "savePlan":
            return plans.save_planning_plan(payload, env.factory, audit_context=owner)
        return plans.confirm_planning_plan(plan_id, payload, env.factory, audit_context=owner)
    return SimpleNamespace(kind=kind, payload=payload, invoke=invoke)


def query(env, operation, account="A"):
    return operations.query_operation(operations.OperationQuery(context="planning", task_id="OWNER-TASK",
        kind=operation.kind, request_id=operation.payload.request_id), env.factory,
        audit_context=env.context(account, method="GET"))


def assert_proof(env, operation):
    result = query(env, operation)
    assert result["state"] == "SUCCEEDED"
    with env.factory() as session:
        record = operations._record(session, operation.kind, operation.payload.request_id)
        proofs = session.scalars(select(SystemAuditEvent).where(SystemAuditEvent.module == "planning",
            SystemAuditEvent.request_id == operation.payload.request_id)).all()
        assert len(proofs) == 1
        proof = proofs[0]
        assert proof.actor["id"] == "OWNER-A" and proof.action == ACTIONS[operation.kind]
        assert proof.object_id == result["entity_id"] and proof.outcome in ("SUCCESS", "UNCHANGED")
        assert {key: proof.changes[key] for key in ("ownerProofVersion", "context", "task_id", "revision_id")} == {
            "ownerProofVersion": "local-owner-v1", "context": "planning", "task_id": "OWNER-TASK", "revision_id": record.revision_id}
        if operation.kind in ("submit", "cancel"):
            assert proof.changes["input_version"] == record.revision_id
            assert proof.changes["resource_revision"] == "OWNER-RES"
            assert proof.changes["job_status"] == "PENDING"
    return result


def build_chain(env, *, owner, stop_before=None):
    executed = []

    def execute(operation):
        result = operation.invoke(owner)
        executed.append((operation, result))
        return result

    save = step(env, "saveTask", task_request())
    if stop_before == "saveTask":
        return executed, save
    saved = execute(save)
    payload = PlanningJobSubmitRequest.model_validate({"context": "planning", "task_id": saved["task_id"],
        "request_id": "owner-submit", "expected_revision": saved["revision"], "input_version": saved["input_version"],
        "condition_version": saved["condition_version"], "resource_revision": saved["resource_revision"], "parent_plan_id": None})
    submit = step(env, "submit", payload)
    if stop_before == "submit":
        return executed, submit
    job = execute(submit)
    cancel = step(env, "cancel", PlanningJobCancelRequest(context="planning", task_id=saved["task_id"],
        expected_revision=saved["revision"], request_id="owner-cancel"), job_id=job["job_id"])
    if stop_before == "cancel":
        return executed, cancel
    execute(cancel)
    if owner is not None:
        # 受理可核实为成功，但取消证明不能冒充算法已停止。
        assert query(env, cancel)["state"] == "SUCCEEDED"
        with env.factory() as session:
            assert session.get(PlanningJobCancellation, "owner-cancel").outcome_status == "CANCEL_REQUESTED"
            assert session.get(PlanningJob, job["job_id"]).status == "PENDING"
    env.checkpoint(job["job_id"], "CANCELLED")
    successful = execute(step(env, "submit", payload.model_copy(update={"request_id": "owner-submit-result"})))
    env.checkpoint(successful["job_id"], "SUCCESS")
    save_plan = step(env, "savePlan", PlanningPlanSaveRequest(context="planning", task_id=saved["task_id"],
        job_id=successful["job_id"], expected_revision=saved["revision"], request_id="owner-plan-save", name="构造方案", note=""))
    if stop_before == "savePlan":
        return executed, save_plan
    plan = execute(save_plan)
    confirm = step(env, "confirm", PlanningPlanConfirmRequest(context="planning", task_id=saved["task_id"],
        expected_revision=plan["revision"], request_id="owner-confirm"), plan_id=plan["plan_id"])
    if stop_before == "confirm":
        return executed, confirm
    execute(confirm)
    return executed, None


def test_five_services_share_real_owner_proofs_and_query_contract(env):
    owner, peer = env.context(), env.context("B")
    assert owner.actor.permissions == peer.actor.permissions == frozenset(PERMISSIONS)
    executed, _ = build_chain(env, owner=owner)
    assert {operation.kind for operation, _ in executed} == set(ACTIONS)
    before, effects = snapshot(env, ignore_job_poll_time=True), (list(env.submissions), list(env.cancellations))
    for operation, original in executed:
        first = assert_proof(env, operation)
        replay = operation.invoke(env.context())
        entity_key = "job_id" if operation.kind in ("submit", "cancel") else "plan_id" if operation.kind in ("savePlan", "confirm") else "task_id"
        data = replay["data"] if operation.kind == "cancel" else replay
        original_data = original["data"] if operation.kind == "cancel" else original
        assert data[entity_key] == original_data[entity_key]
        assert query(env, operation) == first
        with pytest.raises((tasks.TaskInputError, jobs.PlanningJobError, plans.PlanningPlanError)) as foreign_write:
            operation.invoke(peer)
        assert (foreign_write.value.code, foreign_write.value.status) == (1204, 409)
        with pytest.raises(SystemManagementError) as foreign_query:
            query(env, operation, "B")
        assert (foreign_query.value.code, foreign_query.value.status) == (1104, 403)
    assert snapshot(env, ignore_job_poll_time=True) == before and (env.submissions, env.cancellations) == effects
    with env.factory() as session:
        current = session.get(PlanningCurrentPlan, "OWNER-TASK")
        assert current is not None and session.get(PlanningPlan, current.plan_id).state == "CONFIRMED"


def test_legacy_chain_without_proofs_is_not_adopted_by_local_receipt_queries(env, monkeypatch):
    with monkeypatch.context() as legacy:
        legacy.setenv("AUTH_MODE", "OFF")
        executed, _ = build_chain(env, owner=None)
    before, effects = snapshot(env), (list(env.submissions), list(env.cancellations))
    for operation, _ in executed:
        with pytest.raises(SystemManagementError) as missing_proof:
            query(env, operation)
        assert (missing_proof.value.code, missing_proof.value.status) == (1104, 403)
        with pytest.raises((tasks.TaskInputError, jobs.PlanningJobError, plans.PlanningPlanError)) as legacy_digest:
            operation.invoke(env.context())
        assert (legacy_digest.value.code, legacy_digest.value.status) == (1204, 409)
    plan = next(result for operation, result in executed if operation.kind == "savePlan")
    assert plans.get_planning_plan(plan["plan_id"], "OWNER-TASK", env.factory)["plan_id"] == plan["plan_id"]
    assert snapshot(env) == before and (env.submissions, env.cancellations) == effects


@pytest.mark.parametrize("kind", ["submit", "cancel", "confirm"])
def test_audit_sink_failure_rolls_back_cross_service_boundary_and_same_id_can_retry(env, kind):
    executed, pending = build_chain(env, owner=env.context(), stop_before=kind)
    before, effects = snapshot(env), (list(env.submissions), list(env.cancellations))
    failure = OperationalError("owner integration audit INSERT failure", {}, RuntimeError("explicit fault injection"))

    def fail_audit_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("INSERT INTO SYSTEM_AUDIT_EVENTS"):
            raise failure

    event.listen(env.engine, "before_cursor_execute", fail_audit_insert)
    try:
        with pytest.raises((OperationalError, SystemManagementError)) as rejected:
            pending.invoke(env.context())
        if kind == "confirm":
            assert rejected.value.code == 5002 and rejected.value.__cause__ is failure
        else:
            assert rejected.value is failure
    finally:
        event.remove(env.engine, "before_cursor_execute", fail_audit_insert)
    assert snapshot(env) == before and (env.submissions, env.cancellations) == effects
    assert query(env, pending)["state"] == "NOT_FOUND"
    for operation, _ in executed:
        assert_proof(env, operation)
    pending.invoke(env.context())
    assert_proof(env, pending)
