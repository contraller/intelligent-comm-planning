"""V6服务契约；构造DEM与隔离缓存不代表现场覆盖验收。"""
from copy import deepcopy

import pytest
from pydantic import ValidationError

from test_frozen_coverage_engine import scenario, hf, SMALL
from test_frozen_coverage_service import context, ACTOR, BODY, QUERY, terminal
import test_frozen_coverage_service as legacy
from app import frozen_coverage_engine as algorithm
from app import frozen_coverage_service as module
from app.coverage_field_surface import metadata
from app.coverage_terrain_surface import metadata as terrain_metadata
from app.frozen_coverage_router import _Cache, _Latest, _Submit


_legacy_synthetic_result = legacy.synthetic_result


def terrain_synthetic_result(raw, tables, **kwargs):
    # 沿用原compute注入签名，补充V6元数据及构造DEM边界。
    result = _legacy_synthetic_result(raw, tables, **kwargs)
    result["provenance"]["field_strength"] = terrain_metadata()
    result["provenance"]["dem_bbox"] = list(kwargs["terrain"]().bbox)
    return result


def completed(service, body=None):
    job, status = service.submit("P1", BODY if body is None else body, ACTOR)
    assert status == 202
    result = terminal(service, job["job_id"])
    assert result["state"] == "SUCCESS", result
    return service._job(job["job_id"])


def historical_record(record, version):
    old = deepcopy(record)
    old["anchor"]["engine_version"] = version
    provenance = old["result"]["provenance"]
    provenance["engine_version"] = version
    provenance["field_strength"] = metadata()
    if version in ("V01-1", "V01-2", "V01-3"):
        old["result"]["schema_version"] = 1
        old["result"]["status"] = "COMPLETE"
        old["result"].pop("summary")
        provenance.pop("field_strength")
    if version in ("V01-1", "V01-2"):
        for key in ("bandwidth_selection_id", "bandwidth_selection_hash"):
            old.pop(key)
            provenance.pop(key)
        provenance.pop("bandwidth_choices")
    old["result_sha256"] = module._hash(old["result"])
    old["cache_key"] = module._cache_key(old["anchor"], old["parameters"],
        old.get("bandwidth_selection_id"), old.get("bandwidth_selection_hash"))
    return old


@pytest.mark.parametrize("band", ["HF", "VUHF"])
def test_v6_default_real_dem_validation_projection_and_readonly_restart(context, monkeypatch, band):
    if band == "HF":
        hf(context.scenario)
    validations = []
    validate = algorithm.validate_terrain_result

    def checked(result):
        validations.append(result["provenance"]["engine_version"])
        return validate(result)

    monkeypatch.setattr(algorithm, "validate_terrain_result", checked)
    service = context.make()
    assert service.engine is algorithm.compute_frozen_terrain_coverage
    assert module.ENGINE_VERSION == "V01-6"
    assert service.cache("P1", "T1", BODY["snapshot_id"], SMALL)["state"] == "MISS"
    assert not service.root.exists()
    service.start()
    record = completed(service)
    assert record["anchor"]["engine_version"] == "V01-6"
    result = record["result"]
    assert result["schema_version"] == 2
    assert result["provenance"]["field_strength"]["hf_geometry"] == "P368_P533_LOCAL_TERRAIN_GRID"
    parts = [part for device in result["devices"] for part in device["computations"]]
    assert parts and any(part["cells"] for part in parts)
    cached = service.cache("P1", "T1", BODY["snapshot_id"], SMALL)
    assert cached["state"] == "HIT"
    assert validations and set(validations) == {"V01-6"}
    for device in cached["result"]["devices"]:
        for part in device["computations"]:
            assert not {"cells", "radial_samples", "rings"} & set(part)
    assert service._job(record["job_id"])["result"] == result
    service.close()
    before = {path.name: path.read_bytes() for path in service.root.iterdir()}
    reopened = context.make(engine=lambda *a, **k: pytest.fail("只读恢复不得重算"))
    assert reopened.cache("P1", "T1", BODY["snapshot_id"], SMALL) == cached
    assert reopened.latest_cache("P1", "T1", BODY["snapshot_id"]) == cached
    assert reopened.get_job(record["job_id"], **QUERY)["state"] == "SUCCESS"
    assert before == {path.name: path.read_bytes() for path in service.root.iterdir()}


