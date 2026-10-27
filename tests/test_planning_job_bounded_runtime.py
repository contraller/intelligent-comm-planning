"""小规模冻结输入、真实spawn生命周期及独立SQLite竞争；不跑大规模规划。"""
from __future__ import annotations

import copy
import ctypes
import multiprocessing
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "algorithm-service"))
from app import planning_w3 as runtime, planning_w4
from app import planning_job_service as service
from app.database import Base
from app.planning_job_models import PlanningJob
from app.planning_job_schemas import PlanningJobSubmitRequest
from app.task_input_models import PlanningTask, PlanningTaskRevision
import sr4_flow as flow


def cpu_without_checkpoints(payload, tick):
    Path(payload["pid_file"]).write_text(str(os.getpid()), encoding="utf-8")
    tick(.4, "测试CPU循环已开始")
    # 专门验证无进度回调的CPU循环也能被真正终止。
    while True:
        sum(range(1000))


def return_in_child(payload, tick):
    tick(.6, "测试子进程返回")
    return {"value": payload["value"]}


def reserve_in_child(database, request_id, gate, output):
    engine = create_engine(database)
    factory = sessionmaker(engine, expire_on_commit=False)
    service.frontend_integration.resource_revision = lambda: "R1"
    service._algorithm_payload = lambda *_: {}
    payload = PlanningJobSubmitRequest(context="planning", request_id=request_id,
        task_id="T1", expected_revision="V1", input_version="V1",
        condition_version="C1", resource_revision="R1", parent_plan_id=None)
    gate.wait(10)
    try:
        job, _, created, _ = service._reserve(factory, payload, service._digest(payload))
        output.put(("ok", job.job_id, created))
    except service.PlanningJobError as exc:
        output.put(("error", exc.code, exc.status))
    finally:
        engine.dispose()


def wait_until(predicate, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.02)
    pytest.fail("定向测试等待超时")


def assert_pid_stopped(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if handle:
            try:
                code = ctypes.c_ulong()
                assert kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
                assert code.value != 259  # STILL_ACTIVE
            finally:
                kernel.CloseHandle(ctypes.c_void_p(handle))
    else:
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)


@pytest.fixture
def isolated_dirs(monkeypatch, tmp_path):
    monkeypatch.setattr(runtime, "TASK_DIR", tmp_path / "tasks")
    monkeypatch.setattr(planning_w4, "PLAN_DIR", tmp_path / "plans")
    return tmp_path


def test_real_cpu_process_cancel_is_confirmed_only_after_exit(isolated_dirs):
    started, terminal = threading.Event(), threading.Event()
    records = []
    def update(state):
        records.append(state)
        if state.get("stage") == "测试CPU循环已开始":
            started.set()
        if state.get("status") in runtime._FINAL_STATES:
            terminal.set()
    pid_file = isolated_dirs / "cancel.pid"
    tid = runtime._spawn("SR4_FLOW", {"pid_file": str(pid_file)}, cpu_without_checkpoints,
        isolated_budget_s=15, on_update=update)["data"]["task_id"]
    try:
        assert started.wait(12)
        requested = runtime.cancel_task(tid)
        assert requested["status"] == "RUNNING" and requested["cancel_requested"]
        assert terminal.wait(5)
        state = runtime.get_task_record(tid)
        assert state["status"] == "CANCELLED" and state["execution_stopped"]
        assert_pid_stopped(int(pid_file.read_text()))
        assert not any(row["status"] == "SUCCESS" for row in records)
    finally:
        runtime.cancel_task(tid)
        assert terminal.wait(5)


def test_real_cpu_process_budget_failure_does_not_claim_infeasibility(isolated_dirs):
    pid_file = isolated_dirs / "budget.pid"
    tid = runtime._spawn("SR4_FLOW", {"pid_file": str(pid_file)}, cpu_without_checkpoints,
                         isolated_budget_s=4)["data"]["task_id"]
    wait_until(lambda: runtime.get_task_record(tid).get("status") == "FAILED", 10)
    state = runtime.get_task_record(tid)
    assert pid_file.exists(), "必须实际启动CPU任务后验证停止"
    assert_pid_stopped(int(pid_file.read_text()))
    assert state["outcome"]["kind"] == "BUDGET_EXHAUSTED"
    assert state["outcome"]["proven_infeasible"] is False
    assert "未证明无解" in state["error"] or "尚未证明无解" in state["error"]
    runtime._TASKS.pop(tid)
    assert runtime.get_task_record(tid)["outcome"] == state["outcome"]


