"""栅格 ↔ GeoJSON 的小工具（纯标准库）。

干扰影响区域、覆盖等值面都需要把「一片格子」交给前端画成多边形。
这里不做边界追踪（易错、代码长），而是把同一行里连续的格子并成一条矩形，
整片输出为一个 MultiPolygon——**几何上与格子并集完全等价**，GeoJSON 合法，
前端按普通多边形图层渲染即可。代价是顶点数比追踪边界多，60×60 量级无压力。
"""
import math

DEG_PER_M_LAT = 1.0 / 111320.0


def grid_spec(bbox, cell_m):
    """返回 (nx, ny, 每度经度米数)。bbox = (lon0, lat0, lon1, lat1)。"""
    lon0, lat0, lon1, lat1 = bbox
    m_per_deg_lon = 111320.0 * max(0.2, math.cos(math.radians((lat0 + lat1) / 2.0)))
    nx = max(1, int((lon1 - lon0) * m_per_deg_lon / cell_m))
    ny = max(1, int((lat1 - lat0) / DEG_PER_M_LAT / cell_m))
    return nx, ny, m_per_deg_lon


def cell_center(bbox, cell_m, gx, gy, m_per_deg_lon):
    lon0, lat0 = bbox[0], bbox[1]
    return (lon0 + (gx + 0.5) * cell_m / m_per_deg_lon,
            lat0 + (gy + 0.5) * cell_m * DEG_PER_M_LAT)


def cells_to_multipolygon(cells, bbox, cell_m, m_per_deg_lon=None):
    """格子集合 → GeoJSON MultiPolygon 几何。按行合并连续格子为矩形。"""
    if m_per_deg_lon is None:
        m_per_deg_lon = grid_spec(bbox, cell_m)[2]
    lon0, lat0 = bbox[0], bbox[1]
    dlon = cell_m / m_per_deg_lon
    dlat = cell_m * DEG_PER_M_LAT
    rows = {}
    for gx, gy in cells:
        rows.setdefault(gy, []).append(gx)
    polys = []
    for gy in sorted(rows):
        xs = sorted(rows[gy])
        start = prev = xs[0]
        for x in xs[1:] + [None]:
            if x is not None and x == prev + 1:
                prev = x
                continue
            w, e = lon0 + start * dlon, lon0 + (prev + 1) * dlon
            s_, n_ = lat0 + gy * dlat, lat0 + (gy + 1) * dlat
            ring = [[round(w, 6), round(s_, 6)], [round(e, 6), round(s_, 6)],
                    [round(e, 6), round(n_, 6)], [round(w, 6), round(n_, 6)],
                    [round(w, 6), round(s_, 6)]]
            polys.append([ring])
            if x is not None:
                start = prev = x
    return {"type": "MultiPolygon", "coordinates": polys}


def area_km2(cells, cell_m):
    return len(cells) * (cell_m / 1000.0) ** 2
