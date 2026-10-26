"""补充只新增隔离资源版本；不连接运行库或覆盖真实型号原件。"""
from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
for path in (ROOT / "scripts", ROOT / "algorithm-service"):
    sys.path.insert(0, str(path))
import supplement_coverage_models as supplement
from app import resource_dataset_service as datasets
from app.database import Base
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetOperation, ResourceDatasetVersion


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "unit.sqlite"))
    Base.metadata.create_all(engine, tables=[model.__table__ for model in (
        ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation)])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    datasets.initialize()
    baseline = datasets.current()
    yield factory, baseline
    engine.dispose()


def totals(factory):
    with factory() as session:
        return [session.scalar(select(func.count()).select_from(model))
                for model in (ResourceDatasetVersion, ResourceDatasetOperation)]


def test_preview_does_not_change_database_or_source_files(isolated):
    factory, baseline = isolated
    original = (ROOT / "data/raw/equipment_docs/device_model.csv").read_bytes()
    result = supplement.supplement_models(baseline["revision"], "PREVIEW", "offline-test")
    assert result["preview_only"] and not result["changed"]
    assert result["applied_model_count"] == 4 and totals(factory) == [1, 0]
    assert datasets.current() == baseline
    assert (ROOT / "data/raw/equipment_docs/device_model.csv").read_bytes() == original


def test_apply_adds_only_four_model_fields_preserves_history_and_replays(isolated):
    factory, baseline = isolated
    result = supplement.supplement_models(baseline["revision"], "APPLY", "offline-test", apply=True)
    current = datasets.current()
    assert result["changed"] and result["revision"] == current["revision"] != baseline["revision"]
    assert result == supplement.supplement_models(baseline["revision"], "APPLY", "offline-test", apply=True)
    assert totals(factory) == [2, 1]
    with factory() as session:
        assert datasets._decode(session.get(ResourceDatasetVersion, baseline["revision"])) == baseline
    expected = deepcopy(baseline["tables"])
    for row in expected["device_model.csv"]:
        if row["model_id"] in supplement.MODEL_NAMES:
            row.update(bandwidth_khz="3", bandwidth_origin=supplement.ORIGIN,
                bandwidth_source_id=supplement.SOURCE_ID, bandwidth_source_sha256=result["source_sha256"],
                bandwidth_source_note=result["notice"], bandwidth_original_khz="")
    assert current["tables"] == expected
    assert current["source_files"] == baseline["source_files"]
    assert result["device_configuration_verified"] is False


def test_request_actor_conflict_and_stale_version_do_not_add_records(isolated):
    factory, baseline = isolated
    supplement.supplement_models(baseline["revision"], "APPLY", "offline-test", apply=True)
    for rid, actor, code in (("APPLY", "someone-else", 1206), ("NEW", "offline-test", 1205)):
        with pytest.raises(datasets.ResourceDatasetError) as exc:
            supplement.supplement_models(baseline["revision"], rid, actor, apply=True)
        assert exc.value.code == code
    assert totals(factory) == [2, 1]


def test_new_request_cannot_overwrite_already_supplemented_value(isolated):
    factory, baseline = isolated
    receipt = supplement.supplement_models(baseline["revision"], "FIRST", "offline-test", apply=True)
    with pytest.raises(datasets.ResourceDatasetError, match="已变化或已补充"):
        supplement.supplement_models(receipt["revision"], "SECOND", "offline-test", apply=True)
    assert totals(factory) == [2, 1]


@pytest.mark.parametrize("field,value", [("data_origin", "MEASURED"), ("unit", "Hz"),
    ("supplement_id", "OTHER"), ("schema_version", True), ("notice", "")])
def test_profile_identity_is_strict(tmp_path, monkeypatch, field, value):
    profile, _, _ = supplement.load_profile()
    profile[field] = value
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(profile), encoding="utf-8")
    monkeypatch.setattr(supplement, "PROFILE", path)
    with pytest.raises(ValueError):
        supplement.load_profile()


@pytest.mark.parametrize("value", [True, 0, -1, 25, float("nan"), float("inf"), "3"])
def test_supplement_value_cannot_expand_approved_assumption(tmp_path, monkeypatch, value):
    profile, _, _ = supplement.load_profile()
    profile["models"][0]["value_khz"] = value
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(profile), encoding="utf-8")
    monkeypatch.setattr(supplement, "PROFILE", path)
    with pytest.raises(ValueError):
        supplement.load_profile()


def test_database_path_guard_accepts_only_matching_existing_isolated_pair(tmp_path, monkeypatch):
    monkeypatch.setattr(supplement, "ROOT", tmp_path)
    runtime = tmp_path / "data/runtime/r2/r5-unit"
    runtime.mkdir(parents=True)
    database = tmp_path / "data/runtime/tmp/r5-unit/unit.sqlite"
    database.parent.mkdir(parents=True)
    database.touch()
    url = "sqlite:///" + database.as_posix()
    assert supplement.validate_database(str(runtime), url) == database
    for bad in ("sqlite:///:memory:", "sqlite:///" + str(tmp_path / "old.sqlite"), url + "?mode=ro"):
        with pytest.raises(ValueError):
            supplement.validate_database(str(runtime), bad)
    assert not (tmp_path / "old.sqlite").exists()


def test_fill_does_not_change_existing_planner_effective_bandwidths(isolated):
    _, baseline = isolated
    from devicespec import SpecFiller
    original = baseline["tables"]["device_model.csv"]
    before = {row["model_id"]: SpecFiller(original).bandwidth(row) for row in original}
    supplement.supplement_models(baseline["revision"], "BANDWIDTH", "offline-test", apply=True)
    current = datasets.current()["tables"]["device_model.csv"]
    after = {row["model_id"]: SpecFiller(current).bandwidth(row) for row in current}
    assert before == after


@pytest.mark.parametrize("raw", ["[]", "null", '{"schema_version":1,"schema_version":1}'])
def test_nonobject_or_duplicate_profile_is_rejected(tmp_path, monkeypatch, raw):
    path = tmp_path / "profile.json"
    path.write_text(raw, encoding="utf-8")
    monkeypatch.setattr(supplement, "PROFILE", path)
    with pytest.raises(ValueError):
        supplement.load_profile()


def test_existing_value_is_not_replaced_or_partially_supplemented(isolated):
    factory, baseline = isolated

    def original_value(snapshot):
        next(row for row in snapshot["tables"]["device_model.csv"]
             if row["model_id"] == "DM-0008")["bandwidth_khz"] = "2.4"
        return True, {"reason": "隔离测试已知原值"}

    changed = datasets.commit_device_change(baseline["revision"], "ORIGINAL", "test", "unit", original_value)
    before = datasets.current()
    with pytest.raises(datasets.ResourceDatasetError, match="DM-0008"):
        supplement.supplement_models(changed["revision"], "REFUSE", "offline-test", apply=True)
    assert datasets.current() == before and totals(factory) == [2, 1]
