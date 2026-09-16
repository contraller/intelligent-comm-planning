"""候选部署位置筛选（SR-4.2.1.1）。

需规主事件流要求「系统调用地形分析能力，**遍历规划区域**筛选符合条件的点位」，
因此按网格逐点扫描，而非抽样。流程分四步：

  1. 遍历网格，漏斗式施加约束（从廉价到昂贵，尽早短路）
  2. 点位优化处理：按最小站间距做贪心稀释，去除聚集冗余
  3. 打分与分级
  4. 统计筛除原因；候选过少时给出放宽建议（扩展事件流 1）

约束项与需规的对应：
    坡度 / 地物 / 交通可达性        —— 功能要求 a
    最小站间距 / 海拔范围 / 通视要求 —— 功能要求 b
    强制部署点 / 禁部署区           —— SR-4.2.1 扩展事件流 3
"""
import math

from terrain import haversine_m, los_clearance

# 不可部署的地物：水面与建成区无法停车架台
DEFAULT_FORBIDDEN_LANDCOVER = ("水域", "建成区")


class Constraints:
    """部署约束。取值为 None 表示该项不施加。"""

    def __init__(self, grid_step_m=500.0, max_slope_deg=15.0,
                 elevation_range_m=None, allowed_landcover=None,
                 forbidden_landcover=DEFAULT_FORBIDDEN_LANDCOVER,
                 road_max_distance_m=2000.0, min_site_spacing_m=3000.0,
                 los_required_node_ids=(), los_antenna_height_m=8.0,
                 max_sites=None):
        self.grid_step_m = grid_step_m
        self.max_slope_deg = max_slope_deg
        self.elevation_range_m = elevation_range_m
        self.allowed_landcover = tuple(allowed_landcover) if allowed_landcover else None
        self.forbidden_landcover = tuple(forbidden_landcover or ())
        self.road_max_distance_m = road_max_distance_m
        self.min_site_spacing_m = min_site_spacing_m
        self.los_required_node_ids = tuple(los_required_node_ids)
        self.los_antenna_height_m = los_antenna_height_m
        self.max_sites = max_sites


def score_site(elevation_m, slope_deg, road_distance_m, nearest_node_m):
    """候选点打分，0–100。各项权重在此集中定义，便于调整与解释。

    高程：视距随高程平方根增长，用 sqrt 形式给分，1600 m 封顶
    坡度：越平越好，架设与停放更稳
    距路：越近越好，车载站需要驶入
    与已有节点距离：太近则覆盖重叠、价值低；3 km 起计分，20 km 封顶
    """
    s = 0.0
    s += 34.0 * min(math.sqrt(max(elevation_m, 0.0) / 1600.0), 1.0)
    s += 26.0 * max(0.0, 1.0 - slope_deg / 25.0)
    s += 22.0 * max(0.0, 1.0 - road_distance_m / 3000.0)
    d = max(0.0, nearest_node_m - 3000.0)
    s += 18.0 * min(d / 17000.0, 1.0)
    return max(0.0, min(100.0, s))


def level_of(score):
    if score >= 70:
        return "A"
    if score >= 55:
        return "B"
    if score >= 40:
        return "C"
    return "D"


def _point_in_polygon(lon, lat, poly):
    """射线法。poly 为 [(lon, lat), ...]，首尾可不闭合。"""
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > lat) != (y2 > lat):
            xt = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < xt:
                inside = not inside
    return inside


