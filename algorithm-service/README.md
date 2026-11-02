# 后端服务开发说明

服务入口为 `algorithm-service/app/main.py` 中的 `app.main:app`，提供资源、GIS、网络规划、故障诊断、知识图谱、本地认证及系统管理接口。规划与传播算法位于根目录 `scripts/`。

接口字段、错误码和异步任务规则统一见[接口文档](../docs/design/03_接口文档.md)，页面调用见[接口对照矩阵](../docs/design/13_新版前端接口对照矩阵.md)。

## 环境与数据库

- Python 3.12；生产依赖见 `requirements.txt`，开发和测试依赖见 `requirements-dev.txt`。
- 数据层使用 SQLAlchemy 2.x、Alembic；Windows 便携实例使用 SQLite，PostgreSQL/PostGIS 按目标环境单独验证。
- 数据库连接通过 `DATABASE_URL` 指定。迁移、资源初始化和身份配置分别执行，启动服务不代替这些准备步骤。
- 当前迁移源码终点为 `0023_local_identity_system`，实际以 `migrations/versions/` 和 `alembic heads` 为准；实例数据库版本需单独核对。

在仓库根目录查看迁移信息：

```powershell
python -m alembic -c algorithm-service/alembic.ini heads
python -m alembic -c algorithm-service/alembic.ini current
```

新开发环境按依赖清单安装；已有实例升级前先备份并明确目标数据库。数据库、账号、密钥和运行输出保存在各自实例中。

## 运行入口

| 用途 | 入口 |
| --- | --- |
| 最终用户使用 | 完整便携包的“启动系统.cmd”与“停止系统.cmd” |
| 源码同源静态页面与 API | [scripts/serve_delivery.py](../scripts/serve_delivery.py) |
| 隔离开发验收 | [scripts/serve_internal_workspace.py](../scripts/serve_internal_workspace.py) |
| 单独调试 FastAPI | `python -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8001` |

源码启动前需配置已存在且完成迁移、初始化的数据库，以及所用认证模式、允许同源地址和隔离运行目录。当前本地账号模式为 `LOCAL_PASSWORD`；`INTEGRATION` 仅用于显式构造联调。

内部验收入口要求显式传入 `--runtime-root`、`--database-url` 和 `--key-file`，复用所属实例的配置。便携实例与开发实例的数据独立，具体入口见[运行说明](../docs/design/交付运行入口说明.md)。

## 修改与验证

任务输入、资源、方案、故障场景和知识发布均保留各自版本。写操作沿用权限、会话、CSRF、来源校验和幂等回执；接口变更同步前端调用与契约。

按本次修改运行相关测试，分别记录自动化测试、真实 HTTP、浏览器操作的结果。测试代码位于根目录 `tests/`、本目录及前端 `tests/`；构造测试与现场设备验证分别记录。
