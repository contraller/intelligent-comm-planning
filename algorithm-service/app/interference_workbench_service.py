"""R2 持久化干扰工作流；写入受理与来源冻结同事务，GET只读。"""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import threading
from uuid import uuid4

from sqlalchemy import func, or_, select
from sqlalchemy.exc import ArgumentError, IntegrityError, OperationalError, SQLAlchemyError

from .database import DatabaseConfigurationError, get_session_factory
from . import interference_frontend_service as scenes, resource_dataset_service as resources
from .interference_analysis_engine import AnalysisCancelled, AnalysisInputError, FrozenInterferenceEngine, digest, runtime_path
from .interference_frontend_models import InterferenceScene, InterferenceSceneVersion
from .interference_workbench_models import InterferenceWorkbenchAdoption as Adoption
from .interference_workbench_models import InterferenceWorkbenchOperation as Operation
from .interference_workbench_models import InterferenceWorkbenchRun as Run
from .planning_plan_models import PlanningCurrentPlan, PlanningPlan
from .resource_dataset_models import ResourceDatasetCurrent, ResourceDatasetVersion
from .task_input_models import PlanningTask

ACTIVE = ("PENDING", "RUNNING", "CANCEL_REQUESTED")
FINAL = ("SUCCESS", "FAILED", "CANCELLED")


class WorkbenchError(ValueError):
    def __init__(self, message, code=1001, status=422):
        super().__init__(message)
        self.code, self.status = code, status


def fail(message, code=1001, status=422):
    raise WorkbenchError(message, code, status)


def now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc).isoformat().replace("+00:00", "Z")


