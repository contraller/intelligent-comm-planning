# 导入数据归档说明

本目录用于保存外部导入的数据批次。导入数据通常包含 GeoTIFF、Shapefile、PDF 和压缩包等大体量文件，仅作为本地原始资料归档，不直接提交到 GitHub。

每个导入批次建议包含：

- `README.md`：批次说明、数据内容、处理状态和注意事项。
- `source/`：原始压缩包或外部交付文件。
- `raw/`：解压后的原始数据。

算法可直接读取的数据应整理到 `data/synthetic/`、`data/fault/` 或 `data/dictionary/`。
