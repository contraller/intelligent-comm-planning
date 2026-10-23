"""构造状态快照导入与只读查询，不调用设备或修改资源。"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import func, inspect, select, text
from sqlalchemy.exc import ArgumentError, IntegrityError, SQLAlchemyError

from .database import DatabaseConfigurationError, get_session_factory
from . import resource_dataset_service as datasets
from .resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from .device_status_models import DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation
from .device_status_schemas import DeviceStatusImport, SCHEMA, ORIGIN, utc_time


class DeviceStatusError(ValueError):
    def __init__(self, message, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


def _stamp(value):
    return value.replace(tzinfo=timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


@contextmanager
def session_scope(*, writing=False):
    if not datasets.database_mode():
        raise DeviceStatusError("状态快照要求数据库资源模式", 5003, 503)
    try:
        with get_session_factory()() as session:
            if writing:
                if session.get_bind().dialect.name != "sqlite":
                    raise DeviceStatusError("当前数据库写锁语义待确认", 5003, 503)
                session.execute(text("BEGIN IMMEDIATE"))
            inspector = inspect(session.connection())
            tables = (DeviceStatusSnapshot, DeviceStatusRecord, DeviceStatusImportOperation,
                      ResourceDatasetCurrent, ResourceDatasetVersion)
            if any(not inspector.has_table(model.__tablename__) for model in tables):
                raise DeviceStatusError("设备状态表或资源表尚未迁移", 5003, 503)
            yield session
            if writing:
                session.commit()
    except (DatabaseConfigurationError, ArgumentError) as exc:
        raise DeviceStatusError("数据库配置缺失或无效", 5001, 503) from exc
    except IntegrityError:
        raise
    except SQLAlchemyError as exc:
        raise DeviceStatusError("设备状态数据库操作失败", 5002, 503) from exc


def _header(row):
    return {"schema_version": SCHEMA, "snapshot_id": row.snapshot_id, "snapshot_revision": row.snapshot_revision,
        "content_hash": row.content_hash, "resource_revision": row.resource_revision,
        "resource_content_hash": row.resource_content_hash, "data_origin": row.data_origin,
        "source_label": row.source_label, "provenance_note": row.provenance_note,
        "imported_at": _stamp(row.imported_at), "actor_id": row.actor_id, "total": row.total,
        "counts": deepcopy(row.counts), "first_observed_at": row.first_observed_at, "last_observed_at": row.last_observed_at}


def _counts(records):
    result = {key: 0 for key in ("NORMAL", "FAULT", "OFFLINE", "UNKNOWN")}
    for record in records:
        result[record.status or "UNKNOWN"] += 1
    return {**result, "total": len(records)}


def _snapshot(session, snapshot_id, revision=None):
    row = session.get(DeviceStatusSnapshot, snapshot_id)
    if row is None:
        raise DeviceStatusError("状态快照不存在", 1002, 404)
    if revision is not None and row.snapshot_revision != revision:
        raise DeviceStatusError("状态快照版本不符", 1203, 409)
    try:
        original = DeviceStatusImport.model_validate(row.original_input)
        canonical = original.model_dump(exclude={"request_id"})
        if (datasets.content_hash(canonical) != row.content_hash
                or row.snapshot_revision != "device-status-" + row.content_hash
                or original.base_revision != row.resource_revision or original.data_origin != row.data_origin
                or original.source_label != row.source_label or original.provenance_note != row.provenance_note
                or len(original.records) != row.total or _counts(original.records) != row.counts
                or datasets.content_hash(_header(row)) != row.header_hash):
            raise ValueError("快照摘要不一致")
        version = session.get(ResourceDatasetVersion, row.resource_revision)
        if version is None:
            raise ValueError("快照的资源版本缺失")
        resource = datasets._decode(version)
        if resource["content_hash"] != row.resource_content_hash:
            raise ValueError("冻结资源摘要不符")
        devices = {item["device_id"]: item for item in resource["tables"]["device.csv"]}
        records = list(session.scalars(select(DeviceStatusRecord).where(DeviceStatusRecord.snapshot_id == snapshot_id)))
        originals = {item.device_id: item for item in original.records}
        if len(records) != len(originals):
            raise ValueError("快照记录数量不符")
        # 先核验全批，再筛选分页，避免损坏的状态被 WHERE 条件悄悄藏掉。
        for item in records:
            source = devices.get(item.device_id)
            if source is None or item.device_id not in originals or item.availability != source.get("availability", "ACTIVE"):
                raise ValueError("快照冻结设备不符")
            _record(item, originals[item.device_id])
        return row, original
    except DeviceStatusError:
        raise
    except (ValidationError, ValueError, TypeError, AttributeError, KeyError) as exc:
        raise DeviceStatusError("状态快照来源或内容损坏", 5002, 503) from exc


def _receipt(session, row):
    snapshot, _ = _snapshot(session, row.snapshot_id)
    header = _header(snapshot)
    expected = {"schema_version": SCHEMA, "request_id": row.request_id, "snapshot_id": row.snapshot_id,
        "snapshot_revision": snapshot.snapshot_revision, "resource_revision": snapshot.resource_revision,
        "imported_at": header["imported_at"], "total": snapshot.total, "content_hash": snapshot.content_hash, "data_origin": ORIGIN}
    if row.receipt != expected or row.actor_id != snapshot.actor_id or row.request_digest != datasets.content_hash(snapshot.original_input):
        raise DeviceStatusError("状态导入回执损坏", 5002, 503)
    return deepcopy(expected)


def import_snapshot(request: DeviceStatusImport, actor_id: str):
    raw = request.model_dump()
    digest = datasets.content_hash(raw)

    def replay(session, previous):
        if previous.actor_id != actor_id or previous.request_digest != digest:
            raise DeviceStatusError("请求编号已被其他内容或身份使用", 1206, 409)
        return _receipt(session, previous)

    try:
        with session_scope(writing=True) as session:
            prior = session.get(DeviceStatusImportOperation, request.request_id)
            if prior is not None:
                return replay(session, prior)
            pointer = session.get(ResourceDatasetCurrent, datasets.SCOPE)
            if pointer is None:
                raise DeviceStatusError("资源尚未初始化", 5003, 503)
            if pointer.revision != request.base_revision:
                raise DeviceStatusError("资源版本已变化", 1205, 409)
            version = session.get(ResourceDatasetVersion, pointer.revision)
            if version is None:
                raise DeviceStatusError("资源指针损坏", 5002, 503)
            resource = datasets._decode(version)
            devices = {row["device_id"]: row for row in resource["tables"]["device.csv"]}
            for record in request.records:
                device = devices.get(record.device_id)
                if device is None:
                    raise DeviceStatusError("导入设备不存在", 1002, 404)
                if (record.node_id, record.model_id) != (device["node_id"], device["model_id"]):
                    raise DeviceStatusError("导入设备冻结引用不符", 1203, 409)
            content_hash = datasets.content_hash(request.model_dump(exclude={"request_id"}))
            # 新请求是独立显式导入；相同内容可同摘要，但不会冒用上一批操作者/时间。
            times = sorted(utc_time(record.observed_at) for record in request.records if record.observed_at is not None)
            snapshot = DeviceStatusSnapshot(snapshot_id="DSS-" + uuid4().hex,
                snapshot_revision="device-status-" + content_hash, content_hash=content_hash,
                resource_revision=resource["revision"], resource_content_hash=resource["content_hash"],
                data_origin=ORIGIN, source_label=request.source_label, provenance_note=request.provenance_note,
                actor_id=actor_id, imported_at=datetime.now(timezone.utc), total=len(request.records),
                counts=_counts(request.records), first_observed_at=times[0] if times else None,
                last_observed_at=times[-1] if times else None, original_input=raw, header_hash="")
            snapshot.header_hash = datasets.content_hash(_header(snapshot))
            session.add(snapshot)
            session.flush()
            for record in request.records:
                session.add(DeviceStatusRecord(snapshot_id=snapshot.snapshot_id,
                    **record.model_dump(exclude={"observed_at"}),
                    observed_at=utc_time(record.observed_at) if record.observed_at is not None else None,
                    availability=devices[record.device_id].get("availability", "ACTIVE")))
            receipt = {"schema_version": SCHEMA, "request_id": request.request_id, "snapshot_id": snapshot.snapshot_id,
                "snapshot_revision": snapshot.snapshot_revision, "resource_revision": snapshot.resource_revision,
                "imported_at": _stamp(snapshot.imported_at), "total": snapshot.total, "content_hash": snapshot.content_hash, "data_origin": ORIGIN}
            session.add(DeviceStatusImportOperation(request_id=request.request_id, request_digest=digest, actor_id=actor_id,
                snapshot_id=snapshot.snapshot_id, receipt=receipt, created_at=datetime.now(timezone.utc)))
        return receipt
    except IntegrityError as exc:
        with session_scope() as session:
            prior = session.get(DeviceStatusImportOperation, request.request_id)
            if prior is not None:
                return replay(session, prior)
        raise DeviceStatusError("状态导入冲突，请核实原请求", 5002, 503) from exc


def get_operation(request_id, actor_id):
    with session_scope() as session:
        row = session.get(DeviceStatusImportOperation, request_id)
        if row is None or row.actor_id != actor_id:
            raise DeviceStatusError("状态导入请求不存在", 1002, 404)
        return _receipt(session, row)


def list_snapshots(page=1, page_size=20, resource_revision=None):
    with session_scope() as session:
        clauses = [DeviceStatusSnapshot.resource_revision == resource_revision] if resource_revision is not None else []
        total = session.scalar(select(func.count()).select_from(DeviceStatusSnapshot).where(*clauses))
        rows = session.scalars(select(DeviceStatusSnapshot).where(*clauses).order_by(
            DeviceStatusSnapshot.imported_at.desc(), DeviceStatusSnapshot.snapshot_id.desc()).offset((page - 1) * page_size).limit(page_size))
        items = [_header(_snapshot(session, row.snapshot_id)[0]) for row in rows]
        return {"schema_version": SCHEMA, "items": items, "total": total, "page": page, "page_size": page_size}


def get_snapshot(snapshot_id, revision):
    with session_scope() as session:
        return _header(_snapshot(session, snapshot_id, revision)[0])


def _record(row, original):
    expected = original.model_dump()
    expected["observed_at"] = utc_time(original.observed_at) if original.observed_at is not None else None
    if any(getattr(row, key) != value for key, value in expected.items()) or row.availability not in ("ACTIVE", "OFF_SHELF"):
        raise DeviceStatusError("状态记录损坏", 5002, 503)
    return {**expected, "availability": row.availability}


def query_devices(snapshot_id, revision, *, device_id=None, status_filter="ALL", page=1, page_size=20):
    with session_scope() as session:
        snapshot, original = _snapshot(session, snapshot_id, revision)
        originals = {row.device_id: row for row in original.records}
        clauses = [DeviceStatusRecord.snapshot_id == snapshot_id]
        if device_id is not None:
            clauses.append(DeviceStatusRecord.device_id == device_id)
        if status_filter == "UNKNOWN":
            clauses.append(DeviceStatusRecord.status.is_(None))
        elif status_filter != "ALL":
            clauses.append(DeviceStatusRecord.status == status_filter)
        total = session.scalar(select(func.count()).select_from(DeviceStatusRecord).where(*clauses))
        rows = session.scalars(select(DeviceStatusRecord).where(*clauses).order_by(DeviceStatusRecord.device_id)
            .offset((page - 1) * page_size).limit(page_size))
        items = []
        for row in rows:
            if row.device_id not in originals:
                raise DeviceStatusError("状态设备引用损坏", 5002, 503)
            items.append(_record(row, originals[row.device_id]))
        return {"schema_version": SCHEMA, "snapshot_id": snapshot_id, "snapshot_revision": revision,
            "resource_revision": snapshot.resource_revision, "items": items, "total": total, "page": page, "page_size": page_size}


def resolve_snapshot(session, snapshot_id, snapshot_revision, resource_revision, device_ids):
    """供 P07 同事务只读解析；不存在的设备不得构造部分状态引用。"""
    snapshot, original = _snapshot(session, snapshot_id, snapshot_revision)
    if snapshot.resource_revision != resource_revision:
        raise DeviceStatusError("状态引用的资源版本不符", 1203, 409)
    originals = {row.device_id: row for row in original.records}
    items = []
    for device_id in device_ids:
        row = session.get(DeviceStatusRecord, (snapshot_id, device_id))
        if row is None or device_id not in originals:
            raise DeviceStatusError("快照没有该设备记录", 1002, 404)
        items.append(_record(row, originals[device_id]))
    return _header(snapshot), items
