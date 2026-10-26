"""冻结引用投影；只读复核真实P06，不保存或推断设备状态。"""
from __future__ import annotations

from pydantic import ValidationError
from sqlalchemy import inspect

from .observation_schemas import ORIGIN, ObservationDeviceStatusRefInput, ObservationDeviceStatusRefWire
from .observation_service import ObservationError, content_hash

TABLE = "observation_device_status_refs"


def available(session):
    return inspect(session.connection()).has_table(TABLE)


def _dependencies(session):
    if not available(session):
        raise ObservationError("观测状态关联尚未迁移；仅V1无关联可用")
    try:
        from .observation_status_ref_models import ObservationDeviceStatusRef
        from .device_status_service import resolve_snapshot, DeviceStatusError
    except ImportError as exc:
        raise ObservationError("观测状态关联的P06真实依赖尚未接入") from exc
    return ObservationDeviceStatusRef, resolve_snapshot, DeviceStatusError


def canonical(value):
    return ObservationDeviceStatusRefInput.model_validate(value.model_dump(mode="json")
        if isinstance(value, ObservationDeviceStatusRefInput) else value).model_dump(mode="json")


def wire(dataset_id, revision, value):
    ref = canonical(value)
    digest = content_hash({"kind": "OBSERVATION_DEVICE_STATUS_REF", "schemaVersion": 1,
        "dataOrigin": ORIGIN, "datasetId": dataset_id, "datasetRevision": revision, **ref})
    return {**ref, "refRevision": "OSR-" + digest, "contentHash": digest}


def preview_hash(dataset_hash, value):
    return content_hash({"kind": "OBSERVATION_IMPORT_WITH_STATUS_REF", "schemaVersion": 1,
        "datasetContentHash": dataset_hash, "deviceStatusRef": canonical(value)})


def operation_digest(request, value):
    return content_hash({"kind": "OBSERVATION_IMPORT_WITH_STATUS_REF", "schemaVersion": 1,
        "request": request.model_dump(mode="json"), "deviceStatusRef": canonical(value)})


def resolve(session, value, resource_revision):
    ref = canonical(value)
    if ref["resourceRevision"] != resource_revision:
        raise ObservationError("状态引用资源版本与观测不符", 1203, 409)
    _, resolver, error = _dependencies(session)
    try:
        header, items = resolver(session, ref["snapshotId"], ref["snapshotRevision"],
            ref["resourceRevision"], ref["deviceIds"])
    except error as exc:
        raise ObservationError(str(exc), exc.code, exc.status) from exc
    try:
        if (header["snapshot_id"] != ref["snapshotId"] or header["snapshot_revision"] != ref["snapshotRevision"]
                or header["resource_revision"] != resource_revision or header["data_origin"] != ORIGIN
                or len(items) != len(ref["deviceIds"]) or sorted(item["device_id"] for item in items) != ref["deviceIds"]):
            raise ValueError("冻结引用不完整")
    except (KeyError, TypeError, ValueError) as exc:
        raise ObservationError("P06冻结引用或成员覆盖校验失败") from exc
    return ref


def _metadata(dataset, value):
    return content_hash({"schemaVersion": 1, "dataOrigin": ORIGIN, "datasetId": dataset.dataset_id,
        "datasetRevision": dataset.dataset_revision, "deviceStatusRef": value,
        "actorId": dataset.actor_id, "createdAt": dataset.imported_at})


def read(session, dataset, *, optional_table=False):
    if optional_table and not available(session):
        return None
    model, _, _ = _dependencies(session)
    row = session.get(model, dataset.dataset_id)
    if row is None:
        return None
    try:
        value = wire(dataset.dataset_id, dataset.dataset_revision, {"snapshotId": row.snapshot_id,
            "snapshotRevision": row.snapshot_revision, "resourceRevision": row.resource_revision, "deviceIds": row.device_ids})
        ObservationDeviceStatusRefWire.model_validate(value)
        if (row.schema_version != 1 or row.data_origin != ORIGIN or row.dataset_revision != dataset.dataset_revision
                or row.resource_revision != dataset.resource_revision or row.actor_id != dataset.actor_id
                or row.created_at != dataset.imported_at or row.device_ids != value["deviceIds"]
                or row.ref_hash != value["contentHash"] or row.ref_revision != value["refRevision"]
                or row.metadata_hash != _metadata(dataset, value)):
            raise ValueError("关联摘要无效")
        resolve(session, value_input(value), dataset.resource_revision)
        return value
    except (ValidationError, TypeError, ValueError, KeyError) as exc:
        # 已存关联的缺失/错版意味着存储损坏，不伪报未关联。
        raise ObservationError("观测状态关联存储或P06历史校验失败") from exc


def value_input(value):
    return {key: value[key] for key in ObservationDeviceStatusRefInput.model_fields}


def assert_binding(session, dataset, value):
    stored = read(session, dataset, optional_table=value is None)
    expected = wire(dataset.dataset_id, dataset.dataset_revision, value) if value is not None else None
    if stored != expected:
        raise ObservationError("观测集历史绑定不同，禁止补绑、改绑或剥离关联", 1206, 409)
    return stored


def bind(session, dataset, value):
    ref = resolve(session, value, dataset.resource_revision)
    model, _, _ = _dependencies(session)
    result = wire(dataset.dataset_id, dataset.dataset_revision, ref)
    session.add(model(dataset_id=dataset.dataset_id, dataset_revision=dataset.dataset_revision,
        snapshot_id=ref["snapshotId"], snapshot_revision=ref["snapshotRevision"], resource_revision=ref["resourceRevision"],
        device_ids=ref["deviceIds"], schema_version=1, data_origin=ORIGIN, ref_revision=result["refRevision"],
        ref_hash=result["contentHash"], metadata_hash=_metadata(dataset, result), actor_id=dataset.actor_id,
        created_at=dataset.imported_at))
    return result
