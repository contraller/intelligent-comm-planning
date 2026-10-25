# R6 子组 A：态势刷新前端链路分析与待批白名单

日期：2026-10-24。状态：A1、A2 和显式跟随模式已获内部批准并实施；定向验证完成，真实浏览器性能采样交总集成。初始只读分析见第 1 至 7 节，最终实施与证据见第 8 节。

## 1. 范围与现场保护

- 唯一前端目录：`front_design/radio-planning-20261022/`。
- 用户点名的 `src/stores/gis.ts` 不存在，实际宿主为 `src/stores/gis-workspace.ts`，由 `SituationView.vue` 引用。未新建兼容文件。
- 已只读核对接口进度台账、现有 PAR-01 内部批准记录及实际状态导入入口。共享 `main.py`、`http.ts`、`domain.ts`、docs03/12/16 均不修改；接口流程变化后的总台账登记由总集成负责人执行。
- 不操作 `old_front/`、原 5183、运行库、迁移、认证或权限语义，不启动或停止服务，不复制依赖，不运行全仓测试、全项目类型检查或构建，不提交或推送。
- 工作区已有其他组脏改动。下列八个已分析生产文件在记录前的定向 `git status --short` 均无修改；批准后编辑前必须重读文件及定向 diff，不能凭本次基线覆盖后来改动。
- 本阶段只新增本文件，未创建测试目录、测试脚本、截图或日志，未执行自动化测试、HTTP 联调或浏览器验收。
- 后续测试产物独占目录预留：`F:/work/project2026-1/data/runtime/r6/808d094b-3c01-4ad7-99a3-6abd645ddfb7/`。报告、临时配置、缓存、截图、录屏、HAR、下载及日志均放该目录；复用主目录依赖，测试缓存和配置加载临时文件也须显式隔离。

## 2. 规范来源与边界

| 来源 | 已核对内容 | 对本次验收的约束 |
|---|---|---|
| `docs/input/【非密】短波规划要求.docx`，技术指标第 6 项 | “态势刷新时间：≤1分钟。” | 时限为 60 秒；不是覆盖计算耗时、地图加载尺寸或定时器配置值 |
| 根目录 `无线需规v3(3).docx`，SR-1.2.2.5.6.1 功能要求 d、主事件流第 6 步 | 支持设备状态、性能参数、频谱数据实时刷新，按配置周期同步更新态势展示 | 须看到新数据、状态及来源发生一致变化，单次 GET 成功不等于呈现完成 |
| `docs/draft/3.2-csci-capability-requirements.md:427`，SR-3.2-053 | 刷新时间不大于 1 分钟，合格性方法为测试，追踪原始技术要求 | 是本库需求编号依据，不以本分析新增验收门限 |
| `docs/draft/3.11-computer-resource-requirements.md:100`，SR-3.11-012；`docs/draft/3.12-design-and-implementation-constraints.md:169`，SR-3.12-019 | 传输及展示在不大于 1 分钟周期内完成 | 请求、校验、状态提交及呈现都属于待测链路 |
| `docs/draft/3.4-software-internal-interface-requirements.md:31`，IF-3.4-001 | 接口失败记录异常并保留最近一次有效状态 | 同一身份和同一资源来源下，失败不应将旧有效明细清空；失权或换身份仍遵守现有清理边界 |
| `docs/design/03_接口文档.md:1401`、`:1403` | PAR-01 是 1 至 3600 秒整数；仅控制可见 GIS 状态快照目录后台刷新，不采集、不自动切换用户快照 | 这是当前已实施契约，不能把自动跟随新快照作为无须审批的小修 |
| `docs/design/parallel/R2-P02.md:154` 至 PAR-01 消费者批准段 | 目录暂存、显式刷新应用；失败不改变前台消息、选中快照、图层、回放；按条件暂停及取消 | 本次修补须保留这些语义。时限需求与自动呈现缺口须明确报告，不能悄悄改旧约定 |

DOCX 依据由 ZIP 内 `word/document.xml` 的段落及表格文字读取，未改源文件。原始要求技术指标在 XML 段落 41；v3 中本条标题在段落 232、功能要求 d 在 238、主事件流第 6 步在 258。段落号仅供复核，不充当 Word 页码。

## 3. 当前真实链路

### 3.1 运行参数与后台目录

1. `layouts/AppShell.vue:135` 绑定唯一 `runtime-parameters` 实例，按当前会话读取 `collaborationHttp.runtimeParameters`。`stores/system.ts` 仅在参数保存成功或成功核实原回执后触发该实例刷新。
2. `components/GisPlanOperations.vue:532` 至 `:575` 是 HTTP 模式 PAR-01 的实际消费者，标识 `gis.device-status-directory`。进入已保存方案的“设备状态”页签且文档可见、有既有权限、参数有效、没有脏导入或未核实写入时启用。
3. `services/gis-status-refresh.ts:14` 至 `:78` 使用 `setTimeout` 串行调度。首次等待完整间隔；读取完成后再等待下一间隔，不补发遗漏轮次。身份、资源、参数变化取消旧 timer 和 signal，`dispose()` 停止排队。
4. `ResourceStatusPanel.vue:115` 至 `:133` 的后台读取只调用 `listSnapshots`，按当前目录页码和页容量查询同资源版本，结果写入 `stagedDirectory`。不写可见 `status.snapshots`，不读新快照明细。
5. 只有用户点“读取批次”，`:134` 至 `:143` 才应用暂存目录；之后仍需用户选中某个批次才读取该批次状态。
6. `GisPlanOperations.vue:565` 在调度具备运行条件时报告参数已应用。该回执表示本标签消费者采用参数，不是成功完成了一次数据刷新，更不是地图渲染完成时间。

### 3.2 状态导入、选择和表格

1. `ResourcesView.vue` 和 `GisPlanOperations.vue:36` 使用同一个 `ResourceStatusPanel`、`resource-status` store；GIS 历史资源版本不得导入，当前资源仍需既有专项导入权限。
2. 面板解析原始 JSON，`stores/resource-status.ts:105` 深捕获提交记录后调用 `DeviceStatusClient.importSnapshot`，实际路径为 `POST /api/v1/device-status/imports`。这是真实持久化构造状态的入口，不是遥测接收器。
3. 成功回执保存 `request_id`、`snapshot_id`、`snapshot_revision`、`resource_revision`、`imported_at`；随后仅 `list(1)` 更新目录，不自动选择导入批次。失败保留原请求号用于核实；`verifyImport()` 成功不自行读取目录。
4. 显式选中批次经过 `GET /snapshots/{id}` 再经 `GET /snapshots/{id}/devices`。`stores/resource-status.ts:58` 至 `:79` 管理表头、当前明细页及累积已读取记录；未读取设备保持未知，不用基线补齐。
5. `ResourceStatusPanel` 的快照明细表和 `DeviceMonitoringPanel` 通过同一 store 的批次及投影展示设备状态。后者每条已有状态可显示快照 ID、修订和采集时间；面板本身尚未统一显示所选修订与本次读取成功时间。
6. 目录服务按 `imported_at DESC, snapshot_id DESC` 分页（`algorithm-service/app/device_status_service.py:197`）。后台查询当前页，不保证当前页包含最新批次，尤其不能用第二页首项冒称全局最新。这里只读核对服务实现，未连接任何数据库。

### 3.3 地图

- HTTP 下默认“当前资源”地图：`SituationView.vue:1268`、`:2292`、`:2309` 使用 `gis.scene`、资源目录及资源设备点。顶部“刷新资源”走 `useGisResourceWorkspace.refresh()`，不是状态目录定时器。
- `SituationView.vue:1916` 明确以 `!httpMode` 启用旧监控回放；旧 `monitoring`/`system` mock 播放周期不能作为 HTTP 新状态刷新证据。
- HTTP 下“已保存方案”地图：`GisFrozenPlanPanel.vue:119` 只向 `MapCanvas` 传 `model.network`；状态投影 `anchor/projections` 停留在子组件 `GisPlanOperations.vue:389` 至 `:405` 及表格内，没有回传父地图。
- `MapCanvas.vue:1089` 调用 `gisPlanLayer`，`maps/gis-plan-layers.ts` 读取冻结节点自身的 `node.status/node.alert`。设备快照状态与节点冻结状态不是同一数据对象，不能将一个设备的故障直接推成整节点或链路故障。
- 资源刷新也有分阶段读取：`stores/resource-read.ts:99` 先整批替换资源上下文、frame 和详情，`useGisResourceWorkspace.ts` 随后读取目录，`gis-workspace.ts` 另读 scene。不能把 `read.refresh()` 返回成功当作所有 GIS 展示来源均已刷新；scene 失败后的整体来源提示应在后续真实浏览器场景中单独观察。

## 4. 结论与问题分级

| 编号 | 级别及性质 | 精确依据 | 建议 |
|---|---|---|---|
| R6-A-01 | 高，验收缺口；符合旧目录暂存约定 | `ResourceStatusPanel.vue:129` 只暂存，`:134` 才显式应用；已选批次不变 | 增加独立可见的“有待应用目录更新”、最近成功检查及失败状态；保留显式选择语义。自动状态刷新验收仍不能据此标通过 |
| R6-A-02 | 高，地图与状态表不是同一来源 | `GisFrozenPlanPanel.vue:123`、`GisPlanOperations.vue:389`、`MapCanvas.vue:1089` | 增加可选的独立设备状态叠加层，精确按设备 ID 和同版锚点投影；冻结方案节点、链路及算法预测来源继续明确标识，不覆盖冻结对象，不派生链路实测 |
| R6-A-03 | 高，失败保留缺陷 | `stores/resource-status.ts:64` 在新表头成功后立即清空旧记录，`:66` 才读取明细 | 新表头及首明细页均读取、校验成功后一次提交；第二步失败继续保留旧批次、旧记录、旧筛选及旧投影，另外显示读取失败。`setFilter()` 也须避免先改筛选后失败却展示旧筛选数据 |
| R6-A-04 | 中，缺乏可观察的刷新结果 | 调度 `.catch()` 静默，面板后台捕获返回 false；`display()` 的 `fetchedAt` 恒为 undefined | 分别显示“最近检查成功时间”和“当前状态应用成功时间”、当前状态修订、暂停原因与检查失败；不覆盖前台业务错误，不把服务器采集时间改写成本地时间 |
| R6-A-05 | 中，调度周期不等于端到端时限 | `gis-status-refresh.ts:57` 完成后再排队，允许 PAR-01 达 3600 秒 | 单轮请求耗时为 L 时，相邻开始间隔为 L+P；配置 P=60 秒也不能保证含网络和绘制的 60 秒。记录实际等待、请求和呈现用时，不能仅断言定时器为 30 秒即合格 |
| R6-A-06 | 中，资源主视图为独立刷新链 | `useGisResourceWorkspace.refresh()` 与 `gis-workspace.loadScene()` 分阶段提交 | 本批先核验资源来源标签、scene 失败和旧数据保留的实际表现；未证实前不改该 store，不将资源版本更新等同状态快照更新 |

现有保护的静态结论：调度器 `running` 防止自身重入；来源切换、隐藏页签、失权及卸载会取消后台 signal；面板另按身份代次、client、资源版本、目录页及旧目录对象校验晚响应；后台失败保留前台目录及业务消息。若底层忽略 abort 且不结束 Promise，新轮会一直等待旧 Promise 结束。现阶段没有浏览器或故障注入证据证明这些边界全部通过，不登记“已通过”。

当前“无自动切换快照”的约定与“新状态按周期自动呈现”的目标不能同时通过同一条端到端用例。推荐先批准下面的局部修补，自动跟随应作为独立决策：只对明确的当前状态视图启用，用户所选历史快照继续固定；不得借目录刷新静默变更旧契约。

## 5. 待内部批准的精确文件白名单

以下是申请范围，不是已获授权。所有路径均相对 `front_design/radio-planning-20261022/`。建议按 A1、A2 分批批准，任一批均不包含自动跟随新快照或变更 PAR-01 契约。

### A1：确定性缺陷及刷新可观察性

| 操作 | 文件 | 允许的最小修改 |
|---|---|---|
| 修改 | `src/stores/resource-status.ts` | 表头与首明细页原子切换、筛选失败保留旧有效展示；记录成功应用时间与相应版本，不改 HTTP DTO、导入权限、请求幂等或身份语义 |
| 修改 | `src/components/ResourceStatusPanel.vue` | 显示已检查目录的时间、状态、待应用更新及所选快照修订和应用时间；后台仍暂存，不自动选批次，不重排可见目录，不覆盖前台 busy/error/notice |
| 修改 | `src/components/GisPlanOperations.vue` | 显示消费周期、参数 epoch/revision 和暂停状态；向父层传递同版已选状态投影及清理事件，维护现有调度与生命周期保护 |

### A2：地图与已选状态表的同源呈现

