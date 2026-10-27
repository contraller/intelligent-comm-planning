"""SR4预算与取消检查点；使用受控时钟和小场景，不等待真实300秒。"""
from __future__ import annotations

import random
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
for directory in (ROOT / "scripts", ROOT / "scripts/planning"):
    sys.path.insert(0, str(directory))

import branch_bound
import deployment
import echelon as E
import feasibility
import multi_objective as MO
import plan_pipeline
import interference
import radio_params
import sr4_flow


class Cancelled(Exception):
    pass


def test_budget_uses_one_monotonic_deadline_and_throttles_cancel_probes(monkeypatch):
    now = [10.0]
    calls = []
    monkeypatch.setattr(sr4_flow.time, "monotonic", lambda: now[0])
    checkpoint, report = sr4_flow._runtime_callbacks(now[0], lambda *state: calls.append(state))
    checkpoint()
    for value in (10.1, 10.2, 10.49):
        now[0] = value
        checkpoint()
    assert len(calls) == 1
    now[0] = 10.51
    checkpoint()
    assert len(calls) == 2
    report(0.30, "电台部署完成")
    assert calls[-1] == (0.30, "电台部署完成")
    now[0] = 310.0
    with pytest.raises(TimeoutError, match="不表示已证明无解"):
        checkpoint()


@pytest.mark.parametrize("parent", [False, True])
def test_cancellation_is_checked_before_loading_resources(parent, monkeypatch):
    def cancel(*_):
        raise Cancelled("cancel requested")

    monkeypatch.setattr(sr4_flow, "_resource_reader", lambda *_: pytest.fail("取消后不得加载资源"))
    with pytest.raises(Cancelled):
        if parent:
            sr4_flow.run_from_parent({}, {}, [], "task", [], progress=cancel)
        else:
            sr4_flow.run(progress=cancel)


def test_matrix_interrupts_pairwise_propagation_work(monkeypatch):
    checks, links = [], []

    def checkpoint():
        checks.append(True)
        if len(checks) == 6:
            raise Cancelled()

    monkeypatch.setattr(feasibility, "link_margin", lambda *_: (links.append(True) or (12.0, 1.0, None)))
    stations = [SimpleNamespace(sid=f"s{i}", lon=114.0, lat=37.0, subtype="I_FIXED",
                               is_candidate=False, has=lambda band: band == E.HF)
                for i in range(100)]
    with pytest.raises(Cancelled):
        feasibility.FeasibilityMatrix(stations, object(), checkpoint=checkpoint)
    assert 0 < len(links) < 5


def test_deployment_passes_shared_checkpoint_to_candidate_matrix(monkeypatch):
    checks = []

    def checkpoint():
        checks.append(True)

    def matrix(*_args, **kwargs):
        assert kwargs["checkpoint"] is checkpoint
        kwargs["checkpoint"]()
        raise Cancelled()

    monkeypatch.setattr(feasibility, "FeasibilityMatrix", matrix)
    with pytest.raises(Cancelled):
        plan_pipeline.topology_from_deployment([], object(), candidate_rows=[],
            deployment_options={"deploymentSolve": {"mode": "MIN_COUNT"}}, checkpoint=checkpoint)
    assert len(checks) >= 3


def test_assignment_honors_matrix_checkpoint_before_solving():
    def checkpoint():
        raise Cancelled()

    with pytest.raises(Cancelled):
        deployment.solve_assignment(SimpleNamespace(checkpoint=checkpoint))


def test_optimizer_can_interrupt_initial_population_not_only_generation_end(monkeypatch):
    evaluations, checks = [], []
    pb = SimpleNamespace(rng=random.Random(7), n_bits=2, backups=[],
                         lock_backup=set(), lock_relay=set())

    def evaluate(_problem, genome):
        evaluations.append(genome)
        return dict(genome=genome, links=[], m_req=6.0, connectivity=1.0,
                    mandatory_connectivity=1.0, survivability=1.0,
                    total_power_w=10.0, relay_hops=0)

    def checkpoint():
        checks.append(True)
        if len(checks) == 3:
            raise TimeoutError("budget exhausted")

    monkeypatch.setattr(MO, "evaluate", evaluate)
    with pytest.raises(TimeoutError):
        MO.optimize(pb, checkpoint=checkpoint)
    assert len(evaluations) == 1


def test_branch_search_checks_shared_budget_before_exploring():
    def checkpoint():
        raise TimeoutError("budget exhausted")

    with pytest.raises(TimeoutError):
        branch_bound.branch_and_bound(SimpleNamespace(checkpoint=checkpoint), [], [], [])


@pytest.mark.parametrize("bound", [False, True])
def test_radio_planning_propagates_cancellation(bound):
    def checkpoint():
        raise Cancelled()

    with pytest.raises(Cancelled):
        if bound:
            radio_params.plan_bound_devices([], [], [], [], [], object(), checkpoint=checkpoint)
        else:
            radio_params.plan([], [], {}, object(), checkpoint=checkpoint)


def test_interference_grid_stops_within_scan_without_partial_result():
    checks = []

    def checkpoint():
        checks.append(True)
        if len(checks) == 5:
            raise TimeoutError("budget exhausted")

    scenario = SimpleNamespace(checkpoint=checkpoint, jammers=[])
    with pytest.raises(TimeoutError):
        interference.affected_area(scenario)
    assert len(checks) == 5


def test_interference_propagation_cache_honors_shared_checkpoint():
    def checkpoint():
        raise Cancelled()

    cache = interference._PLCache(object(), checkpoint=checkpoint)
    with pytest.raises(Cancelled):
        cache.loss(object(), 114.0, 37.0, 2.0)
