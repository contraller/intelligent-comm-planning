"""冻结规划输入、候选筛选证据及最终新增部署约束。"""
from __future__ import annotations

import copy
import json
import math
import time
from pathlib import Path

import echelon as E
from candidate_sites import (PositionIndex, grid_layout, grid_points, in_exclusion_polygon,
                             same_position, thin_by_spacing, validate_exclusion_polygon)
from terrain import haversine_m, los_clearance
from input_limits import MAX_GRID_POINTS

ROOT = Path(__file__).resolve().parents[2]
# 网格规模上限与输入预检共用；道路距离场单独限额。
MAX_ROAD_FIELD_CELLS = 1_000_000
INPUT_BUDGET_S = 300.0
REJECT_KEYS = ("outside_bbox", "source_rule", "elevation", "slope", "landcover", "road",
               "exclude_zone", "los", "spacing", "data_unavailable")
NUMBER_FIELDS = ("elevation_m", "slope_deg", "nearest_road_distance_m",
                 "nearest_node_distance_m", "visible_node_count", "score")


class DataUnavailable(ValueError):
    pass


def input_checkpoint(checkpoint=None):
    if checkpoint is not None:
        return checkpoint
    deadline = time.monotonic() + INPUT_BUDGET_S

    def check():
        if time.monotonic() >= deadline:
            raise TimeoutError("候选处理超过既有300秒预算，未返回部分结果冒充完成")

    return check


def finite(value):
    if value is None or value == "" or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None
    return number if math.isfinite(number) else None


def inside(lon, lat, bbox, tolerance=0.0):
    return (bbox is None or bbox[0] - tolerance <= lon <= bbox[2] + tolerance
            and bbox[1] - tolerance <= lat <= bbox[3] + tolerance)


def specified(conditions):
    return any(value is not None and value != [] for value in (conditions or {}).values())


class StrictTerrain:
    """新增点约束不允许沿用DEM夹边、缺值补零或合成地形回退。"""
    def __init__(self, terrain, checkpoint=None):
        self.terrain = terrain
        self.checkpoint = checkpoint

    def _check(self):
        if self.checkpoint:
            self.checkpoint()

    def elevation(self, lon, lat):
        self._check()
        raster = getattr(self.terrain, "_dem", None)
        if raster is None or not inside(lon, lat, raster.bbox):
            raise DataUnavailable("缺少覆盖该坐标的原始DEM")
        value = finite(raster.sample(lon, lat))
        self._check()
        if value is None:
            raise DataUnavailable("DEM像元缺失，不能补零或夹边")
        return value

    def slope_deg(self, lon, lat):
        dlat = 90.0 / 111320.0
        dlon = dlat / math.cos(math.radians(lat))
        dx = (self.elevation(lon + dlon, lat) - self.elevation(lon - dlon, lat)) / 180.0
        dy = (self.elevation(lon, lat + dlat) - self.elevation(lon, lat - dlat)) / 180.0
        return math.degrees(math.atan(math.hypot(dx, dy)))

    def landcover(self, lon, lat):
        self._check()
        value = self.terrain.landcover(lon, lat)
        self._check()
        if not value or value == "未知":
            raise DataUnavailable("缺少已知地物分类，来源范围待确认")
        return value


def _display(row):
    result = {key: finite(row.get(key)) for key in NUMBER_FIELDS}
    result.update(site_id=str(row["site_id"]), lon=finite(row.get("lon")), lat=finite(row.get("lat")),
        landcover_type=row.get("landcover_type") or None,
        candidate_role=row.get("candidate_role") or None,
        recommendation_level=row.get("recommendation_level") or None,
        is_deployable=None, reject_reason=None, forced=bool(row.get("forced", False)))
    return result


def _road_field(bbox, labels, checkpoint=None):
    from roads import RoadDistanceField
    path = ROOT / "data/raw/roads/roads_taihang.geojson.gz"
    if checkpoint:
        checkpoint()
    width = int((bbox[2] - bbox[0]) * 111320.0 * math.cos(math.radians((bbox[1] + bbox[3]) / 2)) / 250.0 + 40) + 1
    height = int((bbox[3] - bbox[1]) * 111320.0 / 250.0 + 40) + 1
    if width * height > MAX_ROAD_FIELD_CELLS:
        raise ValueError(f"道路距离场预计{width * height}格，超过单次上限{MAX_ROAD_FIELD_CELLS}格，请缩小任务范围")
    if not path.is_file():
        raise DataUnavailable("缺少道路源文件：roads_taihang.geojson.gz")
    labels.append("道路：roads_taihang.geojson.gz；250m距离栅格近似，通行条件待确认")
    field = RoadDistanceField(str(path), bbox)
    if checkpoint:
        checkpoint()
    if field.occupied == 0:
        raise DataUnavailable("道路资料在任务范围内无可用道路栅格")
    return field


