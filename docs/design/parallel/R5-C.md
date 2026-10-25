# R5-C 冻结覆盖前端适配

## 状态与内部批准

- 日期：2026-10-24。
- 主集成先批准 11 文件白名单，随后追加批准专用 `src/services/frozen-coverage-http.ts`，当前共 12 文件。
- 已完成 docs12、唯一新版冻结覆盖类型、解码、HTTP、composable、面板、带宽编辑器、地图图层及五个专项测试文件的只读分析。
- 主集成已批准下述 V01-4 契约；12 文件白名单内的实现与定向验证已完成，生产源码冻结并交回主集成。
- 已直接与 R5-B 核对 radio_parameters、rx_bandwidth、构造来源及历史缓存的精确兼容边界；最终实现按本记录所列字段逐项校验。

## 批准的精确白名单

以下前端文件均位于 `front_design/radio-planning-20261022/`：

1. `src/types/frozen-coverage.ts`
2. `src/services/frozen-coverage-decode.ts`
3. `src/components/FrozenCoveragePanel.vue`
4. `src/components/FrozenCoverageBandwidthEditor.vue`
5. `src/maps/frozen-coverage-layers.ts`
6. `tests/helpers/frozen-coverage.ts`
7. `tests/frozen-coverage-http.test.ts`
8. `tests/frozen-coverage-entry.test.ts`
9. `tests/frozen-coverage-bandwidth-editor.test.ts`
10. `tests/frozen-coverage-layers.test.ts`
11. `src/services/frozen-coverage-http.ts`

唯一组记录为 `docs/design/parallel/R5-C.md`，合计 12 个文件。扩展白名单须先交主集成内部审核。

## 目标与方案

- 按服务端明确的分类区分本次无活动链路的 208 台与实际缺带宽的 26 台；这些数量是当前冻结样本的核对口径，不能硬编码为页面规则或任意方案的预期值。
- 已批准由版本化构造补充资料产生新的资源版本，再按正常流程生成新规划；前端沿现有带宽选择请求，不增加 profile DTO，不扩展六字段 selection。
- 构造带宽及其来源仅从新方案的冻结型号资料读取，显示为“构造接收假设，非厂家实参”。不得从当前可变资源回填旧方案，不把构造值冒充原型号实参。
- 保留型号原始带宽内容与构造来源的区别；显示的来源字段、版本和摘要均以正式返回为准，不自行拼造字段或出处。
- 保持现有参数区、分页表、预览确认和来源折叠结构；摘要、设备选项和表格行显示一致的已计算、活动设备不可计算、本次无活动链路分类，不增加营销说明或改动整体布局。
- 不默认选择带宽；仍由用户显式选值、预览、确认保存，再 GET 回读选择版本，计算由独立操作触发。旧选择包含的其他设备选值应保留，具体新提交资格按最终契约校验。

## 契约与兼容约束

- 当前解码器只接受 V01-2/V01-3；选项目录为三字段、目录设备为九字段、selection 为六字段、choice 为两字段。V01-4 新增的来源、SKIPPED 和 summary 必须按最终结构逐项校验，不能只放宽版本字符串或任意接收附加字段。
- V01-2/V01-3 缓存与旧六字段 selection 按原语义读取，不给旧结果追加来源，不在客户端将旧 UNAVAILABLE 擅自转为 SKIPPED，不将旧引擎结果升级为新版结果。
- 已批准 engine_version=V01-4 与 result.schema_version=2 配对；summary 为必有的 `{total, eligible, complete, unavailable, skipped}` 非负整数，`total=eligible+skipped`、`eligible=complete+unavailable`，且逐项匹配明细。
- V4 设备状态为 COMPLETE、UNAVAILABLE、SKIPPED；必有 reason_code 为 null、NO_ASSIGNED_FREQUENCY、RX_BANDWIDTH_UNKNOWN、RX_BANDWIDTH_SELECTION_REQUIRED、FROZEN_PARAMETERS_UNKNOWN 之一。SKIPPED 仅匹配 NO_ASSIGNED_FREQUENCY、空 computations、null radio_parameters。
- 总体状态以 eligible 为分母：零 eligible 为 NOT_APPLICABLE；全部 eligible 完成为 COMPLETE；部分完成为 PARTIAL；无完成为 UNAVAILABLE。旧 schema_version=1 保持原总体状态规则。
- V4 options 与 result 的每设备必有 bandwidth_provenance：普通资料为 null。R5-B 随后同步主最新决定，构造资料改为五字段 `{origin, source_id, source_sha256, source_note, original_khz}`，取代早期提案的 source_doc；origin 固定 SYNTHETIC_COVERAGE_ASSUMPTION，source_id 为 R5-HF-RX-3KHZ-V1，摘要为 64 位小写十六进制，source_note 非空，original_khz 为原缺失值空串。原 source_doc 仍保留于 frozen_model 原对象，不移写为新 DTO 字段。
- R5-B 确认 V4 各状态均有 rx_bandwidth；COMPLETE 的 radio_parameters 保留现有八字段对象，SKIPPED/UNAVAILABLE 为 null。frozen_model、frozen_antenna、planned_parameters 原快照允许对象或 null，已有对象身份必须匹配，已有非法参数不能因 SKIPPED 被放过。
- 新版 summary 须与设备明细一致；已计算、活动设备不可计算与 SKIPPED 的计数和总体状态按最终契约复核，不将无活动设备作为缺带宽失败，也不将跳过数当成完成数或覆盖率。
- 选择 ID/hash、方案/任务/快照、资源版本、原始快照摘要、冻结表摘要、DEM 指纹与引擎版本继续核验；地图仅绘制来源绑定一致的已计算设备。
- query 可选 engineVersion 仅用于 cache 历史读取，专用 HTTP 层映射为 engine_version，并核验返回版本；其他操作不向服务端传递该参数。现有选择请求和六字段 selection 保持。
- `composables/useFrozenCoverage.ts` 及共享客户端、宿主页面不在本组修改白名单。