| 操作 | 文件 | 允许的最小修改 |
|---|---|---|
| 修改 | `src/components/GisFrozenPlanPanel.vue` | 接收已选状态锚点及设备投影，给父地图传可选叠加数据，显示其来源和时间；换网络、失权、卸载清理，不混入当前资源或其他方案 |
| 修改 | `src/components/MapCanvas.vue` | 新增可选设备状态叠加入口，浅监听更新该层及实际绘制版本；不触发 fit、不重建底图或覆盖、不改原冻结节点及链路状态 |
| 新增 | `src/maps/gis-device-status-layer.ts` | 纯投影及独立 OL 设备状态层：设备 ID 必须属于冻结网络且状态锚点三元组一致；坐标来自该网络绑定站点；未知状态明确呈现，不聚合推导节点或链路状态 |

A2 的建议实现按设备表达，使用已有状态样式与选中设备联动能力；不修改共享 domain 类型。仅有 A1 时，不声称地图和表格已完成同源刷新。

### 定向测试源码白名单

| 操作 | 文件 | 覆盖内容 |
|---|---|---|
| 修改 | `tests/device-status-snapshots.test.ts` | 新表头成功但明细失败、筛选失败、晚响应和版本不匹配；确认旧有效状态保留 |
| 修改 | `tests/resource-status-components.test.ts` | 实际模板可见的目录检查时间、更新提示、失败及应用时间，延续暂存/显式选择断言 |
| 修改 | `tests/gis-plan-operations.test.ts` | 消费周期及来源接线断言；静态测试只登记为静态证据 |
| 修改 | `tests/gis-frozen-plan-panel.test.ts` | 独立状态源和父地图接线，换方案清理；不能仅靠该文件宣称浏览器绘制通过 |
| 新增 | `tests/gis-device-status-layer.test.ts` | 真实 OL 要素的设备状态、三元组错配拒绝、未知值及更新/清理，不从设备状态推导链路 |

`services/gis-status-refresh.ts`、`stores/gis-workspace.ts`、`views/SituationView.vue` 及旧监控链路建议继续只读；现有 `tests/gis-status-refresh.test.ts` 可定向运行，无需预先修改。若后续证实调度或主资源 scene 缺陷，另报具体差异和白名单，不扩用本批批准。

## 6. 浏览器及性能验收方法

### 6.1 可观察字段

所有时间先区分来源：`observed_at` 是快照声明的采集时间，可以为 null；`imported_at` 是服务器导入记录时间；本地“检查成功”“状态应用成功”“地图已绘制”分别记录不同事件。`device_status_service.py:160` 在提交事务前生成 `imported_at`，因此它也不能直接当作精确提交完成时刻。

每份证据须同时具备：本次浏览器实际加载的源码或资产标识、页面 URL、会话代次、网络 plan/snapshot 身份、资源版本、状态快照 ID/修订、设备 ID、状态/告警、采集时间、目录检查成功时间、状态应用时间、绘制完成时间、PAR-01 值及参数 epoch/revision。缺少的数据标记未知，不伪造值。

目录“最近检查成功”只在有效响应经身份及版本校验后更新；状态“最近应用成功”只在整组表头/明细原子提交后更新；地图“已绘制版本”须由渲染完成事件和同版要素共同证明。定时器回调触发、参数已应用、Vue nextTick 或截图尺寸均不单独证明地图已呈现新状态。

### 6.2 用例与判定

| 用例 | 操作与可观察结果 | 本阶段结果 |
|---|---|---|
| A-DIR | 已有有效状态 A，另一隔离导入入口提交同资源状态 B；等待一个有效周期。记录目录检查成功时间、待应用目录版本变化，当前历史选择 A 不被替换；点“读取批次”后看见 B | 未执行；现状后台无可见更新提示 |
| A-APPLY | 明确选中 B。表头 ID/修订、状态表指定设备的 NORMAL 到 FAULT 等实际变化，以及独立设备状态地图层的同一设备状态、告警、采集时间一致；其他未读成员保持未知 | 未执行；现状地图未接状态投影 |
| A-FAIL | 在 B 表头成功后使明细失败；A 的 ID/修订、明细、图层及最后成功应用时间保持，另有失败提示；恢复后显式重试可原子切换 B。筛选失败同样不把旧行标成新筛选 | 未执行；源码已发现清空旧状态的路径 |
| A-LIFE | 慢请求跨两个周期无重入；离开设备页、隐藏文档、离页、换会话、换资源及失权时停止后台请求；强制返回晚响应不能更改新来源，恢复后不补发累积轮次 | 未执行；现有逻辑及测试源码支持该设计，尚无本轮执行证据 |
| A-IMPORT | 实际浏览器提交构造状态，核对导入回执与 GET 回读；导入前后资源 revision 不变；超时核实原号，不能二次生成新请求号冒充重试；构造数据标签可见 | 未执行；仅核对实际代码路径 |
| A-PERF | 前台可见、授权有效、无编辑阻塞的当前状态场景；在后端状态 B 可读后，自动观察到表格及地图同版 B，记录最晚呈现时刻减起点，要求不大于 60000 ms | 未执行；当前固定快照+暂存契约无法完成这条自动呈现用例，不能登记通过 |
| A-RESOURCE | 当前资源视图点击“刷新资源”，在 scene 请求失败时核对来源标签、目录、主图是否明确保留或降级；不得由 workspace 已更新冒称 scene 刷新成功 | 未执行；后续观察项，非当前生产修改白名单 |

性能时间建议分段记录 `t_send`、`t_ack`、`t_poll_start`、`t_response`、`t_apply`、`t_table_visible`、`t_map_rendercomplete`。表格用真实可见行的状态与版本匹配证明，地图用同版 OL 要素加 rendercomplete 和截图证明；终点取二者较晚者，不能只取首个 HTTP 200。

起点优先用隔离服务的可信提交完成记录，跨进程时间须交代同机时钟或同步方式。没有精确服务端提交时刻时，同一测试控制器用单调时钟从导入请求发送前计到最终可见，可作为包含导入过程的保守上界；导入回执收到后才开始计时只是下界，不能独立证明全部刷新时限。`observed_at`、导入历史时间与本地单调时钟不可直接相减。

至少观察“刚好错过一次轮询后才提交 B”的等待路径，再记录连续变更和慢响应路径；次数及分位数是测试设计，不冒充需求原定次数或分位门限。失败、隐藏、失权、无效配置、尚未批准自动跟随等场景应单列实际结果和原因，不能混进成功样本或用剔除方式宣称满足 60 秒。显式点击应用只能形成点击到呈现耗时，不能替代 A-PERF。

批准后先复用现有主目录依赖做上述白名单的定向验证，不做构建。真实浏览器仅使用总集成提供并已确认隔离的运行入口；先核验该入口实际加载本次源码及数据目录。若现有服务没有加载新源码，则记录源码测试结果及浏览器版本不匹配，等待集成负责人准备入口，不启动、停止或修改任何服务，也不把旧运行包结果归给新源码。

## 7. 本次只读基线

以下为记录前 SHA-256，后续发现不一致时重读差异并与并行修改协作，不回写旧内容。

```text
src/services/gis-status-refresh.ts 16D69B8A51FE5692D66584D98725A2F61AD39FC208020CBC5144C54C79AF200C
src/stores/gis-workspace.ts B6D9B1056C98E8EB421474733BBC31847FEBE08781DE3A24A4F0BA2C77AB1D8F
src/stores/resource-status.ts 4D050D022A67AD405E0380F0D51E94C2E5B22DAAF523D523D680F9C41742C9F6
src/components/ResourceStatusPanel.vue 867D209A8E29E6EF4CB1B20EB2514E9D7C5B5F1EE0A61EEA9A941F701406E85A
src/components/GisPlanOperations.vue E44C21367A563BF355255F01A4FFFCA2DB39EC8B35529911E53B3680D08DC4E0
src/components/GisFrozenPlanPanel.vue 7223E00E54D9EC72BB305A66144CDD69DF9D60885AFAF9CE34BFD87428794971
src/components/MapCanvas.vue 387CF949C78D11123518BB94FC39B80879648BAFCFA0BF6E196934802C0D1495
src/views/SituationView.vue 1547DBC4A4161CA75FD16F659D564CED5087A109889626E3D765F3688AB17734
```

初始分析交接时仅新增本记录，未执行测试，随后收到内部批准并转入实施，结果如下。

## 8. 内部批准后的实施与验证

### 8.1 批准范围与最终行为

本会话后续明确批准 A1、A2、五个测试文件，并批准同批增加“固定批次/跟随最新”模式；必要时可最小扩展调度器及其测试。本批实际只修改已批六个生产文件和五个测试文件；`gis-status-refresh.ts` 及其测试保持源码不变，后者仅定向执行。未增加额外生产文件。

- 默认固定批次。PAR-01 原目录检查行为保留，后台目录结果仍暂存，页面独立显示最近检查成功时间、待应用提示及后台失败；不覆盖前台业务消息。
- 只有用户显式选择“跟随最新”才按周期查询同资源第一页最新批次。仅当前资源版本匹配的 GIS 宿主开放此选择；历史批次按钮或历史观测引用选择均回到固定模式。切换资源、身份代次及失权按原边界取消，不能自动将旧跟随授权延续至新来源。
- 可见设备状态页、既有查看权限、有效运行参数、无脏导入输入、无待核实原号、无配置操作时才后台读取；暂停原因、实际周期和参数修订可见。不修改 PAR-01 的 1 至 3600 秒范围，超过 60 秒显式提示验收风险；周期与请求/绘制耗时分别表达。
- GIS 固定批次选择和跟随更新均读取完整状态批次，每页 100 条、总数最多 1000 条，最多 10 页。414 条状态用 5 页读取。逐页校验快照 ID、修订、资源版本、页码、容量、总数、排序、重复成员，完整读取后核对状态分类计数；任何一步失败保留旧有效批次、明细、筛选、地图投影及成功时间。
- 表头、明细、记录集、筛选及应用时间通过同一不可变选择对象一次发布。可见明细仍按 20 行分页；地图投影使用完整记录集，不以首屏 20 行代替完整状态。普通资源台账入口沿用其既有分页契约。
- 独立设备状态层按冻结网络设备 ID 和站点坐标投影，严格匹配网络 task/plan/snapshot 及状态 snapshot/revision/resource 锚点。未包含、未读取或锚点不符的设备为未知，不拿基线补正常，不更新冻结节点或链路状态，也不从设备故障派生链路实测。
- 新层复用既有设备聚合和样式，浅监听更新自身，不调用地图 fit，不重建底图或覆盖图；单设备点击联动已有设备选择，多成员聚合不遮断底层原节点选择。
- 地图完成证据要求该状态层触发实际 `postrender`，随后地图以同一帧触发 `rendercomplete`，且目标 DOM 已连接、具有可见尺寸、文档可见、该层仍属于当前地图。晚帧、错版本、隐藏目标和已移除图层均不能报告完成。父面板可见锚点只接受当前版本首个完成回执，切换版本时先清空旧完成时间。

### 8.2 总集成浏览器采样入口

以下选择器由实际模板渲染，不是测试脚本临时注入。采样前显式打开同版已保存网络，进入设备状态页，显式选择“跟随最新”，再通过隔离导入入口导入新状态；应选冻结网络和资源状态批次均包含的设备作为状态变化检查对象。

| 选择器 | 可观察内容及使用方法 |
|---|---|
| `input[type="radio"][value="fixed"]`、`input[type="radio"][value="latest"]` | 固定/跟随的真实选项；默认前者。需在“状态刷新方式”fieldset 内定位，避免匹配其他组件 |
| `[data-testid="gis-status-cycle"]` | 文本含周期、参数修订、启用/暂停或刷新状态；`data-interval-seconds`、`data-parameter-revision`、`data-parameter-epoch` 对应当前运行参数 |
| `[data-testid="gis-status-refresh"]` | `data-mode`、`data-checked-at`；只表示检查成功，不是地图完成 |
| `[data-testid="gis-status-state"]` | 当前状态批次 ID、修订、资源版本、成功应用时间及已读取记录数；属性 `data-snapshot-id`、`data-snapshot-revision`、`data-resource-revision`、`data-applied-at` |
| `section[aria-label="快照明细"] tr[data-device-id]` | 每个可见设备行含 `data-device-id`、`data-status`、`data-snapshot-revision`，正文显示状态、告警、采集时间。`UNKNOWN` 保留未知，不统计为正常 |
| `[data-testid="gis-device-status-render"]` | 可见文本含设备状态批次、修订、资源及“等待地图绘制完成”或实际完成时间；属性除上述三元组和应用时间外，还有 `data-network-snapshot-id`、`data-rendered-at`、`data-point-count` |

判定地图就绪必须同时满足：锚点可见、`data-rendered-at` 非空、状态 ID/修订/资源与表格一致、`data-applied-at` 与当前表格一致、网络 snapshot 与本次打开的冻结网络一致，并检查目标设备实际状态及地图颜色。单独读取到非空的旧时间不算新版本完成。

