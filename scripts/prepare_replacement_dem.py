#!/usr/bin/env python3
"""Import the current DEM without changing its geographic coordinates.

由 `prepare_geodata.py` 调用；单独运行时只重新生成 DEM。
原始 GeoTIFF 来自本地导入批次 `data/imported/taihang_20261009/`（不进 git）。
"""
import array
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE / "geo"))
from tiff import Tiff


def convert(source, output, label=None):
    tif = Tiff(str(source))
    if tif.dtype not in ("int16", "float32") or tif.samples != 1:
        raise ValueError("Expected a single-band int16 or float32 DEM")
    keys = tif.tags.get(34735, ())
    if not any(tuple(keys[i:i + 4]) == (2048, 0, 1, 4326)
               for i in range(4, len(keys), 4)):
        raise ValueError("DEM must declare EPSG:4326")
    bbox = list(tif.bbox)
    lon = (bbox[0] + bbox[2]) / 2
    lat = (bbox[1] + bbox[3]) / 2
    dy = 60000 / 111320
    dx = 60000 / (111320 * math.cos(math.radians(lat)))
    planning = [lon - dx, lat - dy, lon + dx, lat + dy]
    if planning[0] < bbox[0] or planning[1] < bbox[1] or planning[2] > bbox[2] or planning[3] > bbox[3]:
        raise ValueError("DEM cannot contain the required 120 x 120 km rectangle")
    output.parent.mkdir(parents=True, exist_ok=True)
    low, high, missing = math.inf, -math.inf, 0
    code = "h" if tif.dtype == "int16" else "f"
    raw_bytes = 0
    temporary = Path(str(output) + ".bin.gz.tmp")
    with gzip.open(temporary, "wb", compresslevel=6) as dest:
        for raw in tif.rows():
            row = array.array(code)
            row.frombytes(raw)
            if (tif.bo == "<") != (sys.byteorder == "little"):
                row.byteswap()
            for v in row:
                if not math.isfinite(v) or v == tif.nodata:
                    missing += 1
                else:
                    low, high = min(low, v), max(high, v)
            if sys.byteorder != "little":
                row.byteswap()
            data = row.tobytes()
            dest.write(data)
            raw_bytes += len(data)
    if missing:
        raise ValueError("DEM contains %d missing pixels; fill explicitly before use" % missing)
    with source.open("rb") as f:
        sha = hashlib.sha256()
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha.update(chunk)
        digest = sha.hexdigest()
    meta = dict(name=output.name, crs="EPSG:4326", width=tif.width,
                height=tif.height, dtype=tif.dtype, byteorder="little",
                nodata=tif.nodata, origin_lon=tif.origin_lon,
                origin_lat=tif.origin_lat, pixel_lon=tif.pixel_lon,
                pixel_lat=tif.pixel_lat, row_direction="north_to_south",
                bbox=bbox, source_bbox=bbox, planning_bbox=planning,
                source=label or source.name, source_sha256=digest,
                elevation_min=low, elevation_max=high, nodata_count=missing,
                raw_bytes=raw_bytes, data_file=output.name + ".bin.gz",
                generated=dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                note="Native geographic coordinates; synthetic stations rebuilt inside planning_bbox.")
    tif.close()
    temporary.replace(str(output) + ".bin.gz")
    header = Path(str(output) + ".json.tmp")
    header.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    header.replace(str(output) + ".json")
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return meta


if __name__ == "__main__":
    convert(ROOT / "data/imported/taihang_20261009/raw/dem/dem_taihang.tif",
            ROOT / "data/raw/dem/dem_current",
            label="太行山东麓_20261009.zip / dem/dem_taihang.tif")
