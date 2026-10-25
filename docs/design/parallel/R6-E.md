# R6-E 规划与干扰浏览器专项

更新：2026-10-25。E拥有 `tests/manual/r6_browser_planning.mjs`、本文件，以及获批的新采纳详情组件和定向测试。主拥有 `tests/manual/r6_browser_acceptance.mjs`，A拥有 `GisPlanOperations.vue`，本组未修改这两个共享文件。已按主各自独立token完成取消复验、任务Import和正常compute/save/confirm；采纳原号恢复只读4 PASS、合法人工调整4 PASS、比较与JSON/XLSX导出1 PASS、独立REFERENCE禁转正1 PASS，旧失败及全部原号保留，详见文末。本组所有CLI/context均已结束、无在途计算或写入，令牌已交回且当前由C持有。FinalRefresh仅静态ready，等待A资源、D频点/追溯/状态全部结束及主明确最终令牌后执行。

本轮task=`r4-network-89db2499fcf6`、资源=`resource-7c8bd11ec30d0ed4`。准备来源为原V1方案`PLAN-5273d94aa08345e4b047d62b915e2928`/快照`SNP-PL-0F4B502A`。本次正常compute已产生并确认V2方案`PLAN-4d974f02b63b465ca03e030dcda8eff9`，新快照`SNP-PL-E4AFB9A0`，已真实GET回读CONFIRMED/current=true/source_changed=false；后续I/A须主显式传入该新planId，不再假设原V1仍current。入口严格限定`http://127.0.0.24:5324`，仅接受此同源与`.24:8124`的真实HTTP；原5183、`.22`、`.23`保持。

## 宿主合同

所有导出函数都接受 `async fn({page,runtime,taskId,planId,login,record,download,shot})`，不创建或替换Page/context。`runtime`仅检查存在，不打开配置/数据库；身份交给`login('editor')`的真实UI表单。顶层只导入Node内建模块；导入/导出文件核验按当前前端package.json解析已有exceljs/papaparse，不安装或复制依赖。

`record(id,fn)`由主宿主保存JSON、截图，失败抛出终止本次group。脚本在业务请求发出时记录原request_id/请求体，取得回执后立即记录原job/plan/run/adoption号，再做界面和回读断言；响应解码失败时仍保留已发出的原请求身份。失败文本附业务anchors及实际HTTP，不能以刷新失败为由重提。宿主自身用于失败DOM取证的只读evaluate由主维护，本模块不调用evaluate/store/APIRequestContext/fetch，不拦截或伪造响应，不记录口令、Cookie或请求头。

`download(action,label)`的宿主实现先挂下载等待再点击，返回 `file/suggested_name/bytes/sha256`；本模块继续读取实际下载文件，验证 JSON 身份及 XLSX“完整快照”拼接内容。`shot`由宿主 `record`统一调用。所有截图/下载标签为 ASCII。

PrimeIcons伪元素会影响文本按钮的accessibleName。本模块文本按钮使用 `getByRole('button').filter({hasText: /^\s*实际文本\s*$/})`；纯图标按钮按源码aria-label精确定位。保留已登录文档，仅更换hash；同一方案再次打开、原job回读均通过真实规划历史搜索/打开，不添加查询串重复冷起。历史作业编号位于行详情，先断言HTTP搜索仅返回一个目标且task一致，再点击唯一打开按钮，不把不可见编号当作摘要行文本。采纳详情按`.p-drawer-title`限定可见抽屉，避免底层措施抽屉同名按钮干扰。

## 分段入口

遵照主“优先最小可运行 cases、长链分拆”的最新指令，默认 `runPlanning`只执行 P01–P03，单次新提交后取消。其余入口独立导出，不在默认入口暗中追加长计算或重算。主可在原宿主的模块调度处选择对应导出；本组没有修改主文件。

| 导出函数 | cases | 前置与结果 |
|---|---|---|
| `runPlanning` / default | E-P01 已保存任务无匹配/查询/打开反馈；E-P02 名称非法反馈/禁止PUT/修改保存/库重开；E-P03 进度/取消/原job终态/历史原号再打开 | 传主提供的有效确认方案。只改任务名称，不改数值条件/资源。若作业先结束，明确未覆盖取消，不重提交碰运气 |
| `runPlanningCheckpoint` | E-P00 原任务/原方案/原MemoryError作业的UI只读回读 | 固定核对本轮原任务及版本、原FAILED号；不提交、不取消、不保存。原方案current只记录实际观察，不预设恢复后仍current |
| `runPlanningCancel` | E-P03R-load-saved-task、E-P03R-submit-once、E-P03R-cancel-readback | 从库载入真实已保存任务，不重复P02。提交回执单独record落盘后，仅对该新job请求取消一次，再经规划历史GET原号。完成竞争/FAILED均停止，禁止循环或自动换号 |
| `runPlanningImport` | E-P06 三模板下载；E-P07 非法CSV拒绝/合法CSV预检取消；E-P08 合法XLSX应用草稿/继续编辑/放弃/原任务回读 | 真实POST模板与预检，验证HTTP/文件摘要/实际问题行。模板副本仅在内存改原taskId和测试名称；不改数值，不PUT、不compute，清理仅放弃未保存草稿 |
| `runPlanningCompute` | E-P04-submit-checkpoint单次提交落盘；E-P04-compute-result-save实际终态/保存/回读；E-P05取消转正确认框一次、再明确转正及同快照回读 | 必须等主通知C场景已冻结、内存满足且取得重计算独占token；载入已保存任务并核对固定版本。正常新请求不是取消重试。真实FAILED保留并抛出；REFERENCE保存后核对禁转正，返回confirmed:false，不算达标 |
| `runPlanningFinalRefresh` | E-F01真实任务基线；E-F02显式UI刷新资源引用/单次保存回读；E-F03单次提交checkpoint；E-F04终态/保存/完整验证；E-F05确认current及原号回读 | 仅A/D全部资源与频点写测试结束、主明确final token且资源冻结后执行。动态采用实际任务版本，不调用recoveryTask；不改名/数值。主已授权对真实SAVED、服务端允许且校验通过者正常确认。FAILED/REFERENCE或版本变化停止，不换号重算 |
| `runPlanningAdjustment` | E-A01 非法原文/校验/继续编辑/放弃；E-A02-submit-checkpoint人工路由+单设备功率一次自动预览回执落盘；E-A02终态/保存新版本/配置回读 | 传本任务与当前条件一致的已保存父方案。返回真实子 `planId/parentPlanId/state`；未自动转正。失败/REFERENCE保留，不另选参数重算 |
| `runPlanningAdjustmentLegal` | E-AL01原FAILED job/父V2/冻结能力；E-AL02一次合法调整意图；E-AL03新受理回执checkpoint；E-AL04同job终态/保存/父回读 | 从ff5d96真实UI冻结raw.params取合法功率档位或明确连续高度后备，核对配置原值；不读全局CSV。不重跑旧A01/A02、不重提旧FAILED号，仅一次新job和一次保存，REFERENCE如实保留不确认。当前仅静态ready，无执行token |
| `runPlanningComparison` | E-V01 父子两版本对比/JSON/XLSX真实下载及内容核验 | `planId`传A02的子方案；两个版本必须在真实当前页，超过当前10项范围明确停止，不无限翻页搜索 |
| `runPlanningReference` | E-V02 真实同任务REFERENCE历史打开/禁转正 | 当前页须已有同任务实际REFERENCE，按原ID二次精确查询并等DOM完成。无记录报前置阻断；不调低门槛、不生成假失败。仅验证UI禁止，不冒称服务端409已执行 |
| `runInterference` | E-I01冻结确认方案选源/场景保存/回读；E-I02-submit-checkpoint单次分析原号落盘，再等终态/预览；E-I03-adopt-checkpoint单次采纳原号落盘，再等真实子规划/详情；E-I04子方案/父方案/原分析和采纳详情重开回读 | 传仍有效且current=true的确认方案；至少1个生效源、至少1条实际可采纳措施。按真实data-measure-id限定措施。无措施或真实失败保留并终止，不换源或提高强度凑通过；采纳可能触发重计算，须独占token |
| `runInterferenceFreshAfterBridgeFix` | 复用原场景；新增E-I02-new-analysis-intent与E-I03-new-adoption-intent两段写前落盘，再按既有分析/采纳回执checkpoint、真实子job/plan及详情回读，共8 cases | 仅主完成受影响24例pytest和仅.24装载后，另授一次独占新案token才执行。固定父V2/source7c，排除旧run/IAD/job，不恢复旧FAILED采纳；0场景PUT、1新分析POST、1新采纳POST、0确认。REFERENCE正常保留并展示完整gap，不冒称SAVED |
| `runInterferenceAcceptedReadback` | 原场景GET、原分析历史GET、原measure预览、E-I03-saved-original-adoption-readback，共4个只读cases | 严格读取ef5f14的6 PASS checkpoint及原FAIL/failed-http；仅接受原新IAD修后SUCCESS、原child SUCCESS和真实持久REFERENCE，详情GET/关闭、完整gap显示/截图、禁转正、父V2/result与原证据不变；0业务POST。不能重跑Fresh入口 |

不能直接执行本模块：它没有创建浏览器的CLI。默认P01/P02已通过，不应重新跑default来续跑，否则会再次修改名称。主串行安排：只读checkpoint/任务导入可独立给token；C场景已冻结后再单独批准正常compute/confirm；取消复验另给一次合理新作业token，不自动接在计算后。后续干扰和调整分别取得独占token，比较用A02返回的子planId。P04得到REFERENCE时保留，不向后传假确认状态；干扰使用主明确指定的真实current确认方案。