class InterferenceWorkbenchService:
    def __init__(self, session_factory=None, *, runtime_root=None, engine=None, replanner=None):
        self.factory = session_factory
        self.runtime_root = runtime_path(runtime_root)
        self.engine = engine or FrozenInterferenceEngine(runtime_root=self.runtime_root)
        from .interference_replan_service import InterferenceReplanService
        self.replanner = InterferenceReplanService(self, replanner)
        self.wakeup = threading.Event()

    @contextmanager
    def transaction(self, *, writing=False):
        try:
            if not resources.database_mode():
                fail("干扰工作流要求数据库资源模式", 5003, 503)
            with (self.factory or get_session_factory())() as session:
                try:
                    if session.get_bind().dialect.name == "sqlite":
                        from pathlib import Path
                        root = runtime_path()
                        database_path = Path(session.get_bind().url.database or "").resolve()
                        allowed_db = root.parent / "r2.sqlite"
                        temporary = root.parent / "tmp"
                        if database_path != allowed_db and not database_path.is_relative_to(temporary):
                            fail("数据库只能为本树r2.sqlite或本树tmp新测试库", 5001, 503)
                        session.connection().exec_driver_sql("BEGIN IMMEDIATE" if writing else "BEGIN")
                    else:
                        fail("本轮工作流仅允许本树SQLite", 5001, 503)
                    yield session
                    if writing:
                        session.commit()
                except Exception:
                    session.rollback()
                    raise
        except (DatabaseConfigurationError, ArgumentError) as exc:
            raise WorkbenchError("工作流数据库配置无效", 5001, 503) from exc
        except (resources.ResourceDatasetError, scenes.InterferenceSceneError) as exc:
            raise WorkbenchError(str(exc), exc.code, exc.status) from exc
        except IntegrityError as exc:
            raise WorkbenchError("请求或活动对象发生持久化竞争，请核实原请求", 1206, 409) from exc
        except OperationalError as exc:
            code = getattr(exc.orig, "sqlite_errorcode", 0) or 0
            if writing and (code & 255) in (5, 6):
                raise WorkbenchError("写入版本竞争，请重新核实对象", 1203, 409) from exc
            if "no such table" in str(exc.orig).lower():
                raise WorkbenchError("工作流表尚未迁移，禁止自动建表", 5003, 503) from exc
            raise WorkbenchError("工作流数据库不可用", 5002, 503) from exc
        except SQLAlchemyError as exc:
            raise WorkbenchError("工作流数据库不可用", 5002, 503) from exc

    @staticmethod
    def _run(session, run_id, task_id):
        run = session.get(Run, run_id)
        if run is None or run.task_id != task_id:
            fail("分析不存在或不可见", 2001, 404)
        if digest(run.source_snapshot) != run.source_hash:
            fail("运行冻结来源校验失败", 5002, 503)
        scene = run.source_snapshot.get("scene", {})
        if (scene.get("task_id"), scene.get("plan_id"), scene.get("version_id"), scene.get("resource_revision")) != (
                run.task_id, run.plan_id, run.scene_version_id, run.resource_revision):
            fail("运行冻结身份不一致", 5002, 503)
        if run.result_snapshot is not None and digest(run.result_snapshot) != run.result_hash:
            fail("分析结果校验失败", 5002, 503)
        if run.state == "SUCCESS" and run.result_snapshot is None:
            fail("成功运行缺少持久化结果", 5002, 503)
        if run.state != "SUCCESS" and (run.result_snapshot is not None or run.result_hash is not None):
            fail("未成功运行含有不应接受的结果", 5002, 503)
        return run

    @staticmethod
    def source_state(session, source):
        scene = source["scene"]
        pointer = session.get(PlanningCurrentPlan, scene["task_id"])
        resource = session.get(ResourceDatasetCurrent, resources.SCOPE)
        task = session.get(PlanningTask, scene["task_id"])
        if pointer is None or resource is None or task is None:
            return {"state": "UNKNOWN", "reasons": ["当前来源指针缺失，保留完整冻结历史"]}
        reasons = []
        if pointer.plan_id != scene["plan_id"]:
            reasons.append("当前确认方案已切换")
        if resource.revision != scene["resource_revision"]:
            reasons.append("当前资源版本已变化")
        if task.current_revision_id != scene["plan_snapshot"]["input_version"]:
            reasons.append("当前任务输入已更新")
        plan = session.get(PlanningPlan, scene["plan_id"])
        if plan is None or plan.raw_snapshot != scene["plan_snapshot"]["raw_snapshot"] or plan.input_snapshot != scene["plan_snapshot"]["input_snapshot"]:
            reasons.append("原方案冻结内容发生变化或缺失")
        return {"state": "HISTORICAL" if reasons else "CURRENT", "reasons": reasons}

    def _freeze(self, session, payload, actor):
        version = session.get(InterferenceSceneVersion, payload.scene_version_id)
        if version is None or version.task_id != payload.task_id:
            fail("场景版本不存在或归属不符", 2001, 404)
        scene = scenes._decode_version(version)
        expected = (payload.plan_id, payload.plan_version, payload.resource_revision, payload.snapshot_hash)
        if (scene["plan_id"], scene["plan_version"], scene["resource_revision"], scene["snapshot_hash"]) != expected:
            fail("所选场景版本与方案/资源身份不一致", 1203, 409)
        if hasattr(payload, "scene_id") and scene["scene_id"] != payload.scene_id:
            fail("场景版本不属于指定场景", 2001, 404)
        resource_row = session.get(ResourceDatasetVersion, scene["resource_revision"])
        resource = resources._decode(resource_row)
        if resource["content_hash"] != scene["resource_content_hash"]:
            fail("场景与资源内容哈希不一致", 5002, 503)
        source = {"schema_version": 1, "scene": scene, "resource": resource,
                  "actor": {"account_id": actor["account_id"]}}
        self._require_current(session, source)
        try:
            self.engine.validate_source(source)
        except (AnalysisInputError, KeyError, TypeError, ValueError) as exc:
            raise WorkbenchError(str(exc), 1203, 409) from exc
        return source

    def _require_current(self, session, source):
        scene = source["scene"]
        pointer = session.scalar(select(PlanningCurrentPlan).where(
            PlanningCurrentPlan.task_id == scene["task_id"]).with_for_update())
        resource = session.scalar(select(ResourceDatasetCurrent).where(
            ResourceDatasetCurrent.scope == resources.SCOPE).with_for_update())
        plan = session.get(PlanningPlan, scene["plan_id"])
        task = session.get(PlanningTask, scene["task_id"])
        if plan is None or task is None:
            fail("所选分析方案或任务不存在", 2001, 404)
        if resource is None:
            fail("资源尚未初始化", 5003, 503)
        if resource.revision != scene["resource_revision"]:
            fail("资源版本已变化", 1205, 409)
        if (plan.task_id != scene["task_id"]
                or plan.state not in {"SAVED", "REFERENCE", "CONFIRMED"}
                or plan.state == "CONFIRMED" and (pointer is None or pointer.plan_id != plan.plan_id)
                or plan.source != "SR4" or f"V{plan.version_no}" != scene["plan_version"]
                or task.current_revision_id != scene["plan_snapshot"]["input_version"]
                or plan.input_snapshot != scene["plan_snapshot"]["input_snapshot"]
                or plan.raw_snapshot != scene["plan_snapshot"]["raw_snapshot"]):
            fail("方案或任务输入不再是场景的当前确认来源", 1203, 409)

    @staticmethod
    def _replay(session, request_id, operation, actor_id, request_digest):
        row = session.get(Operation, request_id)
        if row is None:
            return None
        if (row.operation, row.actor_id, row.request_digest) != (operation, actor_id, request_digest):
            fail("请求编号已用于其他内容或操作者", 1206, 409)
        return InterferenceWorkbenchService._operation_dto(row)

    @staticmethod
    def _operation_dto(row):
        receipt = row.receipt
        if (digest(receipt) != row.receipt_hash or receipt.get("request_id") != row.request_id
                or receipt.get("actor_id") != row.actor_id or receipt.get("operation") != row.operation
                or receipt.get("task_id") != row.task_id or receipt.get("object_id") != row.object_id
                or receipt.get("object_type") != row.object_type):
            fail("受理回执校验失败", 5002, 503)
        return deepcopy(receipt)

    def _receipt(self, session, payload, operation, actor, row, request_digest, changed=True, extra=None):
        is_run = isinstance(row, Run)
        receipt = {"request_id": payload.request_id, "operation": operation, "actor_id": actor["account_id"],
            "task_id": payload.task_id, "object_type": "RUN" if is_run else "ADOPTION",
            "object_id": row.run_id if is_run else row.adoption_id,
            "accepted_version": row.run_version if is_run else row.adoption_version,
            "changed": changed, "status": "ACCEPTED", "source_hash": row.source_hash,
            "data_origin": row.source_snapshot["scene"]["data_origin"] if is_run else self._run(session, row.run_id, row.task_id).source_snapshot["scene"]["data_origin"],
            "accepted_at": iso(now()), **(extra or {})}
        session.add(Operation(request_id=payload.request_id, operation=operation, actor_id=actor["account_id"],
            task_id=payload.task_id, request_digest=request_digest, object_type=receipt["object_type"],
            object_id=receipt["object_id"], receipt=receipt, receipt_hash=digest(receipt), created_at=now()))
        return receipt

    def submit_run(self, payload, actor):
        request_digest = digest({"operation": "SUBMIT_ANALYSIS", "actor": actor["account_id"], "body": payload.model_dump()})
        with self.transaction(writing=True) as session:
            replay = self._replay(session, payload.request_id, "SUBMIT_ANALYSIS", actor["account_id"], request_digest)
            if replay is not None:
                return replay
            source = self._freeze(session, payload, actor)
            active = session.scalar(select(Run.run_id).where(Run.active_task_key == payload.task_id))
            if active:
                fail("本任务已有活动分析", 2002, 409)
            stamp = now()
            run = Run(run_id="IRN-" + uuid4().hex, request_id=payload.request_id, task_id=payload.task_id,
                plan_id=payload.plan_id, scene_version_id=payload.scene_version_id, resource_revision=payload.resource_revision,
                active_task_key=payload.task_id, run_version=1, state="PENDING", progress=0, phase="已受理，等待计算",
                source_snapshot=source, source_hash=digest(source), actor_id=actor["account_id"], started_at=stamp, updated_at=stamp)
            session.add(run)
            session.flush()
            receipt = self._receipt(session, payload, "SUBMIT_ANALYSIS", actor, run, request_digest)
        self.wakeup.set()
        return receipt

    def cancel_run(self, run_id, payload, actor):
        request_digest = digest({"operation": "CANCEL_ANALYSIS", "run_id": run_id, "actor": actor["account_id"], "body": payload.model_dump()})
        with self.transaction(writing=True) as session:
            replay = self._replay(session, payload.request_id, "CANCEL_ANALYSIS", actor["account_id"], request_digest)
            if replay is not None:
                return replay
            run = self._run(session, run_id, payload.task_id)
            changed = run.state not in FINAL and run.state != "CANCEL_REQUESTED"
            if run.state not in FINAL and run.run_version != payload.expected_run_version:
                fail("运行版本已变化", 1203, 409)
            if changed:
                run.state, run.phase = "CANCEL_REQUESTED", "取消已请求，等待计算检查点"
                run.run_version += 1
                run.updated_at = now()
            receipt = self._receipt(session, payload, "CANCEL_ANALYSIS", actor, run, request_digest, changed,
                                    {"object_state": run.state})
        self.wakeup.set()
        return receipt

    def operation(self, request_id, query, actor):
        with self.transaction() as session:
            row = session.get(Operation, request_id)
            if row is None or (row.task_id, row.operation, row.actor_id) != (query.task_id, query.operation, actor["account_id"]):
                fail("没有可见的受理回执", 2001, 404)
            return self._operation_dto(row)

    def _progress(self, session, run):
        source = run.source_snapshot["scene"]
        return {"run_id": run.run_id, "task_id": run.task_id, "scene_id": source["scene_id"],
            "scene_version_id": run.scene_version_id, "plan_id": run.plan_id, "plan_version": source["plan_version"],
            "resource_revision": run.resource_revision, "run_version": run.run_version, "state": run.state,
            "progress": run.progress, "phase": run.phase, "cancel_requested": run.state == "CANCEL_REQUESTED",
            "error": run.error, "source_hash": run.source_hash, "source_state": self.source_state(session, run.source_snapshot),
            "data_origin": source["data_origin"], "started_at": iso(run.started_at), "updated_at": iso(run.updated_at)}

    def progress(self, run_id, query):
        with self.transaction() as session:
            return self._progress(session, self._run(session, run_id, query.task_id))

    def detail(self, run_id, query):
        with self.transaction() as session:
            run = self._run(session, run_id, query.task_id)
            result = deepcopy(run.result_snapshot)
            if result is not None:
                result.pop("previews", None)
            adoptions = session.scalars(select(Adoption).where(Adoption.run_id == run_id).order_by(Adoption.created_at)).all()
            capabilities = self.replanner.capabilities()
            source_state = self.source_state(session, run.source_snapshot)
            if source_state["state"] != "CURRENT":
                for item in capabilities.values():
                    item["enabled"] = False
                    item["reasons"] = [*item["reasons"], *source_state["reasons"]]
            return {**self._progress(session, run), "source": deepcopy(run.source_snapshot["scene"]),
                "result": result, "result_hash": run.result_hash,
                "adoptions": [self.replanner.dto(session, row) for row in adoptions],
                "adoption_capabilities": capabilities}

    def preview(self, run_id, measure_id, query):
        with self.transaction() as session:
            run = self._run(session, run_id, query.task_id)
            if run.run_version != query.expected_run_version:
                fail("运行版本已变化", 1203, 409)
            if run.state != "SUCCESS":
                fail("分析尚未成功，不能读取措施预览", 2002, 409)
            preview = run.result_snapshot.get("previews", {}).get(measure_id)
            if preview is None:
                fail("措施预览不存在", 2001, 404)
            frozen = {k: v for k, v in preview.items() if k != "preview_hash"}
            if digest(frozen) != preview.get("preview_hash"):
                fail("措施预览校验失败", 5002, 503)
            return {**deepcopy(preview), "run_id": run_id, "run_version": run.run_version, "source_hash": run.source_hash}

    def runs(self, query):
        with self.transaction() as session:
            statement = select(Run).where(Run.task_id == query.task_id)
            if query.state:
                statement = statement.where(Run.state == query.state)
            if query.search:
                statement = statement.where(or_(Run.run_id.contains(query.search, autoescape=True),
                                                Run.plan_id.contains(query.search, autoescape=True)))
            total = session.scalar(select(func.count()).select_from(statement.subquery()))
            rows = session.scalars(statement.order_by(Run.started_at.desc(), Run.run_id)
                .offset((query.page - 1) * query.page_size).limit(query.page_size)).all()
            items = []
            for row in rows:
                self._run(session, row.run_id, row.task_id)
                items.append({**self._progress(session, row), "adoption_count": session.scalar(
                    select(func.count()).select_from(Adoption).where(Adoption.run_id == row.run_id))})
            return {"items": items, "total": total, "page": query.page, "page_size": query.page_size}

    def _source_options(self, session, query):
        statement = select(PlanningPlan).where(PlanningPlan.state.in_(("SAVED", "REFERENCE", "CONFIRMED")))
        if query.task_id:
            statement = statement.where(PlanningPlan.task_id == query.task_id)
        if getattr(query, "search", ""):
            statement = statement.where(or_(PlanningPlan.name.contains(query.search, autoescape=True),
                                            PlanningPlan.plan_id.contains(query.search, autoescape=True)))
        total = session.scalar(select(func.count()).select_from(statement.subquery()))
        page, size = getattr(query, "page", 1), getattr(query, "page_size", 20)
        rows = session.scalars(statement.order_by(PlanningPlan.saved_at.desc(), PlanningPlan.plan_id)
            .offset((page - 1) * size).limit(size)).all()
        resource = session.get(ResourceDatasetCurrent, resources.SCOPE)
        items = []
        for plan in rows:
            frozen = {"task_id": plan.task_id, "plan_id": plan.plan_id, "plan_version": f"V{plan.version_no}",
                "input_version": plan.revision_id, "condition_version": plan.condition_version,
                "resource_revision": plan.resource_revision, "source": plan.source,
                "input_snapshot": plan.input_snapshot, "raw_snapshot": plan.raw_snapshot}
            task = session.get(PlanningTask, plan.task_id)
            reasons = []
            pointer = session.get(PlanningCurrentPlan, plan.task_id)
            is_current = pointer is not None and pointer.plan_id == plan.plan_id and plan.state == "CONFIRMED"
            if plan.source != "SR4" or plan.state == "CONFIRMED" and not is_current:
                reasons.append("不是可用的已保存SR4方案")
            if resource is None or resource.revision != plan.resource_revision:
                reasons.append("资源版本已变化或缺失")
            if task is None or task.current_revision_id != plan.revision_id:
                reasons.append("任务输入已变化或缺失")
            try:
                scenes._check_plan(frozen)
                reasons.extend(self.engine.probe_plan(frozen))
            except (ValueError, KeyError, TypeError, AttributeError) as exc:
                reasons.append("冻结方案不完整：" + str(exc))
            resource_row = session.get(ResourceDatasetVersion, plan.resource_revision)
            origin = resources._decode(resource_row)["data_origin"] if resource_row else None
            items.append({k: frozen[k] for k in ("task_id", "plan_id", "plan_version", "input_version",
                "condition_version", "resource_revision", "source")} | {
                "name": plan.name, "plan_snapshot_id": plan.result_snapshot.get("snapshot_id"),
                "data_origin": origin, "current": is_current, "eligible": not reasons,
                "unavailable_reasons": reasons})
        return {"items": items, "total": total, "page": page, "page_size": size}

    def sources(self, query):
        with self.transaction() as session:
            return self._source_options(session, query)

    def context(self, query, actor):
        with self.transaction() as session:
            sources = self._source_options(session, query)
            resource = session.get(ResourceDatasetCurrent, resources.SCOPE)
            snapshot = resources._decode(session.get(ResourceDatasetVersion, resource.revision)) if resource else None
            task_id = query.task_id
            active = select(Run.run_id).where(Run.state.in_(ACTIVE))
            if task_id:
                active = active.where(Run.task_id == task_id)
            def count(model):
                statement = select(func.count()).select_from(model)
                if task_id:
                    statement = statement.where(model.task_id == task_id)
                return session.scalar(statement)
            eligible = any(item["eligible"] for item in sources["items"])
            permissions = actor["permissions"]
            def cap(allowed, reason):
                return {"enabled": allowed, "reasons": [] if allowed else [reason]}
            return {"task_id": task_id, "resource_revision": resource.revision if resource else None,
                "source_options": sources["items"], "scene_count": count(InterferenceScene), "run_count": count(Run),
                "active_run_ids": list(session.scalars(active)), "data_origin": snapshot["data_origin"] if snapshot else None,
                "interference_sources": deepcopy(snapshot["tables"]["interference_source.csv"]) if snapshot else [],
                "capabilities": {"scene_save": cap("planning.save" in permissions and eligible, "需要保存权限及可用的已保存方案"),
                    "analyze": cap("planning.execute" in permissions and eligible, "需要执行权限及可核验的冻结来源"),
                    "cancel": cap("planning.execute" in permissions, "需要执行权限"), "preview": cap(True, ""),
                    "adopt_replan": cap("planning.save" in permissions and "planning.execute" in permissions
                        and bool(self.replanner.supported_types), "共享冻结重算桥未接或没有采纳权限")}}

    def recover_expired(self):
        with self.transaction(writing=True) as session:
            rows = session.scalars(select(Run).where(Run.state.in_(("RUNNING", "CANCEL_REQUESTED")),
                Run.lease_until.is_not(None), Run.lease_until < now())).all()
            for row in rows:
                row.state, row.phase, row.error = "FAILED", "运行已中断", "旧worker租约过期；未自动重算，请明确重新提交"
                row.active_task_key, row.lease_owner, row.lease_until = None, None, None
                row.run_version += 1
                row.updated_at = now()

    def run_once(self, owner=None, stopping=None):
        owner = owner or "worker-" + uuid4().hex
        stopping = stopping or threading.Event()
        source = None
        with self.transaction(writing=True) as session:
            row = session.scalar(select(Run).where(Run.state.in_(("PENDING", "CANCEL_REQUESTED")),
                Run.lease_owner.is_(None)).order_by(Run.started_at).limit(1).with_for_update())
            if row is None:
                pass
            elif row.state == "CANCEL_REQUESTED":
                row.state, row.phase, row.active_task_key = "CANCELLED", "计算前已取消", None
                row.run_version += 1
                row.updated_at = now()
                return True
            else:
                self._run(session, row.run_id, row.task_id)
                row.state, row.phase, row.lease_owner = "RUNNING", "加载冻结来源", owner
                row.lease_until = now() + timedelta(minutes=30)
                row.run_version += 1
                row.updated_at = now()
                run_id, task_id, source = row.run_id, row.task_id, deepcopy(row.source_snapshot)
        if source is None:
            return self.replanner.run_once(owner, stopping)

        def cancelled():
            if stopping.is_set():
                return True
            with self.transaction() as session:
                current = self._run(session, run_id, task_id)
                return current.state != "RUNNING" or current.lease_owner != owner

        def progress(value, phase):
            with self.transaction(writing=True) as session:
                current = self._run(session, run_id, task_id)
                if current.state != "RUNNING" or current.lease_owner != owner:
                    raise AnalysisCancelled("分析已取消或租约变化")
                current.progress, current.phase = max(current.progress, min(99, int(value))), phase[:200]
                current.run_version += 1
                current.updated_at, current.lease_until = now(), now() + timedelta(minutes=30)

        result, error = None, None
        try:
            result = self.engine.analyze(source, progress, cancelled)
            result = {"analysis_id": run_id, **result}
            digest(result)
        except Exception as exc:
            error = str(exc) or type(exc).__name__
        with self.transaction(writing=True) as session:
            current = self._run(session, run_id, task_id)
            if current.state in FINAL or current.lease_owner != owner:
                return True
            if current.state == "CANCEL_REQUESTED":
                current.state, current.phase = "CANCELLED", "计算已取消"
            elif error is not None or stopping.is_set():
                current.state, current.phase, current.error = "FAILED", "计算未完成", (error or "worker停止，未接受结果")[:2000]
            else:
                current.state, current.phase, current.progress = "SUCCESS", "分析完成", 100
                current.result_snapshot, current.result_hash = result, digest(result)
            current.active_task_key, current.lease_owner, current.lease_until = None, None, None
            current.run_version += 1
            current.updated_at = now()
        return True


class InterferenceWorker:
    def __init__(self, service, poll_interval=0.2, recover=True):
        self.service, self.poll_interval, self.recover = service, poll_interval, recover
        self.owner = "IW-" + uuid4().hex
        self.stopping = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self._loop, name="p03-interference-worker", daemon=True)

    def _loop(self):
        try:
            if self.recover:
                self.service.recover_expired()
            while not self.stopping.is_set():
                worked = self.service.run_once(self.owner, self.stopping)
                self.service.wakeup.wait(self.poll_interval)
                self.service.wakeup.clear()
        except Exception as exc:
            # 保留明确健康状态，不能把停止的调度器冒充正常服务。
            self.error = str(exc) or type(exc).__name__


def start_interference_worker(service, poll_interval=0.2, recover=True):
    if poll_interval <= 0:
        raise ValueError("poll_interval必须大于0")
    worker = InterferenceWorker(service, poll_interval, recover)
    worker.thread.start()
    return worker


def stop_interference_worker(worker, timeout=5.0):
    worker.stopping.set()
    worker.service.wakeup.set()
    worker.thread.join(timeout=max(0, timeout))
    return not worker.thread.is_alive()
