# R4-A 规划输入生效

基线：`main@0a8f15d`。依据用户授权的内部审批机制，由主集成内部批准后实施；本组不提交Git，不写共享台账，由主集成汇总。

## 所有权

- `algorithm-service/app/planning_job_service.py`
- `scripts/planning/sr4_flow.py`
- `scripts/planning/candidate_sites.py`
- `scripts/planning/deployment.py`
- `scripts/planning/plan_pipeline.py`
- `scripts/planning/deployment_inputs.py`（新增）
- `tests/test_r4a_planning_inputs.py`（新增）
- `tests/test_r4a_candidate_deployment.py`（新增）
- 本文件；独立测试产物仅写入 `data/runtime/r4/A/`。

五个已有源码文件在修改前均经严格UTF-8解码及BOM检查：合法、无BOM。只使用apply_patch局部编辑。其他组、原有未提交文件、原5183及现有运行库保留。

## 输入与原始结果契约

`resource_rows.planning_input` 为冻结副本，字段为 `schema_version:1`、`bbox`、`stationIds`、`deploymentConstraints`、`deploymentSolve`。不裁剪节点、通联需求或频率表。bbox只筛新增位置；已有节点坐标和R3门槛保持。无高级条件沿用原生P1/MO，合法全空条件不额外施加筛选默认值。

新增原始结果存于现有 `detail.optimization`，W4原有容器可直接保存，不修改W4或适配器：

| 路径 | 固定字段及类型 |
|---|---|
| `planning_input` | `schema_version:number`、`bbox:number[]或null`、`station_ids:string[]`、`deployment_constraints:object或null`、`deployment_solve:object或null` |
| `candidate_filter` | `source:string`、`scanned_count:number`、`accepted_count:number`、`candidates:object[]`、`rejected_stats:Record<string,number>`、`data_sources:string[]`、`unavailable_reasons:object[]` |
| `deployment_solve` | `mode`、`requested_count`、`actual_count`、`count_satisfied`、`requested_solution_count`、`returned_solution_count`、`forced_site_ids`、`selected_sites`、`lower_bound`、`proved_optimal`、`constraint_issues`、`shortfall_reasons`、`solutions` |

`candidate_filter.source` 取 `FROZEN_CANDIDATE_TABLE` 或 `TERRAIN_GRID`。未指定网格时筛冻结候选；显式网格在任务bbox扫描。`scanned_count`为本次逐点检查数（含显式强制点），`accepted_count`为实际进入求解的点数。`candidates`保留通过、排除和资料不足的全部已检查点；不是最终部署列表，也不是实测。

以下为字段示例，不是实跑证据：

```json
{
  "site_id": "CS-example", "lon": 114.0, "lat": 37.0,
  "elevation_m": null, "slope_deg": null, "landcover_type": null,
  "nearest_road_distance_m": null, "nearest_node_distance_m": null,
  "visible_node_count": null, "candidate_role": null,
  "is_deployable": true, "recommendation_level": null,
  "score": null, "reject_reason": null, "forced": false
}
```

未知属性为null。`is_deployable:true/false/null`分别表示通过本次条件、明确被排除、资料不足。没有指定的条件不凭空补默认值；原始表属性只是冻结输入资料，不自动成为科学来源已核验的声明。

`rejected_stats`固定键：`outside_bbox/source_rule/elevation/slope/landcover/road/exclude_zone/los/spacing/data_unavailable`，值均为非负整数；一项点位可触发多种原因，不要求各项之和等于排除点数。

`unavailable_reasons`固定为 `{site_id:string,field:string,reason:string}[]`；`constraint_issues`固定为 `{field:string,reason:string,site_id?:string|null}[]`。`data_sources`只用严格字符串标签，引用原始文件或原头部source，保留“来源待确认”，不编造来源。

`selected_sites`固定为 `{site_id:string|null,node_id:string,lon:number,lat:number,subtype:string|null,forced:boolean}[]`，包含最终网络全部新中继。`site_id:null`表示最终点没有已通过筛选的候选来源，必须同步记录约束问题，不能视为合格。

`requested_solution_count`是请求数；`returned_solution_count`只计`solutions`中实际频点完整校验通过且不同的结果。`solutions`带`candidate_index/selected_sites/evaluation_basis`及原生节点、设备、链路、路由、频率、参数、校验、指标副本；不把代表频点tradeoff计入。预算内不足时记录原因，不复制方案凑数。MIN_COUNT没有下界证明时`proved_optimal:false`，明确未证明全局最优。

`lower_bound`保留原生P1代表频点评估的下界参考，不能外推为实际频点全网问题的全局证明。当前仅零新增且完整实际校验通过的MIN_COUNT结果可据非负数量证明最少为零；其余保守标记未证明全局最优。

## 限制与失败边界

