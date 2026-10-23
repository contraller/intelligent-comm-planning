"""采纳事实与真实规划桥分离；桥未接时明确不可用，不伪造规划结果。"""
from copy import deepcopy
from datetime import timedelta
from math import isfinite
from uuid import uuid4

from sqlalchemy import or_, select

from .interference_analysis_engine import MEASURE_TYPES, digest
from .interference_workbench_models import InterferenceWorkbenchAdoption as Adoption
from .planning_job_models import PlanningJob
from .planning_plan_models import PlanningPlan


class FrozenPlanningReplanner:
    """工作线程专用真实SR4桥；不挂接HTTP，不自动确认或改变父方案。"""
    supported_types = frozenset(MEASURE_TYPES)
    supports_frozen_sources = True

    def __init__(self, session_factory=None, *, runtime_root=None):
        from inspect import signature
        from .database import get_session_factory
        from .planning_job_service import PlanningJobError, validate_interference_runtime
        from .planning_result_adapter import adapt_planning_result
        if "resource_rows" not in signature(adapt_planning_result).parameters:
            raise PlanningJobError(5001, "冻结结果适配入口尚未集成，不启用重算能力", 503)
        self.factory = session_factory or get_session_factory()
        self.runtime_root = validate_interference_runtime(self.factory, runtime_root)

    def _job(self, request):
        from .planning_job_service import PlanningJobError
        with self.factory() as session:
            job = session.get(PlanningJob, request["planning_job_id"])
            if (job is None or job.request_id != request["planning_request_id"]
                    or job.task_id != request["task_id"]
                    or (job.adjustment or {}).get("interference_origin") != request["interference_origin"]):
                raise PlanningJobError(1203, "真实子作业与采纳绑定不一致", 409)
            return job

    def submit(self, request):
        from .planning_job_service import submit_interference_replan
        return submit_interference_replan(request, self.factory, runtime_root=self.runtime_root)

    def poll(self, request):
        from . import planning_adjustment_service, planning_job_service, planning_plan_service
        from .planning_plan_schemas import PlanningPlanSaveRequest
        job = self._job(request)
        with self.factory() as session:
            saved = session.scalar(select(PlanningPlan).where(PlanningPlan.job_id == job.job_id))
            if saved is not None:
                return {"state": "SUCCESS", "progress": 100, "plan_id": saved.plan_id, "error": None}
        response = planning_job_service.query_planning_job(job.job_id, job.task_id, self.factory)
        data = response["data"]
        if data["status"] != "SUCCESS":
            return {"state": data["status"], "progress": data["progress"] * 100,
                    "plan_id": None, "error": data["error"]}
        expected = request["source"]["scene"]["plan_snapshot"]["raw_snapshot"]["terrain_fingerprint"]
        if planning_adjustment_service.terrain_fingerprint() != expected:
            from .interference_workbench_service import WorkbenchError
            raise WorkbenchError("保存前DEM指纹已变化，结果未接受", 5002, 503)
        result = planning_plan_service.save_planning_plan(PlanningPlanSaveRequest(
            context="planning", request_id="interference-save-" + request["adoption_id"],
            task_id=job.task_id, expected_revision=job.revision_id, job_id=job.job_id,
            name="干扰措施重算 " + request["measure"]["type"],
            note="冻结场景算法预测；非实测。来源采纳：" + request["adoption_id"]), self.factory)
        return {"state": "SUCCESS", "progress": 100, "plan_id": result["plan_id"], "error": None}

    def cancel(self, request):
        from .planning_job_schemas import PlanningJobCancelRequest
        from .planning_job_service import request_interference_cancellation
        job = self._job(request)
        request_interference_cancellation(job.job_id, PlanningJobCancelRequest(context="planning",
            request_id="interference-cancel-" + request["adoption_id"], task_id=job.task_id,
            expected_revision=job.revision_id), self.factory, actor_id=request["actor_id"],
            runtime_root=self.runtime_root)

    def shutdown(self, timeout=5.0) -> bool:
        from .planning_job_service import stop_frozen_planning_jobs
        return stop_frozen_planning_jobs(self.factory, runtime_root=self.runtime_root, timeout=timeout)


