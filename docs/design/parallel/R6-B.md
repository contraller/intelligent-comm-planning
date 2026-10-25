# R6-B 态势刷新 HTTP 验收工具

## 范围与当前状态

本组初始批准范围为新增 `tests/manual/r6_situation_http.py` 和本文件；原性能 FAIL 后，主组追加批准末节列出的两份生产服务文件及定向测试。R4 工具、正式需规及总接口台账未修改，没有提交或推送。工具复用 R4 `Probe.call`、真实 LOCAL 登录、Cookie 与 CSRF；加载独立模块实例后局部覆盖 `.24` 目标，增加目标门禁、计时及一致性核验，不调用 R4 的 prepare/provision/服务器启动功能。

当前状态：补丁前真实 HTTP 采样已完成，**原 HTTP 性能验收 FAIL 保留**。串行 20 组成功 11、超时 9；最多 4 路并发共 20 组成功 0、超时 20。追加 N+1/重复校验修复已通过四文件 113 项定向测试，尚未加载到 8124，也未做补丁后真实 HTTP 复测，等待主组重启及明确排程。不能据此登记端到端态势刷新不超过 60 秒为通过；浏览器及 overlay 渲染仍由主组负责。

授权服务目录为 `F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013`；前端为 `http://127.0.0.24:5324`，API 为 `http://127.0.0.24:8124`。程序交叉核对 `workspace.json` 的 runtime、两个 URL、显式数据库 URL 及 private 路径。数据库只能位于该 runtime 或同名 `data/runtime/tmp/r4-f79ea5c1b6c54e38ae495d840c142013` 内；仅验证路径，不打开 SQL 连接。

所有工具产物位于新建的 `F:/work/project2026-1/data/runtime/r6/<GUID>/`。程序仅从本轮 workspace 指定的 private 文件载入 editor/reviewer，凭据留在内存；不从参数、环境或其他轮次取口令，不打印 private、响应原文、Cookie、会话或 CSRF。HTTP 禁止代理、重定向和其他 origin；不操作 5183、`.22`、`.23`。不复制依赖、瓦片或业务库，不迁移库、不创建账号、不启动/停止服务，不做全仓回归、生产打包、备份恢复。

## 指标来源与数据规模

- 原件：`docs/input/【非密】短波规划要求.docx`，`word/document.xml` 中一基段落 41，即零基 40：`6.态势刷新时间：≤1分钟。`
- 原件 SHA-256：`218c3d984d7a1f84c4bf9998ce35618c51e9de06802ca790003a32082a78e613`。程序在运行时同时核验文件摘要与该段正文，原件变化时拒绝沿用旧证明。
- 交叉引用：`docs/design/05_移动电台部署规划算法方案.md:49`；主组提供对应需规编号 `SR-3.2-053`、`SR-3.11-012`。本组不改写正式需求或创建新验收标准。
- 当前主组说明的规模为 414 设备、132 物理节点，HF 对应 76 节点、VUHF 对应 104 节点。两类可以共站，不声称 150 个互不重复物理站点。程序从同版全量设备和节点实际推导各数、交集，分别核对 HF 不少于 50、VUHF 不少于 100 的对应节点；414 是本轮固定数据集断言，不是新增正式规模指标。

60 秒仅用于既有指标的 HTTP 组成部分核对。完整页面是否满足该指标必须与主组浏览器结果共同判断；本工具的 PASS 终态明确为 `PASS_HTTP_ONLY_BROWSER_NOT_RUN`。

## 真实链路与版本边界

`app/resource_read_service.py` 在本树不存在，实际路径为 `algorithm-service/app/resource_read_projection.py`。状态导入入口是 `device_status_router.py:84`，持久化为 `device_status_service.py:123`，投影入口为 `resource_read_projection.py:136`。

1. `GET /api/v1/resource/context?context=ledger` 取得资源版本，完整设备列表取得资源摘要；核验全部 414 个真实设备引用、对应节点与地图空间关联。
2. 串行 `POST /api/v1/device-status/imports`，每批导入全部 414 设备。使用现有设备的 `device_id/node_id/model_id`，轮换 NORMAL/FAULT/OFFLINE/UNKNOWN，明确标记 `SYNTHETIC_INTEGRATION`，未知值为 null 并保留原因，不改台账资源。
3. 回读原请求号的导入回执、状态快照目录、同版本快照头和全部状态记录；核对资源版本/摘要、快照 ID/版本/摘要和原 payload。全面审查在性能样本之外独立记录；每个导入轮次确实改变构造状态，后续新批次不得改写首批快照。
4. 同资源、同快照完整读取 ledger 和 gis 两种 context 的设备投影，核对全库状态/告警筛选、分页、统计及四类代表设备详情，检查全部非状态资源字段不变。
5. `resource/context` 是资源基线，`resource/map` 是节点/干扰空间基线，地图 DTO 明确拒绝 observed 参数。验证其基线保持及详情的空间归属；节点状态不由设备状态猜测聚合。设备 overlay 来自同版 `resource/devices?context=gis&status_mode=observed...` 全量明细，由主组浏览器验证。当前边界见 `resource_read_query_schemas.py:195`，不能将地图基线不变误报为设备刷新失败或已完成 overlay 渲染。

写入只在主组知情且无其他状态写入时执行。每批写前读取资源 context，再以同一 `base_revision` 提交；服务端在写事务校验资源 CURRENT，冲突为 409/1205。此处是资源版本 CAS；接口不存在状态 CURRENT 指针及其 CAS 字段，不虚构跨批状态 CAS。并发阶段由只读客户端门禁禁止所有 POST，并使用各自的 HTTP 客户端及 Cookie 副本，不共享可变 CookieJar。

## 动作与 CLI

运行前主组应已完成 LOCAL 账号初始化、改密及 R5 四型号补充。workspace 的初始化资源版本不一定是补充后的 CURRENT，因此以 `smoke` 实际返回的资源版本和摘要用于 import，不隐式采用 workspace 旧版本。

```powershell
$r6Runtime = 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013'
$r6Workspace = Get-Content -LiteralPath "$r6Runtime/workspace.json" -Encoding UTF8 | ConvertFrom-Json
$r6Args = @('--runtime-root', $r6Runtime, '--database-url', $r6Workspace.database_url,
    '--target', 'http://127.0.0.24:5324')

python -B tests/manual/r6_situation_http.py prepare @r6Args
python -B tests/manual/r6_situation_http.py smoke @r6Args --execute

# 从 smoke 的 report.json.fixture 取补充后的真实值；以下两项不是字面可执行值。
$r6Revision = '<fixture.resource_revision>'
$r6Hash = '<fixture.resource_content_hash>'
python -B tests/manual/r6_situation_http.py import @r6Args --execute `
    --expected-revision $r6Revision --expected-content-hash $r6Hash --rounds 20 --concurrency 4

# 已有已验证锚点可单独读取，不再导入状态；也可使用 --account reviewer。
python -B tests/manual/r6_situation_http.py snapshot @r6Args --execute `
    --anchor 'F:/work/project2026-1/data/runtime/r6/<GUID>/anchor.json' --rounds 20 --concurrency 4
```

`prepare` 只校验公开路径、配置和来源并写离线计划，不读凭据、不发网络请求，不初始化数据库。`smoke` 只登录及读取当前基线，不导入状态；认证本身可以写会话。`import --rounds 20` 表示串行 20 次完整状态更新回读，然后对最终同一快照执行共 20 个读取组，最大 4 路并发；不是 20 批各 4 组。`snapshot --rounds 20` 表示同一已验证锚点串行读 20 组、并发读共 20 组，不写状态。只需先提供浏览器样例时，可用 `import --rounds 1`，保留真实生成的全量 payload 与锚点，再另用 snapshot 完成读取样本。

完整契约审查单独执行一次，读完整批状态记录、ledger/gis 两种全设备投影、四类状态及三类告警全部筛选分页和代表详情。其默认 600 秒是工具执行保护上限，不是项目验收标准，不计入 60 秒性能样本，也不隐藏其实际耗时和失败。

`--audit-report` 可显式复用先前实际 PASS 的完整审查阶段，必须逐项匹配同一运行环境、资源版本/摘要、状态快照 ID/版本/摘要和原 payload 摘要，且先前存在已验证 anchor。先前整轮因后续工具错误失败不抹去已完成的审查阶段，但后续失败仍保留；复用只针对不可变状态一致性，不复用任何性能样本，新一轮的 20+20 组全部重新发真实请求。