def test_isolated_success_delivers_complete_result(isolated_dirs):
    tid = runtime._spawn("SR4_FLOW", {"value": 17}, return_in_child,
                         isolated_budget_s=12)["data"]["task_id"]
    wait_until(lambda: runtime.get_task_record(tid).get("status") in runtime._FINAL_STATES)
    assert runtime.get_task_record(tid)["status"] == "SUCCESS"
    assert runtime.get_task_record(tid)["result"] == {"value": 17}


def case():
    devices = [{"device_id": "DA", "node_id": "A", "model_id": "HF"},
               {"device_id": "DB", "node_id": "B", "model_id": "VUHF"}]
    models = [{"model_id": "HF", "device_class": "HF", "freq_min_khz": 4000, "freq_max_khz": 6000},
              {"model_id": "VUHF", "device_class": "VUHF", "freq_min_khz": 140000, "freq_max_khz": 160000}]
    demands = [{"demand_id": "D1", "src_node_id": "A", "dst_node_id": "B", "is_mandatory": "true"}]
    pool = [{"freq_id": "F1", "device_class": "HF", "center_freq_khz": 5000},
            {"freq_id": "F2", "device_class": "VUHF", "center_freq_khz": 150000}]
    return demands, devices, models, pool


@pytest.mark.parametrize("reason", ["empty", "disabled", "out_of_range", "filter", "wrong_device"])
def test_only_proven_necessary_endpoint_failure_is_rejected(reason):
    demands, devices, models, pool = case()
    if reason == "empty":
        pool = []
    elif reason == "disabled":
        pool = [dict(row, is_available="false") for row in pool]
    elif reason == "out_of_range":
        pool = [dict(row, center_freq_khz=1) for row in pool]
    elif reason == "filter":
        pool = flow.constrained_frequency_rows(pool, {"filters": [
            {"device_class": "HF", "range_khz": None, "exclude_freq_ids": ["F1"]}]})
    else:
        demands[0]["source_device_id"] = "DB"
    before = copy.deepcopy((demands, devices, models, pool))
    with pytest.raises(flow.ProvenInfeasible) as rejected:
        flow.preflight_frequency(demands, devices, models, pool, {})
    outcome = rejected.value.outcome
    assert outcome["kind"] == "PROVEN_INFEASIBLE" and outcome["proven_infeasible"]
    assert outcome["mandatory_connectivity_upper_bound"] == 0
    assert outcome["reasons"][0]["demand_id"] == "D1"
    assert (demands, devices, models, pool) == before


def test_preflight_does_not_require_same_band_or_reject_optional_demands():
    demands, devices, models, pool = case()
    # 两端不同频段仍可由双频中继连接，不能据此断言无解。
    flow.preflight_frequency(demands, devices, models, pool, {})
    flow.preflight_frequency([dict(demands[0], is_mandatory="false")], devices, models, [], {})
    more = demands + [dict(demands[0], demand_id="D2", src_node_id="B")]
    flow.preflight_frequency(more, devices, models, pool[1:], {"mandatory_e2e_connectivity": .5})
    # 与最终检查的1e-9比较容差一致，不能误报门槛附近的“已证明无解”。
    flow.preflight_frequency(more, devices, models, pool[1:], {"mandatory_e2e_connectivity": .5 + 5e-10})


def test_network_infeasibility_summary_is_bounded_but_details_are_complete():
    demands, devices, models, _ = case()
    many = [dict(demands[0], demand_id=f"D-{i}") for i in range(500)]
    with pytest.raises(flow.ProvenInfeasible) as rejected:
        flow.preflight_frequency(many, devices, models, [], {})
    outcome = rejected.value.outcome
    assert len(outcome["message"]) < 512
    assert "500条必要需求" in outcome["message"]
    assert len(outcome["gap"]) == len(outcome["reasons"]) == 1000
    assert outcome["mandatory_connectivity_upper_bound"] == 0


@pytest.mark.parametrize("exhausted", [False, True])
def test_unproven_candidate_failure_cannot_be_saved_as_success(monkeypatch, exhausted):
    monkeypatch.setattr(flow, "run", lambda **_: {"optimization": {"feasible": False,
        "actual_search": {"budget_exhausted": exhausted}, "infeasible": {
            "conflicting_constraints": ["survivability"], "suggestions": ["检查物理备份"]}}})
    monkeypatch.setattr(planning_w4, "_save_plan", lambda *_: pytest.fail("失败候选不能存为成功方案"))
    with pytest.raises(runtime.PlanningSearchFailed) as rejected:
        planning_w4._do_sr4({"task_id": "UNIT"}, lambda *_: None)
    outcome = rejected.value.outcome
    assert outcome["kind"] == ("BUDGET_EXHAUSTED" if exhausted else "SEARCH_NOT_FOUND")
    assert outcome["proven_infeasible"] is False
    assert "尚未证明无解" in outcome["message"]
    assert outcome["reasons"][0]["message"] == "候选方案未满足抗毁性"
    assert outcome["gap"] and outcome["suggestions"]


