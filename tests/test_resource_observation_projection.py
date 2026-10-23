"""新建小构造资源/真实P06批次，验证全库投影只读且不回退基线。"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app.database import Base
from app import device_status_service as status
from app import resource_dataset_service as datasets
from app import resource_observation_projection as projection
from app.device_status_models import DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation
from app.device_status_schemas import DeviceStatusImport, SCHEMA
from app.resource_dataset_models import ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation


MODELS = (ResourceDatasetVersion, ResourceDatasetCurrent, ResourceDatasetOperation,
          DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation)


def resource_fixture():
    # 来源清单明确为内存单测构造，不冒充真实设备文件或采集协议。
    tables = {name: [{field: "fixture-" + field}] for name, field in datasets.ID_FIELDS.items()}
    tables["node.csv"] = [{"node_id": "N1", "parent_node_id": "", "node_name": "单测构造节点"}]
    tables["device_model.csv"] = [{"model_id": "M1", "freq_min_khz": "1000", "freq_max_khz": "30000", "tx_power_max_dbm": "50"}]
    tables["antenna_model.csv"] = [{"antenna_id": "A1"}]
    tables["task_scenario.csv"] = [{"task_id": "T1"}]
    tables["comm_demand.csv"] = [{"demand_id": "C1", "task_id": "T1", "src_node_id": "N1", "dst_node_id": "N1"}]
    tables["device.csv"] = [{"device_id": device_id, "node_id": "N1", "model_id": "M1", "antenna_id": "A1",
        "availability": "OFF_SHELF" if device_id == "D2" else "ACTIVE", "tx_power_dbm": "0", "work_freq_khz": "0",
        "antenna_height_m": "0", "status": "NORMAL"} for device_id in ("D1", "D2", "D3")]
    return {"schema_version": 1, "tables": tables, "source_updated_at": "2026-10-20T00:00:00Z",
        "source_files": {name: {"path": "data/test-only-projection/" + name, "sha256": datasets.content_hash(rows)} for name, rows in tables.items()}}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    path = tmp_path / ("projection-" + uuid4().hex + ".sqlite")
    engine = create_engine("sqlite:///" + str(path))
    Base.metadata.create_all(engine, tables=[model.__table__ for model in MODELS])
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    monkeypatch.setattr(status, "get_session_factory", lambda: factory)
    snapshot = resource_fixture()
    digest = datasets.content_hash(snapshot)
    revision = "resource-" + digest[:16]
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=revision, content_hash=digest, snapshot=snapshot,
            source=datasets.SOURCE, data_origin=datasets.ORIGIN, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.add(ResourceDatasetCurrent(scope=datasets.SCOPE, revision=revision))
    yield factory, revision, path, engine
    engine.dispose()


def wire_items():
    return [{"device_id": device_id, "node_id": "N1", "model_id": "M1", "antenna_id": "A1",
        "availability": "OFF_SHELF" if device_id == "D2" else "ACTIVE", "status": "NORMAL", "alert": True,
        "observed_at": "1999-01-01T00:00:00Z", "tx_power_dbm": 0, "work_freq_khz": 0,
        "antenna_height_m": 0, "node_lon": 0, "node_lat": 0, "extra": {"source": ["构造台账，非观测"]}}
        for device_id in ("D1", "D2", "D3")]


def observations():
    return [
        {"device_id": "D1", "node_id": "N1", "model_id": "M1", "status": "FAULT", "alert": False,
         "observed_at": "2026-10-21T01:00:00+08:00", "unknown_reasons": []},
        {"device_id": "D2", "node_id": "N1", "model_id": "M1", "status": None, "alert": False,
         "observed_at": None, "unknown_reasons": ["构造来源未提供状态和采集时间"]},
        {"device_id": "D3", "node_id": "N1", "model_id": "M1", "status": "OFFLINE", "alert": None,
         "observed_at": "2026-10-21T00:00:00Z", "unknown_reasons": ["构造来源未提供告警"]},
    ]


def persist(isolated, records=None):
    _, revision, _, _ = isolated
    request = DeviceStatusImport.model_validate({"schema_version": SCHEMA, "context": "ledger", "request_id": "projection-" + uuid4().hex,
        "base_revision": revision, "data_origin": "SYNTHETIC_INTEGRATION", "source_label": "投影单测显式构造来源",
        "provenance_note": "非真实设备状态；缺采集时间保持未知", "records": observations() if records is None else records})
    return status.import_snapshot(request, "projection-test-actor")


def project(isolated, receipt, items=None, revision=None):
    factory, resource_revision, _, _ = isolated
    return projection.project_device_items(wire_items() if items is None else items, revision or resource_revision,
        receipt["snapshot_id"], factory=factory)


def test_full_snapshot_metadata_unknown_false_zero_and_originals_unchanged(isolated):
    receipt = persist(isolated)
    items = list(reversed(wire_items()))
    original = deepcopy(items)
    result, metadata = project(isolated, receipt, items)
    by_id = {item["device_id"]: item for item in result}
    assert by_id["D1"]["status"] == "FAULT" and by_id["D1"]["alert"] is False
    assert by_id["D1"]["observed_at"] == "2026-10-20T17:00:00.000000Z"
    assert by_id["D2"]["status"] is None and by_id["D2"]["alert"] is False and by_id["D2"]["observed_at"] is None
    assert by_id["D2"]["availability"] == "OFF_SHELF" and by_id["D3"]["alert"] is None
    assert metadata == {"snapshot_id": receipt["snapshot_id"], "snapshot_revision": receipt["snapshot_revision"],
        "resource_revision": isolated[1], "data_origin": "SYNTHETIC_INTEGRATION", "source_label": "投影单测显式构造来源"}
    assert result is not items and items == original
    for index, (before, after) in enumerate(zip(original, result)):
        assert {key: value for key, value in before.items() if key not in ("status", "alert", "observed_at")} == {
            key: value for key, value in after.items() if key not in ("status", "alert", "observed_at")}
        assert after["tx_power_dbm"] == after["work_freq_khz"] == after["antenna_height_m"] == 0
        assert after is not items[index]
    result[0]["extra"]["source"].append("only output")
    assert items == original


def test_partial_snapshot_does_not_require_full_resource_members_or_fall_back(isolated):
    receipt = persist(isolated, observations()[:1])
    result, _ = project(isolated, receipt)
    assert result[0]["status"] == "FAULT"
    for item in result[1:]:
        assert item["status"] is None and item["alert"] is None and item["observed_at"] is None
    assert result[1]["availability"] == "OFF_SHELF"
    page, _ = project(isolated, receipt, wire_items()[1:])
    assert page == result[1:]


def test_empty_items_still_validate_real_snapshot_and_return_header(isolated):
    receipt = persist(isolated)
    result, metadata = project(isolated, receipt, [])
    assert result == [] and metadata["snapshot_revision"] == receipt["snapshot_revision"]


def test_all_unknown_record_does_not_invent_observation_time(isolated):
    record = {**observations()[0], "status": None, "alert": None, "observed_at": None, "unknown_reasons": ["所有观测字段均未提供"]}
    receipt = persist(isolated, [record])
    result, _ = project(isolated, receipt)
    assert all(item[field] is None for item in result for field in ("status", "alert", "observed_at"))
    assert receipt["imported_at"] is not None


def test_wrong_resource_version_raises_1205_and_does_not_mutate_items(isolated):
    receipt = persist(isolated)
    items = wire_items()
    with pytest.raises(datasets.ResourceDatasetError) as error:
        project(isolated, receipt, items, "resource-0000000000000000")
    assert (error.value.code, error.value.status) == (1205, 409)
    assert items == wire_items()


def test_missing_snapshot_raises_1002_even_for_empty_items(isolated):
    with pytest.raises(datasets.ResourceDatasetError) as error:
        project(isolated, {"snapshot_id": "DSS-" + "0" * 32}, [])
    assert (error.value.code, error.value.status) == (1002, 404)


@pytest.mark.parametrize("statement", [
    "UPDATE device_status_snapshots SET content_hash='bad'",
    "UPDATE device_status_snapshots SET header_hash='bad'",
    "UPDATE device_status_snapshots SET original_input='{}'",
    "UPDATE device_status_snapshots SET resource_content_hash='bad'",
    "UPDATE device_status_records SET status='NORMAL' WHERE device_id='D3'",
    "UPDATE device_status_records SET node_id='wrong-node' WHERE device_id='D3'",
    "UPDATE device_status_records SET observed_at='2026-10-23T00:00:00Z' WHERE device_id='D3'",
])
def test_bad_batch_including_unrequested_record_is_rejected(isolated, statement):
    receipt = persist(isolated)
    with isolated[3].begin() as connection:
        connection.execute(text(statement))
    items = wire_items()[:1]
    with pytest.raises(datasets.ResourceDatasetError) as error:
        project(isolated, receipt, items)
    assert (error.value.code, error.value.status) == (5002, 503)
    assert items == wire_items()[:1]


def test_projection_emits_only_selects_and_preserves_all_tables(isolated):
    receipt = persist(isolated)
    factory, _, _, engine = isolated
    with factory() as session:
        before = [session.scalar(select(func.count()).select_from(model)) for model in MODELS]
    statements = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement.lstrip().upper())
    event.listen(engine, "before_cursor_execute", capture)
    try:
        project(isolated, receipt)
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert statements and all(statement.startswith("SELECT") for statement in statements)
    with factory() as session:
        after = [session.scalar(select(func.count()).select_from(model)) for model in MODELS]
    assert before == after == [1, 1, 0, 1, 3, 1]


def test_new_connection_reads_same_frozen_result_after_current_resource_changes(isolated):
    receipt = persist(isolated)
    first = project(isolated, receipt)
    factory, revision, path, _ = isolated
    later = resource_fixture()
    later["tables"]["device.csv"][0]["tx_power_dbm"] = "10"
    digest = datasets.content_hash(later)
    current_revision = "resource-" + digest[:16]
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=current_revision, content_hash=digest, snapshot=later,
            source=datasets.SOURCE, data_origin=datasets.ORIGIN, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = current_revision
    reader_engine = create_engine("sqlite:///" + str(path))
    reader_factory = sessionmaker(bind=reader_engine, expire_on_commit=False)
    try:
        assert projection.project_device_items(wire_items(), revision, receipt["snapshot_id"], factory=reader_factory) == first
    finally:
        reader_engine.dispose()


def test_default_factory_is_injectable_and_does_not_open_status_service_factory(isolated, monkeypatch):
    receipt = persist(isolated)
    calls = []
    def provided():
        calls.append("factory")
        return isolated[0]
    def forbidden():
        raise AssertionError("resolver must reuse supplied session")
    monkeypatch.setattr(projection, "get_session_factory", provided)
    monkeypatch.setattr(status, "get_session_factory", forbidden)
    result, metadata = projection.project_device_items(wire_items(), isolated[1], receipt["snapshot_id"])
    assert calls == ["factory"] and result[0]["status"] == "FAULT" and metadata["snapshot_id"] == receipt["snapshot_id"]
