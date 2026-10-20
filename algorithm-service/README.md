# Python 算法服务

本服务提供 SR-4 规划、SR-5 故障诊断、SR-6 知识支撑及资源查询接口。入口为 `app.main:app`，OpenAPI 文档由 FastAPI 在 `/docs` 提供。

## 安装与启动

```bash
python -m pip install -r algorithm-service/requirements.txt
python -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8000
```

## 数据库与迁移

数据库基础设施采用 SQLAlchemy 2.x 同步模式、Alembic 和 psycopg 3，目标数据库为 PostgreSQL/PostGIS。`0001_baseline` 是空迁移；`0002_task_input_persistence` 建立规划任务、不可变输入版本和保存回执三张表；`0003_planning_jobs` 建立版本化规划作业表；`0006_planning_job_cancellations` 记录取消请求及其处理结果；`0007_planning_plan_raw_snapshot` 保存父方案原始拓扑。现有 CSV/JSON 数据不会自动迁移。

应用只从 `DATABASE_URL` 环境变量读取连接地址，不在仓库中保存真实凭据。可参考 `algorithm-service/.env.example`，在 PowerShell 中设置：

```powershell
$env:DATABASE_URL="postgresql+psycopg://radio_user:password@127.0.0.1:5432/radio_planning"
```

迁移命令均从仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini history
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini current
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini upgrade head
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini downgrade -1
```

后续模型确认后，可生成新的迁移草稿：

```powershell
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini revision --autogenerate -m "add core tables"
```

自动生成的迁移必须人工检查后再执行。正式环境不得使用 `Base.metadata.create_all()` 代替 Alembic。普通健康检查为 `GET /health`；数据库连接检查为 `GET /health/database`，后者执行 `SELECT 1`，数据库未配置或不可用时返回 HTTP 503。

### 首个数据库业务接口

本地演示可将数据库放在仓库 `data/runtime/` 下，并从仓库根目录运行迁移和服务：

```powershell
$env:DATABASE_URL="sqlite+pysqlite:///data/runtime/task_input_demo.sqlite"
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8000
```

若 `8000` 已被占用，可将启动命令中的端口改为 `8001`，并同步替换以下访问地址中的端口。

打开 `http://127.0.0.1:8000/docs`，调用 `PUT /api/v1/task-inputs/{task_id}`。例如首次使用 `task_id=DEMO-001`，请求正文为：

```json
{
  "context": "planning",
  "task_id": "DEMO-001",
  "expected_revision": null,
  "resource_revision": "r1",
  "request_id": "save-DEMO-001-001",
  "input": {
    "name": "测试通信任务",
    "description": "接口验证",
    "bbox": [113, 36, 116, 39],
    "stationIds": ["N1", "N2"],
    "presetId": "P1",
    "frequencyId": "F1",
    "startTime": null,
    "durationH": null,
    "constraints": {"connectivityPercent": 100, "maxRelayHops": 2, "survivabilityPercent": 90},
    "demands": [{
      "id": "D1", "sourceId": "N1", "targetId": "N2",
      "endpointMode": "station", "sourceDeviceId": null, "targetDeviceId": null,
      "preferredClass": null, "service": "数据", "priority": "P1",
      "mandatory": true, "dataVolumeMb": 10, "requiredRateKbps": 64,
      "maxDelayMs": 100, "minReliability": 0.95
    }]
  }
}
```

也可用 curl 调用，将上述 JSON 放入本地 `request.json`（此文件无需加入版本库）：

```bash
curl -X PUT 'http://127.0.0.1:8000/api/v1/task-inputs/DEMO-001' \
  -H 'Content-Type: application/json' --data-binary @request.json
```

成功响应的 `data` 含 `task_id`、`revision`、`input_version`、`condition_version`、`resource_revision`、`input`、`updated_at` 和 `active_job_id`。再次保存同一任务时，`expected_revision` 填上次返回的 `revision`，并换一个 `request_id`；相同请求编号及内容重复提交会返回原版本。版本不一致或请求编号被不同内容复用时返回 HTTP 409。保存接口不单独确认资源版本是否仍为当前版本；提交 SR4 时会同时校验任务、输入、条件和当前资源版本。`active_job_id` 目前仍返回 `null`；前端登录态联调需后续接入认证服务。