@pytest.mark.parametrize("version", ["V01-1", "V01-2", "V01-3", "V01-4", "V01-5"])
def test_v6_history_read_replay_and_new_cache_are_separate(context, version):
    service = context.make(engine=terrain_synthetic_result)
    service.start()
    base = completed(service)
    service.close()
    old = historical_record(base, version)
    path = service._path(old["job_id"])
    module._atomic(path, old)
    before = path.read_bytes()
    reopened = context.make(engine=terrain_synthetic_result)
    historic = reopened.cache("P1", "T1", BODY["snapshot_id"], SMALL, engine_version=version)
    assert historic["state"] == "HIT"
    assert historic["result"]["provenance"]["engine_version"] == version
    assert reopened.latest_cache("P1", "T1", BODY["snapshot_id"], engine_version=version) == historic
    current = reopened.cache("P1", "T1", BODY["snapshot_id"], SMALL)
    assert current["state"] == "MISS" and current["cache_key"] != historic["cache_key"]
    assert reopened.latest_cache("P1", "T1", BODY["snapshot_id"])["state"] == "MISS"
    reopened.start()
    replay, status = reopened.submit("P1", BODY, ACTOR)
    assert status == 200 and replay["job_id"] == old["job_id"]
    assert replay["anchor"]["engine_version"] == version
    fresh = completed(reopened, {**BODY, "request_id": "V6-NEW"})
    assert fresh["anchor"]["engine_version"] == "V01-6"
    assert fresh["cache_key"] == current["cache_key"]
    assert path.read_bytes() == before


@pytest.mark.parametrize("version", ["V01-3", "V01-4", "V01-5"])
def test_v6_reuses_immutable_bandwidth_from_history_and_restores_latest(context, version):
    context.source["tables"]["device_model.csv"][0]["bandwidth_khz"] = "2.4;2.7;3"
    calls = []

    def compute(raw, tables, **kwargs):
        calls.append(deepcopy(kwargs["bandwidth_selection"]))
        assert callable(kwargs["cancelled"]) and callable(kwargs["progress"])
        return terrain_synthetic_result(raw, tables, **kwargs)

    service = context.make(engine=compute)
    service.start()
    selection, status = service.save_bandwidth_selection("P1", dict(task_id="T1", snapshot_id=BODY["snapshot_id"],
        request_id="SELECT-1", choices=[dict(device_id="D1", rx_bandwidth_khz=2.4)]), ACTOR)
    assert status == 201
    body = {**BODY, "bandwidth_selection_id": selection["selection_id"]}
    base = completed(service, body)
    service.close()
    old = historical_record(base, version)
    path = service._path(old["job_id"])
    module._atomic(path, old)
    old_bytes = path.read_bytes()
    selection_path = service.bandwidth._path(selection["selection_id"])
    selection_bytes = selection_path.read_bytes()
    reopened = context.make(engine=compute)
    reopened.start()
    historic = reopened.cache("P1", "T1", BODY["snapshot_id"], SMALL,
        bandwidth_selection_id=selection["selection_id"], engine_version=version)
    assert historic["state"] == "HIT"
    new_body = {**body, "request_id": "V6-SELECTED", "parameters": {**SMALL, "radius_m": 500}}
    current = completed(reopened, new_body)
    assert current["bandwidth_selection_id"] == selection["selection_id"]
    assert current["bandwidth_selection_hash"] == selection["selection_hash"]
    assert current["result"]["provenance"]["bandwidth_choices"] == selection["choices"]
    assert calls == [selection, selection]
    latest = reopened.latest_cache("P1", "T1", BODY["snapshot_id"])
    assert latest["state"] == "HIT" and latest["parameters"]["radius_m"] == 500
    assert latest["bandwidth_selection_id"] == selection["selection_id"]
    assert latest["cache_key"] != historic["cache_key"]
    hit, status = reopened.submit("P1", {**new_body, "request_id": "V6-HIT"}, ACTOR)
    assert status == 200 and hit["from_cache"] and len(calls) == 2
    assert path.read_bytes() == old_bytes and selection_path.read_bytes() == selection_bytes


def corrupt_result(result, change):
    if change == "schema":
        result["schema_version"] = 1
    elif change == "field_metadata":
        result["provenance"]["field_strength"] = metadata()
    elif change == "unit":
        result["provenance"]["units"]["field_strength"] = "dB"
    elif change == "summary":
        result["summary"]["total"] = 1
    elif change == "engine":
        result["provenance"]["engine_version"] = "V01-5"
    elif change == "source":
        result["provenance"]["raw_snapshot_sha256"] = "e" * 64
    elif change == "parameters":
        result["provenance"]["parameters"]["radius_m"] = 500
    elif change == "solution":
        result["solution_id"] = "OTHER"
    elif change == "dem_bbox_missing":
        result["provenance"].pop("dem_bbox")
    elif change == "dem_bbox_shape":
        result["provenance"]["dem_bbox"] = [0, 1]
    elif change == "dem_bbox_type":
        result["provenance"]["dem_bbox"] = None
    else:
        raise AssertionError(change)