def _sample_point(lon, lat, terrain, roads, nodes, checkpoint=None):
    row = dict(lon=lon, lat=lat)
    errors = {}
    for field, operation in (("elevation_m", terrain.elevation), ("slope_deg", terrain.slope_deg),
                             ("landcover_type", terrain.landcover)):
        if checkpoint:
            checkpoint()
        try:
            row[field] = operation(lon, lat)
        except DataUnavailable as exc:
            row[field] = None
            errors[field] = str(exc)
        if checkpoint:
            checkpoint()
    distance = roads.distance_m(lon, lat) if roads is not None else None
    row["nearest_road_distance_m"] = finite(distance)
    nearest = None
    for node in nodes:
        if checkpoint:
            checkpoint()
        distance = haversine_m(lon, lat, float(node["lon"]), float(node["lat"]))
        nearest = distance if nearest is None else min(nearest, distance)
    row["nearest_node_distance_m"] = nearest
    row["_missing"] = errors
    if checkpoint:
        checkpoint()
    return row


def _los_subtypes(row, stations, strict, templates, target_ids, checkpoint=None):
    targets = {station.sid: station for station in stations}
    eligible, missing = [], []
    visible_count = 0
    for subtype in E.DEPLOYABLE_TYPES:
        if checkpoint:
            checkpoint()
        visible = 0
        for target_id in target_ids:
            if checkpoint:
                checkpoint()
            target = targets.get(target_id)
            if target is None:
                missing.append("通视目标没有可用冻结设备：" + target_id)
                break
            pairs = [(templates.get((subtype, band)) or templates.get(("*", band)), radio)
                     for band, radio in target.radio.items() if band in E.bands_of(subtype)]
            pairs = [(candidate, radio) for candidate, radio in pairs if candidate is not None]
            if not pairs:
                missing.append("通视目标与候选类型缺少同频段挂高：" + target_id + "/" + subtype)
                break
            heights = [(finite(candidate.get("height")), finite(radio.get("height")))
                       for candidate, radio in pairs]
            if any(a is None or b is None or a < 0 or b < 0 for a, b in heights):
                missing.append("通视计算缺少实际天线挂高：" + target_id)
                break
            if not any(los_clearance(strict, row["lon"], row["lat"], a,
                                     target.lon, target.lat, b)[0] for a, b in heights):
                break
            visible += 1
        visible_count = max(visible_count, visible)
        if visible == len(target_ids):
            eligible.append(subtype)
    return eligible, sorted(set(missing)), visible_count


