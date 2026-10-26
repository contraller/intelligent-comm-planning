"""有界频率重着色契约测试，不作为完整 DEM 验收证据。"""
import asyncio
import copy
import random
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "scripts" / "planning"))

import frequency as FQ


def case(domains, colors, edges, frequencies=(5000, 6000, 7000)):
    rows = [{"freq_id": "F%d" % (i + 1), "device_class": "HF",
             "center_freq_khz": str(f), "is_available": "true",
             "bandwidth_khz": "3", "adjacent_guard_khz": "3",
             "reuse_min_distance_m": "60000"} for i, f in enumerate(frequencies)]
    pool = FQ.FreqPool(rows)
    channels = {c["freq_id"]: c for c in pool.channels}
    tasks = [FQ.FreqTask("NET-%d" % i, "HF", ["L%d" % i], [(114, 38)])
             for i in range(len(domains))]
    for task, domain in zip(tasks, domains):
        task.allowed = [channels[f] for f in domain]
    adj = [set() for _ in tasks]
    sep = {}
    for a, b in edges:
        adj[a].add(b)
        adj[b].add(a)
        sep[min(a, b), max(a, b)] = 0.0
    color = {i: channels[f] for i, f in enumerate(colors)}
    return tasks, adj, sep, color


def ids(color):
    return {i: c["freq_id"] for i, c in color.items()}


def cycle():
    return case([['F1', 'F2'], ['F2', 'F3'], ['F3', 'F1']],
                ['F1', 'F2', 'F3'], [(0, 1), (0, 2), (1, 2)])


def test_three_net_cycle_cannot_be_solved_by_two_net_swap():
    tasks, adj, sep, original = cycle()
    before = copy.deepcopy((original, [t.allowed for t in tasks]))
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
                                        {"NET-0": ['F2', 'F1']})
    assert ids(result) == {0: 'F2', 1: 'F3', 2: 'F1'}
    assert moves == 1
    assert not FQ.check_conflicts(tasks, adj, sep, result)
    assert (original, [t.allowed for t in tasks]) == before


@pytest.mark.parametrize('adjacent', [False, True])
def test_multiple_blockers_include_guard_conflicts(adjacent):
    tasks, adj, sep, original = case(
        [['F1', 'F3'], ['F1', 'F3'], ['F2', 'F3']],
        ['F3', 'F1', 'F2'], [(0, 1), (0, 2)],
        frequencies=(5000, 5002 if adjacent else 5000, 6000))
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
                                        {"NET-0": ['F1', 'F3']})
    assert ids(result) == {0: 'F1', 1: 'F3', 2: 'F3'}
    assert moves == 1
    assert not FQ.check_conflicts(tasks, adj, sep, result)


def test_preference_insertion_order_takes_priority_over_task_order_and_list_length():
    tasks, adj, sep, original = case([['F1', 'F2', 'F3']] * 3,
                                   ['F1', 'F2', 'F3'], [(0, 1), (0, 2), (1, 2)])
    result, _ = FQ._preference_repair(tasks, adj, sep, original, set(),
        {"NET-2": ['F1', 'F3'], "NET-0": ['F1', 'F2', 'F3']})
    assert result[2]['freq_id'] == 'F1'
    assert result[0]['freq_id'] == 'F2'
    assert not FQ.check_conflicts(tasks, adj, sep, result)


def test_later_preference_cannot_worsen_an_earlier_satisfied_preference():
    tasks, adj, sep, original = case([['F1', 'F2']] * 2, ['F1', 'F2'], [(0, 1)])
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {"NET-0": ['F1', 'F2'], "NET-1": ['F1', 'F2']})
    assert result == original
    assert moves == 0


def test_reuses_released_channel_without_displacing_an_unrelated_net():
    tasks, adj, sep, original = case(
        [['F3', 'F4'], ['F1', 'F2', 'F3', 'F4'], ['F1', 'F2']],
        ['F4', 'F3', 'F1'], [(0, 1), (0, 2), (1, 2)],
        frequencies=(5000, 6000, 7000, 8000))
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
                                        {"NET-0": ['F3', 'F4']})
    assert ids(result) == {0: 'F3', 1: 'F4', 2: 'F1'}
    assert moves == 1