### 提交版本化 SR4 作业

任务保存成功后，将返回的版本字段原样传给 `POST /api/v1/plan/sr4-flow`：

```json
{
  "context": "planning",
  "request_id": "submit-DEMO-001-001",
  "task_id": "DEMO-001",
  "expected_revision": "TREV-替换为保存结果",
  "input_version": "TREV-替换为保存结果",
  "condition_version": "TCOND-替换为保存结果",
  "resource_revision": "resource-替换为保存结果",
  "parent_plan_id": null
}
```

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/plan/sr4-flow' \
  -H 'Content-Type: application/json' --data-binary @sr4-submit.json
```

成功返回 HTTP 202，`data` 含 `job_id`、冻结的输入及三个版本号、`PENDING/RUNNING` 状态、进度和阶段列表。相同 `request_id` 与相同内容重复提交返回原作业；请求编号复用、任务版本变化、资源版本变化或同任务已有运行作业时返回 HTTP 409。当前支持三个基础预设和任务需求、连通率、最大中继跳数及抗毁性约束；频率过滤和部署高级条件仍明确返回不支持，不会静默忽略。

该接口启动真实 SR4 算法并把作业状态写入 `planning_jobs`。前端使用提交响应中的 `job_id`、原任务编号和固定上下文查询进度：

```bash
curl 'http://127.0.0.1:8000/api/v1/plan/tasks/tsk-替换作业编号?context=planning&task_id=DEMO-001'
```

`PENDING/RUNNING` 返回 `code=2002`，`data` 仍是完整作业对象，含冻结输入、三个版本号、进度和阶段；前端继续轮询。成功结果把原始 SR4 方案转换为节点、设备、链路、主备路由、频率、电台参数、指标和四类校验项。方案未满足硬约束时返回 `code=3001`，但 `status=SUCCESS` 且保留 `result`、`outcome.gap` 和建议，前端不得把有效参考方案丢弃。SR4 全流程暂未生成覆盖栅格或等值面，查询结果中的覆盖字段为 `null`，不会用构造图层冒充计算结果。

不带 `task_id` 查询参数时，端点继续返回原路由、频率、电台参数和方案校验异步任务的旧结构。数据库记录仍为运行中但内存任务在服务重启后消失时，新版查询会把作业标为 `FAILED` 并提示重新提交，避免页面永久停留在计算中。

### 基于已保存方案调整单台设备和主路径

先完成一次基础 SR4 作业并调用 `POST /api/v1/plans` 保存方案。再次提交同一任务时，将 `parent_plan_id` 改为已保存的父方案编号，并添加如下 `adjustment`；其余版本字段与普通提交相同，`request_id` 使用新编号：

```json
{
  "parent_plan_id": "PLAN-替换为父方案编号",
  "adjustment": {
    "schema_version": 1,
    "source_plan_id": "PLAN-替换为父方案编号",
    "source_snapshot_id": "SNP-PL-替换为父方案快照编号",
    "manual_override": [{"device_id": "DV-0001", "tx_power_dbm": 43.01}],
    "manual_paths": [{"demand_id": "CD-0001", "node_path": ["ND-0001", "ND-0002"]}]
  }
}
```

两个数组可为空；单条设备调整至少填写功率或挂高之一。设备编号必须来自父方案 `result.configuration.devices`，功率须匹配型号档位（允许源数据小数舍入差 0.051 dBm），挂高须在平台范围内。基础方案把每个网系在各端绑定到一台物理电台：同一网系的链路共享该电台，不同网系不共用；数量不足时方案标为不可行。已冻结的父方案节点、设备、链路及链路两端设备绑定不会因调整改变。算法按设备重算功率、链路余量、路由、频率、方案校验和干扰结果；未参与链路的设备仍可调整，但不影响链路余量和总辐射功率。人工主路径必须由父方案现有链路组成；设备级需求的主路由端点仍须使用任务指定设备。作业查询和保存的子方案均回显 `parent_plan_id` 与 `adjustment`，返回的设备参数和人工主路径与提交值逐项一致。

旧方案若没有完整原始设备绑定，提交调整返回 HTTP 409 / `1203`，需重新运行并保存基础方案。任务条件、资源版本或地形数据已变化时返回 HTTP 409；功率或挂高越界、人工路径在实际路由图中不可用时，异步作业返回 `FAILED` 和具体错误。基础方案优化器仍以台站级模型搜索，最终输出和约束结论以绑定后的设备级闭环复算为准；权衡曲线仅作搜索阶段参考。

### 取消版本化 SR4 作业

提交接口返回 `job_id` 后，前端可调用 `DELETE /api/v1/tasks/{job_id}`。请求中的版本号是该作业绑定的输入版本，即使任务后来保存了新版本也不改变：

```json
{
  "context": "planning",
  "request_id": "cancel-DEMO-001-001",
  "task_id": "DEMO-001",
  "expected_revision": "TREV-替换为作业输入版本"
}
```

接口核对作业归属及冻结版本，返回完整作业对象。运行中作业转为 `CANCELLED`，同一请求编号和内容重复提交返回当前终态；编号复用且内容变化返回 `1204`。已完成的 `SUCCESS/FAILED` 作业保持原状态，成功作业仍返回已有结果。取消采用单进程内协作式检查点，不能中断正在执行的单个耗时算法步骤；运行线程会在下一检查点退出。跨进程执行或服务重启后的运行线程不支持远程中断，数据库中已取消的终态仍可查询。

### 查询规划写操作回执

写请求超时后，保留原 `request_id`，按任务和操作类型查询，不要直接换新编号重试：

```bash
curl 'http://127.0.0.1:8000/api/v1/planning-operations/save-001?context=planning&task_id=DEMO-001&kind=saveTask'
```

`kind` 可为 `saveTask`、`submit`、`cancel`、`savePlan`、`confirm`。`data` 含 `request_id`、`task_id`、`kind`、`state`、`entity_id`、`message`；已持久化的写入返回 `SUCCEEDED` 及任务、作业或方案编号，未找到返回 `NOT_FOUND`。作业后来运行失败不改变“提交请求已被处理”的回执状态，应继续查询作业结果。当前失败写请求没有独立的持久化回执，因此不能仅凭查不到记录推断具体失败原因。跨任务、类型或场景查询返回 HTTP 409 / `1204`，不返回其他任务的实体编号。

### 任务列表、详情与只读校验

任务库按当前输入版本分页，支持 `context=planning|gis`、`page`、`page_size=5|10|20|50` 和 `search`（任务编号或名称）；详情仅回读对应场景的当前版本。两者均返回最近一次持久化规划作业编号 `active_job_id`，不存在时为 `null`。

```bash
curl 'http://127.0.0.1:8000/api/v1/task-inputs?context=planning&page=1&page_size=10&search='
curl 'http://127.0.0.1:8000/api/v1/task-inputs/DEMO-001?context=planning'
```

`POST /api/v1/task-inputs/validate` 使用与保存接口相同的 `context`、`task_id`、`expected_revision`、`resource_revision` 和 `input`，但不需要 `request_id`。返回 `valid`、`issues` 和当前 `task`（不存在时为 `null`），用于导入预览及保存前检查；`expected_revision` 不阻止读取最新任务，最终并发冲突仍由保存接口判定。校验只核对输入结构与当前节点、设备、通视引用，不运行 SR4；资源版本已变化返回 HTTP 409 / `1205`。历史任务读取不因当前资源变化而改写原输入。

### 保存并读取方案版本

作业成功后可把完整结果保存到数据库。`expected_revision` 使用作业查询返回的 `revision`：

```json
{
  "context": "planning",
  "request_id": "save-plan-DEMO-001-001",
  "task_id": "DEMO-001",
  "expected_revision": "TREV-替换为作业结果",
  "job_id": "tsk-替换为作业编号",
  "name": "太行山区规划方案 V1",
  "note": "初次计算结果"
}
```

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/plans' \
  -H 'Content-Type: application/json' --data-binary @plan-save.json
curl 'http://127.0.0.1:8000/api/v1/plans?context=planning&task_id=DEMO-001&page=1&page_size=10'
curl 'http://127.0.0.1:8000/api/v1/plans/PLAN-替换方案编号?context=planning&task_id=DEMO-001'
```