`data-point-count` 是冻结网络中本层具备坐标的设备要素数，不是资源全库数量，也不等于全部记录都具有已知状态；批次完整性看状态面板“已读 N/总数 N”。采集时间、导入时间、检查时间、应用时间和地图完成时间继续分别保留。不存在端到端计时结果时，不用上述时间字段推算成已经通过 60 秒。

性能起点和终点仍采用第 6 节方法。最终判定包含等待周期、所有必要分页、状态发布、表格可见及实际地图绘制；覆盖计算用时、固定地图尺寸、参数已应用或仅 nextTick 均不代替该结果。

### 8.3 实际验证结果与产物

全部产物在 `F:/work/project2026-1/data/runtime/r6/808d094b-3c01-4ad7-99a3-6abd645ddfb7/`，复用主前端 `node_modules`，使用宿主已配 Node 运行时。临时 Vitest 配置与缓存路径均在该目录，原依赖和正式 Vite 配置未改。

最终命令在主前端目录执行：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'node_modules/vitest/vitest.mjs' run --config 'F:/work/project2026-1/data/runtime/r6/808d094b-3c01-4ad7-99a3-6abd645ddfb7/vitest.config.mjs' --configLoader native
```

最终同一轮 6 文件 112 项全部通过，耗时 75.54 秒，报告 `results-complete.json`：

| 文件 | 通过数 | 证据性质 |
|---|---:|---|
| `resource-status-components.test.ts` | 49 | 真实面板模板 + 内存宿主 + 注入客户端，含模式、可见版本/时间、失败保留；不是浏览器 |
| `device-status-snapshots.test.ts` | 24 | 真实 Pinia store + 客户端桩，含完整 414 条、1000 条分页上限、同步观察原子性、错页/重复/错版本/失败/晚响应 |
| `gis-plan-operations.test.ts` | 13 | 静态接线边界，含默认目录范围、显式跟随、周期风险和地图入口 |
| `gis-frozen-plan-panel.test.ts` | 6 | 真实父模板 + 子组件桩，检查可见锚点等待/完成/错版本拒绝及清理；不以桩证明实际画布 |
| `gis-device-status-layer.test.ts` | 7 | 真实 OL 图层、几何及设备要素；通过分发 OL 事件检验帧、可见性、来源及监听释放，未运行浏览器画布 |
| `gis-status-refresh.test.ts` | 13 | 既有纯调度器假时钟测试，本批未修改源码 |

另执行定向 TS 源码及带类型 Vue 宏检查、4 个实际 SFC 的脚本和模板编译，最终 `target-checks-complete.json` 中模板错误 0、所列文件诊断 0。该检查只报告本批目标文件，不是全项目 vue-tsc 或构建。

过程失败如实保留：`results.json` 为 runner 配置加载导致两个组件套件未执行；`results-native.json` 为父模板测试缺少无关覆盖子组件的 Pinia 上下文；`results-final.json` 为该测试桩尚未暴露 requestLeave，1 项失败。只在获批父模板测试内补齐子组件隔离及公开方法，最终报告为 `results-complete.json`，不将失败轮次登记为通过或累加测试数。`target-checks.json` 是初次对编译产物检查产生的宏类型丢失诊断，改为带类型原始脚本后复核；`target-checks-source.json` 为中间通过记录，最终以 complete 报告为准。

对总集成已运行的 `http://127.0.0.24:5324/src/components/GisFrozenPlanPanel.vue` 仅执行只读 GET，返回 200、JavaScript，内容含 `gis-device-status-render` 和状态叠加入口。这只确认该入口可读取含本批锚点的模块，不代表已执行真实浏览器导入、地图绘制或性能采样。未连接运行库，未启动、停止或重启 5324/8124 及其他服务。

最终 `git diff --check` 的已改目标文件无空白错误。生产文件、测试文件和本记录保持 UTF-8 无 BOM；不覆盖其他组已有脏改动，无提交、无推送。共享 docs03/12/16 的流程与验收状态变更由总集成据本记录登记，本组没有修改这些文件。

当前交接结论：前端实现及定向测试完成；真实浏览器功能与“后端新状态到地图/表格不大于 60 秒”的性能验收仍待总集成在隔离入口实际采样，不登记已通过。

### 8.4 后续授权：采纳详情父层接线待 E 契约

总集成后续授权 E 新增独立 `InterferenceAdoptionDetailDrawer.vue` 和专项测试，A 继续独占 `GisPlanOperations.vue` 并负责最小父层接线。范围仅为既有只读采纳详情，不扩接口、权限或逐源编辑。

已只读核实：`InterferenceMeasureDrawer` 发出 `openAdoption({ adoptionId })`；真实 `AdoptionDetail` 已含 `task_id`、`run_id`、`measure_id`、`source_hash`，现有查询是 `InterferenceWorkbenchServices.getAdoption({ task_id, adoption_id }, signal)`。父层须从当前 `analysis.adoptions` 核对被点击 ID、当前分析及措施，不能用当前规划任务猜测另一条采纳身份；切换分析、网络、会话或失权时清理详情选择。

初次交接时 E 的组件及契约尚未落盘，故当时没有添加猜测属性或不存在的导入。后续已读取 E 实际组件契约：`visible`、`taskId`、`adoptionId`、`services: Pick<InterferenceWorkbenchServices, 'getAdoption' | 'getRun'>`，关闭事件为 `update:visible(false)`。A 在后续源码冻结指令前仅修改获批父组件，接通 `open-adoption`，并在原静态接线测试内补一项门禁。没有修改 E 的组件或专项测试。

打开前核对既有 `analysis.readable`、当前干扰页、真实采纳与当前分析的 task/run/measure/source_hash，查询身份来自匹配后的采纳记录，不猜当前规划任务。切换冻结网络、会话、服务、页签、分析来源、措施或失权会清理选择。该接线只有源码与静态门禁证据，实际抽屉查询及浏览器闭环由 E 专项和总集成验收，不因静态通过登记浏览器完成。

### 8.5 真实 core 发现的只读 busy 阻塞

总集成真实证据 `runtime/browser/r6-browser-1792845104027-ccabeb/CORE-RESOURCE-DETAIL-dom.json` 及同名 PNG 显示：无导入草稿时，目录 list 的 `status.busy` 被误作未提交输入，点击 DV-0001 详情被拦截。内部明确批准后仅最小修改 `ResourceStatusPanel.vue::requestLeave`：先拒绝真实文件读取、待核实导入和脏输入；上述均不存在时取消只读状态请求并放行，清除过时离开提示。未修改 store 或导入、认证、权限语义。

原获批 `resource-status-components.test.ts` 增加两项实际模板回归：目录初始读取未结束但无草稿时 requestLeave 放行、signal 被取消、迟到结果不回写；真实导入 pending 时仍拒绝并且不取消写入，匹配回执完成后才能离开。该文件单独 51 项通过，报告 `results-core-read-leave.json`。没有给主浏览器脚本增加等待目录的规避逻辑；真实页面复验仍由主执行。

### 8.6 性能脚本交付与主接管

后续单独批准新增根目录 `tests/manual/r6_browser_performance.mjs`，复用主 `r6_browser_acceptance.mjs` 的 `page/runtime/taskId/planId/login/record/download/shot` 合同，不自行启动浏览器、服务或登录身份。只读取 B 最终 `563f24e31f094761934e4c067befe138/anchor.json` 和同目录 414 条构造状态 payload，不读取 private，不查询运行库。运行产物独占 `data/runtime/r6/<新 GUID>/`，不复制或安装依赖。

导出入口：`runPerformance` 默认 30 秒配置、3 样本；`runFiveSecondPerformance` 单独 5 秒配置、20 样本；`runPerformanceSamples(args, options)` 允许主明确指定组；`runPerformanceBehavior` 单独验证固定历史、明细读取中断后的失败保留/恢复、离页不再启动轮询。参数由主系统 UI/API 显式配置，脚本只核对周期及 epoch/revision，绝不偷偷修改全局参数。固定的 approved plan 为 `PLAN-5273d94aa08345e4b047d62b915e2928`，资源为 `resource-7c8bd11ec30d0ed4`，未要求主改原任务或方案。

状态写入器是明确标注的 `page.request`：从当前真实 UI 会话获取 CSRF 后 POST 构造导入，每次独立 GUID source_label、request_id，并轮换状态及采集时间以确认新内容版本。它不是浏览器文件导入通过证据。计时由同一 Node 单调时钟在 POST 发送前开始，与实际 UI 观察并行；终点取目标设备表格新状态/告警/采集时间/版本与地图同版 rendercomplete 可见锚点的较晚时刻，不从 ACK 起算。逐样本保存业务锚点与真实 OL viewport PNG，解码检查颜色、非空内容及状态变化前后像素，不拿尺寸或 DOM 属性独立冒称要素已绘制。失败和未观察样本保留在分母中记为无界失败，完整观察但超限的样本保留实际延迟，各配置组分别报告 P50/P95/max/失败数。

脚本初稿交付后主进行首次 preflight，发现 B 的 payload_sha256 是解析对象 canonical digest，而初稿误与缩进文件原始字节 SHA 比较；该次是脚本前置校验失败，不是业务失败。主已明确接管本新脚本写权，按 B canonical 定义严格核验并另外记录原文件字节 SHA，同时接入 bundled PNG 依赖。本组保持脚本不再编辑，已转交目录 `filter(has)` 的内层定位链风险，未登记脚本语法检查或真实浏览器样本已通过。主拥有后续实际执行和修订结果。

### 8.7 冻结与最终定向回归

总集成先为独占 HTTP 复测暂停新测试，解除后本组启动最终六文件回归；随后主要求为浏览器 3×30 秒采样再次冻结生产与新测试时，该回归已在运行，正常结束，没有杀进程。此后不再启动测试、浏览器或 HTTP，不再编辑生产文件及已交主的性能脚本，仅更新本交接记录。

最终 `results-handoff.json`：6 个目标文件、115 项全部通过、0 失败，报告起止约 30.27 秒。分项为组件 51、store 24、静态宿主 14、冻结父模板 6、真实 OL helper 7、既有调度器 13。相较原 112 项增加的是两项只读 busy/写入拒绝模板回归和一项 E 父层静态接线门禁。该轮仍复用同一 GUID 临时配置、主目录依赖和 native loader；没有全仓测试、构建、服务操作或外部 HTTP。已有执行会话均已结束。

先前 `target-checks-complete.json` 的定向类型/模板通过只对应原 112 项阶段的生产内容；新增 E 父层接线后尚未重新执行该类型检查，不将旧报告冒充最终 E 代码已检查。主冻结优先，后续如需复核须等采样结束解冻。最终 115 项是本轮源码定向证据，不替代浏览器。

主报告 HTTP 独立复测 40 样本通过，证据 `data/runtime/r6/8b45b9d7746844cb9165f53b4cd7e958/report.json`；serial max 8.5667 秒/P95 8.3053 秒，4 并发组 max 16.4843 秒/P95 16.3495 秒。这是主提供的 HTTP 结果，本组没有复发请求，不外推表格/地图刷新通过。最终源码浏览器及端到端 60 秒结论由主另行实际采样登记。

### 8.8 GIS 目录阻断后的定向收口

主第二次性能 setup 发现真实 GIS 目录提示“方案历史查询条件无效”，已派 B 修正 GIS context 契约；主另外接管脚本实际目录路径 `/api/v1/plan/saved-plans`，不以切换 planning context 绕过 GIS 授权。本组不改这两处，不改原 task/plan。主明确当时没有性能样本运行，并解除本组冻结以完成 E 和只读 busy 验证。

本轮没有新增生产修改。仅在原已批准 `gis-plan-operations.test.ts` 内新增 14 项真实父模板回归：从措施事件向 E 抽屉传递原采纳任务/编号/服务、关闭销毁、task/run/measure/source_hash 错配及不存在 ID 的拒绝、网络/会话/代次/权限/分析/措施/服务/页签切换后的清理。内存宿主挂载实际父模板、复用既有 `tests/helpers/vue-client.ts`，其余业务子组件和 store 注入为隔离桩；不冒称 E 子抽屉真实查询、浏览器或认证联调通过。没有新增辅助文件。

六文件回归 `results-adoption-handoff.json` 共 129 项全部通过、0 失败，约 76.41 秒；其中父宿主 28 项（原静态 14 + 新实际模板 14），其余文件数目不变。随后定向类型检查在新增只读 busy 导入测试发现 deferred resolver 被声明为 unknown，而真实 Promise 为 DeviceStatusReceipt；只收窄测试类型，未改变生产和测试行为。首次检查失败原样保留于 `target-checks-adoption-handoff.json`，四个生产 SFC 模板错误为 0；修复后另存最终报告，不覆盖失败证据。

