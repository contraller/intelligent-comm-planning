# 本地演示地图来源

- 道路来源：甲方资料 `docs/数据接口样例/05_地理与原始数据/raw/roads/roads_taihang.geojson.gz`，OpenStreetMap 数据。
- 署名：© OpenStreetMap contributors；数据库许可 ODbL 1.0，https://www.openstreetmap.org/copyright 。
- 本地派生数据：仅筛选高速、主干、一级、二级、三级道路及部分连接线，保留源坐标与几何，不修改原始文件。派生道路数据库遵循 ODbL 1.0。
- 坐标 WGS84 / EPSG:4326，顺序 [经度, 纬度]；OpenLayers 显示时统一转换 EPSG:3857。
- 无在线底图、DEM 或真实覆盖计算。蓝色背景为界面背景，不代表土地分类或测量结果。
- 覆盖/盲区/影响范围来自独立手工预设的演示快照，不能解释为真实地理分析结果。

运行 `npm run prepare:assets` 可从随项目保留的原始资料重新生成道路及资源 JSON。首次安装不需要重新生成。

## SR4 联调页地形

`sr4-terrain.png` 是从 `data/results/current_dem/demo_data.json` 的彩色 DEM 晕渲结果提取的图像；对应范围与来源哈希见 `sr4-terrain.json`。该图仅供 SR4 独立联调页使用，不改变上述原有 Mock 地图的底图口径。可运行 `npm run prepare:sr4-terrain` 重新导出。

## 覆盖教学图片及版本（第四十一批）

`coverage/demo-v1-*.png`、`coverage/device-v1-*.png` 及其旧目录保留，供既有任务／方案按冻结版本使用。新增三张 `demo-v2` 规划图和四张 `device-v2` 设备图，几何、孔洞、透明区、alpha 和教学色阶位置保持，仅将对应 RGB 换为弱黄 `#fdd835`、中浅绿 `#9ccc65`、强深绿 `#2e7d32`。设备归属色不随场强色表改变。

数据目录为 `src/mocks/planning-coverage-v2.json`、`src/mocks/device-coverage-v2.json`，源几何和 patches 沿用各自 v1 独立手工教学目录；并非从原始道路数据计算覆盖，也不是甲方提供的真实场强 PNG。40／30／20 dBμV/m 为固定教学值，不代表正式三级阈值。原接口资料只给内嵌覆盖示例，没有独立覆盖 PNG 或完整响应 JSON。

批准范围内的离线生成命令如下；脚本只写明确的七个 v2 路径并拒绝 v1 目标，不需要执行道路资源生成命令：

```text
node scripts/prepare-planning-coverage.mjs
node scripts/prepare-device-coverage.mjs
```

脚本使用已有 `scripts/lib/coverage-png.mjs` 将给定 contour 与 patches 栅格化，不做传播、场强重分级、插值、覆盖率或多设备合成。七组新旧图片已通过逐像素仅对应 RGB 替换检查，原 v1 文件摘要保持，详见[第四十一批自检](../../docs/前端自检记录.md)；该检查不代表真实场强或浏览器视觉验收。正式 HTTP 图片和色表仍由后端提供，前端不据此覆盖它们。道路署名和许可保持上述原文。