每个实际刷新读取组包含资源 context、快照头、GIS 全 414 设备的 9 页明细、轮换的一类状态筛选及一类告警筛选首页/总数、同快照详情和地图基线核验，共 15 个实际请求；每页和全体设备都核对原 payload，筛选与详情核对同组全量列表，轮换覆盖全部状态/告警类型。完整筛选的其余页已由独立全面审查验证。完整 GIS 明细是前端 overlay 所需工作量，不能用单个最快 API 替代。登录、基线读取和客户端建立不计入组时长，没有丢弃预热样本。串行更新从 POST 调用前开始，包含 R4 Probe 自动 CSRF 预检、实际导入及后续核验；目录可见和 ACK 另记。客户端少量证据落盘在更新链路中，结束点为最后一致性核验完成。读取组从实际开始回读计时，另报告整个并发批次时间。

各 lane 及分阶段归一化 endpoint 输出 attempted、成功 n、失败数、P50/P95/max、最慢尝试和超时信息。百分位使用 nearest rank：排序后取 `ceil(p*n)-1`；失败不混入成功分位数，但单独计数且不能得到整体通过。组预算 60 秒，请求超时默认 30 秒，可在 0 到 60 秒之间显式设置；不把超时截成 60 秒成功样本。

## Payload 与浏览器锚点

实际可导入文件是运行产物 `import-payload-0.json`，包含全部 414 条原 API 引用。以下仅展示字段形状，尖括号必须来自当前 API，不能直接把示意值提交；工具会生成实际可导入样例而非人工杜撰设备引用。

```json
{
  "schema_version": "device-status-snapshot-a1",
  "context": "ledger",
  "request_id": "r6-<GUID>-state-0",
  "base_revision": "<current resource revision>",
  "data_origin": "SYNTHETIC_INTEGRATION",
  "source_label": "r6-<GUID>-round-0",
  "provenance_note": "Explicit R6 synthetic acceptance input; no measured telemetry is claimed.",
  "records": [
    {
      "device_id": "<API device_id>",
      "node_id": "<same API node_id>",
      "model_id": "<same API model_id>",
      "observed_at": null,
      "status": null,
      "alert": null,
      "unknown_reasons": ["Explicit R6 synthetic acceptance input; no measured telemetry is claimed."]
    }
  ]
}
```

`anchor.json` 保存资源版本/摘要、`snapshot_id`、`snapshot_revision`、快照 `content_hash`、来源标签、请求号、原 payload 路径/摘要、POST 前墙钟 `t0_wall_ns`、回执导入时间以及 HTTP 核验状态。不包含身份凭据。仅 `validation=COMMITTED_HTTP_VERIFIED` 可作为已验证锚点；首次 ACK 后的 `COMMITTED_NOT_YET_VERIFIED` 不冒称成功。每轮另保留 `anchor-<index>.json`，最终 `anchor.json` 指向本次最后一轮。已提交但性能核验中断的锚点可传给 snapshot，程序重新核对原回执/原文及完整一致性，在新 GUID 下写入已验证锚点，不重发 POST、不改旧失败报告。reviewer 不读取属于 editor 的导入操作回执，仍须完整核对不可变快照及 payload，回执未执行项单独登记。

前端取锚点中的 `R=resource_revision`、`S=snapshot_id`、`SR=snapshot_revision`：

```text
GET /api/v1/device-status/snapshots?context=ledger&resource_revision=R&page=1&page_size=20
GET /api/v1/device-status/snapshots/S?context=ledger&snapshot_revision=SR
GET /api/v1/device-status/snapshots/S/devices?context=ledger&snapshot_revision=SR&page=1&page_size=50
GET /api/v1/resource/devices?context=gis&revision=R&status_mode=observed&observation_snapshot_id=S&page=1&page_size=50&sort=id&order=asc
GET /api/v1/resource/devices/D?context=gis&revision=R&status_mode=observed&observation_snapshot_id=S
GET /api/v1/resource/devices?context=gis&revision=R&status_mode=observed&observation_snapshot_id=S&status=FAULT&page=1&page_size=50
```

列表应读完全部页，核对 `observation.snapshot_id/snapshot_revision/resource_revision/data_origin/source_label`，再按 `node_id`/`node_lon`/`node_lat` 绑定地图设备 overlay；筛选和详情必须使用同一 S，不能拼当前目录中新批次。默认固定批次应保留旧 S；只有显式开启跟随最新后才应用新 S。UNKNOWN/null 不得补 NORMAL。主组应以实际控件、可见 overlay、列表和详情均已更新的时点作为渲染结束证据；HTTP ACK、目录出现或本工具 PASS 都不能替代该证据。

## 失败与证据状态

本工具覆盖：错资源版本 409/1205、错快照版本 409/1203、不存在快照 404/1002、非法 observed/baseline 组合和分页及地图 observed 请求 422/1001；import 另串行覆盖原号原文重放、原号改文 409/1206、未知设备 404/1002、错节点 409/1203、未知值无原因 422/1001、过期资源拒绝。拒绝后查原请求号无回执，并核对 HTTP 可见快照数量未增；这是 HTTP 证据，不声称 SQL 级零写入或事务损坏测试。

任一导入/回读异常即停止后续状态写入，保留 `pending-import.json` 和原 payload。超时可能发生在提交之后，必须按原 `request_id` 查询 `/api/v1/device-status/imports/{request_id}?context=ledger` 核实，不自动换请求号重试，也不删除失败证据。实际执行后在本节追加真实样本数、耗时、快照 ID、异常样例和失败轮次。

未执行项：本组浏览器渲染、外部设备采集协议与实测状态、全仓回归、生产构建、备份恢复；不得依据本工具将这些事项登记为通过。

## 已生成的可用状态样例

原请求号为 `r6-c65a1cacd7b641b292d175af49107e61-state-0`；导入 414 条，状态分布 NORMAL=104、FAULT=104、OFFLINE=103、UNKNOWN=103。实际全量 payload：`data/runtime/r6/c65a1cacd7b641b292d175af49107e61/import-payload-0.json`。原号原文可重放，作为新批次导入必须由主组协调新的请求号和来源标签，不能隐式把浏览器选中批次改为最新。

- 资源版本：`resource-7c8bd11ec30d0ed4`。
- 资源摘要：`7c8bd11ec30d0ed444449a5f7e3229a8f3bdb481acc680adc629b7d89d75bfdf`。
- 状态快照：`DSS-ab417908506d4523a32baf17a28c3a3d`。
- 状态版本：`device-status-8d599724fa77b5aec40216ecffd7389e78b184ff1c452a674c38286055111a6f`。
- 已验证锚点：`data/runtime/r6/4b4467f9bbcf4541a62f4706475dccc7/anchor.json`。此轮完整审查 PASS；其整轮 TypeError 失败结果同时保留于同目录 report.json，不标整轮通过。

| 设备 | 节点 / 型号 | 构造状态 | 告警 / 时间 |
|---|---|---|---|
| DV-0001 | ND-0001 / DM-0004 | NORMAL | false / 2026-10-24T11:52:41.130723Z |
| DV-0002 | ND-0001 / DM-0004 | FAULT | true / 同构造时刻 |
| DV-0003 | ND-0001 / DM-0004 | OFFLINE | true / 同构造时刻 |
| DV-0004 | ND-0001 / DM-0004 | null | null / null，原未知原因保留 |

可用于浏览器的异常详情请求：

```text
GET /api/v1/resource/devices/DV-0004?context=gis&revision=resource-7c8bd11ec30d0ed4&status_mode=observed&observation_snapshot_id=DSS-ab417908506d4523a32baf17a28c3a3d
```

首轮超时证据：`data/runtime/r6/c65a1cacd7b641b292d175af49107e61/report.json`，导入 ACK 1.225 秒，目录可见 2.467 秒；ledger 全量投影后，GIS 第 3 页触发 60 秒链路预算，整轮失败且停止写入。设备投影请求出现 3–7 秒耗时。可复查的性能热点范围为 `resource_observation_projection.py:20` 首次 `_snapshot` 校验及其后 `resolve_snapshot` 再次执行 `_snapshot` 的路径，列表每页与详情均全批投影；这只是代码范围与真实耗时现象，未做 CPU 剖析，不断言单一根因，不修改生产文件。

## 最终实测与交回

最终报告：`data/runtime/r6/563f24e31f094761934e4c067befe138/report.json`，`completed=true`、`outcome=FAIL`。本轮为 488 个具名 HTTP 调用，包含 29 个刷新组请求超时；自动 CSRF 预检另记录在具名 POST 的 transport_requests 中，不把二者混称计数。并发阶段总用时 303.905 秒。

| 读取组 | 尝试 | 成功 n | 超时/失败 | 成功 P50 秒 | 成功 P95 秒 | 成功 max 秒 | 最慢尝试秒 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 单用户串行 | 20 | 11 | 9 | 28.026 | 51.358 | 51.358 | 60.016 |
| 同用户、最大 4 路并发 | 20 | 0 | 20 | 无成功样本 | 无成功样本 | 无成功样本 | 60.031 |