## 跳过规则与性能边界

- 性能方案采用活动频率优先判断：结构合法且服务端确认本次无活动频率的设备跳过覆盖求解，并明确返回 SKIPPED。
- SKIPPED 仅说明本次无适用的活动频率，不能解释为缺少全部设备资料、计算失败、已完成覆盖或实测达标。
- 活动频率优先不豁免结构校验。未知型号、身份错误、重复设备、来源错配、非法枚举、损坏字段或不一致 summary 仍须拒绝；不能将损坏包转换为 SKIPPED 后接受。
- 前端不以空 computations、空选项或自然语言原因自行推断 SKIPPED；新旧版本分别按其正式状态读取。
- 无活动链路行不得进入新的批量选值意图或生成覆盖图层；历史已冻结选值仍须可读，不能静默删除。
- 性能测试与真实耗时验证由主集成统一执行，本组不启动服务或自行开展真实 HTTP/浏览器操作。

## 测试计划

1. 保留 V01-2/V01-3 原夹具与原有来源绑定断言，增加独立 V01-4 小夹具；验证已计算、活动设备不可计算、SKIPPED、混合结果及全部跳过的状态与 summary 一致性。计数覆盖当前 226/26/208 样本，另用不同数量证明页面无硬编码。
2. 验证构造带宽来源展示与新冻结资源绑定；缺字段、摘要错配、型号错配、伪造来源类型及跨版本混包须拒绝，旧结果不得出现新来源。
3. 验证无默认选值、显式预览确认、只针对符合契约的活动设备批量操作、已有其他选择完整保留，以及 GIS 只读和权限撤销后的旧回调保护。
4. 验证 SKIPPED 不能绕过未知型号、错误身份、重复设备、结构损坏、非法频率或 summary 不一致的校验。
5. 验证地图的新版本与 selection ID/hash 匹配；SKIPPED 不绘制，错方案/快照/选择不绘制，HF 内孔及 VUHF 采样点语义不变。
6. 字段实现后执行五个冻结覆盖专项测试文件，并复用现有 workspace 测试检查原号、回读与来源切换行为，再执行全项目类型检查；不新增大型测试产物或把测试桩登记为真实联调。

## 实施与证据边界

- 手工修改使用 `apply_patch`，文件采用 UTF-8 无 BOM，复杂来源或兼容判断处只加必要中文注释。
- 不修改旧前端、domain、公共 HTTP 客户端、AppShell、算法、后端、数据库、DEM、原始资料或原 5183。
- 不删除文件，不复制依赖，不下载，不执行 Git 提交，不启动服务，不进行浏览器账号操作。
- 磁盘异常期间仅只读；主已确认 `login:false` 可恢复 exec、F 盘约 23 GiB 可用且无需清理，本组不执行任何清理。
- docs12、共享契约和真实浏览器/HTTP/性能结论由主集成统一维护。本组仅在本记录登记实际改动与实际测试证据，未执行项保持未执行。
- 用户其他并行成果正在改认证/密码及维护 `.22`，本组未修改 auth/system 文件，也未重启或写入该服务。主的真实验收使用独立 `.23:5323/8123` 及新 `r4-r5-*` 库，本组不操作这些入口或运行库。

## 实际改动

