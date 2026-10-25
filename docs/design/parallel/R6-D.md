# R6 子组 D：浏览器操作工作流

## 内部批准及写集

用户已批准新增 `tests/manual/r6_browser_operations.mjs` 和本文件，D 独占这两个文件。仅只读新版 `front_design/radio-planning-20261022` 及文件12/13核对控件与契约；不修改 A 的刷新/状态组件或 C 的 SR5/SR6 文件。不启动浏览器、服务，不安装依赖，不做全仓测试、生产打包、备份、提交或推送。生产缺陷需先报告精确文件白名单，由主内部批准后另行处理。

目标固定为 `http://127.0.0.24:5324`，对应 `.24:8124` 隔离后端；脚本只通过该页面真实控件产生 HTTP，拒绝其他回环地址及本组范围外的业务写请求。运行目录与浏览器均由主提供，不读取、复制或打印 private、Cookie、CSRF、密码、认证请求正文。

主提供的本轮锚点：任务 `r4-network-89db2499fcf6`、方案 `PLAN-5273d94aa08345e4b047d62b915e2928`、初始资源 `resource-7c8bd11ec30d0ed4`。运行时仍从真实页面响应获取版本，频点维护成功后预期换版，不把该初始版本写死为后续当前版本。

最新分工覆盖初始任务：D **不执行 device-status imports、跟随最新或状态刷新专项**，这些归 A/B/主；只读状态入口及本地 JSON 拒绝。账号、角色、权限、改密不测。参数写入须等主 perf 完成后单独安排。

## 可执行动作及方法

每项由 `record(id, fn)` 包住，成功返回 JSON，失败抛出并结束调用链。动作先监听精确路径、方法及关联查询参数，再操作唯一控件；同时核对 HTTP 状态、业务码、请求与响应、页面结果。不使用请求桩、隐藏 store、页面 evaluate、直接 API 写入或强制点击。

| 导出 case | 实际控件与有限操作 | 核对方法及前置 |
|---|---|---|
| `deviceConfiguration` | 设备详情→参数信息→配置请求→校验→提交系统受理→读取历史→原号回读→重新读取来源 | 型号上下界来自真实 context；POST 校验/受理200。断言 ACCEPTED、SYSTEM_ACCEPTANCE、NOT_DISPATCHED、执行 UNKNOWN、四项结果 null；来源版本/哈希/台账参数不变。默认首屏 DV-0001，可传首屏 `deviceId` |
| `statusEntry` | 设备状态快照入口→展开显式导入→两次本地拒绝→放弃输入→读取批次 | 初始和回读 GET snapshots200；非法 JSON、`{}` 显示错误，未发送状态写请求，仍为台账基线；不点击快照导入成功或跟随控件。主应避免本 case 期间并发新建快照，以便比较目录 |
| `deviceTrace` | 变更追溯与历史版本→选历史→生成三参数恢复候选→关闭→刷新资源 | history200；有真实维护历史才测 operation detail200。否则选留存基线并明确记录 `NOT_RUN_NO_RESOURCE_CHANGE_HISTORY`。restore-preview POST200仅预览，三参数白名单及资源版本不变；不点击载入/应用/保存，不制造维护历史 |
| `frequencyAdd` | 规划频点→精确筛选本组编号→新增构造频点→预检变更→确认保存 | ADD 预检/提交200；7105kHz、3kHz是构造测试输入；新增默认停用、无占用方，资源换版。已有同编号则停止，转入后续 case，不盲重提 |
| `frequencyPatch` | 本组频点编辑→信道号0→预检→确认保存 | PATCH 请求及回执核对，0不丢失，频率与可用性不变。已为0时停止，避免重复写 |
| `frequencyEnable` | 勾选本组频点→启用所选→确认保存 | ENABLE200、回执换版、行状态可用。只启用 D 新增项；已启用时停止，不停用既有资源以便复测 |
| `frequencyDuplicate` | 同编号再新增→预检变更→错误→取消并放弃草稿→刷新 | 必须真实422/1001；不得出现提交确认；原频点内容和资源版本不变 |
| `spectrumSource` | 频谱接口配置→新增来源→填写声明→保存 | 构造来源 SOURCE_SAVE200，启用声明关闭，来源/版本/正文与请求一致；已有本组来源时停止。地址仅声明为`.24:8124/r6-declaration-only`，不建立连接 |
| `spectrumSourceReadback` | 精确搜索本组来源→离线校验→查看或编辑→版本记录/本版本校验记录→导出→选择→取消导入 | checks200、OFFLINE_ONLY、NOT_ATTEMPTED、VALID；版本/检查记录精确绑定；真实下载 JSON、正文和哈希断言。来源选择 GET 精确版本，打开导入框后取消，不导入观测 |
| `spectrumObservation` | 频谱观测→选主准备的带冻结绑定观测→下一/上一帧→倒数第二帧→播放末帧→重播→查看冻结引用→导出观测 | 全程只读。精确版本 context/frames/ref均200；FINITE/loop=false，终帧 hasNext=false、播放及下一帧禁用，下一1.2秒无回绕请求；重播回到首帧暂停。冻结绑定、状态头及首20名成员逐项真实GET，保留未知；V2实际导出及绑定正文一致 |
| `systemLogs` | admin→操作日志→包含归档查询→当前视图查询→归档日志视图→确认→包含归档再查→原事件详情 | archive-logs200，仅归档视图；核对快照序列、历史总数不减、最近旧事件及详情完全不变。无删除请求，不测试“重置日志”旧模式 |
| `systemParameters` | perf后admin→参数配置→PAR-01编辑/保存/回读→恢复参数默认值→确认→查询 | 必须传 `performanceComplete:true`；PAR-01保存到31或32并回读，恢复为30。真实按钮会提交 PAR-01/PAR-02，故**写前要求 PAR-02已为15**并验证后仍为15；否则停止。本 case 不默认运行 |

频点维护改变当前资源版本，旧已确认方案保留。主必须将此组安排在依赖当前资源的 perf/规划/诊断验证之后，或明确串行安排后续数据锚点；不得把旧方案显示为当前资源的新计算结果。来源配置及受理记录均为构造联调，不代表真实连接、下发或实测。

## Harness 合同与续跑

已只读核对 `tests/manual/r6_browser_acceptance.mjs`：record、shot、download 标签严格遵守 `[A-Za-z0-9_-]+`，抽屉以已安装 PrimeVue 的实际标题节点和头部关闭按钮定位。每次入页使用独立查询标记触发完整重载，避免同 URL 导航保留旧页签而没有新 HTTP。宿主不改。

已按主真实UI反馈修正按钮定位：文本按钮统一按 `getByRole('button').filter({hasText: /^\s*可见文本\s*$/})` 定位，动态文本先转义正则；不依赖可能混入 PrimeIcons `::before` 字符的精确 accessibleName。明确有 `aria-label` 的纯图标按钮（来源搜索/查看或编辑/导出，以及观测上一帧/下一帧/播放/重播/后页帧/导出观测）单独使用精确 label。全部仍保留唯一匹配断言；未调用主登录代码，也不把选择器假失败计作业务缺陷。本修正待主浏览器复验。

另已核对主报告的相邻单元格文本拼接边界：D脚本没有 `\b` 行匹配。设备行和频点行以带编号的精确 checkbox 定位，冻结成员行以精确 cell 定位；来源行仅使用字符串 `hasText`，观测行同时核对单元格和导入时间。均不依赖整行 `textContent` 中编号后的词边界，本次无需改脚本。此类探针定位失败不登记为业务失效，也不据静态核对声称浏览器通过。

主可直接沿既有 `--group operations` 使用环境变量选择一个case，优先最小执行：

```powershell
$env:R6_D_CASES = 'statusEntry'
# 由主执行已有宿主命令，runtime沿主本轮隔离目录。
# node tests/manual/r6_browser_acceptance.mjs --group operations --runtime-root <本轮目录> --task-id r4-network-89db2499fcf6 --plan-id PLAN-5273d94aa08345e4b047d62b915e2928
```

`R6_D_CASES` 可填逗号分隔的case名（无重名、全部校验）；未指定时只运行 `statusEntry`。未选case只返回 `notRun`，不创建 PASS 记录。成功后主换下一case，失败则保留现场和原号核实。导出的 `cases` 仍可由主已有Page直接调用；不强制执行大整组。公开观测身份可用 `R6_D_OBSERVATION_ID`、`R6_D_OBSERVATION_REVISION` 传入。参数仅主完成perf后选择 `systemParameters` 并设置 `R6_D_PERFORMANCE_COMPLETE=1`，或直接按下例传参。

