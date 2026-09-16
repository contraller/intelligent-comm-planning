"""距最近道路的距离场。

候选点筛选要判断「交通可达性」（SR-4.2.1.1 a），即每个点位到最近可通行道路的距离。
逐点去 76 万个道路点里找最近的代价太高，这里改为一次性预计算一张距离栅格：

  1. 把道路折线按栅格分辨率打点，落到布尔占位栅格上；
  2. 对占位栅格做精确欧氏距离变换（Felzenszwalb & Huttenlocher 的
     O(N) 一维抛物线下包络算法，逐列再逐行两遍）；
  3. 之后任意点的距路距离即为 O(1) 查表。

分辨率默认 250 m，最大定位误差约半个格对角线（≈177 m），
相对于 2000–3500 m 的可达性门限可以接受。
"""
import gzip
import json
import math
import os

INF = float("inf")


def _edt_1d(f):
    """一维平方距离变换。f 为各位置的初始平方代价，返回下包络。"""
    n = len(f)
    d = [0.0] * n
    v = [0] * n
    z = [0.0] * (n + 1)
    k = 0
    z[0], z[1] = -INF, INF
    for q in range(1, n):
        while True:
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2.0 * q - 2.0 * v[k])
            if s <= z[k] and k > 0:
                k -= 1
            else:
                break
        k += 1
        v[k] = q
        z[k] = s
        z[k + 1] = INF
    k = 0
    for q in range(n):
        while z[k + 1] < q:
            k += 1
        d[q] = (q - v[k]) ** 2 + f[v[k]]
    return d


class RoadDistanceField:
    """规划区内任意点到最近可通行道路的距离（米）。"""

    def __init__(self, geojson_path, bbox, cell_m=250.0, margin_m=5000.0):
        self.cell_m = cell_m
        lat_mid = (bbox[1] + bbox[3]) / 2.0
        self.m_per_deg_lat = 111320.0
        self.m_per_deg_lon = 111320.0 * math.cos(math.radians(lat_mid))
        # 向外留出余量，避免规划区边缘的点因框外道路未纳入而距离偏大
        dlon = margin_m / self.m_per_deg_lon
        dlat = margin_m / self.m_per_deg_lat
        self.lon0 = bbox[0] - dlon
        self.lat0 = bbox[1] - dlat
        self.lon1 = bbox[2] + dlon
        self.lat1 = bbox[3] + dlat
        self.width = int((self.lon1 - self.lon0) * self.m_per_deg_lon / cell_m) + 1
        self.height = int((self.lat1 - self.lat0) * self.m_per_deg_lat / cell_m) + 1

        occ = bytearray(self.width * self.height)
        self.segment_count = 0
        self.vertex_count = 0
        opener = gzip.open if geojson_path.endswith(".gz") else open
        with opener(geojson_path, "rb") as f:
            fc = json.loads(f.read().decode("utf-8"))
        for ft in fc["features"]:
            coords = ft["geometry"]["coordinates"]
            self.segment_count += 1
            prev = None
            for lon, lat in coords:
                self.vertex_count += 1
                cell = self._cell(lon, lat)
                if cell is not None:
                    occ[cell] = 1
                # 折线顶点间距可能大于栅格，按需插值补点，避免道路出现断点
                if prev is not None:
                    d = math.hypot((lon - prev[0]) * self.m_per_deg_lon,
                                   (lat - prev[1]) * self.m_per_deg_lat)
                    steps = int(d / cell_m)
                    if 1 < steps < 4000:
                        for i in range(1, steps):
                            t = i / steps
                            c = self._cell(prev[0] + (lon - prev[0]) * t,
                                           prev[1] + (lat - prev[1]) * t)
                            if c is not None:
                                occ[c] = 1
                prev = (lon, lat)
        self.occupied = sum(occ)
        self._dist = self._transform(occ)

    def _cell(self, lon, lat):
        col = int((lon - self.lon0) * self.m_per_deg_lon / self.cell_m)
        row = int((self.lat1 - lat) * self.m_per_deg_lat / self.cell_m)
        if 0 <= col < self.width and 0 <= row < self.height:
            return row * self.width + col
        return None

    def _transform(self, occ):
        W, H = self.width, self.height
        BIG = float(W * W + H * H) * 4.0
        # 逐列
        tmp = [0.0] * (W * H)
        for col in range(W):
            f = [0.0 if occ[r * W + col] else BIG for r in range(H)]
            d = _edt_1d(f)
            for r in range(H):
                tmp[r * W + col] = d[r]
        # 逐行
        out = [0.0] * (W * H)
        for r in range(H):
            base = r * W
            d = _edt_1d(tmp[base:base + W])
            for c in range(W):
                out[base + c] = d[c]
        return out

    def distance_m(self, lon, lat):
        """到最近道路的距离（米）。落在栅格外时返回 None。"""
        col = int((lon - self.lon0) * self.m_per_deg_lon / self.cell_m)
        row = int((self.lat1 - lat) * self.m_per_deg_lat / self.cell_m)
        if not (0 <= col < self.width and 0 <= row < self.height):
            return None
        return math.sqrt(self._dist[row * self.width + col]) * self.cell_m
