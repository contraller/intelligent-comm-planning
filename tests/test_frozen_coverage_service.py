"""独立覆盖缓存生命周期；小DEM真实计算与受控线程/故障分开。"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import threading
import time

import pytest

from test_frozen_coverage_engine import scenario, SMALL, FINGERPRINT
from app import frozen_coverage_engine as algorithm
from app import frozen_coverage_service as module


ACTOR = "UNIT-COVERAGE-OWNER"
BODY = {"task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "request_id": "REQUEST-1", "parameters": SMALL}
QUERY = {"plan_id": "P1", "task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "actor_id": ACTOR}


def synthetic_result(raw, tables, **kwargs):
    selection = kwargs.get("bandwidth_selection")
    return {"schema_version": 2, "solution_id": raw["solution_id"], "status": "NOT_APPLICABLE", "devices": [],
            "summary": dict(total=0, eligible=0, complete=0, unavailable=0, skipped=0),
            "provenance": {"raw_snapshot_sha256": algorithm._digest(raw), "frozen_tables_sha256": algorithm._digest(tables),
                "terrain_fingerprint": raw["terrain_fingerprint"], "engine_version": module.ENGINE_VERSION,
                "bandwidth_selection_id": selection["selection_id"] if selection else None,
                "bandwidth_selection_hash": selection["selection_hash"] if selection else None,
                "bandwidth_choices": deepcopy(selection["choices"]) if selection else [],
                "parameters": algorithm._parameters(kwargs["params"]), "test_only": True}}


@pytest.fixture
def context(scenario, tmp_path):
    source = {"plan_id": "P1", "task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "input_version": "TV1",
              "condition_version": "TC1", "resource_revision": "resource-" + "1" * 16,
              "resource_content_hash": "b" * 64, "input_snapshot": {"name": "构造冻结任务"},
              "raw_snapshot": scenario.raw, "tables": scenario.tables}
    services = []

    def loader(p, t, s):
        if (p, t) != (source["plan_id"], source["task_id"]):
            raise module.CoverageServiceError("not found", 2001, 404)
        if s != source["snapshot_id"]:
            raise module.CoverageServiceError("snapshot mismatch", 1205, 409)
        return deepcopy(source)

    def make(**kwargs):
        service = module.create_frozen_coverage_service(**{
            "runtime_root": tmp_path / "coverage", "source_loader": loader,
            "terrain_provider": scenario.factory, "fingerprint_provider": lambda: FINGERPRINT, **kwargs})
        services.append(service)
        return service

    yield type("Context", (), {"make": staticmethod(make), "source": source, "scenario": scenario})()
    for service in reversed(services):
        service.close(timeout=5)


def terminal(service, job_id, timeout=8):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        job = service.get_job(job_id, **QUERY)
        if job["state"] not in module.ACTIVE:
            return job
        time.sleep(0.01)
    pytest.fail("controlled coverage worker did not terminate")


def test_real_small_dem_compute_cache_and_read_only_restart(context):
    service = context.make()
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"
    assert not service.root.exists()
    service.start()
    job, status = service.submit("P1", BODY, ACTOR)
    assert status == 202
    assert terminal(service, job["job_id"])["state"] == "SUCCESS"
    cached = service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)
    assert cached["state"] == "HIT" and cached["result"]["devices"][0]["computations"][0]["cells"]
    assert cached["anchor"]["resource_revision"] == context.source["resource_revision"]
    service.close()
    reopened = context.make(engine=lambda *a, **k: pytest.fail("GET must not compute"))
    before = {p.name: p.stat().st_mtime_ns for p in service.root.iterdir()}
    assert reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL) == cached
    assert reopened.get_job(job["job_id"], **QUERY)["state"] == "SUCCESS"
    assert before == {p.name: p.stat().st_mtime_ns for p in service.root.iterdir()}


def test_request_replay_and_new_request_cache_hit_no_recompute(context):
    calls = []

    def calculate(*args, **kwargs):
        calls.append(True)
        return synthetic_result(*args, **kwargs)

    service = context.make(engine=calculate)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    assert terminal(service, job["job_id"])["state"] == "SUCCESS"
    replay, code = service.submit("P1", BODY, ACTOR)
    assert replay["job_id"] == job["job_id"] and code == 200
    hit, code = service.submit("P1", {**BODY, "request_id": "REQUEST-2"}, ACTOR)
    assert hit["state"] == "SUCCESS" and hit["from_cache"] is True and code == 200
    assert len(calls) == 1
    service.close()
    reopened = context.make(engine=calculate)
    reopened.start()
    assert reopened.submit("P1", BODY, ACTOR)[0]["job_id"] == job["job_id"]
    assert reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "HIT" and len(calls) == 1


@pytest.mark.parametrize("change", ["actor", "body", "raw_equivalent"])
def test_actor_bound_idempotency_uses_original_body(context, change):
    service = context.make(engine=synthetic_result)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    terminal(service, job["job_id"])
    body, actor = deepcopy(BODY), ACTOR
    if change == "actor":
        actor = "OTHER"
    elif change == "body":
        body["parameters"]["radius_m"] = 500
    else:
        body["parameters"]["radius_m"] = "250"
    with pytest.raises(module.CoverageServiceError) as error:
        service.submit("P1", body, actor)
    assert error.value.code == 1204


def test_worker_singleton_same_key_conflict_cancel_and_no_partial_cache(context):
    entered, release = threading.Event(), threading.Event()

    def calculate(raw, tables, **kwargs):
        entered.set()
        assert release.wait(3)
        if kwargs["cancelled"]():
            raise algorithm.FrozenCoverageCancelled("controlled cancellation")
        return synthetic_result(raw, tables, **kwargs)

    service = context.make(engine=calculate)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    assert entered.wait(2)
    with pytest.raises(module.CoverageServiceError) as error:
        service.submit("P1", {**BODY, "request_id": "OTHER"}, ACTOR)
    assert error.value.code == 1206
    cancel = {k: QUERY[k] for k in ("plan_id", "task_id", "snapshot_id")}
    cancel["request_id"] = "CANCEL-1"
    pending = service.cancel(job["job_id"], cancel, ACTOR)
    assert pending["cancel_requested"] and pending["state"] == "RUNNING"
    release.set()
    assert terminal(service, job["job_id"])["state"] == "CANCELLED"
    assert service.cancel(job["job_id"], cancel, ACTOR)["state"] == "CANCELLED"
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"


def test_same_directory_exclusive_and_close_waits_for_own_worker(context):
    entered, release = threading.Event(), threading.Event()

    def calculate(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return synthetic_result(*args, **kwargs)

    service = context.make(engine=calculate)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    assert entered.wait(2)
    other = context.make()
    with pytest.raises((OSError, module.CoverageServiceError)):
        other.start()
    with pytest.raises(module.CoverageServiceError, match="尚未退出"):
        service.close(timeout=0.01)
    with pytest.raises((OSError, module.CoverageServiceError)):
        other.start()
    release.set()
    service.close(timeout=5)
    assert service.get_job(job["job_id"], **QUERY)["state"] == "CANCELLED"
    other.start()


@pytest.mark.parametrize("change", ["dem", "raw", "input", "resource"])
def test_changed_frozen_source_never_publishes_late_result(context, change):
    entered, release = threading.Event(), threading.Event()
    fingerprint = [FINGERPRINT]

    def calculate(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return synthetic_result(*args, **kwargs)

    service = context.make(engine=calculate, fingerprint_provider=lambda: fingerprint[0])
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    assert entered.wait(2)
    if change == "dem":
        fingerprint[0] = "c" * 64
    elif change == "raw":
        context.source["raw_snapshot"]["detail"]["params"]["params"][0]["tx_power_dbm"] = 50
    elif change == "input":
        context.source["input_snapshot"]["name"] = "CHANGED"
    else:
        context.source["resource_content_hash"] = "c" * 64
    release.set()
    until = time.monotonic() + 4
    while time.monotonic() < until and service._job(job["job_id"])["state"] in module.ACTIVE:
        time.sleep(0.01)
    assert service._job(job["job_id"])["state"] == "FAILED"
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] in ("MISS", "STALE")


def test_failed_engine_and_progress_one_never_mean_success(context):
    def calculate(*args, **kwargs):
        kwargs["progress"](1, "not committed")
        raise RuntimeError("controlled algorithm failure")

    service = context.make(engine=calculate)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    failed = terminal(service, job["job_id"])
    assert failed["state"] == "FAILED" and failed["progress"] < 1 and failed["error"]
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"


def test_atomic_success_write_failure_preserves_failure_and_no_cache(context, monkeypatch):
    original = module._atomic

    def atomic(path, value):
        if value["state"] == "SUCCESS":
            raise OSError("controlled failed replace")
        return original(path, value)

    monkeypatch.setattr(module, "_atomic", atomic)
    service = context.make(engine=synthetic_result)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    assert terminal(service, job["job_id"])["state"] == "FAILED"
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"


def test_restart_marks_only_own_unfinished_job_interrupted_not_resumed(context):
    service = context.make(engine=synthetic_result)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    terminal(service, job["job_id"])
    service.close()
    record = service._job(job["job_id"])
    record.update(state="RUNNING", result=None, finished_at=None)
    module._atomic(service._path(job["job_id"]), record)
    (service.root / "other-module-evidence.json").write_text('{"state":"RUNNING"}', encoding="utf-8")
    reopened = context.make(engine=lambda *a, **k: pytest.fail("restart must not resume"))
    reopened.start()
    assert reopened.get_job(job["job_id"], **QUERY)["state"] == "INTERRUPTED"
    assert reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"
    assert json.loads((service.root / "other-module-evidence.json").read_text())["state"] == "RUNNING"


@pytest.mark.parametrize("change", ["actor", "plan", "task", "snapshot"])
def test_job_owner_and_anchor_checks(context, change):
    service = context.make(engine=synthetic_result)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    terminal(service, job["job_id"])
    query = dict(QUERY)
    query[{"actor": "actor_id", "plan": "plan_id", "task": "task_id", "snapshot": "snapshot_id"}[change]] = "OTHER"
    with pytest.raises(module.CoverageServiceError) as error:
        service.get_job(job["job_id"], **query)
    assert error.value.code == (1103 if change == "actor" else 1205)


def test_cache_parameters_and_dem_staleness_not_falsely_hit(context):
    value = [FINGERPRINT]
    service = context.make(engine=synthetic_result, fingerprint_provider=lambda: value[0])
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    terminal(service, job["job_id"])
    assert service.cache("P1", "T1", "SNP-PL-UNIT", {**SMALL, "radius_m": 500})["state"] == "MISS"
    value[0] = "c" * 64
    response = service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)
    assert response["state"] == "STALE" and response["result"] is None


def test_corrupt_result_and_request_metadata_rejected(context):
    service = context.make(engine=synthetic_result)
    service.start()
    job, _ = service.submit("P1", BODY, ACTOR)
    terminal(service, job["job_id"])
    service.close()
    record = service._job(job["job_id"])
    record["result"]["status"] = "FORGED"
    module._atomic(service._path(job["job_id"]), record)
    reopened = context.make()
    with pytest.raises(module.CoverageServiceError) as error:
        reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL)
    assert error.value.code == 5002


def test_submit_requires_explicit_start_and_runtime_isolation(context):
    service = context.make()
    with pytest.raises(module.CoverageServiceError) as error:
        service.submit("P1", BODY, ACTOR)
    assert error.value.code == 5003 and not service.root.exists()
    with pytest.raises(module.CoverageServiceError):
        context.make(runtime_root=module.ROOT)


def test_default_loader_uses_exact_historical_version_not_current(context, tmp_path):
    from sqlalchemy import create_engine, inspect
    from sqlalchemy.orm import sessionmaker
    from app.database import Base
    from app import planning_job_models, task_input_models
    from app.planning_plan_models import PlanningPlan
    from app.resource_dataset_models import ResourceDatasetVersion
    from app import resource_dataset_service as datasets

    # 仅创建所需模型表；快照按底座_decode真实校验，未引用磁盘CSV。
    db = create_engine("sqlite:///" + str(tmp_path / "frozen-read.sqlite"))
    factory = sessionmaker(bind=db)
    for table in (PlanningPlan.__table__, ResourceDatasetVersion.__table__):
        table.create(db)
    tables = deepcopy(context.source["tables"])
    for name, key in datasets.ID_FIELDS.items():
        tables.setdefault(name, [{key: "X"}])
    tables["node.csv"] = [{"node_id": "N1"}]
    tables["device.csv"] = [{"device_id": "D1", "node_id": "N1", "model_id": "M1", "antenna_id": "A1"}]
    tables["task_scenario.csv"] = [{"task_id": "T1"}]
    tables["comm_demand.csv"] = [{"demand_id": "C1", "task_id": "T1", "src_node_id": "N1", "dst_node_id": "N1"}]
    tables["device_model.csv"][0]["source"] = ""
    snapshot = {"schema_version": 1, "tables": tables, "source_updated_at": "2026-10-24T00:00:00Z",
                "source_files": {name: {"path": "data/unit/" + name, "sha256": "d" * 64} for name in datasets.ID_FIELDS}}
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=context.source["resource_revision"], content_hash=datasets.content_hash(snapshot),
            source=datasets.SOURCE, data_origin=datasets.ORIGIN, snapshot=snapshot, created_at=datetime.now(timezone.utc)))
        session.add(PlanningPlan(plan_id="P1", request_id="R1", request_digest="e" * 64, task_id="T1", job_id="J1",
            revision_id="TV1", condition_version="TC1", resource_revision=context.source["resource_revision"], version_no=1,
            name="UNIT", note="", state="CONFIRMED", input_snapshot={"name": "UNIT"}, result_snapshot={"snapshot_id": "SNP-PL-UNIT"},
            raw_snapshot=context.source["raw_snapshot"], outcome_snapshot={}, source="SR4", saved_at=datetime.now(timezone.utc)))
    result = module._source_loader(factory, "P1", "T1", "SNP-PL-UNIT")
    assert result["tables"] == tables and result["resource_content_hash"] == datasets.content_hash(snapshot)
    assert not inspect(db).has_table("resource_dataset_current")
    with pytest.raises(module.CoverageServiceError):
        module._source_loader(factory, "P1", "T1", "WRONG")
    db.dispose()


@pytest.fixture(scope="module")
def local_coverage_modules():
    import importlib
    import importlib.util
    from pathlib import Path
    import sys
    from types import ModuleType, SimpleNamespace

    # 隔离包避免旧树同名共享模块遮住真实Context；待测service仍从本树加载。
    sys.dont_write_bytecode = True
    root = Path(__file__).resolve().parents[1]
    shared = next(parent / "algorithm-service/app" for parent in (root, *root.parents)
                  if (parent / "algorithm-service/app/local_business_context.py").is_file())
    name = "_p04_frozen_coverage_local_context"
    package = ModuleType(name)
    package.__path__ = [str(shared)]
    sys.modules[name] = package
    spec = importlib.util.spec_from_file_location(name + ".frozen_coverage_service",
                                                  root / "algorithm-service/app/frozen_coverage_service.py")
    service = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = service
    spec.loader.exec_module(service)
    load = lambda value: importlib.import_module(name + "." + value)
    result = SimpleNamespace(service=service, database=load("database"), models=load("system_management_models"),
        identity=load("local_identity_service"), sessions=load("local_identity_models"),
        settings=load("local_identity_schemas"), system=load("system_management_service"),
        permissions=load("permission_registry"), context=load("local_business_context"),
        errors=load("system_management_schemas"), plans=load("planning_plan_models"),
        resources=load("resource_dataset_models"), datasets=load("resource_dataset_service"))
    # 声明外键元数据，不创建/运行共享任务服务。
    load("planning_job_models")
    load("task_input_models")
    yield result
    for key in list(sys.modules):
        if key == name or key.startswith(name + "."):
            sys.modules.pop(key)


@pytest.fixture
def local_cache(context, tmp_path, monkeypatch, local_coverage_modules):
    from hashlib import sha256
    from types import SimpleNamespace
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from starlette.requests import Request

    m = local_coverage_modules
    monkeypatch.setenv("AUTH_MODE", "LOCAL_PASSWORD")
    db = create_engine("sqlite:///" + str(tmp_path / "local-cache.sqlite"), connect_args={"check_same_thread": False})
    selected = [m.models.LocalRole, m.models.LocalAccount, m.models.LocalCredential, m.models.SystemAuditEvent,
                m.sessions.LocalIdentitySession, m.plans.PlanningPlan, m.resources.ResourceDatasetVersion]
    m.database.Base.metadata.create_all(db, tables=[model.__table__ for model in selected])
    factory = sessionmaker(bind=db, expire_on_commit=False)
    clock = 2_000_000_000
    system = m.system.SystemManagementService(session_factory=factory,
        permission_registry=m.permissions.SERVER_PERMISSION_REGISTRY,
        request_key=b"isolated-frozen-coverage-key-32-bytes", clock=lambda: clock)
    adapter = m.identity.LocalIdentityAdapter(service=m.identity.LocalIdentityService(system_service=system,
        settings=m.settings.LocalIdentitySettings(frozenset({"http://127.0.0.1:8811"}), allow_insecure_loopback=True)))
    application = SimpleNamespace(state=SimpleNamespace(local_identity_adapter=adapter))
    with factory.begin() as session:
        for account, permissions in (("A", ["planning.view", "planning.execute", "planning.save"]),
                                     ("B", ["planning.view", "situation.view"])):
            session.add(m.models.LocalRole(id="ROLE-" + account, name="UNIT-" + account,
                description="隔离测试角色", permissions=permissions))
            session.flush()
            session.add(m.models.LocalAccount(id="ACC-" + account, username="unit_" + account.lower(), name="UNIT-" + account,
                department="UNIT", role_id="ROLE-" + account, enabled=True, identity_revision=1, last_login=None))
            session.flush()
            session.add(m.models.LocalCredential(account_id="ACC-" + account, password_hash="seeded-session-not-login",
                must_change_password=False, revision=1, changed_at=clock))
            session.add(m.sessions.LocalIdentitySession(token_hash=sha256(("unit-cookie-" + account).encode()).hexdigest(),
                account_id="ACC-" + account, session_id="SID-" + account, generation="GEN-" + account,
                identity_revision=1, csrf="unit-csrf-" + account, created_at=clock, last_seen=clock,
                expires_at=clock + 20000, revoked=False))

    def capture(account="A", method="POST"):
        headers = {"cookie": m.identity.SESSION_COOKIE + "=unit-cookie-" + account,
                   "origin": "http://127.0.0.1:8811", "x-session-id": "SID-" + account,
                   "x-csrf-token": "unit-csrf-" + account}
        request = Request({"type": "http", "app": application, "method": method, "scheme": "http",
            "server": ("127.0.0.1", 8811), "client": ("127.0.0.1", 1), "path": "/api/v1/planning-coverages",
            "query_string": b"", "headers": [(k.encode(), v.encode()) for k, v in headers.items()]})
        return m.context.create_local_business_context(request, adapter=adapter)

    tables = deepcopy(context.source["tables"])
    for name, key in m.datasets.ID_FIELDS.items():
        tables.setdefault(name, [{key: "X"}])
    tables.update({"node.csv": [{"node_id": "N1"}], "device.csv": [{"device_id": "D1", "node_id": "N1", "model_id": "M1", "antenna_id": "A1"}],
        "task_scenario.csv": [{"task_id": "T1"}], "comm_demand.csv": [{"demand_id": "C1", "task_id": "T1", "src_node_id": "N1", "dst_node_id": "N1"}]})
    tables["device_model.csv"][0]["source"] = ""
    snapshot = {"schema_version": 1, "tables": tables, "source_updated_at": "2026-10-24T00:00:00Z",
                "source_files": {name: {"path": "data/unit/" + name, "sha256": "d" * 64} for name in m.datasets.ID_FIELDS}}
    with factory.begin() as session:
        session.add(m.resources.ResourceDatasetVersion(revision=context.source["resource_revision"], content_hash=m.datasets.content_hash(snapshot),
            source=m.datasets.SOURCE, data_origin=m.datasets.ORIGIN, snapshot=snapshot, created_at=datetime.now(timezone.utc)))
        for pid in ("P1", "P2"):
            session.add(m.plans.PlanningPlan(plan_id=pid, request_id="SAVE-" + pid, request_digest="e" * 64, task_id="T1", job_id="J-" + pid,
                revision_id="TV1", condition_version="TC1", resource_revision=context.source["resource_revision"], version_no=1 if pid == "P1" else 2,
                name="UNIT", note="", state="CONFIRMED", input_snapshot={"name": "UNIT"}, result_snapshot={"snapshot_id": "SNP-PL-UNIT"},
                raw_snapshot=context.source["raw_snapshot"], outcome_snapshot={}, source="SR4", saved_at=datetime.now(timezone.utc)))
    owner = capture("A")
    with factory.begin() as session:
        ticket = owner.prepare(session, "planning.save")
        owner.append_owner(session, ticket, operation="plan.save", request_id="SAVE-P1", object_id="P1",
                           changes={"context": "planning", "task_id": "T1", "revision_id": "TV1"})
    service = m.service.create_frozen_coverage_service(runtime_root=tmp_path / "local-coverage", session_factory=factory,
        fingerprint_provider=lambda: FINGERPRINT, terrain_provider=context.scenario.factory, engine=synthetic_result)
    try:
        yield SimpleNamespace(m=m, factory=factory, service=service, capture=capture)
    finally:
        service.close()
        db.dispose()


def _local_cached_job(e):
    e.service.start()
    job, status = e.service.submit("P1", BODY, "ACC-A", audit_context=e.capture("A"))
    assert status == 202
    until = time.monotonic() + 8
    while time.monotonic() < until:
        if e.service._job(job["job_id"])["state"] not in module.ACTIVE:
            break
        time.sleep(0.01)
    assert e.service._job(job["job_id"])["state"] == "SUCCESS"
    return job


def test_local_readonly_other_account_cache_hit_miss_and_job_actor_bound(local_cache):
    e = local_cache
    reader = e.capture("B", "GET")
    assert "planning.save" not in reader.actor.permissions and "planning.execute" not in reader.actor.permissions
    assert e.service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, audit_context=reader)["state"] == "MISS"
    job = _local_cached_job(e)
    assert e.service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, audit_context=reader)["state"] == "HIT"
    assert e.service.cache("P1", "T1", "SNP-PL-UNIT", {**SMALL, "radius_m": 500}, audit_context=reader)["state"] == "MISS"
    with pytest.raises(e.m.service.CoverageServiceError) as error:
        e.service.get_job(job["job_id"], **{**QUERY, "actor_id": "ACC-B"}, audit_context=reader)
    assert error.value.status == 403 and error.value.code == 1103


def test_local_other_compute_and_legacy_without_save_proof_still_denied(local_cache):
    e = local_cache
    e.service.start()
    # B补齐execute后再测，避免仅因只读权限不足掩盖owner proof断言。
    with e.factory.begin() as session:
        session.get(e.m.models.LocalRole, "ROLE-B").permissions = ["planning.view", "planning.execute", "situation.view"]
    for account, pid in (("B", "P1"), ("A", "P2")):
        with pytest.raises(e.m.errors.SystemManagementError, match="归属证明") as error:
            e.service.submit(pid, {**BODY, "request_id": "DENIED-" + account}, "ACC-" + account, audit_context=e.capture(account))
        assert error.value.code == 1104 and error.value.status == 403
    assert not e.service._requests


def test_local_readonly_cache_fresh_session_revocation_still_denied(local_cache):
    e = local_cache
    reader = e.capture("B", "GET")
    assert e.service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, audit_context=reader)["state"] == "MISS"
    with e.factory.begin() as session:
        session.get(e.m.sessions.LocalIdentitySession, reader._token_hash).revoked = True
    with pytest.raises(e.m.errors.SystemManagementError) as error:
        e.service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, audit_context=reader)
    assert error.value.code == 1102 and error.value.status == 401


def test_public_status_is_readonly_and_reports_lifecycle_and_storage_fault(context, monkeypatch):
    from types import SimpleNamespace

    service = context.make(engine=synthetic_result)
    assert service.status() == {"state": "disabled", "worker_alive": False, "stop_requested": False, "storage_fault": False}
    assert not service.root.exists()
    service.start()
    assert service.status()["state"] == "running" and service.status()["worker_alive"] is True
    with monkeypatch.context() as patch:
        patch.setattr(service, "_storage_fault", module.CoverageServiceError("unit storage fault", 5002, 503))
        patch.setattr(module, "_read", lambda *_: pytest.fail("status may not read cache"))
        patch.setattr(module, "_atomic", lambda *_: pytest.fail("status may not write cache"))
        assert service.status()["state"] == "failed" and service.status()["storage_fault"] is True
    with monkeypatch.context() as patch:
        patch.setattr(service, "_thread", SimpleNamespace(is_alive=lambda: False))
        assert service.status()["state"] == "failed"
    service.close()
    assert service.status() == {"state": "disabled", "worker_alive": False, "stop_requested": True, "storage_fault": False}


def test_v4_history_scan_reads_v1_to_v3_jobs_cache_and_preserves_exact_bytes(context):
    import uuid

    service = context.make(engine=synthetic_result)
    service.start()
    submitted, _ = service.submit("P1", BODY, ACTOR)
    assert terminal(service, submitted["job_id"])["state"] == "SUCCESS"
    base = service._job(submitted["job_id"])
    service.close()
    legacy = context.make(runtime_root=service.root.parent / "legacy-only")
    legacy.root.mkdir()
    paths = []
    for version in ("V01-1", "V01-2", "V01-3"):
        for state in ("SUCCESS", "FAILED"):
            old = deepcopy(base)
            old["job_id"] = "FCJ-" + uuid.uuid4().hex
            old["request_id"] = "LEGACY-" + version + "-" + state
            old["request_body"]["request_id"] = old["request_id"]
            old["request_digest"] = module._hash(old["request_body"])
            old["anchor"]["engine_version"] = version
            old["cache_key"] = module._cache_key(old["anchor"], old["parameters"])
            if version != "V01-3":
                old.pop("bandwidth_selection_id")
                old.pop("bandwidth_selection_hash")
            old["state"] = state
            if state == "SUCCESS":
                old["result"]["provenance"]["engine_version"] = version
                old["result"]["schema_version"] = 1
                old["result"]["status"] = "COMPLETE"
                old["result"].pop("summary")
                if version != "V01-3":
                    for key in ("bandwidth_selection_id", "bandwidth_selection_hash", "bandwidth_choices"):
                        old["result"]["provenance"].pop(key)
                old["result_sha256"] = module._hash(old["result"])
            else:
                old["result"] = None
                old["error"] = {"code": "COVERAGE_INPUT", "message": "retained original failure"}
            path = legacy._path(old["job_id"])
            module._atomic(path, old)
            paths.append((path, path.read_bytes(), old))
    reopened = context.make(runtime_root=legacy.root, engine=lambda *a, **k: pytest.fail("history must not compute"))
    reopened.start()
    assert reopened.status()["state"] == "running"
    assert reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"
    for path, original, old in paths:
        page = reopened.get_job(old["job_id"], **QUERY)
        assert page["state"] == old["state"] and page["anchor"]["engine_version"] == old["anchor"]["engine_version"]
        assert ("bandwidth_selection_id" in page) == (old["anchor"]["engine_version"] == "V01-3")
        assert path.read_bytes() == original
        cache = reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL, engine_version=old["anchor"]["engine_version"])
        assert cache["state"] == "HIT" and cache["result"]["schema_version"] == 1
        assert "summary" not in cache["result"] and cache["result"]["status"] == "COMPLETE"
        replay, status = reopened.submit("P1", {k: v for k, v in old["request_body"].items() if k != "plan_id"}, ACTOR)
        assert status == 200 and replay["job_id"] == old["job_id"]
    reopened.close()
    assert all(path.read_bytes() == original for path, original, _ in paths)
    context.source["resource_revision"] = "OTHER-REVISION"
    with pytest.raises(module.CoverageServiceError) as error:
        reopened.get_job(paths[0][2]["job_id"], **QUERY)
    assert error.value.code == 1205


@pytest.mark.parametrize("change", ["summary", "overall", "schema"])
def test_v4_inconsistent_engine_result_never_publishes(context, change):
    def wrong(*args, **kwargs):
        result = synthetic_result(*args, **kwargs)
        if change == "summary":
            result["summary"]["total"] = 1
        elif change == "overall":
            result["status"] = "COMPLETE"
        else:
            result["schema_version"] = 1
        return result

    service = context.make(engine=wrong)
    service.start()
    job, status = service.submit("P1", BODY, ACTOR)
    assert status == 202
    finished = terminal(service, job["job_id"])
    assert finished["state"] == "FAILED" and finished["error"]["code"] == "5002"
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"


@pytest.mark.parametrize("version", ["", "V01-5", 4, True])
def test_v4_cache_unknown_version_rejected_without_runtime_write(context, version):
    service = context.make()
    with pytest.raises(module.CoverageServiceError) as error:
        service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, engine_version=version)
    assert error.value.code == 1001 and not service.root.exists()


def test_rx_bandwidth_local_owner_write_shared_read_and_revocation(local_cache):
    e = local_cache
    e.service.start()
    body = {"task_id": "T1", "snapshot_id": "SNP-PL-UNIT", "request_id": "RX-SELECT-LOCAL",
            "choices": [{"device_id": "D1", "rx_bandwidth_khz": 25}]}
    saved, status = e.service.save_bandwidth_selection("P1", body, "ACC-A", audit_context=e.capture("A"))
    assert status == 201
    reader = e.capture("B", "GET")
    assert e.service.bandwidth_options("P1", "T1", "SNP-PL-UNIT", audit_context=reader)["current_selection"] == saved
    assert e.service.get_bandwidth_selection("P1", "T1", "SNP-PL-UNIT", saved["selection_id"], audit_context=reader) == saved
    for actor, context in (("ACC-A", e.capture("A", "GET")), ("ACC-B", e.capture("A"))):
        with pytest.raises(e.m.service.CoverageServiceError) as error:
            e.service.save_bandwidth_selection("P1", body, actor, audit_context=context)
        assert error.value.code == 1104 and error.value.status == 403
    with e.factory.begin() as session:
        session.get(e.m.models.LocalRole, "ROLE-B").permissions = ["planning.view", "planning.execute", "situation.view"]
    for account, pid in (("B", "P1"), ("A", "P2")):
        with pytest.raises(e.m.errors.SystemManagementError) as error:
            e.service.save_bandwidth_selection(pid, {**body, "request_id": "RX-DENIED-" + account},
                                               "ACC-" + account, audit_context=e.capture(account))
        assert error.value.code == 1104 and error.value.status == 403
    assert len(list(e.service.bandwidth.root.glob("FBS-*.json"))) == 1
    with e.factory.begin() as session:
        session.get(e.m.sessions.LocalIdentitySession, reader._token_hash).revoked = True
    with pytest.raises(e.m.errors.SystemManagementError) as error:
        e.service.bandwidth_options("P1", "T1", "SNP-PL-UNIT", audit_context=reader)
    assert error.value.code == 1102
