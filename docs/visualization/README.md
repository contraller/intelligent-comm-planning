# 数据可视化产物说明

本目录存放当前项目数据集的可视化结果，用于数据检查、算法设计讨论和阶段汇报 PPT。

## 生成命令

```powershell
python scripts\gen_visualizations.py
```

脚本会读取 `data/` 下已生成的数据，并重新输出本目录中的 HTML、PNG 和摘要 JSON。

如需生成 DEM、坡度、地物覆盖等地形关系图，需要在包含 `rasterio` 的 Python 环境中执行。例如：

```powershell
conda run -n pytorch python scripts\gen_visualizations.py
```

## 交互地图

- `map_overview.html`

用途：

- 展示 HF / VUHF 节点的空间分布。
- 展示候选部署点的可部署 / 不可部署状态。
- 展示拓扑链路和部分主用 / 备用路由样例。
- 展示干扰源位置及影响范围示意。

说明：

- 该文件是离线 SVG 坐标总览，不依赖在线瓦片地图。
- 页面提供图层开关，可单独查看节点、候选点、链路、路由和干扰源。
- 鼠标悬停元素可查看节点编号、链路编号、评分、故障原因等关键字段。

## PPT 推荐图表

- `figures/terrain_elevation_overview.png`：DEM 高程底图，可用于说明原始地形数据覆盖项目区域。
- `figures/terrain_candidate_overlay.png`：DEM 高程 + 节点 + 候选点叠加图，可作为“地形关系可视化”的主展示图。
- `figures/slope_candidate_rejection.png`：坡度约束 + 坡度拒绝候选点，可用于解释候选点筛选规则。
- `figures/landcover_candidate_overlay.png`：地物覆盖 + 节点 + 候选点叠加图，可用于解释地物约束。
- `figures/spatial_nodes_candidates.png`：节点、候选部署点和干扰源空间分布，可作为汇报中的主展示图。
- `figures/topology_density_map.png`：拓扑链路密度图，可用于说明链路数据规模；该图线条较密，适合讲“拓扑数据已经形成”，不适合承载所有细节。
- `figures/route_sample_map.png`：主用 / 备用路由样例图，可用于说明后续路由规划算法输入和预期输出。
- `figures/node_type_count.png`：节点规模统计，可用于说明短波节点不少于 50、超短波节点不少于 100 的数据基础。
- `figures/candidate_site_result.png`：候选部署点筛选结果，可用于说明 120 个候选点中可部署点的比例。
- `figures/candidate_site_algorithm_funnel.png`：候选部署点算法筛选漏斗，可用于同时说明 120 个候选点、74 个原始可部署点、68 个叠加最小站间距后的可选点。
- `figures/candidate_reject_reasons.png`：候选点被拒原因统计，可用于说明数据已经支持地形、地物、道路距离等约束筛选。
- `figures/link_type_count.png`：拓扑链路数量统计，可用于说明链路建模规模。
- `figures/frequency_resource_count.png`：频率资源统计，可用于说明后续频率分配算法的资源池。
- `figures/frequency_conflict_type_count.png`：频率冲突约束统计，可用于说明冲突检测和频率分配的输入条件。
- `figures/link_margin_distribution.png`：链路余量分布，可用于说明链路质量评估具备量化指标。
- `figures/fault_case_count.png`：故障案例类型统计，可用于说明故障诊断数据覆盖范围。
- `figures/fault_rule_count.png`：故障规则类型统计，可用于说明规则诊断原型的数据基础。

## 摘要文件

- `summary.json`

该文件记录本次可视化生成的文件清单、主要数据统计和地图图元数量，便于汇报时快速核对数据口径。
