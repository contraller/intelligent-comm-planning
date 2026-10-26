# data.zip 导入批次说明

导入日期：2026-09-11

## 目录

- `source/data.zip`：原始压缩包，仅本地保存。
- `raw/device/`：设备和天线参数 CSV。
- `raw/docs/`：设备说明书、数据手册、维修和排障资料 PDF。
- `raw/fault/`：原始故障案例 CSV。
- `raw/landcover/`：地物 GeoTIFF 和地物编码表。
- `raw/road/`：河北、山西及太行区域道路 Shapefile。
- `raw/terrain/`：DEM 地形高程 GeoTIFF。

## 数据概况

- 解压后约 260 个文件，约 2.06 GB。
- 设备型号：16 条，HF 8 种，VUHF 8 种。
- 天线型号：78 条。
- 故障案例：240 条。
- PDF 资料：41 份。
- GeoTIFF：2 个，包含 DEM 和地物数据。
- 太行区域道路 Shapefile：约 77512 条道路要素。

## 已处理事项

- 已将解压时多余的 `data/raw/` 嵌套目录整理为当前批次根目录下的 `raw/`。
- 已修正 `raw/fault/fault_case.csv` 的字段错位问题。
- 已确认 DEM 和地物数据覆盖范围约为 `114.0465E-115.8534E, 36.5813N-38.0188N`。

## 注意事项

- `raw/` 和 `source/*.zip` 已被 `.gitignore` 忽略，避免大文件误提交。
- 若需进入算法流程，应将原始数据清洗或抽取到 `data/synthetic/`、`data/fault/` 或 `data/dictionary/`。
