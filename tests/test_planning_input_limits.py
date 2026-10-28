"""输入上限在读取地形、分配矩阵和启动重计算前生效。"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
for folder in ("scripts", "scripts/planning"):
    sys.path.insert(0, str(ROOT / folder))
from input_limits import MAX_COMPLETE_CHECKS, MAX_GRID_POINTS, input_limit_issues
from candidate_sites import grid_layout
from deployment_inputs import validate_fixed_capacity
from actual_search import ChannelSearch


@pytest.mark.parametrize("count", [1, MAX_COMPLETE_CHECKS])
def test_solution_boundary(count):
    assert input_limit_issues({"deploymentSolve": {"solutionCount": count}}) == []


def test_solution_excess_and_search_use_same_budget():
    assert input_limit_issues({"deploymentSolve": {"solutionCount": 41}})[0]["field"] == "deploymentSolve.solutionCount"
    search = object.__new__(ChannelSearch)
    search.complete_checks = MAX_COMPLETE_CHECKS
    search.checkpoint = lambda: True
    assert search.begin_check() is False


@pytest.mark.parametrize("step", [1e-320, 1, 300, 500, 1000, 200000])
def test_grid_scale_matches_native_count(step):
    bbox = [113, 37, 114.35, 38.08]
    issues = input_limit_issues({"bbox": bbox, "deploymentConstraints": {"gridStepM": step}})
    try:
        cols, rows, *_ = grid_layout(bbox, step)
        exceeds = cols * rows > MAX_GRID_POINTS
    except (ValueError, ZeroDivisionError, OverflowError):
        exceeds = True
    assert bool(issues) is exceeds


@pytest.mark.parametrize("count", [0, 1, 2])
def test_fixed_count_uses_distinct_positions(count):
    candidates = [{"lon": 114, "lat": 37}, {"lon": 114, "lat": 37}, {"lon": 114.1, "lat": 37}]
    validate_fixed_capacity({"deploymentSolve": {"mode": "FIXED_COUNT", "fixedCount": count}}, candidates)


def test_fixed_count_excess_explains_actual_capacity():
    with pytest.raises(ValueError, match="超过本次筛选后可用的1个不同物理位置"):
        validate_fixed_capacity({"deploymentSolve": {"mode": "FIXED_COUNT", "fixedCount": 2}}, [{"lon": 114, "lat": 37}] * 2)