```js
import { cases, runOperations } from './tests/manual/r6_browser_operations.mjs';

const harness = {
  page, runtime, login, record, download, shot, taskId, planId,
  // 主在本轮 .24 中准备的公开观测身份，须在观测列表第一页。
  observation: { datasetId, datasetRevision },
};

// 主控制执行时机；需要的case可逐个调用，失败即停。
await cases.statusEntry(harness);
await cases.deviceConfiguration(harness);
await cases.deviceTrace(harness);
await cases.frequencyAdd(harness);
await cases.frequencyPatch(harness);
await cases.frequencyEnable(harness);
await cases.frequencyDuplicate(harness);
await cases.spectrumSource(harness);
await cases.spectrumSourceReadback(harness);
await cases.spectrumObservation(harness);
await cases.systemLogs(harness);
// 主完成perf后才调用，默认runOperations不包含参数写。
await cases.systemParameters({ ...harness, performanceComplete: true });
```

`login(role)` 使用主提供的实际登录表单，角色为 editor/admin；清理本测试 context 并完整重载只用于身份设置，不计作产品退出证据。每个 case 重新载入真实页面以清空页面草稿，**不能用此动作推断服务端写入取消**。

`record(id, fn)` 负责 JSON/失败截图落盘，fn失败需抛出。`download(action, label)` 先挂下载事件，再执行 action，保存 F 盘并返回文件摘要；脚本另对同次真实响应的附件头、正文身份、长度、SHA-256作断言。`shot(label)` 由主保存截图。脚本不假设 runtime 的文件结构，不自行持久化账号、请求体或任何私密材料。

默认频点/来源编号以 `taskId:planId` 的SHA-256前12位确定，可通过 `frequencyId`、`sourceId` 指定已登记编号续跑。每个写动作只提交一次；若已发生写入后后续断言失败，主先查看原截图/HTTP回执，核实原号，选择下一case。不得重新运行整组以掩盖失败或生成重复记录。`spectrumSourceReadback` 可在来源保存后独立续跑。

`spectrumObservation` 不写观测或状态，依赖 A/B/主准备的带V2冻结引用、2至256帧的观测；提供精确 `observation` 优先，否则仅从第一页选择2至3帧资料并要求确有冻结绑定。缺前置就失败，不降级为通过。帧分页有上限，末帧仅播放一次；冻结引用只验首20名成员，返回未测成员页数，不声称全成员或全时段通过。

`runOperations(harness)` 优先使用 `harness.caseNames`，其次使用 `R6_D_CASES`；未指定时仅执行最小的 `statusEntry`。选择多个case时按给定顺序执行，任一失败立即停止，返回实际结果及未选case名单。主可先跑只读case，把频点换版和参数写放到perf之后；整组从未执行，不承诺一次通过。

## 当前证据状态

- 静态校验：`node --check tests/manual/r6_browser_operations.mjs` 退出0；Node模块导入及12个函数导出检查退出0；两文件字节检查均无 UTF-8 BOM。以上均未启动浏览器、服务或发起HTTP，不计功能通过。
- 浏览器及真实 HTTP：**NOT_RUN**。本组按分工只编写工作流，主尚未调用则不得登记为通过。
- 服务启动、依赖安装、全仓检查、生产打包、备份：**NOT_RUN / 不在D范围**。
- 状态成功导入/跟随刷新、账号/角色/密码：**未执行 / 本组排除**。
- PAR-01保存及默认恢复：**NOT_RUN_WAIT_FOR_MAIN_PERF**。
- 生产缺陷：当前没有浏览器执行证据，不据静态阅读登记生产缺陷或扩大生产文件写集。
- 文件12/13：只读核对，D没有修改接口或完成状态；主执行后按实际证据统一登记。

## 收口与交权

2026-10-24 主解除定向测试暂停后，D已完成最终静态定向检查并交回上述两文件的独占写权限。此后由主统一执行最终源码浏览器验收及维护这两个文件；D不再并发写入。D没有另获生产文件补丁白名单，未修改A/B/C或主宿主文件，未提交、推送、启动服务或安装依赖。

- 最终 `node --check tests/manual/r6_browser_operations.mjs` 退出0。
- 最终Node模块合同检查退出0：12个case均为函数，均有同名导出，函数名满足最新宿主 `--entry` 规则；入口固定 `.24:5324/8124`。这是静态合同检查，不是12项浏览器通过。
- 两文件均为可严格解码的UTF-8且无BOM；操作脚本SHA-256为 `b671a5b34af2450e717f9f02c2149af9b582e519b62d89edcc87183fbe0d1207`。
- B两后端文件及新增性能测试的独立只读复审结论为无阻塞：全批记录读取后校验再解析成员，保留版本/哈希/数量/字段校验及调用方session边界，`_snapshot`二元返回不变，未发现可变引用泄漏。D未执行B测试，不将复审写成测试通过。
- 主报告独占HTTP性能复测40样本通过，给定证据位置为 `runtime/r6/8b45b9d7746844cb9165f53b4cd7e958/report.json`；D未重新读取该报告、未复跑流量，不将主HTTP结论外推为浏览器通过。
- 主明确尚未运行浏览器performance脚本，因此D的 `systemParameters` 仍保持显式门禁，不能仅因HTTP复测结束就设置 `R6_D_PERFORMANCE_COMPLETE=1`。其他未选或未执行case仍为NOT_RUN。

主可从默认 `statusEntry` 或用 `--entry runDeviceConfiguration` 等单个导出函数开始；需传公开观测身份或参数perf标志时，使用既有 `--group operations` 加 `R6_D_CASES`/对应环境变量入口，无需改宿主。实际UI/HTTP失败由主保留原始证据并核实原号，不自动新建请求重提。

## C 覆盖离开保护独立只读复审

按主本次授权，仅追加本节；未修改C生产或测试文件，未读取私密配置，未运行测试、浏览器或HTTP。审阅四个组件/宿主的当前diff、新增 `tests/coverage-leave-guard.test.ts`，并只读核对既有 `useFrozenCoverage.ts`、auth及路由成功/失败清理链。下面行号均相对 `front_design/radio-planning-20261022/`。

结论：**有1处阻塞，P2，成功路由离开后未清除已明确放弃的失败原号。**

- 位置：`src/components/FrozenCoveragePanel.vue:317` 仅在非延迟模式丢弃；`:321` 路由守卫固定调用 `requestLeave(true)`；`:324` 成功卸载仅释放监听和取消对话框，没有执行延迟丢弃或清sessionStorage。记录恢复入口为`:274`至`:279`。
- 触发：带宽选择POST被明确4xx拒绝，原号及选择以rejected保留；用户通过真实路由菜单离开，在覆盖对话框选择“放弃未确认选择”，其余守卫也通过并成功卸载。该路径既不调用`:303`的存储删除，也不触发auth退出成功才运行的cleaner；返回原账号原方案后`:279`再次恢复已放弃原号，重新锁定选择并提示保留失败输入。
- 要求：记录延迟放弃决定，并仅在本次路由成功离开后清理原来源的失败记录和本地选择。其他守卫取消、导航失败或退出HTTP失败时继续保留输入；不可提前清理来绕过该要求。
- 缺少的对应测试：`tests/coverage-leave-guard.test.ts:65`开始的路由用例只调用被收集的守卫并检查允许返回，随后走logout失败/成功；没有验证路由成功后的卸载、原sessionStorage清除及回到原来源不恢复。应补完整成功离页后重挂，并与导航失败仍保留对照。

其余所查未发现新增阻塞：sessionStorage按账号及完整query分键（Panel:267），恢复核对plan/task/snapshot/resource和选择结构（:276）；未核实原号阻止离开（:311）；退出成功后才运行清理（既有`src/stores/auth.ts:84`至`:87`），失败路径保留输入；步骤切换先询问覆盖面板（PlanningApiView:477）且覆盖宿主不按步骤卸载（:257）；BandwidthEditor显式丢弃有busy保护（:108）；反馈抽屉的beforeunload注册和卸载移除成对（DiagnosisFeedbackDrawer:38至:40）。这些是源码复审结论，不是新增测试通过或真实UI验收证据。

## 恢复后的复审与执行准备

2026-10-24 主恢复磁盘空间并重新交付D两文件写权。本节为上述历史NOT_RUN及P2结论的后续记录，不将此前未执行动作改写为通过。

- C最终P2修补只读复审：**无阻塞**。`FrozenCoveragePanel.vue:321`至`:340`将来源、原请求对象和路由to/from固定到本次离开意图；afterEach有失败时不提交放弃，仅在路由成功、真实卸载、来源及原请求仍一致且无未核实写入时清原来源sessionStorage。其他守卫取消、导航失败或退出HTTP失败不走该清理。
- 新增测试源码已补成功导航后卸载再挂载不恢复旧原号（`tests/coverage-leave-guard.test.ts:107`）、取消/导航失败后重挂仍保留（`:113`）、退出HTTP失败保留（`:118`）。D只审阅测试，未运行这些单元测试，也不以此代替真实UI。
- `node --check tests/manual/r6_browser_operations.mjs`退出0。只做语法检查，未产生浏览器或HTTP流量。
- 主已发本组run token：仅执行deviceConfiguration/statusEntry/deviceTrace、spectrumSource/readback、构造finite V2 import/observation和systemLogs。本组最多一个operations context；不运行frequency四项，不执行systemParameters或setup/restore，PAR01=30、PAR02=15保持不动。
- 第一次CLI在加载依赖时因前端package找不到playwright退出，未启动浏览器、未登录或提交业务。改用已存在的本机`C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json`，通过宿主既有`--playwright-package`传入；未安装依赖或修改宿主。
- 后续实际结果按case及本轮证据目录追加，未完成项继续NOT_RUN；构造观测来源说明及未知值语义保持不变，不代表实测、采集连接或性能通过。

