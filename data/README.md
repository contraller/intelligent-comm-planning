# 数据目录说明

本目录用于存放项目第一周“数据生成/数据整理”相关资料，不作为软件需求规格说明书正式章节正文。

## 目录结构

- `raw/`：从公开渠道获取的原始数据或资料。
  - `dem/`：地形高程数据，建议 GeoTIFF。
  - `landcover/`：地物、土地覆盖数据，建议 GeoTIFF、GeoJSON 或 Shapefile。
  - `roads/`：道路与可达性数据，建议 GeoJSON 或 Shapefile。
  - `equipment_docs/`：短波/超短波设备说明书、公开参数资料。
  - `maintenance_docs/`：维修资料、故障处理资料。
- `synthetic/`：根据测试需求自行构造的数据。
  - `nodes/`：短波节点、超短波节点、固定站、移动站数据。
  - `tasks/`：任务通联关系与通信需求。
  - `frequency/`：可用频段、频点、信道与占用状态。
  - `interference/`：干扰源与干扰场景。
  - `topology/`：网络拓扑与链路属性。
  - `link_status/`：网络运行状态、链路状态测试记录。
- `fault/`：故障诊断相关数据。
  - `cases/`：故障案例数据。
  - `knowledge_graph/`：故障知识图谱三元组。
  - `rules/`：故障判断规则。
- `schemas/`：数据字段模板和 JSON Schema。
- `dictionary/`：数据字典、枚举值、字段说明。
- `imported/`：外部导入的原始数据批次归档，通常体量较大，仅保留本地说明文件入库。

## 第一阶段数据量口径

- 短波节点数量不少于 50 个。
- 超短波节点数量不少于 100 个。
- DEM、地物、道路数据覆盖范围不小于 120 km x 120 km。
- 任务通联关系建议 5 到 10 组任务场景，每组 30 到 100 条通联关系。
- 可用频率资源建议每类网络准备约 20 到 50 个可用频点或信道。
- 干扰源建议 10 到 20 个干扰场景。
- 网络拓扑建议 1 套 150 节点以上网络，200 到 500 条链路。
- 链路状态建议准备 1000 条以上状态记录。
- 故障案例建议 4 类故障，每类 50 到 100 条。
- 故障知识图谱第一版建议 500 到 2000 条关系。
- 故障规则第一版建议 50 到 100 条规则。

## 命名建议

建议使用以下命名方式：

- `raw/dem/planning_area_120km_30m.tif`
- `raw/landcover/planning_area_landcover.geojson`
- `raw/roads/planning_area_roads.geojson`
- `synthetic/nodes/nodes_v1.csv`
- `synthetic/tasks/task_links_v1.csv`
- `synthetic/frequency/frequency_resources_v1.csv`
- `synthetic/topology/topology_links_v1.csv`
- `synthetic/link_status/link_status_v1.csv`
- `fault/cases/fault_cases_v1.csv`
- `fault/knowledge_graph/fault_triples_v1.csv`
- `fault/rules/fault_rules_v1.csv`

## 当前可用数据

- 算法可直接读取的测试数据位于 `synthetic/`、`fault/` 和 `dictionary/`。
- `synthetic/nodes/nodes_v1.csv`：节点数据，包含短波和超短波节点。
- `synthetic/tasks/task_links_v1.csv`：任务通联需求。
- `synthetic/frequency/frequency_resources_v1.csv`：可用频率资源。
- `synthetic/topology/topology_links_v1.csv`：网络拓扑链路。
- `synthetic/link_status/link_status_v1.csv`：链路状态样例。
- `fault/cases/fault_cases_v1.csv`：故障案例样例。
- `dictionary/symptom_dict_v1.csv`：故障现象字典。

## 导入数据批次

- `imported/data_zip_20260911/`：2026-09-11 导入的原始数据包。
- `imported/data_zip_20260911/raw/`：解压后的原始资料，包含设备参数、PDF 资料、故障案例、DEM、地物和道路数据。
- `imported/data_zip_20260911/source/data.zip`：原始压缩包，仅本地保存，不提交到 GitHub。

## 注意事项

- 公开资料应记录来源、下载时间、覆盖范围和授权状态。
- 自行构造的数据应记录生成规则、随机种子、字段含义和适用测试场景。
- 不确定的数据来源、协议字段、设备型号和故障知识规模应标注“待确认”。
