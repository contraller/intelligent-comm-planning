"""独立枚举单链路失效，核对最终物理余量口径的全网指标。"""
import random
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "planning"))

import sr4_flow


def _connected(edges, source, target):
    adjacency = {}
    for a, b in edges:
        adjacency.setdefault(a, set()).add(b)
        adjacency.setdefault(b, set()).add(a)
    seen, pending = {source}, [source]
    while pending:
        node = pending.pop()
        for other in adjacency.get(node, ()):
            if other not in seen:
                seen.add(other)
                pending.append(other)
    return target in seen


def _brute_metrics(links, demands):
    # 不调用生产桥算法，分别删除每条达到实际余量的物理链路。
    usable = [(row["node_a_id"], row["node_b_id"]) for row in links
              if row.get("is_available", "true") != "false"
              and row["link_margin_db"] >= 6.0]
    mandatory = [row for row in demands if row["is_mandatory"] == "true"]

    def ratio(rows, edges):
        return sum(_connected(edges, row["src_node_id"], row["dst_node_id"])
                   for row in rows) / max(1, len(rows))

    survivability = (min([ratio(mandatory, usable)] + [
        ratio(mandatory, usable[:i] + usable[i + 1:]) for i in range(len(usable))
    ]) if mandatory else 1.0)
    return ratio(demands, usable), ratio(mandatory, usable), survivability


def _check(links, demands):
    expected = _brute_metrics(links, demands)
    objectives, checks, usable = sr4_flow._fixed_topology_metrics(
        links, demands, {"routes": []},
        {"fade_margin_db": 6.0, "summary": {"total_radiated_w": 123.0}},
        {"mandatory_e2e_connectivity": 1.0, "survivability_threshold": 0.9,
         "max_relay_hops": 2})
    assert objectives["e2e_connectivity"] == round(expected[0], 4)
    assert checks["mandatory_e2e_connectivity"]["value"] == round(expected[1], 4)
    assert objectives["survivability"] == round(expected[2], 4)
    assert checks["survivability"]["required"] == 0.9
    assert checks["survivability"]["pass"] == (expected[2] >= 0.9 - 1e-9)
    assert objectives["total_radiated_power_w"] == 123.0
    assert usable == sum(row.get("is_available", "true") != "false"
                         and row["link_margin_db"] >= 6 for row in links)


@pytest.mark.parametrize("seed", range(20))
def test_final_metrics_match_independent_edge_removal(seed):
    rng = random.Random(seed)
    nodes = [f"N{i}" for i in range(7)]
    links = []
    for _ in range(18):
        a, b = rng.sample(nodes, 2)
        links.append({"node_a_id": a, "node_b_id": b,
                      "is_available": rng.choice(["true", "true", "false"]),
                      "link_margin_db": rng.choice([-2.0, 5.99, 6.0, 20.0])})
    demands = [{"src_node_id": a, "dst_node_id": b,
                "is_mandatory": "true" if i % 3 else "false"}
               for i, (a, b) in enumerate(zip(nodes, reversed(nodes)))]
    _check(links, demands)


@pytest.mark.parametrize("edges", [[], [("A", "B")],
                                  [("A", "B"), ("A", "B")],
                                  [("A", "B"), ("B", "C"), ("C", "A")]])
def test_disconnected_and_parallel_edges_do_not_inflate_survivability(edges):
    links = [{"node_a_id": a, "node_b_id": b, "link_margin_db": 6.0}
             for a, b in edges]
    demands = [{"src_node_id": "A", "dst_node_id": "B", "is_mandatory": "true"},
               {"src_node_id": "A", "dst_node_id": "D", "is_mandatory": "true"}]
    _check(links, demands)
