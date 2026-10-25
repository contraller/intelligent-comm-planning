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


def _on_ring(lon, lat, ring):
    for a, b in zip(ring, ring[1:] + ring[:1]):
        cross = (lon - a[0]) * (b[1] - a[1]) - (lat - a[1]) * (b[0] - a[0])
        if (abs(cross) <= 1e-12 and min(a[0], b[0]) - 1e-12 <= lon <= max(a[0], b[0]) + 1e-12
                and min(a[1], b[1]) - 1e-12 <= lat <= max(a[1], b[1]) + 1e-12):
            return True
    return False


def in_exclusion_polygon(lon, lat, polygon):
    """GeoJSON外环减内环；所有环的边界均属于禁部署边界。"""
    rings = polygon["coordinates"]
    if any(_on_ring(lon, lat, ring) for ring in rings):
        return True
    return (_point_in_polygon(lon, lat, rings[0])
            and not any(_point_in_polygon(lon, lat, ring) for ring in rings[1:]))


def validate_exclusion_polygon(polygon, checkpoint=None):
    """格式校验之外，拒绝自交、交叉内环和外部内环等歧义禁区。"""
    rings = polygon["coordinates"]
    segments = [(ri, index, a, b) for ri, ring in enumerate(rings)
                for index, (a, b) in enumerate(zip(ring, ring[1:]))]

    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    for pos, (ri, index, a, b) in enumerate(segments):
        if checkpoint:
            checkpoint()
        for rj, other, c, d in segments[:pos]:
            if checkpoint:
                checkpoint()
            if ri == rj and (abs(index - other) == 1 or {index, other} == {0, len(rings[ri]) - 2}):
                continue
            if (max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0])
                    or max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1])):
                continue
            if orient(a, b, c) * orient(a, b, d) <= 0 and orient(c, d, a) * orient(c, d, b) <= 0:
                raise ValueError("禁部署区存在自相交或相交坐标环，不能推定有效区域")
    for index, ring in enumerate(rings[1:], 1):
        if checkpoint:
            checkpoint()
        if not _point_in_polygon(*ring[0], rings[0]):
            raise ValueError("禁部署区内环不在外环内部")
        if any(_point_in_polygon(*ring[0], other) or _point_in_polygon(*other[0], ring)
               for other in rings[1:index]):
            raise ValueError("禁部署区内环嵌套，Polygon不能表达独立内部岛区")


def grid_layout(bbox, step_m):
    """只做规模计算，不生成格点或申请与格点数量相关的内存。"""
    west, south, east, north = bbox
    if not math.isfinite(step_m) or step_m <= 0:
        raise ValueError("候选网格间距必须是有限正数")
    dlon = step_m / (111320.0 * math.cos(math.radians((south + north) / 2)))
    dlat = step_m / 111320.0
    if dlon <= 0 or dlat <= 0:
        raise ValueError("候选网格间距过小，扫描规模不可表示")
    columns, rows = (east - west) / dlon, (north - south) / dlat
    if not math.isfinite(columns) or not math.isfinite(rows):
        raise ValueError("候选网格间距过小，扫描规模超出可计算上限")
    return int(columns) + 1, int(rows) + 1, dlon, dlat


def grid_points(bbox, step_m):
    """与原生scan保持同一网格定位；调用方逐点保留筛选证据。"""
    columns, rows, dlon, dlat = grid_layout(bbox, step_m)
    west, south, _east, _north = bbox
    for row in range(rows):
        for col in range(columns):
            yield west + col * dlon, south + row * dlat


POSITION_EPS_DEG = 1e-9


def same_position(lon_a, lat_a, lon_b, lat_b):
    return abs(float(lon_a) - float(lon_b)) <= POSITION_EPS_DEG and abs(float(lat_a) - float(lat_b)) <= POSITION_EPS_DEG


class PositionIndex:
    """按物理坐标查重，编号及站型不能把同一地点变成多个部署位置。"""
    def __init__(self, checkpoint=None):
        self.buckets = {}
        self.checkpoint = checkpoint

    @staticmethod
    def _key(lon, lat):
        return math.floor(float(lon) / POSITION_EPS_DEG), math.floor(float(lat) / POSITION_EPS_DEG)

    def find(self, lon, lat):
        x, y = self._key(lon, lat)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if self.checkpoint:
                    self.checkpoint()
                for a, b, value in self.buckets.get((x + dx, y + dy), ()):
                    if same_position(lon, lat, a, b):
                        return value
        return None

    def add(self, lon, lat, value):
        if self.checkpoint:
            self.checkpoint()
        self.buckets.setdefault(self._key(lon, lat), []).append((float(lon), float(lat), value))


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


def thin_by_spacing(sites, min_spacing_m, lat_mid, checkpoint=None):
    """贪心空间稀释：按分数从高到低取点，与已选点距离不足门限的丢弃。

    用网格桶做邻域查询，避免与全部已选点两两比距。
    """
    if checkpoint:
        checkpoint()
    if not min_spacing_m or min_spacing_m <= 0:
        result = list(sites)
        if checkpoint:
            checkpoint()
        return result
    m_lon = 111320.0 * math.cos(math.radians(lat_mid))
    cell = min_spacing_m
    buckets = {}
    kept = []
    for s in sorted(sites, key=lambda x: -x["score"]):
        if checkpoint:
            checkpoint()
        cx = int(s["lon"] * m_lon / cell)
        cy = int(s["lat"] * 111320.0 / cell)
        clash = False
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for o in buckets.get((cx + dx, cy + dy), ()):
                    if checkpoint:
                        checkpoint()
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
    if checkpoint:
        checkpoint()
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
