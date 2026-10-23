# 新版前端联调运行说明

本目录来自 2026-10-22 导入的新版前端及 MVT 道路改造包，是唯一开发与交付版本。旧目录与旧 HTML 已移入根目录 `old_front/`，停止维护，不再作为后端联调入口。当前使用构造联调数据，页面显示“构造联调数据 / 非生产、非实测”，完成项及缺口以仓库 `docs/design/12_后端接口实施进度.md` 和 `13_新版前端接口对照矩阵.md` 为准。

## 环境与文件

- 已验证环境：Windows PowerShell、Python 3.12.4、Node.js 20.20.1 / 24.19.0；前端依赖版本由 `package-lock.json` 固定。
- 后端入口为 `algorithm-service/app/main.py`，数据库迁移位于 `algorithm-service/migrations/`，当前迁移终点为 `0015_resource_device_changes`（0011 的实际 revision 为 `0011_integration_sessions`）。
- 数据库、测试产物及依赖缓存放在仓库 `data/runtime/`；Python 虚拟环境放在仓库 `.venv/`。
- 仓库 `data/synthetic/` 提供构造资源；算法地形读取 `data/raw/dem/dem_current.json` 与 `dem_current.bin.gz`。交接时须核对这两个地形文件及来源元数据是否齐全。
- 新版资源由显式初始化写入数据库不可变快照，交付入口不再从 CSV 逐次读取。初始化仍需要现有构造资料，DEM/地物文件继续独立使用，不得缺失。
- MVT 道路位于 `public/maps/demo-roads-tiles/`，含 `manifest.json` 和 9520 个 `.mvt` 文件。它们由前端静态服务提供，来源与许可见 `public/maps/ATTRIBUTION.md`。
- DEM 位于 `public/maps/sr4-terrain.json`、`sr4-terrain.png`，规划、诊断与 GIS 共用校验加载器。页面核对后端源哈希、范围、CRS 和实际图片哈希；诊断额外核对方案冻结地形指纹。缺失或错版时不套用当前地形，保留点线及提示；旧报告缺少 DEM 身份时需要新建诊断运行才能生成带身份的新快照，不修改旧报告。
- 图片哈希校验依赖浏览器 Web Crypto；本机 `127.0.0.1` 可使用 HTTP，非本机部署应提供 HTTPS，不能以关闭校验绕过安全上下文限制。
- `node_modules/`、`dist/`、失败安装目录和数据库不纳入源码交付；`tests/` 需要随源码保留。

## 首次安装