## D真实浏览器分段证据

使用最新源码dev服务、主现有账户真实表单登录、Edge及既有本机Playwright。每段串行复用operations profile，仅`.24:5324/8124`；不运行性能计时，下面耗时不作为性能验收。

首个状态入口尝试`browser/r6-browser-1792855081168-d15001/`记录FAIL、0 pageerror：`expand`内部has定位器重复带入外层region，未匹配实际可见summary。没有状态POST或业务写入。已仅修operations脚本两处相对has定位（展开summary及观测导入的批次目录），保留该失败证据，不归为产品缺陷；修后语法检查退出0。

成功首段：`data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792855361026-376d76/`，宿主`results.json`/`group-result.json`及截图均已落盘，completed=true、3 PASS、0 FAIL、0 pageerror。

| Case | 实际结果及原号 | 边界 |
| --- | --- | --- |
| statusEntry | PASS；真实读取46个同版快照目录，畸形JSON及无效schema均本地拒绝，放弃输入后目录回读一致 | 无状态写入，不测试imports成功或follow |
| deviceConfiguration | PASS；设备`DV-0001`，原号`DCUI-0d16b660-e45c-45dc-8200-b316d056f169`，真实校验、系统受理、历史选择及原号GET回读一致 | `ACCEPTED`/`SYSTEM_ACCEPTANCE`/`NOT_DISPATCHED`；执行、生效、在线未知，台账来源未变 |
| deviceTrace | PASS（已执行分支）；来源`resource-e4a642d6ea91744b`，只读生成候选`compatible=false`，未保存，刷新后当前资源版本不变 | 本设备无RESOURCE_CHANGE历史，操作明细分支为`NOT_RUN_NO_RESOURCE_CHANGE_HISTORY`；不声称已测真实历史恢复保存 |

本段当前资源版本始终为`resource-7c8bd11ec30d0ed4`。未运行frequency四项、systemParameters或setup/restore。

为遵守同号续跑，spectrumSource增加已存在路径：精确搜索同一确定性编号，核对完整构造draft及SPV版本，通过真实“查看或编辑/版本记录”读取；不重复保存，返回`reusedExisting=true`与`saveEvidence=NOT_RUN_ALREADY_EXISTS`。只有真实新建POST受理的路径才返回`REAL_UI_HTTP_SOURCE_SAVE`。此说明不预先宣告来源case通过。

## 崩溃后暂停与串行续跑准备

来源段`data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792855589796-ab363f/`真实FAIL、0 pageerror，缺少入页后的`GET /resource/context`及`GET /resource/devices`；保存的DOM为空，仅有认证读取及登录POST，没有来源保存、离线检查或观测导入POST。该次未产生来源业务原号，不据空白启动现场推断产品根因。首段3 PASS及配置原号保持；不重跑已完成受理，不确定业务写入为无。

2026-10-25主恢复为串行调度，当前唯一浏览器token归C。D仅静态准备，不启动测试、HTTP、浏览器、算法或服务，不改production。来源段CLI已退出；此后没有新的D业务写或新运行session，未覆盖既有checkpoint。

收到D独立token后按下面入口分段，沿主指定runtime、taskId/planId及既有本机Playwright依赖，最多一个operations context，前段退出后才启动下一段：

1. `--group operations --cases spectrumSource,spectrumSourceReadback --performance-complete 1`：同一确定性sourceId，新建或只读复用明确区分，离线检查/导出后保留实际SPV与checkId；不执行既有3 PASS。
2. `--group operations --entry runSpectrumObservationImport --performance-complete 1`：只读选同资源既有DSS；内存构造3帧V2非实测JSON，经真实文件控件/预检/提交，保留requestId、OBS版本、DSS及source原号。时间、占用率、功率、异常判定保持null/未知，不造正常值。失败若已观察到requestId，只允许传`R6_D_OBSERVATION_REQUEST_ID`只读核实原号，不重提。
3. `--group operations --cases spectrumObservation,systemLogs --performance-complete 1`：以第2段精确OBS身份读取有限播放/冻结引用/导出，再查询并归档日志视图，保留原事件；不删除记录，不改PAR01/PAR02、账户、认证或角色。

这些续跑尚未执行。frequency四项仍须末尾主另行放行；资源版本不得提前更换。statusEntry重复外层region的两处selector已修，且第一处已真实复跑PASS，不再按旧失败状态报未修。

## Planning MemoryError只读调查

范围仅源码、DEM/地物JSON头部及既有手工脚本；未读取秘密配置，未运行算法、测试或HTTP。**存在明确可优化的加载峰值及计算派发并发风险，但尚不能据本次OOM定位根因，也不修改业务标准、节点数量、DEM分辨率或算法约束。**

| 静态结论 | 精确位置与边界 |
| --- | --- |
| 可确认的临时整幅复制 | `scripts/geo/grid.py:25`至`:28`先gzip无界`read()`生成完整bytes，再`array.frombytes(raw)`复制；构造期间两份栅格有效载荷并存。`scripts/terrain.py:66`至`:67`每次依次新建DEM/地物，`scripts/planning/sr4_flow.py:725`及`:514`为正常/父方案路径各自加载。当前头部DEM为67,560,480字节、地物41,702,400字节，常驻数组合计约104.2 MiB；创建地物时仅数组+raw载荷约144.0 MiB，尚不含gzip缓冲、数组扩容和其他业务对象。这是源码/头部估算，不是实测RSS或峰值上界，不能单独解释数GiB提交耗尽 |
| 作业派发没有全局计算并发上限 | `algorithm-service/app/planning_w3.py:163`每作业直接新daemon线程；`planning_job_service.py:437`至`:440`只禁止同taskId的PENDING/RUNNING，`_SUBMIT_LOCK`只覆盖预留/状态事务，不覆盖整个求解。不同任务可同时加载各自DEM及求解结构；没有证据证明事故时具体运行数量。取消是检查点协作退出，终态标记也不能等同内存已释放 |
| FAILED进度1不能定位故障阶段 | `planning_w3.py:157`至`:160`对任意异常统一写`FAILED, progress=1.0`及异常类型/消息；因此E的FAILED/1不能用来判定刚进入DEM或第1步即失败，仍需已有异常堆栈或现场指标 |
| 未见SR4内部并行/每候选复制DEM | 已查SR4、实际频点评分及多目标搜索调用链，未见线程池或进程池；`scripts/planning/actual_search.py:407`及候选scenario均复用地形对象。检查次数/评分有deadline及数量门限；`deployment.py:425`显式跳过候选×候选建矩阵。不把这些有限串行搜索改写成无界并行 |
| 地形指纹不是整幅读取热点 | `planning_adjustment_service.py:24`至`:31`已使用有界LRU及1 MiB分块哈希，不建议对此做无证据重写 |

建议审批的最小生产修复范围是**仅`scripts/geo/grid.py`的GridRaster初始化读取段，加专用小栅格测试文件（建议`tests/test_grid_raster.py`）**：有界分块解压进入同dtype数组，保留完整字节数、平台itemsize、大小端、尺寸及gzip完整性检查；截断/额外数据不接受，采样/nodata/坐标及实际像元值不变。分块应限制每次解压请求，不能把一次整幅`fromfile`误当降低峰值。D未获该生产白名单，未实施或运行测试。

计算派发限流是另一独立范围（`planning_w3.py:_spawn`及相关作业取消/并发测试），需要保留原号、排队/取消/终态及持久化语义后另行审批，不在单次OOM后临时扩大补丁。本轮应先按主的单浏览器、重计算独占安排续验，不能把释放环境资源或改小业务指标登记为代码修复通过。

## 来源初始读取静态准备修正

主明确暂不批准grid或全局并发生产修改，先按串行真实规划复测；D未改这些生产文件。当前仍无D浏览器token，以下仅编辑manual脚本和本记录，未执行node检查、测试、HTTP或浏览器。

只读核对`ResourcesView.vue`：频谱组件采用首次visited挂载及`v-show`保留，切回已访问页签不会必然再触发mounted读取；`SpectrumConfigPanel.vue:11`提供显式aria-label为“刷新”的纯图标按钮，disabled覆盖初始loading/待核实/忙态，点击调用真实`store.load()`。因此新增`openSpectrumSources`，用于来源保存/复用、来源回读、V2导入三处来源入口：