在仓库根目录使用既有命令，仅更换最后的导出名；下列取消入口已在本次token执行一次，不可据此自动再跑：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'tests/manual/r6_browser_acceptance.mjs' --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' --group planning --playwright-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json' --task-id r4-network-89db2499fcf6 --plan-id PLAN-5273d94aa08345e4b047d62b915e2928 --entry runPlanningCancel
```

只读恢复用`--entry runPlanningCheckpoint`；导入用`runPlanningImport`；正常规划/确认用`runPlanningCompute`。调整/干扰/对比入口与planId按主指定的实际结果选择，不并行、不复制profile、不安装依赖、不重启服务。若任何写后失败，先交主核实results.json中的原request/job/plan/adoption号；重跑含提交的入口不是恢复手段。

## 正常计算排队与复跑边界

主已确认C完成原方案正向coverage UI并关闭context，E随后按正常compute/confirm独占token执行下列命令一次且已完成。该命令不是恢复手段，不可再执行凑结果；不是FinalRefresh，也未重复default/P02/cancel：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'tests/manual/r6_browser_acceptance.mjs' --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' --group planning --playwright-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json' --task-id r4-network-89db2499fcf6 --plan-id PLAN-5273d94aa08345e4b047d62b915e2928 --entry runPlanningCompute
```

| 入口 | 来源/写入边界 | 失败后的处理 |
|---|---|---|
| Compute | 原task的TREV-b5de4a8273904944acdf57ca578adeb2/TCOND-23bae78ad99f4d3f824adc224fa011c7/resource-7c8bd11ec30d0ed4；无任务PUT。1提交checkpoint，最多1保存和1确认 | 已提交后不得重跑整入口。按checkpoint原job只读核实；已保存后仅针对原plan后续核实/确认。源码入口不支持靠--cases跳过前置，须交主明确安排原号恢复，不伪装成新计算 |
| I | 使用P05实际返回的新confirmed/current planId；单次场景保存、分析提交、措施采纳。分析/采纳各有独立record checkpoint | scene/run/adoption/子job/子plan逐级保留。失败后不整段重跑，不另选措施或源；只核实已受理原号，后续动作另由主明确授权 |
| A | 使用主指定的已保存父planId，通常为P05新current；非法编辑阶段不写。合法组合仅一次自动预览，有独立提交checkpoint；最多保存1子版本，不确认 | 终态失败/REFERENCE均保留；不能换设备、功率、路径再试。原备份路径作为人工主路径可能触发真实硬约束未达标，这不是允许放宽条件的理由 |
| V | planId传A02真实返回的子版本，父ID只取该版本parent_plan_id；同task/condition/resource、两个版本同页。比较POST为只读比较，导出GET冻结JSON，XLSX由页面编码 | 核实两个原planId后可另给只读token重开/导出；不得为凑同页或达标生成新版本 |
| Import | 当前原任务/版本仍满足recovery门禁；实际下载3模板、预检及本地草稿，0任务PUT/规划提交 | 失败先确认没有意外写入，再通过UI取消/放弃本地草稿；不得以“清理”为由保存或取消后台作业 |
| Reference | 同任务真实REFERENCE原号，GET搜索/打开及disabled按钮核对，0业务写 | 无同任务记录明确阻断，交主提供原号；不制造失败数据。重新查询仍是只读token，不等于服务器409测试 |

I/A的source planId不自动取最新历史行，也不隐式沿用子参考方案为current。P04若生成REFERENCE，不自动转正、不直接进入I；由主指定仍有效的current来源。所有分段CLI/context严格串行，互斥/RAM门禁拒绝即停止，不绕过。FinalRefresh继续等A/D资源与频点写完且资源冻结后的专用final token，不混入本轮正常compute。

本次静态核对仅修manual中的真实data-measure-id定位、历史/列表DOM等待、比较前清空本地选择和I/A原号checkpoint分段；未改生产、门槛、默认数据或恢复/cancel硬版本门禁，未启动Browser/HTTP/测试/重计算。

## 最终刷新入口

主已批准本入口中的正常确认，但尚未给执行final token。此入口不自动追加到default、P/A/V/I或cancel；内部批准实现不等于允许现在计算。现有RECOVERY常量、recoveryTask和恢复/取消入口的硬版本门禁保持原样，不能用最终刷新绕过旧用例的来源要求。

最终使用同一宿主命令，仅将导出名改为`--entry runPlanningFinalRefresh`，taskId/planId由主明确指定。入口从真实规划路由和任务库打开任务，不依赖旧plan仍可current或旧资源引用有效；不使用预设替换输入。

1. **E-F01**：先经正常UI只读打开固定原父V2 `PLAN-4d974f02b63b465ca03e030dcda8eff9`，GET核对同任务、原CONFIRMED状态、快照`SNP-PL-E4AFB9A0`及真实全网连通率98.29，保留完整metrics和source_changed/current原值。资源变更导致旧父source_changed=true时如实保留，不能因此换新baseline。从真实GET冻结原task的完整input、revision/inputVersion、conditionVersion及resourceRevision；核对原必要通联约束100、抗毁约束不低于90。原输入低于门槛或缺失时交主，不自动改值。
2. **E-F02**：展开“任务详情与版本”，仅点击一次“刷新已保存资源引用”。该现有控件内部先刷新resource/context与地图，再读取当前版本节点/设备引用；等待UI资源版本显示更新，随后仅一次PUT保存原任务，记录request_id。回读必须完整input深等、conditionVersion不变、resourceRevision等于本次真实上下文；资源确实变化才要求新inputVersion，未变化不伪造新版本。
3. **E-F03**：库重开核实保存版本及原active job未被其他作业替换；单次正常提交，不带调整/采纳来源，原request/job/版本先通过record落盘。不得在不确定回执后重提。
4. **E-F04**：观察同一job真实终态。FAILED停止；SUCCESS保存同一结果，方案名使用原任务名，不修改任务输入。REFERENCE保留并停止，不确认、不换号重算。SAVED须四项真实checks均passed=true、outcome.code=0且无gap，并核对冻结配置/必要主路由/链路关联及不可达列表。抗毁真实指标须达到原约束且至少90；全网连通率须满足新值减原父V2真实值不小于-1e-8，容差单位为百分点，不能以必要通联passed替代该不下降门禁。比较前即把父/子plan与snapshot、父source_changed、双方完整metrics、差值、容差和passed落入anchors；回归失败保留已保存原号并停止，禁止确认或换号。保存前再次GET原任务，若input/版本或active job变化立即停止。
5. **E-F05**：重新打开原任务及刚保存的planId，核对同一input/condition/resource/job/快照、SAVED且source_changed=false，再执行全部验证及同一父V2连通率比较，确认控件真实可用后正常确认一次。POST回执及后续同planId GET必须CONFIRMED/current=true、快照与配置未变；最终validation保存确认前的真实比较证据。服务提供confirmed_configuration时逐项核对其来源与完整配置；缺省时如实记录未提供，不用result冒充正式配置。

**必要通联与全网指标不混用**：已有真实快照metrics.connectivityPercent=98.29，但connectivity检查为必要需求1/1主路由、算法值1.0且passed=true。最终入口依据该结构化硬约束检查、每项mandatory需求的原主路由及unreachableDemandIds核实必要通联，不把全网98.29误判为必要通联未达100，也不把它改写成100。另以原父V2真实GET的98.29为全网不下降基线，仅容许1e-8百分点浮点误差。routeQuality.isFeasible允许原样null，不补true；真实抗毁指标另核对至少90。

最终业务写白名单只有一次任务PUT、一次规划POST、一次方案保存POST、一次确认POST。不写资源/频率，不改名称/输入数值，不调用recoveryTask，不自动重试。资源来源通过任务保存/作业终态/方案GET/确认原子校验及source_changed门禁核对；任一版本竞争或HTTP拒绝直接保留原号停止。输出真实新inputVersion/conditionVersion/resourceRevision/jobId/planId和验证摘要，供主后续测试使用；当前实现仅静态完成，未执行或做语法/单测验证。

## 实际控件与契约依据

- `TaskApiPanel.vue` / `TaskApiLibraryDrawer.vue` / `TaskApiForm.vue`：`打开任务`、`任务编号或名称`、`查询`、`打开`、`保存任务`、`data-validation-field="name"`；断言真实 `GET /task-inputs`、`GET/PUT /task-inputs/{taskId}`及明确打开/保存反馈。只改名称，后端 `task_input_service.py::_condition_signature`排除名称，保存前后仍需主核对实际版本。
- `PlanningApiProgressPanel.vue` / `planning-http.ts`：`提交规划`、`规划任务进度`、`取消规划`、确认框`请求取消`；`POST /plan/sr4-flow`、`DELETE /tasks/{jobId}`与原 `GET /plan/tasks/{jobId}`，真实历史查询 `GET /plan/jobs`后重开原号。
- `PlanningApiVersionsPanel.vue`：`保存为方案`、`保存调整为新版本`、`转正并设为当前方案`、确认框`确认转正`、`历史版本与对比`、`对比所选 2 个版本`、`导出与复制任务条件`；断言 `POST /plans`、`POST /plans/{id}/confirm`、`POST /plans/compare`和冻结版本回读。
- `PlanningAdjustmentDrawer.vue` / `stores/planning-api.ts`：真实入口是内联`.inline-editor`，设备`选择调整设备`及`<ID> 发射功率`，`主路由`页签/`选择调整需求`及中间节点控件。合法输入稳定700ms自动预览。先保留非法功率阻止半成品提交，完整录入人工路径后一次填合法功率触发真实异步规划。不点击`重试预览`盲重发。使用实际备份路径；没有备份时明确人工固定原主路径，记录该事实，不声称发现新路径。功率减0.1dBm为单次显式测试输入，失败/参考结果保留。
- `PlanExportDrawer.vue` / `planning-http.ts` / `plan-export.ts`：`格式`、`下载方案`。当前JSON与XLSX均真实GET冻结JSON，XLSX由当前前端ExcelJS编码；不能因为下载XLSX就声称服务端XLSX端点已被页面调用。实际文件快照包含同任务/方案/状态/来源/快照身份。
- `PlanningApiView.vue` → `GisPlanOperations.vue` → `InterferenceAnalysisPanel.vue`：`进入干扰分析`进入冻结方案业务操作；`刷新干扰上下文`、`场景与版本`、`场景名称`、`备注`、选源复选框、`保存版本`、`提交干扰分析`；措施通过真实标题定位，`措施前`/`措施后预测`、`采纳措施并提交规划重算`及`查看规划作业`。不覆盖A的地图/态势刷新或C/D的业务专项。

## 干扰源编辑边界与生产阻断

