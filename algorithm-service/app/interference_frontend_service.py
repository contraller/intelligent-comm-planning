"""独立干扰场景持久化：事务内冻结来源，读取不调用计算引擎。"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from types import SimpleNamespace
from uuid import uuid4

from pydantic import ValidationError
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import ArgumentError, IntegrityError, OperationalError, SQLAlchemyError

from .database import DatabaseConfigurationError, get_session_factory
from .fault_plan_source import FaultPlanSourceError, _snapshot as validate_plan_topology
from .interference_frontend_models import InterferenceScene, InterferenceSceneReceipt, InterferenceSceneVersion
from .interference_frontend_schemas import FrozenPlan, SceneReceipt, SceneSummary, SceneVersion
from .planning_plan_models import PlanningCurrentPlan, PlanningPlan
from .task_input_models import PlanningTask
from .resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from . import resource_dataset_service as datasets

CONTENT_KEYS = ("schema_version", "name", "note", "plan_snapshot", "resource_revision",
                "resource_content_hash", "data_origin", "source", "interference_ids", "interference_sources")


class InterferenceSceneError(ValueError):
    def __init__(self, message, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


def fail(message, code=1001, status=422):
    raise InterferenceSceneError(message, code, status)


def _hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _iso(stamp):
    return stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).isoformat().replace("+00:00", "Z")


@contextmanager
def _session(*, writing=False):
    try:
        if not datasets.database_mode():
            fail("干扰场景仅支持已初始化的数据库资源", 5003, 503)
        with get_session_factory()() as session:
            try:
                if session.get_bind().dialect.name == "sqlite":
                    # 在读取资源/确认指针前取得写事务，防止跨连接来源切换竞态。
                    session.connection().exec_driver_sql("BEGIN IMMEDIATE" if writing else "BEGIN")
                yield session
                if writing:
                    session.commit()
            except Exception:
                session.rollback()
                raise
    except (DatabaseConfigurationError, ArgumentError) as exc:
        raise InterferenceSceneError("数据库配置无效", 5001, 503) from exc
    except datasets.ResourceDatasetError as exc:
        raise InterferenceSceneError(str(exc), exc.code, exc.status) from exc
    except IntegrityError:
        raise
    except OperationalError as exc:
        code = getattr(exc.orig, "sqlite_errorcode", 0) or 0
        if writing and (code & 255) in (5, 6):
            raise InterferenceSceneError("写入冲突，请以原请求编号核实或重试", 1203, 409) from exc
        if "no such table" in str(exc.orig).lower() or getattr(exc.orig, "sqlstate", None) == "42P01":
            raise InterferenceSceneError("干扰场景所需表尚未迁移", 5003, 503) from exc
        raise InterferenceSceneError("干扰场景数据库不可用", 5002, 503) from exc
    except SQLAlchemyError as exc:
        raise InterferenceSceneError("干扰场景数据库不可用", 5002, 503) from exc


def _check_plan(frozen):
    plan = FrozenPlan.model_validate(frozen)
    raw = plan.raw_snapshot
    if not isinstance(raw.get("solution_id"), str) or not raw["solution_id"]:
        raise ValueError("冻结算法方案身份缺失")
    if raw.get("terrain_fingerprint") is not None and not isinstance(raw["terrain_fingerprint"], str):
        raise ValueError("冻结地形指纹无效")
    # 复用已有纯拓扑校验；不调用另开 Session 的 load_plan_source 或地形加载。
    validate_plan_topology(SimpleNamespace(
        raw_snapshot=raw, input_snapshot=plan.input_snapshot, source=plan.source,
        task_id=plan.task_id, plan_id=plan.plan_id, revision_id=plan.input_version,
        resource_revision=plan.resource_revision, name="冻结方案", version_no=int(plan.plan_version[1:]),
        state="CONFIRMED"))
    _hash(frozen)


def _decode_version(row):
    if row is None:
        fail("场景最新版本指针损坏", 5002, 503)
    try:
        dto = SceneVersion.model_validate(row.snapshot).model_dump(mode="json")
        for field in ("scene_id", "task_id", "version_id", "version_no", "name", "plan_id",
                      "resource_revision", "snapshot_hash", "saved_by"):
            if dto[field] != getattr(row, field):
                raise ValueError("冻结版本索引不一致")
        if dto["saved_at"] != _iso(row.saved_at) or _hash({k: dto[k] for k in CONTENT_KEYS}) != row.snapshot_hash:
            raise ValueError("冻结版本内容校验失败")
        _check_plan(dto["plan_snapshot"])
        return deepcopy(dto)
    except (ValidationError, FaultPlanSourceError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise InterferenceSceneError("持久化场景快照损坏，禁止重组或降级", 5002, 503) from exc


def _receipt_dto(session, row):
    try:
        dto = SceneReceipt.model_validate(row.receipt).model_dump(mode="json")
        for key in ("request_id", "actor_id", "task_id", "scene_id", "version_id"):
            if dto[key] != getattr(row, key):
                raise ValueError("回执归属不一致")
        version = _decode_version(session.get(InterferenceSceneVersion, row.version_id))
        for key in ("task_id", "scene_id", "version_id", "version_no", "plan_id", "plan_version",
                    "resource_revision", "snapshot_hash", "data_origin"):
            if dto[key] != version[key]:
                raise ValueError("回执与冻结版本不一致")
        if dto["created_at"] != _iso(row.created_at):
            raise ValueError("回执时间不一致")
        return deepcopy(dto)
    except (ValidationError, ValueError, KeyError, TypeError) as exc:
        if isinstance(exc, InterferenceSceneError):
            raise
        raise InterferenceSceneError("持久化回执损坏", 5002, 503) from exc


def _replay(session, request_id, digest, actor_id):
    row = session.get(InterferenceSceneReceipt, request_id)
    if row is None:
        return None
    if row.actor_id != actor_id or row.request_digest != digest:
        fail("请求编号已被其他内容占用", 1206, 409)
    return _receipt_dto(session, row)


def _source_content(session, payload):
    pointer = session.scalar(select(PlanningCurrentPlan).where(
        PlanningCurrentPlan.task_id == payload.task_id).with_for_update())
    plan = session.get(PlanningPlan, payload.plan_id)
    if plan is None or plan.task_id != payload.task_id:
        fail("所选分析方案不存在或归属不符", 2001, 404)
    # 分析输入可为已保存的参考/候选方案；不写正式方案指针。
    if (plan.state not in {"SAVED", "REFERENCE", "CONFIRMED"} or plan.source != "SR4"
            or payload.plan_version != f"V{plan.version_no}"
            or plan.state == "CONFIRMED" and (pointer is None or pointer.plan_id != plan.plan_id)):
        fail("所选分析方案的状态或版本已变化", 1203, 409)
    resource_pointer = session.scalar(select(ResourceDatasetCurrent).where(
        ResourceDatasetCurrent.scope == datasets.SCOPE).with_for_update())
    if resource_pointer is None:
        fail("资源尚未初始化", 5003, 503)
    if payload.resource_revision != plan.resource_revision or resource_pointer.revision != plan.resource_revision:
        fail("请求、方案与当前资源版本不一致", 1205, 409)
    resource_row = session.get(ResourceDatasetVersion, resource_pointer.revision)
    if resource_row is None:
        fail("当前资源指针引用的版本不存在", 5002, 503)
    resource = datasets._decode(resource_row)
    frozen = {
        "task_id": plan.task_id, "plan_id": plan.plan_id, "plan_version": f"V{plan.version_no}",
        "input_version": plan.revision_id, "condition_version": plan.condition_version,
        "resource_revision": plan.resource_revision, "source": plan.source,
        "input_snapshot": deepcopy(plan.input_snapshot), "raw_snapshot": deepcopy(plan.raw_snapshot),
    }
    try:
        _check_plan(frozen)
    except (ValidationError, FaultPlanSourceError, ValueError, KeyError, TypeError, AttributeError) as exc:
        raise InterferenceSceneError("方案缺少完整冻结拓扑或需求引用", 1203, 409) from exc
    sources = {r["interference_id"]: r for r in resource["tables"]["interference_source.csv"]}
    if any(key not in sources for key in payload.interference_ids):
        fail("选定干扰源不属于指定资源版本")
    return {
        "schema_version": 1, "name": payload.name, "note": payload.note, "plan_snapshot": frozen,
        "resource_revision": resource["revision"], "resource_content_hash": resource["content_hash"],
        "data_origin": resource["data_origin"], "source": resource["source"],
        "interference_ids": list(payload.interference_ids),
        "interference_sources": [{"interference_id": key, "source_row": deepcopy(sources[key])}
                                 for key in payload.interference_ids],
    }


def save_scene(scene_id, payload, actor_id):
    digest = _hash({"operation": "SAVE_INTERFERENCE_SCENE", "scene_id": scene_id,
                    "actor_id": actor_id, "body": payload.model_dump(mode="json")})
    try:
        with _session(writing=True) as session:
            replay = _replay(session, payload.request_id, digest, actor_id)
            if replay is not None:
                return replay
            scene = session.scalar(select(InterferenceScene).where(
                InterferenceScene.scene_id == scene_id).with_for_update())
            if scene is not None and scene.task_id != payload.task_id:
                fail("场景不存在或归属不符", 2001, 404)
            if (scene is None and payload.base_scene_version_id is not None
                    or scene is not None and payload.base_scene_version_id != scene.latest_version_id):
                fail("场景基础版本已变化", 1203, 409)
            content = _source_content(session, payload)
            content_hash = _hash(content)
            previous = None if scene is None else _decode_version(session.get(InterferenceSceneVersion, scene.latest_version_id))
            if previous is not None and (previous["scene_id"], previous["task_id"], previous["version_no"]) != (
                    scene_id, payload.task_id, scene.latest_version_no):
                fail("场景最新指针归属损坏", 5002, 503)
            changed = previous is None or previous["snapshot_hash"] != content_hash
            stamp = datetime.now(timezone.utc)
            if changed:
                version_id, version_no = "ISV-" + uuid4().hex, 1 if scene is None else scene.latest_version_no + 1
                dto = {**content, "scene_id": scene_id, "task_id": payload.task_id,
                       "version_id": version_id, "version_no": version_no, "plan_id": payload.plan_id,
                       "plan_version": payload.plan_version, "source_count": len(payload.interference_ids),
                       "snapshot_hash": content_hash, "saved_at": _iso(stamp), "saved_by": actor_id,
                       "previous_version_id": None if scene is None else scene.latest_version_id}
                if scene is None:
                    session.add(InterferenceScene(scene_id=scene_id, task_id=payload.task_id,
                        latest_version_id=version_id, latest_version_no=version_no))
                    session.flush()
                else:
                    result = session.execute(update(InterferenceScene).where(
                        InterferenceScene.scene_id == scene_id,
                        InterferenceScene.latest_version_id == payload.base_scene_version_id,
                        InterferenceScene.latest_version_no == scene.latest_version_no,
                    ).values(latest_version_id=version_id, latest_version_no=version_no))
                    if result.rowcount != 1:
                        fail("场景基础版本已变化", 1203, 409)
                session.add(InterferenceSceneVersion(version_id=version_id, scene_id=scene_id,
                    task_id=payload.task_id, plan_id=payload.plan_id, resource_revision=payload.resource_revision,
                    version_no=version_no, name=payload.name, snapshot=dto, snapshot_hash=content_hash,
                    saved_by=actor_id, saved_at=stamp))
                session.flush()
            else:
                dto = previous
            receipt = SceneReceipt(
                request_id=payload.request_id, operation="SAVE_INTERFERENCE_SCENE", status="SUCCEEDED",
                actor_id=actor_id, task_id=payload.task_id, scene_id=scene_id,
                base_scene_version_id=payload.base_scene_version_id, version_id=dto["version_id"],
                version_no=dto["version_no"], plan_id=dto["plan_id"], plan_version=dto["plan_version"],
                resource_revision=dto["resource_revision"], snapshot_hash=dto["snapshot_hash"],
                data_origin=dto["data_origin"], changed=changed, created_at=_iso(stamp)).model_dump(mode="json")
            session.add(InterferenceSceneReceipt(request_id=payload.request_id, request_digest=digest,
                actor_id=actor_id, task_id=payload.task_id, scene_id=scene_id, version_id=dto["version_id"],
                receipt=receipt, created_at=stamp))
            return receipt
    except IntegrityError as exc:
        # 新场景或幂等键的跨事务竞争：只有同操作者同摘要的持久化记录可重放。
        with _session() as session:
            replay = _replay(session, payload.request_id, digest, actor_id)
            if replay is not None:
                return replay
        raise InterferenceSceneError("保存发生持久化冲突，请核对场景版本", 1203, 409) from exc


def _scene(session, scene_id, task_id):
    row = session.get(InterferenceScene, scene_id)
    if row is None or row.task_id != task_id:
        fail("场景不存在或归属不符", 2001, 404)
    return row


def _summary(row):
    dto = _decode_version(row)
    return SceneSummary.model_validate({k: dto[k] for k in SceneSummary.model_fields}).model_dump(mode="json")


def list_scenes(query):
    with _session() as session:
        statement = select(InterferenceScene, InterferenceSceneVersion).outerjoin(
            InterferenceSceneVersion, InterferenceSceneVersion.version_id == InterferenceScene.latest_version_id
        ).where(InterferenceScene.task_id == query.task_id)
        if query.search:
            statement = statement.where(or_(InterferenceScene.scene_id.contains(query.search, autoescape=True),
                InterferenceSceneVersion.name.contains(query.search, autoescape=True)))
        total = session.scalar(select(func.count()).select_from(statement.subquery()))
        rows = session.execute(statement.order_by(InterferenceSceneVersion.saved_at.desc(), InterferenceScene.scene_id)
            .offset((query.page - 1) * query.page_size).limit(query.page_size)).all()
        items = []
        for scene, version in rows:
            dto = _summary(version)
            if (dto["scene_id"] != scene.scene_id or dto["task_id"] != scene.task_id
                    or dto["version_no"] != scene.latest_version_no):
                fail("场景最新指针归属损坏", 5002, 503)
            items.append(dto)
        return {"items": items, "total": total, "page": query.page, "page_size": query.page_size}


def scene_versions(scene_id, query):
    with _session() as session:
        _scene(session, scene_id, query.task_id)
        statement = select(InterferenceSceneVersion).where(
            InterferenceSceneVersion.scene_id == scene_id, InterferenceSceneVersion.task_id == query.task_id)
        total = session.scalar(select(func.count()).select_from(statement.subquery()))
        rows = session.scalars(statement.order_by(InterferenceSceneVersion.version_no.desc())
            .offset((query.page - 1) * query.page_size).limit(query.page_size)).all()
        return {"items": [_summary(r) for r in rows], "total": total, "page": query.page, "page_size": query.page_size}


def scene_detail(scene_id, query):
    with _session() as session:
        scene = _scene(session, scene_id, query.task_id)
        row = session.get(InterferenceSceneVersion, query.version_id or scene.latest_version_id)
        if query.version_id and (row is None or row.scene_id != scene_id or row.task_id != query.task_id):
            fail("场景版本不存在或归属不符", 2001, 404)
        dto = _decode_version(row)
        if dto["scene_id"] != scene_id or dto["task_id"] != query.task_id:
            fail("场景最新指针归属损坏", 5002, 503)
        current_plan = session.get(PlanningCurrentPlan, query.task_id)
        current_resource = session.get(ResourceDatasetCurrent, datasets.SCOPE)
        plan_row = session.get(PlanningPlan, dto["plan_id"])
        resource_row = session.get(ResourceDatasetVersion, current_resource.revision) if current_resource else None
        task_row = session.get(PlanningTask, query.task_id)
        frozen_plan = dto["plan_snapshot"]
        missing = (plan_row is None or resource_row is None or task_row is None
                   or plan_row.state not in {"SAVED", "REFERENCE", "CONFIRMED"} or plan_row.source != "SR4")
        reasons = []
        if plan_row is not None and plan_row.state == "CONFIRMED" and (current_plan is None or current_plan.plan_id != dto["plan_id"]):
            reasons.append("当前确认方案已切换")
        if current_resource is not None and current_resource.revision != dto["resource_revision"]:
            reasons.append("当前资源版本已变化")
        if task_row is not None and task_row.current_revision_id != frozen_plan["input_version"]:
            reasons.append("当前任务输入已更新")
        if plan_row is not None:
            if (plan_row.task_id != query.task_id or f"V{plan_row.version_no}" != dto["plan_version"]
                    or plan_row.revision_id != frozen_plan["input_version"]
                    or plan_row.condition_version != frozen_plan["condition_version"]
                    or plan_row.resource_revision != frozen_plan["resource_revision"]):
                reasons.append("所选方案版本或来源已变化")
            if (plan_row.raw_snapshot != frozen_plan["raw_snapshot"]
                    or plan_row.input_snapshot != frozen_plan["input_snapshot"]):
                reasons.append("原方案冻结内容发生变化或缺失")
        if missing:
            reasons.append("当前来源指针缺失，保留冻结数据")
        state = "HISTORICAL" if reasons and not missing else "UNKNOWN" if missing else "CURRENT"
        return {"version": dto, "source_state": {"state": state, "reasons": reasons}}


def scene_receipt(request_id, query, actor_id):
    with _session() as session:
        row = session.get(InterferenceSceneReceipt, request_id)
        if row is None or (row.task_id, row.scene_id, row.actor_id) != (query.task_id, query.scene_id, actor_id):
            fail("没有可见的成功回执", 2001, 404)
        return _receipt_dto(session, row)
