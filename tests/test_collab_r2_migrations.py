"""R2 正式单链迁移：只在新测试库中验证历史保留及不可变 SQL。"""
from datetime import datetime, timezone
from pathlib import Path
import sys
from uuid import uuid4

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
import pytest
import sqlalchemy as sa

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app.database import Base
from app.observation_models import OBSERVATION_METADATA
from app.spectrum_source_models import SPECTRUM_SOURCE_METADATA

EXPECTED_HEAD = "0020_spectrum_sources"


def setup_database(tmp_path, monkeypatch):
    url = "sqlite:///" + str(tmp_path / (uuid4().hex + ".sqlite"))
    monkeypatch.setenv("DATABASE_URL", url)
    return Config(str(ROOT / "algorithm-service/alembic.ini")), sa.create_engine(url)


def seed_status(engine):
    metadata = sa.MetaData()
    metadata.reflect(engine)
    now, identifier = datetime.now(timezone.utc), str(uuid4())
    rows = {
        "device_status_snapshots": {"snapshot_id": identifier, "snapshot_revision": "dss-" + "a" * 64,
            "content_hash": "a" * 64, "resource_revision": "resource-" + "b" * 16, "resource_content_hash": "b" * 64,
            "data_origin": "SYNTHETIC_INTEGRATION", "source_label": "migration fixture",
            "provenance_note": "explicit synthetic migration fixture, not observations", "actor_id": "test-actor", "imported_at": now,
            "total": 1, "counts": {"UNKNOWN": 1}, "first_observed_at": None, "last_observed_at": None,
            "original_input": {"test_only": True}, "header_hash": "c" * 64},
        "device_status_records": {"snapshot_id": identifier, "device_id": "DV-test", "node_id": "ND-test", "model_id": "DM-test",
            "availability": "ACTIVE", "status": None, "alert": None, "observed_at": None, "unknown_reasons": ["not provided"]},
        "device_status_import_operations": {"request_id": str(uuid4()), "request_digest": "d" * 64,
            "actor_id": "test-actor", "snapshot_id": identifier, "receipt": {"test_only": True}, "created_at": now},
    }
    with engine.begin() as connection:
        for table, row in rows.items():
            connection.execute(metadata.tables[table].insert().values(**row))
    return metadata, rows


def test_empty_database_single_head_matches_models(tmp_path, monkeypatch):
    config, engine = setup_database(tmp_path, monkeypatch)
    try:
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert connection.execute(sa.text("select version_num from alembic_version")).scalars().all() == [EXPECTED_HEAD]
            assert compare_metadata(MigrationContext.configure(connection, opts={"compare_type": True}), [Base.metadata, OBSERVATION_METADATA, SPECTRUM_SOURCE_METADATA]) == []
            triggers = connection.execute(sa.text("select name from sqlite_master where type='trigger' and name like 'device_status_%'")).scalars().all()
            assert len(triggers) == 6
            for table in ("device_status_snapshots", "device_status_records", "device_status_import_operations"):
                assert connection.execute(sa.text("select count(*) from " + table)).scalar_one() == 0
    finally:
        engine.dispose()


def test_upgrade_keeps_0018_constructed_history_and_repeated_upgrade_is_noop(tmp_path, monkeypatch):
    config, engine = setup_database(tmp_path, monkeypatch)
    try:
        command.upgrade(config, "0018_observations")
        metadata = sa.MetaData()
        metadata.reflect(engine)
        table = metadata.tables["observation_datasets"]
        row = {"dataset_id": "migration-fixture", "dataset_revision": "migration-fixture-v1", "schema_version": 1,
            "data_origin": "SYNTHETIC_INTEGRATION", "content_hash": "a" * 64, "metadata_hash": "b" * 64,
            "resource_revision": "resource-" + "c" * 16, "provenance_note": "migration-only fixture",
            "source_snapshot": {"test_only": True}, "device_status_snapshot_id": None, "frame_count": 1,
            "first_observed_at": None, "last_observed_at": None, "actor_id": "test-actor", "imported_at": "2026-10-23T00:00:00Z"}
        with engine.begin() as connection:
            connection.execute(table.insert().values(**row))
        command.upgrade(config, "head")
        command.upgrade(config, "head")
        with engine.connect() as connection:
            assert dict(connection.execute(table.select()).mappings().one()) == row
            assert connection.execute(sa.text("select count(*) from sqlite_master where type='trigger' and name like 'observation_%'")).scalar_one() == 6
    finally:
        engine.dispose()


