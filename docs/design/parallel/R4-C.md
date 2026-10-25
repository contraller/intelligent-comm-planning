# R4-C 已发布图谱相似推荐

日期：2026-10-24。起点 `main@0a8f15d`，用户已内部批准本组四文件独占写集；仅补现有内部缺口，不依据《测试用例》扩张验收。

## 所有权与契约

- 修改 `algorithm-service/app/kg_frontend_service.py`；新增 `algorithm-service/app/kg_similarity.py`、`tests/test_kg_frontend_similarity.py` 和本记录。共享台账由主集成汇总，本组不写 docs03/12/16。
- 已有文件修改前确认严格 UTF-8、无 BOM；新增文件使用 UTF-8 无 BOM。使用 apply_patch 局部补丁，不覆盖旧文件，不操作 Git 提交或重置。
- 沿用 `GET /api/v1/kg/workbench/browse/search`。现有精确匹配只要存在结果，即使请求页为空，也不调用推荐；空检索保留原列表语义且不调用推荐。
- 非空检索无命中时仍返回 `items=[]`、`total=0`、`code=4001`；`similar` 最多五条 `{id,name,category,type}` 原快照摘要，去重且不计入命中。详情缺失仍为 404/4001，不替换成推荐实体。
- 仅读取请求版本的数据库发布快照；不读草稿、其他版本或旧图谱缓存。候选服从分类和类型过滤，关系依据的两端均须在所选分类内。现有 `knowledge.view` 路由门禁保持，未新增角色或分类授权语义。
- 不改响应 schema、旧 KG 原生接口、共享 HTTP、数据库结构、权限、SR4/SR5 数值门槛。无 ML 训练、模型准确率或外场实测声明。

## 推荐规则与解释

1. NFKC、大小写和标点分词归一化，仅用于比较；原字段不改写。
2. 原名称、描述、关键词、非编号属性值与 `kg_display.search_aliases` 的现有中文 label/别名提供依据。来源和编号不参与纠错；通用类型别名、空属性/未知属性值和“未配置中文名称”提示不作为依据。
3. 固定分数：归一化文本包含 95；多词全部满足 90；候选自身有有效词锚点、其余词由同域一跳真实关系补足 85；长度至少四字符的一次增删改或相邻换位 80；中文二元词片 70。
4. 中文词片要求查询为至少四字的连续中文，至少两个共同词片，覆盖查询词片至少 75%、覆盖依据文本词片至少 60%。不符合准入条件的候选不输出。
5. 每个查询词都必须有依据；关系证据不足以单独荐出缺少自身锚点的实体。空白、纯标点、泛词、编号样式和无关词返回空推荐。单个不足四字符的查询不做推荐；多个词组合须全部有据。
6. 内部解释含实际实体编号、字段路径、原字段或受控别名、匹配方法；关联依据另外保留真实关系编号。分数及解释不进入 API，不扩前端四字段契约。
7. 按分数降序、实体编号升序排序，上限五条；无随机值和跨请求索引，发布/回滚后不会复用旧版候选。

## 测试隔离与执行记录

- 全部测试临时目录、SQLite、缓存和报告限定于 `F:/work/project2026-1/data/runtime/r4/R4-C/<唯一运行号>/`；禁用 Python 字节码及 pytest 默认缓存。测试默认数据库工厂和旧图谱加载器设为禁止访问，仅数据库专项显式注入新建隔离工厂。
- 新数据库只含构造版本、回滚版本和未发布草稿，检索前后核对数据库字节不变。真实构建器专项仅从仓库源资料建立内存图谱，不接触现有运行库。
- 最终执行：`tests/test_kg_frontend_similarity.py` **72 passed / 0 failed / 0 skipped，10.34 秒，退出码 0**。逐用例结果在最终 `results.xml`，覆盖推荐四类依据、稳定排序/上限、拒荐边界、精确命中/空查询不调用推荐、三域/类型过滤、严格摘要契约、SQL版本/回滚版本读取/草稿隔离及只读性。不把构造回滚快照读取说成真实审核回滚链已执行。
- 未执行：旧中文/回滚整套（其夹具硬编码 `data/runtime/tmp`，本组不改）；真实 HTTP、权限端到端、实际页面、完整回归及压力测试。主集成负责全链和页面验证。
- 权限边界目前为源码审查：现有路由在调用 browse 前执行 `integration_identity.require(request, "knowledge.view")`；本组不导入 main 或启动服务，不将该审查登记为实际权限请求通过。