冻结工作区 `GisPlanOperations.vue`显式传 `source-editable=false`。`InterferenceSceneDrawer.vue`只允许修改场景名称、备注和干扰源选择，保存时冻结选中源的参数快照；本模块I01覆盖这条实际可用的编辑/保存链。**不把该链冒充“冻结方案内逐干扰源功率/频率/位置参数编辑”通过。**

逐源参数的实际入口是普通GIS资源模式 `InterferenceSourceDrawer.vue` → `编辑参数` → `保存全部草稿`，会改变全局资源版本。主已明确冻结场景只读是合理边界，普通GIS资源编辑由主实测并保留来源失效语义；E不扩张冻结场景功能、不改变资源版本，也不把选源冒称逐源参数编辑。

当前生产白名单仅为`front_design/radio-planning-20261022/src/components/InterferenceAdoptionDetailDrawer.vue`和`front_design/radio-planning-20261022/tests/interference-adoption-detail.test.ts`，已经交权冻结。未修改InterferenceMeasureDrawer.vue；A已完成父组件接线，E未抢写。生产范围外缺陷先给主精确scope，不自行修。

采纳详情合同：props为visible/taskId/adoptionId/services，services复用getAdoption和getRun，emit仅update:visible。先读持久化adoption，再读其原分析，展示原请求/分析/措施/父方案/子job/子方案和结论；缺失值显示未提供，不推断补造。I03/I04真实点采纳详情，断言原adoption GET和原run GET、界面dt/dd及关闭；底层措施抽屉仍在，重开不额外POST采纳。组件17/17定向测试在先前获批阶段真实通过，详情浏览器case尚未执行。

## 判定和执行状态

真实默认组证据：`data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/r6-browser-1792855106179-c45a60/results.json`。

| case | 实际结果 | 原始证据 |
|---|---|---|
| E-P01-saved-task-open | PASS，107028ms | 原confirmed方案V1/current=true及任务库查询/无匹配/打开真实HTTP |
| E-P02-invalid-edit-save | PASS，5353ms | 名称清空未PUT；仅名称追加` R6-E`保存并库回读；数值、condition/resource不变 |
| E-P03-cancel-original-job | FAIL，15131ms | 单次POST返回job `tsk-c122e2c8cc06`；DELETE回执及随后原号GET均FAILED/MemoryError，result=null，不能登记取消通过 |

保存后原task的inputVersion/revision为`TREV-b5de4a8273904944acdf57ca578adeb2`，conditionVersion为`TCOND-23bae78ad99f4d3f824adc224fa011c7`，resourceRevision为`resource-7c8bd11ec30d0ed4`。保存request_id=`ecd5664d-2259-4ea8-b04c-c6f8c9ad14f5`；提交request_id=`15100b4b-b5ea-4e15-bee8-7ce5acf69f4d`；取消request_id=`accb5841-efef-473b-99ec-95e8544e153b`。本地`tasks/tsk-c122e2c8cc06.json`只读核对也为FAILED/MemoryError。无不确定写入，未保存/确认新方案；原FAILED保留，不改终态、不冒称取消逻辑缺陷。

旧cold bootstrap失败证据`r6-browser-1792844406172-180f3d`及恢复后`r6-browser-1792854778033-b16d95`中，目标plan GET在60s窗口内尚未发出，DOM为正在读取任务输入，没有业务写；后一次存在整页重新冷加载、资源约50s/地图约54s才返回。结合当时并发负载，证据不足以判定功能bootstrap缺陷。自有openPlan改为同文档hash后P01真实通过，但不能由此外推所有冷启动均通过。F盘ENOSPC旧失败证据也保留，不覆盖为通过。

恢复后只读checkpoint证据：`browser/r6-browser-1792863920034-aaebcf/results.json`。该case保留FAIL：历史搜索HTTP已返回仅1项，但断言发生时DOM仍是loading中的旧2行，打开按钮计数2!=1。此前原plan GET、task GET和原FAILED job GET均200且版本/身份正确，无业务写。只修自有openJob/openPlan，在真实查询响应后等待查询按钮恢复可用再计数/点击，未改生产，未重跑checkpoint凑PASS。

单次获批取消复验证据：`browser/r6-browser-1792864000387-81d25e/results.json`，CLI exit=0、completed=true、page_errors=0。

| case | 实际结果 | 证据 |
|---|---|---|
| E-P03R-load-saved-task | PASS，28007ms | 从库载入原task，input/condition/resource完全一致，原plan仍CONFIRMED/current=true；原MemoryError job GET仍FAILED |
| E-P03R-submit-once | PASS，1304ms | 仅一次POST，HTTP202，回执PENDING，新job=`tsk-ed6bfd550acd`；原号独立record落盘 |
| E-P03R-cancel-readback | PASS，6957ms | 仅一次DELETE，HTTP200回执RUNNING；产品轮询终态及规划历史再打开同一job的GET均CANCELLED |

本次新提交request_id=`8c29be79-8275-475d-bcb7-839920e74fdb`，取消request_id=`4714f573-7e87-4e96-9597-a4ac517d5906`。业务写总计1 POST `/plan/sr4-flow`和1 DELETE `/tasks/tsk-ed6bfd550acd`，没有task PUT、方案保存或确认；未循环新job。原`tsk-c122e2c8cc06`及其失败证据保持，不改判为通过。此后任务active_job_id可以指向新CANCELLED job，这是本次明确新提交的实际变化，不是原失败号被覆盖。

单次获批Import证据：`browser/r6-browser-1792867908187-d9a054/results.json`，entry=`runPlanningImport`，CLI session 27720已退出0并关闭context，completed=true、3/3 PASS、page_errors=0。没有重跑，没有进入default或后续compute。

| case | 实际结果 | 三步分离证据 |
|---|---|---|
| E-P06-task-import-templates | PASS，36958ms | 实际点击XLSX/任务CSV/需求CSV模板，三个POST /task-files/template均200，真实下载文件并核验工作表/列及摘要 |
| E-P07-task-import-invalid-valid-cancel | PASS，4353ms | 非法CSV任务名清空，预检返回task_scenarios第2行task_name问题，input=null且无应用按钮；合法CSV预检通过但尚未替换草稿，关闭并明确放弃导入，原名保持 |
| E-P08-task-import-apply-draft-discard | PASS，8568ms | 合法XLSX预检后明确应用为同任务本地草稿，提示尚未保存且提交规划disabled；取消离开保留草稿，再明确放弃本次输入，任务库原号GET核实未覆盖保存版本 |

实际模板下载摘要（完整文件路径及SHA也在results.json）：

| 文件 | 字节 | SHA256 |
|---|---|---|
| task-template.xlsx | 7149 | f411e10c9061067b20a56737928db6c7f42dd04f5710c3737f6a1b0d8e0bf49a |
| task_scenarios.csv | 630 | 3591009cec8d109991450e59d7ed16b58f9482097a03ccd7d0bf9e2099977635 |
| task_links.csv | 299 | c102169719bde672d7d9345f45570a3b7ba07cc591969c5e73fddf59479cb4b9 |

非法CSV预检signature=`04c6a31a31dce009e409ffa7513aa2056229c4dd2056d0e0f7dad34c3863a81e`；合法CSV=`dbb8d46e972e286a8cf4f2e5cdf01ad5542e432d19215f46fa9d627aa4520487`；合法XLSX=`9b000707201dcac713f905aeb8c16ce7b43bd378d26b143983540ef4270736d8`。这些是只读预检指纹，不冒充任务保存request_id。

Import期间除UI登录外仅3个模板POST、3个预检POST及正常GET，没有任务PUT、规划POST或其他业务写，无新增task/job/plan或不确定写入。原task最终仍为`R4全网实际频点页面联调 R6-E`，inputVersion=`TREV-b5de4a8273904944acdf57ca578adeb2`、conditionVersion=`TCOND-23bae78ad99f4d3f824adc224fa011c7`、resourceRevision=`resource-7c8bd11ec30d0ed4`，active_job_id前后均`tsk-ed6bfd550acd`；原FAILED job不变。

正常compute/save/confirm实跑证据：`browser/r6-browser-1792868756979-73261f/results.json`，entry=`runPlanningCompute`，session 86795已退出0且context关闭，completed=true、3/3 PASS、page_errors=0。没有自动进入I/A/V。

| case | 实际结果 | 原号与断言 |
|---|---|---|
| E-P04-submit-checkpoint | PASS，42634ms | 原任务版本核对后单次POST /plan/sr4-flow，新job=`tsk-9e0489e8ecf2`，PENDING受理回执独立落盘 |
| E-P04-compute-result-save | PASS，154754ms | 同一job真实SUCCESS，正常保存并GET冻结结果；新plan=`PLAN-4d974f02b63b465ca03e030dcda8eff9`，V2，SAVED |
| E-P05-confirm-readback | PASS，2939ms | 转正前显式断言真实SAVED、source_changed=false、完整四checks全通过、outcome.code=0/gap为空、完整配置、实际抗毁达原约束且至少90；取消确认框一次后正常确认一次，原planId GET为CONFIRMED/current=true |

提交request_id=`f09612f2-1fdb-4ef2-a6f7-393734ec0b84`；保存request_id=`14aa4ccd-b202-48a8-9eff-15ad984cce64`；确认request_id=`51e6e028-14cb-4539-afe7-4638cf0f3b24`。本次总计1规划POST、1方案保存POST、1确认POST，0任务PUT，无重提、无取消、无资源/频点修改。

新job/plan的inputVersion=`TREV-b5de4a8273904944acdf57ca578adeb2`、conditionVersion=`TCOND-23bae78ad99f4d3f824adc224fa011c7`、resourceRevision=`resource-7c8bd11ec30d0ed4`均未变化。确认快照=`SNP-PL-E4AFB9A0`；配置完整保存在`cases[2].detail.confirmed_plan.result.configuration`，实际行数为deployment 142、devices 460、routes 2、frequencies 1；这些是配置条目数，不冒称新增部署数量。服务未提供confirmed_configuration，本组如实保留缺省，不把result.configuration补成独立正式配置字段。

