"""SQL-count and fail-closed gates; synthetic isolated databases, no live HTTP."""
from contextlib import contextmanager
from datetime import datetime, timezone
import gc

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from test_resource_observation_projection import MODELS, resource_fixture
from app import device_status_service as status
from app import resource_dataset_service as datasets
from app import resource_observation_projection as projection
from app.database import Base
from app.device_status_schemas import DeviceStatusImport, SCHEMA
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion


@pytest.fixture
def batch_factory(tmp_path, monkeypatch):
    engines = []
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")

    def build(size=414):
        engine = create_engine("sqlite:///" + str(tmp_path / ("batch-" + str(len(engines)) + ".sqlite")))
        engines.append(engine)
        Base.metadata.create_all(engine, tables=[model.__table__ for model in MODELS])
        factory = sessionmaker(bind=engine, expire_on_commit=False)
        source = resource_fixture()
        template = source["tables"]["device.csv"][0]
        source["tables"]["device.csv"] = [{**template, "device_id": "D" + str(index).zfill(4)}
            for index in range(size)]
        source["source_files"]["device.csv"]["sha256"] = datasets.content_hash(source["tables"]["device.csv"])
        content_hash = datasets.content_hash(source)
        revision = "resource-" + content_hash[:16]
        with factory.begin() as session:
            session.add(ResourceDatasetVersion(revision=revision, content_hash=content_hash, snapshot=source,
                source=datasets.SOURCE, data_origin=datasets.ORIGIN, created_at=datetime.now(timezone.utc)))
            session.flush()
            session.add(ResourceDatasetCurrent(scope=datasets.SCOPE, revision=revision))
        monkeypatch.setattr(status, "get_session_factory", lambda: factory)
        records = [{"device_id": row["device_id"], "node_id": "N1", "model_id": "M1",
            "status": (None, "NORMAL", "FAULT", "OFFLINE")[index % 4],
            "alert": None if index % 4 == 0 else index % 4 != 1,
            "observed_at": None, "unknown_reasons": ["SQL gate synthetic input; no observation time."]}
            for index, row in enumerate(source["tables"]["device.csv"])]
        request = DeviceStatusImport.model_validate({"schema_version": SCHEMA, "context": "ledger",
            "request_id": "sql-gate-" + str(len(engines)), "base_revision": revision,
            "data_origin": datasets.ORIGIN, "source_label": "Explicit SQL-count fixture",
            "provenance_note": "Unit-only synthetic data, not the live 132-node fixture.", "records": records})
        receipt = status.import_snapshot(request, "sql-gate-actor")
        items = [{**row, "status": "NORMAL", "alert": False, "observed_at": "2000-01-01T00:00:00Z"}
            for row in source["tables"]["device.csv"]]
        return factory, engine, revision, receipt, records, items

    yield build
    for engine in engines:
        engine.dispose()


@contextmanager
def selects(engine):
    statements = []

    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", capture)


@pytest.mark.parametrize("size", [1, 50, 414])
def test_resolver_select_count_is_constant_for_full_batch(batch_factory, size):
    factory, engine, revision, receipt, records, _ = batch_factory(size)
    requested = [record["device_id"] for record in reversed(records)]
    gc.collect()
    with factory() as session, selects(engine) as statements:
        header, result = status.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"], revision, requested)
    assert header["snapshot_id"] == receipt["snapshot_id"]
    assert [record["device_id"] for record in result] == requested
    assert len(statements) == 3
    assert sum("FROM device_status_records" in statement for statement in statements) == 1


@pytest.mark.parametrize("size", [1, 50, 414])
def test_projection_validates_once_with_one_record_select(batch_factory, monkeypatch, size):
    factory, engine, revision, receipt, records, items = batch_factory(size)
    decoded = []
    original_decode = datasets._decode

    def decode(version):
        decoded.append(version.revision)
        return original_decode(version)

    monkeypatch.setattr(datasets, "_decode", decode)
    with selects(engine) as statements:
        result, metadata = projection.project_device_items(items, revision, receipt["snapshot_id"], factory=factory)
    assert [item["status"] for item in result] == [record["status"] for record in records]
    assert metadata["snapshot_revision"] == receipt["snapshot_revision"]
    assert decoded == [revision]
    assert len(statements) == 3
    assert sum("FROM device_status_records" in statement for statement in statements) == 1