def prepare_candidates(rows, planning_input, terrain, nodes, stations, *, checkpoint=None):
    """不筛掉任何既有节点或需求；返回求解候选和完整筛选明细。"""
    from deployment import radio_templates
    checkpoint = input_checkpoint(checkpoint)
    checkpoint()
    metadata = copy.deepcopy(planning_input or {})
    c = metadata.get("deploymentConstraints") or {}
    bbox = metadata.get("bbox")
    grid_step = c.get("gridStepM")
    if grid_step is not None:
        if bbox is None:
            raise ValueError("gridStepM要求显式任务bbox，不能推定规划区域")
        columns, count_rows, _dx, _dy = grid_layout(bbox, grid_step)
        grid_count = columns * count_rows
        if grid_count > MAX_GRID_POINTS:
            raise ValueError(f"候选网格预计扫描{grid_count}点，超过单次上限{MAX_GRID_POINTS}点；请增大网格间距或缩小任务范围，未执行扫描且不截断结果")
    checkpoint()
    active = specified(c)
    if (active or metadata.get("deploymentSolve")) and getattr(terrain, "_dem", None) is None:
        raise DataUnavailable("部署高级条件缺少原始DEM，禁止使用合成地形回退")
    for polygon in c.get("forcedExcludePolygons", []):
        validate_exclusion_polygon(polygon, checkpoint=checkpoint)
    strict = StrictTerrain(terrain, checkpoint)
    labels = ["冻结输入表：candidate_site.csv；原始来源按资源快照记录"]
    source = "FROZEN_CANDIDATE_TABLE"
    roads = None
    road_error = None
    if c.get("gridStepM") is not None or c.get("forcedInclude"):
        for name in ("dem/dem_current.json", "landcover/landcover_taihang.json"):
            path = ROOT / "data/raw" / name
            checkpoint()
            if path.is_file():
                header = json.loads(path.read_text(encoding="utf-8"))
                labels.append(name + "：" + str(header.get("source") or "来源待确认"))
            checkpoint()
        if c.get("roadMaxDistanceM") is not None:
            try:
                roads = _road_field(bbox or getattr(terrain, "bbox", None), labels, checkpoint)
            except DataUnavailable as exc:
                road_error = str(exc)
    if grid_step is not None:
        source = "TERRAIN_GRID"
        labels[0] = "网格扫描：任务区和步长来自冻结输入；原始候选表未替代网格扫描"

    def original_rows():
        matched = set()
        forced = {(point["lon"], point["lat"]): index
                  for index, point in enumerate(c.get("forcedInclude", []), 1)}
        if grid_step is not None:
            def scanned_rows():
                for index, (lon, lat) in enumerate(grid_points(bbox, grid_step), 1):
                    checkpoint()
                    row = _sample_point(lon, lat, strict, roads, nodes, checkpoint)
                    row["site_id"] = "R4-GRID-%06d" % index
                    yield row
            originals = scanned_rows()
        else:
            originals = (copy.deepcopy(row) for row in rows)
        for row in originals:
            checkpoint()
            position = finite(row.get("lon")), finite(row.get("lat"))
            if position in forced and position not in matched:
                row["forced"] = True
                matched.add(position)
            yield row
        for position, index in forced.items():
            checkpoint()
            if position not in matched:
                row = _sample_point(*position, strict, roads, nodes, checkpoint)
                row.update(site_id="R4-FORCED-%03d" % index, forced=True)
                yield row

    stats = dict.fromkeys(REJECT_KEYS, 0)
    displays, accepted, missing = [], [], []
    accepted_positions = PositionIndex(checkpoint)
    required = set()
    scanned_count = 0
    templates = radio_templates(stations) if c.get("losRequiredNodeIds") else {}
    for raw in original_rows():
        scanned_count += 1
        if checkpoint:
            checkpoint()
        row = _display(raw)
        if row["forced"]:
            required.add(row["site_id"])
        displays.append(row)
        reasons, unavailable = [], []
        if row["lon"] is None or row["lat"] is None:
            unavailable.append(("coordinate", "缺少合法候选坐标"))
        # 冻结表坐标为六位小数，与既有候选接口一致；显式新点不享用此容差。
        elif not inside(row["lon"], row["lat"], bbox,
                        0.5e-6 if source == "FROZEN_CANDIDATE_TABLE" and not row["forced"] else 0.0):
            reasons.append("outside_bbox")
        if active and not reasons and not unavailable:
            if str(raw.get("is_deployable", "true")).lower() == "false":
                reasons.append("source_rule")
            if any(in_exclusion_polygon(row["lon"], row["lat"], polygon)
                   for polygon in c.get("forcedExcludePolygons", [])):
                reasons.append("exclude_zone")
            checks = (("maxSlopeDeg", "slope_deg", "slope"),
                      ("elevationRangeM", "elevation_m", "elevation"),
                      ("allowedLandcover", "landcover_type", "landcover"),
                      ("roadMaxDistanceM", "nearest_road_distance_m", "road"))
            for field, attribute, reason in checks:
                bound, value = c.get(field), row[attribute]
                if bound is None:
                    continue
                if value is None or value == "未知" or attribute == "nearest_road_distance_m" and value < 0:
                    unavailable.append((field, road_error if reason == "road" and road_error else
                        raw.get("_missing", {}).get(attribute, "缺少可用候选属性：" + attribute)))
                elif ((reason in ("slope", "road") and value > bound)
                      or reason == "elevation" and not bound[0] <= value <= bound[1]
                      or reason == "landcover" and value not in bound):
                    reasons.append(reason)
            if raw.get("_missing", {}).get("elevation_m"):
                unavailable.append(("elevation_m", raw["_missing"]["elevation_m"]))
            if c.get("losRequiredNodeIds") and not reasons and not unavailable:
                try:
                    eligible, errors, visible = _los_subtypes(row, stations, strict, templates, c["losRequiredNodeIds"], checkpoint)
                    row["visible_node_count"] = visible
                    raw["eligible_subtypes"] = eligible
                    if not eligible:
                        if errors:
                            unavailable.append(("losRequiredNodeIds", "；".join(errors)))
                        else:
                            reasons.append("los")
                except DataUnavailable as exc:
                    unavailable.append(("losRequiredNodeIds", str(exc)))
        if not reasons and not unavailable:
            duplicate = accepted_positions.find(row["lon"], row["lat"])
            if duplicate is not None:
                reasons.append("duplicate_position:" + duplicate["site_id"])
                stats["source_rule"] += 1
        if unavailable:
            stats["data_unavailable"] += 1
            missing.extend(dict(site_id=row["site_id"], field=field, reason=reason)
                           for field, reason in unavailable)
        for reason in set(reasons):
            if reason in stats:
                stats[reason] += 1
        row["is_deployable"] = False if reasons else (None if unavailable else True)
        row["reject_reason"] = "；".join(reasons + [reason for _, reason in unavailable]) or None
        if row["is_deployable"]:
            candidate = dict(raw, lon=row["lon"], lat=row["lat"])
            accepted.append(candidate)
            accepted_positions.add(row["lon"], row["lat"], candidate)
    spacing = c.get("minSiteSpacingM")
    if spacing and accepted:
        forced = [row for row in accepted if row.get("forced")]
        normal = [row for row in accepted if not row.get("forced")]
        ranked = []
        for row in normal:
            checkpoint()
            separated = True
            for point in forced:
                checkpoint()
                if haversine_m(row["lon"], row["lat"], float(point["lon"]), float(point["lat"])) < spacing:
                    separated = False
                    break
            if separated:
                ranked.append(dict(row, score=finite(row.get("score")) if finite(row.get("score")) is not None else -math.inf))
        latitude = (bbox[1] + bbox[3]) / 2 if bbox else sum(row["lat"] for row in accepted) / len(accepted)
        kept = {row["site_id"] for row in forced + thin_by_spacing(ranked, spacing, latitude, checkpoint=checkpoint)}
        checkpoint()
        for row in displays:
            checkpoint()
            if row["is_deployable"] and row["site_id"] not in kept:
                row.update(is_deployable=False, reject_reason="spacing")
                stats["spacing"] += 1
        accepted = [row for row in accepted if row["site_id"] in kept]
    rejected_forced = required - {row["site_id"] for row in accepted}
    if rejected_forced:
        details = [row for row in displays if row["site_id"] in rejected_forced]
        raise ValueError("强制部署点不可计算或违反部署条件：" + json.dumps(details, ensure_ascii=False))
    checkpoint()
    return accepted, dict(source=source, scanned_count=scanned_count, accepted_count=len(accepted),
        candidates=displays, rejected_stats=stats, data_sources=labels, unavailable_reasons=missing)


