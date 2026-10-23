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
    return {"schema_version": 1, "solution_id": raw["solution_id"], "status": "COMPLETE", "devices": [],
            "provenance": {"raw_snapshot_sha256": algorithm._digest(raw), "frozen_tables_sha256": algorithm._digest(tables),
                "terrain_fingerprint": raw["terrain_fingerprint"], "engine_version": "V01-1",
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