达标结果保存为 `SAVED`；未满足硬约束但有完整结果，或保存时资源版本已经变化的结果保存为 `REFERENCE`。同一 `request_id` 和相同内容幂等返回原方案，同一作业当前只允许保存一次。保存后作业查询的 `saved_plan_id` 返回方案编号。带 `task_id` 的列表和详情使用前端版本化契约；不带 `task_id` 时继续读取原算法方案文件。

确认版本化方案时，请求体如下：

```json
{
  "context": "planning",
  "request_id": "confirm-plan-DEMO-001-001",
  "task_id": "DEMO-001",
  "expected_revision": "TREV-替换为方案输入版本"
}
```

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/plans/PLAN-替换方案编号/confirm' \
  -H 'Content-Type: application/json' --data-binary @plan-confirm.json
```

只有来源版本未变化的 `SAVED` 方案可以首次确认。成功响应返回完整方案，状态为 `CONFIRMED`，`current=true` 且 `confirmed_at` 非空；同一任务此前的当前方案保留为历史，回读时 `current=false`。相同 `request_id` 与相同内容幂等返回；请求编号被不同内容复用返回 `1204`，输入版本不一致返回 `1203`，资源版本变化返回 `1205`，`REFERENCE` 或已不再是当前方案的历史确认版本返回 `3001`。同一路径不带请求体时仍执行旧算法文件确认逻辑。

版本化方案对比请求如下：

```json
{
  "context": "planning",
  "task_id": "DEMO-001",
  "solution_ids": ["PLAN-方案一", "PLAN-方案二"]
}
```

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/plans/compare' \
  -H 'Content-Type: application/json' --data-binary @plan-compare.json
```

