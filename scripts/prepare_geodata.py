#!/usr/bin/env python3
"""把导入批次的原始地理数据转换成仓库内可用、且纯标准库可读的格式。

    python3 scripts/prepare_geodata.py

输入（本地归档，不进 git）：data/imported/data_zip_20260911/raw/
输出（进 git）：
    data/raw/dem/dem_taihang.json        + .bin.gz    高程网格
    data/raw/landcover/landcover_taihang.json + .bin.gz 地物网格（降采样到约 28 m）
    data/raw/landcover/landcover_legend.csv            地物编码对照
    data/raw/roads/roads_taihang.geojson.gz            道路（GBK 转 UTF-8）

为什么不直接提交原始文件：
    地物 GeoTIFF 未压缩 357 MB，道路 shapefile 合计 1.5 GB，均超 GitHub 100 MB 单文件限制；
    且 GeoTIFF / Shapefile 都需要 GDAL 系依赖才能读，与项目「只用标准库」的约束冲突。
    转换后的网格用 gzip + struct 即可读取，运行时零依赖。
"""
import csv, gzip, json, os, shutil, struct, sys, time, zlib
import datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "geo"))
from tiff import Tiff                     # noqa: E402
from shapefile import Shp, Dbf, clip_line  # noqa: E402

ROOT = os.path.normpath(os.path.join(HERE, ".."))
SRC = os.path.join(ROOT, "data", "imported", "data_zip_20260911", "raw")
OUT = os.path.join(ROOT, "data", "raw")

# 数据覆盖范围。以 terrain.BBOX_DATA 为唯一来源，避免与规划区常量各自漂移。
sys.path.insert(0, HERE)
from terrain import BBOX_DATA as BBOX_BUF  # noqa: E402
LANDCOVER_STEP = 3          # 10 m -> 约 28 m，与 DEM 的 30 m 量级对齐

STAMP = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")


def human(n):
    return "%.1f MB" % (n / 1048576.0) if n >= 1048576 else "%.0f KB" % (n / 1024.0)


