"""配置请求持久化与只读历史，不调用设备控制或资源写入入口。"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import math
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import func, inspect, select, text
from sqlalchemy.exc import ArgumentError, IntegrityError, SQLAlchemyError

from .database import DatabaseConfigurationError, get_session_factory
from . import resource_dataset_service as datasets
from .resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from .device_configuration_models import DeviceConfigurationRequest
from .device_configuration_schemas import (
    AcceptanceActor, AcceptanceActorV2, ConfigurationAcceptance, ConfigurationAcceptanceV2, ConfigurationContext, ConfigurationSubmission,
    ConfigurationValidation, DeviceSnapshot, ModelConstraints, Provenance, SCHEMA_VERSION,
)


class ConfigurationError(ValueError):
    def __init__(self, message: str, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


@contextmanager
def _session(*, writing=False):
    if not datasets.database_mode():
        raise ConfigurationError("配置受理仅支持已初始化的数据库模式", 5003, 503)
    try:
        with get_session_factory()() as session:
            if writing:
                if session.get_bind().dialect.name != "sqlite":
                    raise ConfigurationError("当前数据库的受理事务锁语义待确认", 5003, 503)
                # 先取得写锁再读取资源指针，避免校验后资源被并发维护换版。
                session.execute(text("BEGIN IMMEDIATE"))
            required = (DeviceConfigurationRequest.__tablename__, ResourceDatasetCurrent.__tablename__,
                        ResourceDatasetVersion.__tablename__)
            inspector = inspect(session.connection())
            if any(not inspector.has_table(name) for name in required):
                raise ConfigurationError("配置受理所需表尚未迁移", 5003, 503)
            yield session
            if writing:
                session.commit()
    except (DatabaseConfigurationError, ArgumentError) as exc:
        raise ConfigurationError("数据库配置缺失或无效", 5001, 503) from exc
    except IntegrityError:
        raise
    except SQLAlchemyError as exc:
        raise ConfigurationError("配置受理数据库操作失败，可核实或重试原请求", 5002, 503) from exc


def _number(raw, *, optional=False):
    if optional and raw in (None, ""):
        return None
    try:
        value = float(raw)
        if isinstance(raw, bool) or not math.isfinite(value):
            raise ValueError("非有限数值")
        return value
    except (ValueError, TypeError, OverflowError) as exc:
        raise ConfigurationError("资源参数或型号数值无效", 5002, 503) from exc


def _context(session, revision, device_id, model_id=None):
    pointer = session.get(ResourceDatasetCurrent, datasets.SCOPE)
    if pointer is None:
        raise ConfigurationError("资源尚未初始化", 5003, 503)
    if pointer.revision != revision:
        raise ConfigurationError("资源版本已变化，请刷新配置上下文", 1205, 409)
    version = session.get(ResourceDatasetVersion, pointer.revision)
    if version is None:
        raise ConfigurationError("资源指针引用的快照不存在", 5002, 503)
    snapshot = datasets._decode(version)
    device = next((row for row in snapshot["tables"]["device.csv"] if row["device_id"] == device_id), None)
    if device is None:
        raise ConfigurationError("设备不存在", 1002, 404)
    if device.get("availability", "ACTIVE") != "ACTIVE":
        raise ConfigurationError("设备已下架，不能受理配置请求", 1203, 409)
    if model_id is not None and model_id != device["model_id"]:
        raise ConfigurationError("设备型号与请求不一致", 1203, 409)
    model = next(row for row in snapshot["tables"]["device_model.csv"] if row["model_id"] == device["model_id"])
    try:
        return ConfigurationContext(
            resource_revision=revision, resource_content_hash=snapshot["content_hash"],
            device=DeviceSnapshot(device_id=device_id, node_id=device["node_id"], model_id=device["model_id"],
                availability="ACTIVE", source_values={key: _number(device.get(key), optional=True)
                    for key in ("tx_power_dbm", "work_freq_khz")}),
            model=ModelConstraints(model_id=model["model_id"], **{key: _number(model.get(key))
                for key in ("freq_min_khz", "freq_max_khz", "tx_power_max_dbm")}),
            provenance=Provenance(data_origin=snapshot["data_origin"], resource_source=snapshot["source"],
                source_files=snapshot["source_files"]),
        )
    except ValidationError as exc:
        raise ConfigurationError("资源设备、型号约束或来源损坏", 5002, 503) from exc


def _validate(session, payload: ConfigurationValidation):
    context = _context(session, payload.base_revision, payload.device_id, payload.model_id)
    if payload.values.tx_power_dbm > context.model.tx_power_max_dbm:
        raise ConfigurationError("请求功率超过型号上限")
    if not context.model.freq_min_khz <= payload.values.work_freq_khz <= context.model.freq_max_khz:
        raise ConfigurationError("请求频率超出型号范围")
    return context


def load_context(revision: str, device_id: str):
    with _session() as session:
        return _context(session, revision, device_id).model_dump(mode="json")


def validate_request(payload: ConfigurationValidation):
    with _session() as session:
        context = _validate(session, payload)
        return {"valid": True, "context": context.model_dump(mode="json"),
                "requested_values": payload.values.model_dump(mode="json")}


def request_digest(payload: ConfigurationValidation):
    canonical = payload.model_dump(exclude={"request_id"})
    canonical["values"] = {key: (0.0 if value == 0 else float(value))
                           for key, value in canonical["values"].items()}
    return datasets.content_hash(canonical)


def _receipt(row: DeviceConfigurationRequest):
    try:
        model = {SCHEMA_VERSION: ConfigurationAcceptance, "device-configuration-a2": ConfigurationAcceptanceV2}.get(row.schema_version)
        if model is None or not isinstance(row.receipt, dict) or set(row.receipt) != set(model.model_fields):
            raise ValueError("冻结回执字段缺失或未约定")
        result = model.model_validate(row.receipt).model_dump(mode="json")
        columns = ("schema_version", "configuration_id", "request_id", "request_digest", "device_id",
                   "model_id", "base_revision", "resource_content_hash")
        if any(result[key] != getattr(row, key) for key in columns) or result["actor"]["account_id"] != row.actor_id:
            raise ValueError("索引与冻结回执不一致")
        accepted = datetime.fromisoformat(result["accepted_at"].replace("Z", "+00:00"))
        if row.accepted_at.replace(tzinfo=timezone.utc) != accepted:
            raise ValueError("受理时间不一致")
        # a2 只升级受理身份快照；原请求业务 wire 仍为 a1，摘要和幂等不改写。
        original = ConfigurationValidation(schema_version=SCHEMA_VERSION, context=result["context"],
            base_revision=result["base_revision"], device_id=result["device_id"], model_id=result["model_id"],
            values=result["requested_values"])
        if request_digest(original) != row.request_digest:
            raise ValueError("请求摘要不一致")
        return deepcopy(result)
    except (ValidationError, ValueError, TypeError) as exc:
        raise ConfigurationError("持久化受理回执损坏", 5002, 503) from exc


def _replay(row, digest, actor_id):
    if row.actor_id != actor_id or row.request_digest != digest:
        raise ConfigurationError("请求编号已被其他内容或身份使用", 1206, 409)
    return _receipt(row)


def submit_request(payload: ConfigurationSubmission, actor: dict):
    digest = request_digest(payload)
    try:
        with _session(writing=True) as session:
            previous = session.get(DeviceConfigurationRequest, payload.request_id)
            if previous is not None:
                return _replay(previous, digest, actor["account_id"])
            context = _validate(session, payload)
            stamp = datetime.now(timezone.utc)
            try:
                actor_model = AcceptanceActorV2 if "authentication_mode" in actor else AcceptanceActor
                frozen_actor = actor_model(**{key: actor[key] for key in actor_model.model_fields})
            except (KeyError, ValidationError) as exc:
                raise ConfigurationError("可信身份快照接线缺失或不符", 5001, 503) from exc
            receipt_model = ConfigurationAcceptanceV2 if isinstance(frozen_actor, AcceptanceActorV2) else ConfigurationAcceptance
            receipt = receipt_model(
                configuration_id="DC-" + uuid4().hex, request_id=payload.request_id, request_digest=digest,
                device_id=payload.device_id, model_id=payload.model_id, base_revision=payload.base_revision,
                resource_content_hash=context.resource_content_hash, requested_values=payload.values,
                device_snapshot=context.device, model_constraints=context.model, provenance=context.provenance,
                actor=frozen_actor,
                accepted_at=stamp.isoformat().replace("+00:00", "Z"),
            ).model_dump(mode="json")
            session.add(DeviceConfigurationRequest(
                request_id=payload.request_id, configuration_id=receipt["configuration_id"], schema_version=receipt["schema_version"],
                request_digest=digest, actor_id=actor["account_id"], device_id=payload.device_id,
                model_id=payload.model_id, base_revision=payload.base_revision,
                resource_content_hash=context.resource_content_hash, accepted_at=stamp, receipt=receipt,
            ))
        return receipt
    except IntegrityError as exc:
        with _session() as session:
            previous = session.get(DeviceConfigurationRequest, payload.request_id)
            if previous is not None:
                return _replay(previous, digest, actor["account_id"])
        raise ConfigurationError("受理提交冲突，可核实或重试原请求", 5002, 503) from exc


def get_request(request_id: str, actor_id: str):
    with _session() as session:
        row = session.get(DeviceConfigurationRequest, request_id)
        if row is None or row.actor_id != actor_id:
            raise ConfigurationError("配置请求不存在", 1002, 404)
        return _receipt(row)


def query_history(actor_id: str, *, device_id=None, page=1, page_size=20):
    with _session() as session:
        clauses = [DeviceConfigurationRequest.actor_id == actor_id]
        if device_id is not None:
            clauses.append(DeviceConfigurationRequest.device_id == device_id)
        total = session.scalar(select(func.count()).select_from(DeviceConfigurationRequest).where(*clauses))
        rows = session.scalars(select(DeviceConfigurationRequest).where(*clauses).order_by(
            DeviceConfigurationRequest.accepted_at.desc(), DeviceConfigurationRequest.configuration_id.desc()
        ).offset((page - 1) * page_size).limit(page_size))
        keys = ("configuration_id", "request_id", "device_id", "model_id", "base_revision", "requested_values",
                "accepted_at", "status", "receipt_scope", "dispatch_status")
        items = []
        for row in rows:
            receipt = _receipt(row)
            items.append({**{key: receipt[key] for key in keys}, "data_origin": receipt["provenance"]["data_origin"]})
        return {"schema_version": SCHEMA_VERSION, "context": "ledger", "items": items,
                "total": total, "page": page, "page_size": page_size}
