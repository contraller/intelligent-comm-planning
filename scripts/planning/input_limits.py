"""新提交输入的计算规模边界；不改写已保存的历史快照。"""
import math

# 一份完整备选至少需要一次完整物理校验，与实际搜索的预算保持同源。
MAX_COMPLETE_CHECKS = 40
MAX_GRID_POINTS = 100_000


def input_limit_issues(input_data):
    issues = []
    solve = input_data.get("deploymentSolve") or {}
    if not isinstance(solve, dict):
        solve = {}
    count = solve.get("solutionCount")
    if isinstance(count, int) and not isinstance(count, bool) and count > MAX_COMPLETE_CHECKS:
        issues.append(dict(objectId="TASK", field="deploymentSolve.solutionCount",
            message=f"期望备选数量最多{MAX_COMPLETE_CHECKS}份；实际返回数量仍取决于可行方案和搜索预算"))
    deployment = input_data.get("deploymentConstraints") or {}
    step = deployment.get("gridStepM") if isinstance(deployment, dict) else None
    bbox = input_data.get("bbox")
    if step is None or bbox is None:
        return issues
    # 只计算行列规模，不生成网格或读取DEM，与candidate_sites.grid_layout同式。
    try:
        west, south, east, north = bbox
        if not (math.isfinite(step) and step > 0 and -180 <= west < east <= 180
                and -90 <= south < north <= 90):
            return issues
        # 相同运算顺序避免临界格点在前置检查和扫描入口产生偏差。
        columns = (east - west) / (step / (111320.0 * math.cos(math.radians((south + north) / 2))))
        rows = (north - south) / (step / 111320.0)
        exceeded = (not math.isfinite(columns) or not math.isfinite(rows)
                    or (int(columns) + 1) * (int(rows) + 1) > MAX_GRID_POINTS)
    except (TypeError, ValueError, ZeroDivisionError, OverflowError):
        exceeded = True
    if exceeded:
        issues.append(dict(objectId="TASK", field="deploymentConstraints.gridStepM",
            message=f"当前任务范围与网格间距超过{MAX_GRID_POINTS}点扫描上限；请增大网格间距或缩小任务范围"))
    return issues