@pytest.mark.parametrize('fixed', [{1}, {2}])
def test_manual_blocker_cannot_be_displaced_directly_or_recursively(fixed):
    tasks, adj, sep, original = cycle()
    result, moves = FQ._preference_repair(tasks, adj, sep, original, fixed,
                                        {"NET-0": ['F2', 'F1']})
    assert result == original
    assert moves == 0


@pytest.mark.parametrize('limits', [
    {'budget': 0}, {'budget': 4}, {'max_region': 2}, {'time_limit_s': 0},
])
def test_exhaustion_returns_original_without_partial_moves(limits):
    tasks, adj, sep, original = cycle()
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
                                        {"NET-0": ['F2', 'F1']}, **limits)
    assert result == original
    assert moves == 0


def test_deadline_is_checked_during_recursion(monkeypatch):
    tasks, adj, sep, original = cycle()
    ticks = iter(range(100))
    monkeypatch.setattr(FQ.time, 'monotonic', lambda: float(next(ticks)))
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {"NET-0": ['F2', 'F1']}, time_limit_s=3.5)
    assert result == original
    assert moves == 0


def test_deadline_preserves_completed_moves():
    tasks, adj, sep, original = case([['F1', 'F2']] * 2, ['F1', 'F1'], [])
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {"NET-0": ['F2', 'F1'], "NET-1": ['F2', 'F1']}, budget=3)
    assert ids(result) == {0: 'F2', 1: 'F1'}
    assert moves == 1


def test_unavoidable_conflict_is_retained_and_never_increases():
    tasks, adj, sep, original = case([['F1', 'F2']] * 3, ['F1', 'F1', 'F2'],
                                   [(0, 1), (0, 2), (1, 2)])
    conflicts = FQ.check_conflicts(tasks, adj, sep, original)
    result, _ = FQ._preference_repair(tasks, adj, sep, original, set(),
                                    {"NET-0": ['F2', 'F1']})
    assert 0 < len(FQ.check_conflicts(tasks, adj, sep, result)) <= len(conflicts)
    assert set(result) == set(original)


def test_assign_defaults_and_manual_values_remain_authoritative(monkeypatch):
    pool = FQ.FreqPool([
        {"freq_id": fid, "device_class": "HF", "center_freq_khz": freq,
         "is_available": active} for fid, freq, active in [
            ('F1', '5000', 'true'), ('F2', '6000', 'true'),
            ('DISABLED', '5500', 'false'), ('OUTSIDE', '8000', 'true')]])

    def tasks():
        return [FQ.FreqTask('NET-0', 'HF', ['L0'], [(114, 38)], 4000, 6500)]

    original = copy.deepcopy(pool.channels)
    default = FQ.assign(tasks(), pool)
    assert default == FQ.assign(tasks(), pool, channel_preference=None)
    assert default == FQ.assign(tasks(), pool, channel_preference={})
    actual = FQ.assign(tasks(), pool, [{'link_id': 'NET-0', 'freq_khz': 5000}],
        channel_preference={'NET-0': ['INVENTED', 'DISABLED', 'OUTSIDE', 'F2', 'F1']})
    assert actual['assignments'][0]['freq_id'] == 'F1'
    assert actual['assignments'][0]['manual']
    assert actual['manual_errors'] == []
    assert actual['conflict_free']
    assert pool.channels == original

    def unexpected(*args, **kwargs):
        pytest.fail('Default allocation must not invoke preference recoloring')

    monkeypatch.setattr(FQ, '_preference_repair', unexpected)
    assert default == FQ.assign(tasks(), pool)


