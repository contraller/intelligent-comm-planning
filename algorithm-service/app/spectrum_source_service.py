"""来源配置与离线检查；所有写入保留版本和实际操作回执。"""
from datetime import datetime, timezone

from pydantic import ValidationError
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from . import frontend_integration
from .observation_schemas import ORIGIN
from .observation_service import ObservationError, content_hash
from .spectrum_source_models import SpectrumSourceCurrent as Current, SpectrumSourceOperation as Operation, SpectrumSourceVersion as Version
from .spectrum_source_schemas import OfflineCheck, SourceCheck, SourceReceipt, SourceSave, SourceVersion


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _payload(source_id, draft):
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "sourceId": source_id, "draft": draft}


def decode_version(row):
    if row is None:
        raise ObservationError("来源配置版本不存在", 1002, 404)
    try:
        value = SourceVersion.model_validate(row.snapshot).model_dump(mode="json")
        digest = content_hash(_payload(row.source_id, value["draft"]))
        if value != row.snapshot or any((value[key] != item) for key, item in (
            ("sourceId", row.source_id), ("configRevision", row.config_revision),
            ("schemaVersion", row.schema_version), ("dataOrigin", row.data_origin),
            ("contentHash", row.content_hash), ("actorId", row.actor_id), ("createdAt", row.created_at),
        )) or row.content_hash != digest or row.config_revision != "SPV-" + digest:
            raise ValueError("来源版本摘要不一致")
        return value
    except (ValidationError, ValueError, TypeError, KeyError) as exc:
        raise ObservationError("来源版本存储内容损坏，未回退教学配置") from exc


def get_version(session, source_id, revision=None):
    explicit = revision is not None
    if revision is None:
        pointer = session.get(Current, source_id)
        if pointer is None:
            raise ObservationError("频谱来源不存在", 1002, 404)
        revision = pointer.config_revision
    row = session.get(Version, revision)
    if row is None or row.source_id != source_id:
        raise ObservationError("来源配置版本不存在" if explicit else "来源当前指针无效", 1002 if explicit else 5002, 404 if explicit else 503)
    return decode_version(row)


def _decode_operation(row):
    try:
        value = SourceReceipt.model_validate(row.receipt).model_dump(mode="json")
        if value != row.receipt or any(value[key] != item for key, item in (
            ("requestId", row.request_id), ("operationType", row.operation_type),
            ("sourceId", row.source_id), ("configRevision", row.config_revision),
            ("actorId", row.actor_id), ("committedAt", row.created_at),
        )):
            raise ValueError("来源回执身份不一致")
        return value
    except (ValidationError, ValueError, TypeError, KeyError) as exc:
        raise ObservationError("来源操作回执损坏") from exc


def _replay(session, request_id, actor, kind, digest):
    row = session.get(Operation, request_id)
    if row is None:
        return None
    if (row.actor_id, row.operation_type, row.request_digest) != (actor, kind, digest):
        raise ObservationError("请求标识已被其他身份、操作或内容使用", 1206, 409)
    return _decode_operation(row)


def _write_gate(actor):
    if not frontend_integration.integration_enabled():
        raise ObservationError("构造联调模式未开启", 1101, 401)
    if not isinstance(actor, str) or not actor.strip() or len(actor) > 120:
        raise ObservationError("须提供可信调用者身份", 1001, 422)


def save_source(request, *, actor_id, factory):
    _write_gate(actor_id)
    request = SourceSave.model_validate(request.model_dump(mode="json") if isinstance(request, SourceSave) else request)
    digest = content_hash({"operationType": "SOURCE_SAVE", **request.model_dump(mode="json")})
    draft = request.draft.model_dump(mode="json")
    version_hash = content_hash(_payload(request.sourceId, draft))
    revision = "SPV-" + version_hash
    for attempt in range(2):
        try:
            with factory.begin() as session:
                previous = _replay(session, request.requestId, actor_id, "SOURCE_SAVE", digest)
                if previous is not None:
                    return previous
                pointer = session.get(Current, request.sourceId)
                baseline = pointer.config_revision if pointer else None
                if baseline != request.baseConfigRevision:
                    raise ObservationError("来源配置版本已变化，请保留表单并刷新", 1204, 409)
                if pointer:
                    get_version(session, request.sourceId, baseline)
                row = session.get(Version, revision)
                stamp = _now()
                if row is None:
                    snapshot = {**_payload(request.sourceId, draft), "configRevision": revision,
                        "contentHash": version_hash, "createdAt": stamp, "actorId": actor_id}
                    row = Version(config_revision=revision, source_id=request.sourceId, schema_version=1,
                        data_origin=ORIGIN, content_hash=version_hash, snapshot=snapshot, actor_id=actor_id, created_at=stamp)
                    session.add(row)
                    session.flush()
                source = decode_version(row)
                changed = baseline != revision
                if pointer is None:
                    session.add(Current(source_id=request.sourceId, config_revision=revision))
                    session.flush()
                elif changed:
                    affected = session.execute(update(Current).where(Current.source_id == request.sourceId,
                        Current.config_revision == baseline).values(config_revision=revision), execution_options={"synchronize_session": False})
                    if affected.rowcount != 1:
                        raise ObservationError("来源保存并发冲突，原版本已保留", 1204, 409)
                receipt = SourceReceipt(requestId=request.requestId, operationType="SOURCE_SAVE",
                    sourceId=request.sourceId, configRevision=revision, changed=changed, actorId=actor_id,
                    committedAt=stamp, source=source, check=None).model_dump(mode="json")
                session.add(Operation(request_id=request.requestId, operation_type="SOURCE_SAVE",
                    request_digest=digest, actor_id=actor_id, source_id=request.sourceId,
                    config_revision=revision, receipt=receipt, created_at=stamp))
                return receipt
        except IntegrityError as exc:
            if attempt:
                raise ObservationError("来源保存竞争冲突，可核实原请求") from exc
        except SQLAlchemyError as exc:
            raise ObservationError("来源存储不可用，请检查迁移；没有建立连接") from exc


