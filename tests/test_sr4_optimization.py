"""SR4 全网候选拓扑与真实校验选优回归。"""
import copy
import random
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "planning"))

import echelon as E
import multi_objective as MO
import plan_pipeline
import sr4_flow
from deployment import Solution


def test_alternative_parent_merges_nets_without_moving_stations():
    stations = [SimpleNamespace(sid="P-0", subtype="II_MOBILE"),
                SimpleNamespace(sid="P-1", subtype="II_MOBILE"),
                SimpleNamespace(sid="C-2", subtype="III_MOBILE"),
                SimpleNamespace(sid="C-3", subtype="III_MOBILE")]

    class Matrix:
        def __init__(self):
            self.stations = stations

        def neighbors(self, child, band):
            return [0, 1] if child in (2, 3) and band == E.VUHF else []

        def margin_of(self, child, parent, band):
            return 8.0 if band == E.VUHF and parent in (0, 1) else None

    sol = Solution()
    sol.connected = set(range(4))
    sol.parent_of = {2: (0, E.VUHF), 3: (1, E.VUHF)}
    sol.ports = {(i, E.VUHF): 1 for i in range(4)}
    variants = plan_pipeline.alternative_parent_solutions(
        Matrix(), sol, max_variants=2, important_nodes={"C-2"})

    assert len(variants) == 2
    assert variants[0].parent_of[2] == (1, E.VUHF)
    assert variants[0].parent_of[3] == (1, E.VUHF)
    assert variants[0].ports[(0, E.VUHF)] == 0
    assert variants[0].ports[(1, E.VUHF)] == E.capacity("II_MOBILE", E.VUHF)
    assert sol.parent_of[2] == (0, E.VUHF)
    assert sol.ports[(0, E.VUHF)] == 1


def test_cumulative_parent_changes_reduce_several_active_nets():
    stations = [SimpleNamespace(sid=f"P-{i}", subtype="II_NODE") for i in range(4)]
    stations += [SimpleNamespace(sid=f"C-{i}", subtype="III_MOBILE") for i in range(4)]

    class Matrix:
        def __init__(self):
            self.stations = stations

        def neighbors(self, child, band):
            return [child - 4, 0] if child > 4 and band == E.VUHF else []

        def margin_of(self, child, parent, band):
            return 10.0 if band == E.VUHF else None

    sol = Solution()
    sol.connected = set(range(8))
    sol.parent_of = {child: (child - 4, E.VUHF) for child in range(4, 8)}
    sol.ports = {(i, E.VUHF): 1 for i in range(8)}
    variants = plan_pipeline.alternative_parent_solutions(Matrix(), sol, max_variants=3)

    assert len(variants) == 3
    merged = variants[-1]
    assert [merged.parent_of[i][0] for i in range(4, 8)] == [0, 0, 0, 0]
    assert merged.ports[(0, E.VUHF)] == 4
    assert all(merged.ports[(i, E.VUHF)] == 0 for i in (1, 2, 3))
    assert [sol.parent_of[i][0] for i in range(4, 8)] == [0, 1, 2, 3]


def test_optimizer_keeps_distinct_topologies_with_equal_objectives(monkeypatch):
    pb = SimpleNamespace(rng=random.Random(7), n_bits=2, backups=[],
                         lock_backup=set(), lock_relay=set())

    def evaluate(_pb, genome):
        count = sum(genome[0])
        return dict(genome=genome, links=[(0, i + 1, E.HF) for i in range(count)],
                    m_req=6.0, connectivity=1.0, mandatory_connectivity=1.0,
                    survivability=1.0, total_power_w=10.0, relay_hops=0)

    monkeypatch.setattr(MO, "evaluate", evaluate)
    result = MO.optimize(pb, pop_size=8, generations=1)
    signatures = {tuple(sorted(row["links"])) for row in result["candidates"]}
    assert len(signatures) >= 2


def test_new_relay_can_attach_unconnected_mandatory_station():
    def station(sid, subtype, bands, candidate=False):
        return SimpleNamespace(sid=sid, subtype=subtype, is_candidate=candidate,
                               radio={band: {"tx_dbm": 47.0} for band in bands},
                               lon=114.0, lat=37.0)

    stations = [station("ROOT", "I_FIXED", (E.HF,)),
                station("HEAD", "II_MOBILE", (E.HF, E.VUHF)),
                station("ORPHAN", "IV_MOBILE", (E.VUHF,)),
                station("CANDIDATE", "III_MOBILE", (E.HF, E.VUHF), True)]
    neighbors = {(1, E.HF): [0], (3, E.VUHF): [1, 2]}

    class Matrix:
        def __init__(self):
            self.stations = stations

        def neighbors(self, index, band):
            return neighbors.get((index, band), [])

        def margin_of(self, a, b, band):
            return 12.0 if (a, b, band) in ((1, 0, E.HF), (3, 1, E.VUHF),
                                             (3, 2, E.VUHF)) else None

    sol = Solution()
    sol.connected = {0, 1}
    sol.unconnected = [2]
    sol.active = {0, 1, 2}
    sol.parent_of = {1: (0, E.HF)}
    sol.ports = {(0, E.HF): 1, (1, E.HF): 1, (2, E.VUHF): 1}
    demand = dict(src_node_id="ROOT", dst_node_id="ORPHAN",
                  is_mandatory="true", demand_id="D-1")
    pb = MO.Problem(Matrix(), sol, [demand], {})

    assert pb.mandatory_orphans == {2}
    assert pb.ports_base[(2, E.VUHF)] == 0
    assert len(pb.relay_cands) == 1
    evaluated = MO.evaluate(pb, ([1], 0))
    assert evaluated["mandatory_connectivity"] == 1.0
    assert (3, 2, E.VUHF) in evaluated["links"]