- V4 按 engine/schema 配对解码，严格核验五字段构造来源及与 frozen_model 原字段的一致性；拒绝 source_doc 混入 provenance，也拒绝旧 schema 夹带未校验的 V4 summary、reason_code 或来源。
- V4 summary 与设备明细逐项一致，并按 eligible 判定总体状态；SKIPPED 仍核对已给冻结身份、参数、原因码、接收带宽及 null radio_parameters，不能绕过结构损坏。
- R5-B 只读复核指出两项 P2 解码缺口，已在本组白名单内修复：普通型号原始带宽标量/分号集与 rx_bandwidth 的来源、值及显式选值必须一致，SKIPPED 同样拒绝坏列表；已给射频参数拒绝 JS Number 特有的 0x/0b/0o 字符串，保留后端原十进制、指数及前后空白语义。未通过扩大后端接受范围解决。
- 页面显示活动设备已计算数、实际缺带宽数、已有选项但待选带宽数、无活动链路数；26 台实际缺带宽与 208 台跳过按结构化码分别统计，不把尚未人工选值也称为缺资料，不硬编码样本数量。
- 构造型号的来源、补充版本、摘要及原 source_doc 可读；冻结型号单值只是展示已冻结的值，不从多项集合取首值，不自动勾选、POST 选择或计算。
- 无活动链路行保留旧冻结值和来源，但不能新选或批量改写；保存其他设备时完整保留当前版本的其他选择。GIS 写边界、预览确认、独立回读和显式计算流程不变。
- 新版地图核对 engine/schema、方案、快照与 selection ID/hash，仅绘制 COMPLETE；SKIPPED 或 UNAVAILABLE 即使带错误几何也不绘制。原 HF 内孔和 VUHF 采样点语义保持。
- 专用 HTTP 的 query.engineVersion 仅映射到 cache GET 的 engine_version，并验证返回版本；计算、选项目录、选择保存及其他操作不向服务端发送该参数。前端继续保留原 V01-1 拒绝规则，历史 V01-2/V01-3 可读，不补新版字段。

## 实际验证与证据

- 最终定向命令：`node node_modules/vitest/vitest.mjs run tests/frozen-coverage-http.test.ts tests/frozen-coverage-entry.test.ts tests/frozen-coverage-bandwidth-editor.test.ts tests/frozen-coverage-layers.test.ts tests/frozen-coverage-workspace.test.ts --maxWorkers=1 --no-file-parallelism`。
- 最终同轮五文件 **208 passed / 0 failed / 0 skipped**，用时 **28.71 秒**。entry 14、bandwidth-editor 32、http 122、workspace 22、layers 18；workspace 仅回归未修改。新增测试覆盖 B 只读复核的普通型号带宽和 JS 扩展数值两个拒绝分支，并保留合法缺失资料、分号去重、显式选值与十进制正例。
- 最终全项目 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` 退出 **0**。首轮新增测试桩泛型标注造成七处类型错误，沿既有 AuthenticatedRequest 断言方式修正；生产类型未放宽。此前 178、191、192、201 项阶段回归均实际通过，不与最终 208 项累加。
- 11 个前端变更文件的 `git diff --check` 退出 **0**；12 个白名单文件通过严格 UTF-8 解码且无 BOM。没有生成大型报告、生产包或复制依赖，测试证据为本会话实际命令输出与本记录。
- 上述为构造夹具、内存组件宿主及 HTTP 请求桩的定向回归，不是实际服务 HTTP、真实浏览器、完整 DEM 计算或性能验收。后者均由主集成统一执行，本组未登记通过。
- B 已按最终 decoder 摘要独立内存复核：原单值错配、坏分号列表、JS 扩展数值及目录对应负例均正确拒绝，V4/V3 控制样本可读；原两项 P2 缺口已关闭。B 曾提出目录分支待补，随后实际探针确认该分支已拒绝并撤回该项，不作为未解决缺陷。
- 主开始真实页面验收后要求六个生产文件冻结；本记录的最终 decoder 摘要在该指令到达前已形成，已向主说明版本时点并同步 B。此后仅更新本记录、读取源码摘要和收尾既有类型检查，未再修改生产文件，也未扩展历史页面入口等需求。

## 冻结生产源码 SHA256

以下路径前缀为 `front_design/radio-planning-20261022/`：

| 文件 | SHA256 |
|---|---|
| `src/types/frozen-coverage.ts` | `e73e8253f04474cfdcf39e7a11ab9584adc7df71f88439b0d0d420b34c912e51` |
| `src/services/frozen-coverage-decode.ts` | `f08d9695c1bee0243b32669b245488c34c9bc39d40e362c02a588a4ca13078a1` |
| `src/services/frozen-coverage-http.ts` | `8f571e2ab44a1542325765f3f319dce6e551717def63512e379c338d3f8b68d8` |
| `src/components/FrozenCoveragePanel.vue` | `c0bed543d53bf6720d7b312a80d156467fde555dc526fb6057cdc88b010e4403` |
| `src/components/FrozenCoverageBandwidthEditor.vue` | `f05cf6ca1ac48bef05124e7016368df79144903ecdeeef0937ec3cdfae00d7e8` |
| `src/maps/frozen-coverage-layers.ts` | `c12bcecb00d5f31eccec89c2b02e9d3fbd35c111805e777b3e2cf85c0ebaee7e` |
