# 太行山东麓_20261009 导入批次说明

入库日期：2026-10-12

## 目录

- `source/太行山东麓_20261009.zip`：原始压缩包（66.2 MB），仅本地保存。
- `raw/dem/`：`dem_taihang.tif`（6480 × 5213，int16，30 m，EPSG:4326）+ `.prj`。
- `raw/landcover/`：`landcover_taihang.tif`（21600 × 17376，uint8，约 9 m，ESA WorldCover 编码）+ `landcover_legend.csv`。
- `raw/road/`：`road_taihang_bbox.shp/.shx/.dbf/.prj/.cpg`，OpenStreetMap 道路 57610 条，属性 GBK 编码。

解压时去掉压缩包内的顶层文件夹，使上述三个子目录直接位于 `raw/` 下。
压缩包内文件名是 UTF-8 编码但未设 UTF-8 标志位，`unzip -l` 会把中文顶层文件夹显示成问号；
其下子目录与文件名都是英文，去掉顶层文件夹后不受影响。

## 数据概况

- 三项数据覆盖范围一致：`113.15E–114.95E, 36.276N–37.724N`。
- DEM 高程 12–2211 m，无 NoData；SHA256 `a42f42e17d38218f539cb04323696cacb296c4bcc11bb50a77cccf927f91bf7f`，
  与 2026-10-10 用于搬迁规划区的 `dem_taihang(1).tif` 是同一文件。
- 地物覆盖整个 DEM 范围；此前 9/11 批次的地物只到约 114.05°E 以东，新规划区有 55.6% 的候选扫描格点为「未知」。

## 处理

由 `scripts/prepare_geodata.py` 转换为 `data/raw/` 下的预处理文件，方式与体积见 [`data/raw/README.md`](../../raw/README.md)。

## 注意事项

- `raw/` 和 `source/*.zip` 已被 `.gitignore` 忽略，避免大文件误提交。
- DEM 与地物的原始出处、授权状态待确认；道路遵循 ODbL 1.0，使用时需保留署名。
