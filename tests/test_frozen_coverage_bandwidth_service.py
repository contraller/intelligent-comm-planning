"""不可变接收带宽版本；仅本树隔离文件，不连接运行库。"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import threading
import uuid

import pytest

from test_frozen_coverage_engine import scenario, SMALL
from test_frozen_coverage_service import context, ACTOR, BODY, QUERY, synthetic_result, terminal
from app import frozen_coverage_service as module
from app import frozen_coverage_bandwidth_service as bandwidth


def selection_body(request_id="SELECT-1", choices=None):
    return dict(task_id="T1", snapshot_id="SNP-PL-UNIT", request_id=request_id,
                choices=[{"device_id": "D1", "rx_bandwidth_khz": 2.4}] if choices is None else choices)


@pytest.fixture
def selected(context):
    context.source["tables"]["device_model.csv"][0]["bandwidth_khz"] = "0.5;2.4;2.7;3"
    service = context.make(engine=synthetic_result)
    service.start()
    return service, context


def save(service, body=None, actor=ACTOR):
    return service.save_bandwidth_selection("P1", selection_body() if body is None else body, actor)


def test_rx_bandwidth_options_without_worker_is_readonly(context):
    service = context.make(engine=lambda *a, **k: pytest.fail("GET cannot compute"))
    result = service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")
    assert result["current_selection"] is None and len(result["devices"]) == 3
    assert result["devices"][0]["state"] == "SINGLE_VALUE"
    assert not service.root.exists()
    with pytest.raises(module.CoverageServiceError) as error:
        save(service, selection_body(choices=[]))
    assert error.value.status == 503 and not service.root.exists()


def test_rx_bandwidth_latest_version_replay_and_restart_not_browser_storage(selected, monkeypatch):
    service, context = selected
    monkeypatch.setattr(module, "_now", lambda: "2026-10-24T00:00:00Z")
    first, status = save(service)
    assert status == 201 and first["version_no"] == 1
    first_path = service.bandwidth._path(first["selection_id"])
    first_bytes = first_path.read_bytes()
    second, status = save(service, selection_body("SELECT-2", [{"device_id": "D1", "rx_bandwidth_khz": 2.7}]))
    assert status == 201 and second["version_no"] == 2 and first["selection_id"] != second["selection_id"]
    assert second["created_at"] == first["created_at"]
    assert save(service) == (first, 200)
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"] == second
    second["choices"][0]["rx_bandwidth_khz"] = 99
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"]["choices"][0]["rx_bandwidth_khz"] == 2.7
    service.close()
    reopened = context.make(engine=lambda *a, **k: pytest.fail("read must not compute"))
    before = {p.name: p.read_bytes() for p in service.bandwidth.root.glob("*.json")}
    restored = reopened.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"]
    assert restored["version_no"] == 2 and restored["selection_id"] == second["selection_id"]
    assert first_path.read_bytes() == first_bytes
    assert before == {p.name: p.read_bytes() for p in service.bandwidth.root.glob("*.json")}


@pytest.mark.parametrize("choices", [
    [{"device_id": "D1", "rx_bandwidth_khz": True}],
    [{"device_id": "D1", "rx_bandwidth_khz": float("nan")}],
    [{"device_id": "D1", "rx_bandwidth_khz": float("inf")}],
    [{"device_id": "D1", "rx_bandwidth_khz": "2.4"}],
    [{"device_id": "D1", "rx_bandwidth_khz": None}],
    [{"device_id": "D1", "rx_bandwidth_khz": 0}],
    [{"device_id": "D1", "rx_bandwidth_khz": 25}],
    [{"device_id": "OUTSIDE", "rx_bandwidth_khz": 2.4}],
    [{"device_id": "D1", "rx_bandwidth_khz": 2.4}] * 2,
    [{"device_id": "D1", "rx_bandwidth_khz": 2.4}] * 1025,
    [{"device_id": "D1", "rx_bandwidth_khz": 2.4, "actor_id": "A"}],
])
def test_rx_bandwidth_invalid_choice_never_persists(selected, choices):
    service, _ = selected
    with pytest.raises(module.CoverageServiceError) as error:
        save(service, selection_body(choices=choices))
    assert error.value.code == 1001 and error.value.status == 422
    assert not service.bandwidth.root.exists() and not service._requests


@pytest.mark.parametrize("change", ["actor", "value", "order"])
def test_rx_bandwidth_selection_actor_original_body_conflict(selected, change):
    service, _ = selected
    body = selection_body(choices=[{"device_id": "D1", "rx_bandwidth_khz": 2.4},
                                   {"device_id": "D2", "rx_bandwidth_khz": 2.7}])
    first, _ = save(service, body)
    other = deepcopy(body)
    if change == "value":
        other["choices"][0]["rx_bandwidth_khz"] = 3
    elif change == "order":
        other["choices"].reverse()
    with pytest.raises(module.CoverageServiceError) as error:
        save(service, other, actor="OTHER" if change == "actor" else ACTOR)
    assert error.value.code == 1204
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"] == first


def test_rx_bandwidth_unknown_model_cannot_be_filled_with_unverifiable_choice(selected):
    service, context = selected
    context.source["tables"]["device_model.csv"][0]["bandwidth_khz"] = ""
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["devices"][0]["state"] == "UNKNOWN"
    with pytest.raises(module.CoverageServiceError):
        save(service)
    assert not service.bandwidth.root.exists()


def test_rx_bandwidth_concurrent_same_request_has_one_version(selected):
    service, _ = selected
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: save(service), range(2)))
    assert sorted(status for _, status in results) == [200, 201]
    assert results[0][0] == results[1][0]
    assert len(list(service.bandwidth.root.glob("FBS-*.json"))) == 1


def test_rx_bandwidth_selection_source_and_corruption_rejected(selected):
    service, context = selected
    saved, _ = save(service)
    path = service.bandwidth._path(saved["selection_id"])
    context.source["resource_revision"] = "DIFFERENT-REVISION"
    with pytest.raises(module.CoverageServiceError) as error:
        service.get_bandwidth_selection("P1", "T1", "SNP-PL-UNIT", saved["selection_id"])
    assert error.value.code == 1205
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"] is None
    record = json.loads(path.read_text(encoding="utf-8"))
    record["choices"][0]["rx_bandwidth_khz"] = 3
    module._atomic(path, record)
    with pytest.raises(module.CoverageServiceError) as error:
        service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")
    assert error.value.code == 5002


def test_rx_bandwidth_atomic_failure_not_accepted_or_advances_current(selected, monkeypatch):
    service, _ = selected
    atomic = module._atomic
    with monkeypatch.context() as patch:
        patch.setattr(module, "_atomic", lambda *a: (_ for _ in ()).throw(OSError("unit disk fault")))
        with pytest.raises(module.CoverageServiceError) as error:
            save(service)
        assert error.value.code == 5002
    assert not list(service.bandwidth.root.glob("FBS-*.json"))
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"] is None
    assert module._atomic is atomic and save(service)[0]["version_no"] == 1


def test_rx_bandwidth_actual_record_size_guard_before_publication(selected, monkeypatch):
    service, _ = selected
    monkeypatch.setattr(bandwidth, "MAX_RECORD_BYTES", 64)
    with pytest.raises(module.CoverageServiceError) as error:
        save(service)
    assert error.value.code == 1001 and not service.bandwidth.root.exists()


def test_rx_bandwidth_near_128k_request_over_256k_record_reads_and_restarts(selected):
    service, context = selected
    choices = []
    body = selection_body(choices=choices)
    for index in range(1021):
        did = ("LONG-" + str(index) + "-").ljust(160, "X")
        choice = {"device_id": did, "rx_bandwidth_khz": 2.4}
        candidate = {**body, "choices": [*choices, choice]}
        size = len(json.dumps(candidate, separators=(",", ":")).encode())
        if size > 128 * 1024:
            break
        choices.append(choice)
        context.source["raw_snapshot"]["detail"]["devices"].append(
            dict(device_id=did, node_id="N1", model_id="M1", antenna_id="A1"))
    body["choices"] = choices
    size = len(json.dumps(body, separators=(",", ":")).encode())
    assert 127 * 1024 < size <= 128 * 1024
    saved, status = save(service, body)
    path = service.bandwidth._path(saved["selection_id"])
    assert status == 201 and 256 * 1024 < path.stat().st_size < 512 * 1024
    assert service.get_bandwidth_selection("P1", "T1", "SNP-PL-UNIT", saved["selection_id"]) == saved
    original = path.read_bytes()
    service.close()
    reopened = context.make()
    reopened.start()
    assert reopened.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"] == saved
    assert path.read_bytes() == original


def test_rx_bandwidth_job_cache_result_and_new_selection_strict_binding(selected):
    service, _ = selected
    first, _ = save(service)
    body = {**BODY, "bandwidth_selection_id": first["selection_id"]}
    job, status = service.submit("P1", body, ACTOR)
    assert status == 202 and terminal(service, job["job_id"])["state"] == "SUCCESS"
    cached = service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, bandwidth_selection_id=first["selection_id"])
    assert cached["state"] == "HIT" and cached["bandwidth_selection_hash"] == first["selection_hash"]
    assert cached["result"]["provenance"]["bandwidth_choices"] == first["choices"]
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL)["state"] == "MISS"
    second, _ = save(service, selection_body("SELECT-2", []))
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, bandwidth_selection_id=second["selection_id"])["state"] == "MISS"
    with pytest.raises(module.CoverageServiceError) as error:
        service.submit("P1", {**body, "bandwidth_selection_id": second["selection_id"]}, ACTOR)
    assert error.value.code == 1204
    assert service.get_job(job["job_id"], **QUERY)["bandwidth_selection_id"] == first["selection_id"]


@pytest.mark.parametrize("change", ["id", "hash", "choices"])
def test_rx_bandwidth_wrong_engine_provenance_cannot_publish(selected, change):
    service, _ = selected
    saved, _ = save(service)

    def incorrect(*args, **kwargs):
        result = synthetic_result(*args, **kwargs)
        key = {"id": "bandwidth_selection_id", "hash": "bandwidth_selection_hash", "choices": "bandwidth_choices"}[change]
        result["provenance"][key] = [] if change == "choices" else "WRONG"
        return result

    service.engine = incorrect
    job, _ = service.submit("P1", {**BODY, "bandwidth_selection_id": saved["selection_id"]}, ACTOR)
    finished = terminal(service, job["job_id"])
    assert finished["state"] == "FAILED" and finished["error"]["code"] == "5002"
    assert service.cache("P1", "T1", "SNP-PL-UNIT", SMALL, bandwidth_selection_id=saved["selection_id"])["state"] == "MISS"


@pytest.mark.parametrize("action", ["cancel", "dem"])
def test_rx_bandwidth_new_selection_does_not_replace_running_job_cancel_or_dem_guard(selected, action):
    service, _ = selected
    entered, release = threading.Event(), threading.Event()

    def calculate(*args, **kwargs):
        entered.set()
        assert release.wait(4)
        return synthetic_result(*args, **kwargs)

    service.engine = calculate
    first, _ = save(service)
    body = {**BODY, "bandwidth_selection_id": first["selection_id"]}
    job, _ = service.submit("P1", body, ACTOR)
    try:
        assert entered.wait(2)
        second, _ = save(service, selection_body("SELECT-2", [{"device_id": "D1", "rx_bandwidth_khz": 2.7}]))
        if action == "cancel":
            service.cancel(job["job_id"], {**{k: QUERY[k] for k in ("plan_id", "task_id", "snapshot_id")},
                                           "request_id": "CANCEL-RX"}, ACTOR)
        else:
            service.fingerprint = lambda: "e" * 64
    finally:
        release.set()
    finished = terminal(service, job["job_id"])
    assert finished["state"] == ("CANCELLED" if action == "cancel" else "FAILED")
    assert finished["bandwidth_selection_id"] == first["selection_id"]
    assert service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")["current_selection"] == second
    assert not service._caches


def test_rx_bandwidth_bad_persistent_job_selection_is_storage_error_not_bad_input(selected):
    service, _ = selected
    saved, _ = save(service)
    job, _ = service.submit("P1", {**BODY, "bandwidth_selection_id": saved["selection_id"]}, ACTOR)
    assert terminal(service, job["job_id"])["state"] == "SUCCESS"
    record = service._job(job["job_id"])
    record["bandwidth_selection_id"] = "BAD-PERSISTED-ID"
    record["request_body"]["bandwidth_selection_id"] = "BAD-PERSISTED-ID"
    record["request_digest"] = module._hash(record["request_body"])
    record["cache_key"] = module._cache_key(record["anchor"], record["parameters"],
                                           record["bandwidth_selection_id"], record["bandwidth_selection_hash"])
    module._atomic(service._path(job["job_id"]), record)
    with pytest.raises(module.CoverageServiceError) as error:
        service.get_job(job["job_id"], **QUERY)
    assert error.value.code == 5002 and error.value.status == 503


def test_rx_bandwidth_duplicate_persistent_version_number_cannot_choose_arbitrary_latest(selected):
    service, _ = selected
    saved, _ = save(service)
    record = json.loads(service.bandwidth._path(saved["selection_id"]).read_text(encoding="utf-8"))
    record["selection_id"] = "FBS-" + uuid.uuid4().hex
    record["request_id"] = "DIFFERENT-REQUEST"
    record["request_body"]["request_id"] = record["request_id"]
    record["request_digest"] = module._hash(record["request_body"])
    record.pop("record_sha256")
    record["record_sha256"] = module._hash(record)
    module._atomic(service.bandwidth._path(record["selection_id"]), record)
    with pytest.raises(module.CoverageServiceError) as error:
        service.bandwidth_options("P1", "T1", "SNP-PL-UNIT")
    assert error.value.code == 5002


def test_rx_bandwidth_request_frozen_before_source_callback(selected):
    service, _ = selected
    body = selection_body()
    loader = service.source_loader

    def mutate(*args):
        body["choices"][0]["rx_bandwidth_khz"] = 3
        body["request_id"] = "MUTATED"
        return loader(*args)

    service.source_loader = mutate
    saved, _ = save(service, body)
    assert saved["choices"] == [{"device_id": "D1", "rx_bandwidth_khz": 2.4}]
    record = service.bandwidth._record(saved["selection_id"])
    assert record["request_id"] == "SELECT-1" and record["request_body"]["choices"] == saved["choices"]


def test_v4_old_selection_and_v3_cache_read_without_rewrite(selected):
    service, context = selected
    saved, _ = save(service)
    selection_path = service.bandwidth._path(saved["selection_id"])
    selection_bytes = selection_path.read_bytes()
    body = {**BODY, "bandwidth_selection_id": saved["selection_id"]}
    job, _ = service.submit("P1", body, ACTOR)
    assert terminal(service, job["job_id"])["state"] == "SUCCESS"
    record = service._job(job["job_id"])
    service.close()
    record["anchor"]["engine_version"] = "V01-3"
    record["cache_key"] = module._cache_key(record["anchor"], record["parameters"],
        saved["selection_id"], saved["selection_hash"])
    record["result"]["schema_version"] = 1
    record["result"]["status"] = "UNAVAILABLE"
    record["result"].pop("summary")
    record["result"]["provenance"]["engine_version"] = "V01-3"
    record["result_sha256"] = module._hash(record["result"])
    path = service._path(job["job_id"])
    module._atomic(path, record)
    original = path.read_bytes()
    reopened = context.make()
    reopened.start()
    old = reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL,
        bandwidth_selection_id=saved["selection_id"], engine_version="V01-3")
    assert old["state"] == "HIT" and old["result"]["status"] == "UNAVAILABLE"
    assert "summary" not in old["result"]
    assert reopened.submit("P1", body, ACTOR)[0]["job_id"] == job["job_id"]
    assert reopened.cache("P1", "T1", "SNP-PL-UNIT", SMALL,
        bandwidth_selection_id=saved["selection_id"])["state"] == "MISS"
    current, status = reopened.submit("P1", {**body, "request_id": "V4-NEW"}, ACTOR)
    assert status == 202 and terminal(reopened, current["job_id"])["state"] == "SUCCESS"
    assert current["anchor"]["engine_version"] == "V01-4"
    assert path.read_bytes() == original and selection_path.read_bytes() == selection_bytes
    context.source["resource_revision"] = "NEW-RESOURCE"
    with pytest.raises(module.CoverageServiceError) as error:
        reopened.submit("P1", {**body, "request_id": "FOREIGN-SOURCE"}, ACTOR)
    assert error.value.code == 1205


@pytest.mark.parametrize("version", ["V01-1", "V01-2"])
def test_v4_preselection_cache_versions_reject_selection(selected, version):
    service, _ = selected
    saved, _ = save(service)
    with pytest.raises(module.CoverageServiceError) as error:
        service.cache("P1", "T1", "SNP-PL-UNIT", SMALL,
            bandwidth_selection_id=saved["selection_id"], engine_version=version)
    assert error.value.code == 1001
