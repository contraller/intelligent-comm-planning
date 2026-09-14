"""Generate visualization artifacts for the planning data set.

Outputs:
- docs/visualization/map_overview.html
- docs/visualization/figures/*.png
- docs/visualization/summary.json
"""

from __future__ import annotations

import csv
import html
import json
import math
import os
from collections import Counter, defaultdict
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import BoundaryNorm, ListedColormap

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = ROOT / "docs" / "visualization"
FIGURES = OUT / "figures"

PATHS = {
    "nodes": DATA / "synthetic" / "nodes" / "nodes_v1.csv",
    "candidate_sites": DATA / "synthetic" / "nodes" / "candidate_sites_v1.csv",
    "task_links": DATA / "synthetic" / "tasks" / "task_links_v1.csv",
    "frequency_resources": DATA / "synthetic" / "frequency" / "frequency_resources_v1.csv",
    "interference_sources": DATA / "synthetic" / "interference" / "interference_sources_v1.csv",
    "topology_links": DATA / "synthetic" / "topology" / "topology_links_v1.csv",
    "frequency_conflicts": DATA / "synthetic" / "topology" / "frequency_conflicts_v1.csv",
    "routes": DATA / "synthetic" / "topology" / "routes_v1.json",
    "link_status": DATA / "synthetic" / "link_status" / "link_status_v1.csv",
    "fault_cases": DATA / "fault" / "cases" / "fault_cases_v1.csv",
    "fault_rules": DATA / "fault" / "rules" / "fault_rules_v1.csv",
    "dem": DATA / "imported" / "data_zip_20260911" / "raw" / "terrain" / "dem_taihang.tif",
    "landcover": DATA / "imported" / "data_zip_20260911" / "raw" / "landcover" / "landcover_taihang.tif",
}

COLORS = {
    "hf": "#1f77b4",
    "vuhf": "#2ca02c",
    "candidate_ok": "#009e73",
    "candidate_bad": "#d55e00",
    "topology": "#677381",
    "route_primary": "#cc3311",
    "route_backup": "#0072b2",
    "interference": "#aa3377",
    "background": "#f8fafc",
    "ink": "#172033",
}


def read_csv(path: Path) -> pd.DataFrame:
    return pd.read_csv(path, encoding="utf-8-sig")


def load_data() -> dict[str, object]:
    data: dict[str, object] = {key: read_csv(path) for key, path in PATHS.items() if path.suffix == ".csv"}
    with PATHS["routes"].open("r", encoding="utf-8-sig") as f:
        data["routes"] = json.load(f)
    return data


def bool_series(series: pd.Series) -> pd.Series:
    return series.astype(str).str.lower().isin(["true", "1", "yes"])


def save_bar(counter: Counter | pd.Series, title: str, xlabel: str, ylabel: str, output: Path) -> None:
    if isinstance(counter, pd.Series):
        labels = [str(x) for x in counter.index.tolist()]
        values = [int(x) for x in counter.values.tolist()]
    else:
        labels = [str(k) for k, _ in counter.most_common()]
        values = [int(v) for _, v in counter.most_common()]

    fig, ax = plt.subplots(figsize=(9.6, 5.4), dpi=160)
    bars = ax.bar(labels, values, color=["#1f77b4", "#2ca02c", "#d55e00", "#9467bd", "#8c564b", "#e377c2"][: len(labels)])
    ax.set_title(title, fontsize=16, pad=14)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.grid(axis="y", color="#d9dee7", linewidth=0.8)
    ax.set_axisbelow(True)
    for bar in bars:
        height = bar.get_height()
        ax.annotate(
            f"{int(height)}",
            xy=(bar.get_x() + bar.get_width() / 2, height),
            xytext=(0, 4),
            textcoords="offset points",
            ha="center",
            va="bottom",
            fontsize=10,
        )
    fig.autofmt_xdate(rotation=20, ha="right")
    fig.tight_layout()
    fig.savefig(output, bbox_inches="tight")
    plt.close(fig)