真实metrics：全网connectivityPercent=98.29，survivabilityPercent=91.01，totalRadiatedPowerW=16301.6，delayMs=25.01，coveragePercent=null。必要通联checks为主路由1/1、算法值1.0且passed=true；抗毁检查算法值0.9101/要求0.9、中继检查0.0/上限2.0、频率冲突0处，四项均passed=true。未降低门槛，未用全网连通率冒充必要通联。

当前主排队交接：E的I执行token已由主收回；session 71923已退出1、context关闭，此后没有启动新CLI/browser/计算或发业务写。主先串行安排D27与A entry复验；E仅静态准备，不操作服务，也不重复提交/保存/确认。上述V2配置/metrics来自已落盘的实际确认回读；I尝试又GET核实V2，但未进入场景保存。

待主单独授予`runInterference` token时，必须显式传`--plan-id PLAN-4d974f02b63b465ca03e030dcda8eff9`，task仍为`r4-network-89db2499fcf6`。入口先正常UI GET核对V2/current/source_changed及实际workbench来源，再只分析一次、采纳一次；如新服务回读有来源/版本变化即停止，不重复确认V2或改用旧V1。原提交、保存、确认request_id和jobId沿用上方证据，不能为了补正式配置字段重写方案。后续服务若提供新的独立confirmed_configuration，应作为新的只读证据逐项核验，不能覆盖本次“未提供”的历史观察。

I首次实跑证据：`browser/r6-browser-1792869821711-97fcfd/results.json`，entry=`runInterference`，仅E-I01一个case FAIL，89653ms，page_errors=0。失败位置是等待“干扰分析”region可见超时，但真实前置不是单纯aria selector问题：

- `GET /plans/PLAN-4d974f02b63b465ca03e030dcda8eff9?context=planning&task_id=r4-network-89db2499fcf6`为200；workbench同task GET为200。
- 导航到真实`#/situation?analysisTaskId=...&analysisPlanId=...`后，GIS冻结深链的`GET /plans/{同V2}?context=gis&task_id={同task}`返回422；DOM明确显示“context 只能是 planning”，未出现冻结网络业务操作/干扰面板。
- 失败证据`writes=[]`，仅登录POST；没有场景保存、分析或采纳请求，不存在新scene/run/adoption/child job/child plan，无在途业务事务。父V2未被本次尝试更改。

静态定位：`src/stores/gis-frozen-plan.ts::openIdentity`明确以context=gis读取原plan版本，现有测试也要求保留真实GIS上下文；`algorithm-service/app/main.py::plans_get`仍只接受planning，虽然同文件已保存方案目录允许planning/gis并对gis额外核对situation.view。因此不在manual改成planning上下文或换入口绕过该契约阻断。

主已自行修改共享`algorithm-service/app/main.py::plans_get`：增加Request，task_id存在时接受planning/gis，gis显式核对planning.view+situation.view，保留legacy无task分支、planning行为及原来源检查。E未修改main.py或local_frontend_boundary，执行/重启/共享接口台账均由主处理；当前C独占coverage/report原号只读浏览器，E没有测试或浏览器token。

E获批仅修改`tests/test_gis_plan_api.py`并静态完成13个参数化main-handler场景：

| 组 | 静态数量 | 覆盖 |
|---|---|---|
| GIS与planning兼容 | 1 | 真实main.plans_get与真实planning_plan_service读取同一既有P1/T1，返回完全一致；resource-old与当前resource-new不符时仍保留冻结input/result，source_changed=true/current=false且原current指针不被读取动作改写 |
| 非法context | 5 | ledger/demo/unknown/空串/缺省均422/code1001/data=null |
| 双权限 | 3 | 空权限、仅planning.view、仅situation.view均403/code1104，必须实际调用对应require边界 |
| 未鉴权 | 1 | stub边界抛真实IdentityError类型，handler保留401/code1101/data=null |
| 归属/存在性 | 2 | P1配OTHER task及MISSING plan配T1均404/code2001，不跨任务返回冻结数据 |
| legacy分支 | 1 | 无task_id时仍分派原get_plan；该legacy依赖单独stub，仅验证dispatch兼容，不冒称旧算法或权限集成 |

新增fixture`main_plans_get_api`复用原`api` fixture的`tmp_path/gis.sqlite`、seed P1/T1/I1/J1及同一session factory，只向原隔离FastAPI注册真实`main.plans_get`，不启动完整main.app或其middleware/lifespan。测试内DATABASE_URL显式限定为该既有隔离库，真实service的factory指向同库，不访问.24运行数据库。每例监听SQL，拒绝INSERT/UPDATE/DELETE/REPLACE/DDL，并比较原task/revision/job/plan/current-pointer全部列快照，证明没有多余写。

身份边界明确为**stub契约测试**：require stub按当前用例返回权限或抛原IdentityError，断言GET/writing=false及权限调用顺序；未验证LOCAL账号、cookie、会话替换或local_frontend_boundary，也不证明完整主应用鉴权。LOCAL真实权限与浏览器闭环仍由主后续单独验收，不弱化生产权限以满足测试。

推荐主在仓库根目录执行下列**单文件且仅新增handler用例**命令；当前E未执行，也未做collect/语法检查：

```powershell
& 'F:/work/project2026-1/.venv/Scripts/python.exe' -m pytest -q tests/test_gis_plan_api.py -k main_plans_get
```

该过滤不运行原文件的`test_isolated_socket_http_projection_and_errors`，不启动127.0.0.12测试socket，更不启动或重启.24服务；不额外设置运行库DATABASE_URL或创建另一套业务库。13为静态参数化计数，实际收集数量、通过/失败及API装载后真实I回验结果待主记录，当前不得记PASS。

manual失败日志已静态瘦身：完整已消费HTTP、已捕获的未等待失败HTTP、写入原号及原错误存到宿主本轮证据目录`<case>-http.json`（UTF-8/no overwrite）；错误正文和stack只保留截短原错误、anchors、request IDs和最多24项路径/HTTP/code摘要，避免完整快照重复塞进results.failure.message与终端。证据落盘失败明确报告，不覆盖旧checkpoint。该新日志分支尚未实际运行验证；97fcfd历史原证据保持不改。

E-F01至E-F05及A/V后续浏览器分段仍未执行；I停在首个真实前置阻断，未把未执行链路登记通过。本次没有额外node --check或单测。先前17组件测试通过不代表采纳详情实际UI已通过。阻断修复ready并获主新token后，因本次0业务写才可重新开始I一次；后续任何已受理原号只读恢复，不整体重提。FinalRefresh继续等最终资源冻结token。

每个函数串行执行；任何异常立即经record抛出终止group，保留原作业、REFERENCE、分析和采纳编号。后台终态观察上限360秒，仅观察产品自身真实轮询，不自行请求API。选择器无强制点击/隐藏操作；来源或版本变化、HTTP非预期、无有效源/措施、无法同页对比、下载内容不符均停止。主统一登记共享台账，E不改共享台账。当前没有在途业务写/浏览器会话；后续只在主明确恢复并给token后执行指定入口。

## I实际执行及原号失败保留（后续记录）

以上GIS阻断与静态ready是此前时点记录。主随后报告隔离handler测试13 PASS / 45 deselected、60.59s，JUnit=`r6-gis-plan-detail-context-20261025.xml`，并重启仅本轮.24 API装载修复；E未启动测试或服务。身份桩/LOCAL边界仍按上文区分。

| 证据目录（runtime/browser/下） | 实际结果与恢复边界 |
|---|---|
| `r6-browser-1792871478143-83ad76` | I01 FAIL：场景仅PUT一次并GET成功，后续Escape关闭抽屉等待超时；未分析/采纳。改本组manual为真实关闭按钮，保留此FAIL |
| `r6-browser-1792871694328-9820bf` | 原场景回读PASS，单分析提交checkpoint PASS；分析已SUCCESS，预览脚本错误地将运行digest与场景snapshot_hash直接比较而FAIL。依据真实DTO改为逐项核对scene_version_id、source.version_id/source.snapshot_hash和完整冻结父plan；运行digest在preview/adoption间精确一致，不弱化来源断言；未重分析 |
| `r6-browser-1792871871550-83a284` | 原场景/原分析/措施预览/单采纳checkpoint均PASS；采纳原号终态为FAILED，error=`桥回报与持久化作业状态不一致`，无持久化子plan。本次真实失败保留 |
| `r6-browser-1792872044379-aee1b4` | 仅原号只读4 PASS，0业务写；实际点击采纳详情，GET原IAD及原run、关闭；原child job及父V2 GET一致。此PASS仅证明失败详情/原号回读，不算采纳成功 |

场景=`ISC-78232efa-d4b7-4760-b2b9-ecd006fa6b30`，版本=`ISV-461c806f9a4f4d70be1d2b0b009b18ec`，保存request=`4a363435-cbc3-4f44-9930-4060f3d4ff68`。分析=`IRN-c393b6a276864f1696dd93cfe241a937`，request=`6fd7eb46-3708-4646-9497-2fb328005673`。分析实际提供CHANNEL_SWITCH和FREQ_ADJUST两类可行措施，不要求每次结果均有五类；五类支持能力与措施子集分别核验。场景snapshot_hash=`9a88e68b3a3f462db042fa090293764148446c97f8e2d1ea69f1d0f6832a877b`；run/preview/adoption的source_hash=`18f4dd862a71930c56f0229d8b9135ca5d9d64e77acd1ded8c395cfc81dc7320`，两者语义不同。

原采纳=`IAD-a9fe72310cc24e229eb79740bf9d1341`，request=`58187ea0-f0dc-4cfd-b3bc-3ccd9f7926a9`，planning_request=`interference-IAD-a9fe72310cc24e229eb79740bf9d1341`，子job=`tsk-d447a171c25d`。IAD保持FAILED、result_plan_id/state=null；子job已SUCCESS、saved_plan_id=null、快照=`SNP-PL-DF0D2CD5`。子job结果outcome.code=3001，频率check=false，gap为`NET-ND-0007-VUHF`与`NET-ND-0037-VUHF`同频，实际间距21654m小于要求25000m；其余三个checks通过，抗毁91.01%。该硬约束缺口允许正常保存REFERENCE，但当前没有保存出子plan，不能称为REFERENCE采纳完成。

