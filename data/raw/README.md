# 原始地理与设备数据

本目录存放**经过预处理、可直接进入算法流程**的基础数据。
原始交付件（`data.zip`，643 MB）仅本地保留，不进仓库。

## 数据来源

| 项 | 值 |
|---|---|
| 交付批次 | `data.zip`，2026-09-11 由数据采集同学交付 |
| 解压后 | 272 个文件，约 2.06 GB |
| 覆盖范围 | `114.0465E–115.8532E, 36.5815N–38.0187N`（规划区外扩 20 km） |
| 原始件位置 | 本地 `~/Desktop/data.zip`，未上传 GitHub（见下） |

## 目录内容

| 路径 | 体积 | 说明 |
|---|---|---|
| `dem/dem_taihang.json` + `.bin.gz` | 20 MB | 高程网格，6504 × 5174，int16，约 30 m |
| `landcover/landcover_taihang.json` + `.bin.gz` | 4.1 MB | 地物网格，7228 × 5750，uint8，约 28 m |
| `landcover/landcover_legend.csv` | 4 KB | 地物编码对照（10 树木 / 30 草地 / 40 农田 / 50 建筑区 / 80 永久水体 …） |
| `roads/roads_taihang.geojson.gz` | 4.9 MB | 道路，76218 条 / 76239 段，仅车辆可通行等级 |
| `maintenance_docs/fault_case_imported.csv` | 56 KB | 采集的 240 条故障案例原始表 |
| `maintenance_docs/docs_index.csv` | 8 KB | 41 份设备说明书 / 维修资料的索引（PDF 本身不在仓库） |
| `equipment_docs/` | 8 KB | 设备与天线型号表（**当前仍为示例行，真实型号待并入**） |

进入仓库总计约 **28 MB**。

## 为什么不直接提交原始文件

1. **体积超限**。地物 GeoTIFF 未压缩 357 MB、道路 shapefile 合计 1.5 GB、`data.zip` 643 MB，
   均超过 GitHub 单文件 100 MB 的硬限制，`git push` 会被直接拒绝。
   Git LFS 免费额度为 1 GB 存储 + 1 GB/月流量，一次 clone 即接近耗尽，不适合多人协作。
2. **格式需要依赖**。GeoTIFF 与 Shapefile 都要 GDAL 系依赖才能读，
   与 CLAUDE.md「只用标准库」的约束冲突。
3. **版权**。41 份设备说明书为厂商版权资料（Motorola、Barrett、Harris、Yaesu 等），
   不适合公开分发，已从仓库排除，仅保留索引表。

## 预处理方式

由 [`scripts/prepare_geodata.py`](../../scripts/prepare_geodata.py) 一次性生成，可重复执行：

```bash
python3 scripts/prepare_geodata.py
```

| 数据 | 原始 | 处理 | 结果 |
|---|---|---|---|
| DEM | 17.2 MB LZW 分块 GeoTIFF | 解码后平铺 + gzip | 20 MB |
| 地物 | 356.7 MB **未压缩** GeoTIFF，10 m | 3 倍最近邻降采样至约 28 m + gzip | 4.1 MB（压缩 87 倍） |
| 道路 | 49.3 MB Shapefile（GBK） | 裁至外扩框、仅留车行等级、属性精简为 `fclass`/`name`、转 UTF-8、坐标 6 位小数 + gzip | 4.9 MB |

DEM 未沿用原 GeoTIFF 而改存平铺网格，是因为原格式每次加载需解码 546 个 LZW 分块耗时 5.5 s，
平铺 gzip 仅 0.1 s；多付 1.4 MB 体积换 55 倍加载速度。

地物降采样到约 28 m，是因为 DEM 本身只有 30 m，地物保留 10 m 没有可用的额外信息。

## 读取方式（纯标准库，无需任何第三方包）

```python
import sys; sys.path.insert(0, "scripts/geo")
from grid import GridRaster

dem = GridRaster("data/raw/dem/dem_taihang.json")
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

- **规划区 bbox 需要重新评估**。实测当前规划区 `114.2724–115.6276, 36.7610–37.8390`
  高程仅 18–524 m、中位 35 m、坡度中位 2.2°、坡度 >15° 仅占 0.7%，几乎全是平原；
  太行山主脊位于 `114.047–114.272` 这条**外扩缓冲带**内（最高 1526 m，33% 高于 500 m），
  未被规划区覆盖。详见 `工作交接.md`。
- `equipment_docs/` 中的设备与天线型号表仍是示例行，
  真实的 16 个设备型号与 77 个天线型号尚未并入（表头与现有约定不一致，需先对齐字段）。
- DEM 与地物数据的原始出处、授权状态待确认。
- 道路数据来自 OpenStreetMap，遵循 ODbL 1.0，使用时需保留署名。