超时样本是未完成的刷新，不能用 60 秒填充成功分位数或当成真实完成时长。上表成功分位数使用已声明的 nearest-rank 方法，整体结论同时保留全部失败。完整 GIS 投影已验证到 414 设备、132 物理节点、HF 对应 76、VUHF 对应 104、共站 48；不是 180 个或至少 150 个不同物理站。

实际仅执行 **1 次新增状态快照导入**，全量 414 条；首轮更新回读超时后停止新增状态。后续 20+20 是同一已提交快照的全新真实只读刷新请求，不能冒称 20 次状态更新链路通过。串行更新动作本身的首轮失败、完整审查成功后的 CookieJar 工具失败，以及最终性能 FAIL，分别保留，未覆盖旧证据。

最终可交主组的锚点为 `data/runtime/r6/563f24e31f094761934e4c067befe138/anchor.json`，payload 为同目录 `import-payload-0.json`；与前述已验证快照 ID、状态版本及四个异常/正常样例一致。完整审查实际于 `4b4467f9bbcf4541a62f4706475dccc7` 执行，142.666 秒 PASS；该轮其后因 CookieJar 的 TypeError 整轮失败，修复独立复制并完成离线门禁验证后，最终轮只显式复用同一不可变快照的审查阶段，40 个性能样本没有复用。

异常场景实跑 7 个 GET：资源版本过期 409/1205、快照不存在 404/1002、baseline 携带快照 422/1001、observed 缺有效快照 422/1001、page_size=51 为 422/1001、map observed 为 422/1001、快照版本不符 409/1203。原状态请求号回执已实际查回并核对；本轮没有执行原号 POST 重放、改文冲突或非法状态 POST 的专项，因为初次 import 已在后续回读中断；相关工具路径已实现，未将其登记为通过。没有验证多轮状态历史保持、没有浏览器渲染证据。

产生最终性能报告的 CLI：

```powershell
python -B tests/manual/r6_situation_http.py snapshot `
  --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' `
  --database-url 'sqlite:///F:/work/project2026-1/data/runtime/tmp/r4-f79ea5c1b6c54e38ae495d840c142013/workspace.sqlite' `
  --target 'http://127.0.0.24:5324' `
  --anchor 'F:/work/project2026-1/data/runtime/r6/4b4467f9bbcf4541a62f4706475dccc7/anchor.json' `
  --audit-report 'F:/work/project2026-1/data/runtime/r6/4b4467f9bbcf4541a62f4706475dccc7/report.json' `
  --rounds 20 --concurrency 4 --execute
```

离线检查通过：Python AST、两文件 UTF-8 无 BOM、原件摘要及段落、独立 CookieJar 复制、拒绝 `.22/.23/5183`、只读客户端拒绝 POST；五份本组 report 中没有口令/会话/CSRF/用户名等凭据字段。没有执行全仓回归、生产打包、备份恢复、服务启停或提交推送。写入独占已释放，本组新增状态快照仍仅 1 份，资源未回写。

原性能运行 UTC 为 2026-10-24 12:04:14 至 12:24:45；并发段约 UTC 12:19:36 至 12:24:40，即北京时间 20:19:36 至 20:24:40。该段未与主组 UI 负载隔离，因此原 FAIL 保留为实际运行证据，不能作为无其他浏览器/测试负载的隔离基准，不能直接据此归因主组冷加载/规划 bootstrap 的 60 秒等待。工具未连接运行库 SQL，没有采集锁等待证据，不能声称已确认锁等待。主组发出新排程要求时该运行已结束；后续不再发起 HTTP 或并发性能批次，等待主组明确安排。

## 追加批准的服务修复

主组在保留原 FAIL 的前提下，批准修改：

- `algorithm-service/app/device_status_service.py`。
- `algorithm-service/app/resource_observation_projection.py`。
- 新增 `tests/test_device_status_projection_performance.py`。
- 核对并运行既有 `tests/test_device_status_api.py`、`tests/test_resource_observation_projection.py`、`tests/test_resource_observed_export.py`；实际名称如上，本次未修改这三份既有测试。

原 `_snapshot` 完整读取并校验全批 ORM 记录，但返回后记录强引用释放，`resolve_snapshot` 随后对每个成员执行 `session.get`，形成 N+1；投影先 `_snapshot`，再 `resolve_snapshot`，重复完整校验。新增 `_validated_snapshot` 在一次全批 SELECT 后形成已验证的记录映射，原 `_snapshot` 仍返回原二元组。`resolve_snapshot` 使用本次映射，保持请求顺序、重复项独立值和缺失成员整批拒绝；新 `resolve_full_snapshot` 在调用方 Session 内完整校验一次，按原批次顺序返回全记录，供资源投影使用。所有摘要、原输入、资源关联、可用性及未请求成员校验保留；没有跨请求缓存、TTL、迁移或 schema 变动，分页/权限/UNKNOWN 语义不变。

新 SQL 门禁先在未修实现上实际失败：1/50/414 设备解析为 4/53/417 次 SELECT，投影解码两次；`data/runtime/r6/c42b291d6d5843e3a58df58120664277/red.xml` 保留 6 失败、12 未选中。修复后新增专项 18 项通过，20.67 秒，`green.xml`；1/50/414 解析及投影均为固定 3 次 SELECT，状态记录表只读取一次，投影资源解码一次。3 次 SQL 是本地回归门禁，不是新增项目性能指标。测试仅为 SQL 行为构造数据，不冒充真实 132 节点/HF76/VUHF104 的 HTTP 场景。

新增专项还覆盖：乱序及重复请求、缺失成员拒绝、未知值保留、先前成功后出现的未请求坏记录仍 503、空投影仍完整核验、版本错仍 409，以及调用方同一事务内未提交损坏可见/回滚后恢复。默认 Anaconda 缺 FastAPI，首次既有测试收集为 2 错误、未执行，对应 `related.xml` 保留；改用仓库已有 `.venv`，不安装/复制依赖，四文件定向组合 **113 passed，0 失败/0 错误/0 跳过，211.02 秒**，证据 `data/runtime/r6/c42b291d6d5843e3a58df58120664277/venv-related.xml`。保留 1 条既存 Starlette TestClient/httpx 弃用警告，没有为此调整依赖。所有 pytest basetemp、系统临时目录和 JUnit 均位于同一 R6 GUID 下。

最终定向测试 CLI：

```powershell
$r6SqlRoot = 'F:/work/project2026-1/data/runtime/r6/c42b291d6d5843e3a58df58120664277'
$env:TEMP = Join-Path $r6SqlRoot 'os-temp'
$env:TMP = $env:TEMP
& './.venv/Scripts/python.exe' -B -m pytest -p no:cacheprovider `
  tests/test_device_status_projection_performance.py tests/test_device_status_api.py `
  tests/test_resource_observation_projection.py tests/test_resource_observed_export.py `
  --basetemp (Join-Path $r6SqlRoot 'venv-related-temp') `
  --junitxml (Join-Path $r6SqlRoot 'venv-related.xml') -q
```

本次只修改源码及运行隔离定向测试，未重启 8124、未连接 `.24`、未再做 HTTP/并发基准；运行 API 尚未加载本补丁。由主组单独重启自有 8124，并在无其他 browser/测试负载下明确排程后复测。原 HTTP FAIL 和唯一状态快照来源均保留，不将 SQL 次数下降写成 60 秒或浏览器验收通过。

## GIS 方案目录定向补丁

主组已自行修改 `algorithm-service/app/main.py` 的 `saved_plan_history` handler：GIS 先检查 `planning.view`，再检查 `situation.view`，仅接受 `planning/gis`；未知 context 仍为 422，查询 service 不变。本组未修改该文件、公共 `http.ts` 或权限 union。

本组本次实际修改白名单：

- `front_design/radio-planning-20261022/src/services/planning-http.ts:42`：仅 `querySavedPlanningPlans` 输入允许 `planning/gis`，通过原 query 构造器原样传递 context；分页、状态、搜索与其他规划方法保持不变。
- `front_design/radio-planning-20261022/tests/planning-plan-history-http.test.ts`：两种合法 context 的精确 URL 参数、GIS 工作区到 HTTP 适配器的连接、未知 context 发送前拒绝，以及原有严格响应校验。
- `algorithm-service/tests/test_planning_plan_history_api.py`：GIS 与 planning 分页/状态/搜索/摘要完全一致；GIS 双权限调用顺序、缺任一权限 403 且不调用查询 service；未知 context 422、旧 planning 行为保留。SQLite 改用 pytest `tmp_path`，本次所有临时产物置于 R6 GUID 下。

只读核对 `src/services/access.ts:122` 的外层 `checkTaskContext` 已对本查询要求 `planning.view`，GIS 额外要求 `situation.view`；无需扩展生产文件范围。前端 workspace、类型及查询 service 不需修改，不将 GIS 改写成 planning 来绕过页面授权。

定向结果为 **后端 27 passed，113.89 秒**；前端三文件 **66 passed，0 失败/0 跳过**，分别为 `planning-plan-history-http.test.ts` 12 项、`planning-api-http.test.ts` 38 项、`gis-frozen-plan.test.ts` 16 项。后端保留 1 条既存 Starlette TestClient/httpx 弃用警告。证据目录 `data/runtime/r6/c42b291d6d5843e3a58df58120664277/gis-context/`，后端 `backend.xml`、前端 `frontend.json`。这些为隔离 TestClient/fixture 测试，权限场景显式替换 identity 校验以断言 handler 调用边界，前端 fixture 不发真实 HTTP，不冒充实际登录或浏览器端到端验收。

```powershell
$r6CatalogRoot = 'F:/work/project2026-1/data/runtime/r6/c42b291d6d5843e3a58df58120664277/gis-context'
$env:TEMP = Join-Path $r6CatalogRoot 'os-temp'
$env:TMP = $env:TEMP
& './.venv/Scripts/python.exe' -B -m pytest -p no:cacheprovider `
  algorithm-service/tests/test_planning_plan_history_api.py `
  --basetemp (Join-Path $r6CatalogRoot 'backend-temp') `
  --junitxml (Join-Path $r6CatalogRoot 'backend.xml') -q
# 以下命令工作目录为 front_design/radio-planning-20261022
node node_modules/vitest/vitest.mjs run tests/planning-plan-history-http.test.ts `
  tests/planning-api-http.test.ts tests/gis-frozen-plan.test.ts `
  --configLoader runner --no-cache --pool forks --maxWorkers 1 --no-file-parallelism `
  --reporter=json --outputFile "$r6CatalogRoot/frontend.json"