- 强制点不得绕过bbox、禁区或已指定条件；不可计算或冲突时明确错误。禁区支持Polygon内环，所有环边界禁止部署。
- 自交、相交环、外部内环及嵌套内环明确拒绝，不推定其区域；非空部署高级条件缺少原始DEM时明确失败，不使用原生合成地形回退。
- 间距约束作用于待新增点之间，不移动或删除既有站点。强制点参与间距和指定数量；同一候选位置不部署多个类型以凑数量。
- 冻结候选表经纬度为六位小数，bbox沿既有候选接口使用0.5e-6度精度容差，原坐标不移动；显式强制点及新扫描点使用精确边界。
- LOS按候选原生射频模板和目标冻结设备实际挂高逐类型计算；没有共同频段或挂高时记录不能计算的原因，不沿用固定8m假设。
- 新网格/显式增点采样不采用DEM夹边、缺值补零、合成地形。地物未知、道路缺失或范围不足不自动通过。
- 道路复用250m距离场，为近似几何距路；可通行条件和科学来源仍待确认。未指定道路条件时不伪造道路距离或评分。
- P1/P2保留原生启发式性质；强制点类型逐点选择不是全局组合证明。P2不能达到指定数时保留实际数量并令最终条件不通过。
- 最终MO新中继仍检查候选来源、bbox、类型LOS、禁区、间距、强制点和指定数量。物理余量、必要通联、90%抗毁与既有校验保持。
- 原生搜索继续受既有300秒/40次完整核验预算约束。完整DEM、真实HTTP、浏览器及重型全量测试由主集成统一，本组不执行。
- 固定父方案人工调整入口不重新选址；父快照已有相同部署高级条件时，允许调整功率、挂高和路由。真实准备/预留层仍严格比较条件版本和冻结输入（仅排除名称、描述），部署条件或区域改变返回409；不能仅凭高级字段非空在payload层拒绝。
- 最终LOS再按实际规划设备挂高检查；`forced_site_ids`记录请求的强制候选编号，即使最终缺失也不从审计集合删除。

## 测试证据

| 轮次 | 实际结果 | 证据与说明 |
|---|---|---|
| 首轮专用 | 35通过、1失败，3.98秒 | `data/runtime/r4/A/run-20261024-01/results.xml`；默认入口对比夹具缺少VUHF模板，原生正确报错。补充构造双频夹具，保留原比较断言，不修改生产缺资料拒绝逻辑 |
| 第二轮专用 | 38通过、1失败，3.94秒 | `data/runtime/r4/A/run-20261024-02/results.xml`；新增原始1032候选集合检查发现精确bbox比较漏掉六位小数边界点，复用既有候选接口精度容差修复生产代码，保留全量编号/顺序断言 |
| 第三轮专用 | 40通过、0失败，3.88秒 | `data/runtime/r4/A/run-20261024-03/results.xml`；原始1032候选编号及顺序完整保留，最终实际挂高LOS、固定父方案明确拒绝、强制点精确边界通过 |
| 第四轮专用 | 42通过、0失败，3.11秒 | `data/runtime/r4/A/run-20261024-04/results.xml`；增加两节点平地构造场景原生SR4串跑（0.16秒），固定零新增实际进入求解链，输入保持，方案数按实际结果记录；未替换路由/频率/参数/完整校验算法，但不属于真实DEM/HTTP证据 |
| 第五轮专用 | 47通过、0失败，8.50秒 | `data/runtime/r4/A/run-20261024-05/results.xml`；新增歧义禁区/合成回退拒绝及普通完成作业按历史资源版本投影、快照缺失/损坏不回退三个SQLite专项 |
| 最终源码专用 | 47通过、0失败，8.54秒 | `data/runtime/r4/A/run-20261024-06/results.xml`；固定父方案拒绝字段精确定位后最终复跑，所有测试逐项结果见XML |
| 内部gate首轮 | 64通过、2失败，17.80秒 | `data/runtime/r4/A/gate-20261024-01/results.xml`；新增父子测试的两节点父夹具未满足完整校验，两个失败均发生在父方案前置断言，原记录保留 |
| 内部gate父子第二轮 | 0通过、2失败，2.94秒 | `data/runtime/r4/A/gate-20261024-02-parent/results.xml`；三节点夹具缺少允许类型间的冗余边，未满足父方案前置断言 |
| 内部gate父子诊断轮 | 0通过、2失败，4.06秒 | `data/runtime/r4/A/gate-20261024-03-parent/results.xml`；保留物理校验通过但抗毁不通过的诊断，未放宽门槛 |
| 内部gate父子修正轮 | 2通过、0失败，2.64秒 | `data/runtime/r4/A/gate-20261024-04-parent/results.xml`；改用符合原生类型约束的四节点八设备冗余环，成功、失败子方案均不继承父候选解计数 |
| 内部gate最终专用 | 66通过、0失败，16.92秒 | `data/runtime/r4/A/gate-20261024-05/results.xml`；原47项加19项专项，含网格预检、流式扫描、共享预算、同坐标去重、原生父子重算及真实准备/预留边界 |

每条已执行用例的通过/失败均保留在对应JUnit XML，前两轮失败记录未覆盖。W4保存测试使用受控SR4返回替身，只验证容器持久化；原生P1/P2使用小场景平地构造数据，均不冒称完整DEM或真实HTTP验证。

