"""Candidate deployment site filtering."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from .data_loader import candidate_sites, task_scenarios, to_float


DEFAULT_AREA_BBOX = [114.2724, 36.7610, 115.6276, 37.8390]


@dataclass(frozen=True)
class CandidateConstraints:
    max_slope_deg: float = 18.0
    elevation_range_m: tuple[float, float] | None = (0.0, 3000.0)
    allowed_landcover: tuple[str, ...] | None = None
    road_max_distance_m: float = 3500.0
    min_site_spacing_m: float = 3000.0

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "CandidateConstraints":
        constraints = payload.get("constraints") or {}
        elevation = constraints.get("elevation_range_m", [0.0, 3000.0])
        allowed = constraints.get("allowed_landcover")
        return cls(
            max_slope_deg=float(constraints.get("max_slope_deg", 18.0)),
            elevation_range_m=(float(elevation[0]), float(elevation[1])) if elevation else None,
            allowed_landcover=tuple(allowed) if allowed else None,
            road_max_distance_m=float(constraints.get("road_max_distance_m", 3500.0)),
            min_site_spacing_m=float(constraints.get("min_site_spacing_m", 3000.0)),
        )


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def _in_bbox(site: dict[str, str], bbox: list[float]) -> bool:
    lon, lat = to_float(site, "lon"), to_float(site, "lat")
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def _base_reject_reasons(site: dict[str, str], constraints: CandidateConstraints) -> list[str]:
    reasons: list[str] = []
    slope = to_float(site, "slope_deg")
    elevation = to_float(site, "elevation_m")
    road_distance = to_float(site, "nearest_road_distance_m")
    landcover = site.get("landcover_type", "")

    if slope > constraints.max_slope_deg:
        reasons.append("slope")
    if constraints.elevation_range_m:
        lo, hi = constraints.elevation_range_m
        if not (lo <= elevation <= hi):
            reasons.append("elevation")
    if constraints.allowed_landcover and landcover not in constraints.allowed_landcover:
        reasons.append("landcover")
    if road_distance > constraints.road_max_distance_m:
        reasons.append("road")
    if site.get("is_deployable") == "false":
        reasons.append("source_rule")
    return reasons


def _format_site(site: dict[str, str]) -> dict[str, Any]:
    return {
        "site_id": site["site_id"],
        "lon": to_float(site, "lon"),
        "lat": to_float(site, "lat"),
        "elevation_m": to_float(site, "elevation_m"),
        "slope_deg": to_float(site, "slope_deg"),
        "landcover_type": site["landcover_type"],
        "nearest_road_distance_m": to_float(site, "nearest_road_distance_m"),
        "nearest_node_distance_m": to_float(site, "nearest_node_distance_m"),
        "candidate_role": site["candidate_role"],
        "is_deployable": site["is_deployable"] == "true",
        "recommendation_level": site["recommendation_level"],
        "score": to_float(site, "score"),
        "reject_reason": site.get("reject_reason", ""),
    }


def filter_candidate_sites(payload: dict[str, Any]) -> dict[str, Any]:
    task_id = payload.get("task_id")
    known_tasks = {row["task_id"] for row in task_scenarios()}
    if task_id not in known_tasks:
        return {
            "code": 1002,
            "message": "任务不存在或任务数据未加载",
            "data": None,
            "request_id": payload.get("request_id", "req-local-candidate-sites"),
        }

    bbox = payload.get("area_bbox") or DEFAULT_AREA_BBOX
    constraints = CandidateConstraints.from_payload(payload)
    rejected_stats = {
        "slope": 0,
        "elevation": 0,
        "landcover": 0,
        "road": 0,
        "spacing": 0,
        "source_rule": 0,
        "outside_bbox": 0,
    }

    viable: list[dict[str, str]] = []
    for site in candidate_sites():
        if not _in_bbox(site, bbox):
            rejected_stats["outside_bbox"] += 1
            continue
        reasons = _base_reject_reasons(site, constraints)
        if reasons:
            for reason in set(reasons):
                rejected_stats[reason] += 1
            continue
        viable.append(site)

    selected: list[dict[str, str]] = []
    for site in sorted(viable, key=lambda s: to_float(s, "score"), reverse=True):
        lon, lat = to_float(site, "lon"), to_float(site, "lat")
        if any(
            haversine_m(lon, lat, to_float(prev, "lon"), to_float(prev, "lat"))
            < constraints.min_site_spacing_m
            for prev in selected
        ):
            rejected_stats["spacing"] += 1
            continue
        selected.append(site)

    code = 0 if len(selected) >= 20 else 3001
    message = "success" if code == 0 else "候选部署点数量不足，建议放宽筛选约束"
    data: dict[str, Any] = {
        "task_id": task_id,
        "candidate_count": len(candidate_sites()),
        "deployable_count": len(selected),
        "candidates": [_format_site(site) for site in selected],
        "rejected_stats": rejected_stats,
    }
    if code == 3001:
        data["suggestions"] = [
            "提高 max_slope_deg",
            "增加 allowed_landcover",
            "提高 road_max_distance_m",
            "降低 min_site_spacing_m",
        ]
    return {
        "code": code,
        "message": message,
        "data": data,
        "request_id": payload.get("request_id", "req-local-candidate-sites"),
    }