def selected_sites(nodes, original_nodes, candidates, *, checkpoint=None):
    existing = {row["node_id"] for row in original_nodes}
    by_id = {}
    positions = PositionIndex(checkpoint)
    for row in candidates:
        if checkpoint:
            checkpoint()
        by_id[row["site_id"]] = row
        positions.add(row["lon"], row["lat"], row)
    out = []
    for node in nodes:
        if checkpoint:
            checkpoint()
        if node["node_id"] in existing:
            continue
        native_id = node["node_id"].split("-", 2)[-1]
        match = by_id.get(native_id)
        if match is None or not same_position(match["lon"], match["lat"], node["lon"], node["lat"]):
            match = positions.find(node["lon"], node["lat"])
        out.append(dict(site_id=match["site_id"] if match else None, node_id=node["node_id"],
            lon=float(node["lon"]), lat=float(node["lat"]), subtype=node.get("node_subtype"),
            forced=bool(match and match.get("forced"))))
    if checkpoint:
        checkpoint()
    return out


def position_issues(sites, *, checkpoint=None):
    positions = PositionIndex(checkpoint)
    site_ids = set()
    issues = []
    for site in sites:
        if checkpoint:
            checkpoint()
        previous = positions.find(site["lon"], site["lat"])
        if previous is not None:
            issues.append(dict(field="duplicatePosition", site_id=site["site_id"],
                reason="最终新增站点重复占用同一物理位置：" + previous["node_id"] + "、" + site["node_id"]))
        else:
            positions.add(site["lon"], site["lat"], site)
        if site["site_id"] is not None and site["site_id"] in site_ids:
            issues.append(dict(field="duplicateSiteId", site_id=site["site_id"], reason="最终新增站点重复使用候选编号"))
        site_ids.add(site["site_id"])
    if checkpoint:
        checkpoint()
    return issues


