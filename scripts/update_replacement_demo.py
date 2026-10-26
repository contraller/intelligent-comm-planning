#!/usr/bin/env python3
"""导入 DEM、重建数据并执行算法；不再生成已归档的旧前端页面。"""
import base64
import io
import math
from pathlib import Path
import subprocess
import sys
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def terrain_color(t):
    stops = [(0, (35, 79, 56)), (.28, (87, 112, 68)), (.52, (133, 121, 82)),
             (.75, (151, 139, 112)), (1, (224, 226, 218))]
    for i in range(1, len(stops)):
        if t <= stops[i][0]:
            p0, c0 = stops[i - 1]
            p1, c1 = stops[i]
            f = (t - p0) / (p1 - p0)
            return tuple(round(a + (b - a) * f) for a, b in zip(c0, c1))
    return stops[-1][1]


def hillshade_data_uri(grid, extent, size):
    width, height = size
    lon0, lat0, lon1, lat1 = extent
    ml = 111320 * math.cos(math.radians((lat0 + lat1) / 2))
    dx = (lon1 - lon0) * ml / width
    dy = (lat1 - lat0) * 111320 / height
    vals = [[float(grid.sample(lon0 + (lon1 - lon0) * (x + .5) / width,
                               lat1 - (lat1 - lat0) * (y + .5) / height, 0))
             for x in range(width)] for y in range(height)]
    lo, hi = min(map(min, vals)), max(map(max, vals))
    pixels = bytearray()
    az, alt = math.radians(315), math.radians(42)
    for y in range(height):
        ym, yp = max(0, y - 1), min(height - 1, y + 1)
        for x in range(width):
            xm, xp = max(0, x - 1), min(width - 1, x + 1)
            dzdx = (vals[y][xp] - vals[y][xm]) / max(dx, (xp - xm) * dx)
            dzdy = (vals[ym][x] - vals[yp][x]) / max(dy, (yp - ym) * dy)
            slope, aspect = math.atan(math.hypot(dzdx, dzdy)), math.atan2(dzdy, -dzdx)
            light = math.sin(alt) * math.cos(slope) + math.cos(alt) * math.sin(slope) * math.cos(az - aspect)
            light = max(.30, min(1.18, .68 + .55 * light))
            pixels.extend(max(0, min(255, int(c * light))) for c in terrain_color((vals[y][x] - lo) / max(1, hi - lo)))
    buf = io.BytesIO()
    Image.frombytes('RGB', tuple(size), bytes(pixels)).save(buf, format='PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii'), [lo, hi]


def main():
    steps = ['prepare_replacement_dem.py', 'gen_test_data.py', 'gen_algorithm_design_data.py',
             'diagnosis/build_fault_graph.py', 'rerun_dem_algorithms.py']
    for script in steps:
        print('Running:', script, flush=True)
        subprocess.run([sys.executable, str(ROOT / 'scripts' / script)], cwd=ROOT, check=True)


if __name__ == '__main__':
    main()
