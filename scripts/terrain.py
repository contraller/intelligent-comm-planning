"""地形与地物查询。

默认使用真实数据（`data/raw/dem/` 与 `data/raw/landcover/` 下的网格，
由 scripts/prepare_geodata.py 从导入批次生成），纯标准库读取。
真实数据缺失时自动回退到合成地形，便于在没有数据的环境里跑通流程。

对外接口（规划、传播、故障诊断等模块依赖，改动需同步调用方）：
    elevation(lon, lat)      -> 高程（米）
    slope_deg(lon, lat)      -> 坡度（度）
    landcover(lon, lat)      -> 地物名（中文，取值见 _LC_NAME）
    profile(lon1, lat1, lon2, lat2, n) -> [(距离m, 高程m), ...]
    haversine_m(...)         模块级函数
    los_clearance(...)       模块级函数
"""
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "geo"))

# 规划区（2026-09-16 西移）。
# 原框 (114.2724, 36.7610, 115.6276, 37.8390) 实测几乎全为平原：
# 高程中位 35 m、坡度 >15° 仅占 0.7%，太行山主脊全部落在其西侧的缓冲带内。
# 西移 20 km 后纳入山地，高程 16–1616 m、坡度 >15° 占 8.7%，
# 且高程 ≥300 m 的可部署点位由 54 个增至 1629 个。
BBOX = (114.0465, 36.9110, 115.4045, 37.9890)

# DEM 与地物栅格的实际覆盖范围。规划区西边界与之重合，西侧无缓冲。
BBOX_DATA = (114.0465, 36.5815, 115.8532, 38.0187)
BBOX_BUF = BBOX_DATA                      # 兼容旧名

DEM_HEADER = os.path.join(_HERE, "..", "data", "raw", "dem", "dem_taihang.json")
LC_HEADER = os.path.join(_HERE, "..", "data", "raw", "landcover", "landcover_taihang.json")

# 真实地物编码 -> 传播模型使用的地物名。
# 传播模型（propagation.py）的损耗表以「林地/草地/耕地/建成区/裸地/水域」为键，
# 此处做一次归并，使真实数据接入后 propagation.py 无需改动。
_LC_NAME = {10: "林地",    # 树木
            20: "草地",    # 灌木
            30: "草地",    # 草地
            40: "耕地",    # 农田
            50: "建成区",  # 建筑区
            60: "裸地",    # 裸地/稀疏植被
            70: "裸地",    # 积雪和冰
            80: "水域",    # 永久水体
            90: "水域",    # 草本湿地
            95: "林地",    # 红树林
            100: "裸地"}   # 苔藓和地衣


class DemTerrain:
    """基于真实 DEM 与地物栅格。"""
    name = "DEM"

    def __init__(self, dem_header=DEM_HEADER, lc_header=LC_HEADER):
        from grid import GridRaster
        self._dem = GridRaster(dem_header)
        self._lc = GridRaster(lc_header)
        self.bbox = tuple(self._dem.meta["bbox"])

    @staticmethod
    def _clamped(raster, lon, lat):
        """越界时取最近边缘像元，避免调用方处理 None。"""
        col = int((lon - raster.origin_lon) / raster.pixel_lon)
        row = int((raster.origin_lat - lat) / raster.pixel_lat)
        col = min(max(col, 0), raster.width - 1)
        row = min(max(row, 0), raster.height - 1)
        return raster.data[row * raster.width + col]

    def elevation(self, lon, lat):
        v = self._clamped(self._dem, lon, lat)
        nd = self._dem.nodata
        return 0.0 if (nd is not None and v == nd) else float(v)

    def slope_deg(self, lon, lat, step_m=90.0):
        dlat = step_m / 111320.0
        dlon = step_m / (111320.0 * math.cos(math.radians(lat)))
        dzdx = (self.elevation(lon + dlon, lat) - self.elevation(lon - dlon, lat)) / (2 * step_m)
        dzdy = (self.elevation(lon, lat + dlat) - self.elevation(lon, lat - dlat)) / (2 * step_m)
        return math.degrees(math.atan(math.hypot(dzdx, dzdy)))

    def landcover(self, lon, lat):
        return _LC_NAME.get(int(self._clamped(self._lc, lon, lat)), "裸地")

    def profile(self, lon1, lat1, lon2, lat2, n=64):
        d = haversine_m(lon1, lat1, lon2, lat2)
        return [(d * i / n,
                 self.elevation(lon1 + (lon2 - lon1) * i / n,
                                lat1 + (lat2 - lat1) * i / n))
                for i in range(n + 1)]