@pytest.mark.parametrize("change", ["schema", "field_metadata", "unit", "summary", "engine", "source", "parameters", "solution",
    "dem_bbox_missing", "dem_bbox_shape", "dem_bbox_type"])
def test_v6_invalid_engine_result_never_publishes_success(context, change):
    def compute(raw, tables, **kwargs):
        result = terrain_synthetic_result(raw, tables, **kwargs)
        corrupt_result(result, change)
        return result

    service = context.make(engine=compute)
    service.start()
    job, status = service.submit("P1", BODY, ACTOR)
    assert status == 202
    failed = terminal(service, job["job_id"])
    assert failed["state"] == "FAILED" and failed["error"]["code"] == "5002"
    assert failed["progress"] < 1 and service._job(job["job_id"])["result"] is None
    assert service.cache("P1", "T1", BODY["snapshot_id"], SMALL)["state"] == "MISS"


@pytest.mark.parametrize("change", ["digest", "schema", "field_metadata", "unit", "summary",
    "dem_bbox_missing", "dem_bbox_shape", "dem_bbox_type"])
def test_v6_persisted_result_is_strictly_validated_even_with_rehashed_tampering(context, change):
    service = context.make(engine=terrain_synthetic_result)
    service.start()
    record = completed(service)
    service.close()
    if change == "digest":
        record["result_sha256"] = "e" * 64
    else:
        corrupt_result(record["result"], change)
        record["result_sha256"] = module._hash(record["result"])
    path = service._path(record["job_id"])
    module._atomic(path, record)
    before = path.read_bytes()
    reopened = context.make(engine=lambda *a, **k: pytest.fail("损坏缓存不得触发重算"))
    with pytest.raises(module.CoverageServiceError) as error:
        reopened.cache("P1", "T1", BODY["snapshot_id"], SMALL)
    assert (error.value.code, error.value.status) == (5002, 503)
    assert path.read_bytes() == before


@pytest.mark.parametrize("case", [
    "test_request_replay_and_new_request_cache_hit_no_recompute",
    "test_worker_singleton_same_key_conflict_cancel_and_no_partial_cache",
    "test_failed_engine_and_progress_one_never_mean_success",
    "test_restart_marks_only_own_unfinished_job_interrupted_not_resumed",
])
def test_v6_preserves_existing_injected_compute_worker_contract(context, monkeypatch, case):
    # 旧生命周期断言原样复用；适配仅限本测试的合成结果，不放宽验证器。
    monkeypatch.setattr(legacy, "synthetic_result", terrain_synthetic_result)
    getattr(legacy, case)(context)


@pytest.mark.parametrize("change", ["actor", "body", "raw_equivalent"])
def test_v6_preserves_original_request_idempotency(context, monkeypatch, change):
    monkeypatch.setattr(legacy, "synthetic_result", terrain_synthetic_result)
    legacy.test_actor_bound_idempotency_uses_original_body(context, change)


@pytest.mark.parametrize("change", ["dem", "raw", "input", "resource"])
def test_v6_still_rechecks_source_before_publication(context, monkeypatch, change):
    monkeypatch.setattr(legacy, "synthetic_result", terrain_synthetic_result)
    legacy.test_changed_frozen_source_never_publishes_late_result(context, change)


def test_v6_atomic_publication_failure_keeps_cache_empty(context, monkeypatch):
    monkeypatch.setattr(legacy, "synthetic_result", terrain_synthetic_result)
    legacy.test_atomic_success_write_failure_preserves_failure_and_no_cache(context, monkeypatch)


@pytest.mark.parametrize("schema", [_Cache, _Latest])
def test_v6_cache_router_accepts_v1_through_v6_only(schema):
    anchor = {"task_id": "T1", "snapshot_id": BODY["snapshot_id"]}
    for version in module.ENGINE_VERSIONS:
        assert schema.model_validate({**anchor, "engine_version": version}).engine_version == version
    for version in ("V01-7", "", 6, True):
        with pytest.raises(ValidationError):
            schema.model_validate({**anchor, "engine_version": version})
    with pytest.raises(ValidationError):
        _Submit.model_validate({**BODY, "engine_version": "V01-5"})


@pytest.mark.parametrize("version", ["V01-7", "", 6, True])
def test_v6_service_rejects_unknown_history_versions(context, version):
    service = context.make(engine=terrain_synthetic_result)
    for read in (service.cache, service.latest_cache):
        with pytest.raises(module.CoverageServiceError) as error:
            read("P1", "T1", BODY["snapshot_id"], engine_version=version)
        assert (error.value.code, error.value.status) == (1001, 422)
    assert not service.root.exists()