最终 `target-checks-adoption-final.json`：4 个生产 SFC 模板错误 0，7 个所列 TS 目标及带类型宏原始脚本诊断 0。该检查仍非全项目 vue-tsc 或构建。仅测试类型修改后的组件复跑 `results-core-read-leave-final.json` 为 51 项全部通过、0 失败；不把重复执行累加为新增测试。新改两份测试和本记录均核对 UTF-8 有效且无 BOM，目标文件 `git diff --check` 无空白错误。所有执行会话正常结束，无遗留测试进程，没有浏览器、HTTP、服务或运行库操作。

本组最终交权状态：E 父层接线及只读 busy 修复已完成并有上述定向证据，生产保持上一冻结时内容；可重新冻结并由主在 GIS 目录契约修复后执行真实样本。本组不再自行编辑主接管的性能脚本，不将 setup 阻断或 HTTP40 结果登记为浏览器性能通过。

## 9. 资源写闭环脚本：已静态准备，禁止提前执行

2026-10-24 后续明确批准仅新增根目录 `tests/manual/r6_browser_resource_writes.mjs` 并更新本记录。2026-10-25 崩溃恢复后再次明确：资源版本 `resource-7c8bd11ec30d0ed4` 冻结，C 的覆盖/SR56、E 的原规划作业及其他下游优先，所有资源写必须最后由主发串行 token 才执行。本组没有启动浏览器、业务 HTTP 或任何资源写；没有新资源业务 ID 或资源写检查点。

### 9.1 入口与实际操作

复用主 harness 的 `Page/runtime/taskId/planId/login/record/download/shot`，不创建 context、库、服务或身份，不读取 private，不安装或复制依赖。主已自行登记 group `resourceWrites`，主 harness、core、performance 均非本组写入范围。

| 导出 | 实际范围与顺序 |
|---|---|
| `runResourceWrites` / default | 先 G04 原任务桥，再 R03–R06，最后 G02/G03。任务桥先于资源变更，不能先使原任务过期再用换任务或改 plan 掩盖 |
| `runResourceTaskBridge` | G04：真实 UI 选择传入原 task，定位一个参与节点/一条通联；返回 GIS 不保存；再仅改名称，保存任务并返回 GIS，重新导航强制回读同 task、input_version、revision、原条件与资源来源 |
| `runResourceLedgerWrites` | R03：一台实际在架设备高度维护、刷新详情回读，继续编辑/明确放弃；R04：复用真实节点/型号/天线及合法设备参数，仅新增一台；R05：只对 R04 新台做下架取消/确认及启用确认，保持原 ID；R06：当前 UI 下载设备 CSV 模板，实际表头和 R04 真实关联形成一行构造新增，预检、继续查看、放弃、重新选择同文件、单次确认及刷新回读 |
| `runResourceGisWrites` | G02：合法高度应用草稿、撤销、重做、统一保存及新编辑基线/表单回读；G03：各一条固定站、干扰源及待评估候选。坐标取实际 DEM 内节点，干扰参数取实际已有源，新源显式未生效，候选取不同节点的同类实际在架设备；不推导物理可通性 |

默认共九个业务 case，另有环境证据。不是运行所有组合；前置不足或任一步失败立即停止，不换型号、任务、节点、原号或扩大强度凑通过。台账保存、文件预检/提交及 GIS 草稿统一保存分开记录，不把应用草稿或下载模板当持久化成功。

脚本中名为 `http` 的 helper 只通过 `page.waitForResponse` 观察 UI 已发出的真实响应，不使用 `page.request/fetch/route.fulfill` 旁路查询或写入。只有 DOM 控件和正常页面导航触发业务。导入使用已有前端 `papaparse` 结构化读取/生成 CSV；未知模板字段直接阻断，不虚构设备型号或未知协议。确认前核对完整实际预检、等待“正在读取并预检…”隐藏及确认按钮启用，不用包含静态“错误”二字的全文判定代替预检完成。

### 9.2 授权、检查点与异常

- 必须由主明确放行后传 `performanceComplete: true`；现有 main CLI 的 `--performance-complete 1` 是主确认性能及下游完成后的执行信号，不得提前传 1。另须提供并沿用 `resourceWritesRunId` 或环境变量 `R6_RESOURCE_WRITES_RUN_ID` 的一个 GUID。没有授权或 GUID 时在登录、页面导航和业务写之前拒绝。
- 本模块证据放 `data/runtime/r6/<GUID>/`，包括 `resource-writes-state.json`、实际模板副本、合法 CSV 和 case PNG。主 record/download 自己的宿主证据仍由主管理。检查点不写认证头、Cookie、CSRF 或 private 内容；导入请求日志仅留文件名及 base64 摘要，实际构造文件独立保留。
- 每个持久化动作在 UI 点击前记 `ARMED`，捕获原 request_id，收到真实回执先登记，再校验单次发出、context/base_revision、新版本、受影响对象及刷新回读；完成后才记 `READBACK_CONFIRMED`。失败/在途 case 在重新登录前阻断，未知结果保留 `UNCERTAIN_NO_RETRY`，不自动重提或换 GUID。复开既有已完成 case 也不自动重复写。
- 检查点先完整写同 GUID 临时文件，再 rename 替换。ENOSPC/其他写失败后 sticky 停止后续落盘，保留上一有效检查点和临时文件，不删除、压缩或重试业务；只向控制台报告已知业务 ID、原号、阶段与版本。`finally` 不再覆写失败磁盘。磁盘正常但已受理/回读失败仍保留原回执，不将其改称业务未提交。
- 恢复上下架只恢复该台标记，不声称恢复旧任务或方案有效性；不恢复初始库、不删除本轮或既有资源。资源变更后的原 plan 可能成为历史，这不是性能结果。

### 9.3 静态检查与崩溃边界

初稿一次 `node --check` 退出 0，随后又做了静态完善，包括原子检查点、ENOSPC 停写、单次请求门禁及合法导入关闭保护。最终增量版本重检时，宿主 Node 在分配内存阶段报 `VirtualAlloc failed`，未到语法判定；后续 import-only 工具 cell 在崩溃后不可恢复，不能登记 import 或最终语法通过。2026-10-25 主限制低内存串行后，不再启动 Node、测试、浏览器或 HTTP；本稿当前状态为“静态准备完成，最终解析待主 token”，不能用初稿通过覆盖增量。

只读恢复已核对：`results-adoption-handoff.json` 129 项通过、`results-core-read-leave-final.json` 51 项通过和 `target-checks-adoption-final.json` 目标诊断 0 的既有文件仍在。`data/runtime/r6` 未找到 `resource-writes-state.json` 或 `system-state.json`。旧工具 cell 不存在；OS Node 进程归属查询被拒，本组未提权或杀进程。本组从未启动测试浏览器，无本组 profile/Edge 需要清理；没有取消、重提 E 的原作业 `tsk-c122e2c8cc06`。

### 9.4 导入关闭与地图来源只读复核

旧 core 的 `panel.innerText().includes('错误')` 会命中静态副标题“任何错误均不写入”，不能证明预检完成。`ResourceLedgerImportDrawer` 的头部事件与 footer 均接 `editor.closeImport()`；`AppDrawer` 转发 PrimeDrawer 的 `update:visible`，store 在 busy 时直接 false，空闲且存在文件时先询问“导入尚未确认”。失败 DOM 是超时后的状态，不能证明关闭点击时已空闲。当前没有证据支持为此修改共享 AppDrawer 或 busy 语义；主已接管 core 的等待/关闭复核，本组不改。

冻结地图静态链核对到：network 到达即发布，surface 单独失败有 groundMessage，不通过全局遮罩阻止 network 显示；已绘制锚点在地图容器外，固定地图尺寸与换行样式保留。没有新增静态证据证明快照全局显示阻塞，也没有本组真实 UI/像素证据可宣称显示通过。

另有独立候选缺陷：当前 `SituationView.vue` 选择已有干扰源转到“干扰分析”，该资源区域只显示“打开方案干扰工作区”；未找到将 `interferenceOpen` 显式置 true 的现有详情入口，虽已有 `InterferenceSourceDrawer` 的只读/编辑能力。新建源可保存，但本脚本仅以真实编辑基线响应和刷新目录 ID/name/active 回读，不假报已有源参数抽屉复开通过。若主要求补入口，建议精确申请 `src/views/SituationView.vue` 与新增 `tests/gis-interference-resource-entry.test.ts`，复用原抽屉、原权限和离开保护，不扩 API 或冻结方案逐源编辑。该范围未获本批地图批准，未修改。

## 10. 可牺牲系统账号/角色脚本：静态方案与检查点

主追加批准仅新增 `tests/manual/r6_browser_system.mjs` 和本记录，后续已登记 main group `system` 并初审通过仅可牺牲对象范围。本组已落盘静态稿，未执行；production auth 及其他用户改动、主 harness 均不修改。当前资源版本继续冻结，系统脚本仍须等主单个串行 token。

导出 `runSystem` / default 及别名 `runSystemAccounts`。调用同一宿主 `page/runtime/login/record`；入口需要 `systemWritesAuthorized: true` 或 `R6_SYSTEM_WRITES_ALLOWED=1`，并提供 `systemRunId` 或 `R6_SYSTEM_RUN_ID` GUID。证据为 `data/runtime/r6/<GUID>/system-state.json` 和主 record 的截图/结论；不建浏览器或库，不直接调用认证/业务 API。

| Case | 真实 UI 操作与判定 |
|---|---|
| 01 | h.login admin 真实登录，读取现有 options/catalog；仅新建 GUID 名角色，勾选 `situation.view` 和实际声明依赖，保存后从列表及权限矩阵重新回读。若依赖扩到系统、知识审核或规划写等范围则阻断，不静默提权 |
| 02 | 只给新角色新增一个 GUID 登录名账号，随机初始密码仅内存；保存后原 accountID/roleID/启用和 mustChangePassword 回读一致。新 ID 不可复用 admin 或既有角色 ID |
| 03 | 对同一个新登录名做一次重复创建，要求明确重复拒绝、可见错误，关闭时明确放弃；回读仍只有原账号，不新造另一个用户名绕过 |
| 04 | 只对新 accountID 做停用取消/确认和启用取消/确认；取消无 state POST，确认后列表/详情回读标记一致。不操作既有 admin/editor/reviewer 或其他账号 |
| 05 | 当前 admin 真实 UI 退出，新账号用实际登录表单登录，核对原 accountID/roleID/权限，并进入首次强制本人改密 |
| 06 | 当前表单 7 字符新密码/确认一致时按钮仍禁用且没有改密请求；8 字符才一次真实提交 `/auth/password`，回执对应原账号/原 requestId 并要求重新认证。不把前端禁用说成后端拒绝 |
| 07 | 用新 8 字符口令真实重新登录、reload 回读身份；无系统/规划/知识入口，直接正常路由到系统应回 GIS。这里只判 UI 权限边界，不冒称已执行服务端 403 测试 |
| finally | 强制经过 `about:blank#/login` 使主 helper 的 activeRole 缓存不能短路，再调用 h.login admin 走其真实表单登录，核对最初 adminID/所需管理权限；不读取主私有口令，不改 helper，不把 helper 清理当业务退出保护通过 |

当前实际源码中，新账号 `must_change_password=True`，登录页已有本人改密抽屉，`changeOwnPassword` 不要求 `system.view` 或 `knowledge.review`。因此不为此新增权限，也不借用 ROLE-ADMIN 独有的知识编辑/审核混授例外。实际执行仍先读 catalog；缺前置即停，不改认证语义。

初始、重复提交用、7 字符和 8 字符口令仅存在模块本次函数调用内存；不写私有文件，也不输出原文/摘要、完整 auth body、Cookie、sessionID、CSRF 或请求头。证据仅记录口令长度、业务 ID、非秘密权限集、原 requestId 和结论；异常文本按已知内存口令脱敏。检查点原子写、磁盘失败停写、不重提规则与资源脚本一致。

完整运行失败后禁止自动续跑已有检查点或换 tag 重建账号。若进程崩溃导致内存口令丢失，仍保留原 accountID、roleID、原请求号及结果阶段；后续仅由主另案进行管理员目标维护或只读回读，不能重建账号凑通过。本脚本不自动重置密码、删除账号/角色、改全局参数或恢复默认值。

主随后追加批准成功收尾：仅在七个业务 case 全 PASS、所有原事务已回读确认或明确拒绝、无失败/不确定/磁盘错误且已恢复原 admin 时，增加主 record `A-SYSTEM-success-disable-sacrificial`。通过真实 UI 打开系统、查询并读取本次原 `state.anchors.account_id`，核对创建前登录名不存在、原创建 requestId/回执目标一致、GUID 登录名、新建角色不属于创建前角色集合，且目标不是 admin/editor/reviewer 或当前 admin；然后仅对该行“停用”→“确认”一次，保存原停用回执，再列表/详情回读 `enabled=false`。新 role 保留，不删除对象。`success_cleanup` 独立记录最终状态；停用失败/不确定令整个 group 失败，不自动重试。七 case 失败、原号未核实、恢复 admin 失败或磁盘失败时跳过停用，不新增账号状态写；保留原账号交主另案处理。该增量仍仅为静态脚本准备，未运行。

