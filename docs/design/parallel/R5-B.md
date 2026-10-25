# R5-B 冻结覆盖后端计算与状态契约

## 内部审批与白名单

2026-10-24：主已批准本组下列八个文件及 V4 DTO，允许开始实施。当前共用工作区的既有 R4 成果保留。本组不修改补充 JSON、补充脚本、共享 main、迁移、公共类型及 docs03/12/16；接口总台账由主统一维护。

1. `algorithm-service/app/frozen_coverage_engine.py`
2. `algorithm-service/app/frozen_coverage_service.py`
3. `algorithm-service/app/frozen_coverage_router.py`
4. `tests/test_frozen_coverage_engine.py`
5. `tests/test_frozen_coverage_service.py`
6. `tests/test_frozen_coverage_bandwidth_service.py`
7. `tests/test_frozen_coverage_api.py`
8. `docs/design/parallel/R5-B.md`

所有手工修改使用 apply_patch，UTF-8 无 BOM。不删除文件、不复制依赖、不提交代码、不启动或重启服务、不操作端口、不连接运行库。

## 批准的最小契约

- 新计算引擎为 `V01-4`，新结果为 `schema_version: 2`。选择请求及不可变选择 V1 的格式和摘要算法不变。
- 主在新隔离库通过现有资源版本提交流程显式采用 A 的 `data/supplements/coverage_rx_bandwidth_v1.json`。仅四个原缺失型号补单值字符串 `3`，不回写 CSV、旧资源、旧 Plan、旧选择或旧缓存。
- 冻结型号来源字段为 `bandwidth_origin=SYNTHETIC_COVERAGE_ASSUMPTION`、`bandwidth_source_id=R5-HF-RX-3KHZ-V1`、`bandwidth_source_sha256=<补充 JSON 原始字节 SHA256>`、`bandwidth_source_note=<profile.notice>`、`bandwidth_original_khz=''`，保留原 `source_doc`。
- V4 的 options/result 每个设备均必有 `bandwidth_provenance`：普通型号为 null；构造型号为 `{origin, source_id, source_sha256, source_note, original_khz}`，与上述五字段对应。来源残缺或非法必须拒绝，不能静默降级。
- 设备状态为 `COMPLETE / UNAVAILABLE / SKIPPED`，保留 `reasons`，新增 `reason_code`：`null / NO_ASSIGNED_FREQUENCY / RX_BANDWIDTH_UNKNOWN / RX_BANDWIDTH_SELECTION_REQUIRED / FROZEN_PARAMETERS_UNKNOWN`。
- 先验证冻结结构、引用、已给参数及身份，再对无活动频率设备返回 SKIPPED；不要求其具备缺失的射频参数，计算列表为空、radio_parameters 为 null。rx_bandwidth 仍返回原值及来源枚举。
- 必填 summary 为 `{total, eligible, complete, unavailable, skipped}` 非负整数，`total=eligible+skipped`、`eligible=complete+unavailable`。按 eligible 判定总体状态；零 eligible 为 NOT_APPLICABLE，有 eligible 且全部完成为 COMPLETE，部分完成为 PARTIAL，全部不可算为 UNAVAILABLE。原生异常仍导致作业 FAILED，不归为 SKIPPED。
- 缓存 GET 增加可选 `engine_version`：V01-1/2/3/4；省略取 V4。新计算请求不扩字段。旧请求号重放旧作业，历史缓存显式按旧版读取，原字节及旧语义保持。V01-1/2 不接受带宽选择引用；V01-3 可引用其旧选择。同冻结来源的旧选择可用于 V4，但不可跨方案或资源版本。

## 限额及验证边界

保持现有 1024 设备、4096 设备频率组合、1000 万射线步、25 万输出格、64 在途作业及单 worker 上限；不扩计算半径、不降采样、不改频率分配、拓扑或原校验门槛。原方案的 252 活动设备中 226 可算、26 缺带宽，208 无活动频率为对照事实，不硬编码为新方案计数。

测试只使用 F 盘本树独立 runtime；覆盖持久服务沿既有目录门禁使用 `data/runtime/r2/r4-r5-b-*` 兼容隔离路径，不放宽生产目录检查。分类、非法来源、引用与限额、旧缓存字节/重放、API 严格校验分层验证；测试桩与小 DEM 原生计算分别记录，完整 DEM/真实 HTTP/浏览器及耗时由主集成验证。

## 实施与证据

- 已读取 docs12、四个覆盖实现文件、带宽 schema 及现有五组专项测试；已直接向 C 同步最终 DTO。
- 已完成 V4 引擎、设备分类/原因、五项统计、构造来源返回、历史缓存显式版本读取及原号重放兼容。未改带宽选择 service/schema、共享文件或认证文件。
- 四文件专项：`tests/test_frozen_coverage_engine.py`、`tests/test_frozen_coverage_service.py`、`tests/test_frozen_coverage_bandwidth_service.py`、`tests/test_frozen_coverage_api.py`，**293 passed，0 失败，0 跳过，211.65 秒**。只有一条既有 Starlette/TestClient 对 httpx 的弃用警告，未调整依赖。
- 证据：`data/runtime/r2/r4-r5-b-1792835991959/results.xml`；临时文件和测试独立 SQLite 均在同目录的 `pytest-temp/`，没有连接运行库。
- 命令：`.venv/Scripts/python.exe -B -m pytest <上述四文件> -q -p no:cacheprovider --basetemp <证据目录>/pytest-temp --junitxml <证据目录>/results.xml`；进程设置 `PYTHONDONTWRITEBYTECODE=1`。
- 覆盖小 DEM 的原生 HF/VUHF、受控 worker/原子发布、选择/缓存历史原字节、LOCAL 可信上下文测试独立库、API 授权注入严格请求等分层用例。它们不是主现场完整 DEM、真实 LOCAL 登录、真实 HTTP 服务或浏览器验收；该部分由主在独立新库及 `.23` 自有入口继续验证。
- 八文件均已严格解码验证 UTF-8 无 BOM，`git diff --check` 通过。本组未提交代码，未启动或重启服务，未操作端口，未触碰 `.22`、原 5183 或其运行库。

## 生产代码冻结

已告知主可启动本轮独立入口；后续只补本记录，不继续修改生产逻辑。如需修复真实缺陷，将先告知主重跑边界。

| 文件 | SHA256 |
|---|---|
| `algorithm-service/app/frozen_coverage_engine.py` | `3b47bf8137182bc04b48a65df17b8303433e220430464e454a7c8f208fe2514e` |
| `algorithm-service/app/frozen_coverage_service.py` | `a304ba10e258db7e6006f7a701e621ffa1ebd7f9e8514cf8332709b389bb385f` |
| `algorithm-service/app/frozen_coverage_router.py` | `aabd9ec5358e3c2b9a3f55b35a330fa125c467fec0909d7e791ecf4cb158ea5d` |

主运行目录 `data/runtime/r2/r4-372edc854b934c27a0cbffc30c6c79f2` 与 `.23:5323/8123` 由主所有，本组未操作。其他并行会话的认证/密码和 `.22` 变更保留，本批专项未遇到密码规则导致的失败。