```

本补丁 ready，等待主组重启仅本轮 `.24` API 后做真实浏览器目录验证。本组本阶段未连接 `.24`、未重启服务、未运行并发或全仓回归/生产打包、未提交推送；主组负责正式接口契约与台账同步，原性能 FAIL 不变。

## 响应式只读验收模块（待执行）

主组反馈 API 已重启，真实 GIS 目录已能查询并打开；主组另反馈 30 秒周期 3 个渲染性能样本全部 PASS、max 37.276 秒。以上为主组反馈，不是 B 组本轮运行证据，亦不覆盖此前 HTTP FAIL。B 组只读复审 A 的 `resource-status.ts`、`ResourceStatusPanel.vue`、`GisPlanOperations.vue`、`gis-device-status-layer.ts` 及相邻取消/投影边界，未发现阻塞；本次未修改这些生产文件，也未执行测试或启动负载。

主组批准本次新增白名单 `tests/manual/r6_browser_responsive.mjs`，并允许更新本日志；宿主与所有 production 保持原样。新增模块默认导出 `runResponsive(h)`，复用 `r6_browser_acceptance.mjs` 已注册的 `responsive` 分组及其真实 `Page/login` 闭包，不启动第二浏览器、不安装/复制库、不连接业务库、不读取 private、口令、Cookie 或请求头。仅核对公开 `workspace.json` 的 runtime/db/URL 配对，前端限定 `127.0.0.24:5324`、API 限定 `127.0.0.24:8124`。凭据只由主组既有 login 闭包读取本轮 private。

矩阵为 editor 的 `situation/resources/planning/diagnosis/knowledge`，admin 的 `system`，分别在 `1440x1000` 和 `390x844` 下顺序执行，共 12 组、每组 6 帧，完整成功时为 72 帧。模块不点击业务命令、不修改业务表单、不直接调用 API、不注入 store 或桩、不拦截/伪造网络；真实登录自身允许 `POST /auth/login`，其余非 GET/HEAD/OPTIONS 的 API 请求被记录为违规并令结果 FAIL。登录会产生真实会话及正常登录审计，不将其描述成服务器零写入。模块所有自身 JSON/截图只写 `F:/work/project2026-1/data/runtime/r6/<GUID>/`；主 harness 自身的浏览器 profile/总报告沿用主组既有目录策略，本模块不修改该宿主。

就绪条件同时要求真实、非 Service Worker 的产品 fetch/XHR 返回 HTTP 200/code 0，以及正确路由、可见 H1、实际内容、字体就绪、无加载提示及错误提示。来源范围按生产适配器核对：

- GIS：`resource/context` 与 `resource/map`，`context=gis`，并要求真实 OL canvas 有非透明且多色的采样。
- 资源：`resource/context` 与 `resource/devices`，`context=ledger`。
- 规划：`resource/context`、`resource/map`、`resource/param-presets`、`resource/frequency-pool`，`context=planning`；不等待不存在的 `/plan/catalog` 或目录未打开时不会发出的请求。
- 诊断：`fault/workbench`、`fault/workbench/catalog/scenarios`、`fault/workbench/catalog/history`。
- 知识：`kg/workbench`、`kg/workbench/browse/graph`、`kg/workbench/browse/search`。
- 系统：`system/options`、`system/accounts`。

响应仅保留白名单版本、来源、数量/数组长度，不落全量响应或账号内容；请求开始的 navigation epoch 与当前轮次一致才可作为来源证据，拒绝前一页面迟到响应。资源 context 与 map/list 的 revision 必须一致。实际运行前已把来源等待从 120 秒放宽到 240 秒，属于工具预算，不是新增产品时限指标；超时只表示未观察到就绪，不直接诊断生产缺陷。

每帧记录 document/H1 标题、viewport/DPR、document/body/main/page/title 的尺寸与 scrollWidth/scrollHeight、scroll 位置、来源标签、错误/加载状态和地图 canvas 颜色。间隔以 1 秒为最小目标并保留真实间隔；慢截图不会触发追赶式密集采样。六帧内标题必须一致，尺寸/滚动尺寸波动与 body 横向溢出仅容许 1 CSS px 舍入误差；这属于本地稳定性检查，不改正式需规。任意 pageerror 均失败，不过滤 ResizeObserver 错误。

必须使用主 harness 初始 `1440x1000` 的新 Page。唯一一次 `1440→390` 正常视口转换独立保留 before/after 与排除原因，发生在正式移动端用例前，`removedFromCaseFrames=0`；不能从六帧中剔除某个不稳定帧或用该排除掩盖后续 overflow。各组六帧的第 1/6 帧留真实 viewport PNG；GIS/规划另在采样后截取实际 map viewport，记录截图可能引起的只读滚动。直接 canvas 颜色与解码真实 map PNG 分别核对非空/多色，8 种量化颜色为本地非空检查，不是项目标准。完整截图的遮挡、文字与构图复核明确标为 `PENDING_MAIN_VISUAL_REVIEW`，不能用 DOM 尺寸或颜色数量冒充人工视觉复核通过。

模块不调用主 `record/shot`，自身完整矩阵及失败证据写入 R6 GUID 下的 `responsive.json`；主 harness 的 `group-result.json` 返回该目录，宿主外层 case 计数不能冒充本矩阵计数。失败帧/PNG 原样保留，剩余未运行组为 NOT_RUN，任意失败不报告整体 PASS。

仅在主组明确结束独占窗口并放行后使用：

```powershell
node tests/manual/r6_browser_acceptance.mjs `
  --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' `
  --group responsive --performance-complete 1 `
  --png-package '<主性能运行已使用的现有 package.json 绝对路径>'
```

宿主继续复用本轮既有 task/plan 参数；如自动发现未命中，主组补其原有 `--task-id/--plan-id`，不新建任务或方案。模块要求 `performanceComplete=true`，缺少放行标志即在读取环境或操作 Page 前拒绝。当前仅静态编写/阅读核对；主组正在执行 5 秒×20 独占性能窗口，B 组未启动 UI、HTTP、测试或脚本入口，未登记该矩阵或语法执行检查通过，等待主组后续明确排程。

文件静态检查：两文件 UTF-8 无 BOM；`git diff --check` 无空白错误。尚未执行 `node --check`、导入模块或运行浏览器矩阵，不能登记语法/运行通过。

## 恢复后状态与定向补项准备

前段“待执行”是首次静态交付时状态。随后主组放行后，原版脚本已执行 `node --check tests/manual/r6_browser_responsive.mjs`，退出码 0；首次普通沙箱内 Edge 初始化 180 秒超时，未进入业务页面。经获准在沙箱外仅重试同一专属 profile，实际完成如下旧矩阵；没有把初始化失败计作业务页面失败。

旧 responsive 运行 ID：`05d3737a-898e-4076-be56-a2bb38ad56de`；宿主 ID：`r6-browser-1792855463044-52f3c3`；原 CLI session `59360` 在恢复后已不可继续读取。证据目录 `data/runtime/r6/05d3737a-898e-4076-be56-a2bb38ad56de/`，包含 `responsive.json`、`screenshot-index.json`、`screenshot-index.md` 和 26 张 PNG。2026-10-25 恢复后只读核对到 `completed=true`、`outcome=FAIL`，**11 PASS / 1 FAIL、66 帧**；66 帧最大 body 横向溢出为 0，pageerror/违规业务写/越界请求均为 0，唯一正常 resize 单独保留且未删除正式帧。未产生新业务任务、快照或变更请求号；真实登录自身有正常会话和审计副作用。

