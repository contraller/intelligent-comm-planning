"""局地DEM覆盖预览：公里级预算与稀疏剖面，不替代精细传播或实测。

短波地波叠加单刃遮挡近似；天波保持电离层假设，仅检查收发端低仰角遮挡。
天波能够越山时不强行造山影。仅输出真实DEM范围内的格面，不把远域环带变形。
"""
import math

from . import coverage_field_surface as legacy
from .coverage_field_surface import field_strength, signal_values

VERSION = "V01-6"
PROFILE_SEGMENTS = 16


def _shadow(terrain, item, lon, lat, frequency, radio, options, sky_height_m, check):
    from propagation import knife_edge_loss_db
    profile = terrain.profile(item["lon"], item["lat"], lon, lat, n=PROFILE_SEGMENTS)
    distance = profile[-1][0]
    tx = profile[0][1] + radio["height"]
    rx = profile[-1][1] + options["rx_height_m"]
    # 仅在剖面可支持的尺度估计绕射；不凭随机扰动改变轮廓。
    slope = sky_height_m / max(1.0, distance / 2)
    ground_loss, sky_loss, ground_reference, sky_reference, clearance = 0.0, 0.0, 0.0, 0.0, math.inf
    for along, elevation in profile[1:-1]:
        check()
        other = distance - along
        earth = along * other / (2 * 6371008.8 * 4 / 3)
        straight = tx + (rx - tx) * along / distance - elevation - earth
        clearance = min(clearance, straight)
        ground_loss = max(ground_loss, knife_edge_loss_db(straight, frequency, along, other))
        incoming = min(tx + along * slope, rx + other * slope) - elevation - earth
        sky_loss = max(sky_loss, knife_edge_loss_db(incoming, frequency, min(along, other), sky_height_m))
        # P.368已含光滑地面损耗，只叠加超出收发端线性地面的遮挡增量，避免平地重复计损。
        reference = profile[0][1] + (profile[-1][1] - profile[0][1]) * along / distance
        clear_reference = tx + (rx - tx) * along / distance - reference - earth
        sky_clear_reference = min(tx + along * slope, rx + other * slope) - reference - earth
        ground_reference = max(ground_reference, knife_edge_loss_db(clear_reference, frequency, along, other))
        sky_reference = max(sky_reference, knife_edge_loss_db(sky_clear_reference, frequency, min(along, other), sky_height_m))
    return max(0.0, ground_loss - ground_reference), max(0.0, sky_loss - sky_reference), clearance


def _grid_budget(radius, cell, limit):
    count = math.ceil(radius / cell)
    if (2 * count + 1) ** 2 > limit:
        from .frozen_coverage_engine import FrozenCoverageError
        raise FrozenCoverageError("COVERAGE_LIMIT", "逐格覆盖超过本次剩余采样限额，请增大网格或减小半径")
    return count


def vuhf_surface(terrain, item, options, check, limit):
    """沿用地形传播预算，为本台所在格取近距代表采样，避免固定的空白方孔。"""
    from propagation import vuhf_path_loss
    cell, radius = options["cell_m"], options["radius_m"]
    _grid_budget(radius, cell, limit)
    result = legacy.vuhf_surface(terrain, item, options, check, limit)
    dx = cell / (111320 * math.cos(math.radians(item["lat"])))
    dy = cell / 111320
    lon, lat = item["lon"], item["lat"]
    west, south, east, north = terrain.bbox
    if not (west <= lon-dx/2 and lon+dx/2 < east and south < lat-dy/2 and lat+dy/2 <= north):
        return result
    check()
    radio, frequency = item["radio_parameters"], item["frequency"]
    sample_lon = lon + dx * min(0.25, radius / (2 * cell))
    loss, los, clearance, distance = vuhf_path_loss(terrain, (lon, lat), (sample_lon, lat),
        frequency, radio["height"], options["rx_height_m"])
    values = dict(gx=0, gy=0, los=los, clearance_m=clearance,
        **signal_values(radio, loss, frequency, "数据", options["margin_min_db"]))
    result["cells"].append(values)
    result["evaluated_samples"] += 1
    if values["is_coverage"]:
        ring = [[lon-dx/2, lat-dy/2], [lon+dx/2, lat-dy/2], [lon+dx/2, lat+dy/2],
                [lon-dx/2, lat+dy/2], [lon-dx/2, lat-dy/2]]
        result["geojson"]["features"].append(legacy._feature(item,
            dict(type="Polygon", coordinates=[ring]), dict(freq_khz=frequency,
            surface_kind="TERRAIN_CELL", **values)))
    return result