最近实际只读证据中父V2=`PLAN-4d974f02b63b465ca03e030dcda8eff9`仍CONFIRMED/current=true/source_changed=false，冻结结果未变；任务input/condition/resource仍为本文既有版本。没有启动A/V计算。四次CLI均已退出/context关闭，主已确认55324无监听；没有不确定写入、没有待取消事务。本组不SQL重置FAILED、不改旧checkpoint、不用新采纳覆盖此失败。

完整HTTP日志实际已分别落在对应case的`*-http.json`，日志瘦身分支已真实运行；83a284原完整错误、IAD终态与子job结果可分别回溯，旧日志不覆盖。`runInterferenceFromScene`、`runInterferenceFromRun`、`runInterferenceFailureReadback`仅按脚本中固定证据/请求号恢复，不用latest推断。当前禁止执行这些入口。

## 桥竞态最小修复（已批，静态ready）

修复前窗口（以下行号为修复前）：`interference_replan_service.py:303`的bridge.poll已返回PENDING/RUNNING后，`:304`重新开启WB写事务，`:309`将旧outcome.state与新job.status精确比较；期间算法回调或查询可在另一事务持久化SUCCESS，随后5002被`:328`归为终态FAILED。实际IAD错误与此窗口一致；原证据未记录poll当刻旧状态，不能编造具体是PENDING还是RUNNING。

主已内部批准仅两文件：`algorithm-service/app/interference_replan_service.py`、`tests/test_interference_adoption.py`；本文件同步记证据。生产已静态落盘：仅在run_once中复用现有进程内`planning_job_service._SUBMIT_LOCK`，在**前一WB关联事务已提交后、bridge.poll之前**获取，持续到最终WB核对/采纳提交完成或回滚。保持原exact mismatch、_row/_job/_plan来源与措施校验、租约和取消分支；不增加重试、submit、状态宽容、终态改写或DB迁移。

| 锁序依据 | 当前源码事实及约束 |
|---|---|
| 冻结job状态一致性 | `planning_job_service.py:539/575/670/700/840`的回调、提交、启动恢复、取消和查询均先持_SUBMIT_LOCK再开DB事务；该锁为`:40`的RLock，同线程poll中query/save再次获取可重入 |
| 保存锁 | `planning_plan_service.py:167`在_SAVE_LOCK前完成_job_result/query；唯一_SAVE_LOCK区段`:171-220`内不再获取_SUBMIT_LOCK。提案锁序为_SUBMIT_LOCK → _SAVE_LOCK → 保存DB事务，保存事务和_SAVE_LOCK释放后再开WB最终事务；绝不在WB写事务内调用poll/save |
| WB事务 | `interference_workbench_service.py:68/73`写事务为BEGIN IMMEDIATE至commit；现有采纳submit/cancel和run_once的WB事务内没有调用bridge或获取_SUBMIT_LOCK。前两段WB事务先结束，再获得提案外锁，避免WB写锁 → _SUBMIT_LOCK反向等待 |
| 运行时锁 | `planning_w3.py:134-137`先调用_set，在其`:91`的_LOCK已释放后才调用on_update；get_task_record只短持_LOCK，无_LOCK → _SUBMIT_LOCK嵌套。提案不等待算法线程、Event或join；运行时可先推进内存，真实query在同一外锁下同步其状态后，再精确核对DB |

这是当前单API进程/SQLite实现下的进程内一致性窗口，不宣称解决多进程派发。外锁仅覆盖本轮poll及已有保存/核对，不跨算法运行时长；poll成功路径仍有真实文件读取/结果适配，因此会暂时串行化其他job状态操作，需在获准定向测试中核实无死锁和及时释放。若未来多进程需另案设计数据库状态见证，当前不扩scope。

新增测试均以`test_poll_state_window_`开头，共5函数/18个参数化场景。首次静态交付时未执行、未collect；后续主执行结果及fixture修正另见下节，不把静态ready记为PASS：

| 场景 | 数量 | 具体断言与证据边界 |
|---|---:|---|
| 确定性状态推进 | 4 | PENDING→RUNNING、RUNNING→SUCCESS/FAILED/CANCELLED。显式桥桩冻结旧快照；Event控制另一线程经真实_update_interference_job推进。跨线程非阻塞探测锁，严格核对Workbench空分析扫描、领取租约、关联job、最终WB commit后的可获取性为true/true/true/false；桥内独立连接可BEGIN IMMEDIATE，证明未在WB写事务中poll。释放后原回调完成，同job下一轮收敛，submit一次、无sleep概率重试 |
| exact mismatch反例 | 4 | 假SUCCESS对真实RUNNING、FAILED与CANCELLED错终态、SUCCESS倒退RUNNING均维持原5002和FAILED；FAILED不会再次领取或改成功 |
| 来源/措施反例 | 5 | 错job request、错job origin、错父plan、错plan origin、实际频点未应用均拒绝；错来源DTO本身也会拒绝，故直接核对隔离库持久化失败事实，父current/快照不变 |
| 锁释放及早退 | 4 | poll传输异常、mismatch、租约被其他worker取得、已进入终态，均由另一线程确认RLock已释放；保留稳定job/租约/原终态，不再次派发 |
| 真实REFERENCE保存一次 | 1 | 复用既有_native_dispatch_case的真实W3/W4两节点单边小样本，合成DEM/显式UNIT措施边界不变；单边网天然不满足既有90%抗毁，真实adapter产生3001与gap，不改门槛/结果。真实FrozenPlanningReplanner与save_planning_plan在持锁路径正常保存REFERENCE，稳定save请求只调用一次、数据库仅一子plan；完整result/checks/outcome/gap与原job一致，重复调度/replay不再save，未确认且父current不变 |

Event/探测/join及回调取锁等待均有界；真实小样本复用既有120秒终态门禁，不接.24运行库。普通取消与晚取消仍由原文件既有定向用例覆盖，未改其逻辑。以上不是完整SR4/LOCAL权限/浏览器验收。

主结束B独占窗口后，可在仓库根目录用本树**全新GUID basetemp**只跑新增场景（E当前不执行）：

```powershell
$ePollTemp = Join-Path (Get-Location) ('data/runtime/tmp/r6-e-poll-' + [guid]::NewGuid().ToString('N'))
& 'F:/work/project2026-1/.venv/Scripts/python.exe' -m pytest -q tests/test_interference_adoption.py -k poll_state_window --basetemp $ePollTemp
```

随后如主执行本文件既有取消/冻结桥回归，应另用新GUID basetemp、去掉`-k poll_state_window`；不复用或指向任何运行库目录。E仅做源码/diff和编码字节静态审阅，三文件UTF-8无BOM，未运行Python/pytest/语法检查或其他测试。

当前生产补丁与18个测试场景静态ready，等待主统一测试及仅.24装载；本组无执行token、无CLI/browser/业务写/计算。原FAILED IAD/job及失败子结果证据不改、不SQL重置。新独立analysis/adoption须主另案明确授权；真实复验若得到3001，应保存并诚实展示REFERENCE，禁止转成SAVED/确认或换号凑结果。

## 主组合执行后的fixture/探针修正（仅静态，待复测）

主首次session 54988的5 PASS/98 SETUP_ERRORS因scene_api要求本树`data/runtime/tmp`，却把basetemp设在`runtime/r2`；不构成功能结论，旧XML保留。主改为`data/runtime/tmp/r6-if-window-1f7368162cb3404ab5021de8d64374b8`后，session 56944退出1：79 PASS/24 FAIL，551.38s。证据为`data/runtime/r6/r6-interference-window-20261025-b.xml`及同名`.log`；E仅读取这些文件，未执行测试或业务。

| XML聚类 | 数量 | 明确原因与未验证边界 |
|---|---:|---|
| 既有native桥/取消/恢复 | 19 FAIL | 7例直接抛5001“算法任务/方案实际目录不在本树指定r2根内”；其余12例在原有错身份/来源反例期望1203前被同一5001路径门禁拦截，尚未到算法派发或本次poll锁窗口，不能改期望接受5001 |
| 新nativeReference | 1 FAIL | 同上路径门禁，在_native_dispatch_case首个反例断言处5001≠1203；尚未证明真实REFERENCE保存可用，不改为通过/skip |
| 新Event探针 | 4 FAIL | 精确实际`[True, True, True, False]`与旧预期`[True, True, False]`不等；原updated Event、有界join、errors为空及contended=[True]此前均已通过，非锁等待超时，但后续同job收敛断言仍须复测 |
| 未失败用例 | 79 PASS | frontend_api全54 PASS；adoption 25 PASS（含新mismatch/来源/锁释放13例）。不将其外推为24失败已修复通过 |

多出的WB事务身份：`InterferenceWorkbenchService.run_once`在`:406`先开启写事务扫描待分析Run，即使查无行仍在`:423`前正常commit，之后`:424`才委派replanner；再依次为replanner领取租约、关联原job、poll后的最终WB提交。因此只将**精确预期**补为四项`[True, True, True, False]`，继续证明前三段不持状态锁、最终commit仍持锁；不宽松计数、不忽略False、不改Event/来源/取消断言或5秒等待。

路径源码依据：`planning_w3.TASK_DIR`与`planning_w4.PLAN_DIR`分别在模块导入时从`ALGORITHM_TASK_DIR`/`SR4_PLAN_DIR`或默认tasks/plans目录取值。原scene_api只绑定DB factory，adoption测试未绑定真实模块常量；正确tmp DB门禁通过后，`validate_interference_runtime`的第二层实际算法目录检查仍失败。不存在本轮身份403、5002 mismatch或死锁超时的失败聚类，但native锁序完整结论仍待复测。

主随后批准仅测试fixture及准确探针期望修正。E已静态新增本文件`_native_runtime` fixture：每个需真实入口的测试创建`data/runtime/r2/pytest-adoption-{全新GUID}/tasks|plans`，直接monkeypatch真实planning_w3.TASK_DIR与planning_w4.PLAN_DIR，保留测试文件，不依赖继承环境、不复制依赖、不重载模块、不改生产guard或任务/方案缓存。DB仍由原scene_api强制位于本树tmp；仅8个受影响测试函数（20参数化例）显式声明该fixture，不给已通过的其他用例增加autouse路径改动。无需修改`test_interference_frontend_api.py::bind`。

