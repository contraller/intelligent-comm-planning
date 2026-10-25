# R4-D 新版规划结果接线与展示

日期：2026-10-24。状态：本组实现和测试补充完成，写集所有权交回主集成，统一运行四文件测试、类型检查及浏览器验收。D组停止修改。

## 独占写集

以下路径相对 `front_design/radio-planning-20261022/`：

- `src/views/PlanningApiView.vue`
- `src/types/planning-result-details.ts`
- `src/types/planning-candidates.ts`
- `src/services/planning-result-details-validation.ts`
- `src/services/planning-result-details-display.ts`
- `src/components/PlanningApiResultPanel.vue`
- `tests/planning-result-details.test.ts`
- `tests/planning-api-http.test.ts`
- `tests/planning-result-components.test.ts`
- `tests/planning-api-integration.test.ts`

另含本记录。实际 decoder 为既有 `planning-result-details-validation.ts`，不新增同职 decode 文件。
共享 stores、HTTP、domain、AppShell、后端及主台账保持主集成所有权；需要扩展时先报主审核。

## 已批准契约

- B 组沿既有 `result_details` 输出路由质量、逐链路频率、冲突、缺口及不可达需求，身份必须与当前冻结配置一致。
- 可选 `deploymentSummary`：`mode: 'MIN_COUNT' | 'FIXED_COUNT' | null`；`requestedCount/actualCount/requestedSolutionCount/returnedSolutionCount/lowerBound: number | null`；`countSatisfied/provedOptimal: boolean | null`；`shortfallReasons/forcedSiteIds: string[] | null`。提供对象时字段完整，数量为非负安全整数；旧快照缺省保留，不回填。
- 候选增加可选 `unavailableReasons: string[] | null` 和 `dataSources: string[] | null`；主已确认A的 `data_sources` 为严格字符串标签并批准类型、解码及展示。旧快照缺省保留，null和明确空数组分别展示；非列表、对象、非字符串或空白标签拒收。
- 来源标签按原文显示，保留来源文件、近似方法和待确认限制。已将主提供的 `道路：roads_taihang.geojson.gz；250m距离栅格近似，通行条件待确认` 用于原文保留断言，不拆分标签内部标点或改写科学来源。
- 新增部署单元数仍读取当前对象的服务字段，不从节点、设备或候选条数计算。部署摘要各项也只读服务声明，不推算数量满足或最优性。
- 保存的 REFERENCE 原因复用该方案 `outcome.message/gap/suggestions`；规划坐标缺失显示未提供，不伪称沿用输入。
- `null`、空集合、0、false 分别保留；不新增手动调频、ML、倾角算法或候选写入能力。

## 实施与验证

- 已实施：类型与严格解码、既有部署页摘要、候选限制说明、保存方案原因及坐标缺值提示。新摘要的 `actualCount:null` 不借旧 `radioCount` 填充；缺摘要才保留旧当前对象的数量来源。覆盖轮廓缺值不再显示为0。
- 已补测试但未运行：旧快照兼容、数量/布尔/集合边界、候选来源和限制的严格类型与原文保留、损坏响应拒收、HTTP 回读、实际组件展示及切换隔离。四个测试文件均为既有文件，本组没有新增测试目录或缓存。
- 尚未执行前端测试、类型检查、构建、真实 HTTP 或浏览器验收；不登记为通过。
- 只读静态检查：本组10个新版文件的 `git diff --check` 退出0；连同本记录共11个文件通过严格UTF-8解码且无BOM。Git提示后续可能按仓库配置转换CRLF，此提示不等于当前存在BOM或差异空白错误。
- 本组不启动服务、不操作现有运行库、不复制依赖、不新增缓存、不修改用户未跟踪资料、不提交 Git。
- 主集成完成验证后，将实际证据同步至 `docs/design/12_后端接口实施进度.md`；本记录不替代主台账。

## 主集成交接

- 主已确认 B 将 `candidate_filter.unavailable_reasons:{site_id,field,reason}[]` 投影为稳定中文字符串，并同步 `data_sources:string[]` 至 `candidateScreening.dataSources`；前端严格接收批准类型，不接原生对象。
- `deployment_solve.shortfall_reasons` 为字符串数组，`constraint_issues` 为独立原生对象数组。B负责将具体约束原因也投影到 `shortfallReasons`；前端完整显示服务字符串，不从计数或问题集合伪造通过。HTTP页面组合测试已加入强制点约束原因及 `countSatisfied:false` 展示断言。
- 部署摘要的所有十项字段已按主批准类型接入，不从实际数量与请求数量推导 `countSatisfied`，不从下界推导 `provedOptimal`。
- 主报告独立环境真实HTTP23项通过，入口 `http://127.0.0.22:5322/`。这是主提供的独立环境证据，D组未执行或独立复核，不能作为本组四文件、类型或浏览器通过记录。

## 主集成建议验证命令

工作目录：`F:\work\project2026-1\front_design\radio-planning-20261022`。仅使用现有依赖，测试缓存和临时目录由主统一限定在已批准的F盘目录。

```powershell
npm test -- tests/planning-result-details.test.ts tests/planning-api-http.test.ts tests/planning-result-components.test.ts tests/planning-api-integration.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck
```

以上命令由主集成运行；本组未执行，也未作通过声明。真实HTTP和浏览器验收继续由主集成单独记录。
