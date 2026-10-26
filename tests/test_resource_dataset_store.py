"""资源快照存储及错误边界；全部使用隔离测试库。"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sys

import pytest
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import frontend_integration as frontend, resource_dataset_service as datasets
from app.resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from app.database import Base


@pytest.fixture
def resource_db(tmp_path, monkeypatch):
    path = tmp_path / "resources.sqlite"
    engine = create_engine("sqlite:///" + str(path), connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(datasets, "get_session_factory", lambda: factory)
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    yield factory, engine, path
    engine.dispose()


def add_test_version(factory, old):
    # 只在隔离库构造第二版本，不提供资源修改业务接口。
    snapshot = {key: deepcopy(old[key]) for key in ("schema_version", "tables", "source_files", "source_updated_at")}
    snapshot["tables"]["node.csv"][0]["node_name"] = "隔离库新资源名称"
    digest = datasets.content_hash(snapshot)
    revision = "resource-" + digest[:16]
    with factory.begin() as session:
        session.add(ResourceDatasetVersion(revision=revision, snapshot=snapshot, content_hash=digest,
            data_origin=datasets.ORIGIN, source=datasets.SOURCE, created_at=datetime.now(timezone.utc)))
        session.flush()
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = revision
    return revision


def test_initialization_preserves_revision_rows_and_restart(resource_db, monkeypatch):
    factory, engine, path = resource_db
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "file")
    revision = frontend.resource_revision()
    original = {name: frontend._rows(name) for name in frontend.DATA_FILES}
    result = datasets.initialize()
    assert result["changed"] and result["revision"] == revision
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    assert frontend.resource_revision() == revision
    assert all(frontend._rows(name) == rows for name, rows in original.items())
    assert len(result["tables"]) == 10 and result["data_origin"] == "SYNTHETIC_INTEGRATION"
    monkeypatch.setattr(datasets, "capture_files", lambda: pytest.fail("重复初始化不应读取文件"))
    assert datasets.initialize()["changed"] is False
    with factory() as session:
        assert session.scalar(select(func.count()).select_from(ResourceDatasetVersion)) == 1
    engine.dispose()
    reopened = create_engine("sqlite:///" + str(path))
    try:
        value = datasets.current(sessionmaker(bind=reopened))
        assert value["revision"] == revision and value["content_hash"] == result["content_hash"]
    finally:
        reopened.dispose()


def test_missing_baseline_has_no_file_fallback(resource_db):
    with pytest.raises(datasets.ResourceDatasetError) as error:
        frontend.resource_revision()
    assert error.value.code == 5003 and error.value.status == 503


def test_missing_migration_and_invalid_mode(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///" + str(tmp_path / "unmigrated.sqlite"))
    monkeypatch.setattr(datasets, "get_session_factory", lambda: sessionmaker(bind=engine))
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "database")
    try:
        with pytest.raises(datasets.ResourceDatasetError, match="禁止回退文件"):
            frontend._rows("nodes")
    finally:
        engine.dispose()
    monkeypatch.setenv("RESOURCE_DATASET_MODE", "typo")
    with pytest.raises(datasets.ResourceDatasetError) as error:
        frontend.resource_revision()
    assert error.value.code == 5001


@pytest.mark.parametrize("action", ["update", "delete"])
def test_immutable_history(resource_db, action):
    factory, _, _ = resource_db
    revision = datasets.initialize()["revision"]
    with pytest.raises(ValueError, match="不可修改或删除"):
        with factory.begin() as session:
            row = session.get(ResourceDatasetVersion, revision)
            if action == "update":
                row.source = "不得覆盖"
            else:
                session.delete(row)
    assert datasets.current()["revision"] == revision


def test_corrupted_hash_is_rejected(resource_db):
    factory, _, _ = resource_db
    revision = datasets.initialize()["revision"]
    # 模拟绕过应用损坏的数据库，不能补成文件读取成功。
    with factory.begin() as session:
        session.execute(update(ResourceDatasetVersion).where(ResourceDatasetVersion.revision == revision).values(content_hash="0" * 64))
    with pytest.raises(datasets.ResourceDatasetError, match="校验失败"):
        frontend._rows("nodes")


def test_request_scope_and_frozen_inputs(resource_db):
    factory, _, _ = resource_db
    old = datasets.initialize()
    with datasets.read_scope():
        assert datasets.current()["revision"] == old["revision"]
        frozen = datasets.algorithm_tables(old["revision"])
        original_name = frontend._rows("nodes")[0]["node_name"]
        frontend._rows("nodes")[0]["node_name"] = "不应修改缓存"
        new_revision = add_test_version(factory, old)
        assert frontend.resource_revision() == old["revision"]
        assert frontend._rows("nodes")[0]["node_name"] == original_name
    assert frontend.resource_revision() == new_revision
    assert frozen["node.csv"][0]["node_name"] == original_name
    with pytest.raises(datasets.ResourceDatasetError) as error:
        datasets.algorithm_tables(old["revision"])
    assert error.value.code == 1205


@pytest.mark.parametrize("kind", ["missing", "duplicate", "device", "parent", "demand", "time", "time-naive", "manifest"])
def test_broken_snapshot_rejected(resource_db, kind):
    value = datasets.initialize()
    snapshot = deepcopy(value)
    if kind == "missing":
        snapshot["tables"].pop("device.csv")
    if kind == "duplicate":
        snapshot["tables"]["node.csv"].append(snapshot["tables"]["node.csv"][0])
    if kind == "device":
        snapshot["tables"]["device.csv"][0]["model_id"] = "absent"
    if kind == "parent":
        snapshot["tables"]["node.csv"][0]["parent_node_id"] = "absent"
    if kind == "demand":
        snapshot["tables"]["comm_demand.csv"][0]["task_id"] = "absent"
    if kind == "time":
        snapshot["source_updated_at"] = "not-a-time"
    if kind == "time-naive":
        snapshot["source_updated_at"] = "2026-10-23T12:00:00"
    if kind == "manifest":
        snapshot["source_files"].pop("node.csv")
    with pytest.raises(datasets.ResourceDatasetError):
        datasets._validate_snapshot(snapshot)


def test_broken_pointer_is_not_reported_as_uninitialized(resource_db):
    factory, _, _ = resource_db
    datasets.initialize()
    with factory.begin() as session:
        session.get(ResourceDatasetCurrent, datasets.SCOPE).revision = "resource-" + "0" * 16
    with pytest.raises(datasets.ResourceDatasetError) as error:
        datasets.current()
    assert error.value.code == 5002