- 保留原`ledger`真实文档reload和资源context/devices响应断言，不通过API请求、隐藏store、evaluate或已有缓存替代。
- 页签点击只确认真实可见面板，不把“切页签必须GET”作为前提。等唯一刷新按钮可用（初始列表加载已结束），注册HTTP响应监听，再点击刷新；要求新`GET /spectrum/sources?page=1&page_size=10`为实际fetch/XHR、非service-worker、200/code0，响应页码/大小正确，面板无解析错误。
- 刷新后继续原精确sourceId搜索、版本/回执/原号断言；未添加任何POST/PUT/DELETE、重提交或自动业务重试，不放宽幂等保护，不改变来源正文或资源版本。

这是脚本静态准备，不是新增功能PASS；上次来源空白文档/资源初始GET超时仍保留FAIL，不能因本次处理页签缓存就认定那次故障是缓存导致。修后的来源三条路径待主独立token后逐段真实验证。

## Diagnosis Entry测试事件死等静态修补

2026-10-25主新增精确白名单：只修改新版前端`tests/diagnosis-entry.test.ts`及本记录，不修改production、C测试、公共helper或旧前端同名测试。C仍持唯一browser token，D不执行任何测试、浏览器或HTTP，等待主排队单文件复跑。

先只读确认：原本地click helper第59至61行`await onClick()`；导出用例原第124行让impact服务返回deferred Promise，先`await click(label)`，原第127行才`resolve(file)`。点击helper等待处理器，而处理器等待后面的resolve，是可由源码确认的循环等待；真实DOM事件派发不会等待异步处理器完成。同文件离页确认用例先点击GIS入口、再点击继续编辑，也不应让首次点击等待用户决定。

最小修正保留原button定位/存在断言、直接调用实际模板注册的onClick、保留`await nextTick()`；只是不再await处理器返回值。通过`Promise.resolve(result).catch(...)`收集带按钮label的意外异步拒绝，在afterEach原有卸载/Pinia/spy/global/env清理及nextTick之后断言集合为空并清空，避免静默吞掉处理器异常。同步抛错仍直接失败，待决Promise不加入任何等待屏障。

没有删除或弱化原业务断言，没有增加timeout，没有改生产来满足测试，也没有修改mountPage初始化或其他夹具。仅静态确认上述helper缺陷，不能据此认定全部26个超时已解决；全部用例都先执行mountPage，是否还有独立初始化阻塞需主单文件复跑证据，当前未确认新的夹具死等，也未擅自修它。

状态：**STATIC_EDIT_ONLY / NOT_RUN**。主所报其他4文件33 PASS不计为此文件通过；修后该文件尚无D运行结果，不记26 PASS或真实UI通过。

## Diagnosis Xlsx单项定位结果

主随后报告第二轮26项仍全部5秒timeout，故上节click缺陷修补不能记为全文件解决。按新增单项token，D仅在同一测试文件补实际`DiagnosisFeedbackDrawer`的import和现有`clientTemplate`清单，并添加`R6_DIAGNOSIS_STAGE=1`才启用的纯标签日志；没有抑制Vue warning、替换该Drawer为桩、修改production或C测试。radio helper原本不await onChange返回值，未改它；mountPage及服务契约也未作猜测性改动。

本token只使用**第1轮**，未使用第2轮、未重跑26项。命令在新版前端目录使用现有本机Node：

```powershell
$env:R6_DIAGNOSIS_STAGE = '1'
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' node_modules/vitest/vitest.mjs run tests/diagnosis-entry.test.ts -t 'xlsx 导出失败' --reporter=default
```

实际session为`61042`，已退出0，**1 PASS、25 SKIPPED**。该项4424 ms，原5秒门槛未改；总耗时23.21 s包含transform/import，不作为产品性能结果。主要default reporter输出为`Test Files 1 passed (1)`、`Tests 1 passed | 25 skipped (26)`。本轮未出现FeedbackDrawer缺客户端模板警告，afterEach异步拒绝集合断言为空。

stage实际顺序完整到达：`mount:enter`、`seed:planning:start/submitted/confirmed`、`seed:diagnosis:start/done`、`mount:services:bound`、`mount:preview:loaded`、`mount:router:push/pushed/ready`、`mount:render:start/done`、`mount:settle:done`、各点击`start/dispatched/tick`、`afterEach:start/cleanup/done`。由此可确认本次xlsx没有卡在seed、router.isReady、mount/settle、deferred导出或afterEach；不是仅因为删断言跳过了业务流程。

结论边界：**单项已真实通过；未复现此前全26 timeout，尚不能唯一归因为Drawer模板、click或机器压力中的任一项。** 全26统一复跑交还主，其他25项不登记为通过。测试用例正文及全部业务断言保留，未加timeout或sleep，stage默认关闭。1 PASS后立即停止新增测试，已报告交权；没有本组活动exec/browser、HTTP、算法或业务写入，既有operations3 PASS及配置原号不变。

## Diagnosis阶段耗时静态准备

主最终宿主全26报告`r6-diagnosis-entry-final-host-20261025.json`仍26 FAIL、session 99803退出1，约224秒；原5秒timeout及后续污染DOM断言均保留，不能由此前xlsx单项通过外推全文件已修复。此处记录主提供结果，D没有再次运行该文件。

按新增静态授权，在同一测试文件将stage升级为`performance.now()`计时：每次mount使用独立trace及闭包，输出标签、相邻阶段`delta_ms`、从mount开始的`elapsed_ms`，精确到小数点后三位；click、radio及afterEach捕获该trace，不因下一次mount重置时钟而重标旧调用。默认仍关闭，仅`R6_DIAGNOSIS_STAGE=1`输出；不输出fixture正文、账号、原号或秘密。未添加定时器、sleep、额外事件等待、互斥绕过或超时延长。

拆分的可观测边界为身份初始化、资源clone、保存任务、规划提交/保存/确认、四次诊断写前workspace读取、两场景分别保存/提交、服务绑定、preview读取、store创建、router push/ready、真实render及settle、点击分发/nextTick、卸载和afterEach nextTick。仅把原组合await拆成同顺序局部变量以记时，仍调用同一真实服务和校验，26项业务断言不变。当前没有执行token，这版计时尚未运行，不能宣称最慢阶段已经定位。

静态候选热点及不可变seed可行性：

- `tests/helpers/tasks.ts`的savedRequest会真实保存任务；resourceSource的taskMeta每次经`readResources(storage,initialResources())`重新读取/克隆资源。`planning-storage.ts:223`及`:250`在read/write分别执行JSON解析/序列化及完整冻结规划校验，不能只把顶层JSON文件大小当作运行时成本。
- 本地mutation当前四次调用完整`createDiagnosisMock.loadDiagnosisWorkspace()`取revision，`diagnosis-mock.ts:57`的loaded还会克隆预设、读取历史/来源。其legacy遍历每条记录两次upstream，upstream重新`readPlanning`及资源元数据；`diagnosis-storage.ts:52`/`:63`又在每次读写校验冻结网络与诊断结果。确认存在重复遍历/序列化，但未测量各自占比，暂不旁路或memoize这些生产校验。
- 若计时证明重复建seed是主要成本，可以在**本测试文件**通过真实PlanningMock/DiagnosisMock为各demo分支只建立一次seed，将storage条目的不可变字符串快照、最终时钟、确认workspace、runIds保存为私有不可变资产。每case新TestStorage和独立Map/读写历史/故障开关/计数器，资源/meta/确认workspace深克隆，新Pinia/auth/router、时钟和服务闭包；不得共享服务、Promise、可变网络或运行对象。当前normal、diagnosis-failed、impact-failed等分支不可混用；HTTP展示用例不能被强制改mock模式。
- 不可变seed只减少重复前置搭建，后续真实store、render、业务服务读写及验证必须照常执行，所有写入数/原冻结内容断言保留。不能用手写快照或去掉真实性校验换取通过。当前**未实施seed复用**，先等主单项计时token获得最慢阶段，再决定精确夹具改动。

本次只编辑测试文件和R6-D；未运行node检查、测试、HTTP、浏览器或算法，未改production及公共helper。

## 主执行来源段真实证据补记

主已串行真实执行来源保存及回读；D仅只读核对`data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792867484463-9c2302/results.json`和`group-result.json`，不重跑原号。主报告exit0、2 PASS、0 pageerror，与落盘case及group结果一致：