本次仅修改`tests/test_interference_adoption.py`与本记录；production RLock补丁继续冻结。可只复测受影响24例，已有79例不在此筛选内。以下筛选已按旧XML的实际testcase名称静态核对：匹配24、均为本次FAIL、未漏其他FAIL；没有运行pytest collect：

```powershell
$eFixTemp = Join-Path (Get-Location) ('data/runtime/tmp/r6-e-window-fix-' + [guid]::NewGuid().ToString('N'))
& 'F:/work/project2026-1/.venv/Scripts/python.exe' -m pytest -q tests/test_interference_adoption.py -k 'native or startup_recovery or cancellation_waits_for_worker_checkpoint or recovered_child or serializes_callback' --basetemp $eFixTemp
```

旧XML/log、原FAILED IAD、原SUCCESS子job及3001频率gap全部保留；本次不重置、不提交新analysis/adoption、不运行任何测试/browser/HTTP/计算。当前仅静态修正ready，结果等待主串行复测，不能写24 PASS。

## 修复后独立I新案入口（仅静态准备，无执行授权）

现有`runInterferenceFromScene`确实会复用原场景后新提交分析/采纳，但没有新案专用写前意图、旧号排除和REFERENCE gap展示取证。按主批准，仅在本组manual新增显式export `runInterferenceFreshAfterBridgeFix`，复用其余真实UI流程，不修改harness或production。旧`runInterferenceFromRun`会打开旧分析，其措施已有FAILED采纳，不能用来生成新案；旧`runInterferenceFailureReadback`继续仅只读。

新入口静态顺序：

1. 读取固定`browser/r6-browser-1792872044379-aee1b4/results.json`中已PASS的原号只读记录，核对原FAILED IAD、原SUCCESS job/saved_plan_id=null、code3001及完整gap、task/input/condition/source7c。这是**历史基线证据**，不冒称本轮又GET了旧号，不改旧文件。
2. 仍经既有原场景证据定位`ISC-78232efa-d4b7-4760-b2b9-ecd006fa6b30`/`ISV-461c806f9a4f4d70be1d2b0b009b18ec`；真实UI GET父V2与场景、确认current/source/input/condition/resource不变，无场景保存。任何版本或来源变化停止。
3. `E-I02-new-analysis-intent`先经宿主record落盘旧IDs/失败、父方案版本/资源、原scene/version/hash和“一次新分析/一次新采纳、禁止确认”意图，成功落盘后才点“提交干扰分析”。前端在点击时生成真实request_id，脚本不伪造或提前注入；新回执立刻在原`E-I02-submit-checkpoint`落盘，再等待终态。断言新run/request不同于旧分析，运行初始adoptions为空。
4. 正常原号分析/措施预览完成后，`E-I03-new-adoption-intent`先落盘新run/request、实际measure/change_set/source_hash、原失败号及禁止确认边界；之后只点一次采纳。`E-I03-adopt-checkpoint`记录新IAD/request/planning_request后才等子job，明确排除旧IAD/规划请求/子job。
5. IAD必须真实SUCCESS且有持久化子plan；FAILED/CANCELLED仍保留并失败退出，错误摘要保留state/error/job/plan及anchors，完整HTTP文件不截断。真实job GET必须回显新job及saved_plan_id；实际点击采纳详情，核对原run/IAD/子job/子plan/请求号并关闭，禁止借详情重提。
6. 打开新子方案，深等子job与子plan的完整result/outcome/checks/gap及冻结输入版本。REFERENCE须保持code3001和非空真实gap，实际确认按钮禁用；切换真实“2 · 规划计算与结果”，核对aria-label“当前方案服务结论”中每条gap.message可见，保存`E-I04-reference-gap`截图及完整显示文本。真实25km频率缺口按原文展示，不删gap或改阈值。若实际SAVED，必须code0/gap空/完整checks全true；两种结果均不确认。
7. 父V2 GET仍CONFIRMED/current=true且result不变，新分析/采纳详情再打开核对；最后严格浏览器业务写清单只能为1 POST /runs + 1 POST /adoptions。旧FAILED IAD/job不在任何写请求中，也不保存其未持久化结果。

