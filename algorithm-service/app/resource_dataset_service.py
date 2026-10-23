"""构造资源初始化、同版读取及 SR4 冻结输入；数据库模式禁止文件降级。"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from .database import DatabaseConfigurationError, get_session_factory
from .resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetOperation, ResourceDatasetVersion

ROOT = Path(__file__).resolve().parents[2]
SCOPE = "project"
ORIGIN = "SYNTHETIC_INTEGRATION"
SOURCE = "项目构造资源基线，非生产、非实测"
PRIMARY_NAMES = {
    "nodes": "node.csv", "devices": "device.csv", "models": "device_model.csv",
    "antennas": "antenna_model.csv", "frequencies": "frequency_resource.csv",
    "interferences": "interference_source.csv",
}
EXTRA_NAMES = ("task_scenario.csv", "comm_demand.csv", "link_metric.csv", "candidate_site.csv")
ID_FIELDS = dict(zip((*PRIMARY_NAMES.values(), *EXTRA_NAMES), (
    "node_id", "device_id", "model_id", "antenna_id", "freq_id", "interference_id",
    "task_id", "demand_id", "record_id", "site_id")))
_scope: ContextVar[dict | None] = ContextVar("resource_dataset_read", default=None)


class ResourceDatasetError(RuntimeError):
    def __init__(self, message, code=5002, status=503):
        super().__init__(message)
        self.code, self.status = code, status


def database_mode():
    mode = os.environ.get("RESOURCE_DATASET_MODE", "file")
    if mode not in ("file", "database"):
        raise ResourceDatasetError("RESOURCE_DATASET_MODE 只能为 file 或 database", 5001)
    return mode == "database"


@contextmanager
def read_scope():
    # 可变容器随请求上下文传入同步路由线程，各请求之间不共享缓存。
    token = _scope.set({})
    try:
        yield
    finally:
        _scope.reset(token)


def content_hash(snapshot):
    raw = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get("schema_version") != 1:
        raise ResourceDatasetError("资源快照结构无效")
    tables = snapshot.get("tables")
    if not isinstance(tables, dict) or set(tables) != set(ID_FIELDS):
        raise ResourceDatasetError("资源快照缺少完整输入表")
    manifest = snapshot.get("source_files")
    if not isinstance(manifest, dict) or set(manifest) != set(ID_FIELDS) or any(
        not isinstance(item, dict) or not isinstance(item.get("path"), str)
        or not item["path"].startswith("data/")
        or not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
        for item in manifest.values()
    ):
        raise ResourceDatasetError("资源来源清单无效")
    ids = {}
    for name, field in ID_FIELDS.items():
        rows = tables[name]
        if not isinstance(rows, list) or not rows or any(
            not isinstance(row, dict) or not row.get(field)
            or any(not isinstance(key, str) or not isinstance(value, str) for key, value in row.items())
            for row in rows
        ):
            raise ResourceDatasetError("资源输入表无效：" + name)
        ids[name] = {row[field] for row in rows}
        if len(ids[name]) != len(rows):
            raise ResourceDatasetError("资源输入表编号重复：" + name)
    for row in tables["device.csv"]:
        # 旧基线缺少生命周期字段时沿用在架；显式非法值不能降级为可用。
        if row.get("availability", "ACTIVE") not in ("ACTIVE", "OFF_SHELF"):
            raise ResourceDatasetError("设备上下架状态无效")
        if any(row.get(field) not in ids[name] for field, name in (
            ("node_id", "node.csv"), ("model_id", "device_model.csv"), ("antenna_id", "antenna_model.csv")
        )):
            raise ResourceDatasetError("设备所属节点、型号或天线关联无效")
    for row in tables["node.csv"]:
        if any(parent not in ids["node.csv"] for parent in row.get("parent_node_id", "").split(";") if parent):
            raise ResourceDatasetError("节点父级关联无效")
    for row in tables["comm_demand.csv"]:
        if row.get("task_id") not in ids["task_scenario.csv"] or any(
            row.get(field) not in ids["node.csv"] for field in ("src_node_id", "dst_node_id")
        ):
            raise ResourceDatasetError("基线通联需求关联无效")
    try:
        stamp = datetime.fromisoformat(snapshot["source_updated_at"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            raise ValueError("缺少时区")
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise ResourceDatasetError("资源来源时间无效") from exc


def capture_files():
    """仅显式初始化时读取原件；业务版本沿用现有六类文件的字节摘要。"""
    from .frontend_integration import DATA_FILES
    scripts = str(ROOT / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from datapaths import path
    files = {PRIMARY_NAMES[key]: value for key, value in DATA_FILES.items()}
    files.update({name: Path(path(name)) for name in EXTRA_NAMES})
    raw = {name: value.read_bytes() for name, value in files.items()}
    legacy = hashlib.sha256()
    for key, value in DATA_FILES.items():
        legacy.update(value.name.encode("utf-8"))
        legacy.update(raw[PRIMARY_NAMES[key]])
    tables = {}
    for name, data in raw.items():
        reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""))
        if not reader.fieldnames or len(reader.fieldnames) != len(set(reader.fieldnames)):
            raise ResourceDatasetError("资源文件表头无效：" + name)
        tables[name] = list(reader)
    snapshot = {
        "schema_version": 1, "tables": tables,
        "source_files": {name: {"path": str(value.relative_to(ROOT)).replace("\\", "/"),
            "sha256": hashlib.sha256(raw[name]).hexdigest()} for name, value in files.items()},
        "source_updated_at": datetime.fromtimestamp(
            max(value.stat().st_mtime for value in DATA_FILES.values()), timezone.utc
        ).isoformat().replace("+00:00", "Z"),
    }
    if any(value.read_bytes() != raw[name] for name, value in files.items()):
        raise ResourceDatasetError("导入期间来源文件发生变化，请重试", 1205, 409)
    _validate_snapshot(snapshot)
    return "resource-" + legacy.hexdigest()[:16], snapshot


def _decode(row):
    if row is None:
        raise ResourceDatasetError("资源基线尚未初始化，请先运行 scripts/init_resource_dataset.py", 5003)
    if row.data_origin != ORIGIN or row.source != SOURCE or not re.fullmatch(r"resource-[0-9a-f]{16}", row.revision):
        raise ResourceDatasetError("资源版本来源或标识无效")
    try:
        valid_hash = content_hash(row.snapshot) == row.content_hash
    except (TypeError, ValueError) as exc:
        raise ResourceDatasetError("资源快照校验失败") from exc
    if not valid_hash:
        raise ResourceDatasetError("资源快照内容校验失败，禁止回退文件")
    _validate_snapshot(row.snapshot)
    return {"revision": row.revision, "content_hash": row.content_hash, "source": row.source,
            "data_origin": row.data_origin, **deepcopy(row.snapshot)}


def current(factory=None):
    cached = _scope.get() if factory is None else None
    if cached is not None and "current" in cached:
        return cached["current"]
    try:
        with (factory or get_session_factory())() as session:
            pointer = session.get(ResourceDatasetCurrent, SCOPE)
            row = session.get(ResourceDatasetVersion, pointer.revision) if pointer else None
            if pointer is not None and row is None:
                raise ResourceDatasetError("当前资源指针引用的快照不存在")
            result = _decode(row)
    except DatabaseConfigurationError as exc:
        raise ResourceDatasetError("DATABASE_URL 未配置", 5001) from exc
    except SQLAlchemyError as exc:
        raise ResourceDatasetError("资源数据库不可用，请检查连接及 0014 迁移；禁止回退文件") from exc
    if cached is not None:
        cached["current"] = result
    return result


def algorithm_tables(expected_revision):
    snapshot = current()
    if snapshot["revision"] != expected_revision:
        raise ResourceDatasetError("资源版本已变化，请重新保存任务", 1205, 409)
    return deepcopy(snapshot["tables"])


def commit_device_change(base_revision, request_id, request_digest, actor_id, operation):
    """版本、当前指针及回执同事务写入；先查回执，再检查当前版本。"""
    if not database_mode():
        raise ResourceDatasetError("资源保存仅支持已初始化的数据库模式", 5003)
    factory = get_session_factory()

    def replay(row):
        if row.actor_id != actor_id or row.request_digest != request_digest:
            raise ResourceDatasetError("请求标识已被其他内容或身份使用", 1206, 409)
        return deepcopy(row.receipt)

    try:
        with factory.begin() as session:
            previous = session.get(ResourceDatasetOperation, request_id)
            if previous:
                return replay(previous)
            # 条件更新取得写锁；并发请求不能用旧快照覆盖先提交的新版本。
            locked = session.execute(update(ResourceDatasetCurrent).where(
                ResourceDatasetCurrent.scope == SCOPE,
                ResourceDatasetCurrent.revision == base_revision
            ).values(revision=base_revision)).rowcount
            if locked != 1:
                previous = session.get(ResourceDatasetOperation, request_id)
                if previous:
                    return replay(previous)
                pointer = session.get(ResourceDatasetCurrent, SCOPE)
                if pointer is None:
                    raise ResourceDatasetError("资源基线尚未初始化", 5003)
                raise ResourceDatasetError("资源版本已变化，请刷新后重新编辑", 1205, 409)
            decoded = _decode(session.get(ResourceDatasetVersion, base_revision))
            snapshot = {key: deepcopy(value) for key, value in decoded.items()
                        if key not in ("revision", "content_hash", "source", "data_origin")}
            changed, receipt = operation(snapshot)
            revision = base_revision
            stamp = datetime.now(timezone.utc)
            if changed:
                snapshot["source_updated_at"] = stamp.isoformat().replace("+00:00", "Z")
                # 改回原值也是新版本，不能重新认证依赖旧参数的历史方案。
                snapshot["change"] = {"parent_revision": base_revision, "request_id": request_id,
                    "actor_id": actor_id, "nonce": uuid4().hex}
                _validate_snapshot(snapshot)
                digest = content_hash(snapshot)
                revision = "resource-" + digest[:16]
                session.add(ResourceDatasetVersion(revision=revision, snapshot=snapshot,
                    content_hash=digest, source=SOURCE, data_origin=ORIGIN, created_at=stamp))
                session.flush()
                session.execute(update(ResourceDatasetCurrent).where(
                    ResourceDatasetCurrent.scope == SCOPE).values(revision=revision))
            receipt = {**receipt, "changed": changed, "revision": revision, "read_revision": revision}
            session.add(ResourceDatasetOperation(request_id=request_id, request_digest=request_digest,
                actor_id=actor_id, base_revision=base_revision, revision=revision,
                receipt=receipt, created_at=stamp))
        # 不能用请求内旧缓存拼装新回执；下一次读取从数据库重新固定版本。
        cached = _scope.get()
        if cached is not None:
            cached.pop("current", None)
        return receipt
    except IntegrityError as exc:
        with factory() as session:
            previous = session.get(ResourceDatasetOperation, request_id)
            if previous:
                return replay(previous)
        raise ResourceDatasetError("资源保存冲突，未覆盖原有记录") from exc
    except SQLAlchemyError as exc:
        raise ResourceDatasetError("资源保存失败，请检查数据库及 0015 迁移；可重试原请求") from exc


def initialize(factory=None):
    """只创建首个版本；已有指针时直接回读，不再从文件覆盖数据库。"""
    factory = factory or get_session_factory()
    try:
        with factory() as session:
            if session.get(ResourceDatasetCurrent, SCOPE):
                return {"changed": False, **current(factory)}
        revision, snapshot = capture_files()
        with factory.begin() as session:
            existing = session.get(ResourceDatasetVersion, revision)
            if existing is None:
                session.add(ResourceDatasetVersion(revision=revision, snapshot=snapshot,
                    content_hash=content_hash(snapshot), source=SOURCE, data_origin=ORIGIN,
                    created_at=datetime.now(timezone.utc)))
                session.flush()
            elif _decode(existing)["content_hash"] != content_hash(snapshot):
                raise ResourceDatasetError("已有同名资源版本内容不同，初始化已停止")
            session.add(ResourceDatasetCurrent(scope=SCOPE, revision=revision))
        return {"changed": True, **current(factory)}
    except IntegrityError:
        # 并发初始化只接受已经提交的完整版本，不能覆盖获胜事务。
        return {"changed": False, **current(factory)}
    except SQLAlchemyError as exc:
        raise ResourceDatasetError("资源初始化失败，请先迁移数据库；未覆盖原有资料") from exc
