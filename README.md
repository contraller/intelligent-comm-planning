# 短波／超短波智能规划系统 · 源码交付

本分支为当前实现的独立源码快照，来源提交 `9cd7cfb0724a30a533944d66eb3d097c0e1e9484`，不是全部测试用例已验收通过的声明。

## 交付内容

- `algorithm-service/`：后端接口、SQLAlchemy模型、Alembic迁移及依赖清单。
- `front_design/radio-planning-20261022/`：唯一使用的Vue3／TypeScript前端、MVT道路、DEM图片及字体许可。
- `scripts/`、`alt_steiner/`：规划、传播、覆盖、诊断、图谱及初始化／启动代码。
- `data/`：现有算法必需的地形、道路、地物、字典和构造联调数据。
- `tests/`：随源码保留的测试代码；手工验收脚本中的本机地址和运行目录须在目标环境另行配置。
- `docs/design/03_接口文档.md`、`docs/design/13_新版前端接口对照矩阵.md`：接口和页面操作契约。
- `docs/input/`、`docs/output/`及其余保留的设计资料：需求依据和软件说明。

## 安装与启动

首次使用请按 `front_design/radio-planning-20261022/README.integration.md` 安装依赖、执行显式数据库迁移和资源初始化，再启动新版前端及后端。

生产构建入口为新版前端目录的 `npm run build -- --mode integration`；同源启动入口为仓库根目录的 `scripts/serve_delivery.py`，必须配置指向已存在且已迁移数据库的 `DATABASE_URL`。

分支不携带开发电脑的数据库、账号口令或私有密钥，目标环境必须自行初始化身份和权限。依赖按清单安装，不附带`.venv`、`node_modules`或本机缓存。

## 边界

本分支不包含个人开发日志、协作台账、阶段汇报、旧前端源码或历史交接副本；采用独立Git历史，未继承开发日志提交。`old_front/README.md`仅为旧前端隔离边界的说明，不提供旧页面。

构造联调数据、算法预测、系统受理和真实设备观测／执行须按接口中的来源与状态区分。剩余验收范围以实际实现、项目需规及双方确认的验收口径为准。
