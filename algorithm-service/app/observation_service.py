"""显式导入构造观测及只读查询；不采集、不补帧、不改资源。"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from . import frontend_integration, resource_dataset_service as resources
from .observation_models import ObservationDataset, ObservationFrame, ObservationImportOperation
from .resource_dataset_models import ResourceDatasetVersion
from .observation_schemas import (
    MAX_BINS, MAX_FRAMES, ORIGIN, DatasetSummary, ImportedFrame,
    ObservationImportReceipt, ObservationImportRequest, StoredFrame, ObservationImportFile,
    ObservationImportCommand, parse_import_file,
)

MAX_PUBLIC_FILE_BYTES = 2 * 1024 * 1024


class ObservationError(ValueError):
    def __init__(self, message: str, code: int = 5002, status: int = 503):
        super().__init__(message)
        self.code, self.status = code, status


def synthetic_workflows_enabled() -> bool:
    # 业务来源仍是构造数据；LOCAL只放行已由路由鉴权的显式操作，不提供身份。
    demo = frontend_integration.integration_enabled()
    mode = os.environ.get("AUTH_MODE", "INTEGRATION" if demo else "OFF")
    return (mode == "INTEGRATION" and demo) or (mode == "LOCAL_PASSWORD" and not demo)


def _require_synthetic_mode():
    if not synthetic_workflows_enabled():
        raise ObservationError("构造观测工作流未启用或认证模式冲突", 1101, 401)


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
    return _import_dataset(request, actor_id=actor_id, factory=factory)


def _existing_dataset(session, request, dataset_hash, status_ref=None, actor_id=None):
    row = session.get(ObservationDataset, request.datasetId)
    if row is None:
        return None
    _dataset(session, row.dataset_id, row.dataset_revision)
    if (row.content_hash != dataset_hash or row.resource_revision != request.resourceRevision
            or actor_id is not None and row.actor_id != actor_id):
        raise ObservationError("观测集编号已被其他内容或身份使用", 1206, 409)
    # noop仍验证历史正文和资源；不以CURRENT替换原来源，也不信任仅存的hash列。
    stored = {"schemaVersion": 1, "dataOrigin": ORIGIN, "datasetId": row.dataset_id,
        "provenanceNote": row.provenance_note, "resourceRevision": row.resource_revision,
        "deviceStatusSnapshotId": None, "source": row.source_snapshot, "frames": []}
    for item in session.scalars(select(ObservationFrame).where(ObservationFrame.dataset_id == row.dataset_id)
            .order_by(ObservationFrame.frame_index)):
        value = _frame(item, row)
        stored["frames"].append({key: value[key] for key in ImportedFrame.model_fields})
    if content_hash(stored) != dataset_hash:
        raise ObservationError("历史观测正文摘要不符，禁止返回noop回执")
    try:
        resources._decode(session.get(ResourceDatasetVersion, row.resource_revision))
    except resources.ResourceDatasetError as exc:
        raise ObservationError("历史观测的冻结资源缺失或损坏") from exc
    from . import observation_status_ref_service as refs
    refs.assert_binding(session, row, status_ref)
    return row


def _import_dataset(request, *, actor_id, factory, status_ref=None):
    from . import observation_status_ref_service as refs
    _require_synthetic_mode()
    if not resources.database_mode():
        raise ObservationError("观测导入需要显式数据库资源模式", 5001)
    if not isinstance(actor_id, str) or not actor_id.strip() or len(actor_id) > 120:
        raise ObservationError("导入须提供可信内部调用者身份", 1001, 422)
    # 重新验证模型，防止 model_construct 或调用后修改绕过完整输入校验。
    request = ObservationImportRequest.model_validate(request.model_dump(mode="json") if isinstance(request, ObservationImportRequest) else request)
    payload = request.model_dump(mode="json", exclude={"requestId"})
    digest = content_hash(request.model_dump(mode="json")) if status_ref is None else refs.operation_digest(request, status_ref)
    dataset_hash = content_hash(payload)
    revision = "observation-" + dataset_hash
    for attempt in range(2):
        try:
            with factory.begin() as session:
                receipt = _receipt(session, request.requestId, digest, actor_id)
                if receipt is not None:
                    stored = _existing_dataset(session, request, dataset_hash, status_ref, actor_id)
                    if stored is None or stored.dataset_revision != receipt.datasetRevision:
                        raise ObservationError("历史回执对应观测集缺失或版本不符")
                    return receipt
                row = _existing_dataset(session, request, dataset_hash, status_ref, actor_id)
                changed = row is None
                if row is None:
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
                    if status_ref is not None:
                        refs.bind(session, row, status_ref)
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


def _source_binding(session, source):
    # 登记版本仅用于身份比对，未登记来源和真实连通性不能互相替代。
    if not source.configRevision.startswith("SPV-"):
        return "DECLARED_ONLY"
    from .spectrum_source_models import SpectrumSourceVersion
    from .spectrum_source_service import decode_version
    row = session.get(SpectrumSourceVersion, source.configRevision)
    if row is None:
        return "DECLARED_ONLY"
    saved = decode_version(row)
    values = {"sourceId": saved["sourceId"], "configRevision": saved["configRevision"],
        "name": saved["draft"]["name"], "minKhz": saved["draft"]["minKhz"],
        "maxKhz": saved["draft"]["maxKhz"], "intervalSeconds": saved["draft"]["intervalSeconds"]}
    if source.model_dump(mode="json") != values:
        raise ObservationError("观测来源声明与登记配置版本不一致", 1204, 409)
    return "REGISTERED_VERSION"


def preview_import(file: ObservationImportFile, *, factory):
    _require_synthetic_mode()
    file = parse_import_file(file)
    payload = file.to_request("preview-only").model_dump(mode="json", exclude={"requestId"})
    _assert_file_size(file.model_dump(mode="json"))
    dataset_hash = content_hash(payload)
    with factory() as session:
        status_ref = file.deviceStatusRef if file.schemaVersion == 2 else None
        existing = _existing_dataset(session, file.to_request("preview-only"), dataset_hash, status_ref)
        if existing is None:
            snapshot = resources.current(factory=factory)
            if file.dataset.resourceRevision != snapshot["revision"]:
                raise ObservationError("预检时资源来源已变化，请保留输入并刷新来源", 1205, 409)
        binding = _source_binding(session, file.dataset.source)
        if file.schemaVersion == 2:
            from . import observation_status_ref_service as refs
            refs.resolve(session, file.deviceStatusRef, file.dataset.resourceRevision)
    result = {"schemaVersion": 1, "dataOrigin": ORIGIN, "previewHash": content_hash(payload),
        "datasetId": file.dataset.datasetId, "resourceRevision": file.dataset.resourceRevision,
        "source": payload["source"], "frameCount": len(file.dataset.frames), "sourceBinding": binding,
        "warnings": ["来源只是导入声明，未登记采集配置；未核实真实采集"] if binding == "DECLARED_ONLY" else ["登记配置只作身份比对，未核实真实采集"]}
    if file.schemaVersion == 2:
        dataset_hash = content_hash(payload)
        result.update(schemaVersion=2, datasetContentHash=dataset_hash, datasetRevision="observation-" + dataset_hash,
            previewHash=refs.preview_hash(dataset_hash, file.deviceStatusRef),
            deviceStatusRef=refs.wire(file.dataset.datasetId, "observation-" + dataset_hash, file.deviceStatusRef))
    return result


def _assert_file_size(value):
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(raw) > MAX_PUBLIC_FILE_BYTES:
        raise ObservationError("观测JSON超过2MiB保护限制，未截断或保存", 1001, 413)
    return raw


def import_file(command: ObservationImportCommand, *, actor_id, factory):
    _require_synthetic_mode()
    command = ObservationImportCommand.model_validate(command.model_dump(mode="json", exclude_unset=True) if isinstance(command, ObservationImportCommand) else command)
    request = command.file.to_request(command.requestId)
    digest = content_hash(request.model_dump(mode="json", exclude={"requestId"}))
    status_ref = command.file.deviceStatusRef if command.file.schemaVersion == 2 else None
    from . import observation_status_ref_service as refs
    expected_preview = digest if status_ref is None else refs.preview_hash(digest, status_ref)
    if expected_preview != command.previewHash or status_ref is not None and digest != command.datasetContentHash:
        raise ObservationError("提交内容与预检摘要不一致，请重新预检", 1206, 409)
    _assert_file_size(command.file.model_dump(mode="json"))
    # 原键回放先核实已提交事实，不能被新的当前资源/配置误拒绝。
    with factory() as session:
        existed = session.get(ObservationImportOperation, command.requestId) is not None
    if not existed:
        preview_import(command.file, factory=factory)
    receipt = _import_dataset(request, actor_id=actor_id, factory=factory, status_ref=status_ref)
    result = {"schemaVersion": 1, "dataOrigin": ORIGIN, "requestId": command.requestId,
        "operationType": "OBSERVATION_IMPORT", "status": "COMMITTED", "receipt": receipt.model_dump(mode="json")}
    if status_ref is not None:
        result.update(schemaVersion=2, deviceStatusRef=refs.wire(receipt.datasetId, receipt.datasetRevision, status_ref))
    return result


def import_receipt(session, request_id, actor_id, include_device_status_ref=False):
    row = session.get(ObservationImportOperation, request_id)
    value = None
    if row is not None:
        if row.actor_id != actor_id:
            raise ObservationError("无权读取其他身份的导入回执", 1104, 403)
        value = _receipt(session, request_id, row.request_digest, actor_id).model_dump(mode="json")
    result = {"schemaVersion": 1, "dataOrigin": ORIGIN, "requestId": request_id,
        "operationType": "OBSERVATION_IMPORT", "status": "COMMITTED" if value else "NOT_FOUND", "receipt": value}
    if include_device_status_ref:
        from . import observation_status_ref_service as refs
        refs._dependencies(session)
        dataset = _dataset(session, value["datasetId"], value["datasetRevision"])[0] if value else None
        result.update(schemaVersion=2, deviceStatusRef=refs.read(session, dataset) if dataset is not None else None)
    return result


def device_status_ref(session, dataset_id, revision):
    from . import observation_status_ref_service as refs
    row, _ = _dataset(session, dataset_id, revision)
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "datasetId": dataset_id,
        "datasetRevision": revision, "resourceRevision": row.resource_revision, "deviceStatusRef": refs.read(session, row)}


def export_dataset(session, dataset_id, revision, include_device_status_ref=False):
    row, summary = _dataset(session, dataset_id, revision)
    rows = session.scalars(select(ObservationFrame).where(ObservationFrame.dataset_id == dataset_id).order_by(ObservationFrame.frame_index))
    values = []
    for item in rows:
        stored = _frame(item, row)
        values.append({key: stored[key] for key in ImportedFrame.model_fields})
    dataset = {"datasetId": dataset_id, "provenanceNote": summary["provenanceNote"],
        "resourceRevision": row.resource_revision, "deviceStatusSnapshotId": None,
        "source": summary["source"], "frames": values}
    try:
        file = ObservationImportFile.model_validate({"schemaVersion": 1, "fileKind": "SPECTRUM_OBSERVATION_DATASET",
            "dataOrigin": ORIGIN, "dataset": dataset})
        if content_hash(file.to_request("export-validation").model_dump(mode="json", exclude={"requestId"})) != row.content_hash:
            raise ValueError("集合内容摘要不一致")
    except (ValidationError, TypeError, ValueError) as exc:
        raise ObservationError("观测集完整内容校验失败，未导出替代值") from exc
    result = file.model_dump(mode="json")
    if include_device_status_ref:
        from . import observation_status_ref_service as refs
        ref = refs.read(session, row)
        if ref is not None:
            result.update(schemaVersion=2, deviceStatusRef=refs.value_input(ref))
    return _assert_file_size(result)