- sourceId：`SRC-R6-D-7f80d1313ebc`。
- SPV：`SPV-d849051f2fb66f36b2645bd5a21856ceaf09180f185bd053a450dfcbf18ef531`。
- 保存原号：`source-save-adbc912f-6015-4273-bb08-928909a18647`；`reusedExisting=false`、`REAL_UI_HTTP_SOURCE_SAVE`，本次确有真实保存，不是仅复用缓存。
- 离线检查原号：`source-check-2ebaea6e-ea6e-4116-93c4-ae81bacf5dcf`；连接`NOT_ATTEMPTED`，不代表真实采集连接成功。
- 配置下载520字节，SHA-256=`fe99771a4c76c29a5ef693ce898247d187822cb6c7252b27a93febc0f407736d`，文件位于上述证据目录的`r6-d-source.json`。

结合此前deviceConfiguration/statusEntry/deviceTrace已执行分支，共5项operations PASS；deviceTrace真实修改历史分支仍待A后安排。V2观测导入/播放/冻结引用及systemLogs尚未执行，不增加PASS；frequency四项、PAR参数及认证保持不动。D当前无执行token、活动browser或不确定业务写入。

## 主执行V2导入与终帧脚本修正

主已实际完成V2导入，D只读核对`data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792867614620-98c2d2/`的results/group-result：completed=true、1 PASS、0 pageerror，不重导入或新建来源。

- 导入原号：`observation-import-d869bcd1-bf31-450c-b576-e56364dd97b3`。
- 观测：`OBS-R6-D-7f80d1313ebc`，版本`observation-52a4b11ea0ab4cc2a1c3812f334e2dd24643e54b02e427356bce98556dd84b85`，3帧，source/SPV沿用上一节原号。
- 资源：`resource-7c8bd11ec30d0ed4`；冻结引用`DSS-2187f205dedb43408fa4290b9779af8d`，版本`device-status-494382e7366c5e8eb12de3b828c9058a60335eb2aa8b4403f704cd29bc733912`，声明成员`DV-0001`、`DV-0002`，只读未修改。
- 内存JSON为2353字节，SHA-256=`8cbe742f182f4ccb9b97d6fb558986560e19ef3021dcd4c40d2e2b4247e6c54d`。原号GET方式为已明确标记的只读浏览器文档导航，未假称成功回执有UI查询按钮。构造/非实测来源说明及所有未知值保留，不代表采集连接或性能通过。

后续`browser/r6-browser-1792867711821-00e60c/`只读观测case真实FAIL、0 pageerror，systemLogs尚未进入。已读DOM显示“已到末帧 · 3 / 3”，HTTP最后一帧`frames/2`为200；错误停在末帧后的“播放”按钮可见性等待，不是获取末帧失败。以下为静态分辨：

- `src/services/monitoring-playback.ts:43`到末帧只设置finished，未清active；`:19`及`:35`同时以finished阻止继续调度/next。因此active不等同还有定时推进。
- `src/components/SpectrumMonitoringPanel.vue:29`的toggle标签依active为“暂停/播放”，禁用条件包含finished；下一帧同样按finished禁用，`:34`优先显示“已到末帧”。该行为能解释DOM末帧、禁用toggle及找不到“播放”的组合。
- 结论为**manual脚本固定末帧标签的假设错误**，当前未发现需生产补丁的越帧、循环播放或禁用条件缺陷，不申请或修改production。若另外要求末帧重命名toggle，属于独立界面一致性需求，不作为本次等待超时的业务故障。

已在原manual白名单内将末帧断言改为唯一`button[aria-label="播放"], button[aria-label="暂停"]`toggle，仍断言其disabled、下一帧disabled、真实终帧HTTP与3/3状态，以及随后1.2秒无帧请求/不回绕、重播真实GET回首帧暂停、冻结成员及导出全文/哈希。结果会记录终帧实际aria-label和禁用状态，不静默丢弃该证据。没有替换成隐藏store读取或API调用，也没有点击暂停来掩盖终帧行为。

本次修后**STATIC_EDIT_ONLY / NOT_RUN**：D未启动测试/浏览器/HTTP，没有重导入、新source或其他业务写；失败证据保留，不记观测播放或systemLogs PASS。累计为既有5项加V2导入1项operations PASS，后续只读观测和日志仍待主串行续跑。

## 诊断宿主不可变Seed静态实施

按主内部批准，仅修改新版`tests/diagnosis-entry.test.ts`和本记录，未改production、C测试或公共helper，无测试/浏览器执行token。本节是上述seed方案的实施后续，不把先前全26 FAIL改成通过。

- 从原mountPage逐case建库部分抽出`buildSeed(demo)`，与现有clientTemplate顶层await同层，按normal、diagnosis-failed、impact-failed依次await建三份seed，不用Promise.all并行，不转入单个beforeAll，不调整测试/hook超时。
- 每份seed仍完整调用原savedRequest保存任务、PlanningMock提交/保存/确认、四次真实诊断workspace读取、两场景保存/提交。保留资源全量、原preset、请求签名、冻结引用及校验，不手写正常结果或存储正文。
- 建库只用显式TestStorage、资源provider及模拟时钟，不调用authorizeStore/useStore/setActivePinia/previewService，不依赖活动身份或Pinia。真实服务所需crypto仍使用原运行时；不调用系统登录、改密、角色或HTTP。
- 整份seed先structuredClone再递归freeze，包含键值字符串元组、writes、读写历史、current、确认workspace、runIds和模拟时间；外层三分支目录也freeze。不把可变Map、服务实例、Promise或store保存进seed，不因clone丢失undefined字段。
- 每case重新创建TestStorage和entries Map，恢复本分支实际写入计数，复制读写历史数组；故障开关/集合来自新实例。current及确认workspace分别structuredClone，runIds数组独立，时钟为本case局部变量；DiagnosisMock、createMockService、Pinia/auth、store、router及页面实例均重新建立。原`writes:storage.writes`仍在挂载后取本case基线，原写数/调用次数/错误/冻结内容断言未改。
- 原模拟时间保持规划起点加10000ms后建立两次运行、每次加12000ms，最终起点加34000ms；advance(-10400)和advance(-11900)含义不变。runId等值保留真实seed生成结果，与各自克隆存储引用一致，不重新编号；隔离依赖不同Map/对象/时钟/服务，而不是伪造新ID。
- `resources.json`设备/节点来源ID固定，initialMeta的epoch/revision为initial且不随机；任务版本、条件版本、规划作业/方案、诊断场景/运行及回执ID由每份seed的真实调用生成。current保留原资源及initialMeta，resourceSource仍每次从本case存储读取taskMeta，不用共享来源结果替代。
- 原真实FeedbackDrawer模板、非阻塞DOM点击、异步拒绝断言、性能stage开关及真实store/render均保留。seed建库与case挂载分别独立trace；新增说明注释均为中文，先前英文DOM派发说明也已改为中文。

主已预授权：若后续实际失败暴露非阻塞click后的导航/抽屉/decision时机，只在原断言前等待实际currentRoute或可见状态，沿原5秒预算且不删原值/次数/写数断言；不得加sleep或盲增nextTick。本次**尚未实际运行新seed版本**，没有据猜测新增等待或声称已消除超时污染。若新一轮仍失败，先按stage和真实初始化状态报具体位置，再作对应最小修补。

状态：**STATIC_EDIT_ONLY / NOT_RUN**，待主review后统一排队全26一次；D未自行启动类型检查、单测、浏览器、HTTP或算法。既有业务证据与原号不变。

## Seed宿主23通过后的精确时序修补

只读核对主已结束的`data/runtime/r6/r6-diagnosis-entry-seeded-20261025.json`及同名log：旧26项为**23 PASS / 3 FAIL**，总106.33秒（import 50.08秒、tests 51.82秒），session 15687已结束；不是26项全超时，也不将先前单项PASS外推。D未复跑。

三个失败的证据与仅测试文件修正：

1. “首次无运行显示创建引导，明确选择网络才建立草稿，历史手动打开”在原303行点击新建后立即断言抽屉存在。trace11显示click已dispatched/tick，`openSource`仍需等待refreshSources后才显示Drawer。现将同一存在断言放入vi.waitFor，并在确认创建后等待该真实Drawer消失再继续原草稿/按钮/历史断言；不等待处理器Promise，不修改页面流程。
2. “场景草稿与撤销历史交给GIS”原377行在router.push异步完成前读query，得到空对象。现仅在原query/path/草稿/撤销历史/dirty/写数断言前vi.waitFor实际path为`/situation`，原精确query仍逐值断言。
3. 原多网络copy复合用例确为累计流程超过5秒：trace12的mount于1321.750ms完成，第一次打开2091.020ms、第二次打开2938.362ms、创建点击2941.979ms均到tick；后续创建/重新读取累计到4858.806ms才开始第三次打开，最后click tick为5597.568ms，afterEach正常完成。没有卡在await事件Promise，因此按主条件授权拆为下列两个独立mount的聚焦case，而不是增加timeout。