从仓库根目录执行。以下前端 `npm ci` 命令用于尚无 `node_modules` 的新检出目录；已有开发目录继续使用其依赖，先核对版本。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --cache-dir data/runtime/pip-cache -r algorithm-service/requirements-dev.txt
$env:npm_config_cache=Join-Path (Get-Location) 'data/runtime/npm-cache'
Set-Location front_design/radio-planning-20261022
npm ci
```

## 启动隔离后端

首次隔离验收可从仓库根目录初始化新数据库，迁移由 Alembic 执行。下面的随机库名只用于首次初始化；日常重启必须沿用已有 DATABASE_URL，不能反复新建空库。

```powershell
New-Item -ItemType Directory -Force data/runtime | Out-Null
$deliveryDatabaseName='delivery_'+[guid]::NewGuid().ToString('N')+'.sqlite'
$deliveryDatabasePath=Join-Path (Get-Location) ('data/runtime/'+$deliveryDatabaseName)
$env:DATABASE_URL='sqlite:///'+$deliveryDatabasePath.Replace('\','/')
.\.venv\Scripts\python.exe -m alembic -c algorithm-service/alembic.ini upgrade head
.\.venv\Scripts\python.exe -m alembic -c algorithm-service/alembic.ini check
.\.venv\Scripts\python.exe scripts/init_resource_dataset.py
$env:RESOURCE_DATASET_MODE='database'
$env:FRONTEND_INTEGRATION_DEMO='1'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8006
```

`GET http://127.0.0.1:8006/health` 与 `/health/database` 应返回 `code=0`。`FRONTEND_INTEGRATION_DEMO=1` 提供联调规划员、编辑者与审核者，不执行真实账户登录；正式认证和退出仍待实施。关闭并重开服务时，沿用同一 `DATABASE_URL` 才能回读该库的任务与版本。

默认规划员开放规划查看、执行、保存和确认，以及资源/态势查看；编辑者开放 SR5 场景/执行/导出、SR6 编辑，以及基础参数 `resources.device.edit` 和上下架 `resources.device.availability` 两项专项权限，没有整库 `resources.edit`；审核者开放只读查询、审核/发布/回滚。页头“联调身份”下拉框选择后点击“切换”，服务端校验 Cookie/CSRF 和权限，未保存输入先走离开保护。成功切换后从主导航或身份旁“知识图谱”进入 `/#/knowledge`；窄窗口导航换行，不应被挤出。无 Cookie 时默认规划员；已失效 Cookie 不能静默恢复为另一身份。未达标 `REFERENCE` 方案仍不能转正，资源过期也会拒绝确认。不开放清空历史操作。

## 启动新版前端

在第二个终端，从仓库根目录运行：

```powershell
Set-Location front_design/radio-planning-20261022
$env:VITE_BACKEND_PROXY_TARGET='http://127.0.0.1:8006'
npm run dev -- --mode integration --port 5184 --strictPort
```

开发时打开 `http://127.0.0.1:5184/#/planning`。`.env.integration` 设置 HTTP 模式及构造数据标识，`/api/v1` 通过 Vite 同源代理转发至后端。端口被占用时更换端口，并同步测试地址和代理目标。启动后先确认 `/api/v1/auth/session` 可以返回；本机曾有 Vite 启动后跨进程超时，原因未解决。日常验收优先使用下方已验证的静态同源 `5183`，避免混用服务或数据库。

### 静态构建同源预览

先执行 `npm run build -- --mode integration`。在已设置 `DATABASE_URL` 的终端中回到仓库根目录，执行唯一交付启动入口（当前常用地址为 `5183`）：

```powershell
$env:FRONTEND_INTEGRATION_DEMO='1'
.\.venv\Scripts\python.exe scripts/serve_delivery.py --port 5183
```

`http://127.0.0.1:5183/#/situation` 同时提供构建后的页面和同源 API，无需 Vite 代理。入口不挂载旧前端、不迁移或重置数据库；SQLite 必须为已存在文件的绝对路径。启动固定使用数据库资源，未初始化会明确失败，不回退旧 CSV。已有任务继续使用 `sqlite:///F:/work/project2026-1/data/runtime/sr56_integration_20261023.sqlite`，不要每次启动换新库。端口占用则先确认原进程，或显式改用新端口。正式部署的 Web 服务配置仍须单独确认。

### 已有数据库升级资源底座

先停止该库对应的服务并备份数据库，再在仓库根目录执行；不创建新库、不重建历史表：

```powershell
$env:DATABASE_URL='sqlite:///F:/work/project2026-1/data/runtime/sr56_integration_20261023.sqlite'
.\.venv\Scripts\python.exe -m alembic -c algorithm-service/alembic.ini upgrade head
.\.venv\Scripts\python.exe -m alembic -c algorithm-service/alembic.ini check
.\.venv\Scripts\python.exe scripts/init_resource_dataset.py
```

首次 `changed=true`，相同资料的版本仍为原来的 `resource-e4a642d6ea91744b`；再次执行为 `changed=false`，不会用磁盘文件覆盖数据库。不要手工改数据库 JSON；快照内容与来源清单校验失败会拒绝读取。0015 已接已有设备的功率、挂高和频率编辑，本批复用该版本/回执表完成单台和批量上下架；新增、端口/模式、导入导出及重置尚未开放。

修改原 CSV 或重新生成文件不会自动更新已初始化的交付资源；后续应通过经确认的版本化写入流程产生新版本，不能通过重复初始化覆盖当前版本。直接运行历史文件来源算法与新版交付入口是两种明确模式，不得混作同一次验收。

前批资源底座验证为后端 225、前端相关 123、同源真实 SR4 2 项及原 SR5/SR6 重启回读 1 项。0015 参数批后端全量 246 项、前端相关 287 项、类型检查及构建通过，现有库/空库迁移和模型检查通过；真实编辑、参数拒绝、重启回执与更新资源后的 SR4 保存确认通过。旧宿主测试有 navigator 和不完整超时响应替身两处失败，未擅自修改，不宣称前端全量通过。当时方案 `PLAN-780141e8dfc64ce3a7554bea74af33bf` 为 `CONFIRMED`，141 节点/166 链路；当前有效方案见后面的上下架批验证，构造数据结论不代替真实设备验收。

### 单设备参数维护测试

1. 打开 `http://127.0.0.1:5183/#/resources`，页头选择“联调编辑者”并点击“切换”；旧页面需要刷新以重新读取权限。
2. 选择一台已有设备，点击“编辑设备参数”，核对设备编号、所属节点、型号及功率/频率限制。
3. 修改挂高、功率或工作频率，点击“保存当前设备”。频率可清空；功率和挂高不可空，超限或无效输入返回失败并保留输入。
4. 保存成功显示“设备已保存”，刷新台账；重新打开、刷新浏览器或重启同一库服务后应回读保存值。重复发送原请求只返回原回执。
5. 进入 GIS 时读取同版资源。旧任务/方案因全局资源换版而要求重新保存与计算；不自动修改历史，不执行真实设备配置下发。

参数批验收保留 DV-0001 挂高 16.6→16.85→17.1 m 的两个历史版本，参数批资源为 `resource-ae42003d8fbfce0b`，原 CSV 未改。随后上下架批产生新资源版本，但挂高仍为 17.1 m。旧方案不再被描述为来源未变化；重新规划的原始快照已核对该设备挂高。参数批截图与原请求/回执在仓库 `data/runtime/browser_device_changes_20261023/`，数据库升级前备份为 `data/runtime/sr56_before_device_changes_20261023.sqlite`。这些运行产物不纳入源码提交。

### 单台与批量上下架测试

1. 切换为“联调编辑者”，在设备台账勾选当前页 1–50 台设备，点击“批量下架”或“批量启用”；也可打开设备详情，点击“下架设备”或“启用设备”。
2. 阅读服务端预览和影响提示。取消不提交；确认后整批保存，返回成功变更与无变化计数。设备缺失、旧版本或越权会明确拒绝，不保留部分写入。
3. 在“更多筛选 → 在架状态”选择“已下架”，核对服务端全库匹配数和当前页。下架状态独立于运行状态，不会自动把“正常”改成“故障/离线”。
4. 新规划排除下架设备；指定下架端点、任务参与节点无在架设备时，任务校验/保存/提交返回错误。任务内容不变但资源已换版时，也必须重新保存再规划。
5. 启用设备后保留设备 ID、参数和历史，但不会使旧方案自动恢复有效。重复启用已在架设备应显示“无变化”，不产生新资源版本。请求结果未知时重试原请求；迟到重放旧下架请求不会再次改变当前状态。

本批备份为 `data/runtime/sr56_before_availability_20261023.sqlite`；没有新增表，迁移终点仍为 0015。真实验收已临时下架 DV-0001/0002，在下架状态生成的方案 `PLAN-8405dc9b4fc94a6e86dfa3556543c361` 为 141 节点/165 链路，原始结果与绑定均不含两设备。随后已全部恢复在架，当前资源 `resource-f82ea3157ad8d95b`；恢复后的有效方案为 `PLAN-505ad2d25bfd4c04bd0d1b7afff766c2`，141 节点/166 链路、CONFIRMED。重启同库及旧请求/无变化请求重放通过，原文件未改。截图和回执位于 `data/runtime/browser_availability_20261023/`。

本批后端全量 270、前端相关 314 项通过，类型检查及构建通过；两轮真实 SR4 HTTP 各 2 项通过。额外复测资源读取旧测试为 34 项通过、1 项超时替身缺少 headers 失败；前批路由宿主 navigator 缺失问题也仍在记录中，不宣称前端全量通过。规划员/审核者写入口禁用、确认对话框 8 次位置采样稳定及 390 宽视口检查通过；这不等于全部移动端业务验收。

页面检查顺序：

1. 新建任务，选择节点与通联需求，点击“保存任务”，确认显示服务端返回的输入版本。
2. 从任务列表重新打开，核对名称、条件和版本；修改后保存，确认生成新版本。
3. 点击“提交规划”，核对作业编号和阶段进度，完成后检查指标、节点、链路及约束结论。
4. 点击“规划历史”，在“作业记录”中搜索刚才的任务并打开，核对冻结输入与结果。
5. 在“方案调整与对比”中保存方案，从方案列表重新打开并核对版本、配置；达标且来源未变化时点击“转正并设为当前方案”，核对“已转正 · 当前方案”。参考方案不得转正。
6. 打开“规划历史 → 已保存方案”，按保存名称、方案/任务/作业编号搜索，选择状态后点击“查询”，再“打开方案”。核对任务、版本和结果快照与保存时一致；取消未保存输入的处理应保留现场，读取失败应在目录显示错误。
7. 切换“联调编辑者”，进入 `/#/diagnosis`。新建场景并选择刚确认的网络，通过表单或 GIS 设置 NODE/DEVICE/LINK 故障，也可下载 CSV/XLSX 模板、预检并提交导入；保存后应显示服务端场景版本。
8. 点击执行，页面先提交诊断并轮询，再单独提交影响分析并轮询。检查两个不同任务编号、诊断依据、影响节点/链路、建议和完整报告；从历史重新打开及取消未完成运行。未提供的影响面、传播路径和状态不能被编造成已知数据。
9. 完成后分别下载 JSON/DOCX/PDF 报告和 XLSX/PNG 影响资料；从报告跳转 GIS 检查同一冻结网络、故障位置与地形。旧报告缺地形身份或地形错版时应提示，不显示其他 DEM。
10. 在有已观察症状的诊断结论上点击“知识反馈”，人工填写确认根因、部件、处置及检查步骤，提交后跳转 SR6 草稿。也可在 `/#/knowledge` 手动维护实体、关系、设备原理或组网说明。
11. 编辑者保存、送审；自审必须失败。切换“联调审核者”，打开同一变更审核，通过后单独发布。检索新版本应看到变更，旧版本及旧报告保持原样；回滚须填写原因并生成新版本，发布历史仍能打开。

已保存历史只读取当前联调数据库，不混入两份旧前端演示快照，也不读取旧算法 JSON 目录。新链接为 `/#/planning?history=saved`，旧 `history=references` 链接进入同一目录。该全局目录仅供显式构造联调，不代表正式账户之间的数据隔离。

进入地图后应看到 DEM 地形，MVT 道路和站点、链路仍在地形之上；地形错版或损坏时应显示错误，不展示旧图。以上是人工验收步骤，不代表本机已完成浏览器点击和视觉验证。

## 自动化验证

在后端与代理已运行后，从本目录执行：

```powershell
npm run typecheck
npm run build -- --mode integration
$env:PLANNING_DELIVERY_URL='http://127.0.0.1:5183'
$env:PLANNING_DELIVERY_ISOLATED='1'
npm test -- tests/planning-delivery-smoke.test.ts --reporter=dot
```

冒烟测试使用实际会话、任务和规划 HTTP 适配器，会从同源静态服务下载并校验 DEM，在隔离库创建任务、校验版本冲突、运行真实 SR4，再保存、列表/详情回读和确认方案，并验证幂等回放和错误版本拒绝。单次规划最多等待 300 秒；输出 `SR4_RESULT` 含任务、作业、方案编号及确认状态。本构造预设必须得到 `outcome=0` 才能通过整组成功流，不能放宽硬约束。未设置 `PLANNING_DELIVERY_URL` 时该组测试跳过；通过测试桩的结果不算真实服务验证。必须使用提供 `maps/` 和 API 的同源地址；裸后端 `8006` 不提供地形静态文件，不能直接跑此整组测试。

冒烟测试还验证：保存后在 `SAVED` 历史中可检索；确认后在 `CONFIRMED` 中可检索、在 `SAVED` 中不再命中；从历史摘要打开的详情与原结果快照一致。历史页面及 HTTP 定向回归可单独执行：

```powershell
npm test -- tests/planning-plan-history-http.test.ts tests/planning-plan-history-entry.test.ts tests/planning-guidance-entry.test.ts --testTimeout=30000 --maxWorkers=1
```

既有引导测试在默认 5 秒上限和并行负载下曾超时；当前串行、30 秒单用例上限通过，不作为默认全量前端测试全部通过的证据。

后端回归从仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests algorithm-service/tests/test_planning_job_history_api.py algorithm-service/tests/test_planning_plan_history_api.py -q
```

### SR5/SR6 定向及真实 HTTP 验证

```powershell
npm test -- tests/http-client.test.ts tests/integration-identity-http.test.ts tests/diagnosis-http.test.ts tests/knowledge-http.test.ts tests/sr5-sr6-integration.test.ts tests/terrain-workspace.test.ts tests/workspace-stability.test.ts tests/terrain-basemap.test.ts tests/planning-terrain-entry.test.ts --testTimeout=30000 --maxWorkers=1
$env:SR56_DELIVERY_URL='http://127.0.0.1:5183'
$env:SR56_DELIVERY_ISOLATED='1'
npm test -- tests/sr5-sr6-delivery-smoke.test.ts --testTimeout=480000 --maxWorkers=1
```

`5183` 为当前静态同源预览入口，数据库为项目内 `data/runtime/sr56_integration_20261023.sqlite`。不要对生产库运行冒烟测试。测试会产生真实算法输出和持久化构造记录，不自动删除；输出 `SR56_RESULT` 包含方案、运行、变更与知识版本编号。

重启同一库的服务后，仅运行回读用例，不再次生成规划：

```powershell
$env:SR56_REOPEN_RUN_ID='<SR56_RESULT.runId>'
$env:SR56_REOPEN_VERSION_ID='<SR56_RESULT.published>'
npm test -- tests/sr5-sr6-delivery-smoke.test.ts -t '重启回读' --testTimeout=60000 --maxWorkers=1
```

本批真实 HTTP 已验证完整两段诊断、DEM 字节校验、模板及五种文件格式、人工反馈、独立审核发布、回滚和重启回读。尺寸回调测试使用内存宿主，不等同浏览器尺寸与抖动验收。旧前端相关回归 342 项通过，1 项因 Node 宿主缺少 `navigator` 失败；不得登记为前端全量通过。

## 资源台账导出与筛选

资源台账现有“导出”抽屉已接入服务端预检及文件接口，支持 CSV 单表、XLSX 多表，以及全部、全部筛选结果、当前页勾选设备。XLSX 同时选择站点表时补齐设备所属站点及父级；不包含未保存输入。筛选按完整资源集执行，不只作用于当前页。文件名及 XLSX 说明表标明构造联调来源，非生产、非实测。

本批隔离页面为 `http://127.0.0.11:5311/#/resources`，代理 API `http://127.0.0.11:8111`；只连接 P01 工作树自身的 `data/runtime/collab.sqlite`，不要将地址改为主运行 5183。使用规划员可查看和导出；切换身份继续沿用服务端会话与 CSRF 校验。

```powershell
npm test -- tests/resource-export-http.test.ts tests/resource-read-http.test.ts tests/http-client.test.ts --maxWorkers=1
$env:RESOURCE_EXPORT_URL='http://127.0.0.11:5311'
$env:RESOURCE_EXPORT_ISOLATED='1'
npm test -- tests/resource-export-live.test.ts --maxWorkers=1
```

真实 HTTP 3 项通过；Edge 无头页面点击已验证 414 行全量 CSV、174 行 HF 筛选 CSV 和 1 台选中设备 XLSX（补齐 1 节点），截图和文件在 P01 工作树 `data/runtime/browser_export_1792747304085/`。版本变化返回 `RESOURCE_VERSION_CHANGED`，需刷新后重新预检。GIS/观测专用导出、资源导入和新增设备仍未接入，不因台账导出完成而开放。

## 构建与交付边界

`npm run build -- --mode integration` 生成静态 `dist/`。Vite 开发代理不随静态文件发布，部署时须由 Web 服务将 `/api/v1` 转发到运行中的后端，并提供 `maps/` 等静态资源；直接双击 HTML 无法完成业务调用。构建配置保留已有输出文件，打正式包时应使用新的输出目录，例如 `npm run build -- --mode integration --outDir dist/delivery-20261022`，避免将旧哈希资源一并交付。

当前仍有以下交付缺口：

- 新版 GIS/规划/诊断的 DEM 显示与 GIS 道路开关已通过本机浏览器检查；1280×720 四页各 10 次、1440×1000 GIS 8 次空闲采样位置/滚动稳定且无循环请求。未覆盖的操作、浏览器与平台仍需验收。
- 数据库方案历史、SR5/SR6 主流程已接入；旧兼容全量工作区聚合不是新版主页面验收入口。工作区重置、多项 GIS 资源编辑、频谱/干扰业务适配和系统管理仍有缺口，详见矩阵，不把当前 99 处占位统计当独立接口数。
- 联调身份不能替代正式认证、退出、设备下发、状态上报或真实观测能力。编辑者与审核者分离只用于显式联调。
- 后端依赖目前使用版本区间，麒麟环境的依赖锁定、离线安装包与平台兼容性仍需单独验证。
- 本批已使用现有 Playwright/Edge 无头验证任务整行/按钮打开、两个联调身份图谱入口、实体详情与子图及地图像素非空；截图见仓库 `data/runtime/browser_gis_20261023/`。最终后端全量 203、前端相关 16 文件 123 项与构建通过；前端全量、全部写操作浏览器闭环和麒麟部署不在此证明范围。

已确认方案、数据来源、正式部署平台与外部设备协议按项目已确认口径验收，构造联调闭环不替代真实数据和最终交付验收。