一次只能对比同一任务、同一冻结任务条件和资源版本下的 2–4 个不同方案，`SAVED`、`REFERENCE` 和 `CONFIRMED` 均可参与。响应 `data` 按 `solution_ids` 的请求顺序返回完整方案数组，包含部署、路由、频率、参数、指标、检查项和当前方案标记。方案不存在或不属于当前任务返回 `2001`；数量、重复编号或冻结条件不满足要求返回 `1001`。只传旧格式 `solution_ids` 时仍返回旧算法摘要。

版本化方案导出从数据库冻结快照读取，不回读算法运行文件：

```bash
curl 'http://127.0.0.1:8000/api/v1/plans/PLAN-替换方案编号/export?context=planning&task_id=DEMO-001&format=json'
curl -o plan.xlsx 'http://127.0.0.1:8000/api/v1/plans/PLAN-替换方案编号/export?context=planning&task_id=DEMO-001&format=xlsx'
```

`format=json` 返回标准接口包络中的完整 `ApiPlan`，供现有前端校验后在浏览器生成用户选择的文件；`format=xlsx` 直接返回服务端工作簿，包含方案概要、任务输入、通联需求、节点、设备、链路、部署、路由、频率、指标、检查项和完整 JSON 快照。版本化接口只接受 `json`、`xlsx`，方案不存在或不属于任务返回 `2001`，参数或格式错误返回 `1001`。不带 `context` 和 `task_id` 时继续使用旧算法 JSON/CSV/XLSX 导出行为。

SR-5 场景及报告默认保存在 `data/runtime/`，可通过 `SR5_STORE_PATH` 和 `SR5_REPORT_DIR` 指定位置。SR-4 方案保存在 `data/runtime/plans/`（`SR4_PLAN_DIR`）；已完成的异步任务保存在 `data/runtime/tasks/`（`ALGORITHM_TASK_DIR`）；覆盖结果和覆盖任务分别保存在 `data/runtime/coverage/`（`COVERAGE_CACHE_DIR`）和 `data/runtime/coverage_tasks/`（`COVERAGE_TASK_DIR`）。运行中的任务在服务重启后不能恢复计算，须重新提交。运行目录已加入 `.gitignore`；正式部署时应配置持久卷并备份。当前持久化仅适用于单进程服务，多进程或多实例部署需另行设计共享存储。

