"""Ⅲ──Ⅲ 直连限同组（合作方 2026-09-29）与超短波借道的回归测试。

用最小的桩可行性矩阵，不依赖地形数据。pytest 可收集；没有 pytest 时也可直接运行：

    python3 tests/test_peer_group.py
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "scripts" / "planning")]

import echelon as E  # noqa: E402
import plan_check  # noqa: E402
from deployment import solve_assignment  # noqa: E402


class _Station:
    def __init__(self, sid, subtype):
        self.sid, self.subtype, self.is_candidate = sid, subtype, False


class _Matrix:
    """只实现 solve_assignment 用到的接口：邻接按频段给出，余量一律 20 dB。"""

    def __init__(self, subtypes, edges):
        self.stations = [_Station(sid, sub) for sid, sub in subtypes]
        self.index = {s.sid: i for i, s in enumerate(self.stations)}
        self.adj = {b: {} for b in E.BANDS}
        for a, b, band in edges:
            i, j = self.index[a], self.index[b]
            self.adj[band].setdefault(i, set()).add(j)
            self.adj[band].setdefault(j, set()).add(i)

    def neighbors(self, i, band, damaged=False):
        return iter(sorted(self.adj[band].get(i, ())))

    def margin_of(self, i, j, band):
        return 20.0 if j in self.adj[band].get(i, ()) else None


def _net(extra):
    """R(Ⅰ)─F(Ⅱ固定)─A(Ⅱ机动)─x(Ⅲ)，y 是够不到任何 Ⅱ 的 Ⅲ，v1–v3 是 Ⅳ。"""
    subtypes = [("R", "I_FIXED"), ("F", "II_FIXED"), ("A", "II_MOBILE"), ("x", "III_MOBILE"),
                ("y", "III_MOBILE"), ("v1", "IV_MOBILE"), ("v2", "IV_MOBILE"), ("v3", "IV_MOBILE")]
    edges = [("R", "F", E.HF), ("F", "A", E.HF), ("A", "x", E.VUHF),
             ("v1", "x", E.VUHF), ("v2", "x", E.VUHF)] + extra
    fm = _Matrix(subtypes, edges)
    sol = solve_assignment(fm)
    parent = {fm.stations[c].sid: (fm.stations[p].sid, b) for c, (p, b) in sol.parent_of.items()}
    unconnected = {fm.stations[i].sid for i in sol.unconnected}
    return parent, unconnected


def test_borrow_falls_back_to_vuhf_when_hf_unreachable():
    parent, unconnected = _net([("x", "y", E.VUHF)])
    assert parent["y"] == ("x", E.VUHF)
    assert unconnected == {"v3"}          # v3 本例没有任何链路


def test_vuhf_ports_go_to_iv_before_peer_borrowing():
    # x 的 4 个 cdb：自己上行 1 + 三个 Ⅳ，借道已无端口
    parent, unconnected = _net([("x", "y", E.VUHF), ("v3", "x", E.VUHF)])
    assert {"v1", "v2", "v3"} <= set(parent) and parent["v3"][0] == "x"
    assert unconnected == {"y"}


def test_borrow_prefers_hf():
    parent, _ = _net([("x", "y", E.VUHF), ("x", "y", E.HF)])
    assert parent["y"] == ("x", E.HF)


def _row(lid, a, b, band, backup):
    return dict(link_id=lid, node_a_id=a, node_b_id=b, device_class=band,
                is_available="true", is_backup="true" if backup else "false")


def test_plan_check_flags_cross_group_only():
    nodes = [dict(node_id=n, node_subtype=s) for n, s in
             (("A", "II_MOBILE"), ("B", "II_NODE"), ("x", "III_MOBILE"), ("w", "III_MOBILE"),
              ("z", "III_MOBILE"), ("c", "III_MOBILE"))]
    links = [_row("L1", "x", "A", E.VUHF, False), _row("L2", "w", "A", E.VUHF, False),
             _row("L3", "z", "B", E.VUHF, False),
             _row("L4", "c", "x", E.HF, False),       # 借道（主链路）
             _row("L5", "x", "w", E.VUHF, True),      # 同组备份
             _row("L6", "c", "w", E.VUHF, True),      # 借道者与借出方同组
             _row("L7", "w", "z", E.HF, True)]        # 跨组
    for uplinks in (None, {"x": "A", "w": "A", "z": "B", "c": "x"}):
        res = plan_check.check(links=links, nodes=nodes, uplinks=uplinks)
        bad = [i["link_ids"][0] for i in res["issues"] if i["kind"] == "PEER_CROSS_GROUP"]
        assert bad == ["L7"], (uplinks, bad)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("PASS", name)