@pytest.mark.parametrize("table", ["device_status_snapshots", "device_status_records", "device_status_import_operations"])
@pytest.mark.parametrize("operation", ["UPDATE", "DELETE"])
def test_status_history_cannot_be_mutated_with_direct_sql(tmp_path, monkeypatch, table, operation):
    config, engine = setup_database(tmp_path, monkeypatch)
    try:
        command.upgrade(config, "head")
        metadata, rows = seed_status(engine)
        statement = metadata.tables[table].update().values(**rows[table]) if operation == "UPDATE" else metadata.tables[table].delete()
        with pytest.raises(sa.exc.IntegrityError, match="immutable device status"):
            with engine.begin() as connection:
                connection.execute(statement)
        with engine.connect() as connection:
            assert connection.execute(sa.select(sa.func.count()).select_from(metadata.tables[table])).scalar_one() == 1
    finally:
        engine.dispose()


def test_destructive_downgrade_is_refused(tmp_path, monkeypatch):
    config, engine = setup_database(tmp_path, monkeypatch)
    try:
        command.upgrade(config, "head")
        with pytest.raises(RuntimeError, match="不允许破坏性降级"):
            command.downgrade(config, "0018_observations")
        with engine.connect() as connection:
            assert connection.execute(sa.text("select version_num from alembic_version")).scalar_one() == EXPECTED_HEAD
    finally:
        engine.dispose()


@pytest.mark.parametrize("table", ["spectrum_source_versions", "spectrum_source_operations"])
@pytest.mark.parametrize("operation", ["UPDATE", "DELETE"])
def test_spectrum_history_is_immutable_but_current_pointer_is_not(tmp_path, monkeypatch, table, operation):
    config, engine = setup_database(tmp_path, monkeypatch)
    try:
        command.upgrade(config, "head")
        metadata = sa.MetaData()
        metadata.reflect(engine)
        versions, current, operations = (metadata.tables[name] for name in (
            "spectrum_source_versions", "spectrum_source_current", "spectrum_source_operations"))
        row = {"config_revision": "source-test-v1", "source_id": "source-test", "schema_version": 1,
            "data_origin": "SYNTHETIC_INTEGRATION", "content_hash": "a" * 64, "snapshot": {"test_only": True},
            "actor_id": "test-actor", "created_at": "2026-10-23T00:00:00Z"}
        with engine.begin() as connection:
            connection.execute(versions.insert().values(**row))
            connection.execute(versions.insert().values(**{**row, "config_revision": "source-test-v2", "content_hash": "b" * 64}))
            connection.execute(current.insert().values(source_id="source-test", config_revision="source-test-v1"))
            connection.execute(operations.insert().values(request_id="request-test", operation_type="SOURCE_SAVE",
                request_digest="c" * 64, actor_id="test-actor", source_id="source-test", config_revision="source-test-v1",
                receipt={"test_only": True}, created_at="2026-10-23T00:00:00Z"))
            connection.execute(current.update().values(config_revision="source-test-v2"))
        target = metadata.tables[table]
        statement = target.update().values(actor_id="altered") if operation == "UPDATE" else target.delete()
        with pytest.raises(sa.exc.IntegrityError, match="spectrum source history is immutable"):
            with engine.begin() as connection:
                connection.execute(statement)
        with engine.connect() as connection:
            assert connection.execute(sa.select(current.c.config_revision)).scalar_one() == "source-test-v2"
    finally:
        engine.dispose()