SR-6 三类知识图谱接口位于 `/api/v1/kg/*`，包含统计、实体/设备查询、模糊检索、子图/路径查询、按症状推理、链路状态评估、变更提交/审核、版本查询与回滚。`GET /api/v1/kg/triples` 可按 `graph`、`relation`、`source`、`entity` 追溯三元组；`GET /api/v1/kg/quality` 检查悬空实体、重复关系、缺失来源、关系类型约束和故障案例知识完整性。首版图谱由构造的设备台账、拓扑、链路状态及故障案例构建；`GET /api/v1/kg/stats` 返回各域规模和 `sr4_plan_validated=false`。链路状态规则使用构造记录挖掘，不能作为真实链路诊断准确率。故障推理结果有 `source_doc`，命中数仅用于排序。

SR-6 审核后的图谱、待审核变更与版本快照保存在 `data/runtime/sr6_graph.json`，可用 `SR6_STORE_PATH` 更改，正式部署需持久卷及备份。当前审核者仅是请求中的标识，不具备身份认证；正式环境必须由 Java 主服务或网关限制写入、审核和回滚接口。现有 SR-4 测试方案有频率冲突，不作为 SR-6 的正常运行态势基准。

`GET /api/v1/kg/audit` 可查询最近的变更日志。新增知识须先提交到 `/api/v1/kg/updates`，再由 `/api/v1/kg/updates/{change_id}/review` 审核发布；回滚通过 `/api/v1/kg/versions/{version}/rollback` 执行。

故障图谱的已审核变更会用于后续 SR-5 图谱分支诊断与处置建议，回滚后恢复旧知识。240 条构造案例的原始 CSV 有 2022 条故障关系，其中 960 条是有序诊断步骤；运行图谱另补 240 条案例关联、240 条故障类型和 240 条对象类型关系，故障域合计 2742 条。旧版已保存图谱首次加载时会迁移并生成新版本。链路状态数值门限可通过 `set_link_rule` 变更操作审核发布，字段为 `rule_id`、`threshold_value`（原始物理单位）和 `source`，重启及回滚均会同步评估器；普通三元组变更不修改数值门限。所有变更仍基于合成数据，未经过真实设备校准。

## SR-5 联调流程

正式规划方案模式先调用 `GET /api/v1/fault/plan-sources?task_id={task_id}`。只有数据库中该任务当前 `CONFIRMED`、资源版本未变化且带完整冻结拓扑的 SR4 方案可选；无可选方案时查看 `data.reason`，不退回合成基线。诊断请求示例：`{"context":"planning","task_id":"TS-0001","plan_id":"PLAN-0001","scenario_id":"FS-0001"}`，仍提交到 `POST /api/v1/fault/diagnose` 并轮询原任务查询接口。影响分析调用 `POST /api/v1/fault/impact`，传 `diagnose_task_id`、同一 `task_id` 与 `plan_id`；服务端使用诊断时的场景和原方案版本，当前方案切换不改变既有诊断。现有场景增删改校验仍依赖构造台账，暂不能对任意新规划节点完成场景录入；外包前端 HTTP 页面尚未接入本模式。

以下步骤保留旧文件方案和合成基线的算法演示用法。若请求携带 `task_id` 或 `plan_id`，必须显式设置 `context=planning`，否则返回参数错误。

1. `GET /api/v1/fault/scenarios` 获取五个合成示例；也可先调用 `POST /api/v1/fault/scenarios/validate`，再保存场景。
2. `POST /api/v1/fault/diagnose` 传 `scenario_id`，取回 `task_id`。
   无预设故障类型的观测可调用 `POST /api/v1/fault/diagnose/observations`，请求体传 `faults[]`（每项含 `object_type`、`object_id`、`symptom_ids`，可选 `params`；不得含 `fault_type`）。该入口只用于诊断，不生成可供影响分析引用的场景。