主静态 review 指出的两处 selector 已修：使用 `getByRole('checkbox', { checked: true })`；原生角色 select 通过“角色”label wrapper 的直子 `select` 定位，不用隐式标签含 option 文本的 exact accessible name。未执行 Node 解析、测试、浏览器或 HTTP，当前为待 token 的静态交付。

## 11. GIS 聚合标签避让：获批最小生产差异

2026-10-25 主实际发现 desktop/mobile GIS 聚合 caption 互盖，先批准只读候选方案；C 安全退出后明确准许仅修改 `src/maps/gis-device-layers.ts`、真实既有 `tests/gis-device-layers.test.ts` 和本记录。测试名称与批准一致，无额外生产文件。B 只写其 CSS，不由本组覆盖。

先核对本项目固定 OL 10.10.0 的本地 `Vector/BaseVector`、`Circle/RegularShape/Text` 类型及 Canvas Executor 实现：图层支持独立 truthy declutter 组，image/Text 支持 `declutterMode`，`none` 在绘制及 hit callback 中不被 declutter 结果排除。仅使用这些已安装 API，不升级库。

- 图层新增 `declutter: 'gis-device-captions'`，不与非设备图层共用默认组；所有设备图标、单点外圈、聚合圆及状态外圈明确 `declutterMode: 'none'`；中心 count Text 同为 `none`。
- 外部 caption 保持独立 Style，Text 明确 `declutter`，由原生 OL 避让。不按 resolution 分级，不改缓存 key、不截断标签字符串、不减少成员、不移动坐标或改 Cluster distance。
- 聚合圆描边按 FAULT 红色优先、ALERT 黄色次之，否则沿用原描边。caption 即使被避让仍有故障/告警视觉信号；有状态色且选中/人工站点时增加不参与避让的独立外圈，保留白色选中/金色人工标识。未知构造状态不补 NORMAL，不把实体或 count 当可避让文字删除。
- `update` 的状态/几何/签名、cluster 创建及 `pick` 逻辑未改。新增三个测试源码门禁：image/count 与 caption 各自 mode；故障/告警/选中/人工/未知信号；真实原成员/几何和 pick 编号/版本保持。测试 getter 仅在测试内按当前 OL 运行时读取 protected group；生产不调用其 protected API。

主已 review 11+/7- 最小差异和三个新门禁并批准，随后由主串行启动 layers/status-layer/display 三文件专项；本组没有运行 tests/browser/HTTP。此后地图 production 冻结，不再修改；仅将新增测试说明注释中文化，无语义变化。最终专项结果由主登记，本组不把“已启动”登记为 PASS，也不以类型/样式门禁取代 desktop/mobile 实际画面和点击复验。

## 12. SR5 人读导出：获批静态补丁，交主单独 review / 排队

2026-10-25 主追加批准仅 `algorithm-service/app/fault.py`、`algorithm-service/app/fault_frontend_service.py`、新增 `tests/test_sr5_report_exports.py` 和本记录。只改导出展示及同运行来源传递，不改算法、冻结网络、接口、JSON 机器导出或运行库。未执行测试、编译、HTTP、浏览器或服务操作。

### 12.1 原缺陷与来源核实

- 原 `_report_docx/_report_pdf` 直接 `str(evidence)` / `str(summary)` 输出整段字典，显式空值时间也会变成 `None`。原 PNG 只读 `impact_scope` 的点，没有网络背景或图例。`fault_frontend_service.report(run_id)` 已返回本运行 `row.snapshot.network`，不是重新拼当前资源，故无需更改冻结数据或生成位置/边。
- 已只读解析真实下载报告 `data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792865551816-7fa87a/sr5-FR-3a67f1773487493aa949-report-json.json` 和原任务 `tasks/tsk-6c49cdd71e87.json`。raw `result.network_solution_id` 与 projection `network.id` 均为 `PLAN-5273d94aa08345e4b047d62b915e2928`，任务均为 `r4-network-89db2499fcf6`，snapshot 为 `SNP-PL-0F4B502A`，不是原算法 PL 编号。
- 该 projection 实际 142 个 stations、159 条 links；raw 2 个影响节点、4 条影响链路，4 条均能按原 ID 对应 projection；159 条端点全部在原节点集合内。`scenarioVersion` 是实际 string `FSV-EB0FD92F984C44E5`。这些是既有文件静态核对，不能写为新导出渲染通过。
- 实际生产来源链也一致：`fault_plan_source._snapshot` 的 `solution.solution_id=plan.plan_id`，`FaultEngine.impact` 从该 solution 取 `network_solution_id`；正式影响任务保存原任务/修订/场景版本。本次保留 plan/task/snapshot 一致校验，不用忽略标识差异或把当前资源回填来绕过校验。

### 12.2 最终展示行为

`_report_sections` 共用于 PDF/DOCX，按来源与场景、故障输入、诊断结论、规则/图谱/机器学习依据、影响统计、受影响对象、处置建议分节。字段标题中文，缺失/空字符串为“未提供”，0 和 false 保留真实含义。规则编号、三元组、案例/文档来源 ID 可见；图谱候选前五项为结构化摘要，其余明确指向同运行 JSON，不打印字典。故障类型复用后端现有 `kg_display.FAULT_TYPES` 中文字典并保留括号内原码，JSON 中原故障码与完整候选均不改。PDF 沿用已有 ReportLab STSong 中文支持，DOCX 设置中文字体属性。

`export_file` 仅向人读导出传递本运行 run/task/plan/snapshot/scenarioVersion/诊断和影响任务 ID。JSON 分支仍输出原 report projection，不增删机器字段；旧 JSON 报告内容函数和 XLSX 行数据未改。

`_impact_geometry/_impact_png` 只从本运行冻结 stations 的有限合法经纬度取点，从真实 links 的 a/b 端点取边，再按原影响对象 ID 着色；缺坐标/未定位数量明确显示，不合成坐标、链路或覆盖面。背景灰色含义是“冻结背景／影响状态未提供”，不能当 NORMAL。中断红色、降级黄色后绘制，避免被同位置背景覆盖；图内保留受影响节点/链路 ID、来源、真实已绘计数和图例，说明是经纬度拓扑示意而非电波传播路径/覆盖边界。PNG iTXt 留 run/plan/snapshot 与已绘数量供复核。

PNG 优先只读 `ROOT/front_design/radio-planning-20261022/public/fonts/NotoSansCJKsc-Regular.otf`，本机静态核对存在、16,437,364 字节。该文件是本次交付已有的共享运行字体资产，不是依赖旧前端业务代码；没有复制字体或依赖、没有安装字体。现有 Windows/Linux 中文字体仅为候补，均不可用时明确报错，不生成缺字图。后续打包需明确包含该共享资产或已有系统候补字体；打包范围本轮排除。

### 12.3 专项准备与交权

新增测试源码覆盖中文摘要与缺失/0/false、完整 JSON 不变、真实 DOCX/PDF 生成、冻结几何不改写、缺坐标不造边、plan/task/snapshot 错配拒绝、共享字体优先/缺失失败、PNG 真正绘图区的红/黄/灰像素（排除图例）、workbench 传同运行网络及 JSON 不变。测试将使用主指定 F 盘独立 GUID `--basetemp`；本组没有执行，不能登记通过。主可先 review 此三文件，再按单进程 token 运行该新专项和既有相关回归、渲染实际 PDF/DOCX/PNG，必要 API 重启仍由主决定。本组不启动或停止服务。

## 13. 选中干扰源参数入口：获批静态补丁，独立交主排队

主明确追加批准 `front_design/radio-planning-20261022/src/views/SituationView.vue` 和新增 `tests/gis-interference-resource-entry.test.ts`，并允许资源写脚本对同一新源追加回读。此批准取代 9.4 中“候选未批准”的当时状态；其他地图生产文件继续冻结，未改主的 planning-api 图层或 B/C/E 范围。

普通资源模式“干扰分析”区新增“查看/编辑参数”，真实 DOM 锚点 `data-testid="gis-resource-interference-parameters"`，打开原 `InterferenceSourceDrawer`。入口不要求新增编辑权限；只读情况只查看，进入原 GIS 编辑上下文后仍由抽屉原 `editor.canEdit` 控制编辑按钮，不变权限或 API。冻结方案、任务预览、诊断、监测、故障工作台、失权/blocked 会话不开放入口，busy/取点时禁用。

打开先经原 `configurationAction` 和 `editor.closeForm()`，保留配置及未提交表单的用户离开决定。等待前后核对同会话 generation、选中源 ID、资源 revision 和普通资源模式；取消或来源改变均不打开迟到抽屉。没有另写保存、修改参数、自动退出编辑或绕过冻结保护。

专项直接编译实际入口按钮/原抽屉模板，并执行从 SituationView 读取的实际 computed/handler；仅弹层外壳和周边状态使用替身，不启动全地图/轮询。测试源码覆盖只读详情、已有编辑权限进入同源原字段、无编辑权限禁用、冻结与失权等视图拒绝、busy/取点、配置/表单取消保留输入、等待离开决定期间的会话/选择/版本/冻结/权限变化。这是待运行的定向组件门禁，不是浏览器验收结果。

`tests/manual/r6_browser_resource_writes.mjs` 仅在原 G03 同一新干扰源的保存/刷新目录回读后，追加点击上述入口→同 ID 详情→原“编辑参数”→回读 name/active/高度/频率/带宽/功率，之后关闭并退出编辑。复开不填字段、不再保存、不造第二个源，原资源写顺序和 performanceComplete/GUID 门禁不变。资源版本继续冻结，该脚本及 system 均未执行、无本组业务写入或新 ID。主 review 后再排定专项及最后的资源写 token。

静态交权核对：本批七个修改/新增文件均可按严格 UTF-8 解码且无 BOM；三个已跟踪生产文件定向 `git diff --check` 无空白错误。这些只读检查不代表类型、模板或测试通过。两个生产补丁及各自新专项源码已就绪，交主分别 review / 排队后保持冻结；当前无本组在途业务写、运行中 exec 会话或测试浏览器，未启动新测试负载，未操作验收服务。

## 14. 主串行专项回报与原 FR 五文件只读重导出准备

主报告 SR5 新专项 + `sr5` + `frontend_api` 三文件组合 **25 PASS / 0 FAIL，102.27s**，原始记录名 `r6-sr5-report-exports-20261025-b.xml`。首轮收集因新测试未配置 algorithm-service 导入路径失败；主已仅修新测试的 Path/sys.path 导入，首轮失败 XML 保留。本组未重新执行或覆盖该结果，未改主修后的测试导入。Situation 入口专项由主在 D26 后串行排队，结果未到不能预记通过。仅 .24 API 的补丁加载重启仍由主执行。

2026-10-25 只读核对主 harness 与 C 脚本：`caseSr5ReportFeedback` 下载五文件后即使已有 changeId 仍调用 `openChange(ctx, 'DRAFT')`、回写知识草稿相关检查点；不能用它代替“仅原 FR 重下载”。`caseSr56Readback` 不含五文件下载。C 需新增独立导出入口，建议命名 `caseSr5ReportDownloadsReadOnly`；本组没有修改 C 脚本或主 harness。

该新段应只读加载既有 `r6-browser-sr56-state.json`，要求原 FS/FSV/FR/诊断/影响任务号及 reportHash 存在，不创建新 state、不修改原 operations/检查点。原号为 FR `FR-3a67f1773487493aa949`、FS `FS-2C769275EF6A4985`、FSV `FSV-EB0FD92F984C44E5`、诊断 `tsk-de56e435ee73`、影响 `tsk-6c49cdd71e87`。先正常 editor 登录，经 UI 进入诊断历史并明确选择原场景/运行，观察页面实际 GET 回读，校验同原号、plan/task/snapshot 和原稳定报告哈希 `2347f7026cfec8ee85fd012b5262a073437ebedc091400d52795a3cb37783cab`；随后报告预览点击 JSON/DOCX/PDF，关闭预览、影响页点击 XLSX/PNG。复用 C 原 `exported` 与主 `download/record/shot` helper，证据落本次新增 browser 目录，不覆盖原五份文件。只观察 UI 请求，不用 page.request/fetch 代替点击；必须记录诊断/影响提交、feedback、SR6 等业务 mutation 数为零（正常登录不计业务写）。不调用原写 case，也不调用会覆盖原检查点的普通 context/finish 保存路径。

以下为给主的待执行命令；**仅 C 新增并确认该只读入口、主完成 .24 API 装载重启并发单个 browser token 后使用**，当前命令未执行且该入口尚未由本组创建。Node、Playwright 和可选 PNG 包均复用主既有 bundled 位置，不复制依赖：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  'F:/work/project2026-1/tests/manual/r6_browser_acceptance.mjs' `
  --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' `
  --group sr56 --entry caseSr5ReportDownloadsReadOnly `
  --task-id 'r4-network-89db2499fcf6' `
  --plan-id 'PLAN-5273d94aa08345e4b047d62b915e2928' `
  --playwright-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json' `
  --png-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'