def test_actual_hard_checks_outrank_approximate_connectivity():
    constraints = dict(mandatory_e2e_connectivity=1.0,
                       survivability_threshold=0.9, max_relay_hops=2)
    passed = dict(mandatory_e2e_connectivity=dict(value=1.0, pass_=True),
                  survivability=dict(value=0.91, pass_=True),
                  max_relay_hops=dict(value=1, pass_=True))
    passed = {key: {"value": row["value"], "pass": row["pass_"]}
              for key, row in passed.items()}
    failed = {key: dict(row) for key, row in passed.items()}
    failed["survivability"] = {"value": 0.85, "pass": False}
    clean = {"passed": True, "summary": {"severe": 0, "moderate": 0}}
    conflict = {"passed": False, "summary": {"severe": 1, "moderate": 0}}
    lower_power = {"e2e_connectivity": 1.0, "total_radiated_power_w": 1.0}
    viable = {"e2e_connectivity": 0.95, "total_radiated_power_w": 100.0}

    assert sr4_flow._candidate_score(viable, passed, clean, [], constraints) < \
        sr4_flow._candidate_score(lower_power, failed, clean, [], constraints)
    assert sr4_flow._candidate_score(viable, passed, clean, [], constraints) < \
        sr4_flow._candidate_score(lower_power, passed, conflict, [], constraints)


@pytest.mark.parametrize("edges,demands,expected", [
    ([(0, 1), (1, 2), (2, 0)], [(0, 1, True, "OK"), (0, 3, True, "LOST")], 0.5),
    ([], [(0, 1, True, "LOST")], 0.0),
    ([(0, 1), (1, 2), (2, 0)], [(0, 1, True, "OK")], 1.0),
])
def test_approximate_survivability_never_hides_preexisting_disconnection(
        monkeypatch, edges, demands, expected):
    links = [(a, b, E.HF) for a, b in edges]
    pb = SimpleNamespace(demands=demands, mandatory=demands, base_relays=set())
    monkeypatch.setattr(MO, "decode", lambda *_: (links, [], 6.0, {}))
    monkeypatch.setattr(MO, "_usable", lambda *_: [(*edge, 12.0) for edge in links])
    monkeypatch.setattr(MO, "_total_power_w", lambda *_: (10.0, 2))
    monkeypatch.setattr(MO, "_max_relay_chain", lambda *_: 0)
    result = MO.evaluate(pb, ([], 0))
    assert result["survivability"] == expected
    assert result["survivability"] <= result["mandatory_connectivity"]


def test_actual_parent_feedback_considers_legal_parent_outside_representative_neighbors():
    stations = [SimpleNamespace(sid="P0", subtype="II_MOBILE", radio={E.VUHF: {}}),
                SimpleNamespace(sid="P1", subtype="II_MOBILE", radio={E.VUHF: {}}),
                SimpleNamespace(sid="C2", subtype="III_MOBILE", radio={E.VUHF: {}})]
    matrix = SimpleNamespace(stations=stations, neighbors=lambda *_: [0], margin_of=lambda *_: -2.0)
    sol = Solution()
    sol.connected = {0, 1, 2}
    sol.parent_of = {2: (0, E.VUHF)}
    sol.ports = {(0, E.VUHF): 1, (1, E.VUHF): 0, (2, E.VUHF): 1}
    assert plan_pipeline.alternative_parent_solutions(matrix, sol) == []
    variants = plan_pipeline.alternative_parent_solutions(matrix, sol,
        failure_context={"failed_nodes": {"C2"}, "cuts": [{"side": {"C2"}, "lost": ["D1"]}]})
    assert variants[0].parent_of[2] == (1, E.VUHF)
    assert sol.parent_of[2] == (0, E.VUHF)


@pytest.mark.parametrize("ancestry", ["self", "descendant", "ancestor_loop"])
def test_actual_parent_feedback_rejects_self_and_cyclic_ancestry(monkeypatch, ancestry):
    import deployment
    stations = [SimpleNamespace(sid="P0", subtype="II_MOBILE", radio={E.VUHF: {}}),
                SimpleNamespace(sid="P1", subtype="II_MOBILE", radio={E.VUHF: {}}),
                SimpleNamespace(sid="C2", subtype="III_MOBILE", radio={E.VUHF: {}}),
                SimpleNamespace(sid="P3", subtype="II_MOBILE", radio={E.VUHF: {}})]
    matrix = SimpleNamespace(stations=stations, neighbors=lambda *_: [0], margin_of=lambda *_: None)
    sol = Solution()
    sol.parent_of = {2: (0, E.VUHF)}
    sol.connected = {0, 2}
    sol.ports = {(0, E.VUHF): 1, (2, E.VUHF): 1}
    if ancestry == "self":
        # UNIT permissive layer isolates the guard from the production type restriction.
        monkeypatch.setattr(deployment, "LAYER_PLAN", deployment.LAYER_PLAN + [
            (("III_MOBILE",), ("III_MOBILE",), E.VUHF, "UNIT self candidate")])
    elif ancestry == "descendant":
        sol.connected.add(1)
        sol.parent_of[1] = (2, E.VUHF)
    else:
        sol.connected.update((1, 3))
        sol.parent_of.update({1: (3, E.VUHF), 3: (1, E.VUHF)})
    frozen = copy.deepcopy(sol.__dict__)
    assert plan_pipeline.alternative_parent_solutions(matrix, sol,
        failure_context={"failed_nodes": {"C2"}, "cuts": []}) == []
    assert sol.__dict__ == frozen