3. `GET /api/v1/fault/tasks/{task_id}` 查询诊断结果。现有案例全部为构造数据，结果标记 `TWO_WAY_DEGRADED`，ML 分项带停用原因。
4. `POST /api/v1/fault/impact` 传 `diagnose_task_id`，再查询任务结果。缺省使用仓库的合成拓扑；若诊断时指定有效的 `network_solution_id`，使用对应 SR-4 全流程方案。
   `GET /api/v1/fault/impact/{task_id}/nodes?node_role=...&region=...` 可按节点角色和区域筛选受影响节点；等级为 `SEVERE`、`MODERATE`、`MINOR`。图层仍只表示节点位置，不表示覆盖边界。
5. `GET /api/v1/fault/suggestions?diagnose_task_id=...&impact_task_id=...` 获取建议；`POST /api/v1/fault/report` 生成 JSON、DOCX 或 PDF 报告，按返回的 `report_url` 下载。
6. 人工研判后调用 `POST /api/v1/fault/diagnoses/{task_id}/feedback`，传 `reviewer`、`result_index`，可选修正 `confirmed_fault_type`、`root_cause`、`fault_component`、`solution`、`diagnosis_steps`。反馈只进入 SR-6 待审核队列；知识管理员通过 `/api/v1/kg/updates/{change_id}/review` 审核发布后，新案例才参与后续图谱诊断。当前 `reviewer` 尚未接统一鉴权，因此来源标记为 `UNAUTHENTICATED_REVIEW`，不能等同真实案例验证。

`POST /api/v1/fault/scenarios/import` 支持 `multipart/form-data` 上传 CSV/XLSX，也支持 JSON 批量提交。表格至少包含 `scenario_name` 和 `faults` 两列，其中 `faults` 是 JSON 数组文本。影响结果可通过 `GET /api/v1/fault/impact/{task_id}/export?format=xlsx|png` 导出。

现有知识图谱从合成案例派生，图层返回受影响节点的坐标点，不推断未经数据支持的地理受影响面。融合得分仅用于合成场景的候选排序；出现证据不足或多个同样受支持的根因时，结果与处置建议均要求人工复核。
影响结果的 `planning_check_passed` 保留上游 SR-4 方案的校验状态；若为 `false`，该次影响分析仅用于方案诊断和演示。
`POST /api/v1/plans/{solution_id}/confirm` 仅接受通过全流程校验的 SR4_FLOW 方案或标记为可行的 NETWORK_OPTIMIZE 方案；当前含频率冲突的实跑方案不能确认。
方案导出支持 JSON、CSV 和 XLSX。异步任务目前只支持轮询，非空 `callback_url` 会返回 `1001`；回调地址、签名与重试协议仍需联调确认。

## 首个前端任务保存联调

该联调入口使用固定身份，只用于本地验证“网络规划 → 保存任务”，不属于正式认证实现。数据库和运行文件均放在项目目录下。PowerShell 启动命令如下：

```powershell
$env:DATABASE_URL="sqlite+pysqlite:///data/runtime/task_input_demo.sqlite"
$env:FRONTEND_INTEGRATION_DEMO="1"
.\.venv\Scripts\python.exe -m alembic -c algorithm-service\alembic.ini upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8001
```

联调身份仅授予规划查看、规划执行、资源查看和态势查看权限。前端初始化使用仓库现有节点、设备、型号、天线、频率及干扰源数据生成稳定资源版本；修改这些源文件后资源版本会随内容哈希变化。

页面保存成功时，`data/runtime/task_input_demo.sqlite` 中的 `planning_tasks`、`planning_task_revisions` 和 `planning_operation_receipts` 会分别产生记录。原首个保存闭环未包含正式账号密码、任务列表、历史任务打开和操作回执查询；后三项现已补齐，使用上文的新接口。正式账号密码仍待统一鉴权方案确认。

## 测试

```bash
python -m pip install -r algorithm-service/requirements-dev.txt
python -m pytest tests -q
```