class SyntheticTerrain:
    """合成地形。真实数据缺失时的回退实现，也用于无数据环境下的冒烟测试。

    拟合太行山东麓的西高东低格局：绝对高程不真实，但大格局与高差量级一致。
    """
    name = "SYNTHETIC"
    SPAN_KM = 160.0

    def __init__(self, bbox=BBOX_DATA):
        self.lon0, self.lat0, self.lon1, self.lat1 = bbox
        self.bbox = bbox

    def elevation(self, lon, lat):
        t = (lon - self.lon0) / (self.lon1 - self.lon0)
        t = min(max(t, 0.0), 1.0)
        s = (lat - self.lat0) / (self.lat1 - self.lat0)
        x = t * self.SPAN_KM
        y = s * self.SPAN_KM
        TAU = 2.0 * math.pi
        base = 1650.0 * (1.0 - t) ** 2.2 + 45.0
        decay = 0.5 * (1.0 - math.tanh((t - 0.40) / 0.09))
        u1 = x * 0.94 + y * 0.34
        u2 = x * 0.87 - y * 0.49
        ridge = 380.0 * decay * math.sin(TAU * u1 / 9.0)
        ridge += 220.0 * decay * math.sin(TAU * u2 / 4.0)
        valley = 90.0 * decay * math.sin(TAU * (x * 0.7 + y * 0.72) / 1.8)
        micro = 5.0 * math.sin(TAU * (x + y * 1.3) / 1.6)
        return max(20.0, base + ridge + valley + micro)

    def slope_deg(self, lon, lat, step_m=90.0):
        dlat = step_m / 111320.0
        dlon = step_m / (111320.0 * math.cos(math.radians(lat)))
        dzdx = (self.elevation(lon + dlon, lat) - self.elevation(lon - dlon, lat)) / (2 * step_m)
        dzdy = (self.elevation(lon, lat + dlat) - self.elevation(lon, lat - dlat)) / (2 * step_m)
        return math.degrees(math.atan(math.hypot(dzdx, dzdy)))

    def landcover(self, lon, lat):
        e = self.elevation(lon, lat)
        sl = self.slope_deg(lon, lat)
        if e > 1100 and sl > 18:
            return "裸地"
        if e > 700:
            return "林地"
        if e > 300:
            return "草地"
        if abs(math.sin(31.0 * lon + 19.0 * lat)) > 0.985:
            return "水域"
        if abs(math.sin(13.0 * lon - 7.0 * lat)) > 0.95:
            return "建成区"
        return "耕地"

    def profile(self, lon1, lat1, lon2, lat2, n=64):
        d = haversine_m(lon1, lat1, lon2, lat2)
        return [(d * i / n,
                 self.elevation(lon1 + (lon2 - lon1) * i / n,
                                lat1 + (lat2 - lat1) * i / n))
                for i in range(n + 1)]


def default_terrain(verbose=True):
    """优先真实 DEM，缺失时回退合成地形。"""
    if os.path.exists(DEM_HEADER) and os.path.exists(LC_HEADER):
        return DemTerrain()
    if verbose:
        print("  警告：未找到 data/raw/dem 与 data/raw/landcover 网格，回退到合成地形。")
        print("        执行 python3 scripts/prepare_geodata.py 可从导入批次生成。")
    return SyntheticTerrain()


def haversine_m(lon1, lat1, lon2, lat2):
    R = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def los_clearance(terrain, lon1, lat1, h1, lon2, lat2, h2, k=4 / 3):
    """通视判断。返回 (是否通视, 最小余隙m, 最严重障碍处距离m)。

    计入地球等效曲率 (k=4/3) 与两端天线挂高。余隙为正表示视线高于地形。
    """
    d = haversine_m(lon1, lat1, lon2, lat2)
    if d < 1.0:
        return True, 999.0, 0.0
    Re = 6371008.8 * k
    e1 = terrain.elevation(lon1, lat1) + h1
    e2 = terrain.elevation(lon2, lat2) + h2
    worst, worst_at = 1e9, 0.0
    n = 48
    for i in range(1, n):
        f = i / n
        di = d * f
        ground = terrain.elevation(lon1 + (lon2 - lon1) * f, lat1 + (lat2 - lat1) * f)
        bulge = di * (d - di) / (2 * Re)
        sight = e1 + (e2 - e1) * f
        clr = sight - (ground + bulge)
        if clr < worst:
            worst, worst_at = clr, di
    return worst > 0, worst, worst_at