def test_small_graph_invariants_with_fixed_seed():
    rng = random.Random(20261024)
    for _ in range(40):
        domains = [rng.sample(['F1', 'F2', 'F3'], rng.randint(1, 3)) for _ in range(5)]
        colors = [rng.choice(domain) for domain in domains]
        edges = [(i, j) for i in range(5) for j in range(i + 1, 5) if rng.random() < 0.5]
        tasks, adj, sep, original = case(domains, colors, edges)
        fixed = {rng.randrange(5)}
        order = rng.sample(range(5), 5)
        preferences = {'NET-%d' % i: rng.sample(domains[i], len(domains[i])) for i in order}
        before = copy.deepcopy(original)
        result, _ = FQ._preference_repair(tasks, adj, sep, original, fixed, preferences)
        assert original == before
        assert set(result) == set(original)
        assert all(result[i] in tasks[i].allowed for i in result)
        assert all(result[i] == original[i] for i in fixed)
        assert len(FQ.check_conflicts(tasks, adj, sep, result)) <= len(FQ.check_conflicts(tasks, adj, sep, original))
        ranks = [{fid: rank for rank, fid in enumerate(preferences['NET-%d' % i])} for i in order]
        assert tuple(r[result[i]['freq_id']] for i, r in zip(order, ranks)) <= tuple(
            r[original[i]['freq_id']] for i, r in zip(order, ranks))


def test_admissible_rejects_bad_blocker_and_finds_another_three_net_recoloring():
    tasks, adj, sep, original = case(
        [['F1', 'F2'], ['F2', 'F3'], ['F3', 'F1', 'F4']],
        ['F1', 'F2', 'F3'], [(0, 1), (0, 2), (1, 2)],
        frequencies=(5000, 6000, 7000, 8000))
    before = copy.deepcopy((original, [t.allowed for t in tasks]))
    calls = []

    def admissible(task_id, channel):
        calls.append((task_id, channel['freq_id']))
        task = next(t for t in tasks if t.task_id == task_id)
        assert any(channel is option for option in task.allowed)
        return (task_id, channel['freq_id']) != ('NET-2', 'F1')

    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {'NET-0': ['F2', 'F1']}, channel_admissible=admissible)
    assert ids(result) == {0: 'F2', 1: 'F3', 2: 'F4'}
    assert moves == 1
    assert ('NET-2', 'F1') in calls
    assert {task_id for task_id, _ in calls} == {'NET-0', 'NET-1', 'NET-2'}
    assert not FQ.check_conflicts(tasks, adj, sep, result)
    assert (original, [t.allowed for t in tasks]) == before


@pytest.mark.parametrize('rejected', [('NET-1', 'F3'), ('NET-2', 'F1')])
def test_admissible_rejection_rolls_back_an_incomplete_three_net_cycle(rejected):
    tasks, adj, sep, original = cycle()
    before = copy.deepcopy((original, [t.allowed for t in tasks]))
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {'NET-0': ['F2', 'F1']},
        channel_admissible=lambda task_id, channel: (task_id, channel['freq_id']) != rejected)
    assert result == original
    assert moves == 0
    assert (original, [t.allowed for t in tasks]) == before


def test_admissible_filters_root_options_before_preference_selection():
    tasks, adj, sep, original = case([['F1', 'F2', 'F3']], ['F1'], [])
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {'NET-0': ['F2', 'F3', 'F1']},
        channel_admissible=lambda task_id, channel: channel['freq_id'] != 'F2')
    assert ids(result) == {0: 'F3'}
    assert moves == 1


def test_admissible_can_reject_every_candidate_without_erasing_current_assignments():
    tasks, adj, sep, original = cycle()
    before = copy.deepcopy((original, [t.allowed for t in tasks]))
    result, moves = FQ._preference_repair(tasks, adj, sep, original, set(),
        {'NET-0': ['F2', 'F1']}, channel_admissible=lambda *_: False)
    assert result == original
    assert moves == 0
    assert (original, [t.allowed for t in tasks]) == before


def test_admissible_cannot_override_or_recheck_a_fixed_manual_blocker():
    tasks, adj, sep, original = cycle()

    def admissible(task_id, channel):
        assert task_id != 'NET-2'
        return True

    result, moves = FQ._preference_repair(tasks, adj, sep, original, {2},
        {'NET-0': ['F2', 'F1']}, channel_admissible=admissible)
    assert result == original
    assert moves == 0