唯一失败是 `RESP-1440-planning`：240 秒来源就绪预算结束时，四类期望来源均已有真实 HTTP 200/code 0，资源 context/map 同为 `resource-7c8bd11ec30d0ed4`，页面 H1、字体、内容及地图均已存在，canvas 采样有 39 种量化颜色、body 横向溢出为 0，但 DOM 仍显示 `Failed to fetch` alert。该项正式帧为 0，原 `RESP-1440-planning-failed.png` 保留；不能据此声称规划页布局坏，也不能直接抹掉失败。390 planning 已有 6 帧 PASS。其余 1440 的 situation/resources/diagnosis/knowledge/system 与 390 全部六路由均 PASS。所有截图视觉复核保持 `PENDING_MAIN_VISUAL_REVIEW`，主组另外指出的地图聚合标签互盖尚不能由这些自动化 PASS 抵消。

暂停时已核实本组 `browser-contexts/responsive` 专属 Edge 和对应 CLI 均未运行，没有关闭其他 context、停用服务、重提交或取消事务。最新恢复授权仅允许静态编辑本脚本和本日志；本节新增定向分支未执行 `node --check`、浏览器、HTTP、测试或 typecheck，等待主组单个执行 token。

### caseNames 与报告范围

`h.caseNames` 使用真实 ID，例如 `RESP-1440-planning`；宿主既有 `--cases` 已原样传入，不改宿主。缺省或空数组仍运行严格全 12 项；未知 ID、重复 ID 或非字符串立即拒绝，不回退全量。按原矩阵顺序只编排所选项，不重跑未选中的 11 项；宿主真实登录的默认 landing 不算另一个验收 case。

- 默认完整矩阵：`scope.mode=FULL_MATRIX`、期望 12 项/72 新帧/1 次正常 resize 排除，全部原就绪、六帧、PNG、权限及安全断言不变。
- 只补 1440 planning：`scope.mode=SELECTED_CASES`、`selectedCaseIds=[RESP-1440-planning]`、期望 1 项/6 新帧/0 次 resize 排除；未选 11 项逐项列在 `notSelectedCaseIds`，不计入本次 PASS 或新帧。
- 报告和截图索引同时记录 scope、期望/实际 case 与帧数；`fullMatrixPassed` 在定向补项中始终为 false，即使本次 `outcome=PASS` 也仅代表所选项通过。
- 定向补项读取旧 `responsive.json`，核实原 run/schema/环境、11 个六帧 PASS 和唯一原失败 ID，并记录其 SHA-256、旧 66 帧和截图索引为 `priorEvidence`。历史 `outcome=FAIL` 原样保留，`referenceOnly=true`、`combinedFullMatrixOutcome=NOT_EVALUATED`；不修改旧报告，不把旧 66 帧冒充新采样，不自动宣布“12/12 或单轮 72 帧通过”。是否接受跨轮补项及完整截图视觉结论由主组决定。
- 每次补项使用新的 R6 GUID 目录，原子保存完整 JSON 后才替换本轮报告；ENOSPC 时保留前一个完整版本和失败临时文件，不自行清理。

待主组单个 token 放行后的 CLI（当前不执行）：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  tests/manual/r6_browser_acceptance.mjs `
  --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' `
  --group responsive --performance-complete 1 --cases RESP-1440-planning `
  --playwright-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json' `
  --png-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs/package.json'
```

去掉 `--cases RESP-1440-planning` 才是全 12 项重新运行；两种方式都必须另获主组 token，不能因准备了 CLI 就自动启动。

## A 链与地图标签只读复审交回

**A 的状态原子应用/显式跟随/独立地图叠加链未发现阻塞。** `resource-status.ts:69` 先校验同一批次的表头、全部分页、成员顺序/唯一性、数量和统计，`:101/:120` 才替换同一 selection；失败不发布半批。`:109` 跟随 current 同时核对客户端、资源、会话 generation、取消、权限、pending 与显式 latest 模式；`:148` 返回 baseline 同步退出跟随。`ResourceStatusPanel.vue:118/:123` 的 dirty、权限、来源和 pending 门禁配合同步取消；`GisPlanOperations.vue:401/:428` 的 resources+situation 双权限与资源锚点约束 overlay，`:681` 离页释放刷新与叠加；`gis-device-status-layer.ts:20/:72` 再核对网络/状态身份和真实绘制代次。以上仅代码复审，不替代主组已报告的两组性能及 behavior 通过，也不重跑这些验收。

标签问题的准确生产范围如下，**本组未修改任何生产地图文件**：

- 必需范围：`front_design/radio-planning-20261022/src/maps/gis-device-layers.ts:12` 的 caption，`:17` 的 `gisDeviceStyles`，尤其单设备外部说明 `:28` 和聚合外部说明 `:40/:43/:46/:47`；`:56` 样式缓存与 `:57` layer style 回调。这才是普通设备层和 observed overlay 实际共用的实现。
- 推荐最小修法：在 style 回调使用 OL 传入的 resolution 做局部标签详略分级；低 zoom 不绘制外部说明文字，保留设备图形、聚合圆点/中心数量、状态颜色及选中详情入口。选中成员可保留简短 ID；具体阈值由主组区域缩放截图确认，不写成新需规。不得清空 source、偏移设备坐标或删除成员来减少重叠。**缓存键必须增加标签级别/resolution bucket**；目前仅含 version/selected，单改条件而不改缓存会导致缩放后标签不及时切换。
- 若主组还要处理关键站点文字，则可追加 `src/maps/layers.ts:21` 的 `nodeLayer`，只限制 `:57` 的 key 站点外部文字，保留选中点与聚合中心数字；不扩到 link/demand/region 其他导出。只修改 `layers.ts` 不能消除设备 caption 的互盖。
- `src/maps/gis-device-status-layer.ts:43` 直接复用 `createGisDeviceLayer()`，不自行创建标签；采用上述共用修法时无需改该 wrapper、锚点、generation、postrender/rendercomplete 证据链，也不需改 `MapCanvas.vue` 或 `GisPlanOperations.vue`。

不建议只给整个 layer 加 `declutter:true`：本地 OL 10.10.0 的 `node_modules/ol/layer/BaseVector.js:49` 已明确 declutter 同时作用于 images 与 text，相同 truthy 组值才跨层避让；普通点、聚合圆点/数字在当前样式中也会进入候选，不能保证点和点击入口全部保留。若主组选用同组文字 declutter，应明确让图标/圆点不被裁剪（image 的 `declutterMode=none`，需要保留占位时另用 obstacle），将外部文字独立为可避让 style，并实测中心数量与拾取；不能把“只加 true”视作已满足清晰且点不丢。相关官方说明：[VectorLayer declutter](https://openlayers.org/en/latest/apidoc/module-ol_layer_Vector-VectorLayer.html)、[DeclutterMode](https://openlayers.org/en/latest/apidoc/module-ol_style_Style.html)。

建议测试白名单（仅建议，未编辑/执行）：`tests/gis-device-layers.test.ts` 增加低/高 resolution 外部文字分级、同 version/selected 缓存随标签级别变化、圆点/聚合数字和 pick 成员仍在；`tests/gis-device-status-layer.test.ts` 验证 observed wrapper 复用且身份/UNKNOWN/帧证据不变。若追加 `nodeLayer` 修改，再定向核对 `tests/resource-map.test.ts`、`tests/planning-map.test.ts`，不做全仓回归。最终仍需主组在区域缩放及移动视口实际看图确认互盖是否解除。

## 最终源码冻结与主组定向证据

主组实际查看旧 responsive 截图后确认：390 diagnosis 的 210px 侧栏挤压中央区、按钮截断；390 system 的 210px 侧栏使右侧标题竖排、表格裁切。这两页视觉未通过，不能用旧矩阵 11 个自动 PASS 抵消；GIS 标签互盖另交 A 实施，本组不修改地图。主组已看过的桌面资源/诊断/知识/系统未发现业务遮挡，仍不代替最终新源码下的完整矩阵。

本组在新增授权后仅修改两页 scoped CSS 末尾的 `<=760px/<=600px` 媒体规则：

- `front_design/radio-planning-20261022/src/views/DiagnosisView.vue:1152`：新增 69 行，窄屏 workspace 单列，场景列表有界滚动，中央区不再强制 650px 最小高度，结果区/恢复按钮回正常流，页头及按钮在窄屏换行。
- `front_design/radio-planning-20261022/src/views/SystemView.vue:525`：新增 53 行，窄屏管理导航置顶、内容独占整行，控件和按钮换行；账号/角色/参数/日志表格保留 760/650/650/900px 原最小列宽，仅实际 `.p-datatable-table-container` 内部横滚。
- 新增 `front_design/radio-planning-20261022/tests/compact-diagnosis-system-layout.test.ts`：20 个声明级 CSS/SFC 用例，覆盖 320/390/600/760 单列、结果恢复正常流、内部横滚、按钮及 601 边界，并核对 761/960/1440/1600 原桌面/平板规则不变。该测试不模拟浏览器排版或像素，不能独立证明视觉通过。

两页模板、script、业务 store、权限、API 和桌面媒体规则均未修改；没有修改共享 global CSS、AppTable、主 harness 或生产地图。原补丁目标文件静态 diff 无空白错误、UTF-8 无 BOM。实施时按主指令未运行 Vitest/Browser，随后主组统一单 worker 专项，本组只读本地 JSON 核对结果如下。

主组 B 定向证据：`data/runtime/r6/r6-responsive-compact-20261025.json`，`success=true`、35 passed、0 failed、0 pending；实际为 3 个物理文件，不将 reporter 的 6 个 describe suites 混称 6 文件：

| 文件 | 通过数 |
|---|---:|
| `tests/compact-diagnosis-system-layout.test.ts` | 20 |
| `tests/compact-workspace-layout.test.ts` | 13 |
| `tests/system-busy-navigation.test.ts` | 2 |

主组 A 地图定向证据：`data/runtime/r6/r6-gis-declutter-20261025.json`，`success=true`、49 passed、0 failed、0 pending；实际为 3 个物理文件，不将 reporter 的 10 个 describe suites 混称 10 文件：

| 文件 | 通过数 |
|---|---:|
| `tests/gis-device-display.test.ts` | 34 |
| `tests/gis-device-layers.test.ts` | 8 |
| `tests/gis-device-status-layer.test.ts` | 7 |

以上两轮均由主组执行，B 只读核验既有 JSON，未自行重跑。前节地图建议是当时只读评估，最终原生 declutter 修改及其定向测试由 A/主组负责；49 PASS 也不独立代表地图标签视觉验收通过。A 状态原子应用/显式跟随/独立 overlay 链只读复审结论仍为未发现阻塞，未因本次 CSS 修改扩大生产范围或重跑两组刷新性能/behavior。

### 最终 full12 待单个 token

主组已冻结最终源码，执行顺序为 E 单个取消复测、C SR56、随后 B 单个 responsive context。B 当前仅更新本文，不启动 Browser/HTTP/测试/typecheck/重算或任何服务。partial `h.caseNames` 支持保留作后续定位工具，最终默认采用一轮新 GUID 的 **FULL_MATRIX：12 项、72 个新帧**，不拼接历史 66 帧，不把旧 11 PASS 作为最终源码结果。

待主组明确交付 B token 后执行；当前只准备命令，不执行：

```powershell
& 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  tests/manual/r6_browser_acceptance.mjs `
  --runtime-root 'F:/work/project2026-1/data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013' `
  --group responsive --performance-complete 1 `
  --playwright-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json' `
  --png-package 'C:/Users/y/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pngjs/package.json'