```

验收时需在下载成功之外另行渲染 PDF/DOCX、检查中文摘要/未提供/来源 ID，PNG 核对真实拓扑背景、2 影响节点/4 影响链路及图例；文件签名与下载字节不能单独证明可读性。JSON 与原 reportHash 一致、冻结网络应保留 142 节点 / 159 链路。resourceWrites/system 仍未放行，resource-7c8bd11ec30d0ed4 继续冻结。本轮仅只读源码/既有证据、写本记录，没有启动测试、浏览器、HTTP 或服务操作。

### 14.1 入口专项首轮 fixture 修正，待主单文件复验

主组合 `r6-interference-entry-candidates-20261025.json` / session 5768 exit 1：候选两文件 30 PASS，新增干扰入口 22 FAIL，均在第 53 行 fixture 初始化时 TypeError，尚未走到入口断言。此前测试错误地将 `initialResources` 工厂当资源对象读取 `interferences`；原 base resources.json 也没有该集合。已只读核对真实既有 `resource-presets.initialInterferences()` 从 `resource-supplement.json.interferences` 返回独立克隆，首项为原 `IF-0001`（origin=SOURCE，已有完整位置/参数），没有为测试新造干扰源。

本轮仅将新 test 的 import 改为 `initialInterferences`，初始化改为 `ref(initialInterferences()[0])`；真实 Situation 模板/handler、原 Drawer 和全部 22 用例断言保持不变。未改 production、Mock 数据、主 harness 或 C 脚本，也未执行解析、测试、HTTP 或浏览器。失败原结果保留，修正后是否通过由主在 E 干扰后排单文件复验；不能把 fixture 修正登记为通过。

### 14.2 主接管宿主修复及入口专项最终通过

主后续组合 `r6-diagnosis-entry-interference-final-20261025.json/.log` 中 D27 全 PASS，干扰入口 22 用例仍因本地客户端宿主缺 SSR context，在 `InterferenceSourceDrawer.vue setup` 读取 modules 时失败；没有据此证实 production 缺陷。主已接管新测试并补 `app.provide(Vue.ssrContextKey, {})`，与其他实际客户端模板宿主一致。

中间复验 21 PASS / 1 FAIL 的原因是 Vue v-model 将值写到内存宿主实际 `HostNode.value`，原断言错误读取 `vnode.props.value`；主将该断言改为读取实际 input.value，保留同一源原名称字段的语义。两处均仅测试宿主/读取位置修正，没有改生产入口、原 Drawer、权限或离开保护。原失败和中间结果保留，不以最终结果覆盖历史失败。

主最终单文件 `r6-gis-interference-entry-final-20261025.json/.log`：**22 / 22 PASS，命令耗时 9.8s**。本结果为主执行并回报的定向组件门禁，不是浏览器验收；本组未重跑。测试文件现交主并冻结，本组不再并行修改；production 同样保持冻结。

主当前处理 GIS 深链 GET plans context，由主独占共享 main、E 补测试，该问题不归为本次干扰参数入口的产品缺陷，本组不改共享入口。resourceWrites/system 仍等待最后串行 token，resource-7c8bd11ec30d0ed4 继续冻结；本轮仅更新本记录，未执行测试、HTTP、浏览器或服务操作。

## 15. system 首轮已受理角色与限定恢复：静态修正，待主审核 / token

主首次执行 system session 66172 / exit 1（证据结果目录后缀 c0215e）：唯一业务写 role-create 已 HTTP 200 / code 0 受理，新角色 `ROLE-7febd6c9940e444d9393c6e425e88006`，revision `SYS-10`；requestId 为 `d6c7f445-26e1-4bb3-be41-24577da96e49`，operationId 为 `OP-8cdda1df7c61438685bc3d066199c81a`。本脚本把独立操作号误断言为请求号，导致 case 01 FAIL；不是角色创建未成功。主确认 finally 真实 admin 恢复 PASS、无在途；没有 account-create，生成的初始口令从未用于创建账号。

已只读核对原 `data/runtime/r6/bf0e888b-0c04-4c65-9dbd-479f60c89baa/system-state.json`：唯一原 case FAILED，唯一 role-create 为 ACK_RECEIVED，result.object_id 已有但 anchors.role_id 未填，原三个 preexisting_role_ids 和 `situation.view` 权限集合已存。此次没有写该 checkpoint、没有新建任何角色或账号。主内部仅批准 `tests/manual/r6_browser_system.mjs` + 本记录；production、认证、权限和其他 manual 文件均不改。

### 15.1 请求与操作号分开，改密独立校验

对照实际 `system_management_service` 的 SystemOperation 持久化：requestId 是幂等原号，operationId 由 `OP-` + 独立 UUID 生成。System 写回执继续校验 changed、实际对象/目标、一次请求和 OP 形态，并分别记录两种 ID；已移除写 helper 和成功停用前两处错误的相等断言。响应必须通过其实际 request 的 requestId 与本次 UI 原号关联，不能只按 endpoint 接受其他响应。

本人改密 `/auth/password` 另走 AuthPassword 分支，不再套用 System OP 必填或对象/修订必填条件。静态核对 `local_identity_schemas.OwnPassword`、`local_identity_service.change_password`、`local-identity-http` 和本人改密表单：请求仅携带 requestId/当前与新口令，账号由真实认证会话决定；当前后端成功体会包含 OP/object/revision/changed/reauthenticationRequired，但 manual 不把额外 OP/object/revision 作为改密必须字段。提交前必须绑定 case 05 实际登录回执中的本次 accountID、roleID、username，目标不能是 admin；收到回执后校验一次原请求关联、changed=true、reauthenticationRequired=true；若响应提供 objectId/requestId 则分别核对目标和原号。OP/object/revision 有则仅保留脱敏元数据，缺失不导致已成功改密后因 System 字段假设失败。随后仍以新口令真实重新登录及 `/auth/session` 页面回读核实目标，才确认 self-password 操作；不直接 API 查询或重置密码。

口令始终仅在当前函数内存，日志/检查点仅长度、账号/角色/原请求及可用操作号、状态和结论，不保存完整认证 body、Cookie、CSRF 或口令。既有失败/不确定路径不自动新建账号、换 tag、重放请求或重置未知口令。

### 15.2 唯一允许的已创建角色恢复入口

新增显式 `runSystemResumeCreatedRole`，与正常新跑 `runSystem` 分开。入口保留原授权变量 `R6_SYSTEM_WRITES_ALLOWED=1`，要求同一 `R6_SYSTEM_RUN_ID=bf0e888b-0c04-4c65-9dbd-479f60c89baa` 及原 r4 runtime；旧普通入口仍拒绝该失败检查点。恢复前严格校验原名称/登录名、adminID、原三个角色集合、唯一 case/唯一角色写、原 requestId/OP/ROLE/SYS-10 回执、sent_count=1、HTTP 200/code 0/changed=true、ACK_RECEIVED、原 FAIL 含这两个 ID；不得已有账号锚点、account-create/其他业务或改密操作、其他失败 case、恢复标记或未核实写。缺少原检查点直接拒绝，不新建 state 或 tag。

执行后保留原 `A-SYSTEM-01-role-create-readback` FAILED 原样，新增 `A-SYSTEM-R01-created-role-readonly-recovery`。`created_role_resume` 留原检查点 SHA-256、原 FAILED case、原 ACK_RECEIVED operation 完整副本及原 preexisting_role_ids；这些非秘密证据不含密码。R01 经真实 admin 登录和 UI options/查询/原角色权限矩阵回读原 ROLE/name/仅 situation.view（含实际选中 checkbox 数），核对原角色集合不被当前含新增角色的 options 覆盖。确认本段角色/账号 POST 均为 0 后，才绑定原 role_id、将已受理 role-create 标记只读回读确认。不 POST 角色、不重新提交原 requestId，也不跳过真实 UI 选择/回读。

R01 成功后才按原 02–07 顺序执行原登录名的新账号创建、重复拒绝、停启取消/确认、目标账号真实登录、本人改密 7 拒绝/8 接受及新口令回读。由于严格证明原从未创建账号，本次可重新生成仅内存的初始随机口令；已存在 account-create 的任何检查点不能走本入口。恢复或后续任一步失败/不确定后再次执行同入口也被门禁拒绝，保留原号另案核实。

### 15.3 七逻辑步骤与成功停用

使用显式 `requiredCaseIds`：恢复跑为新 R01 + 原 02–07 共七步骤，普通跑为原 01–07。成功条件逐个核对七个指定 case PASS、所有操作为 READBACK_CONFIRMED/明确拒绝、无新增未列 case、原 FAILED 与原角色集合保持原样、R01 回读确实确认；不再依赖 `cases.length===7` 或把历史 FAIL 改为 PASS。返回 required_case_ids、required_steps、recorded_cases、historical_failed_case_ids；恢复成功时总历史 case 为八条，原 FAIL 仍明确可见。

只有上述全部成立、无失败/磁盘错误且真实原 admin 恢复成功，才沿既有唯一新 accountID 执行停用及 UI 回读；保留角色，不删除对象，不碰既有账号。停用记录分别保留 request_id/operation_id/目标/修订；任何未核实条件均不新增清理写。

交主审核后的待执行选择为原 harness `--group system --entry runSystemResumeCreatedRole`，沿用原 runtime/task/plan 和上述 GUID；必须等主新 token，不能运行默认入口或另换 GUID。首轮运行前旧 `Node --check` 的 exit 0 不能覆盖本轮修改后的解析结果。本轮只静态源码/契约复核及脚本/记录修改，未运行 Node 检查、测试、HTTP、浏览器或服务，未动原 checkpoint；当前脚本交主 review 后冻结，等待主单次串行恢复结果。

## 16. resourceWrites 原号串行落盘补丁：获批静态就绪

主认可原 taskBridge 仅改原任务名称、逐字段守住所有数值条件及“任务桥先、资源最后”顺序后，只读复核发现 manual 的 `onRequest` 原先仅在内存更新 SENT/request_id，等响应或异常才保存，崩溃期间可能只留下无原号的 ARMED。原 RUNNING/FAILED / operation key 禁止重提门禁仍有效，但原号持久化存在窗口。本次内部仅批准 `tests/manual/r6_browser_resource_writes.mjs` + 本记录，system manual 继续冻结，未改 D、production、API、主 harness 或资源执行顺序。

### 16.1 串行原子快照与失败阻断

- `save()` 在入队时生成完整 JSON 快照，所有请求事件和正常保存共用一条 Promise 尾链；逐项写同 GUID 同目录 `wx` 临时文件，`flush: true` 后再 rename，避免并发 rename 或 ACK 更新把尚未完成的 SENT 快照替换成后阶段内容。
- 每个持久写在点击前仍先保存 ARMED；实际请求事件立即记录原 `request_id`、首个 request、sent_count 及 sent_requests 历史，再把 SENT 快照入队。若同一动作意外发出多个请求，首原号不被覆盖，各次实际原号分别留存，随后次数断言失败，不自动重提。
- 临时写、同步或 rename 失败均锁存首个失败，立即输出已知原号/阶段/版本，保留最后有效检查点和临时文件；所有排队后续写停止，不清理或重试。事件回调捕获 rejected Promise，避免未处理拒绝，同时失败 latch 不能被吞掉或恢复为成功。
- 后续 `c.change`、`c.http` UI 动作前，等待当前串行尾链排空并检查失败；用例入口、回读确认和最终收尾同样设门禁，轮询等待发现失败即退出。因 SENT 落盘失败而已在途的原 HTTP 仍等待其原响应或原超时，不取消原事务，不再发下一业务写。

### 16.2 回执先保存，再核验

收到真实响应并解析后，先把原 HTTP 证据与 operation 的 ACK_RECEIVED（明确失败响应为 REJECTED_RECEIVED）、原响应 data、HTTP/code、响应所属原 request_id 一并入队保存；SENT 快照必在此前完成。完成该保存后，才核对一次发出、实际原号存在及响应关联、context/base_revision、changed、新 resource revision/readRevision 等原业务断言，随后保存 ACK_VALIDATED。真实刷新/表单回读通过后才保存 READBACK_CONFIRMED。

落盘失败时不能声称回执已持久化；已知原响应仍留当前内存/失败证据供主核实，原检查点不被重建。保留既有 operation key 去重、失败 case 恢复阻断、GUID 连续性、ENOSPC 不再保存及不重复提交规则。没有为验证此补丁增加测试 API、绕 UI 写入或自动恢复事务。

### 16.3 交主及 Dtrace 的实际高度历史

R03 维护的是设备天线高度 `antenna_height_m`，目标仍为 `Number((before + 0.1).toFixed(4))`；随后再增加 0.1 的输入只用于继续/放弃保护，明确不保存。G02 仍单独按所选真实设备当时高度 `+0.2`（四位小数）应用草稿、撤销/重做并持久保存。两步均返回各自 id/before_height_m/saved_height_m/revision，实际原号/回执也在对应 operation 中保留。

**需主转达 D：Dtrace 必须按全部实际已受理并核实的设备 ID、原号、版本和修改历史恢复最早原始高度，不能把 A-R03 after 当作执行 G02 后的当前值。** 若两步作用同一设备，正常最终是原始值依次 +0.1、+0.2（按各步四位小数处理）；若作用不同设备，须分别按各自历史恢复。若某步已受理但 case 未结束，先核实该原号与当前回读，不能只按 PASS case 或假定未保存。A 未修改 D 脚本、未替 D 恢复资源。

本轮仅静态修改上述 manual 和记录，没有执行 Node 检查/测试/脚本、浏览器或 HTTP，也没有覆盖任何现存 runtime checkpoint。补丁已准备交主 review，再等待最后一次资源写 token；不能把静态补丁登记为运行通过。system manual 保持此前交权冻结，PAR、resource-7c8bd11ec30d0ed4 与服务未操作。

## 17. resourceWrites 失败证据与限长回报：唯一补强静态就绪

主已 review 第 16 节 SENT 队列/latch/回执顺序并认可，D 已按双原号完善 Trace。后续仅批准同一 manual 与本记录：原 `c.test` 将完整 HTTP/operations 拼入 error.message，可能导致终端及宿主 results.failure 展开十余万 token；本次改为独立证据文件，不改生产、业务断言、判定、执行顺序或其他组文件。

case 失败时新增 `data/runtime/r6/<原GUID>/failure-<caseID>-<本case原requestID或no-write-request>-<独立UUID>.json`，使用 `wx` 与 flush 独占新建，不覆盖旧证据、旧失败或检查点。文件完整保存原错误 message/stack 及不截断的详细错误、全部原业务 HTTP/operations/writes/anchors/cases、case HTTP 起点和新增 operation keys。原 case 仍为 FAILED，原错误在 checkpoint 中也保留；没有把失败改判为 PASS、丢弃数据或靠换 GUID 重跑。

抛给主 `record` / results.failure 的是全新紧凑异常，不附完整原 error/cause：错误正文最多 1024 字符后注明剩余数量，仅列锚点 ID（device_source 仅列 ID）、最多 20 个操作原号摘要及最多 20 个 endpoint 摘要（path 最多 256 字符），同时提供原始数量/省略数量、证据路径和写入状态。完整业务内容只在独立原号证据和原检查点中保留，不再拼入终端异常。检查点失败即时输出和 finally 输出也共用该限长摘要，finally 不以另一个落盘错误覆盖已有紧凑 case 异常。

若磁盘 latch 已失败，不再尝试大文件写入，明确标记 `NOT_WRITTEN_DISK_FAILURE`；若独立文件写失败，保留可能的部分文件并明确标记 `WRITE_FAILED_PARTIAL_POSSIBLE`，锁存失败阻断后续写，不声称证据完整。独立文件已写入而 checkpoint 随后失败时，回报仍保留已完成文件路径与 checkpoint 失败标志，不覆盖或删除该原文件。所有响应/请求证据仍仅为既有资源/任务业务记录，不读取或新增认证 body、Cookie、CSRF、私密配置或口令。

本轮只有静态编辑与源码复核；E 执行期间没有运行 Node、检查/测试、浏览器或 HTTP，没有覆盖现存 runtime checkpoint 或新建运行产物。manual 和记录已准备交主审核，随后继续冻结；system manual、production、资源/PAR 和 D 文件未改。

## 18. system 已创建账号限定恢复：静态实现，待主 helper / token

主报告 system 恢复 session 5696 已 exit 1、context 已关闭，证据目录 `r6-browser-1792877033509-f51038`。新 R01 与 account-create 已 PASS；唯一新账号为 `ACC-48883ff3e2634b8bbb13dd54a43a3398`，account-create 原号 `f50ffa38-362a-475b-9bca-8ff54bb80017`、OP `OP-58da41917cd64fe8b83663dfd97224e8`、SYS-13 已 READBACK_CONFIRMED。duplicate 原号 `7243a997-7600-4d63-b883-7d626fab01d8` 为 HTTP 409/code1203、EXPLICIT_REJECTION，但 manual 仅匹配“重复|已存在”，未识别实际可见“唯一性或并发状态冲突”，导致原03 FAIL。原 admin 已恢复；没有状态/改密写，原初始口令随进程结束不可恢复。

本次主仅批准 system manual 与本记录，新增 `runSystemResumeCreatedAccount`，并授权一次对该可牺牲账号的真实管理员 UI 密码维护。未授权创建替代账号/角色、重发 duplicate 或操作原三个账号/角色；production 无缺陷证据，不改。resourceWrites manual 及其他组文件继续冻结。

### 18.1 原检查点与历史拒绝证据门禁

入口严格要求原 GUID `bf0e888b-0c04-4c65-9dbd-479f60c89baa`、原 r4 runtime、ROLE `ROLE-7febd6c9940e444d9393c6e425e88006`、上述唯一 ACC/创建与拒绝原号、创建 OP/SYS-13 和三份原业务 HTTP。要求原01/03仍 FAIL、R01/02仍 PASS，唯一 operations 恰为 role-create/account-create/duplicate-account，分别已回读确认/已明确拒绝；原 admin/角色集合与 situation.view 保持，必须没有后续状态/密码/未知写或既有账号恢复标记。其他检查点或重复进入均在业务动作前拒绝，不能重跑 createdRole 或普通入口绕过。

静态核对并绑定原拒绝 DOM 与 results 的只读路径及 SHA-256：DOM `1e67f0c11511cb901e7efc952c01abca5803d4477a362a08b87b7e0eb2adb8e0`，results `870fe5a1b66ab1af0da9d71bfc7c481ca7c3711bcf90ccbfb51395341a0355b4`。执行入口时先核对这两份已退出 CLI 的文件、原失败及409记录、可见拒绝/登录名/角色，再通过真实 admin UI 查询及原角色矩阵、唯一原账号详情，确认 ID/username/role/enabled/mustChangePassword，不提交 duplicate。新增 R03 只读恢复记录，原01/03 FAIL 不删除、不改判。

`created_account_resume` 保存原检查点 SHA、原 cases/operations/requiredCaseIds/角色集合的非秘密副本和历史文件证据。后续成功条件逐项要求这些历史 cases 原样保持，不用重建账号/重跑拒绝来制造通过。

### 18.2 唯一管理员维护与 helper 合同

主须向 args 提供 `fillSystemOperatorPassword({targetId})`；仅此恢复入口、实际原 admin、确切 ACC 和已打开“维护账号密码”抽屉时调用。调用前再次由 UI 回读目标详情/最新 revision，helper 只填实际“操作人当前密码”并安装目标路由限制，不提交、不向模块返回口令；模块不读该输入值、不读 private，helper 异常只报固定脱敏消息。

新 initial 随机口令仅在本次函数内存，填“新密码/确认新密码”。唯一新 operation key `account-password-recovery` 先 ARMED，再由真实 UI 一次 POST `/system/accounts/ACC-48883ff3e2634b8bbb13dd54a43a3398/password`，记录实际 requestId 与独立 OP，不复用旧创建/拒绝原号。先落盘脱敏回执，再校验 changed=true/目标/baseRevision/一次请求；随后通过 UI 回读同账号 role/enabled 及 mustChangePassword=true，才记维护 READBACK_CONFIRMED。仅记录口令长度和“操作人口令已提供”布尔值，不留任何口令正文或摘要。

之后只执行原04–07：新账号停启取消/确认、用本次内存 initial 真实登录、7字符前端拒绝/8字符本人改密及新口令登录回读。没有重新角色/账号/duplicate POST。维护或后续任一步不确定即保留原号停止，恢复标记阻止同入口反复维护；不因文案泛化失败再次换号/重置。

### 18.3 SENT 队列、未知写阻断与最终判定

system 的 checkpoint 改为同资源方案的串行不可变快照：唯一临时文件 wx/flush 后 rename；每次真实 SENT 立即入队保存原 requestId、所有发出原号及口令长度元数据，首原号不被覆盖；HTTP/脱敏 ACK 与响应所属原号先一并落盘，再做业务断言。异步保存拒绝被捕获但失败 latch 不清除，后续脚本 UI/写入口及确认/收尾等待队列并检查失败，不取消原在途事务、不重提。没有改主 harness 的独占、pending 或 Windows rename 处理。

恢复范围内禁止角色/账号创建，业务写必须有 ARMED/SENT 且仅限本 ACC 的维护/状态及已登录本人改密。其他未知写立即记录脱敏 endpoint/原号并锁存 scopeFailure，阻断后续业务；仍允许已授权的真实原 admin 恢复，磁盘 latch 不绕过。所有 auth body/Cookie/CSRF/会话凭据均不落盘；错误信息只按 System 固定 message/reason 与公共 ID 记录。

七个 requiredCaseIds 为既有 R01/02 PASS + 新 R03只读恢复 + 原04–07；管理员密码维护是另一个必须 PASS/原号回读确认的恢复步骤，不替代七步，也不把原01/03 FAIL 当 PASS。预计保留十条历史 case（七逻辑步骤、两个历史 FAIL、一次密码维护）。只有全部指定步骤、维护、所有 operation、原历史不变、无未知写/落盘失败且原 admin 已恢复，才按原唯一 accountID 执行成功停用及回读，保留新角色。

主后续选择 `--group system --entry runSystemResumeCreatedAccount`，沿用原 GUID/runtime/task/plan，并注入上述私有填密 helper；需主单个 token 后执行。本轮只静态实现和读取已退出证据，没有运行 Node/测试、浏览器、HTTP 或任何业务写，没有修改原 checkpoint/旧证据，也没有重置账号口令。当前源码与记录交主审核后冻结；不预记解析或验收通过。

## 19. R03 无写超时后的唯一只读继续入口：静态交权

主报告 session 59486 已 exit 1/context 关闭，目录 `r6-browser-1792878513938-9b9eb3`。初始 openSystem 等 options 超时，DOM 为“本地认证数据库不可用”，只有两次成功 auth/login，**零新业务 mutation**；原三份 operation 完整不变、密码维护 NOT_STARTED、原 admin 恢复 PASS。主已另案定位 worker 大快照 flush 后跨连接等待自身 SQLite 锁，修复/大 payload 专项及仅 .24 API 重启由主负责；A 不把该环境故障改称查询输入或系统脚本的业务成功。

本次仅批准 system manual + 本记录新增 `runSystemResumeAccountReadonly`，原 CreatedAccount/CreatedRole/默认入口继续严格拒绝当前失败检查点，不增加通用“跳过失败”或自动重试。新入口仍只接受原 GUID/runtime/ROLE/ACC/创建与拒绝原号；要求原三 ops 全部已核实、原 admin 恢复、精确五个既有 cases、原新 R03 为 60000ms waitForResponse 超时 FAILED、`created_account_resume.phase=PREPARED` 且 password_maintenance 恰为 NOT_STARTED/同目标。任何额外 case、写入、未核实状态或已存在只读继续标记均拒绝。

新门禁还核对该已退出 CLI 的 DOM/results 字节 SHA：DOM `a5935e847698f98b4e9c7e6e81881f190d228ddae12c5b9efd388ae6e8c05481`，results `a0c48d6a3c9f932b4e834c459576105fed61d1e603acdcc21ae19a6ad618eb57`。要求结果只有原 R03 FAIL/admin恢复 PASS、全部非 GET 请求只有两次成功 auth/login，并含 auth/session 503；同时重核第18节原 duplicate 的拒绝文件。不读取任何 live results、不调用当前 API 来伪造此无写证明。

未来授权运行时仅新增 `account_readonly_resume`，存本次原 checkpoint SHA、完整既有 `created_account_resume` 副本、五份原 cases、原三 ops、原 requiredCaseIds/角色集合以及两个阶段的历史文件证明。旧 cases 和旧 `created_account_resume` 不覆盖、不删除，后续最终判定还要求它们逐项原样保留。新 `A-SYSTEM-R03b-account-readonly-continuation` 通过真实 admin UI 重新回读原角色、唯一原账号、enabled/mustChangePassword，再确认该阶段业务写仍为0；只推进新 metadata 的只读阶段，旧 PREPARED/NOT_STARTED 作为历史证明保持原样。

R03b 通过后，沿第18节已批准的唯一 `account-password-recovery` 对原 ACC 维护一次本次仅内存 initial；主 helper 只新增允许此确切入口，其 target/route/私有填密合同不变。维护 helper/写/回读全部使用新恢复 metadata，不重建账号、不重复 duplicate，不调用或覆盖旧失败 case。实际密码从未维护，只有此严格无写证明成立才允许本次新 initial；其他情况停止，不能反复换号重置。

requiredCaseIds 使用 R03b 替换 FAILED R03，仍为七逻辑步骤；原01、原03、旧恢复R03三条 FAIL 全保留，额外密码维护仍必须 PASS/原号回读确认，之后原04–07照原顺序执行。成功时历史 case 总数预计11（七逻辑步骤、三条历史FAIL、一次维护）；全部核实、原 metadata 不变且 admin已恢复才停用同一新账号。

主后续应选 `--group system --entry runSystemResumeAccountReadonly`，同系统 GUID/runtime，并由主提供已批准的目标 helper；主 harness 的当前 task/plan 由主管理，本入口不写规划或资源。API/SQLite恢复、Node检查和真实执行均等待主排队/token。本轮只有静态编辑、读取已退出历史证据和编码核对，没有执行脚本/Node/测试/浏览器/HTTP，没有改原数据库、checkpoint、密码、production 或其他 manual；源码交主审核后继续冻结。

## 20. accountAccess 独立05–07脚本与密文凭据恢复：静态交权

主报告57099退出/context关闭，目录 `r6-browser-1792880363346-714b72`：R03b、管理员密码维护、状态04和原admin恢复四项PASS；05在真实logout后因runtime重复绑定/vnode错误无法显示登录表单而FAIL，没有target login或self-password写。旧密码维护 `0d1ed2d8-9cf5-4f7d-979c-e7acfa8b2ef8`、off `a8007b41-c44d-47bc-8509-4de50bedf7bb`、on `dd659619-0b02-4a3f-85e0-4f61a1f04c39` 均已回读确认。主独占修AppShell为onBeforeUnmount解绑，并另验admin正常退出/重登；A不改该production，也不再写原system约800行脚本或原sys checkpoint。

本次仅批准新增 `tests/manual/r6_browser_account_access.mjs` 和本记录，主已登记 group `accountAccess`。仅导出 `runAccountAccess` / default 与 `runAccountAccessResume`；主须显式选择其中一个entry。目标固定为同GUID `bf0e888b-0c04-4c65-9dbd-479f60c89baa` / ROLE `ROLE-7febd6c9940e444d9393c6e425e88006` / ACC `ACC-48883ff3e2634b8bbb13dd54a43a3398` / 原runtime，源角色/账号create、duplicate、04停启case全部不重复，不建服务/浏览器、库或依赖。

### 20.1 冻结来源与独立检查点

新脚本只读绑定原 `system-state.json` SHA `616767cc7e0cf814a1c51be4c3f95aa1fa3748fc84c5d5128733bf1abec9ef63`，核对原六份ops的目标、原request、已确认/明确拒绝、原三角色集合、仅situation.view、原admin恢复、05失败且06/07未发生。原714b72 DOM SHA为 `36ef16091b2a723bc895c334ce9d972724e1751e3b35bd152611eb29f0188933`，results SHA为 `837af81daa874c6b649a6cb9147475c47a86ae8a4c119c7812dff50033b8afe8`；核对四PASS/05FAIL、两条原pageErrors，以及05请求中有logout而无target login、全轮无self-password。仅读取该已退出证据，未读其他live results。

新检查点独立为 `data/runtime/r6/<同GUID>/account-access-state.json`。初跑wx独占创建，已有则拒绝默认入口；先保存源hash、完整原ops证明和原case状态，再进入后续流程。之后使用同目录唯一临时文件wx/flush/串行rename，实际SENT原号即时排队、ACK脱敏回执先持久化再断言、失败latch阻断后续写。旧sys文件/证据全程只读，收尾再次核对其hash。Page/locator/完整AuthIdentity均不能写检查点或宿主结果。

### 20.2 主加密凭据helper合同

仅使用主提供的 `h.accountTestSecrets.create()` / `read()`，不另造密码。首次create在原runtime私有位置原子写AES-GCM密文后返回initial32字符/next8小写数字，已有文件拒绝create；key由主helper用现有identity_request_key经HKDF派生，原private.json不改。本模块不读private/key/密文文件，也不实现或复制加密依赖；仅调用闭包，再read并在内存用布尔比较验证同一对象的两个秘密一致，后保存“SEALED_VERIFIED”和32/8长度。任何最终管理员维护提交前必须完成此步骤。

所有敏感值仅在本次函数内存，helper异常变为固定脱敏消息；不print、写明文/密码摘要、将密码作为assert actual/expected或放入error cause。断言只检查布尔/长度；HTTP/ops仅留公共ID、状态、口令长度和“operator已提供”布尔，Auth body、Cookie、CSRF和session凭据均不保存。7字符输入仅由持久化next取前7字符，不生成另一份口令。UUID仅用于文件临时名，不是密码。

### 20.3 唯一最终维护与真实05–07

先真实admin UI回读原角色权限矩阵和唯一目标账号/role/enabled/mustChangePassword，确认原角色集合仍在。初跑仅额外一次 `final-admin-maintenance`：打开原目标“维护密码”并GET原详情/版本，调用 `h.fillSystemOperatorPassword({targetId: ACC…3398})` 只填私有operator输入并安装目标路由限制，不提交、不回secret；脚本填helper持久化的initial32，c.write一次POST确切target/password。先保存原回执，再核对changed/目标/原号/版本，并由UI回读mustChangePassword=true后确认。密文失败、不确定写或未知endpoint均停止，不换号/重建/重置循环。

普通账号目录同时只读核对原三账号（合计原三+本target四条），原三ID/登录名/role/enabled/mustChangePassword形成公开profile基线，角色集合须与原三角色对应且包含原admin；停用前及最终admin恢复后再次回读比较。合法登录会更新的lastLogin不作静态profile比较。模块业务写白名单只允许本target最终维护/本人改密/成功停用，不能写原三账号资料或角色。

随后只补05–07：实际UI退出admin→target用initial登录并见强制本人改密；7字符前端禁用且无请求，8字符next才单次真实self-password，按真实目标/原request/changed/reauthenticationRequired校验，不强加可选System OP/object/revision字段。最后用next在同SPA登录，核对公共performance.timeOrigin未换文档、无新pageerror、同账号/role/权限、reload session回读及实际系统路由回退。仅通过后才恢复admin、一次停用同target并UI回读disabled；收尾再确认原admin。新角色保留，不删对象，不复位旧ledger。

### 20.4 显式原号恢复与交权

`runAccountAccessResume` 只能加载既有独立检查点并 `read()` 同密文，绝不调用create或最终管理员维护POST。只接受已明确受理、目标/actor/响应原号一致的原operation；ARMED/SENT/UNKNOWN/拒绝或其他未知写必须先由主另案核实，不能重发。管理员维护已受理但回读中断时，用原凭据与真实UI继续核实；self-password已受理时只回读该原号，使用同next登录证明，不再提交改密。清理停用已受理时也仅回读，不再次停用。

历史尝试/失败保存在attempts，原05来源失败永久保留；新05/06/07成功判定与清理均依实际证据。跨CLI无法宣称保留旧文档连续性：若改密已在上一CLI受理，当前SPA另做next退出/重登并核对timeOrigin，明确记录为“原写保留、当前SPA重登”，不冒称旧CLI同文档。若改密在当前CLI执行则直接验证同文档重登。凭据始终来自同一密文，不因故障再维护或新建账号。

主合同的两个entry及helper已接入静态稿，所有业务只通过主Page与正常UI触发/回读，不用page.request/fetch替代。未执行Node/解析/测试、浏览器、HTTP、密码维护、加密helper或新checkpoint落盘；本轮只新增该manual及记录，原system/manual/checkpoint、其他manual、production和原三账户未改。源码待主review/Node检查/单token执行，静态就绪不能登记真实通过；交权后继续冻结。

## 21. LoginView 能力失效后重读与最终专项证据（2026-10-25）

主批准白名单仅为 `src/views/LoginView.vue`、新增 `tests/login-capabilities-entry.test.ts` 和本记录。原 accountAccess 首次执行 session10120 已退出，证据目录为 `data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792882853080-b85d8c`：本人改密已受理，07的账号/密码输入均有效但登录按钮持续禁用，0 pageerror；07没有登录请求。身份同步 watcher 清空 capabilities 后未补读，旧密码抽屉又可能因身份换代卸载，使 saved 回调不能作为唯一恢复路径。该原失败及其已受理改密、检查点均保留，不重置口令或重做业务写。

LoginView 保留 sync 清空、身份 generation/id/sessionId/revision 校验及 Abort/serial 丢弃旧读；busy/transition 开始时作废能力，组件仍挂载且当前身份稳定、两者均结束后才受控补读。本人改密提交完成也触发该补读，不依赖旧抽屉事件；同身份进行中的读复用，显式登录/重读流程可复用刚完成的稳定结果，避免与自动补读重复请求。失败不循环自动重试，卸载或超时后的迟到成功不应用；capabilities 为空、未初始化或强制改密时仍禁止普通登录。SESSION_REPLACED 必须经既有显式清理，未知改密回执保留原请求号及原账号限制，NOT_FOUND 不视为失败或成功。不修改 auth store、认证服务、API、权限及会话替换语义。

专项挂载真实 LoginView、SystemPasswordDrawer、Pinia auth store及内存路由，仅替换服务响应和弹层外壳。输入通过真实 v-model 的 input 监听进入表单；覆盖成功改密后原页面直接重登、busy/transition及交叠、能力空/未初始化/强制改密门禁、同账号代次/revision变化、换号迟到成功/失败、卸载、超时、失败后明确重读、会话替换与未知回执。

测试按主唯一串行令牌执行，未跑全仓或构建；所有新增测试产物在 `data/runtime/r6/e34be10e-2aad-4bd0-aaf4-5fbb7ece6b2d`。首轮 session14243：10 PASS、5 FAIL、7个未处理异常；原 `login-capabilities-entry.json/.log` 保留。内存宿主补 Document/ShadowRoot，生产窄修稳定读复用后，session61982只复验5个失败项及关联超时异常项：6 PASS、9 skipped、0未处理异常、exit0，证据 `login-capabilities-entry-retry.json/.log`；该次不冒称全文件通过。

主随后独占执行 session89364，最终全文件 **15 PASS、0 FAIL**，报告 `data/runtime/r6/r6-login-capabilities-20261025.json`，对应 `.log` 保留。A在主执行期间未重复启动测试或浏览器。最终生产文件及新专项已交主并冻结。

## 22. accountAccess 原号恢复、成功停用与交权（2026-10-25）

主授唯一串行测试/浏览器令牌后，A先结束上述定向测试，再运行既有 `runAccountAccessResume`；未修改永久冻结的 system/manual、accountAccess 脚本或主 harness。沿同 GUID `bf0e888b-0c04-4c65-9dbd-479f60c89baa`、同密文 vault、原 ROLE `ROLE-7febd6c9940e444d9393c6e425e88006`、原 ACC `ACC-48883ff3e2634b8bbb13dd54a43a3398`，只读取原已受理维护/本人改密并续07，不再创建或维护账号、不重发本人改密。

浏览器 session19395 已 **exit0、context关闭**。新增证据目录为 `data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792883824673-0e2811`，`results.json`、`group-result.json`及七项截图保留；本次 **7 PASS、0 FAIL、0 pageerror**：原号只读回查、原维护确认、原05证明保留、原06受理保留、07新密码重登/权限路由限制、成功停用目标、恢复admin。05/06的恢复PASS表示核对原证明，不能计作重新执行或再次改密；本次07同SPA重登也不冒称与前次CLI的改密处于同一文档。

只在07全部核实成功后，通过真实管理员UI单次停用本测试ACC。独立 `account-access-state.json` 当前三原号均为 READBACK_CONFIRMED：

| 操作 | 原 request_id | 最终状态 |
| --- | --- | --- |
| 最终管理员维护 | `3cae617f-1122-4942-872b-b74e868d9727` | READBACK_CONFIRMED；本次未重发 |
| 本人改密 | `5ae383d3-5eac-490b-aaef-67688ea82d8b` | READBACK_CONFIRMED；本次未重发 |
| 成功收尾停用 | `70e4c642-c068-4f9e-b15e-8e8f80d5aebc` | READBACK_CONFIRMED；目标 enabled=false |

检查点确认 `target_disabled`、`admin_restored`、`original_accounts_unchanged`、`new_password_verified`、`same_spa_relogin_verified` 均为true；新角色保留，原admin/editor/reviewer未改口令或权限，秘密仍仅经原私有密文闭包使用，记录不含明文或密码摘要。原 system checkpoint/历史失败证据不覆盖；account-access 原第1次 FAILED/07失败仍在 attempts，第2次 resume 为PASS。主已只读复核0e2811及三个原号，没有再次启动账号浏览器。

串行令牌已交回，当前A无在途测试、浏览器或业务写。后续浏览器由主直接执行；LoginView、新专项及所有manual保持冻结。资源Writes本次未启动，等待主oldsource收口后由主沿其固定新GUID单次执行，A不提前启动资源版本写入。本次收尾只更新本记录，不修改生产、测试源码、检查点或运行服务，不提交推送。