def physical_count(sites, *, checkpoint=None):
    positions = PositionIndex(checkpoint)
    count = 0
    for site in sites:
        if checkpoint:
            checkpoint()
        if positions.find(site["lon"], site["lat"]) is None:
            positions.add(site["lon"], site["lat"], site)
            count += 1
    if checkpoint:
        checkpoint()
    return count


def validate_fixed_capacity(planning_input, candidates, *, checkpoint=None):
    """新增数量以本次筛选的不同物理位置为上限，在构造链路矩阵前拒绝超额。"""
    solve = (planning_input or {}).get("deploymentSolve") or {}
    if solve.get("mode") != "FIXED_COUNT":
        return
    limit = physical_count(candidates, checkpoint=checkpoint)
    requested = solve["fixedCount"]
    if requested > limit:
        raise ValueError(f"指定新增部署数量{requested}超过本次筛选后可用的{limit}个不同物理位置；请减小数量或调整筛选条件")


def final_issues(sites, planning_input, candidates, *, nodes=(), params=None, terrain=None, checkpoint=None):
    metadata = planning_input or {}
    c, solve = metadata.get("deploymentConstraints") or {}, metadata.get("deploymentSolve") or {}
    issues = position_issues(sites, checkpoint=checkpoint)
    candidates_by_id = {}
    for row in candidates:
        if checkpoint:
            checkpoint()
        candidates_by_id[row["site_id"]] = row
    for site in sites:
        if checkpoint:
            checkpoint()
        match = candidates_by_id.get(site["site_id"])
        tolerance = 0.5e-6 if match and c.get("gridStepM") is None and not match.get("forced") else 0.0
        if not inside(site["lon"], site["lat"], metadata.get("bbox"), tolerance):
            issues.append(dict(field="bbox", site_id=site["site_id"], reason="最终新增站点位于任务区外"))
        if match is None:
            issues.append(dict(field="candidate", site_id=site["site_id"], reason="最终新增站点没有已通过筛选的候选来源"))
        elif not same_position(match["lon"], match["lat"], site["lon"], site["lat"]):
            issues.append(dict(field="candidate", site_id=site["site_id"], reason="最终新增站点坐标与候选来源不一致"))
        elif match.get("eligible_subtypes") is not None and site["subtype"] not in match["eligible_subtypes"]:
            issues.append(dict(field="losRequiredNodeIds", site_id=site["site_id"], reason="最终候选类型未通过全部通视条件"))
        if any(in_exclusion_polygon(site["lon"], site["lat"], polygon) for polygon in c.get("forcedExcludePolygons", [])):
            issues.append(dict(field="forcedExcludePolygons", site_id=site["site_id"], reason="最终新增站点位于禁部署区"))
    spacing = c.get("minSiteSpacingM")
    for index, site in enumerate(sites):
        if checkpoint:
            checkpoint()
        if spacing and any(haversine_m(site["lon"], site["lat"], other["lon"], other["lat"]) < spacing for other in sites[:index]):
            issues.append(dict(field="minSiteSpacingM", site_id=site["site_id"], reason="最终新增站点间距不足"))
    forced = {row["site_id"] for row in candidates if row.get("forced")}
    if forced - {row["site_id"] for row in sites}:
        issues.append(dict(field="forcedInclude", reason="最终方案未保留全部强制部署点"))
    if solve.get("mode") == "FIXED_COUNT" and physical_count(sites, checkpoint=checkpoint) != solve["fixedCount"]:
        issues.append(dict(field="fixedCount", reason="最终新增数量未满足指定数量"))
    if c.get("losRequiredNodeIds"):
        positions = {node["node_id"]: node for node in nodes}
        radios = {}
        for radio in (params or {}).get("params", []):
            if checkpoint:
                checkpoint()
            height = finite(radio.get("antenna_height_m"))
            if height is not None and height >= 0:
                radios.setdefault(radio["node_id"], []).append((radio["band"], height))
        for site in sites:
            for target_id in c["losRequiredNodeIds"]:
                if checkpoint:
                    checkpoint()
                target = positions.get(target_id)
                pairs = [(a, b) for band_a, a in radios.get(site["node_id"], [])
                         for band_b, b in radios.get(target_id, []) if band_a == band_b]
                if terrain is None or target is None or not pairs:
                    reason = "最终LOS缺少目标坐标或实际规划挂高：" + target_id
                else:
                    try:
                        visible = any(los_clearance(StrictTerrain(terrain, checkpoint), site["lon"], site["lat"], a,
                            float(target["lon"]), float(target["lat"]), b)[0] for a, b in pairs)
                        if visible:
                            continue
                        reason = "最终实际挂高未满足通视目标：" + target_id
                    except DataUnavailable as exc:
                        reason = str(exc)
                issues.append(dict(field="losRequiredNodeIds", site_id=site["site_id"], reason=reason))
    if checkpoint:
        checkpoint()
    return issues