def save_candidate_reason_chart(candidates: pd.DataFrame, output: Path) -> Counter:
    reason_labels = {
        "地物类型不适宜": "Landcover unsuitable",
        "道路距离超过阈值": "Road distance over limit",
        "坡度超过阈值": "Slope over limit",
    }
    reasons: Counter[str] = Counter()
    for value in candidates.get("reject_reason", pd.Series(dtype=str)).fillna(""):
        text = str(value).strip()
        if not text:
            continue
        for part in text.replace("|", ";").replace(",", ";").split(";"):
            part = part.strip()
            if part:
                reasons[reason_labels.get(part, part)] += 1
    if not reasons:
        reasons["none"] = 0
    save_bar(reasons, "Candidate Site Rejection Reasons", "Reason", "Count", output)
    return reasons


def save_hist(series: pd.Series, title: str, xlabel: str, output: Path, bins: int = 18) -> None:
    fig, ax = plt.subplots(figsize=(9.6, 5.4), dpi=160)
    ax.hist(series.dropna(), bins=bins, color="#0072b2", edgecolor="white")
    ax.set_title(title, fontsize=16, pad=14)
    ax.set_xlabel(xlabel)
    ax.set_ylabel("Count")
    ax.grid(axis="y", color="#d9dee7", linewidth=0.8)
    ax.set_axisbelow(True)
    fig.tight_layout()
    fig.savefig(output, bbox_inches="tight")
    plt.close(fig)


def distance_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius = 6371000.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def candidate_spacing_count(candidates: pd.DataFrame, min_spacing_m: float = 3000.0) -> tuple[int, int]:
    selected: list[dict[str, object]] = []
    deployable = candidates[bool_series(candidates["is_deployable"])].sort_values("score", ascending=False)
    for row in deployable.to_dict("records"):
        lon = float(row["lon"])
        lat = float(row["lat"])
        if all(distance_m(lon, lat, float(other["lon"]), float(other["lat"])) >= min_spacing_m for other in selected):
            selected.append(row)
    return len(selected), len(deployable) - len(selected)


def generate_figures(data: dict[str, object]) -> dict[str, object]:
    nodes = data["nodes"]
    candidates = data["candidate_sites"]
    links = data["topology_links"]
    freqs = data["frequency_resources"]
    fault_cases = data["fault_cases"]
    fault_rules = data["fault_rules"]
    conflicts = data["frequency_conflicts"]

    FIGURES.mkdir(parents=True, exist_ok=True)

    node_counts = nodes["device_class"].value_counts()
    save_bar(node_counts, "Node Count by Device Class", "Device Class", "Count", FIGURES / "node_type_count.png")

    deployable_counts = bool_series(candidates["is_deployable"]).map({True: "Deployable", False: "Rejected"}).value_counts()
    save_bar(deployable_counts, "Candidate Site Screening Result", "Result", "Count", FIGURES / "candidate_site_result.png")

    final_deployable, spacing_filtered = candidate_spacing_count(candidates)
    funnel_counts = pd.Series(
        {
            "Total candidates": len(candidates),
            "Raw deployable": int(bool_series(candidates["is_deployable"]).sum()),
            "After spacing": final_deployable,
        }
    )
    save_bar(funnel_counts, "Candidate Site Algorithm Screening Funnel", "Stage", "Count", FIGURES / "candidate_site_algorithm_funnel.png")

    rejection_reasons = save_candidate_reason_chart(candidates, FIGURES / "candidate_reject_reasons.png")

    link_counts = links["device_class"].value_counts()
    save_bar(link_counts, "Topology Link Count by Device Class", "Device Class", "Count", FIGURES / "link_type_count.png")

    freq_counts = freqs["device_class"].value_counts()
    save_bar(freq_counts, "Frequency Resource Count by Device Class", "Device Class", "Count", FIGURES / "frequency_resource_count.png")

    fault_case_counts = fault_cases["fault_type"].value_counts()
    save_bar(fault_case_counts, "Fault Case Count by Type", "Fault Type", "Count", FIGURES / "fault_case_count.png")

    fault_rule_counts = fault_rules["fault_type"].value_counts()
    save_bar(fault_rule_counts, "Fault Rule Count by Type", "Fault Type", "Count", FIGURES / "fault_rule_count.png")

    conflict_counts = conflicts["conflict_type"].value_counts().head(8)
    save_bar(conflict_counts, "Frequency Conflict Constraint Types", "Conflict Type", "Count", FIGURES / "frequency_conflict_type_count.png")

    save_hist(links["link_margin_db"], "Topology Link Margin Distribution", "Link Margin (dB)", FIGURES / "link_margin_distribution.png")

    return {
        "node_counts": node_counts.astype(int).to_dict(),
        "candidate_result_counts": deployable_counts.astype(int).to_dict(),
        "candidate_algorithm_funnel": {
            "total_candidates": int(len(candidates)),
            "raw_deployable": int(bool_series(candidates["is_deployable"]).sum()),
            "spacing_filtered": int(spacing_filtered),
            "after_spacing": int(final_deployable),
        },
        "candidate_rejection_reasons": dict(rejection_reasons),
        "link_counts": link_counts.astype(int).to_dict(),
        "frequency_counts": freq_counts.astype(int).to_dict(),
        "fault_case_counts": fault_case_counts.astype(int).to_dict(),
        "fault_rule_counts": fault_rule_counts.astype(int).to_dict(),
        "frequency_conflict_counts": conflict_counts.astype(int).to_dict(),
    }