本组未执行：完整DEM优化、真实HTTP、浏览器验收、全仓重型测试、服务启动/重启、Git提交/重置。最新源码统一运行与默认预设范围验证由主集成执行。当前无白名单外写入申请。

## 主集成待核对的默认区域

只读核对当前`frontend_integration.planning_preset_catalog`：默认bbox来自节点外接框`[113.394977,36.623746,114.416886,37.518987]`，1032个原始候选中417个位于该框外。旧SR4忽略bbox，当前显式bbox生效后该预设候选集合会改变。本组不静默绕过bbox，不修改共享预设，不宣称此预设与R3输入完全相同。R3规划框`dem_current.json.planning_bbox`在六位小数精度容差下保留全部1032候选；主集成需统一默认区域与同输入验证口径。2026-10-24已向主集成回报，未扩展文件白名单。

主集成内部批准并独占`frontend_integration.py`，修正新任务默认范围为实际DEM的`planning_bbox`；旧已保存输入保持。本组不编辑该共享文件，也不以自动扩大旧任务bbox掩盖条件差异。

## 内部扩展：完成作业结果冻结来源

主集成2026-10-24内部批准在本组独占`planning_job_service.py`的`query_planning_job`同一冻结来源装配处，将普通完成作业也按`job.resource_revision`读取`ResourceDatasetVersion`，通过既有`_decode`校验来源、内容摘要和表结构，再显式传`resource_rows`给B组适配器。删除该查询分支中回退当前CSV的调用，不修改适配器签名。旧版本不存在或损坏时返回原资源错误码及明确“冻结资源不可读”，不读取当前指针替代。专项使用A目录新SQLite及受控适配器捕获参数；不是HTTP验证，不写既有数据库。

## 内部gate四项修补

主集成内部批准在既有独占源码、两份专用测试及本记录内修补，不扩展文件范围。独立审阅原复现保留于`data/runtime/r4/R4-B/review-confirmed-4d7b6e81dbb34469b9b9925524f476ab/minimal-repro.json`。

1. 候选网格先按原生步长公式计算完整规模，超过100000点明确中文拒绝，尚未采样或分配网格列表，不截断结果。既有接口未发现扫描前限额，故明确设置此资源上限；120km量级范围的500m网格可落在上限内，1m/120km约143亿点会在扫描前拒绝。逐点采样后立即筛选，不先累积全部原始网格。采样、LOS、间距、候选解整理及最终输出共用原生300秒checkpoint，不增加时间预算。道路距离场另在分配前限制1000000格；原生道路构造为有界非抢占块，构造前后检查同一预算，未修改共享道路模块，超时不能返回成功。
2. 固定父方案重算后，继承的`deployment_solve.solutions`清空、`returned_solution_count`置0、`proved_optimal`置false，并明确说明父候选解未逐套验证、已失效。子方案失败另记实际完整校验失败；子方案成功也不将父解冒充子解。子方案实际校验结果保留，父对象不变。
3. 不同编号但同物理位置的候选只能一个进入求解；坐标相等判断为1e-9度身份容差，不移动坐标或放宽部署间距。被排除的原始候选仍留在审计列表，`reject_reason`为`duplicate_position:<保留编号>`，计入既有`source_rule`，DTO不加键。原生兼容检查禁止重合点；最终输出独立检测重复位置和重复编号，保留所有实际节点供审计，`actual_count`按唯一物理位置计数，重复时`count_satisfied:false`，不能靠两个别名满足指定数量。
4. 删除payload层仅因父方案带非空高级字段而触发的422。新增真实`_reserve`/`prepare_parent`测试证明相同冻结条件允许功率、挂高、路径调整；改变部署求解、部署筛选、bbox或条件版本仍409，且不产生新预留作业。原错误入口断言由正确边界测试替代，不移除冻结条件和父拓扑约束。

测试路径组合修补只将隔离断言放宽至本树`data/runtime/r4`根，仍禁止越出该隔离根；主集成此前4项因路径拒绝的失败保留，不改业务断言。以上原生小场景采用受控传播损耗/底噪输入，不替换路由、频率、参数或完整校验算法，6dB、90%及必要通联门槛未改。主集成此前176前端、217后端、全DEM/参数矩阵、图谱GUI和覆盖324回读证据早于本次gate最终源码，不能冒充本次源码验证。

## 交接状态

四项内部gate及轻量专用验证完成，全部文件所有权交回主集成，源码冻结供API重启与最终全网验收；没有Git提交。本组最终9文件严格UTF-8无BOM，`git diff --check`限定本组文件退出0。此前摘要`data/runtime/r4/A/source-manifest-20261024-final.json`保留，本次最终源码摘要另记于`data/runtime/r4/A/source-manifest-20261024-gate-final.json`。完整DEM/真实HTTP与页面基线由主集成使用本次最终源码重跑，本组不启动服务，不写原5183或旧数据库，不再新增生产变更。
