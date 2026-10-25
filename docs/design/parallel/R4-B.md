# R4-B 结果正确性及正式结果明细

基线：`main@0a8f15d`。本组仅实施用户内部批准的结果适配及明细投影，不按《测试用例》扩张验收。

## 独占写集

- `algorithm-service/app/planning_result_adapter.py`
- `algorithm-service/app/planning_result_details.py`（新增）
- `tests/test_planning_result_details_projection.py`（新增）
- `docs/design/parallel/R4-B.md`（新增）

修改前适配器已验证为 UTF-8 无 BOM；新增文件使用相同编码。主集成负责共享台账及契约文档，D 组负责唯一新版前端类型、严格 decoder 和展示；本组不编辑这些共享文件。

## 判定口径

- 必要集合仅取冻结输入的 `mandatory is True`；输入 schema 为 `StrictBool`，不能把字符串或整数当必要标志。
- 必要集合非空、所有必要需求存在有效主路由、原生必要连通检查 `pass is True` 同时成立才输出通过。非必要需求未通不抬为必要约束；备份不能代替主路由。
- 既有 schema 允许无必要需求。空必要集合保守返回 `passed=false`，明示“无必要需求，无法评价必要通联连通率”，不输出 0/0 或推算 100%；不改变算法输入或算法门槛。
- 原 6dB、90%抗毁、中继及必要通联要求不变。缺失指标保留 null；倾角原生 0 不被源设备值覆盖。

## 正式结果明细契约

HTTP 增补 `result_details`，由既有 decoder 转为 `resultDetails`。`schemaVersion=1`，`assetVersion=sr4-native-v1:<原生solution_id>`。集合未提供为 null，明确空数组保留 []。旧保存快照不回填、不改写。

| 字段 | 原始来源及定义 |
|---|---|
| deviceParameters | 仅关联 configuration.devices；按 device_id 优先、node_id/band 旧参数次之，输出 deviceId、tiltDeg、tiltEffective；未提供结论为 null |
| routeQuality | 仅关联已输出主备路由；hop_count、total_delay_ms、min_link_margin_db、reliability、bottleneck_link_id 直接投影；totalDistanceM 为路径全部原生链路 distance_m 齐全时之和；isFeasible 无独立来源，保留 null |
| frequencyAssignments | link_assignments 明确展开至冻结物理链路；freq_id、reuse_group、freq_khz、bandwidth_khz 直接投影；每链路唯一，resourceGroupId 仅引用实际输出频率组 |
| frequencyConflicts | 原生 type/kind、link_ids、freq_khz、distance_m、required_distance_m、severity；网级引用按 assignments/link_assignments 的明确成员展开；邻频双频数组无法由现有标量字段承载，frequencyKhz=null，不取首频冒充 |
| frequencyGap | 原生各独立频段 required_channels、available_channels、shortage 分别求和；不再叠加 sub_bands；任一频段缺项时该统计为 null |
| conflictFree | 仅读取原生 conflict_free 布尔值，不从冲突列表推断 |
| unreachableDemandIds | 原生 unreachable_demand_ids 与本次冻结输入需求的交集，不把缺少路由等同原生不可达结论 |

## A/D 组扩展边界

按 A 组批准的 `detail.optimization.candidate_filter` 和 `deployment_solve` 对接；已核对 R4-A.md 的固定候选行及不可计算原因定义，并补充调用 A 组轻量原生筛选和数量元数据函数的定向测试。

- candidateScreening：sourceLabel←source、candidateCount←scanned_count、deployableCount←accepted_count、rejectedStats←rejected_stats、candidates←candidates；候选属性逐项读取，不把强制纳入等同可部署。批准新增 `unavailableReasons:string[]|null`，按主集成最新约定将原生 `{site_id,field,reason}` 严格格式化为 `<site_id>/<field>：<reason>`，保留三项事实，不放宽前端接收对象。
- 候选原生缺少 visible_node_count、candidate_role、is_deployable 等属性时，相应 DTO 字段保留 null；来源文本缺失时 candidateScreening=null，不编造来源。
- 主集成已批准可选 `dataSources:string[]|null`，对应原生 `data_sources`，原文及顺序保留，包括“来源待确认”。原生缺省时 DTO 也缺省，明确 null 和空数组分别保留；对象、非字符串元素或空白标签拒绝投影，不补造来源，不用 unknown 或任意对象承载。
- 批准可选 deploymentSummary：mode 为 MIN_COUNT/FIXED_COUNT/null；requestedCount、actualCount、requestedSolutionCount、returnedSolutionCount 为 number/null；countSatisfied 为 boolean/null；shortfallReasons、forcedSiteIds 为 string[]/null；lowerBound 为 number/null；provedOptimal 为 boolean/null。均仅投影对应原生 snake_case 字段，不推定计数满足或全局最优。
- 主集成批准 constraint_issues 合入 deploymentSummary.shortfallReasons：原生 `{field,reason,site_id?}` 按 `<field>/<site_id>：<reason>` 投影；site_id=null 或缺省时为 `<field>：<reason>`，不补造站点。先保留 shortfall_reasons 原顺序，再追加约束问题，按完整字符串稳定去重，不修改 raw 字段。
- selected_sites 不塞进旧候选字段；本轮未约定其独立新增 DTO。正式部署配置仍为既有 configuration.deployment。
- 原生优化 tradeoff 标记为代表频点预筛选，不能冒称最终实际频点合格解；本轮不输出优化曲线或缺少明确冻结边身份的关键桥明细。