| 旧多网络copy语义 | 新用例及原断言映射 |
| --- | --- |
| 其他网络置首，取消不改原报告，再复制仍优先原网络 | “复制在多网络中优先原网络，取消不改快照”：保留取消后的报告JSON不变、创建后的draft.planId/network.id精确为原网、原record不变、storage.writes不变。打开/取消/创建只等真实Drawer显现或消失 |
| 原网络不在有效目录中，必须明确重选，原快照不变 | “复制时原网络不可用必须重新选择，原快照不变”：新mount后设置仅另一网络的同一目录夹具，保留替代网络提示、创建按钮disabled、原报告JSON不变、storage.writes不变。不再复用前半段草稿后discard/reselect来搭前置，所有业务断言原样保留 |

**新总数为27项，不是26项。** 原26语义中仅一个复合case拆成两个，另两处加真实DOM/router条件等待；其余23项不变。等待沿现有vi.waitFor及原5秒预算，不新增sleep、定时器、testTimeout/hookTimeout，不缩减资源、不改production、C测试或公共helper。新增解释注释为中文，stage计时及不可变seed隔离保持。

本次修补状态为**STATIC_EDIT_ONLY / NOT_RUN**；git diff --check退出0，但不等于类型检查或测试通过。D无执行token，没有启动类型检查、测试、浏览器、HTTP或重算。交主review后统一排队**27项**复验；旧23 PASS保留为旧版本实际证据，新版本27项不能提前记通过。

## 诊断宿主最终27项通过与冻结

2026-10-25主完成组合复验，D只读核对：

- JSON：`data/runtime/r6/r6-diagnosis-entry-interference-final-20261025.json`。
- 日志：`data/runtime/r6/r6-diagnosis-entry-interference-final-20261025.log`。
- `diagnosis-entry.test.ts`文件status为passed，**27 PASS / 0 FAIL / 0 PENDING，无timeout**。保留原26项语义，其中一个复合copy用例拆为两个独立case，映射见上一节。
- 整个组合为2文件49项：D文件27 PASS；另一`gis-interference-resource-entry.test.ts`为22 FAIL，所以组合并非全绿。该文件不在D写集，本次未调查、修改或复跑它。
- 91.03秒为整组合耗时，含transform 13.16秒、import 34.77秒及tests 54.34秒，不作为D单文件耗时或产品性能指标。以上为主实际执行证据，D只读核对，没有另起测试。

本节将新D宿主27项状态更新为**PASS（内存宿主单元/组件测试）**；不是浏览器UI或所有后端功能通过。原5秒门槛、全部原业务断言、真实服务seed、实际store/render及逐case隔离保持，production代码零修改。

按主要求冻结`tests/diagnosis-entry.test.ts`：不移除stage、不继续改动、不扩测或重跑。D当前无执行token；没有新增测试、浏览器、HTTP、算法、资源或状态快照写入。资源末尾deviceTrace真实变更历史及frequency四项等待主另发token；此前已登记的实际业务原号及证据不变。

## 末尾Trace恢复范围修正（静态方案）

主已纠正A维护内容：`tests/manual/r6_browser_resource_writes.mjs:213`的maintenance实际选择可见台账首个ACTIVE设备，将已知`antennaHeightM`显式加0.1 m保存；随后再加0.1 m作为草稿，验证继续编辑后放弃，后一次输入没有保存。不是metadata维护。D此前基于metadata所报不可恢复边界不适用于这次挂高操作。

目标必须来自A实际`resource-writes-state.json`：`anchors.maintained_device_id`、`cases.A-R03-maintenance-save-discard.detail.before_height_m`及`operations.R03-save`的原请求/回执。预期设备为`DV-0001`；若实际不同，先交主核对，不擅自替换目标或改另一设备。主随后补充并经D只读确认：默认G02还会将选中设备当前挂高加0.2 m保存，因此末尾当前值必须再核对`cases.A-G02-edit-undo-redo-save-readback`及`operations.G02-save`，不能把R03的after直接当最终值；两条记录必须属于同一maintained设备。恢复目标仍仅为R03的`before_height_m`，不按当前值反算或凭假设减0.1/0.3。

静态可达路径及限制：

1. 用真实台账控件读取最新资源context及目标完整明细，打开“设备资源追溯”，分别选择R03/G02原号并核对`RESOURCE_CHANGE`、before/after、base/revision、device和actor。G02.before的完整设备记录必须等于R03.after，当前完整设备字段必须对应G02.after。除挂高外，两次操作前后及当前目标的射频、型号、节点/天线关联、可用性、状态、告警、模式/端口等设备业务字段均须保持一致；不把null转为正常或零。版本和回执身份分别核对，不要求恢复后资源revision退回旧值。
2. `useDeviceTrace.ts:50`以所选条目的`revision`生成候选；`device_trace_service.py:128`按该版本取设备。因此直接选择A维护原号，得到的是该次保存后的值。要恢复before，必须在实际历史列表中选择维护前已有的留存基线或上一条设备修改，核对其原号/版本与A记录的目标值一致，不向接口私自传入UI未选中的base_revision。
3. 点击“生成三参数恢复候选”，要求真实preview响应的device/model/base/source身份一致、compatible=true，且patch和changes都**仅含**`antenna_height_m`，目标精确为`before_height_m`。三参数中任何额外差异、来源未知、型号/可用性不符或目标已被别处改变，均停止并报边界，不手填替代候选。
4. 点击“交资源维护确认”进入真实“编辑设备参数”，核对整表单后通过“关闭”及“放弃本次修改”取消；断言没有资源持久化请求，刷新后挂高、完整设备字段及资源版本/哈希未变。再沿同一真实历史来源重建候选，保存当前设备仅一次；保留该次请求原号及回执，不因超时自动再点。
5. 保存后真实刷新/复开目标，要求挂高等于R03的`before_height_m`，其余全部设备业务字段与恢复前逐字段一致；校验资源操作仅作用于这一设备的挂高。重新查询历史，R03/G02两条原历史及恢复原号均保留，原历史完整字段未被改写，恢复before对应G02.after、after挂高为R03.before，既有状态快照不改写。

当前UI和后端支持已知且符合型号约束的挂高恢复，经`ResourcesView.vue:985`载入统一资源维护表单，最终仍由资源底座保存。若历史UI没有匹配的维护前条目、候选不兼容或实际保存不可达，必须报告实际边界，不伪造恢复完成。

本节为**STATIC_REVIEW_ONLY / NOT_RUN**；未新增entry、未修改manual或production、未生成恢复请求。频率四项和此恢复段仍待主末尾执行token。

## Positive状态UI导入方案（静态核对，尚未编码）

现有statusEntry只覆盖非法JSON/schema的本地拒绝；外部writer的性能样本不计为UI正向导入。主批准未来仅在D manual内新增独立entry（拟名`runStatusImportPositive`），安排在A资源维护、D频率四项及Trace恢复全部结束后、FinalRefresh前，真实上传并提交一次完整构造状态，不另写资源底座或重复导入。

已只读核对模板`data/runtime/r6/563f24e31f094761934e4c067befe138/import-payload-0.json`：414条，NORMAL 104、FAULT 104、OFFLINE 103、未知103；其旧base_revision及已有观测时间不能当作末尾当前资源/实测时间复用。实际输入由`device-status-decode.ts:49`严格限定，额外字段会被拒绝。

| 字段 | 末尾构造映射及断言 |
| --- | --- |
| `schema_version`、`context` | 固定为`device-status-snapshot-a1`、`ledger` |
| `request_id`、`base_revision` | 保留一个唯一原请求号；资源版本取末尾真实UI读取的当前context，不硬编码旧resource |
| `data_origin`、`source_label`、`provenance_note` | `SYNTHETIC_INTEGRATION`；明确“构造验收、非实测、采集时间未知、不是全设备正常或在线证明” |
| `records[].device_id/node_id/model_id` | 以真实台账分页HTTP响应中的当前完整设备集合及关联为准；唯一、无遗漏/额外ID，数量不硬编码414。必需关联缺失则停止，不伪造ID |
| `records[].status/alert` | 仅ID及node/model关联均未变时复用上述既有构造模板；新增或关联已变的设备均为null，原未知继续为null，不从availability或旧资源展示值推断正常 |
| `records[].observed_at` | 全部null，不复用模板中构造时间、不填写本次墙钟时间冒充采集时间 |
| `records[].unknown_reasons` | 保留模板原因并去重补充非实测/时间未知说明；新设备注明无观测资料。任何null均有原因；不静默截断超限原因 |
| 非输入字段 | 不写availability、DSS号、snapshot_revision、actor或imported_at；availability由服务冻结当前资源，DSS/版本/导入时间取真实回执 |

输入每条恰为上述7个record字段，顶层恰为8个字段；records为1至1000条，文件不超过UI的2 MiB限制。未来通过实际分页控件枚举当前设备，要求所有页revision/总数一致；不使用page.request、evaluate、隐藏store或私自API读取来绕过页面。