def solve_detail(planning_input, sites, solution, issues, alternatives, *, forced_site_ids=None, checkpoint=None):
    if checkpoint:
        checkpoint()
    issues = list(issues)
    for issue in position_issues(sites, checkpoint=checkpoint):
        if issue not in issues:
            issues.append(issue)
    count = physical_count(sites, checkpoint=checkpoint)
    solve = (planning_input or {}).get("deploymentSolve") or {}
    if solve.get("mode") == "FIXED_COUNT" and count != solve["fixedCount"] and not any(row["field"] == "fixedCount" for row in issues):
        issues.append(dict(field="fixedCount", reason="最终不同物理位置数量未满足指定数量"))
    requested = solve.get("solutionCount", 1)
    reasons = []
    if issues:
        reasons.append("部署约束未满足，不能作为合格部署结果")
    if len(alternatives) < requested:
        reasons.append("既有搜索预算内完整校验合格的不同方案数量不足")
    # P1的证明只覆盖代表频点选址，不能外推为实际频点全网硬约束的全局证明。
    proved = bool(alternatives) and not issues and count == 0 and solve.get("mode", "MIN_COUNT") == "MIN_COUNT"
    if solve.get("mode", "MIN_COUNT") == "MIN_COUNT" and not proved:
        reasons.append("未证明全局最少部署数量")
    if checkpoint:
        checkpoint()
    return dict(mode=solve.get("mode", "MIN_COUNT"), requested_count=solve.get("fixedCount"),
        actual_count=count, count_satisfied=not any(row["field"] in {"fixedCount", "duplicatePosition", "duplicateSiteId"} for row in issues),
        requested_solution_count=requested, returned_solution_count=len(alternatives),
        forced_site_ids=(list(forced_site_ids) if forced_site_ids is not None else
                         [row["site_id"] for row in sites if row["forced"]]), selected_sites=sites,
        lower_bound=solution.lower_bound, proved_optimal=proved, constraint_issues=issues,
        shortfall_reasons=reasons, solutions=alternatives)


def verified_solutions(verified, selected, original_nodes, candidates, limit, *, checkpoint=None):
    """只计入实际频点完整校验通过且不同的结果，不复用近似tradeoff。"""
    results, seen = [], set()
    ordered = [selected] + [item[3] for item in sorted(verified, key=lambda item: item[3]["score"])]
    for result in ordered:
        if checkpoint:
            checkpoint()
        if (result["score"][0] != 0 or result.get("deployment_issues")
                or not result["check"]["passed"] or result.get("binding_errors")
                or any(not row["pass"] for row in result["constraint_check"].values())):
            continue
        sites = selected_sites(result["nodes"], original_nodes, candidates, checkpoint=checkpoint)
        if position_issues(sites, checkpoint=checkpoint):
            continue
        signature = json.dumps([result["links"], result["frequency"]["assignments"]],
                               sort_keys=True, ensure_ascii=False)
        if checkpoint:
            checkpoint()
        if signature in seen:
            continue
        seen.add(signature)
        results.append(dict(candidate_index=len(results) + 1,
            selected_sites=sites,
            evaluation_basis="ACTUAL_FREQUENCY_FULL_CHECK",
            **{key: copy.deepcopy(result[key]) for key in (
                "nodes", "devices", "links", "routes", "frequency", "params", "check",
                "objectives", "constraint_check")}))
        if checkpoint:
            checkpoint()
        if len(results) >= limit:
            break
    if checkpoint:
        checkpoint()
    return results