@pytest.mark.parametrize('preference', [None, {}])
@pytest.mark.parametrize('manual', [None,
    [{'link_id': 'NET-0', 'freq_khz': 5000}],
    [{'link_id': 'NET-0', 'freq_khz': 9000}],
])
def test_assign_never_calls_admissible_without_preferences(preference, manual):
    tasks, _, _, _ = cycle()
    pool = FQ.FreqPool([
        dict(freq_id=fid, device_class='HF', center_freq_khz=str(freq), is_available='true')
        for fid, freq in [('F1', 5000), ('F2', 6000), ('F3', 7000)]])

    def unexpected(*_):
        pytest.fail('无偏好分配不得调用物理候选回调')

    expected = FQ.assign(copy.deepcopy(tasks), pool, manual, channel_preference=preference)
    actual = FQ.assign(copy.deepcopy(tasks), pool, manual,
                       channel_preference=preference, channel_admissible=unexpected)
    assert actual == expected


def test_assign_forwards_callback_only_to_repair_and_keeps_manual_authoritative(monkeypatch):
    tasks, _, _, _ = cycle()
    pool = FQ.FreqPool([
        dict(freq_id=fid, device_class='HF', center_freq_khz=str(freq), is_available='true')
        for fid, freq in [('F1', 5000), ('F2', 6000), ('F3', 7000)]])
    original_pool = copy.deepcopy(pool.channels)
    calls = []
    real_repair = FQ._preference_repair

    def admissible(task_id, channel):
        assert task_id != 'NET-0'
        calls.append((task_id, channel['freq_id']))
        return False

    def spy(*args, **kwargs):
        assert kwargs['channel_admissible'] is admissible
        original = copy.deepcopy(args[3])
        result, moves = real_repair(*args, **kwargs)
        assert result == original
        assert moves == 0
        return result, moves

    monkeypatch.setattr(FQ, '_preference_repair', spy)
    actual = FQ.assign(tasks, pool, [{'link_id': 'NET-0', 'freq_khz': 5000}],
        channel_preference={'NET-0': ['F3', 'F1'], 'NET-1': ['F3', 'F2']},
        channel_admissible=admissible)
    assert actual['assignments'][0]['manual']
    assert actual['assignments'][0]['freq_id'] == 'F1'
    assert actual['unassigned'] == []
    assert calls
    assert all(len(t.allowed) == 3 for t in tasks)
    assert pool.channels == original_pool


@pytest.mark.parametrize('error_type', [RuntimeError, asyncio.CancelledError])
@pytest.mark.parametrize('failed_task', ['NET-0', 'NET-2'])
def test_admissible_errors_and_cancellation_propagate_from_every_depth(error_type, failed_task):
    tasks, adj, sep, original = cycle()
    before = copy.deepcopy(original)
    error = error_type('停止候选核验')

    def admissible(task_id, channel):
        if task_id == failed_task:
            raise error
        return True

    with pytest.raises(error_type) as caught:
        FQ._preference_repair(tasks, adj, sep, original, set(),
            {'NET-0': ['F2', 'F1']}, channel_admissible=admissible)
    assert caught.value is error
    assert original == before


@pytest.mark.parametrize('error_type', [RuntimeError, asyncio.CancelledError])
def test_assign_does_not_swallow_admissible_errors_or_cancellation(error_type):
    tasks, _, _, _ = cycle()
    pool = FQ.FreqPool([
        dict(freq_id=fid, device_class='HF', center_freq_khz=str(freq), is_available='true')
        for fid, freq in [('F1', 5000), ('F2', 6000), ('F3', 7000)]])
    error = error_type('停止分配')

    def admissible(*_):
        raise error

    with pytest.raises(error_type) as caught:
        FQ.assign(tasks, pool, channel_preference={'NET-0': ['F2', 'F1']},
                  channel_admissible=admissible)
    assert caught.value is error