def svg_projector(points: list[tuple[float, float]], width: int = 1180, height: int = 760):
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    min_lon, max_lon = min(lons), max(lons)
    min_lat, max_lat = min(lats), max(lats)
    pad = 44

    def project(lon: float, lat: float) -> tuple[float, float]:
        x = pad + (lon - min_lon) / max(max_lon - min_lon, 1e-9) * (width - pad * 2)
        y = height - pad - (lat - min_lat) / max(max_lat - min_lat, 1e-9) * (height - pad * 2)
        return x, y

    bounds = {
        "min_lon": min_lon,
        "max_lon": max_lon,
        "min_lat": min_lat,
        "max_lat": max_lat,
        "width": width,
        "height": height,
    }
    return project, bounds


def save_spatial_figures(data: dict[str, object]) -> dict[str, int]:
    nodes = data["nodes"]
    candidates = data["candidate_sites"]
    links = data["topology_links"]
    interferences = data["interference_sources"]
    routes = data["routes"]

    node_lookup = nodes.set_index("node_id")[["lon", "lat", "device_class"]].to_dict("index")

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    hf = nodes[nodes["device_class"] == "HF"]
    vuhf = nodes[nodes["device_class"] == "VUHF"]
    ok = candidates[bool_series(candidates["is_deployable"])]
    bad = candidates[~bool_series(candidates["is_deployable"])]
    ax.scatter(ok["lon"], ok["lat"], s=18, c=COLORS["candidate_ok"], label="Deployable site", alpha=0.85)
    ax.scatter(bad["lon"], bad["lat"], s=18, c=COLORS["candidate_bad"], label="Rejected site", alpha=0.85)
    ax.scatter(vuhf["lon"], vuhf["lat"], s=22, c=COLORS["vuhf"], label="VUHF node", edgecolors="white", linewidths=0.35)
    ax.scatter(hf["lon"], hf["lat"], s=32, c=COLORS["hf"], label="HF node", edgecolors="white", linewidths=0.45)
    ax.scatter(interferences["lon"], interferences["lat"], s=110, facecolors="none", edgecolors=COLORS["interference"], label="Interference")
    ax.set_title("Spatial Distribution of Nodes and Candidate Sites", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.grid(color="#d9dee7", linewidth=0.8)
    ax.legend(loc="upper right", frameon=True)
    fig.tight_layout()
    fig.savefig(FIGURES / "spatial_nodes_candidates.png", bbox_inches="tight")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    for row in links.to_dict("records"):
        a = node_lookup.get(row["node_a_id"])
        b = node_lookup.get(row["node_b_id"])
        if not a or not b:
            continue
        color = COLORS["hf"] if row["device_class"] == "HF" else "#8d99a8"
        ax.plot([a["lon"], b["lon"]], [a["lat"], b["lat"]], color=color, linewidth=0.55, alpha=0.22)
    ax.scatter(vuhf["lon"], vuhf["lat"], s=12, c=COLORS["vuhf"], label="VUHF node")
    ax.scatter(hf["lon"], hf["lat"], s=18, c=COLORS["hf"], label="HF node")
    ax.set_title("Topology Link Density", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.grid(color="#d9dee7", linewidth=0.8)
    ax.legend(loc="upper right", frameon=True)
    fig.tight_layout()
    fig.savefig(FIGURES / "topology_density_map.png", bbox_inches="tight")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    sampled_routes = route_sample(routes, limit_demands=6)
    for route in sampled_routes:
        points = [node_lookup[nid] for nid in route.get("node_path", []) if nid in node_lookup]
        if len(points) < 2:
            continue
        is_primary = route.get("route_type") == "PRIMARY"
        ax.plot(
            [p["lon"] for p in points],
            [p["lat"] for p in points],
            color=COLORS["route_primary"] if is_primary else COLORS["route_backup"],
            linewidth=2.3 if is_primary else 1.8,
            alpha=0.82,
            linestyle="-" if is_primary else "--",
        )
    ax.scatter(nodes["lon"], nodes["lat"], s=14, c="#6b7280", alpha=0.72)
    ax.set_title("Primary and Backup Route Samples", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.grid(color="#d9dee7", linewidth=0.8)
    ax.plot([], [], color=COLORS["route_primary"], linewidth=2.3, label="Primary route")
    ax.plot([], [], color=COLORS["route_backup"], linewidth=1.8, linestyle="--", label="Backup route")
    ax.legend(loc="upper right", frameon=True)
    fig.tight_layout()
    fig.savefig(FIGURES / "route_sample_map.png", bbox_inches="tight")
    plt.close(fig)
    return {"route_sample_count": len(sampled_routes)}


def raster_extent(dataset) -> tuple[float, float, float, float]:
    bounds = dataset.bounds
    return bounds.left, bounds.right, bounds.bottom, bounds.top


def read_raster_sample(path: Path, max_size: int = 1400):
    import rasterio
    from rasterio.enums import Resampling

    with rasterio.open(path) as dataset:
        scale = max(dataset.width / max_size, dataset.height / max_size, 1)
        out_width = max(1, int(dataset.width / scale))
        out_height = max(1, int(dataset.height / scale))
        resampling = Resampling.nearest if dataset.dtypes[0].startswith("uint") else Resampling.bilinear
        arr = dataset.read(1, out_shape=(out_height, out_width), resampling=resampling)
        arr = arr.astype("float32")
        nodata = dataset.nodata
        if nodata is not None:
            arr[arr == nodata] = np.nan
        return arr, raster_extent(dataset)


def plot_overlay_points(ax, nodes: pd.DataFrame, candidates: pd.DataFrame, light: bool = False) -> None:
    ok = candidates[bool_series(candidates["is_deployable"])]
    bad = candidates[~bool_series(candidates["is_deployable"])]
    hf = nodes[nodes["device_class"] == "HF"]
    vuhf = nodes[nodes["device_class"] == "VUHF"]
    edge = "#ffffff" if not light else "#263244"
    ax.scatter(ok["lon"], ok["lat"], s=18, c=COLORS["candidate_ok"], label="Deployable site", alpha=0.9, edgecolors=edge, linewidths=0.25)
    ax.scatter(bad["lon"], bad["lat"], s=18, c=COLORS["candidate_bad"], label="Rejected site", alpha=0.9, edgecolors=edge, linewidths=0.25)
    ax.scatter(vuhf["lon"], vuhf["lat"], s=14, c=COLORS["vuhf"], label="VUHF node", alpha=0.9, edgecolors=edge, linewidths=0.2)
    ax.scatter(hf["lon"], hf["lat"], s=24, c=COLORS["hf"], label="HF node", alpha=0.92, edgecolors=edge, linewidths=0.25)


def generate_terrain_figures(data: dict[str, object]) -> dict[str, object]:
    nodes = data["nodes"]
    candidates = data["candidate_sites"]
    dem_path = PATHS["dem"]
    landcover_path = PATHS["landcover"]
    if not dem_path.exists() or not landcover_path.exists():
        return {"terrain_available": False}

    dem, extent = read_raster_sample(dem_path)
    landcover, landcover_extent = read_raster_sample(landcover_path)

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    image = ax.imshow(dem, extent=extent, origin="upper", cmap="terrain")
    ax.set_title("Terrain Elevation Overview", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    cbar = fig.colorbar(image, ax=ax, fraction=0.03, pad=0.02)
    cbar.set_label("Elevation (m)")
    fig.tight_layout()
    fig.savefig(FIGURES / "terrain_elevation_overview.png", bbox_inches="tight")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    image = ax.imshow(dem, extent=extent, origin="upper", cmap="terrain", alpha=0.92)
    plot_overlay_points(ax, nodes, candidates)
    ax.set_title("Terrain Elevation with Nodes and Candidate Sites", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.legend(loc="upper right", frameon=True)
    cbar = fig.colorbar(image, ax=ax, fraction=0.03, pad=0.02)
    cbar.set_label("Elevation (m)")
    fig.tight_layout()
    fig.savefig(FIGURES / "terrain_candidate_overlay.png", bbox_inches="tight")
    plt.close(fig)

    lat_mid = (extent[2] + extent[3]) / 2
    meters_per_deg_lon = 111320 * math.cos(math.radians(lat_mid))
    meters_per_deg_lat = 110540
    pixel_size_x_m = (extent[1] - extent[0]) * meters_per_deg_lon / dem.shape[1]
    pixel_size_y_m = (extent[3] - extent[2]) * meters_per_deg_lat / dem.shape[0]
    grad_y, grad_x = np.gradient(dem, pixel_size_y_m, pixel_size_x_m)
    slope_deg = np.degrees(np.arctan(np.sqrt(grad_x**2 + grad_y**2)))
    slope_deg = np.clip(slope_deg, 0, 45)

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    image = ax.imshow(slope_deg, extent=extent, origin="upper", cmap="YlOrRd", vmin=0, vmax=35)
    rejected_by_slope = candidates[candidates["reject_reason"].fillna("").str.contains("坡度", regex=False)]
    ax.scatter(candidates["lon"], candidates["lat"], s=12, c="#4b5563", alpha=0.45, label="Candidate site")
    ax.scatter(rejected_by_slope["lon"], rejected_by_slope["lat"], s=32, c=COLORS["candidate_bad"], edgecolors="white", linewidths=0.4, label="Rejected by slope")
    ax.set_title("Slope Constraint and Candidate Rejections", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.legend(loc="upper right", frameon=True)
    cbar = fig.colorbar(image, ax=ax, fraction=0.03, pad=0.02)
    cbar.set_label("Slope (degree)")
    fig.tight_layout()
    fig.savefig(FIGURES / "slope_candidate_rejection.png", bbox_inches="tight")
    plt.close(fig)

    landcover_codes = [10, 20, 30, 40, 50, 60, 80, 90]
    landcover_labels = {
        10: "Cropland",
        20: "Forest",
        30: "Grassland",
        40: "Shrubland",
        50: "Wetland",
        60: "Water",
        80: "Built-up",
        90: "Bareland",
    }
    landcover_colors = ["#d8b365", "#1b7837", "#7fbf7b", "#a6d96a", "#80cdc1", "#2b83ba", "#b2182b", "#c2a5cf"]
    cmap = ListedColormap(landcover_colors)
    bounds = [5, 15, 25, 35, 45, 55, 70, 85, 95]
    norm = BoundaryNorm(bounds, cmap.N)

    fig, ax = plt.subplots(figsize=(10.8, 6.4), dpi=160)
    image = ax.imshow(landcover, extent=landcover_extent, origin="upper", cmap=cmap, norm=norm, alpha=0.82)
    plot_overlay_points(ax, nodes, candidates, light=True)
    ax.set_title("Landcover with Nodes and Candidate Sites", fontsize=15, pad=12)
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.legend(loc="upper right", frameon=True)
    cbar = fig.colorbar(image, ax=ax, fraction=0.03, pad=0.02, ticks=landcover_codes)
    cbar.ax.set_yticklabels([landcover_labels.get(code, str(code)) for code in landcover_codes])
    fig.tight_layout()
    fig.savefig(FIGURES / "landcover_candidate_overlay.png", bbox_inches="tight")
    plt.close(fig)

    elevation_stats = {
        "min_m": float(np.nanmin(dem)),
        "mean_m": float(np.nanmean(dem)),
        "max_m": float(np.nanmax(dem)),
    }
    candidate_elevation_stats = {
        "min_m": float(candidates["elevation_m"].min()),
        "mean_m": float(candidates["elevation_m"].mean()),
        "max_m": float(candidates["elevation_m"].max()),
    }
    return {
        "terrain_available": True,
        "dem_extent": {"left": extent[0], "right": extent[1], "bottom": extent[2], "top": extent[3]},
        "dem_sample_shape": list(dem.shape),
        "landcover_sample_shape": list(landcover.shape),
        "elevation_stats": elevation_stats,
        "candidate_elevation_stats": candidate_elevation_stats,
    }


def route_sample(routes: list[dict[str, object]], limit_demands: int = 8) -> list[dict[str, object]]:
    by_demand: defaultdict[str, list[dict[str, object]]] = defaultdict(list)
    for route in routes:
        if route.get("is_feasible") is True:
            by_demand[str(route.get("demand_id", ""))].append(route)
    selected = []
    for demand_id in sorted(by_demand.keys())[:limit_demands]:
        selected.extend(sorted(by_demand[demand_id], key=lambda item: str(item.get("route_type", ""))))
    return selected


def svg_circle(cx: float, cy: float, r: float, color: str, klass: str, label: str, opacity: float = 0.92) -> str:
    return (
        f'<circle class="{klass}" cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" '
        f'fill="{color}" fill-opacity="{opacity}" stroke="#ffffff" stroke-width="1.2">'
        f"<title>{html.escape(label)}</title></circle>"
    )


def svg_line(x1: float, y1: float, x2: float, y2: float, color: str, klass: str, label: str, width: float, opacity: float) -> str:
    return (
        f'<line class="{klass}" x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
        f'stroke="{color}" stroke-width="{width:.1f}" stroke-opacity="{opacity}" stroke-linecap="round">'
        f"<title>{html.escape(label)}</title></line>"
    )


def svg_polyline(points: list[tuple[float, float]], color: str, klass: str, label: str, width: float, opacity: float, dash: str = "") -> str:
    point_text = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<polyline class="{klass}" points="{point_text}" fill="none" stroke="{color}" '
        f'stroke-width="{width:.1f}" stroke-opacity="{opacity}" stroke-linejoin="round" stroke-linecap="round"{dash_attr}>'
        f"<title>{html.escape(label)}</title></polyline>"
    )


def generate_map(data: dict[str, object], summary: dict[str, object]) -> dict[str, object]:
    nodes = data["nodes"]
    candidates = data["candidate_sites"]
    links = data["topology_links"]
    interferences = data["interference_sources"]
    routes = data["routes"]

    all_points = []
    for frame in (nodes, candidates, interferences):
        all_points.extend(list(zip(frame["lon"].astype(float), frame["lat"].astype(float))))
    project, bounds = svg_projector(all_points)

    node_xy = {}
    for row in nodes.to_dict("records"):
        x, y = project(float(row["lon"]), float(row["lat"]))
        node_xy[str(row["node_id"])] = (x, y)

    lines = []
    for row in links.to_dict("records"):
        a = node_xy.get(str(row["node_a_id"]))
        b = node_xy.get(str(row["node_b_id"]))
        if not a or not b:
            continue
        color = COLORS["hf"] if row["device_class"] == "HF" else COLORS["topology"]
        lines.append(
            svg_line(
                a[0],
                a[1],
                b[0],
                b[1],
                color,
                "layer-topology",
                f'{row["link_id"]}: {row["node_a_id"]} -> {row["node_b_id"]}, margin={row["link_margin_db"]} dB',
                1.2,
                0.22,
            )
        )

    route_lines = []
    for route in route_sample(routes):
        points = [node_xy[nid] for nid in route.get("node_path", []) if nid in node_xy]
        if len(points) < 2:
            continue
        is_primary = route.get("route_type") == "PRIMARY"
        route_lines.append(
            svg_polyline(
                points,
                COLORS["route_primary"] if is_primary else COLORS["route_backup"],
                "layer-routes",
                f'{route["route_id"]}: hops={route["hop_count"]}, reliability={route["estimated_reliability"]}',
                3.3 if is_primary else 2.5,
                0.72,
                "" if is_primary else "8 6",
            )
        )

    candidate_points = []
    for row in candidates.to_dict("records"):
        x, y = project(float(row["lon"]), float(row["lat"]))
        ok = str(row["is_deployable"]).lower() == "true"
        color = COLORS["candidate_ok"] if ok else COLORS["candidate_bad"]
        candidate_points.append(
            svg_circle(
                x,
                y,
                4.2 if ok else 3.6,
                color,
                "layer-candidates",
                f'{row["site_id"]}: deployable={row["is_deployable"]}, score={row["score"]}, reason={row.get("reject_reason", "")}',
                0.86,
            )
        )

    node_points = []
    for row in nodes.to_dict("records"):
        x, y = node_xy[str(row["node_id"])]
        is_hf = row["device_class"] == "HF"
        node_points.append(
            svg_circle(
                x,
                y,
                4.8 if is_hf else 3.8,
                COLORS["hf"] if is_hf else COLORS["vuhf"],
                "layer-nodes",
                f'{row["node_id"]}: {row["device_class"]}, role={row["node_role"]}, status={row["status"]}',
                0.95,
            )
        )

    interference_points = []
    for row in interferences.to_dict("records"):
        x, y = project(float(row["lon"]), float(row["lat"]))
        power = float(row["tx_power_dbm"])
        radius = max(12, min(40, power / 1.7))
        interference_points.append(
            f'<circle class="layer-interference" cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" '
            f'fill="{COLORS["interference"]}" fill-opacity="0.11" stroke="{COLORS["interference"]}" '
            f'stroke-width="1.3" stroke-opacity="0.72"><title>{html.escape(str(row["interference_id"]))}: '
            f'{row["interference_type"]}, {row["center_freq_khz"]} kHz, {row["tx_power_dbm"]} dBm</title></circle>'
        )

    html_text = build_html(
        bounds,
        "\n".join(lines),
        "\n".join(route_lines),
        "\n".join(candidate_points),
        "\n".join(node_points),
        "\n".join(interference_points),
        summary,
        route_count=len(route_lines),
    )
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "map_overview.html").write_text(html_text, encoding="utf-8")
    return {"route_polylines": len(route_lines), "topology_lines": len(lines)}


def build_html(
    bounds: dict[str, float],
    topology: str,
    routes: str,
    candidates: str,
    nodes: str,
    interferences: str,
    summary: dict[str, object],
    route_count: int,
) -> str:
    stats = [
        ("Nodes", sum(summary["node_counts"].values())),
        ("Candidate Sites", sum(summary["candidate_result_counts"].values())),
        ("Topology Links", sum(summary["link_counts"].values())),
        ("Routes Shown", route_count),
        ("Frequency Resources", sum(summary["frequency_counts"].values())),
        ("Fault Cases", sum(summary["fault_case_counts"].values())),
    ]
    stat_cards = "\n".join(f"<div><strong>{value}</strong><span>{label}</span></div>" for label, value in stats)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Planning Data Visualization Overview</title>
  <style>
    :root {{
      --bg: {COLORS["background"]};
      --ink: {COLORS["ink"]};
      --muted: #5f6b7a;
      --line: #d8dee8;
      --panel: #ffffff;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
    }}
    header {{
      padding: 22px 28px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }}
    h1 {{ margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }}
    p {{ margin: 0; color: var(--muted); line-height: 1.6; }}
    main {{ max-width: 1280px; margin: 0 auto; padding: 18px 24px 28px; }}
    .stats {{
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }}
    .stats div {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      min-width: 0;
    }}
    .stats strong {{ display: block; font-size: 24px; line-height: 1.1; }}
    .stats span {{ display: block; margin-top: 4px; color: var(--muted); font-size: 12px; }}
    .toolbar {{
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
    }}
    label {{ display: inline-flex; align-items: center; gap: 6px; color: #263244; font-size: 14px; }}
    input {{ accent-color: #0072b2; }}
    .map-wrap {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }}
    svg {{ display: block; width: 100%; height: auto; background: linear-gradient(180deg, #ffffff, #eef3f7); }}
    .grid-line {{ stroke: #d9e0ea; stroke-width: 1; }}
    .axis-label {{ fill: #667085; font-size: 12px; }}
    .legend {{ display: flex; flex-wrap: wrap; gap: 14px; padding: 12px 14px; border-top: 1px solid var(--line); }}
    .legend span {{ display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 13px; }}
    .swatch {{ width: 12px; height: 12px; border-radius: 50%; display: inline-block; }}
    .note {{ margin-top: 10px; font-size: 13px; color: var(--muted); }}
    @media (max-width: 860px) {{
      main {{ padding: 14px; }}
      .stats {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Planning Data Visualization Overview</h1>
    <p>Generated from current synthetic planning, topology, frequency, interference, and fault data. Hover map elements to inspect IDs and key metrics.</p>
  </header>
  <main>
    <section class="stats">{stat_cards}</section>
    <section class="toolbar" aria-label="Layer controls">
      <label><input type="checkbox" data-layer="layer-nodes" checked> Nodes</label>
      <label><input type="checkbox" data-layer="layer-candidates" checked> Candidate Sites</label>
      <label><input type="checkbox" data-layer="layer-topology"> Topology Links</label>
      <label><input type="checkbox" data-layer="layer-routes" checked> Route Samples</label>
      <label><input type="checkbox" data-layer="layer-interference" checked> Interference</label>
    </section>
    <section class="map-wrap">
      <svg viewBox="0 0 {int(bounds["width"])} {int(bounds["height"])}" role="img" aria-label="Coordinate overview of planning data">
        <rect x="0" y="0" width="{int(bounds["width"])}" height="{int(bounds["height"])}" fill="transparent"></rect>
        <line class="grid-line" x1="44" y1="44" x2="44" y2="{int(bounds["height"] - 44)}"></line>
        <line class="grid-line" x1="44" y1="{int(bounds["height"] - 44)}" x2="{int(bounds["width"] - 44)}" y2="{int(bounds["height"] - 44)}"></line>
        <text class="axis-label" x="52" y="30">lat {bounds["max_lat"]:.4f}</text>
        <text class="axis-label" x="52" y="{int(bounds["height"] - 18)}">lat {bounds["min_lat"]:.4f}</text>
        <text class="axis-label" x="44" y="{int(bounds["height"] - 8)}">lon {bounds["min_lon"]:.4f}</text>
        <text class="axis-label" x="{int(bounds["width"] - 150)}" y="{int(bounds["height"] - 8)}">lon {bounds["max_lon"]:.4f}</text>
        <g>{topology}</g>
        <g>{routes}</g>
        <g>{interferences}</g>
        <g>{candidates}</g>
        <g>{nodes}</g>
      </svg>
      <div class="legend">
        <span><i class="swatch" style="background:{COLORS["hf"]}"></i>HF node / link</span>
        <span><i class="swatch" style="background:{COLORS["vuhf"]}"></i>VUHF node</span>
        <span><i class="swatch" style="background:{COLORS["candidate_ok"]}"></i>Deployable site</span>
        <span><i class="swatch" style="background:{COLORS["candidate_bad"]}"></i>Rejected site</span>
        <span><i class="swatch" style="background:{COLORS["route_primary"]}"></i>Primary route</span>
        <span><i class="swatch" style="background:{COLORS["route_backup"]}"></i>Backup route</span>
        <span><i class="swatch" style="background:{COLORS["interference"]}"></i>Interference</span>
      </div>
    </section>
    <p class="note">This is an offline SVG coordinate overview, not an online tile map. Topology links are hidden by default because 500 links overlap heavily; enable that layer only when checking connectivity.</p>
  </main>
  <script>
    document.querySelectorAll("[data-layer]").forEach((checkbox) => {{
      const update = () => {{
        document.querySelectorAll("." + checkbox.dataset.layer).forEach((element) => {{
          element.style.display = checkbox.checked ? "" : "none";
        }});
      }};
      checkbox.addEventListener("change", update);
      update();
    }});
  </script>
</body>
</html>
"""


def write_summary(summary: dict[str, object], map_summary: dict[str, object]) -> None:
    payload = {
        "generated_files": {
            "map": "docs/visualization/map_overview.html",
            "figures": sorted(p.name for p in FIGURES.glob("*.png")),
        },
        "data_summary": summary,
        "map_summary": map_summary,
    }
    (OUT / "summary.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    FIGURES.mkdir(parents=True, exist_ok=True)
    data = load_data()
    summary = generate_figures(data)
    spatial_summary = save_spatial_figures(data)
    terrain_summary = generate_terrain_figures(data)
    map_summary = generate_map(data, summary)
    map_summary.update(spatial_summary)
    map_summary.update(terrain_summary)
    write_summary(summary, map_summary)
    print(f"Generated visualization artifacts in {OUT}")


if __name__ == "__main__":
    main()