def scan(terrain, road_field, bbox, nodes, constraints,
         forced_include=(), forced_exclude_polygons=(), progress=None):
    """遍历规划区域筛选候选点位。

    nodes: [{node_id, lon, lat, ...}]，用于最近节点距离与通视判定
    返回 (候选点列表, 筛除统计, 扫描格点总数)
    """
    c = constraints
    lon0, lat0, lon1, lat1 = bbox
    lat_mid = (lat0 + lat1) / 2.0
    dlon = c.grid_step_m / (111320.0 * math.cos(math.radians(lat_mid)))
    dlat = c.grid_step_m / 111320.0
    ncols = int((lon1 - lon0) / dlon) + 1
    nrows = int((lat1 - lat0) / dlat) + 1

    los_targets = [n for n in nodes if n["node_id"] in c.los_required_node_ids]
    reject = dict(elevation=0, slope=0, landcover=0, road=0,
                  exclude_zone=0, los=0, spacing=0)
    passed = []
    scanned = 0

    for r in range(nrows):
        lat = lat0 + r * dlat
        for k in range(ncols):
            lon = lon0 + k * dlon
            scanned += 1

            # —— 漏斗第 1 层：高程（1 次采样）——
            elev = terrain.elevation(lon, lat)
            if c.elevation_range_m:
                lo, hi = c.elevation_range_m
                if not (lo <= elev <= hi):
                    reject["elevation"] += 1
                    continue

            # —— 第 2 层：地物（1 次采样）——
            lc = terrain.landcover(lon, lat)
            if lc in c.forbidden_landcover:
                reject["landcover"] += 1
                continue
            if c.allowed_landcover and lc not in c.allowed_landcover:
                reject["landcover"] += 1
                continue

            # —— 第 3 层：交通可达性（查表 O(1)）——
            rd = road_field.distance_m(lon, lat)
            if rd is None:
                rd = float("inf")
                
            if c.road_max_distance_m is not None and rd > c.road_max_distance_m:
                reject["road"] += 1
                continue

            # —— 第 4 层：禁部署区 ——
            if any(_point_in_polygon(lon, lat, p) for p in forced_exclude_polygons):
                reject["exclude_zone"] += 1
                continue

            # —— 第 5 层：坡度（4 次采样）——
            slope = terrain.slope_deg(lon, lat)
            if c.max_slope_deg is not None and slope > c.max_slope_deg:
                reject["slope"] += 1
                continue

            # —— 第 6 层：通视（最贵，每个目标节点 48 次采样）——
            if los_targets:
                ok_all = True
                for t in los_targets:
                    vis, _, _ = los_clearance(terrain, lon, lat, c.los_antenna_height_m,
                                              float(t["lon"]), float(t["lat"]),
                                              c.los_antenna_height_m)
                    if not vis:
                        ok_all = False
                        break
                if not ok_all:
                    reject["los"] += 1
                    continue

            nearest = min((haversine_m(lon, lat, float(n["lon"]), float(n["lat"]))
                           for n in nodes), default=float("inf"))
            passed.append(dict(lon=round(lon, 6), lat=round(lat, 6),
                               elevation_m=round(elev, 1), slope_deg=round(slope, 2),
                               landcover_type=lc,
                               nearest_road_distance_m=round(rd, 1),
                               nearest_node_distance_m=round(nearest, 1),
                               score=round(score_site(elev, slope, rd, nearest), 2)))
        if progress and r % 20 == 0:
            progress(r / nrows)

    # —— 点位优化处理：按最小站间距贪心稀释，保留高分点 ——
    kept = thin_by_spacing(passed, c.min_site_spacing_m, lat_mid)
    reject["spacing"] = len(passed) - len(kept)

    # —— 强制部署点：无条件纳入，不参与稀释 ——
    for f in forced_include:
        lon, lat = float(f["lon"]), float(f["lat"])
        elev = terrain.elevation(lon, lat)
        slope = terrain.slope_deg(lon, lat)
        rd = road_field.distance_m(lon, lat)
        nearest = min((haversine_m(lon, lat, float(n["lon"]), float(n["lat"]))
                       for n in nodes), default=float("inf"))
        kept.insert(0, dict(lon=round(lon, 6), lat=round(lat, 6),
                            elevation_m=round(elev, 1), slope_deg=round(slope, 2),
                            landcover_type=terrain.landcover(lon, lat),
                            nearest_road_distance_m=round(rd or -1, 1),
                            nearest_node_distance_m=round(nearest, 1),
                            score=100.0, forced=True))

    kept.sort(key=lambda s: -s["score"])
    if c.max_sites:
        kept = kept[:c.max_sites]
    for i, s in enumerate(kept, 1):
        s["site_id"] = "CS-%04d" % i
        s["recommendation_level"] = level_of(s["score"])
    return kept, reject, scanned


def thin_by_spacing(sites, min_spacing_m, lat_mid):
    """贪心空间稀释：按分数从高到低取点，与已选点距离不足门限的丢弃。

    用网格桶做邻域查询，避免与全部已选点两两比距。
    """
    if not min_spacing_m or min_spacing_m <= 0:
        return list(sites)
    m_lon = 111320.0 * math.cos(math.radians(lat_mid))
    cell = min_spacing_m
    buckets = {}
    kept = []
    for s in sorted(sites, key=lambda x: -x["score"]):
        cx = int(s["lon"] * m_lon / cell)
        cy = int(s["lat"] * 111320.0 / cell)
        clash = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for o in buckets.get((cx + dx, cy + dy), ()):
                    if haversine_m(s["lon"], s["lat"], o["lon"], o["lat"]) < min_spacing_m:
                        clash = True
                        break
                if clash:
                    break
            if clash:
                break
        if not clash:
            kept.append(s)
            buckets.setdefault((cx, cy), []).append(s)
    return kept


def suggestions_for(reject, kept_count, constraints, min_expected=20):
    """候选点过少时，按筛除量最大的约束给出放宽建议（扩展事件流 1）。"""
    if kept_count >= min_expected:
        return []
    order = sorted(((v, k) for k, v in reject.items() if v > 0), reverse=True)
    names = {"elevation": ("海拔范围", "放宽 elevation_range_m"),
             "slope": ("坡度上限", "调高 max_slope_deg"),
             "landcover": ("地物类型", "增加 allowed_landcover 或减少禁用地物"),
             "road": ("交通可达性", "调高 road_max_distance_m"),
             "los": ("通视要求", "减少 los_required_node_ids"),
             "spacing": ("最小站间距", "调小 min_site_spacing_m"),
             "exclude_zone": ("禁部署区", "缩小 forced_exclude_polygons")}
    out = []
    for cnt, key in order[:3]:
        label, advice = names.get(key, (key, "放宽该约束"))
        out.append("%s筛除 %d 个点位，建议%s" % (label, cnt, advice))
    return out