def test_resolver_preserves_requested_order_duplicates_and_independent_values(batch_factory):
    factory, _, revision, receipt, records, _ = batch_factory()
    requested = [records[-1]["device_id"], records[0]["device_id"], records[-1]["device_id"]]
    with factory() as session:
        _, result = status.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"], revision, requested)
    assert [record["device_id"] for record in result] == requested
    result[0]["unknown_reasons"].append("caller-only mutation")
    assert "caller-only mutation" not in result[-1]["unknown_reasons"]


@pytest.mark.parametrize("ids", [[], ["D0000", "missing"], ["missing", "D0413"]])
def test_empty_or_missing_members_never_form_a_partial_reference(batch_factory, ids):
    factory, _, revision, receipt, _, _ = batch_factory()
    with factory() as session:
        if not ids:
            _, result = status.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"], revision, ids)
            assert result == []
        else:
            with pytest.raises(status.DeviceStatusError) as error:
                status.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"], revision, ids)
            assert (error.value.code, error.value.status) == (1002, 404)


@pytest.mark.parametrize("target", ["resolver", "projection", "empty-projection"])
def test_later_unrequested_corruption_is_not_hidden_by_prior_success(batch_factory, target):
    factory, engine, revision, receipt, _, items = batch_factory()
    projection.project_device_items(items[:1], revision, receipt["snapshot_id"], factory=factory)
    with engine.begin() as connection:
        connection.execute(text("UPDATE device_status_records SET node_id='wrong-node' WHERE device_id='D0413'"))
    if target == "resolver":
        with factory() as session, pytest.raises(status.DeviceStatusError) as error:
            status.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"], revision, ["D0000"])
    else:
        with pytest.raises(datasets.ResourceDatasetError) as error:
            projection.project_device_items([] if target == "empty-projection" else items[:1], revision,
                receipt["snapshot_id"], factory=factory)
    assert (error.value.code, error.value.status) == (5002, 503)


@pytest.mark.parametrize("kind", ["snapshot", "resource", "projection-resource"])
def test_wrong_versions_still_reject_with_409(batch_factory, kind):
    factory, _, revision, receipt, _, items = batch_factory()
    if kind == "projection-resource":
        with pytest.raises(datasets.ResourceDatasetError) as error:
            projection.project_device_items(items, "wrong-resource", receipt["snapshot_id"], factory=factory)
        assert (error.value.code, error.value.status) == (1205, 409)
    else:
        with factory() as session, pytest.raises(status.DeviceStatusError) as error:
            status.resolve_snapshot(session, receipt["snapshot_id"], "wrong" if kind == "snapshot" else receipt["snapshot_revision"],
                "wrong" if kind == "resource" else revision, ["D0000"])
        assert (error.value.code, error.value.status) == (1203, 409)


@pytest.mark.parametrize("target", ["resolver", "projection"])
def test_same_caller_transaction_sees_uncommitted_corruption_and_rollback(batch_factory, target):
    factory, _, revision, receipt, _, items = batch_factory()

    @contextmanager
    def borrowed(session):
        yield session

    with factory() as session:
        session.execute(text("UPDATE device_status_records SET node_id='uncommitted' WHERE device_id='D0413'"))
        if target == "resolver":
            with pytest.raises(status.DeviceStatusError) as error:
                status.resolve_snapshot(session, receipt["snapshot_id"], receipt["snapshot_revision"], revision, ["D0000"])
        else:
            with pytest.raises(datasets.ResourceDatasetError) as error:
                projection.project_device_items(items[:1], revision, receipt["snapshot_id"], factory=lambda: borrowed(session))
        assert (error.value.code, error.value.status) == (5002, 503)
        session.rollback()
    result, _ = projection.project_device_items(items[:1], revision, receipt["snapshot_id"], factory=factory)
    assert result[0]["node_id"] == "N1" and result[0]["status"] is None