实际UI路径为“设备状态快照”区域 → “显式导入构造状态” → “构造状态 JSON 文件”控件 → “校验并导入”。此组件没有独立预览/确认抽屉，不编造预览证据。文件选择只读入本地，唯一持久化提交是该按钮触发的`POST /api/v1/device-status/imports`。

原号保护和回读方案：

- 上传/提交前先单独调用harness record，将request_id、完整非秘密构造正文、模板身份、当前资源revision/哈希、记录数、字节数及SHA-256落盘；record返回确认后才允许点击提交。该条明确为意图检查点，不计功能验收PASS。相同意图已有已发送/回执记录时只核实原号，不生成新号绕过。
- 正向回执核对原request_id、DSS号、snapshot_revision、resource_revision、total及content_hash。若结果不确定，停止本组并保留原号/正文/已知DSS；只允许现存“核实原导入编号”进行只读核实，不自动点击“原号重试导入”。成功后该核实按钮不会继续显示，不能谎称通过它查询了成功原号；页面reload后待核实状态也不保证保留。
- 成功导入不会自动选中新批次。通过“读取批次”及目录中精确DSS号选择原批次，断言真实header及devices响应；经“下一明细页”读完全部记录，逐条比较7个输入字段及服务冻结的availability，校验集合、分类计数、来源说明和全null观测时间。资源context的revision/哈希须保持不变。
- 保留该DSS和全部历史供FinalRefresh查看，页面可停在该固定批次，不切跟随、不清除旧快照；关闭context后不宣称Pinia选择会自动恢复，主后续可按保存的DSS原号选择。

状态为**STATIC_REVIEW_ONLY / NOT_RUN**：未新增正向entry、未导入状态、未改变任何资源或快照，27项诊断单测冻结不动。

## 主串行70814期间源码冻结

主通知session `70814`正在串行运行`operations spectrumObservation+systemLogs`，沿既有OBS/source/DSS核验修后的终帧toggle禁用、无回绕、重播，再做日志查询及非删除归档。D只记录该执行安排，未核对最终结果，不能登记新PASS。

在主确认该CLI结束前，冻结`tests/manual/r6_browser_operations.mjs`，避免运行中源码/行号漂移；本次仅补本R6-D静态方案，不修改manual、production、主harness或已冻结单测，不启动任何测试、浏览器、HTTP、算法或服务。其他system组role-create后脚本原号断言问题及原role恢复由主/A处理，D不接触账户、角色或认证设置。

## 主串行70814观测及日志实际通过

主确认session `70814`已exit0、context关闭；D仅只读核对`data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792873424679-2a7e7a/`的`results.json`、`group-result.json`和下载JSON，未再次启动CLI。落盘completed=true、failure=null、2 PASS、pageErrors为空，与主报告一致。主报告两段耗时41.951 s及19.881 s；results的case elapsed_ms分别为41713和19725，分别保留各自记录口径，不作为性能验收数据。

观测只读分支真实PASS：

- 沿原`OBS-R6-D-7f80d1313ebc`及版本`observation-52a4b11ea0ab4cc2a1c3812f334e2dd24643e54b02e427356bce98556dd84b85`，未重导入；下载正文核对来源`SRC-R6-D-7f80d1313ebc`及`SPV-d849051f2fb66f36b2645bd5a21856ceaf09180f185bd053a450dfcbf18ef531`，非实测说明及全部未知观测值保留。
- 3帧、terminalIndex=2，终帧toggle实际aria-label为“暂停”且disabled=true；修后case完整通过无回绕检查及真实重播回首帧，保留原标签，不扩改生产toggle命名。真实帧响应沿同一观测版本，未新建来源/观测/状态或资源写入。
- 冻结引用`DSS-2187f205dedb43408fa4290b9779af8d`及版本`device-status-494382e7366c5e8eb12de3b828c9058a60335eb2aa8b4403f704cd29bc733912`，resourceRevision为`resource-7c8bd11ec30d0ed4`；引用版本`OSR-470a99ce7f700ec267fe3dc9cb6ea65fabcba1c70f1b3ddc5cd73ea63faf8b32`。真实成员核对`DV-0001`、`DV-0002`两项，memberPagesNotRun=0，原DSS未修改。
- 下载`r6-d-observation.json`为2369字节，D另只读计算SHA-256与结果一致：`6d080fc04a7d5fbaff0acf0b60b467cc6c890915fedc16d3733a1d0fa8da7dd5`。输出包含原source/SPV及deviceStatusRef，不能以dataset中兼容字段的null否认独立冻结引用。

日志查询及非删除归档分支真实PASS：

- 归档操作原号`OP-8014042230cd4c1b973c05d3dd864141`，throughSequence=99；真实`POST /api/v1/system/actions/archive-logs`返回200，其后经实际查询控件回读未归档及includeArchived=true视图。
- 原事件`AUD-1ccd97676335425986c0e52477a82acc`在归档后仍可按原号读取，结果记录beforeTotal=99、afterTotal=100、deletedRecords=0；没有删除请求或删除记录，不把归档当清库。
- 此组仅执行spectrumObservation及systemLogs，其余group-result.notRun仍为本次未执行；没有改PAR01/PAR02、账户、密码、角色或资源版本。既往终帧失败证据保留，本次是修后同一观测的真实复验。

累计为已登记6项加本轮2项，共**8项operations实际PASS**，不包含尚未执行的frequency四项、Trace真实恢复写分支或positive状态UI导入，也不与27项诊断宿主单测混计。

按主本次通知，解除manual因session 70814运行而设置的临时源码冻结；D本次仍只修改R6-D，没有修改manual或production。上两节Trace及positive状态方案已交主，保持**STATIC_REVIEW_ONLY / NOT_RUN**；不据解除源码冻结获得执行token，不启动测试、浏览器、HTTP或业务写入，无D活动exec/browser或不确定写入。

## 末尾两个独立Entry静态实施及交回

主审阅并批准上述两节方案后，本次仅修改`tests/manual/r6_browser_operations.mjs`和本R6-D，UTF8无BOM；没有修改production、主harness、A文件或冻结的27项单测。当前主54988 pytest桥占执行token，D未运行任何浏览器、HTTP、算法或测试。以下为新增脚本的实际代码准备，**不是新增UI PASS**。

| 独立导出 | 主后续调用及必要输入 |
| --- | --- |
| `runDeviceTraceRestore(h)` | 主原CLI基础参数加`--group operations --entry runDeviceTraceRestore --performance-complete 1`；`R6_D_A_CHECKPOINT`指定本轮A原`data/runtime/r6/<A run UUID>/resource-writes-state.json`，或沿用`R6_RESOURCE_WRITES_RUN_ID`定位该原件。校验checkpoint schema/runtime/task/plan、A维护case PASS、原操作READBACK_CONFIRMED及anchors/明细设备一致。默认仅接受DV-0001；若A实际设备不同，必须先交主核对，再由主明确提供`R6_D_MAINTAINED_DEVICE_ID`，不自动选首个设备替换 |
| `runStatusImportPositive(h)` | 主原CLI基础参数加`--group operations --entry runStatusImportPositive --performance-complete 1`；只读固定的既有414构造模板，不提供改模板路径或随机新资源入口。当前全部device/node/model关联从真实台账分页读取，最多1000台 |

两个导出均未加入`cases`、`runOperations`默认选择或frequency入口；不会触发既有8 PASS分支。代码只有入口被明确调用后才读取本组检查点/非秘密模板及执行UI动作，模块import不读这些文件、不启动服务或浏览器。

- Trace按R03的`before_height_m`及R03/G02两个原号核对真实RESOURCE_CHANGE；两次操作before/after除挂高外全等，G02.before与R03.after完整衔接，并将实际当前完整设备字段与G02.after逐字段比较。真实历史最多读取400条；只尝试R03维护前UI中存在的条目，候选必须仅含挂高至精确原始目标。无匹配则明确失败保留边界，不填写高度框伪造恢复。先交表单再放弃、真实刷新证明零写及设备/资源版本/哈希不变，再从同一历史重建候选保存一次。保存后原设备其他所有明细字段全等，恢复历史仅挂高变更且R03/G02原历史均完整保留。
- Positive从台账真实分页下拉选50条，通过实际下一页枚举完整ID，要求页码/数量/revision/content_hash及全库设备统计一致、无重复；不把旧414总数当当前总数。同node/model才复用原构造status/alert；新增或关联改变均未知。严格构造8顶层/7record字段，所有observed_at=null，原因非空去重且不截断，保留SYNTHETIC/非实测说明及混合状态。文件经真实控件读入并比对textarea完整正文，然后只点一次导入；按回执DSS目录选择及20条明细分页逐条比较全部输入字段、冻结availability和分类计数，最后真实资源刷新核对revision/content_hash不变。
- 两入口在写入前通过`wx`独占创建`<runtime>/r6-d-trace-height-restore-<task-plan摘要>.json`或`r6-d-status-positive-<摘要>.json`，并先用harness record落盘意图。Positive保存原request_id、完整构造正文/字节哈希、模板身份及当前资源引用；Trace保存A原件身份、原历史、目标及恢复前完整设备，实际UI生成的保存request_id在request事件捕获。意图record明确`acceptanceResult=NOT_EVALUATED`，不能混入功能PASS数。
- 后续状态以串行临时文件+rename保存，不截断上一检查点；受理回执在业务断言前先落盘。任何已有检查点都会在登录/页面操作前拒绝自动重跑，错误保留原号/已知DSS；不删除检查点、不重提、不直接API代替UI。若失败或中断，交主按原号/原检查点安排只读核实，此两入口本身不把不确定提交重新执行一遍。跨CLI的新证据目录不能绕过该保护。
- 复用原文本button helper，避免PrimeIcons accessibleName假失败；新增HTTP helper仅扩充path支持两条明确资源维护端点的正则，原字符串行为保持。新入口处理相同搜索不产生GET的情况，并按真实DeviceInfoPanel的revision watcher等待保存刷新后旧追溯抽屉自动关闭；没有evaluate、page.request、隐藏store/API写入或静默补正常值。

