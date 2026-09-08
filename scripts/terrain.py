"""地形高程采样。

第 1 周：DEM 未到位，用合成地形（拟合太行山东麓的西高东低格局）。
第 2 周：DEM 到位后把 DemTerrain 接上，调用方代码不用改。
"""
import math

BBOX = (114.2724, 36.7610, 115.6276, 37.8390)          # 规划区
BBOX_BUF = (114.0466, 36.5814, 115.8534, 38.0186)      # 外扩 20km


class SyntheticTerrain:
    """合成地形：西侧太行山 1000-1800m，东侧华北平原 50-100m。

    仅用于第 1 周构造测试数据。它的绝对高程不真实，但西高东低的
    大格局、山脊走向和高差量级与实际区域一致，足以让部署规划、
    通视判断、遮挡计算跑出有区分度的结果。
    """
    name = "SYNTHETIC"

    def __init__(self, bbox=BBOX_BUF):
        self.lon0, self.lat0, self.lon1, self.lat1 = bbox

    # 区域跨度约 160 km x 160 km（外扩框），按公里参数化便于控制山脊间距
    SPAN_KM = 160.0

    def elevation(self, lon, lat):
        t = (lon - self.lon0) / (self.lon1 - self.lon0)      # 0 西 -> 1 东
        t = min(max(t, 0.0), 1.0)
        s = (lat - self.lat0) / (self.lat1 - self.lat0)
        x = t * self.SPAN_KM                                 # 东向公里
        y = s * self.SPAN_KM                                 # 北向公里
        TAU = 2.0 * math.pi

        # 主趋势：西侧山地 -> 东侧平原
        base = 1650.0 * (1.0 - t) ** 2.2 + 45.0
        # 山地起伏向东衰减：t<0.35 为山区，0.35-0.50 为山前过渡带，
        # t>0.55 起伏基本消失（华北平原实际高差 < 20 m）
        decay = 0.5 * (1.0 - math.tanh((t - 0.40) / 0.09))
        # 山脊 NNE-SSW 走向：脊线方向 = x 与 y 的线性组合
        u1 = x * 0.94 + y * 0.34
        u2 = x * 0.87 - y * 0.49
        ridge = 380.0 * decay * math.sin(TAU * u1 / 9.0)      # 主脊，间距 9 km
        ridge += 220.0 * decay * math.sin(TAU * u2 / 4.0)     # 次脊，间距 4 km
        valley = 90.0 * decay * math.sin(TAU * (x * 0.7 + y * 0.72) / 1.8)
        micro = 5.0 * math.sin(TAU * (x + y * 1.3) / 1.6)     # 平原微起伏
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
            return "山地岩石"
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
        """两点间地形剖面，返回 [(距离m, 高程m), ...]。"""
        d = haversine_m(lon1, lat1, lon2, lat2)
        out = []
        for i in range(n + 1):
            f = i / n
            out.append((d * f, self.elevation(lon1 + (lon2 - lon1) * f,
                                              lat1 + (lat2 - lat1) * f)))
        return out


class DemTerrain(SyntheticTerrain):
    """DEM 到位后用这个替换 SyntheticTerrain。

    需要 rasterio：
        self._src = rasterio.open('data/raw/terrain/dem_taihang.tif')
        def elevation(self, lon, lat):
            return next(self._src.sample([(lon, lat)]))[0]
    其余方法（slope_deg / profile / landcover）复用父类实现即可，
    landcover 换成读 data/raw/landcover/ 的栅格。
    """
    name = "DEM"


def haversine_m(lon1, lat1, lon2, lat2):
    R = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def los_clearance(terrain, lon1, lat1, h1, lon2, lat2, h2, k=4/3):
    """通视判断。返回 (是否通视, 最大余隙m, 最严重障碍处距离m)。

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
        lon = lon1 + (lon2 - lon1) * f
        lat = lat1 + (lat2 - lat1) * f
        ground = terrain.elevation(lon, lat)
        bulge = di * (d - di) / (2 * Re)          # 地球曲率隆起
        sight = e1 + (e2 - e1) * f
        clr = sight - (ground + bulge)
        if clr < worst:
            worst, worst_at = clr, di
    return worst > 0, worst, worst_at