```

不传 `--cases`，报告须为 `scope.mode=FULL_MATRIX`、`expectedCaseCount=12`、`expectedFrameCount=72`；只有 12 项各采满 6 稳定帧且全部原就绪/尺寸/标题/横向溢出/pageerror/canvas/PNG/安全断言通过，才可令自动化 `fullMatrixPassed=true`。每项真实等待来源就绪，不以短超时直接判业务坏。源码或来源若中途变化，不能静默拼接此前帧当作同一最终轮次。

新产物仍仅由模块写入 `F:/work/project2026-1/data/runtime/r6/<新GUID>/`：`responsive.json`、`screenshot-index.md`、`screenshot-index.json`、各组 frame-1/frame-6 PNG 和地图 PNG。截图索引明确保留 `PENDING_MAIN_VISUAL_REVIEW`，最终由主组实际查看新源码截图；截图生成或自动化通过不等于视觉通过。旧 `05d3737a-898e-4076-be56-a2bb38ad56de` 原 FAIL、66 帧及截图均保留。

### 明确 GO 后的 planning 单项实跑

主组后续明确只授权原失败项 `RESP-1440-planning`，要求正常竞争 `127.0.0.24:55324` lease、被拒即停、不绕过，不能运行 full12。B 使用上述既有运行参数并增加 `--cases RESP-1440-planning`，未启动其他测试、重算、业务写或服务；主 harness 正常取得互斥并仅创建一个本组专属 context。执行 session `9898` 已正常结束，退出码 0；宿主 finally 的 `context.close()` 与 `lease.close()` 路径正常返回，交回浏览器 token。

实际新运行 ID `c04875de-4faa-47d0-b123-41b76ef4cd47`，宿主 ID `r6-browser-1792864705092-5f6897`。目录 `data/runtime/r6/c04875de-4faa-47d0-b123-41b76ef4cd47/` 的 `responsive.json` 已只读复核为 `completed=true`、`outcome=PASS`，但明确 **`scope.mode=SELECTED_CASES`、1 项/6 新帧、`fullMatrixPassed=false`**；11 个未选中 ID 单列，不计入本次覆盖。

六帧均通过原真实来源/页面就绪、标题/尺寸/滚动尺寸稳定及非空地图要求，资源版本仍为 `resource-7c8bd11ec30d0ed4`；尺寸/滚动尺寸波动 range 均为 0，body 横向溢出最大为 0，pageerror、违规业务写、越界请求、resize 排除均为 0。实际相邻采样间隔约 1005.8 至 1016.6 ms。用例总耗时 32.604 秒仅为此次只读用例执行时间，不是新增状态刷新性能样本，也不作为 60 秒性能结论。

本次截图索引为该目录的 `screenshot-index.md`、`screenshot-index.json`，共 3 张 PNG：

- `RESP-1440-planning-frame-1.png`：1440x1000。
- `RESP-1440-planning-frame-6.png`：1440x1000。
- `RESP-1440-planning-map-1.png`：实际地图 viewport 978x742，解码为 463 种量化颜色。

截图视觉结论继续为 `PENDING_MAIN_VISUAL_REVIEW`。原 `05d3737a-898e-4076-be56-a2bb38ad56de` 的 11 PASS/1 FAIL 和 66 帧没有覆盖或改写；新报告记录其 SHA-256 为历史引用、`combinedFullMatrixOutcome=NOT_EVALUATED`，不把本单项与历史拼成一轮 72 帧或宣布最终 full12 通过。等待主组后续最终源码冻结及另一个完整矩阵 token。

### 最终 full12 首轮实跑：保留原 FAIL 并交回 token

主组随后明确授予唯一 browser+性能 token，要求原资源 `resource-7c8bd11ec30d0ed4`、原 task `r4-network-89db2499fcf6`、原 plan `PLAN-5273d94aa08345e4b047d62b915e2928`，先完成 full12，再按批准顺序安排两组性能及真实 UI 参数切换；任意样本失败须先保留，不自动追加组或改门槛凑通过。B 先只执行 full12，未修改生产或脚本，不运行单测、重算或服务操作。

实际 full12 run ID 为 `35eacda1-7c7d-4338-b530-05c082b1be3f`，宿主 ID 为 `r6-browser-1792872594982-bd0ee7`，执行 session `50809` 已退出 1。`data/runtime/r6/35eacda1-7c7d-4338-b530-05c082b1be3f/responsive.json` 已实际读回：`completed=true`、`scope.mode=FULL_MATRIX`、12 项均已执行、**72 新帧全部保留、11 PASS / 1 FAIL、outcome=FAIL、fullMatrixPassed=false**。pageerror、违规业务写、越界请求均为 0。共有 29 张 PNG（包括失败补充截图），索引 `screenshot-index.md/json` 已完整落盘；视觉仍为 `PENDING_MAIN_VISUAL_REVIEW`。

唯一失败 `RESP-390-diagnosis`：六帧的 main 容器可见高度保持约 664.4px，但第 1 帧 page 高约 763.1px、main.scrollHeight=763，第 2 至第 6 帧 page 高约 3344.5px、main.scrollHeight=3345，波动 2582px，触发原 1px 稳定性检查。六帧均无 loading/alert 提示、body 横向溢出为 0。没有丢弃首帧、延长样本数或用正常 viewport resize 排除来覆盖该失败；390 system 及其余十项均 PASS。

宿主原始 GET 响应时序（相对 diagnosis 正式第 1 帧）提供了下一步静态定位范围：当前既有 run `FR-3a67f1773487493aa949` 的 progress 为 -132ms，detail 为 +99ms，impact stage（resultVersion `7032ce131bc57fadce1e`）为 +816ms，report 为 +1111ms，均 HTTP 200；元信息/场景目录/历史目录分别在 -541/-309/-278ms 完成。原脚本仅等待后三类目录来源与页面无加载提示，可能在当前运行详情/影响内容仍在读取时启动了正式六帧。此证据倾向**工具实际就绪门禁不足**，尚不能据此判定最终生产布局存在持续不稳定；也不能直接抹掉本轮真实 FAIL。只读核查使用本轮现存 JSON，没有追加页面/API请求。

本轮 CLI finally 已关闭本组 context 并释放 55324 lease，B 立即交回 token。后续 30秒×3、UI设5、5秒×20、UI恢复30及PAR-02=15回读均 **NOT_RUN**，没有新性能样本或状态导入请求号，也没有 PAR-01/PAR-02 写入。不能把“参数未被本组修改”登记成“已通过真实UI恢复及15回读”。是否修正手工脚本的 diagnosis 运行详情就绪门禁、如何继续批准的性能序列，等待主组明确后续排程；未自动重跑任何组凑通过。

### diagnosis 真实初始就绪门禁修复（仅静态，待主 review）

主组正式收回 B token 后，授权只修改 `tests/manual/r6_browser_responsive.mjs` 的 readiness 与本记录，不改 production。B 继续核对原 6 帧：main.height 均为 664.4px，body.scrollHeight 均为 844，window scrollX/scrollY 均为 0；main.scrollHeight 仅从第 1 帧 763 到第 2 帧 3345，此后连续 5 帧一致。证据符合一次初始默认结果晚到，而非 6 帧内反复抖动；未通过 CSS 固定大高度或滚动位置掩盖。旧记录未采集 main 自身的 scrollTop/scrollLeft，不能倒填为 0；本次脚本仅增加后续采样的元素 scrollTop/scrollLeft 读数。

按主组明确批准的唯一可读 R6 fixture，诊断 source 现在显式要求**两个 viewport 各自本次导航**下的以下真实 GET 均返回 HTTP 200/code 0、非 Service Worker，不能复用前一个 viewport、旧请求或旧 DTO：

```text
/api/v1/fault/workbench
/api/v1/fault/workbench/catalog/scenarios?archived=false&pageNum=1&pageSize=20
/api/v1/fault/workbench/catalog/history?pageNum=1&pageSize=20
/api/v1/fault/workbench/runs/FR-3a67f1773487493aa949/progress
/api/v1/fault/workbench/runs/FR-3a67f1773487493aa949/detail
/api/v1/fault/workbench/runs/FR-3a67f1773487493aa949/stage?stage=impact&resultVersion=<本次真实progress.resultVersion>
/api/v1/fault/workbench/runs/FR-3a67f1773487493aa949/report
```

metadata 的 `latestRunId` 必须是原 `FR-3a67f1773487493aa949`，真实 history DTO 必须包含该 ID；空历史、另一个 run、缺少原 run 来源均不能作为此次 R6 成功。progress/detail/report 的响应 ID 分别匹配原 run；progress 必须表明原成功运行及 diagnosisReady/impactReady，impact stage 的实际请求 query 版本必须等于本次 progress.resultVersion。没有固定等待旧版本 `7032ce131bc57fadce1e`，该值仅是失败轮原实际 URL 证据；新一轮版本取真实响应。

正式六帧开始前还要求真实 DOM：`page-actions` 中“重新加载”按钮可见且非 disabled（UI locked 已解除）；`.progress-panel` 可见、状态文字为“已完成”且 progress 值与本次 DTO 一致；`.network-panel`、`.result-workspace .result-panel` 可见；`.result-panel button.report` 可见且 enabled，证明 report 已应用到 UI，而不是只有响应返回。存在真实查询错误/重试提示时不放行。不访问 Vue/Pinia 内部状态，不增加 production aria、CSS 或接口，不点击加载/报告按钮，不追加任何 API 请求，仅观察产品已发出的嵌套读取与 DOM。

每个正式帧继续核对上述初始来源/DOM 就绪，原 run/resultVersion 不得在六帧间切换。readiness 结果及所匹配源路径、stage/resultVersion、响应完整读取时间、DOM enabled/visible 证据写入本轮 `ready.diagnosis`；不记录完整业务 payload、账号或凭据。

原 240 秒工具预算、6 帧、约 1 秒间隔、无 loading、无 body 横溢、1px 尺寸/scrollWidth/scrollHeight 稳定断言及性能 60 秒门槛均未放宽。没有新增“sleep 到稳定”或连续稳定预筛选，不丢弃首帧，不补第七帧；只有真实初始数据和 UI 都已就绪后，才开始同样的六帧检查。若之后仍改变尺寸，原断言照常失败。

本次未启动 Browser/HTTP/性能/测试/Node 语法执行或参数变更，未触碰生产布局。原 `35eacda1-7c7d-4338-b530-05c082b1be3f` 的 12 项/72 帧 FAIL 及全部 PNG 保留不变；不与旧 11 PASS 或单项补跑合并为全绿。静态修复交主 review，下一次完整新 full12/72 与性能阶段必须等待新 token。

## 最终串行验收与参数恢复交接（2026-10-25）

主组 review 上述真实来源及 DOM 门禁，执行 `node --check` 退出 0 后，重新授予 B 唯一 browser/性能窗口。B 严格按 full12 → 30秒3样本 → 真实系统UI设5 → 5秒20样本 → 真实系统UI恢复30 顺序执行，每个 CLI 退出并关闭 context/lease 后才启动下一个；没有重跑 behavior4、全仓测试、生产构建、服务重启或改阈值。下表是本轮新证据，不覆盖前文旧 FAIL/NOT_RUN 当时记录。

| 阶段 | 本轮证据 | 结果 |
|---|---|---|
| responsive | `data/runtime/r6/61fa2bca-f764-4802-933f-17984c7144df/responsive.json`；宿主 `r6-browser-1792874608258-3b973c` | FULL_MATRIX，12/12 PASS，72/72 新帧，`fullMatrixPassed=true` |
| 默认30秒 | `data/runtime/r6/34554fa6-98eb-445c-8eed-1d4b13498e36/samples.json`；宿主 `r6-browser-1792874915312-89500a` | 3/3 PASS，0 FAIL |
| UI设5 | 宿主 `r6-browser-1792875119585-51f997/group-result.json` | PAR-01 30→5；PAR-02 15→15；SYS-11 |
| 五秒 | `data/runtime/r6/60ee5700-9d87-4d42-93ec-dd0c3299dfff/samples.json`；宿主 `r6-browser-1792875181953-38fe30` | 20/20 PASS，0 FAIL |
| UI恢复30 | 宿主 `r6-browser-1792875526642-8478b5/group-result.json` | PAR-01 5→30；PAR-02 15→15；SYS-12 |

宿主目录前缀均为 `data/runtime/r2/r4-f79ea5c1b6c54e38ae495d840c142013/browser/`。上述五个 CLI 均退出 0；恢复原 exec `30794` 已结束，只有原恢复请求一次，没有重提。主组收回 token 后 B 仅轮询原 exec 和读取既有文件、静态补本文与 SHA，没有再启动 CLI、Browser、HTTP 或测试。无本组在途写入、exec 或 context，token 已交回；服务保持由主组管理。

### 完整响应式与人工看图边界

本轮六页×1440/390，各采六帧，pageerror、违规业务写、越界请求均为 0；唯一正常 viewport resize 单独登记，未删除正式首帧。两个 diagnosis viewport 均实际等到原 `FR-3a67f1773487493aa949` 的本次 progress/detail/同版impact/report 与 UI unlocked/内容就绪后才开始原六帧；原无 loading、无 body 横溢、1px 稳定性门槛保留。

截图索引：`data/runtime/r6/61fa2bca-f764-4802-933f-17984c7144df/screenshot-index.md` 及同名 JSON。主组明确逐张查看本轮 12 张 `RESP-{1440,390}-{situation,resources,planning,diagnosis,knowledge,system}-frame-6.png` 原图，反馈内容可读、导航/内部滚动正常，GIS/规划/诊断真实 DEM 可见，无旧道路错叠。因此登记 **`MAIN_VISUAL_REVIEW=PASS`**，范围仅为这些 12 张原图；不扩展为所有交互、所有地图缩放或全部截图均已人工审查。原采样 JSON 的 `screenshotsReview` 保持原值，本文保留后续人工审查结论，不覆盖原始证据。

### 真实刷新性能分布与状态锚点

| PAR-01 | 新样本数 | PASS/FAIL | P50(s) | P95(s) | max(s) | 原门槛 |
|---|---:|---|---:|---:|---:|---|
| 30秒 | 3 | 3/0 | 32.887 | 34.998 | 34.998 | 每样本≤60秒 |
| 5秒 | 20 | 20/0 | 8.418 | 9.944 | 10.224 | 每样本≤60秒 |

表中数值直接来自两个 `samples.json` 的 distribution，以 nearest-rank 求分位；非 CLI 用例总耗时。计时从真实 POST 发出前的 Node `performance.now` 起，到同快照资源表格内容与真实 OL 地图绘制可见，并核对实际 PNG；没有把导入 ACK 或 API 响应时间当作浏览器渲染。地图与状态栏是否同处 viewport 单独记录，不能将 layout-visible 自动扩展成二者同时在屏内可见。

固定原 task `r4-network-89db2499fcf6`、原 plan `PLAN-5273d94aa08345e4b047d62b915e2928`、资源 `resource-7c8bd11ec30d0ed4`，每个状态构造样本覆盖完整414设备。真实规模仍为132物理节点，HF76/VUHF104对应节点（存在跨制式重叠），不声称150不同物理站。写状态导入均串行 CAS；这些是构造集成状态、非真实遥测。真实 API 外部 writer 与浏览器读回联合验收，不冒充 UI 文件导入验收。原 payload、request、receipt、PNG 均保存在各新组目录；未换 plan 或资源版本，未修改正式60秒来源/需规。

最后五秒样本原 request `r6a-eda65d9e-61ef-4e66-a6e1-415466407e0f`，snapshot `DSS-9a5ce07b39da47ae8b75ceddc391821a`，revision `device-status-0315df7cf87657d1c4025e8c2485e467ab0fc2f5bda64670d82b25769d0b3eaf`，receipt total=414、`data_origin=SYNTHETIC_INTEGRATION`；浏览器表格/地图锚点匹配该快照。旧 HTTP FAIL、旧 responsive FAIL 与 planning 单项补跑原样保留，不与本轮新矩阵或新样本混合。

### 真实 UI 参数切换原号与恢复回读

| 动作 | requestId | operationId | 真实回读 |
|---|---|---|---|
| 30→5 | `df5a05f4-823e-4d89-a2d6-fa6298710688` | `OP-b693890c288e4504bdc90e7fdf73a823` | PAR-01=5，PAR-02=15，SYS-11 |
| 5→30 | `d962b3e7-ccb7-44d2-9062-b90c70d12677` | `OP-60402ec242894a1cada8ddff688537fb` | **PAR-01=30，PAR-02=15，SYS-12** |

两次均调用主组已有 operations 导出，通过真实 admin 系统参数表单提交 CAS，并读取实际参数详情及列表；没有直接后台改值，没有重置全部默认参数。恢复组 `R6-D-restore-thirty-second-refresh` PASS、pageerror=0、CLI exit=0，截图 `r6-d-restore-thirty-second-refresh.png` 与原 JSON 同目录。恢复请求在 token 收回前已启动，收回后只核实原回执；主组无需再次恢复。

### 交接时静态源码 SHA-256

下列是上述 CLI 全部退出后对当前冻结文件的只读 SHA-256，属于交接时源码指纹，不冒充运行前原子采集的全仓版本证明；本次只写本文，没有改这些源码或原报告。

| 文件 | SHA-256 |
|---|---|
| `tests/manual/r6_browser_responsive.mjs` | `e857e00601c87b28db5fba6f9fd9425b44d4fe58557c3f44ba3b36072e7123b8` |
| `tests/manual/r6_browser_acceptance.mjs` | `6c26320371653cb321b884c6479eacf7f33325d9f7d29fc58cbb2870b205768b` |
| `tests/manual/r6_browser_performance.mjs` | `8901cb6117b03f118d63c6812566d2c1533e4e69b59d8d1147bebc5f646bc8c8` |
| `tests/manual/r6_browser_operations.mjs` | `830681e9150552eacfc77f74352b9a12cd23b32b7aee6164b04d4640c409fd0c` |
| `front_design/radio-planning-20261022/src/stores/resource-status.ts` | `102b1e946575d7855eb27747679c3d5a35fcd927314e3edb834a56212446c9f2` |
| `front_design/radio-planning-20261022/src/components/ResourceStatusPanel.vue` | `c839064f7759816f80f6a988e14cf941b11824ee14374fe37aa366a678a7b28d` |
| `front_design/radio-planning-20261022/src/components/GisPlanOperations.vue` | `bc6b6bcb7450bc224f2fb9ef4f889a703057e4f68e21e2722e5f40d70371af20` |
| `front_design/radio-planning-20261022/src/maps/gis-device-layers.ts` | `4e3cac02419dd51f8fb552bf96b92c5cfe7053be34a9a27fecb06ec5bd577465` |
| `front_design/radio-planning-20261022/src/maps/gis-device-status-layer.ts` | `77dec67442c9855f46c698ced3db14eec584b62714845bbd25a4975acf48571d` |
| `front_design/radio-planning-20261022/src/maps/planning-api-layers.ts` | `7222b94a05e51a2d3773e566a45975fd99c29a0a15ca0f0daa95b27fbf2a9636` |
| `front_design/radio-planning-20261022/src/views/DiagnosisView.vue` | `5a5d3352c9bd69c3bc603971ff51e7bbd48433ac30090538537b83a683fed5cb` |
| `front_design/radio-planning-20261022/src/views/SystemView.vue` | `1075a3931d0b9fa1ab08bd93f479ae04e5eef2857c0953fc7704c6d180c0b65b` |
| `algorithm-service/app/device_status_service.py` | `0e1bb919ca15bbf371107aac95b2131b0989bd49a70cf27bc327630c3d84ba1b` |
| `algorithm-service/app/resource_observation_projection.py` | `365dc564084f38d7bdf0bbf2fd25c1b885437783b8732a935658d46824c6db49` |

原报告文件 SHA-256：responsive `cbd2574603364da563e93347e5d75d352b60d4f2f57f2d8ee85c6df1c39d9e48`；30秒 samples `5e79b66260c83d5effca5260b2a1b2df9e2c5d89f23faeba0e96a9c94fe35535`；5秒 samples `5700bcbf578c764be3721e735075518153ddd50680810f07ab0675ef55f21624`；恢复 group-result `8e2df9df32209b5dd3866fc8cae61a4e0394835710e6c313103a5aed33b8b871`。本文的后续摘要没有改写这些文件。

## 窄静态审计：浏览器功能完成声明的核心缺口

仅对照 R6-C §1/§2.3/§5–6、A/C/D/E 最新记录、已落盘 results 与现有 manual；以下5项未由已通过核心链或既定剩余队列覆盖，不能扩记“本轮浏览器功能验收完成”，也不据此判生产缺陷或获得执行授权。

| 必要遗漏 | 现有 entry 与准确边界 |
|---|---|
| F03：同一本轮构造频点的 DISABLE（确认前取消/确认）及原 requestId 历史查询、读取回执/行内回读 | `operations::runFrequencyAdd/Patch/Enable/Duplicate` 仅四项；`maintainFrequency` 只检查本次回执及当前行，ADD默认停用不等于执行DISABLE。当前无停用/历史专用export，需D补范围，不能重复ENABLE替代。 |
| Q03：故障场景文件模板/非法预检/合法整批导入及导入原场景的版本、归档→恢复回读 | `sr56::caseSr5Scenario` 仅GIS标绘配置/保存，未调用“导入场景”或归档/恢复；当前无对应export。资源/任务导入证据不能代替诊断场景导入。 |
| Q04：诊断实际PENDING/RUNNING时取消确认框取消→确认、原run/task终态与冻结输入回读 | `sr56::caseSr5DiagnosisImpact` 只等待SUCCESS并断言两段完成，无取消export；规划取消不替代诊断取消。仅自然运行窗口可验，不延迟桩、不循环重提；原FR报告运行不得拿来重做取消。 |
| K01：已发布知识的真实检索→实体/关系一跳展开收起，代表性相似推荐及空结果 | `sr56::runSr56` 系列只覆盖维护发布链；`responsive::runResponsive` 仅初始来源/布局就绪，无上述交互entry或当前R6结果。需一次有限只读分支，不做全部栏目/查询组合。 |
| K03：独立reviewer无意见驳回校验→有意见REJECTED回读→作者修订再送审 | `sr56::caseSr6ReviewPublish` 固定`approved=true`（约706–708行），无REJECT export；已测撤回不等于驳回。原已发布/回滚CR保持，补验须另批对象边界，不能重跑原发布入口。 |

已排队项另保持待验，不重复算新增遗漏：A `resourceWrites::runResourceWrites`、`system::runSystemResumeCreatedRole`；D上述频率四项、`runDeviceTraceRestore`、`runStatusImportPositive`；E现独占I/A/V及末尾`runPlanningFinalRefresh`，未完成前亦不能总收口。
SR5/SR6原核心链、报告/覆盖主视觉及B新12/72和两组性能证据保持；作者互斥UI不可达、外部协议、ML、筛选笛卡尔积/所有组合不列新增阻断。本次无CLI/Browser/HTTP/测试/重算，仅追加本节，未改production/manual/共享账或干扰E。