def write_grid(out_base, data, meta):
    """落盘为 JSON 头 + gzip 原始网格。"""
    os.makedirs(os.path.dirname(out_base), exist_ok=True)
    binp = out_base + ".bin.gz"
    with gzip.open(binp, "wb", compresslevel=6) as f:
        f.write(data)
    meta["data_file"] = os.path.basename(binp)
    meta["raw_bytes"] = len(data)
    meta["generated"] = STAMP
    with open(out_base + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return os.path.getsize(binp)


def grid_meta(tif, width, height, step, name, source, note):
    return dict(
        name=name, crs="EPSG:4326",
        width=width, height=height,
        dtype=tif.dtype, byteorder="little",
        nodata=tif.nodata,
        origin_lon=tif.origin_lon, origin_lat=tif.origin_lat,
        pixel_lon=tif.pixel_lon * step, pixel_lat=tif.pixel_lat * step,
        row_direction="north_to_south",
        bbox=[tif.origin_lon, tif.origin_lat - height * tif.pixel_lat * step,
              tif.origin_lon + width * tif.pixel_lon * step, tif.origin_lat],
        source=source, note=note)


def convert_dem():
    src = os.path.join(SRC, "terrain", "dem_taihang.tif")
    print("[1/4] DEM")
    t0 = time.time()
    t = Tiff(src)
    buf = bytearray()
    for row in t.rows():
        buf += row
    t.close()
    vals = struct.unpack("<%dh" % (len(buf) // 2), bytes(buf))
    nd = int(t.nodata) if t.nodata is not None else None
    good = [v for v in vals if v != nd]
    meta = grid_meta(t, t.width, t.height, 1, "dem_taihang",
                     "data.zip / raw/terrain/dem_taihang.tif（30 m DEM，来源待确认）",
                     "由原始 LZW 分块 GeoTIFF 解码后平铺存储；"
                     "平铺 gzip 加载耗时 0.1 s，原 GeoTIFF 需 5.5 s 解码")
    meta["elevation_min"] = min(good)
    meta["elevation_max"] = max(good)
    meta["nodata_count"] = len(vals) - len(good)
    sz = write_grid(os.path.join(OUT, "dem", "dem_taihang"), bytes(buf), meta)
    print("      %d x %d int16   高程 %d ~ %d m   NoData %d" %
          (t.width, t.height, min(good), max(good), len(vals) - len(good)))
    print("      %s -> %s   %.1fs" % (human(os.path.getsize(src)), human(sz), time.time() - t0))
    return sz


def convert_landcover():
    src = os.path.join(SRC, "landcover", "landcover_taihang.tif")
    print("[2/4] 地物")
    t0 = time.time()
    t = Tiff(src)
    step = LANDCOVER_STEP
    out = bytearray()
    w = 0
    for row in t.rows(step=step):
        sub = row[::step]
        w = len(sub)
        out += sub
    h = len(out) // w
    t.close()
    import collections
    cnt = collections.Counter(out)
    meta = grid_meta(t, w, h, step, "landcover_taihang",
                     "data.zip / raw/landcover/landcover_taihang.tif（ESA WorldCover 量级 10 m，来源待确认）",
                     "原图 10 m 未压缩 357 MB；按 %d 倍最近邻降采样至约 28 m，"
                     "与 DEM 的 30 m 量级对齐后 gzip 存储" % step)
    meta["downsample_factor"] = step
    meta["class_histogram"] = {str(k): v for k, v in sorted(cnt.items())}
    sz = write_grid(os.path.join(OUT, "landcover", "landcover_taihang"), bytes(out), meta)
    print("      %d x %d uint8   %d 种地物码值" % (w, h, len(cnt)))
    print("      %s -> %s   %.1fs" % (human(os.path.getsize(src)), human(sz), time.time() - t0))
    lg = os.path.join(SRC, "landcover", "landcover_legend.csv")
    if os.path.exists(lg):
        os.makedirs(os.path.join(OUT, "landcover"), exist_ok=True)
        shutil.copy2(lg, os.path.join(OUT, "landcover", "landcover_legend.csv"))
        print("      地物编码对照表已复制")
    return sz


# 车辆可通行的道路等级；步道/自行车道/台阶不参与交通可达性判定
DRIVABLE = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
            "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
            "residential", "service", "living_street", "track", "road"}


def convert_roads():
    base = os.path.join(SRC, "road", "road_taihang", "road_taihang_bbox")
    print("[3/4] 道路")
    t0 = time.time()
    dbf = Dbf(base + ".dbf", encoding="gbk")    # .cpg 声明 GBK
    shp = Shp(base + ".shp")
    feats, kept, dropped_class, dropped_bbox = [], 0, 0, 0
    for idx, lines in shp:
        rec = dbf.record(idx)
        fclass = rec.get("fclass", "")
        if fclass not in DRIVABLE:
            dropped_class += 1
            continue
        parts = []
        for ln in lines:
            parts.extend(clip_line(ln, BBOX_BUF))
        if not parts:
            dropped_bbox += 1
            continue
        kept += 1
        props = {"fclass": fclass}
        name = rec.get("name", "")
        if name:
            props["name"] = name
        for ln in parts:
            coords = [[round(x, 6), round(y, 6)] for x, y in ln]
            feats.append({"type": "Feature", "properties": props,
                          "geometry": {"type": "LineString", "coordinates": coords}})
    shp.close(); dbf.close()
    fc = {"type": "FeatureCollection",
          "name": "roads_taihang",
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
          "properties": {
              "source": "data.zip / raw/road/road_taihang/road_taihang_bbox.shp（OpenStreetMap，ODbL 1.0）",
              "generated": STAMP,
              "bbox": list(BBOX_BUF),
              "note": "仅保留车辆可通行等级，属性精简为 fclass 与 name；"
                      "坐标保留 6 位小数；原 shapefile 属性为 GBK，已转 UTF-8"},
          "features": feats}
    os.makedirs(os.path.join(OUT, "roads"), exist_ok=True)
    p = os.path.join(OUT, "roads", "roads_taihang.geojson.gz")
    payload = json.dumps(fc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.open(p, "wb", compresslevel=6) as f:
        f.write(payload)
    sz = os.path.getsize(p)
    orig = sum(os.path.getsize(base + e) for e in (".shp", ".dbf", ".shx"))
    print("      保留 %d 条 / %d 段   非车行丢弃 %d   框外丢弃 %d" %
          (kept, len(feats), dropped_class, dropped_bbox))
    print("      %s -> %s (GeoJSON 明文 %s)   %.1fs" %
          (human(orig), human(sz), human(len(payload)), time.time() - t0))
    return sz


def copy_small_csv():
    print("[4/4] 小体量 CSV")
    jobs = [(os.path.join(SRC, "fault", "fault_case.csv"),
             os.path.join(OUT, "maintenance_docs", "fault_case_imported.csv")),
            (os.path.join(SRC, "docs", "index.csv"),
             os.path.join(OUT, "maintenance_docs", "docs_index.csv"))]
    total = 0
    for s, d in jobs:
        if not os.path.exists(s):
            print("      跳过（缺失）: %s" % os.path.basename(s)); continue
        os.makedirs(os.path.dirname(d), exist_ok=True)
        # 去掉 BOM，统一 UTF-8 无 BOM
        with open(s, "rb") as f:
            raw = f.read()
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        with open(d, "wb") as f:
            f.write(raw)
        total += len(raw)
        print("      %-28s %s" % (os.path.basename(d), human(len(raw))))
    return total


def main():
    if not os.path.isdir(SRC):
        print("找不到导入批次目录：%s" % SRC)
        print("请先解压 data/imported/data_zip_20260911/source/data.zip")
        return 1
    print("地理数据预处理  %s\n" % STAMP)
    total = convert_dem() + convert_landcover() + convert_roads() + copy_small_csv()
    print("\n进入仓库的总体积：%s" % human(total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