### 各轮实际结果

下列目录均在 `data/runtime/r4/R4-C/` 下，每轮保留 `pytest.log` 和 `results.xml`，不覆盖或删除失败证据；不同轮次不累加为最终通过数。

| 目录 | 命令差异与实际状态 |
|---|---|
| `run-ecc6e9472d7c4f8d83dc7457cfbe5f65` | 默认 Anaconda `python -m pytest` 收集失败，缺少 fastapi；0 条业务用例执行，1 个收集错误，退出码 2。未安装或复制依赖 |
| `run-c0e2a784d34a4753a9e856d4dfafb87a` | 改为只读复用项目 `.venv/Scripts/python.exe -B`；首轮功能专项 64 passed，12.02 秒，退出码 0 |
| `run-68f091bd538b40e1a67cbf7b96c66f23` | 新增拒荐用例，`-k 'missing_attribute_placeholders or unconfigured_type_hint'`；6 failed / 2 passed / 64 deselected，9.37 秒，退出码 1。复现占位值/未知类型提示误荐，修复 helper，未放宽断言 |
| `run-7d2b429d8242470d847857facc2a4091` | 最新源码完整专项 72 passed，10.34 秒，退出码 0；原有及新增断言均保留 |

最终命令在仓库根目录执行，使用新 GUID，`tmp` 执行前不存在：

```powershell
$r4Run = Join-Path (Get-Location) ('data/runtime/r4/R4-C/run-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $r4Run
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTEST_DISABLE_PLUGIN_AUTOLOAD = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:TEMP = $r4Run
$env:TMP = $r4Run
$env:DATABASE_URL = 'sqlite:///' + $r4Run.Replace('\', '/') + '/unopened-default.sqlite'
$env:SR6_STORE_PATH = Join-Path $r4Run 'absent-default-legacy.json'
$env:AUTH_MODE = 'OFF'
$env:FRONTEND_INTEGRATION_DEMO = '0'
$env:RESOURCE_DATASET_MODE = 'file'
& ./.venv/Scripts/python.exe -B -m pytest tests/test_kg_frontend_similarity.py -q -p no:cacheprovider --basetemp "$r4Run/tmp" --junitxml "$r4Run/results.xml" 2>&1 | Tee-Object -FilePath "$r4Run/pytest.log"
```

### 源码与静态核对

- 四个白名单文件严格 UTF-8、无 BOM、无行尾空白；`git diff --check -- <四文件>` 通过。现有服务仅增加 import、零命中推荐分支及 similar 赋值；原精确匹配、graph/entity/device 分支未改。
- 最终测试源码 SHA-256：`kg_frontend_service.py` 为 `73B0AC6D7F90AF0E7CB47FCEE9A87CD50633445DB4BFF50E9D170D6C36C7507D`；`kg_similarity.py` 为 `03FB145F26DCD2F92E3F07345E1AA5D3D47E290FAB2E427066E48D25E8F7CA23`；专项测试为 `ABE17ED11EEF01B7B4267A22750E176B2FA474BB4E95D6F016A18C24EC517683`。
- 主集成可用现有新版前端验证：精确词“话音”应保留 items、不荐；拼写词“哈里斯公同”在设备知识/Manufacturer 过滤下应返回原实体 Harris Corporation 的 similar 摘要、内层 code4001；无关词“紫色月球烘焙器”应 items/similar 均为空。这些构建器用例已在内存专项执行，真实发布库是否含该实体须以其实际版本为准。

## 剩余边界

- 这是有拒荐门槛的确定性规则推荐，尚无标注语料召回率/准确率评测。保守的编号和短词限制可能减少召回；候选不是事实结论或精确命中。
- 本组不读写任何现有运行库、不操作原5183、不启动服务、不复制依赖，不物理删除文件；所有真实集成结论由主集成另行登记。