class InterferenceReplanService:
    def __init__(self, workbench, bridge=None):
        self.workbench, self.bridge = workbench, bridge

    @property
    def supported_types(self):
        if self.bridge is None or not getattr(self.bridge, "supports_frozen_sources", False):
            return frozenset()
        if not all(callable(getattr(self.bridge, name, None)) for name in ("submit", "poll", "cancel")):
            return frozenset()
        return frozenset(getattr(self.bridge, "supported_types", ())) & frozenset(MEASURE_TYPES)

    def capabilities(self):
        return {kind: {"enabled": kind in self.supported_types,
            "reasons": [] if kind in self.supported_types else ["共享规划桥尚未支持此类型及冻结干扰源"]}
            for kind in MEASURE_TYPES}

    def _row(self, session, adoption_id, task_id):
        from .interference_workbench_service import fail
        row = session.get(Adoption, adoption_id)
        if row is None or row.task_id != task_id:
            fail("采纳记录不存在或不可见", 2001, 404)
        run = self.workbench._run(session, row.run_id, row.task_id)
        measure = next((m for m in (run.result_snapshot or {}).get("measures", [])
                        if m["measure_id"] == row.measure_id), None)
        if (digest(row.change_set) != row.change_hash or row.source_hash != run.source_hash
                or measure is None or measure["change_set"] != row.change_set):
            fail("采纳来源或措施校验失败", 5002, 503)
        return row, run, measure

    @staticmethod
    def origin(row):
        return {"adoption_id": row.adoption_id, "run_id": row.run_id, "measure_id": row.measure_id,
                "source_hash": row.source_hash, "change_hash": row.change_hash, "actor_id": row.actor_id}

    def _job(self, session, row, run, job_id):
        from .interference_workbench_service import fail
        scene = run.source_snapshot["scene"]
        job = session.get(PlanningJob, job_id)
        if (job is None or job.request_id != row.planning_request_id or job.task_id != row.task_id
                or job.parent_plan_id != run.plan_id or job.resource_revision != run.resource_revision
                or job.revision_id != scene["plan_snapshot"]["input_version"]
                or job.condition_version != scene["plan_snapshot"]["condition_version"]
                or (job.adjustment or {}).get("interference_origin") != self.origin(row)):
            fail("共享规划作业没有回显精确冻结来源", 5002, 503)
        if (not isinstance(job.progress, (int, float)) or isinstance(job.progress, bool)
                or not isfinite(job.progress) or not 0 <= job.progress <= 1):
            fail("共享规划进度不符合数据库0..1契约", 5002, 503)
        return job

    def _plan(self, session, row, run, plan_id, *, accepting=False):
        from .interference_workbench_service import fail
        plan = session.get(PlanningPlan, plan_id)
        frozen = run.source_snapshot["scene"]["plan_snapshot"]
        if (plan is None or plan.job_id != row.planning_job_id or plan.task_id != row.task_id
                or plan.parent_plan_id != run.plan_id or plan.plan_id == run.plan_id
                or plan.state not in (("SAVED", "REFERENCE") if accepting else ("SAVED", "REFERENCE", "CONFIRMED"))
                or plan.source != "SR4" or plan.resource_revision != run.resource_revision
                or plan.revision_id != frozen["input_version"] or plan.condition_version != frozen["condition_version"]
                or plan.input_snapshot != frozen["input_snapshot"]
                or (plan.adjustment or {}).get("interference_origin") != self.origin(row)
                or not plan.raw_snapshot or plan.raw_snapshot.get("terrain_fingerprint") != frozen["raw_snapshot"]["terrain_fingerprint"]):
            fail("共享重算没有真实保存正确的新方案", 5002, 503)
        if not self.applied(row.change_set, plan.raw_snapshot["detail"]):
            fail("真实重算结果未应用所采纳的措施", 5002, 503)
        return plan

    @staticmethod
    def applied(change, detail):
        """五类变化逐项回验，不能只信任共享桥返回 SUCCESS。"""
        try:
            kind, target, values = change["type"], change["target"], change["detail"]
            def equal(a, b):
                return a is not None and b is not None and abs(float(a) - float(b)) < 1e-6
            if kind in ("FREQ_ADJUST", "CHANNEL_SWITCH"):
                ids = values.get("links_in_net") or [target["link_id"]]
                frequencies = {r["link_id"]: r["freq_khz"] for r in detail["frequency"]["link_assignments"]}
                return bool(ids) and all(equal(frequencies.get(lid), values["to_freq_khz"]) for lid in ids)
            if kind == "POWER_OPT":
                params = {r["device_id"]: r["tx_power_dbm"] for r in detail["params"]["params"]}
                return bool(change["device_changes"]) and all(equal(params.get(r["device_id"]), r["tx_power_dbm"])
                    for r in change["device_changes"])
            if kind == "NODE_REDEPLOY":
                node = next(r for r in detail["nodes"] if r["node_id"] == target["node_id"])
                return equal(node["lon"], values["to_lon"]) and equal(node["lat"], values["to_lat"])
            if kind == "ROUTE_REBUILD":
                routes = {r["demand_id"]: r for r in detail["routes"]["routes"]}
                def path_equal(actual, expected):
                    if expected is None:
                        return actual is None
                    return isinstance(actual, dict) and all(actual.get(key) == expected.get(key)
                        for key in ("node_path", "link_path"))
                return bool(values["rerouted"]) and all(
                    path_equal(routes.get(r["demand_id"], {}).get("primary"), r["primary"])
                    and path_equal(routes[r["demand_id"]].get("backup"), r.get("backup"))
                    for r in values["rerouted"])
        except (KeyError, TypeError, ValueError, StopIteration):
            return False
        return False

    def dto(self, session, row):
        from .interference_workbench_service import iso
        row, run, _ = self._row(session, row.adoption_id, row.task_id)
        job = self._job(session, row, run, row.planning_job_id) if row.planning_job_id else None
        plan = self._plan(session, row, run, row.result_plan_id) if row.result_plan_id else None
        return {"adoption_id": row.adoption_id, "task_id": row.task_id, "run_id": row.run_id,
            "measure_id": row.measure_id, "adoption_version": row.adoption_version, "state": row.state,
            "source_hash": row.source_hash, "source_state": self.workbench.source_state(session, run.source_snapshot),
            "planning_request_id": row.planning_request_id, "planning_job_id": row.planning_job_id,
            "planning_state": job.status if job else None, "planning_progress": job.progress * 100 if job else None,
            "result_plan_id": row.result_plan_id, "result_plan_state": plan.state if plan else None,
            "error": row.error, "data_origin": run.source_snapshot["scene"]["data_origin"],
            "created_at": iso(row.created_at), "updated_at": iso(row.updated_at)}

    def detail(self, adoption_id, query):
        with self.workbench.transaction() as session:
            return self.dto(session, self._row(session, adoption_id, query.task_id)[0])

    def submit(self, payload, actor):
        from .interference_workbench_service import fail, now
        wb = self.workbench
        request_digest = digest({"operation": "ADOPT_MEASURE", "actor": actor["account_id"], "body": payload.model_dump()})
        with wb.transaction(writing=True) as session:
            replay = wb._replay(session, payload.request_id, "ADOPT_MEASURE", actor["account_id"], request_digest)
            if replay is not None:
                return replay
            run = wb._run(session, payload.run_id, payload.task_id)
            if run.state != "SUCCESS" or run.run_version != payload.expected_run_version:
                fail("只能采纳指定成功运行版本的措施", 1203, 409)
            source = wb._freeze(session, payload, actor)
            if source["scene"] != run.source_snapshot["scene"]:
                fail("采纳来源与分析不一致", 1203, 409)
            measure = next((m for m in run.result_snapshot["measures"] if m["measure_id"] == payload.measure_id), None)
            if measure is None:
                fail("措施不存在", 2001, 404)
            if not measure["available"] or measure["type"] not in self.supported_types:
                fail("此措施的冻结重算桥未接或措施不可用", 2002, 409)
            row = session.scalar(select(Adoption).where(Adoption.run_id == run.run_id, Adoption.measure_id == payload.measure_id))
            changed = row is None
            if row is None:
                stamp = now()
                aid = "IAD-" + uuid4().hex
                row = Adoption(adoption_id=aid, task_id=run.task_id, run_id=run.run_id,
                    measure_id=payload.measure_id, adoption_version=1, state="PENDING", source_hash=run.source_hash,
                    change_set=deepcopy(measure["change_set"]), change_hash=digest(measure["change_set"]),
                    planning_request_id="interference-" + aid, actor_id=actor["account_id"], created_at=stamp, updated_at=stamp)
                session.add(row)
                session.flush()
            receipt = wb._receipt(session, payload, "ADOPT_MEASURE", actor, row, request_digest, changed,
                {"adoption_id": row.adoption_id, "planning_request_id": row.planning_request_id,
                 "planning_job_id": row.planning_job_id, "plan_id": row.result_plan_id})
        wb.wakeup.set()
        return receipt

    def cancel(self, adoption_id, payload, actor):
        from .interference_workbench_service import FINAL, fail, now
        wb = self.workbench
        request_digest = digest({"operation": "CANCEL_ADOPTION", "adoption_id": adoption_id,
                                "actor": actor["account_id"], "body": payload.model_dump()})
        with wb.transaction(writing=True) as session:
            replay = wb._replay(session, payload.request_id, "CANCEL_ADOPTION", actor["account_id"], request_digest)
            if replay is not None:
                return replay
            row, _, _ = self._row(session, adoption_id, payload.task_id)
            if row.state not in FINAL and row.adoption_version != payload.expected_adoption_version:
                fail("采纳版本已变化", 1203, 409)
            changed = row.state not in (*FINAL, "CANCEL_REQUESTED")
            if changed:
                row.state, row.updated_at = "CANCEL_REQUESTED", now()
                row.adoption_version += 1
            receipt = wb._receipt(session, payload, "CANCEL_ADOPTION", actor, row, request_digest, changed,
                                  {"object_state": row.state})
        wb.wakeup.set()
        return receipt

    def run_once(self, owner, stopping):
        from .interference_workbench_service import ACTIVE, FINAL, WorkbenchError, now
        wb = self.workbench
        with wb.transaction(writing=True) as session:
            row = session.scalar(select(Adoption).where(Adoption.state.in_(ACTIVE),
                or_(Adoption.lease_owner.is_(None), Adoption.lease_until < now()))
                .order_by(Adoption.updated_at).limit(1).with_for_update())
            if row is None or stopping.is_set():
                return False
            row, run, measure = self._row(session, row.adoption_id, row.task_id)
            # 未知派发结果仍按稳定子请求回查，取消不能跳过可能存在的子作业。
            existing = session.scalar(select(PlanningJob).where(PlanningJob.request_id == row.planning_request_id))
            if row.state == "CANCEL_REQUESTED" and row.lease_owner is None and existing is None and row.error is None:
                row.state, row.updated_at = "CANCELLED", now()
                row.adoption_version += 1
                return True
            row.lease_owner, row.lease_until = owner, now() + timedelta(minutes=5)
            row.adoption_version += 1
            row.updated_at = now()
            if row.state != "CANCEL_REQUESTED":
                row.state = "RUNNING"
            aid, task_id = row.adoption_id, row.task_id
            request = {"adoption_id": aid, "planning_request_id": row.planning_request_id,
                "planning_job_id": row.planning_job_id or (existing.job_id if existing else None),
                "actor_id": row.actor_id, "task_id": row.task_id, "source": deepcopy(run.source_snapshot),
                "measure": deepcopy(measure), "change_set": deepcopy(row.change_set),
                "interference_origin": self.origin(row), "runtime_root": str(wb.runtime_root)}
        try:
            if measure["type"] not in self.supported_types:
                raise RuntimeError("冻结重算桥暂不可用，保留稳定请求等待恢复")
            job_id = request["planning_job_id"] or self.bridge.submit(deepcopy(request))
            with wb.transaction(writing=True) as session:
                row, run, _ = self._row(session, aid, task_id)
                if row.state in FINAL or row.lease_owner != owner:
                    return True
                job = self._job(session, row, run, job_id)
                row.planning_job_id = job.job_id
                cancellation = row.state == "CANCEL_REQUESTED"
            request["planning_job_id"] = job_id
            if cancellation:
                self.bridge.cancel(deepcopy(request))
            outcome = self.bridge.poll(deepcopy(request))
            with wb.transaction(writing=True) as session:
                row, run, _ = self._row(session, aid, task_id)
                if row.state in FINAL or row.lease_owner != owner:
                    return True
                job = self._job(session, row, run, job_id)
                if outcome["state"] != job.status:
                    raise WorkbenchError("桥回报与持久化作业状态不一致", 5002, 503)
                if job.status == "SUCCESS":
                    # 取消晚于成功时保留真实完成结果，不谎报已停止。
                    plan = self._plan(session, row, run, outcome.get("plan_id"), accepting=True)
                    row.result_plan_id, row.state, row.error = plan.plan_id, "SUCCESS", None
                elif job.status in ("FAILED", "CANCELLED"):
                    row.state, row.error = job.status, job.error
                else:
                    row.error = None
                row.lease_owner, row.lease_until, row.updated_at = None, None, now()
                row.adoption_version += 1
        except Exception as exc:
            with wb.transaction(writing=True) as session:
                row, _, _ = self._row(session, aid, task_id)
                if row.state not in FINAL and row.lease_owner == owner:
                    # 传输失败不能证明子作业未受理；保留稳定键，下一轮先回查。
                    row.error = (str(exc) or type(exc).__name__)[:2000]
                    row.lease_until = now() + timedelta(seconds=2)
                    if (isinstance(exc, WorkbenchError) and exc.code == 5002
                            or getattr(exc, "code", None) in (1001, 1002, 1003, 1203, 1205)):
                        row.state, row.lease_owner, row.lease_until = "FAILED", None, None
                    row.adoption_version += 1
                    row.updated_at = now()
        return True