def check_source(source_id, request, *, actor_id, factory):
    _write_gate(actor_id)
    request = SourceCheck.model_validate(request.model_dump(mode="json") if isinstance(request, SourceCheck) else request)
    digest = content_hash({"operationType": "SOURCE_CHECK", "sourceId": source_id, **request.model_dump(mode="json")})
    for attempt in range(2):
        try:
            with factory.begin() as session:
                previous = _replay(session, request.requestId, actor_id, "SOURCE_CHECK", digest)
                if previous is not None:
                    return previous
                source = get_version(session, source_id, request.configRevision)
                issues = [{"field": name, "code": "MISSING", "message": "来源声明未提供该字段；未建立网络连接"}
                    for name in ("protocolHint", "endpoint", "intervalSeconds", "minKhz", "maxKhz") if source["draft"][name] is None]
                stamp = _now()
                result = OfflineCheck(checkId=request.requestId, sourceId=source_id, configRevision=request.configRevision,
                    checkedAt=stamp, validation="INCOMPLETE" if issues else "VALID", connection="NOT_ATTEMPTED",
                    validationMode="OFFLINE_ONLY", issues=issues)
                receipt = SourceReceipt(requestId=request.requestId, operationType="SOURCE_CHECK", sourceId=source_id,
                    configRevision=request.configRevision, changed=False, actorId=actor_id, committedAt=stamp,
                    source=None, check=result).model_dump(mode="json")
                session.add(Operation(request_id=request.requestId, operation_type="SOURCE_CHECK", request_digest=digest,
                    actor_id=actor_id, source_id=source_id, config_revision=request.configRevision, receipt=receipt, created_at=stamp))
                return receipt
        except IntegrityError as exc:
            if attempt:
                raise ObservationError("离线检查回执竞争冲突，可核实原请求") from exc
        except SQLAlchemyError as exc:
            raise ObservationError("离线检查回执存储失败，未建立网络连接") from exc


def lookup(session, request_id, kind, actor_id):
    row = session.get(Operation, request_id)
    value = None
    if row is not None:
        if row.actor_id != actor_id:
            raise ObservationError("无权读取其他身份的操作回执", 1104, 403)
        if row.operation_type != kind:
            raise ObservationError("请求回执的操作类型不匹配", 1204, 409)
        value = _decode_operation(row)
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "requestId": request_id,
        "operationType": kind, "status": "COMMITTED" if value else "NOT_FOUND", "receipt": value}


def query_sources(session, query):
    statement = select(Version).join(Current, Current.config_revision == Version.config_revision)
    if query.search:
        statement = statement.where(or_(Current.source_id.contains(query.search, autoescape=True),
            Version.snapshot["draft"]["name"].as_string().contains(query.search, autoescape=True)))
    if query.enabled is not None:
        statement = statement.where(Version.snapshot["draft"]["enabled"].as_boolean() == query.enabled)
    total = session.scalar(select(func.count()).select_from(statement.subquery()))
    offset = (query.page - 1) * query.page_size
    rows = session.scalars(statement.order_by(Current.source_id).offset(offset).limit(query.page_size)) if offset < total else []
    items = []
    for row in rows:
        item = decode_version(row)
        check = session.scalars(select(Operation).where(Operation.source_id == row.source_id,
            Operation.config_revision == row.config_revision, Operation.operation_type == "SOURCE_CHECK")
            .order_by(Operation.created_at.desc(), Operation.request_id).limit(1)).first()
        items.append({**item, "latestOfflineCheck": _decode_operation(check)["check"] if check else None})
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "items": items,
        "page": query.page, "pageSize": query.page_size, "total": total}


def history(session, source_id, page, page_size, *, checks=False, revision=None):
    get_version(session, source_id, revision)
    statement = select(Operation).where(Operation.source_id == source_id, Operation.operation_type == "SOURCE_CHECK") if checks else select(Version).where(Version.source_id == source_id)
    if checks and revision is not None:
        statement = statement.where(Operation.config_revision == revision)
    total = session.scalar(select(func.count()).select_from(statement.subquery()))
    offset = (page - 1) * page_size
    ordering = (Operation.created_at.desc(), Operation.request_id) if checks else (Version.created_at.desc(), Version.config_revision)
    rows = session.scalars(statement.order_by(*ordering).offset(offset).limit(page_size)) if offset < total else []
    items = [_decode_operation(row)["check"] if checks else decode_version(row) for row in rows]
    return {"schemaVersion": 1, "dataOrigin": ORIGIN, "sourceId": source_id,
        "items": items, "page": page, "pageSize": page_size, "total": total}


def export_source(session, source_id, revision):
    source = get_version(session, source_id, revision)
    return {"schemaVersion": 1, "fileKind": "SPECTRUM_SOURCE_CONFIG", "dataOrigin": ORIGIN,
        "sourceId": source_id, "configRevision": revision, "draft": source["draft"]}
