"""显式导入构造观测及只读查询；不采集、不补帧、不改资源。"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from . import frontend_integration, resource_dataset_service as resources
from .observation_models import ObservationDataset, ObservationFrame, ObservationImportOperation
from .observation_schemas import (
    MAX_BINS, MAX_FRAMES, ORIGIN, DatasetSummary, ImportedFrame,
    ObservationImportReceipt, ObservationImportRequest, StoredFrame,
)


class ObservationError(ValueError):
    def __init__(self, message: str, code: int = 5002, status: int = 503):
        super().__init__(message)
        self.code, self.status = code, status


def content_hash(value) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _summary(row: ObservationDataset) -> dict:
    value = {
        "datasetId": row.dataset_id, "datasetRevision": row.dataset_revision,
        "schemaVersion": row.schema_version, "dataOrigin": row.data_origin,
        "provenanceNote": row.provenance_note, "resourceRevision": row.resource_revision,
        "deviceStatusSnapshotId": row.device_status_snapshot_id, "source": row.source_snapshot,
        "frameCount": row.frame_count, "firstObservedAt": row.first_observed_at,
        "lastObservedAt": row.last_observed_at, "importedAt": row.imported_at,
        "contentHash": row.content_hash,
    }
    try:
        result = DatasetSummary.model_validate(value).model_dump(mode="json")
        if result != value or row.dataset_revision != "observation-" + row.content_hash:
            raise ValueError("元数据版本无效")
        if content_hash({"summary": value, "actorId": row.actor_id}) != row.metadata_hash:
            raise ValueError("元数据摘要无效")
        return result
    except (ValidationError, TypeError, ValueError) as exc:
        raise ObservationError("观测集存储内容损坏，禁止回退或生成观测") from exc


def _dataset(session: Session, dataset_id: str, revision: str) -> tuple[ObservationDataset, dict]:
    row = session.get(ObservationDataset, dataset_id)
    if row is None:
        raise ObservationError("观测集不存在", 1002, 404)
    summary = _summary(row)
    if row.dataset_revision != revision:
        raise ObservationError("观测集版本不匹配，请保留原结果并重新选择", 1204, 409)
    count, first, last = session.execute(select(
        func.count(), func.min(ObservationFrame.frame_index), func.max(ObservationFrame.frame_index)
    ).where(ObservationFrame.dataset_id == dataset_id)).one()
    if (count, first, last) != (row.frame_count, 0, row.frame_count - 1):
        raise ObservationError("观测帧集合不完整")
    return row, summary


def _frame(row: ObservationFrame, dataset: ObservationDataset) -> dict:
    try:
        frame = ImportedFrame.model_validate(row.frame_payload)
        value = frame.model_dump(mode="json")
        if value != row.frame_payload or content_hash(value) != row.frame_hash:
            raise ValueError("帧摘要无效")
        if frame.index != row.frame_index or frame.frameId != row.frame_id:
            raise ValueError("帧身份无效")
        source = dataset.source_snapshot
        if any(item.minKhz < source["minKhz"] or item.maxKhz > source["maxKhz"] for item in frame.bins):
            raise ValueError("帧范围无效")
        return StoredFrame.model_validate({**value, "datasetId": dataset.dataset_id,
            "datasetRevision": dataset.dataset_revision, "dataOrigin": dataset.data_origin}).model_dump(mode="json")
    except (ValidationError, TypeError, ValueError, KeyError) as exc:
        raise ObservationError("观测帧存储内容损坏，禁止回退或生成观测") from exc


def _receipt(session: Session, request_id: str, digest: str, actor: str):
    row = session.get(ObservationImportOperation, request_id)
    if row is None:
        return None
    if row.request_digest != digest or row.actor_id != actor:
        raise ObservationError("导入请求标识已被其他内容或身份使用", 1206, 409)
    try:
        value = ObservationImportReceipt.model_validate(row.receipt)
        if value.requestId != request_id or value.actorId != actor or value.datasetId != row.dataset_id:
            raise ValueError("回执归属无效")
        dataset, _ = _dataset(session, row.dataset_id, value.datasetRevision)
        if value.frameCount != dataset.frame_count or value.resourceRevision != dataset.resource_revision or value.importedAt != dataset.imported_at:
            raise ValueError("回执来源无效")
        return value
    except (ValidationError, TypeError, ValueError) as exc:
        if isinstance(exc, ObservationError):
            raise
        raise ObservationError("导入回执存储内容损坏") from exc


def import_synthetic_dataset(
    request: ObservationImportRequest, *, actor_id: str, factory: sessionmaker[Session],
) -> ObservationImportReceipt:
    if not frontend_integration.integration_enabled():
        raise ObservationError("联调模式未开启", 1101, 401)
    if not resources.database_mode():
        raise ObservationError("观测导入需要显式数据库资源模式", 5001)
    if not isinstance(actor_id, str) or not actor_id.strip() or len(actor_id) > 120:
        raise ObservationError("导入须提供可信内部调用者身份", 1001, 422)
    # 重新验证模型，防止 model_construct 或调用后修改绕过完整输入校验。
    request = ObservationImportRequest.model_validate(request.model_dump(mode="json") if isinstance(request, ObservationImportRequest) else request)
    payload = request.model_dump(mode="json", exclude={"requestId"})
    digest = content_hash(request.model_dump(mode="json"))
    dataset_hash = content_hash(payload)
    revision = "observation-" + dataset_hash
    for attempt in range(2):
        try:
            with factory.begin() as session:
                receipt = _receipt(session, request.requestId, digest, actor_id)
                if receipt is not None:
                    return receipt
                row = session.get(ObservationDataset, request.datasetId)
                changed = row is None
                if row is not None:
                    _summary(row)
                    if row.content_hash != dataset_hash or row.actor_id != actor_id:
                        raise ObservationError("观测集编号已被其他内容或身份使用", 1206, 409)
                    _dataset(session, row.dataset_id, row.dataset_revision)
                else:
                    snapshot = resources.current(factory=factory)
                    if snapshot["revision"] != request.resourceRevision:
                        raise ObservationError("资源版本已变化，未导入观测", 1205, 409)
                    row = ObservationDataset(dataset_id=request.datasetId, dataset_revision=revision,
                        schema_version=1, data_origin=ORIGIN, content_hash=dataset_hash,
                        metadata_hash="", resource_revision=request.resourceRevision,
                        provenance_note=request.provenanceNote, source_snapshot=payload["source"],
                        device_status_snapshot_id=None, frame_count=len(request.frames),
                        first_observed_at=request.frames[0].observedAt,
                        last_observed_at=request.frames[-1].observedAt, actor_id=actor_id, imported_at=_now())
                    summary = {"datasetId": row.dataset_id, "datasetRevision": revision,
                        "schemaVersion": 1, "dataOrigin": ORIGIN, "provenanceNote": row.provenance_note,
                        "resourceRevision": row.resource_revision, "deviceStatusSnapshotId": None,
                        "source": row.source_snapshot, "frameCount": row.frame_count,
                        "firstObservedAt": row.first_observed_at, "lastObservedAt": row.last_observed_at,
                        "importedAt": row.imported_at, "contentHash": dataset_hash}
                    row.metadata_hash = content_hash({"summary": summary, "actorId": actor_id})
                    session.add(row)
                    session.flush()
                    for frame in request.frames:
                        value = frame.model_dump(mode="json")
                        session.add(ObservationFrame(dataset_id=row.dataset_id, frame_index=frame.index,
                            frame_id=frame.frameId, frame_payload=value, frame_hash=content_hash(value)))
                receipt = ObservationImportReceipt(requestId=request.requestId, actorId=actor_id,
                    datasetId=row.dataset_id, datasetRevision=row.dataset_revision, dataOrigin=ORIGIN,
                    resourceRevision=row.resource_revision, frameCount=row.frame_count,
                    changed=changed, importedAt=row.imported_at)
                session.add(ObservationImportOperation(request_id=request.requestId,
                    request_digest=digest, actor_id=actor_id, dataset_id=row.dataset_id,
                    receipt=receipt.model_dump(mode="json"), created_at=_now()))
                return receipt
        except IntegrityError as exc:
            # 唯一键竞争后只在新事务核实或重试，不沿用失败会话。
            if attempt:
                raise ObservationError("观测导入竞争冲突，原记录已保留") from exc
        except SQLAlchemyError as exc:
            raise ObservationError("观测数据库不可用，未生成替代观测") from exc
    raise ObservationError("观测导入未完成")


def context(session: Session, dataset_id=None, revision=None):
    count = session.scalar(select(func.count()).select_from(ObservationDataset))
    selected = _dataset(session, dataset_id, revision)[1] if dataset_id is not None else None
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "datasetCount": count,
        "selected": selected, "reasons": [] if selected else ["NO_IMPORTED_DATA" if count == 0 else "DATASET_NOT_SELECTED"],
        "replay": {"mode": "FINITE", "loop": False, "maxFramesPerDataset": MAX_FRAMES, "maxBinsPerFrame": MAX_BINS}}


def datasets(session: Session, page: int, page_size: int):
    total = session.scalar(select(func.count()).select_from(ObservationDataset))
    rows = session.scalars(select(ObservationDataset).order_by(ObservationDataset.dataset_id)
        .offset((page - 1) * page_size).limit(page_size)) if (page - 1) * page_size < total else []
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "items": [_summary(row) for row in rows],
        "page": page, "pageSize": page_size, "total": total}


def _identity(row):
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "datasetId": row.dataset_id,
        "datasetRevision": row.dataset_revision, "resourceRevision": row.resource_revision,
        "sourceId": row.source_snapshot["sourceId"], "configRevision": row.source_snapshot["configRevision"],
        "frameCount": row.frame_count}


def frames(session: Session, dataset_id: str, revision: str, page: int, page_size: int):
    row, _ = _dataset(session, dataset_id, revision)
    items = session.scalars(select(ObservationFrame).where(ObservationFrame.dataset_id == dataset_id)
        .order_by(ObservationFrame.frame_index).offset((page - 1) * page_size).limit(page_size)) if (page - 1) * page_size < row.frame_count else []
    return {**_identity(row), "items": [_frame(item, row) for item in items],
        "page": page, "pageSize": page_size, "total": row.frame_count}


def frame(session: Session, dataset_id: str, revision: str, index: int):
    row, _ = _dataset(session, dataset_id, revision)
    if index >= row.frame_count:
        raise ObservationError("观测帧索引超出已存范围", 1002, 404)
    item = session.get(ObservationFrame, (dataset_id, index))
    if item is None:
        raise ObservationError("观测帧缺失")
    return {**_identity(row), "index": index, "hasPrevious": index > 0,
        "hasNext": index + 1 < row.frame_count, "frame": _frame(item, row)}