def hf_surface(terrain, item, options, check, circle, limit=250000):
    """返回有地形凹凸的局地格面，保留旧径向预算供跳距解释与历史对照。"""
    from propagation import hf_ground_wave_loss
    from terrain import haversine_m
    from prop import p533

    radio, frequency = item["radio_parameters"], item["frequency"]
    cell = options["cell_m"]
    radius = min(options["radius_m"], options["hf_max_km"] * 1000)
    count = _grid_budget(radius, cell, limit)
    # 径向预算不直接绘图；新格面与旧缓存用不同版本身份保存。
    radial = legacy.hf_surface(terrain, item, options, check, circle)
    dx = cell / (111320 * math.cos(math.radians(item["lat"])))
    dy = cell / 111320
    west, south, east, north = terrain.bbox
    station_lc = terrain.landcover(item["lon"], item["lat"])
    default_height = float(p533.ionosphere(options["hour"])["h"]) * 1000
    sky_cache, ground_cache = {}, {}
    cells, features = [], []
    for gx in range(-count, count + 1):
        for gy in range(-count, count + 1):
            check()
            lon, lat = item["lon"] + gx * dx, item["lat"] + gy * dy
            if not (west <= lon - dx / 2 and lon + dx / 2 < east
                    and south < lat - dy / 2 and lat + dy / 2 <= north):
                continue
            distance = haversine_m(item["lon"], item["lat"], lon, lat)
            if distance > radius:
                continue
            # 本台所在格改用格内近距代表点；不把零距离公式的缺口画成传播盲区。
            sample_lon = lon + dx * min(0.25, radius / (2 * cell)) if distance < 1 else lon
            sample_distance = haversine_m(item["lon"], item["lat"], sample_lon, lat)
            # 以网格尺度缓存距离预算，DEM遮挡仍逐格计算，避免全网重复精算。
            budget_distance = max(min(cell / 2, radius / 2), round(sample_distance / cell) * cell)
            lc = terrain.landcover(lon, lat)
            ground_key = (budget_distance, lc)
            if ground_key not in ground_cache:
                ground_cache[ground_key] = max(hf_ground_wave_loss(frequency, budget_distance, station_lc),
                                              hf_ground_wave_loss(frequency, budget_distance, lc))
            if budget_distance not in sky_cache:
                sky_cache[budget_distance] = p533.path_loss(budget_distance, frequency, options["hour"],
                                                           lat_deg=item["lat"], hops=1)
            sky, detail = sky_cache[budget_distance]
            height = float(detail["h_km"]) * 1000 if "h_km" in detail else default_height
            ground_shadow, sky_shadow, clearance = _shadow(terrain, item, sample_lon, lat, frequency,
                                                           radio, options, height, check)
            ground = ground_cache[ground_key] + ground_shadow
            sky_total = sky + sky_shadow
            mode, loss, shadow = ("GROUND", ground, ground_shadow) if ground <= sky_total else ("SKYWAVE", sky_total, sky_shadow)
            values = dict(gx=gx, gy=gy, propagation_mode=mode, terrain_loss_db=shadow,
                          clearance_m=clearance, los=clearance >= 0,
                          **signal_values(radio, loss, frequency, "话音", options["margin_min_db"]))
            cells.append(values)
            if not values["is_coverage"]:
                continue
            ring = [[lon-dx/2, lat-dy/2], [lon+dx/2, lat-dy/2], [lon+dx/2, lat+dy/2],
                    [lon-dx/2, lat+dy/2], [lon-dx/2, lat-dy/2]]
            features.append(dict(type="Feature", geometry=dict(type="Polygon", coordinates=[ring]),
                properties=dict(device_id=item["device_id"], node_id=item["node_id"], freq_khz=frequency,
                                surface_kind="TERRAIN_CELL", **values)))
    return dict(shape="CELLS", origin=[item["lon"], item["lat"]], cell_m=cell, radius_m=radius,
                cells=cells, rings=radial["rings"], radial_samples=radial["radial_samples"],
                skip_distance_m=radial["skip_distance_m"], max_distance_m=radial["max_distance_m"],
                evaluated_samples=len(cells), profile_segments=PROFILE_SEGMENTS,
                geojson=dict(type="FeatureCollection", features=features))


def metadata():
    result = legacy.metadata()
    result.update(hf_geometry="P368_P533_LOCAL_TERRAIN_GRID",
                  grading_note="预测场强；HF局地DEM稀疏剖面遮挡近似，VUHF逐格地形预算；10/20dB为显示分级，非实测")
    return result