以下是**未来主明确授权后的唯一单次调用方案**，当前没有启动，仍等待主24例pytest、装载与新案token：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' 'tests/manual/r6_browser_acceptance.mjs' --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' --group planning --playwright-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json' --task-id r4-network-89db2499fcf6 --plan-id PLAN-4d974f02b63b465ca03e030dcda8eff9 --entry runInterferenceFreshAfterBridgeFix
```

该入口不是恢复工具：接受任何新分析或采纳后若断言/落盘失败，立即保留该次原request/run/IAD/job，只按主后续原号只读恢复授权处理，**不得再次运行本入口**。不自动进入A/V、FinalRefresh或第二轮分析/采纳。当前只静态编写/源码与diff审阅，未跑语法检查、测试、浏览器、HTTP、算法或服务操作。

## ef5f14实际新案及LOCAL后台保存阻断

主报告精确24例复测PASS/25 deselected、222.56s，`r6-interference-window-fix-20261025.xml/log`；原79 PASS保留。主随后仅.24 API重启28500→29848、health/code0并装载RLock。获独占token后，E先执行所属manual的`node --check`退出0，再仅一次新案CLI（session 18244）。证据=`runtime/browser/r6-browser-1792875916123-ef5f14`，最终6 PASS/1 FAIL、page_errors=0、completed=false，CLI退出1且context关闭，55324已由主/E分别确认无监听。

| 实际原号 | 状态与边界 |
|---|---|
| 新分析`IRN-aace31d38ce44ccdbb9904569579aad3` | 提交request=`eca181d7-9dd3-4c0a-b3d4-202a05edf432`，真实SUCCESS及预览PASS；与原场景/父V2/source7c及运行hash精确一致 |
| 新采纳`IAD-8eebc0ad511c4744bcc38eeb5ceff183` | request=`5b6d1f4e-b40a-472a-8899-185db38497ff`，planning_request=`interference-IAD-8eebc0ad511c4744bcc38eeb5ceff183`。原意图与受理回执均已落盘；最后实际GET仍RUNNING，error=`本地规划操作缺少可信业务上下文` |
| 新子job`tsk-8f6b3b3f904b` | 由同一实际adoption GET回显持久化planning_state=SUCCESS、progress=100；result_plan_id/state=null。E尚未另GET子job完整result，不能将旧job的3001/gap补成新job已验证结果 |

最初case错误是`E-I03-adopt-real-child-original-receipt`在360000ms内未返回采纳终态，不是算法尚未完成。完整原错误及100条已消费HTTP在同目录`E-I03-adopt-real-child-original-receipt-http.json`；最后05:12:26响应显示adoption_version=202、子job SUCCESS及上述保存错误。宿主record保存又出现`EPERM results.pending.json → results.json`，最终results.json仍保留7 cases而顶层failure为EPERM；两个错误分别保留，不改绿。主曾在运行中读取大results文件，已停止所有在途结果文件读取并接管宿主保存修复，E不修改harness。

本次只有1分析POST+1采纳POST；无场景PUT、方案保存/确认、资源/频点写。A/V/REFERENCE独立入口与FinalRefresh均未执行。token已明确交回，无活动E CLI/browser/文件读取；后台IAD按原号继续重试保存，E不SQL置终态、不取消或重提。旧FAILED IAD=`IAD-a9fe72310cc24e229eb79740bf9d1341`及旧job/证据不变。

只读定位链：`FrozenPlanningReplanner.poll → save_planning_plan(audit_context=None) → planning_operation_service._business_context`在AUTH_MODE=LOCAL_PASSWORD抛5001。该异常不进入原5002终态拒绝分支，因此IAD保留RUNNING重试，不能靠加长等待变PASS。此前隔离native测试没有覆盖这个正式LOCAL后台保存边界，不能将其24 PASS外推成LOCAL业务通过。

主已接管`planning_plan_service.py`和`interference_replan_service.py`，新增私有worker关键词`_interference_request/_runtime_root`，普通LOCAL guard保持；以唯一不可变ADOPT_MEASURE受理证明及真实LOCAL账号/当前角色权限验证后台授权，不伪造cookie/SystemActor，不追加用户plan.save ownerProof。主负责生产、共享台账、测试执行与仅.24装载。E只新增下节测试，不改这两份生产文件/共享guard/旧测试。

## test_interference_worker_save.py（静态ready，未执行）

新文件只调用已约定签名：`save_planning_plan(payload, factory, _interference_request=原请求, _runtime_root=独立r2目录)`。真实bridge也按同样关键词传递；回滚注入点为`app.system_audit_service.append_system_audit`，不改生产helper。审计预期module=`interference`、action=`interference.plan.save`、原受理人真实DB账户/角色snapshot、七个精确changes字段`adoption_id/run_id/accepted_request_id/job_id/parent_plan_id/task_id/revision_id`，只有一份且不含ownerProofVersion、不冒充plan.save。

fixture边界：复用旧scene_api的本树tmp新库、`_native_runtime`的独立r2 GUID和真实W3/W4两节点单边算法。仅在新文件内给该测试FastAPI替换DEMO auth路由并安装正式LocalIdentityAdapter/Router；实际建立LocalAccount/LocalRole/LocalCredential/SystemState、真实密码hash和登录。固定账号ID`integration-planner`只是为兼容既有UNIT helper，数据库中是实际LOCAL账号，登录断言FORMAL_VERIFIED及integration_mode=false；不mock actor、不构造SystemActor。全程AUTH_MODE=LOCAL_PASSWORD、FRONTEND_INTEGRATION_DEMO=0，不关闭正式模式绕过保存guard。Run/措施/不可变受理原件为显式UNIT材料，在真实派发前用既有_receipt生成且绑定实际登录人，不冒称真实浏览器采纳流程。

共12函数/34个静态参数化场景，未collect/执行，不记PASS：

| 覆盖 | 数量 |
|---|---:|
| 普通LOCAL save无可信上下文仍503/5001且零写 | 1 |
| 错source/actor/task/job/planning_request/measure/change/origin，固定payload的save request/task/job/revision/name不符，错误runtime | 15 |
| 原受理证明缺失、changed=false、hash错误、多份changed=true、hash有效但object_type错误、hash有效但status非ACCEPTED | 6 |
| 缺真实账号、停用、分别缺view/situation.view/execute/save权限 | 6 |
| 原FAILED采纳不能保存复活 | 1 |
| 真实REFERENCE保存及独立审计一次；同原请求重放零写 | 1 |
| 重放重新核对来源/当前权限；首读后、写事务前撤销权限须拒绝 | 2 |
| 审计实际插入后故障，方案/审计同回滚；恢复后同原请求保存成功 | 1 |
| bridge已存在方案的重放也必须复核LOCAL授权 | 1 |

零写验证同时监听SQL INSERT/UPDATE/DELETE/DDL与对照task/revision/job/plan/current/run/adoption/operation/account/role/audit全列快照；测试中的恶意材料和权限变更发生于调用前的隔离fixture，拒绝本身不得附带写。审计故障测试允许事务内真实INSERT后rollback，比较落库前后完全一致，并用同一请求恢复保存，不造新job。正测3001、完整result/checks/outcome/gap与原真实小样本job保持一致，父current/快照不变，未确认；该小样本的硬约束缺口不是本轮生产25km缺口的替代证据。

只读复审已向主反馈两个必须保持严格的反例：bridge.poll已有plan的早返分支不能绕过新私有服务的重放授权/审计；受理证明必须明确object_type=ADOPTION而非仅表行和receipt相等。新增测试要求拒绝，不改宽松。生产是否已修由主复核，E未编辑生产。

主随后报告最终proof增加status=ACCEPTED与object_type=ADOPTION两项硬检查；新专项已覆盖有效正例及两种hash仍有效的坏原件。坏receipt只在隔离库尚未首次flush/INSERT前构造，之后不UPDATE/DELETE不可变回执；不借SQL修改生产fixture既有持久行。主session 56249加载的是此前版本，不能当作最终worker证据；该专项仍待主另行串行执行。

主报告56249最终110 PASS、旧6个native保存FAIL：旧_native_dispatch_case直接构造Adoption却没有Operation，生产正确拒绝，不能放宽proof。主自行给旧helper新增`accepted_receipt=True`默认凭真实WB._receipt构造UNIT原件；E仅将本新专项的唯一调用显式传`accepted_receipt=False`，仍由本文件wrapper独立生成正/坏原件，防止额外受理凭证污染各凭证场景。主另报告bridge已有plan分支已改为仍经私有save授权重放、且命中首只读replay后不读运行文件；该问题不再登记为未修，但尚待专项实测。主计划新34+旧6共40例串行，旧6后续结果与原110 PASS分开记录；E未执行任何负载。

主获得串行测试窗口后可执行（E现在不执行）：

```powershell
$eWorkerTemp = Join-Path (Get-Location) ('data/runtime/tmp/r6-e-worker-save-' + [guid]::NewGuid().ToString('N'))
& 'F:/work/project2026-1/.venv/Scripts/python.exe' -m pytest -q tests/test_interference_worker_save.py --basetemp $eWorkerTemp
```

只读恢复入口`runInterferenceAcceptedReadback`已获主明确manual+R6-E收口授权，按下节专用readonlyCompletedAdoption分支完成静态收口。入口保持此名称，不新增Saved别名；当前未运行、修改后未node --check，须等主40例和仅.24装载完成后另给执行token。禁止重跑`runInterferenceFreshAfterBridgeFix`。

## 原ef5f14持久化完成后的只读恢复（静态ready）

确切entry=`runInterferenceAcceptedReadback`。不改tests或production；主已报告40例session 40887退出0，40 PASS/385.66s，证据`r6-worker-save-final-20261025.xml/log`，最终源码包含status/type/bridge只读replay及原摘要核验。主已对当前manual执行node --check通过，但未执行readback。主正仅.24重启装载；E没有启动任何浏览器/HTTP/测试，等待health确认和明确串行token。

入口先读取已退出ef5f14的results.json，严格要求按原顺序6 PASS（原scene、分析意图/回执/预览、采纳意图/回执）和原E-I03 FAIL，completed=false；再读取该原case的failed-http，核对最初360000ms超时、新IAD原受理请求/原run，以及原GET所见RUNNING/缺可信上下文、child SUCCESS和plan=null。原顶层EPERM及所有FAIL保持原文件不改，不将其覆写为成功。

固定回读`IRN-aace31d38ce44ccdbb9904569579aad3`、`IAD-8eebc0ad511c4744bcc38eeb5ceff183`、`tsk-8f6b3b3f904b`及request `eca181d7-9dd3-4c0a-b3d4-202a05edf432`/`5b6d1f4e-b40a-472a-8899-185db38497ff`。原scene及hash仍经既有固定证据定位，原measure精确限定`CM-a8a8670f0359b55871f5f02d`；不再选“首条可行措施”代替原measure。

`readonlyCompletedAdoption`要求resumeScene+resumeRun齐全，拒绝混入fresh/旧FAILED恢复/宽松Accepted分支。完成分支在默认新采纳POST之前直接return，三个前置步骤只GET，末尾c.writes必须0。实际原run GET必须回显同IAD为SUCCESS、error=null、planning_state=SUCCESS/100、真实result_plan_id及REFERENCE；仍RUNNING或任何失败立即停止，不延长等待、不点击重试、取消、采纳或保存。

采纳详情实际点击、原IAD和原run GET、完整字段核对和关闭沿用严格helper，SUCCESS不可被宽松状态推进逻辑接受；随后原job GET的saved_plan_id必须指向同一新持久plan。子plan的result/outcome与原job深等、code3001、非空原gap完整显示并截图，确认按钮必须禁用；input/condition/resource保持既有版本且source_changed=false，不改门槛或确认。

父V2初次GET先与ef5f14原GET的完整result深等，最终再GET证明CONFIRMED/current=true、result不变。旧a9fe FAILED从原分析意图的retained_failure严格核对并保留，不对其发送写请求，也不冒称本轮重新GET了旧a9fe。整个入口只证明同一新IAD修复后完成持久化，不制造第三个analysis/adoption或新job。

未来获主明确只读browser token后，沿既有完整CLI参数只改entry为：

```text
--group planning --task-id r4-network-89db2499fcf6 --plan-id PLAN-4d974f02b63b465ca03e030dcda8eff9 --entry runInterferenceAcceptedReadback
```

E当前仅做静态源码/差异检查，未执行额外node --check或验收负载；主已报告当前manual语法检查通过。只读恢复、A/V/REFERENCE仍未执行，保持等待health确认与执行token。

## ff5d96实际I恢复与ef0898硬件档位拒绝

主定位b928b3提前回读仍处原5分钟lease，旧error不能证明sameSessionDTO修后再次失败；其后主确认原IAD已由原worker正常保存。再获唯一token后，E用同entry执行session 37328，证据`browser/r6-browser-1792879930240-ff5d96`，退出0/context关闭、4/4 PASS、page_errors=0、0业务写。实际原IAD=`IAD-8eebc0ad511c4744bcc38eeb5ceff183`为SUCCESS/error=null，原job=`tsk-8f6b3b3f904b` SUCCESS，原号正常保存子plan=`PLAN-3f42a59887ca463bbd732175995f7884`，REFERENCE/code3001。

真实gap完整保留并在UI截图：NET-ND-0007-VUHF与NET-ND-0037-VUHF同频，间距21654m、要求≥25000m；禁止确认。父V2仍CONFIRMED/current=true且result与ef5f14原冻结内容深等。没有新分析/采纳；旧a9fe FAILED、ef5f14超时/EPERM和b928b3提前回读FAIL均保留，不覆盖旧结果。

I成功后按同轮授权串行启动原runPlanningAdjustment（session 57785），证据`browser/r6-browser-1792880042704-ef0898`。E-A01非法文字/取消编辑PASS，E-A02单次受理checkpoint PASS；E-A02结果保存前FAIL，实际job=`tsk-aa60dc27b628` FAILED、outcome=null、saved_plan_id=null。提交request=`15f69b98-f9c2-487a-b17b-ed4af179dc67`；真实error=`ValueError: 人工设备参数无效：设备 DV-0001 功率不属于型号档位 [51.76]`。

该脚本将原51.76减0.1成51.66，不属于型号唯一档位，后端拒绝正确；不改硬件规则、算法或门槛。手工路径已原样受理为DEMAND-01的既有备用路径显式选主，输入/条件/resource7c未变。没有保存新plan、没有确认；V和独立REFERENCE入口未执行。原job保存FAIL保留。CLI已退出1/context关闭、55324无监听，token已交回。

## runPlanningAdjustmentLegal（内部批准，静态ready）

仅新增本组manual入口与本记录；不修改production/tests，不重跑原A01或原A02非法档位作业。入口固定原task/父V2及既有input/condition/resource7c，不调用default、compute、Fresh或旧runPlanningAdjustment。

能力证据严格读取已关闭且4 PASS的ff5d96/results.json之E-I01.scene.version.plan_snapshot.raw_snapshot.detail.params.params。已只读确认其中460条原参数原生含tx_power_levels_dbm/antenna_height_range_m；例如DV-0037原40dBm，冻结档位[40,46.99,50.97]。入口不硬造这些值：执行时重新GET父方案，核对task/plan/version、raw.solution_id=PL-E4AFB9A0与SNP-PL-E4AFB9A0、输入/条件/资源、完整input、配置设备ID/节点/原power一致后，才从真实已配置且active的设备中选择一个不同合法档位。

若全部配置设备都没有不同合法档位，才允许明确标记FROZEN_CONTINUOUS_HEIGHT_FALLBACK：读取该设备冻结[low,high]连续高度范围，核对原height和power、仅取范围内不同值并在意图中保留范围/原值/新值；没有合法能力就停止，不读当前全局CSV或换来源。当前冻结样本存在多档设备，预计使用真实功率档位，执行前不冒称已写入DV-0037。

| 新case | 动作与落盘边界 |
|---|---|
| E-AL01-failed-job-parent-frozen-source | 真实规划历史GET原FAILED tsk-aa60dc27b628及完整硬件拒绝原因/saved_plan_id=null，核对parent/版本，再GET父V2不变；记录冻结能力选择和唯一手工路径来源。0写 |
| E-AL02-legal-adjustment-intent | 开原父调整界面，用未完成数字草稿`-`暂时阻止700ms自动预览，再显式设置既有备用或原主路径。路径下拉原生没有空选项，不能假造空节点；临时草稿从不提交、不重测旧非法档位job。确认期间0写，先经record落盘实际来源、旧FAILED号、合法值/路径和“一次submit+一次save、禁止confirm”意图 |
| E-AL03-submit-checkpoint | 最后一次将未完成草稿替换为冻结合法值，等待真实自动POST /plan/sr4-flow，仅一次；立即保存原request/new job及完整adjustment，再进入终态等待。核对单设备override恰为冻结合法值，manual_paths为已明确输入路径，来源版本不变，新job不同于旧FAILED号 |
| E-AL04-result-save-readback | 同一新jobSUCCESS后才正常保存新版本一次，深等result/outcome/adjustment及实际设备值/主路径；SAVED须真实code0/checks全true，REFERENCE须code3001并保留显示全部真实gap、禁确认。最后父V2 GET仍current/result不变，业务写清单严格1规划POST+1保存POST，无confirm/resource/task写 |

若任一新业务写后失败，保留该新request/job/plan原号，只读核实，不换设备/档位/路径或重提以凑通过。原FAILED tsk-aa60dc27b628不复活。四case成功后才可由主再安排V与独立REFERENCE，传实际新child ID，父V2不确认替换；FinalRefresh仍无授权。

当前仅静态编码及源码/差异审阅，**修改后未执行node --check、测试、浏览器、HTTP或算法**。未来主明确token后沿既有CLI仅指定`--entry runPlanningAdjustmentLegal --task-id r4-network-89db2499fcf6 --plan-id PLAN-4d974f02b63b465ca03e030dcda8eff9`，不得直接重跑原A入口。

主后续授权实跑：manual先node --check退出0，runPlanningAdjustmentLegal session 23458退出0，证据`browser/r6-browser-1792881258098-6dbb0b`，4/4 PASS。实际选active=true的DV-0037，从冻结合法档位[40,46.99,50.97]取46.99，实际配置回读一致；仅新job=`tsk-b6ec45f0673b` SUCCESS、保存子plan=`PLAN-170c9b3a0c4a4f67b4ff8c80b15c441d` REFERENCE/code3001，快照SNP-PL-E22AEB00。真实必要通联/抗毁/中继及链路余量gap全部保留展示，未降低门槛、未确认；父V2最终GET仍current/result不变。旧tsk-aa60dc27b628 FAILED保留。

随后串行runPlanningComparison（传实际新child）session 2155退出1，证据`browser/r6-browser-1792881375543-6d0a80`，E-V01 FAIL。真实GET父子版本及POST /plans/compare均200/code0，两个原planId/同task/condition/resource和“方案横向对比”区域均已核对；失败在导出前expand“导出与复制任务条件”。JSON/XLSX尚未下载，不能记V通过；独立runPlanningReference未执行。没有新增job/plan/task/resource写，compare为只读POST。CLI/context均关闭、55324无监听，执行token已交回。

只读源码核实导出details原本就在.selected-plan内；问题是本组expand helper的filter(has)错误重复外层scope，导致在details内再找.selected-plan。E只将has内部定位改为相对candidate的page.getByText，仍严格要求唯一details；未改产品或断言门槛。该一行选择器修复为交权后的静态改动，未再次node --check或浏览器复验，V FAIL及原号全部保留，等待后续只读恢复授权。

主再给短token后，manual node --check通过，V复验session 65583退出1，证据`browser/r6-browser-1792881634480-bb4e18`。前一expand问题已越过；比较仍200/code0，后续getByLabel('格式',exact=true).selectOption超时，未发导出GET/未下载，独立REFERENCE未启动。已关闭context、55324无监听、交回token，无新计算/保存/确认。源码PlanExportDrawer的label嵌套select及option文本，不能假定其完整label恰为“格式”；E交权后静态改为可见“导出已保存方案”drawer内唯一原生combobox，保留count=1断言后选原json/xlsx值。未再次语法/浏览器复验，不改绿原FAIL。

主再次短token：manual node --check通过；runPlanningComparison session 22209退出1，证据`browser/r6-browser-1792881902358-33d817`，原FAIL保留。真实比较200/code0；JSON下载`E-V01-json.json`共1,086,035字节，并通过该格式快照断言。选择真实xlsx后下载事件90秒超时；已关闭DOM中抽屉明确显示`Cannot read properties of undefined (reading 'Workbook')`，不是本次combobox定位问题。只读源码定位`src/services/plan-export.ts:30`的`(await import('exceljs')).default`及`new Excel.Workbook()`为最小生产排查范围，未擅改生产。XLSX不得记通过。

失败即停止，独立REFERENCE未执行；无新计算/保存/确认/任务或资源写，仅比较只读POST。CLI/context已关闭、55324监听0，执行token已交回；未重试导出、未启动后续entry。父V2及实际A子plan原号保持。

主恢复后再次明确令牌，E未重做已失败的第三次V，仅独立执行runPlanningReference：session 72753退出0，证据`browser/r6-browser-1792882328299-55c7d1`，E-V02-reference-no-confirm 1/1 PASS、page_errors=0。CLI以已保存干扰REFERENCE `PLAN-3f42a59887ca463bbd732175995f7884`进入，经真实规划历史REFERENCE筛选/查询/打开后，实际核对同任务A子版本`PLAN-170c9b3a0c4a4f67b4ff8c80b15c441d`状态REFERENCE及转正按钮禁用；返回rejection=UI_DISABLED、server_409_tested=false，不冒称执行了服务端确认拒绝。没有新计算/保存/确认。退出后context已关闭、55324监听0，立即交回令牌；第三次V的XLSX真实失败保持。

主提示实际launcher后静态复核：`scripts/internal_workspace_frontend.mjs`使用configFile:false、optimizeDeps.noDiscovery:true，acceptanceDependencies未列exceljs；本轮实际`runtime/vite-cache/deps/_metadata.json`也没有exceljs项及对应预打包文件，先前node_modules/.vite并非本轮缓存。ExcelJS 4.4.0 package.browser指向dist/exceljs.min.js，入口UMD在浏览器赋值window.ExcelJS、无ESM导出。由该源码/缓存及抽屉undefined.Workbook错误可静态推导：未经预打包的原生import返回空namespace，.default不存在；未启动namespace运行探针，不冒称抓到了浏览器模块对象。两次实际export GET均200，JSON文件完整，XLSX预期为冻结快照工作簿、实际未生成下载，问题首先归属隔离launcher依赖预打包漏配，而非已证实的业务loader契约缺陷。

E未修改plan-export.ts及其测试，也未添加window全局fallback；主负责共享launcher将exceljs纳入acceptance include，并在C结束后只重启本轮.24前端。等待排队复验前不运行测试/浏览器/HTTP/计算或再次导出；旧33d817 FAIL及文件完整保留。

主已报告只改共享launcher acceptanceDependencies加exceljs并重启仅5324，runtime/vite-cache metadata已出现exceljs/needsInterop=true。E仅静态新增`runPlanningXlsxReadback`（E-V03-xlsx-existing-json），复用33d817原已下载JSON作为完整冻结基线，记录其原路径/字节数/SHA256；必须显式传原A子plan `PLAN-170c9b3a0c4a4f67b4ff8c80b15c441d`，严格核对task/job/input/condition/resource/parent/snapshot及REFERENCE状态。真实可见导出drawer内唯一combobox选xlsx，先等待下载再点一次；仍断言实际GET是format=json，随后浏览器ExcelJS编码，不冒称服务端XLSX端点。下载文件必须可读、完整快照按连续序号重组、完整plan逐项等于原JSON、来源/schema保留，人工输入/路由/指标/校验工作表存在；最后REFERENCE禁转正及父V2 current/来源未变，c.writes严格0。不再下载JSON或重复比较，不提交计算/保存/确认。

后续授权命令沿既有harness/runtime/Playwright，仅用`--group planning --entry runPlanningXlsxReadback --task-id r4-network-89db2499fcf6 --plan-id PLAN-170c9b3a0c4a4f67b4ff8c80b15c441d`。当前A独占令牌，E尚未对新entry执行nodecheck、测试、浏览器、HTTP或导出；生产及tests/plan-export.test.ts保持未改。旧FAIL与原下载文件不改绿，JSON已有通过和后续XLSX复验分别保留证据。

主随后明确授权完整runPlanningComparison一次，E先manual nodecheck退出0，再session 47538退出0；证据`browser/r6-browser-1792883072297-4ff0db`，E-V01-compare-json-xlsx 1/1 PASS、page_errors=0、86.911秒。父V2/实际A子plan比较200，JSON下载1,086,035字节（SHA256 df52c5846c501cf7da7f4e0dc4ff01710d0c151b615caf98bf45c77d3bbceabe），XLSX下载226,630字节（SHA256 98c13d39d67b05e08c7a3f73ca391289c1d16bc17aefe6d369c1ab54383b3147），两份冻结身份/来源/快照断言通过。业务请求仅POST /plans/compare，无新计算/保存/确认；context关闭、55324监听0后立即交回令牌。该结果支持仅修launcher预打包即可修复本轮导出，plan-export及测试一直未改；独立runPlanningXlsxReadback未执行，旧三轮FAIL保留。

交权后静态补FinalRefresh的父V2真实metrics基线及98.29不下降门禁，详见上方五步。新比较在E-F04保存验证和E-F05确认前均执行，差值仅允许1e-8百分点浮点容差，失败先保留对比anchors再停止；不调整input/资源/算法门槛。RECOVERY及取消硬版本检查未改。该最新FinalRefresh补丁未再执行nodecheck、测试、浏览器、HTTP或最终计算；此前nodecheck只覆盖补丁前源码，FinalRefresh执行授权仍未给。