## 验证记录

测试临时目录及证据统一放入 `F:/work/project2026-1/data/runtime/r4/R4-B/` 的本次独立子目录，不写 C 盘或现有运行库。

| 项目 | 状态 | 证据及边界 |
|---|---|---|
| 新增结果投影定向测试 | 64 passed | 最新两文件合计70项中的64项；包括判定、主备质量、网级频率映射、缺值、候选来源可空、约束原因合并去重、部署扩展及旧保存快照DTO；构造夹具不能替代物理求解或真实HTTP |
| 既有冻结结果来源测试 | 6 passed | 最新合计70项中的6项；不读取当前资源、显式空设备及旧入口兼容 |
| A 组固定字段及轻量原生函数对照 | passed，计入上述64项 | 实际调用 prepare_candidates/solve_detail，核对通过与资料不足候选、对象原因转字符串、数量缺口和未证明最优；新增无DEM拒绝断言及原生加载的2x2构造栅格，不是完整DEM求解 |
| 最新前端严格 decoder | 未执行 | 由主集成统一安排，本组不跑前端重型测试 |
| 真实 HTTP、浏览器、完整DEM求解 | 未执行 | 主集成负责；本组未启动服务或执行重型全量测试 |

首轮已执行新增投影及既有冻结来源两文件：50 passed，2.11秒。证据：`data/runtime/r4/R4-B/unit-397a126b0bf0468db2672cc21a7f5c09/results.xml`、同目录 pytest.log。该轮夹具早于 A 组不可计算原因对象结构对齐，不作为最新源码证据；后续重跑另记，不抹去原记录。

第二轮原生字段对齐：**55 passed / 0 failed / 0 skipped，7.10秒**。证据：`data/runtime/r4/R4-B/native-alignment-c72036a04bd14076be85856b9162c2c8/results.xml`、同目录 `pytest.log`。该轮先于来源字段和约束原因扩展，不作为最终修订通过证据。

来源数组首轮扩展：**62 passed，9.03秒**。证据：`data/runtime/r4/R4-B/provenance-ca54651652be4fcb9799abaf41774f14/results.xml`、同目录 pytest.log。该轮完成时主已追加来源可空及约束问题合并要求，后续另行修订，不沿用为最终代码通过。

来源可空及约束原因合并首跑：**69 passed / 1 failed，8.87秒**。证据：`data/runtime/r4/R4-B/final-contract-329b8dfb2bb64df8a687b0558c3956e9/results.xml`、同目录 pytest.log。A 组同步新增高级条件缺原始DEM时拒绝合成回退的门禁，现有元数据对接夹具无DEM而被正确拒绝。保留失败记录；测试现增加无DEM拒绝断言，并使用测试独立目录的2x2构造栅格经原生 DemTerrain/GridRaster 加载器提供前置条件，原候选通过/不可计算断言不变，不放宽生产门禁，不冒称真实DEM或完整物理求解。

最终修订重跑：**70 passed / 0 failed / 0 skipped，5.86秒**。证据：`data/runtime/r4/R4-B/final-verified-bc93084b823f44d4835a3cb7f787ccca/results.xml`、同目录 `pytest.log`。该轮包含 dataSources:string[]|null、`站点id/field：reason` 格式、constraint_issues 合并和原生DEM前置条件对齐。

各轮临时文件均在对应独立目录；设置 TEMP/TMP/TMPDIR、ALGORITHM_TASK_DIR、SR4_PLAN_DIR 指向本轮目录，关闭字节码写入、pytest缓存及自动加载插件。最后一轮另设 PYTHONUTF8/PYTHONIOENCODING，确保中文测试日志按UTF-8输出。

实际命令使用仓库 `.venv/Scripts/python.exe -m pytest tests/test_planning_result_details_projection.py tests/test_planning_result_frozen_sources.py -q -p no:cacheprovider --basetemp <独立目录>/pytest-temp --junitxml <独立目录>/results.xml`。各轮都是后端定向测试，计数不相加，不用旧源码证据充当最终修订通过。

旧快照兼容新增实际 planning_plan_service._dto 的单元验证，禁止重新投影、禁止访问数据库；不把它称为真实持久化保存回读。

## 主集成交接

- 本组四文件实现及后端定向验证完成。旧 `mandatory` 判定缺陷已修复；空必要集仍为显式无法评价，未改算法或输入 schema。
- D 组需严格读取可选 unavailableReasons/deploymentSummary；本组只读核对了 D 组已接入的字段定义，没有修改或执行前端。
- dataSources 及不可计算原因格式已按主集成最新批准修订；D 组同步可选 dataSources:string[]|null 及严格 decoder，旧候选缺省继续兼容。constraint_issues 现在通过既有 shortfallReasons 呈现，不增加 raw 字段或改变原生事实。
- selected_sites、邻频双频标量表达限制及优化预筛选曲线边界见上文。不得把本组单元/轻量对接通过外推为真实HTTP、浏览器或完整DEM验收。
- 相关提交：未提交，遵守本轮禁止 Git 提交要求。主台账 docs03/12/16 由主集成同步；本组不修改共享文件。
- 当前已有本轮API由主集成启动；本组未请求、重启或修改该进程及其库。主集成统一重启载入本组最终代码后，再执行真实HTTP和浏览器验证，本组70项通过不替代这些验证。

本组不提交 Git，不启动服务，不操作原5183及任何现有运行库；保留用户未提交 docs12、docs/review 等文件。
