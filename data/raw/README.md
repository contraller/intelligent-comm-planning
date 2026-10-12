# 原始地理与设备数据

本目录存放**经过预处理、可直接进入算法流程**的基础数据。
原始交付件只在本地保留，不进仓库；进仓库的文件都是**普通 git 文件，不走 Git LFS**。

## 数据来源

| 项 | 值 |
|---|---|
| 地理数据批次 | `太行山东麓_20261009.zip`（66.2 MB，解压 96.3 MB），2026-10-12 入库 |
| 批次内容 | DEM GeoTIFF、地物 GeoTIFF + 编码表、道路 Shapefile，三者覆盖范围一致 |
| 覆盖范围 | `113.1499E–114.9499E, 36.2760N–37.7240N` |
| 规划区 | `113.3750E–114.7247E, 36.4610N–37.5390N`（DEM 正中 120 km × 120 km，写在 `dem_current.json` 的 `planning_bbox`） |
| 原始件位置 | 本地 `data/imported/taihang_20261009/`（见该目录 README），未上传 GitHub |
| 设备 / 故障资料 | 仍取自 2026-09-11 的 `data.zip` 批次（`data/imported/data_zip_20260911/`） |

## 目录内容

| 路径 | 体积 | 说明 |
|---|---|---|
| `dem/dem_current.json` + `.bin.gz` | 31.4 MB | 高程网格，6480 × 5213，int16，约 30 m，高程 12–2211 m，无 NoData |
| `landcover/landcover_taihang.json` + `.bin.gz` | 4.9 MB | 地物网格，7200 × 5792，uint8，约 28 m，**覆盖整个 DEM 范围** |
| `landcover/landcover_legend.csv` | 173 B | 地物编码对照（ESA WorldCover：10 树木 / 30 草地 / 40 农田 / 50 建筑区 / 80 永久水体 …） |
| `roads/roads_taihang.geojson.gz` | 5.1 MB | 道路，54848 条 / 54856 段，仅车辆可通行等级 |
| `maintenance_docs/fault_case_imported.csv` | 56 KB | 采集的 240 条故障案例原始表 |
| `maintenance_docs/docs_index.csv` | 8 KB | 41 份设备说明书 / 维修资料的索引（PDF 本身不在仓库） |
| `equipment_docs/` | 8 KB | 设备与天线型号表（16 个设备型号 / 78 个天线型号） |

地理数据进入仓库共 **41.4 MB**，最大单文件 31.4 MB，低于 GitHub 单文件 50 MB 的警告线（文中 MB 均按 1024² 字节计）。

地物各类占比：农田 37.1%、草地 29.7%、树木 22.3%、建筑区 9.5%、裸地/稀疏植被 1.1%、永久水体 0.4%，
灌木与草本湿地合计不足 0.01%。

## 为什么不用 Git LFS

2026-10-10 地理数据曾改为 LFS 托管。本机及多数协作环境未装 git-lfs，拉下来的只是 133 字节的指针文件，
`terrain.default_terrain()` 直接报 `BadGzipFile`，所有规划脚本都跑不起来。
预处理后的文件体积不大，以普通文件提交即可，2026-10-12 起改回此方式，
`.gitattributes` 只对 `*.zip` 保留 LFS 规则（文档线的 Visio 图与前端交接包）。

## 为什么不直接提交原始文件

1. **读取需要依赖、且慢**。GeoTIFF 与 Shapefile 的通用读法都要 GDAL 系依赖，与 CLAUDE.md「只用标准库」冲突；
   仓库自带的最小读取器能读，但地物原图 21600 × 17376 像素、展开 358 MB，每次加载都要逐行解码。
   预处理后的网格用 gzip + struct 即可读取，地形加载约 0.2 s。
2. **没有可用的额外信息**。DEM 本身只有 30 m，地物保留约 9 m 原分辨率对传播计算没有增益。
3. **版权**。41 份设备说明书为厂商版权资料（Motorola、Barrett、Harris、Yaesu 等），
   不适合公开分发，已从仓库排除，仅保留索引表。

## 预处理方式

由 [`scripts/prepare_geodata.py`](../../scripts/prepare_geodata.py) 一次性生成，可重复执行：

```bash
python3 scripts/prepare_geodata.py
```

| 数据 | 原始 | 处理 | 结果 |
|---|---|---|---|
| DEM | 31.9 MB GeoTIFF，30 m | 原生经纬度解码后平铺 + gzip，并在正中取 120 km 规划区（`prepare_replacement_dem.convert`） | 31.4 MB |
| 地物 | 24.1 MB GeoTIFF，约 9 m（展开 358 MB） | 3 倍最近邻降采样至约 28 m + gzip | 4.9 MB |
| 道路 | 40.2 MB Shapefile（GBK） | 裁至 DEM 覆盖范围、仅留车行等级、属性精简为 `fclass`/`name`、转 UTF-8、坐标 6 位小数 + gzip | 5.1 MB |

DEM 的 `source_sha256` 记录原始 GeoTIFF 的哈希（`a42f42e1…`），可据此核对来源。

**换了地理数据之后**，按 CLAUDE.md 重新生成测试数据与派生数据并校验：

```bash
python3 scripts/gen_test_data.py
python3 scripts/gen_algorithm_design_data.py
python3 scripts/diagnosis/build_fault_graph.py
python3 scripts/validate_data.py
```

## 读取方式（纯标准库，无需任何第三方包）

```python
import sys; sys.path.insert(0, "scripts/geo")
from grid import GridRaster

dem = GridRaster("data/raw/dem/dem_current.json")
lc  = GridRaster("data/raw/landcover/landcover_taihang.json")

dem.sample(114.30, 37.30)     # -> 263  (米)
lc.sample(114.30, 37.30)      # -> 30   (草地)
dem.sample(100.0, 37.30)      # -> None (越界)
```

道路为标准 GeoJSON，`gzip.open` 后 `json.load` 即可；QGIS 也可直接打开解压后的文件。

相关模块：

- [`scripts/geo/tiff.py`](../../scripts/geo/tiff.py) —— 最小 GeoTIFF 读取器，含手写 TIFF 变体 LZW 解码
- [`scripts/geo/shapefile.py`](../../scripts/geo/shapefile.py) —— 最小 Shapefile / DBF 读取器
- [`scripts/geo/grid.py`](../../scripts/geo/grid.py) —— 网格读取与经纬度采样

## 待确认

- DEM 与地物数据的原始出处、授权状态待确认。
- 道路数据来自 OpenStreetMap，遵循 ODbL 1.0，使用时需保留署名。
- 规划区西侧缓冲约 20 km（DEM 西界 113.15°E，规划区西界 113.375°E），贴边链路的遮挡计算已有地形可用。
