"""共享入口及迁移链验证，只向本轮新建的项目内测试库写入。"""
from pathlib import Path
import sys

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))

from app import database, resource_dataset_service as resources
from app.main import app
from app.observation_models import ObservationDataset, ObservationFrame, ObservationImportOperation

HEAD = "0018_observations"
NEW_TABLES = {"interference_frontend_scenes", "interference_frontend_scene_versions",
    "interference_frontend_scene_receipts", "device_configuration_requests",
    "observation_datasets", "observation_frames", "observation_import_operations"}


def migration_config():
    return Config(str(ROOT / "algorithm-service/alembic.ini"))


@pytest.fixture
def migrated(tmp_path, monkeypatch):
    assert (ROOT / "data/runtime/tmp").resolve() in tmp_path.resolve().parents
    path = tmp_path / "integration.sqlite"
    assert not path.exists()
    database.reset_database_state_for_tests()
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + path.as_posix())
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    monkeypatch.setenv("FRONTEND_INTEGRATION_DEMO", "1")
    command.upgrade(migration_config(), "head")
    yield database.get_engine()
    database.reset_database_state_for_tests()


def test_empty_upgrade_single_head_metadata_and_observation_triggers(migrated):
    assert ScriptDirectory.from_config(migration_config()).get_heads() == [HEAD]
    assert NEW_TABLES <= set(inspect(migrated).get_table_names())
    command.check(migration_config())
    with migrated.begin() as connection:
        triggers = connection.execute(text("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'observation_%'")).scalars().all()
        assert len(triggers) == 6
        connection.execute(ObservationDataset.__table__.insert().values(dataset_id="test-observation",
            dataset_revision="test-revision", schema_version=1, data_origin="SYNTHETIC_INTEGRATION",
            content_hash="a" * 64, metadata_hash="b" * 64, resource_revision="test-source",
            provenance_note="仅验证迁移触发器的构造测试，不是实测", source_snapshot={},
            device_status_snapshot_id=None, frame_count=1, first_observed_at=None,
            last_observed_at=None, actor_id="test-editor", imported_at="2026-10-23T00:00:00Z"))
        connection.execute(ObservationFrame.__table__.insert().values(dataset_id="test-observation",
            frame_index=0, frame_id="test-frame", frame_payload={}, frame_hash="c" * 64))
        connection.execute(ObservationImportOperation.__table__.insert().values(request_id="test-request",
            request_digest="d" * 64, actor_id="test-editor", dataset_id="test-observation",
            receipt={}, created_at="2026-10-23T00:00:00Z"))
    # 仅对新建测试库验证 SQL 写保护；失败事务不删除或修改已有证据。
    for table in ("observation_datasets", "observation_frames", "observation_import_operations"):
        for sql in (f"UPDATE {table} SET dataset_id=dataset_id", f"DELETE FROM {table}"):
            with pytest.raises(IntegrityError, match="immutable"):
                with migrated.begin() as connection:
                    connection.execute(text(sql))


def test_existing_0015_upgrade_preserves_resource_snapshot(tmp_path, monkeypatch):
    assert (ROOT / "data/runtime/tmp").resolve() in tmp_path.resolve().parents
    path = tmp_path / "before-0015.sqlite"
    assert not path.exists()
    database.reset_database_state_for_tests()
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + path.as_posix())
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    try:
        command.upgrade(migration_config(), "0015_resource_device_changes")
        resources.initialize()
        before = resources.current()
        command.upgrade(migration_config(), "head")
        assert resources.current() == before
        command.check(migration_config())
        with database.get_engine().connect() as connection:
            assert connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == HEAD
    finally:
        database.reset_database_state_for_tests()


def _session_headers(client):
    identity = client.get("/api/v1/auth/session").json()["data"]
    challenge = client.get("/api/v1/auth/csrf").json()["data"]
    return {"X-Session-Id": identity["session_id"], "X-CSRF-Token": challenge["csrf_token"]}


def _switch(client, account):
    response = client.post("/api/v1/auth/integration/switch", json={"accountId": account}, headers=_session_headers(client))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_main_router_permissions_resource_version_and_unknown_observations(migrated):
    resources.initialize()
    original = resources.current()
    revision = original["revision"]
    with TestClient(app) as client:
        paths = set(app.openapi()["paths"])
        assert {"/api/v1/gis/plans/{plan_id}/network", "/api/v1/interference/scenes/{scene_id}",
            "/api/v1/resource/frequency-resources/disable", "/api/v1/device-configurations/context",
            "/api/v1/observations/spectrum/context"} <= paths
        query = {"context": "ledger", "revision": revision}
        frequency = client.get("/api/v1/resource/frequency-resources", params=query)
        assert frequency.status_code == 200, frequency.text
        assert len(frequency.json()["data"]["items"]) == 105
        selected = next(row["freq_id"] for row in frequency.json()["data"]["items"] if row["is_available"])
        payload = {**query, "ids": [selected]}
        denied = client.post("/api/v1/resource/frequency-resources/disable/validate", json=payload, headers=_session_headers(client))
        assert (denied.status_code, denied.json()["code"]) == (403, 1104)
        editor = _switch(client, "integration-editor")
        assert "resources.frequency.disable" in editor["permissions"]
        assert "resources.edit" not in editor["permissions"]
        headers = _session_headers(client)
        preview = client.post("/api/v1/resource/frequency-resources/disable/validate", json=payload, headers=headers)
        assert preview.status_code == 200, preview.text
        assert resources.current() == original
        change = {"context": "ledger", "base_revision": revision, "request_id": "int-frequency-disable", "ids": [selected]}
        saved = client.post("/api/v1/resource/frequency-resources/disable", json=change, headers=headers)
        assert saved.status_code == 200, saved.text
        replay = client.post("/api/v1/resource/frequency-resources/disable", json=change, headers=headers)
        assert replay.json() == saved.json()
        assert resources.current()["revision"] != revision
        stale = client.get("/api/v1/resource/frequency-resources", params=query)
        assert (stale.status_code, stale.json()["code"]) == (409, 1205)
        reviewer = _switch(client, "integration-reviewer")
        assert "resources.frequency.disable" not in reviewer["permissions"]
        observed = client.get("/api/v1/observations/spectrum/context", headers=_session_headers(client))
        assert observed.status_code == 200, observed.text
        assert observed.json()["data"]["datasetCount"] == 0
        assert observed.json()["data"]["selected"] is None
        missing = client.get("/api/v1/gis/plans/no-plan/network", params={"context": "gis", "task_id": "no-task"})
        assert (missing.status_code, missing.json()["code"]) == (404, 2001)