本次仅运行`node --check tests/manual/r6_browser_operations.mjs`静态语法检查，退出0；该命令不加载模块、不调用entry或Playwright。文本差异检查无报错；两个文件当前为本轮未跟踪产物，未暂存、提交或推送。此前8项operations PASS和诊断27 PASS保持，新Trace恢复及positive导入均为**STATIC_IMPLEMENTED / NOT_RUN**，等待A资源、频率及主末尾串行执行安排。

## R03及G02双原号挂高链静态修正

主补充A默认resourceWrites还有G02保存后，D只读复核`tests/manual/r6_browser_resource_writes.mjs:405`的gisEdit：它通过`validDevice(source.resources)`选择有效设备，以当时真实`antennaHeightM + 0.2`（四位小数）执行应用草稿/撤销/重做、`G02-save`保存及原设备回读；不是直接用`anchors.maintained_device_id`选设备。因此不将“默认恰好同一设备”当作可免验证的事实，未来必须用checkpoint证明。

本次仅在已批准manual和R6-D修正`runDeviceTraceRestore`：

- 入口要求R03、G02两个case均PASS、两个operation均READBACK_CONFIRMED；两个detail.id须与maintained anchor及主预期设备一致，两个实际request_id非空且不同。读取两份原请求context/base_revision/目标设备及挂高，并禁止原请求包含其他资源对象变更。
- 目标固定为R03.before；R03.saved须对应原记录加0.1，G02.before须精确等于R03.saved，G02.saved须对应其原记录加0.2。R03的未保存草稿取消、G02撤销/重做无写记录均保留。实际未来当前挂高按G02.saved核对，不由常量、R03.after或简单减差猜测。
- 在真实UI历史中分别按两个原号读取完整详情，确认最新设备修改为G02、前一条为R03；每条base/revision对应各自原operation和case。两条历史均只改变挂高，G02.before完整等于R03.after，当前完整设备字段对应G02.after。若ID不同、额外设备修改、记录不衔接或其他字段不等，停止交主核对。
- 候选仍从R03之前实际存在的UI历史条目产生，只接受`antenna_height_m: G02.after → R03.before`的唯一patch及精确changes；不先恢复到R03.after再多写一次。取消仍零写；最终资源保存仍仅一次。无实际匹配或不可达候选即明确停止，不填height、不向隐藏store或API写入伪造追溯。
- 恢复检查点/结果同时保存R03和G02原号、两份完整历史、R03中间高度、G02最终当前高度及原始目标。保存后重新逐条选择并比较两份原历史完整内容，确认没有改写；恢复历史before必须完整等于G02.after，恢复后除挂高外其他设备明细全等。原号一次提交保护和positive入口均不变。

本轮主24例pytest在运行，D仅做源码/文档静态读写和文本检查，未重跑node语法命令、单测、浏览器、HTTP或算法；上一节node检查是修正前版本的实际证据，不能外推为本版验收。主确认尚无本轮A资源写入，因此此处不登记R03/G02真实业务ID或PASS；两入口仍为**STATIC_IMPLEMENTED / NOT_RUN**，已有8项operations及27项诊断证据不变。

## F03独立停用及历史回读静态补齐

主收到B窄审计指出F03遗漏后，内部批准仅本manual及R6-D新增`runFrequencyDisableHistory(h)`；没有修改原四项frequency case、Trace、positive、主harness、production或冻结单测。新导出未加入`cases`、默认选择或其他entry，不会自动重跑原四项或既有8 PASS。

末尾安排为：所有旧资源依赖验收结束 → A资源完成 → D既定ADD/PATCH/ENABLE/重复失败四项实际成功 → **F03停用及历史回读** → Trace恢复 → positive状态导入。新入口通过主原CLI基础参数显式指定`--group operations --entry runFrequencyDisableHistory --performance-complete 1`；当前没有D执行token，不能按此顺序提前运行。

必要输入`R6_D_FREQUENCY_RESULTS`指向原四项实际`results.json`，可为单一路径；若主分段执行，则为1至4个路径的JSON数组，也可由结构化调用提供`h.frequencyResultsFiles`。路径必须在本runtime的`browser/r6-browser-<原run>/results.json`内；只读公开结果，核对方法、group、frontend、task/plan及四个各自PASS的case和原请求记录，不读private或凭目录名推定通过。更大原group若在其他case失败，保留该组completed状态，仍只取实际PASS的目标case，不宣称原组全绿；同一case多份PASS须先核对原号，不猜选最新一份。

新路径的真实控件和HTTP断言准备：

1. 强制使用本轮task/plan生成的默认`FQ-R6-D-<摘要>`，不能通过frequencyId替换源频点。当前唯一行必须完整匹配本轮ENABLE原回执、PATCH后的channel_no=0及人工构造来源说明，仍为可用且occupied_by=null；当前版本必须等于四项重复失败后的未变版本。已停用或另有资源版本变化时停止，不重复enable/提交。
2. 在“本人频点操作历史”通过“请求号 → 查询历史”和“核实原请求 → 读取回执”分别读取ADD/PATCH/ENABLE三个原号。核对真实GET、原版本/保存版本、分区/目标ID、完整items及三步值衔接；保存完整原回执。另经实际历史分页读取本人全部历史摘要（本次上限200条），不删除、覆盖或忽略旧项。
3. 勾选唯一构造频点，点击“停用所选”，要求真实`POST /resource/frequency-resources/disable/validate`精确为当前revision及单一ID，would_disable仅该ID、unchanged为空，历史保留/需重算及link_impact=UNKNOWN声明正确。当前UI是“确认停用规划频点”，不是构造ADD/PATCH/ENABLE的确认抽屉，也不是不存在的changes kind=DISABLE。
4. 首次点击“取消”，实际刷新后完整频点页、revision/content_hash及本人全部历史摘要均与之前全等；持久化`/disable`请求计数必须为0。随后重新勾选并预检，在原确认弹窗提交一次“确认停用”。提交前用既有独占检查点/意图record保护，保留三原号/回执、原四项证据身份、完整取消证据及恢复前行值，意图记录不计验收PASS。
5. 唯一持久化请求为真实`POST /resource/frequency-resources/disable`，context=ledger、base_revision为预检当前版、ids仅本轮构造ID，实际request_id由UI生成并捕获/先落盘。要求object_id=resource-frequency-disable、updated/affected_ids仅该ID、changed=true、资源revision前进，其他频点字段完全不变，is_available=false。
6. 保存后按该原request_id真实查询历史、读取回执并比较完整receipt；再次读取ADD/PATCH/ENABLE三个原号，所有原字段/时间/回执不变。本人完整历史摘要须仅新增此次停用一条，全部原摘要仍在且全等；最后真实刷新查询当前停用版，HTTP行值与停用回执一致、可见行显示“已停用”，整个流程`/disable`计数精确为1。最后保持此频点停用，不新增或扩大可用池。

沿用`<runtime>/r6-d-frequency-disable-history-<task-plan摘要>.json`独占保护；任何已有检查点在登录/UI操作前阻止自动重跑，失败或不确定时保留原号/回执，由主安排只读核实，不点击“重试原请求”、不生成新号绕过、不删除检查点或旧结果。此entry没有任何ENABLE/changes保存白名单，也不操作其他频点、账户或参数。

当前完整manual已执行一次`node --check`静态语法检查，退出0；只解析源码，不加载模块、依赖或entry。manual及R6-D经严格UTF8解码及BOM检查，均为UTF8无BOM。

本节是**STATIC_IMPLEMENTED / NOT_RUN**：未执行新entry或任何单测、浏览器、HTTP、算法/服务操作，未产生停用requestId或资源版本。既有8项operations及27项诊断实际证据不变，F03不能提前记PASS。