def test_real_sr4_empty_frozen_frequency_fails_before_terrain_search(isolated_dirs):
    demands, devices, models, _ = case()
    tables = {"node.csv": [{"node_id": "A"}, {"node_id": "B"}],
        "device.csv": devices, "device_model.csv": models, "antenna_model.csv": [],
        "comm_demand.csv": [dict(demands[0], task_id="UNIT-EMPTY")],
        "frequency_resource.csv": [], "interference_source.csv": [],
        "candidate_site.csv": [], "link_metric.csv": []}
    # 使用真实SR4入口与spawn；缺少传播计算字段，证明未进入地形/算法阶段。
    tid = planning_w4.submit_sr4({"task_id": "UNIT-EMPTY", "resource_rows": tables})["data"]["task_id"]
    wait_until(lambda: runtime.get_task_record(tid).get("status") in runtime._FINAL_STATES)
    result = runtime.query_task(tid)
    assert result["code"] == 3001 and result["data"]["status"] == "FAILED"
    assert result["data"]["outcome"]["proven_infeasible"] is True
    assert result["data"]["outcome"]["kind"] == "PROVEN_INFEASIBLE"
    assert not list((isolated_dirs / "plans").glob("*.json"))


@pytest.mark.parametrize("scope,count", [("NETWORK", 2), ("TASK", 1)])
def test_preflight_uses_the_same_mandatory_denominator_as_final_checks(monkeypatch, scope, count):
    demands, devices, models, pool = case()
    tables = {"node.csv": [], "device.csv": devices, "device_model.csv": models,
        "antenna_model.csv": [], "comm_demand.csv": [dict(demands[0], task_id="T1"),
            dict(demands[0], demand_id="OTHER", task_id="T2")],
        "frequency_resource.csv": pool, "interference_source.csv": []}
    def preflight(rows, *_, checkpoint=None):
        assert callable(checkpoint)
        assert checkpoint() is True
        assert len(rows) == count
        raise RuntimeError("已验证必要通联分母")
    monkeypatch.setattr(flow, "preflight_frequency", preflight)
    monkeypatch.setattr(flow, "default_terrain", lambda **_: pytest.fail("不运行传播或搜索"))
    with pytest.raises(RuntimeError, match="已验证必要通联分母"):
        flow.run("T1", resource_rows=tables, survivability_scope=scope, verbose=False)


@pytest.mark.parametrize("execution", [None, 456])
def test_dead_supervisor_requires_evidence_of_cpu_exit(isolated_dirs, monkeypatch, execution):
    tid = "tsk-123456abcdef"
    runtime._set(tid, task_id=tid, status="RUNNING", progress=.3,
                 owner_pid=123, execution_pid=execution)
    monkeypatch.setattr(runtime, "_process_alive", lambda _: False)
    state = runtime.get_task_record(tid)
    assert state["status"] == ("FAILED" if execution else "RUNNING")
    if execution:
        assert state["execution_stopped"] is True


@pytest.mark.parametrize("same_request", [False, True])
def test_separate_process_reservations_serialize_on_independent_sqlite(tmp_path, same_request):
    url = "sqlite:///" + (tmp_path / "reservations.sqlite").as_posix()
    engine = create_engine(url)
    Base.metadata.create_all(engine)
    now = datetime.now(timezone.utc)
    with sessionmaker(engine)() as session, session.begin():
        session.add(PlanningTask(task_id="T1", current_revision_id="V1", current_version_no=1,
                                 created_at=now, updated_at=now))
        session.add(PlanningTaskRevision(revision_id="V1", task_id="T1", version_no=1,
            condition_version="C1", resource_revision="R1", context="planning", input_snapshot={}, created_at=now))
    ctx = multiprocessing.get_context("spawn")
    gate, output = ctx.Event(), ctx.Queue()
    children = [ctx.Process(target=reserve_in_child,
        args=(url, "REQ1" if same_request else "REQ%d" % index, gate, output)) for index in range(2)]
    try:
        for child in children:
            child.start()
        gate.set()
        results = [output.get(timeout=15) for _ in children]
        for child in children:
            child.join(5)
            assert child.exitcode == 0
        if same_request:
            assert all(row[0] == "ok" for row in results)
            assert results[0][1] == results[1][1]
            assert sorted(row[2] for row in results) == [False, True]
        else:
            assert len([row for row in results if row[0] == "ok"]) == 1
            assert ("error", 2002, 409) in results
        with sessionmaker(engine)() as session:
            assert session.scalar(select(func.count()).select_from(PlanningJob)) == 1
    finally:
        for child in children:
            if child.is_alive():
                child.terminate()
            child.join()
        output.close()
        engine.dispose()
