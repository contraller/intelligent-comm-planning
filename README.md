# 短波/超短波智能规划系统

提供 GIS 态势、设备资源管理、无线网络规划、故障诊断、知识图谱和系统管理。当前维护前端为 `front_design/radio-planning-20261022/`，后端采用 Python、FastAPI、SQLAlchemy 和 Alembic。

本分支用于开发维护；正式交付源码位于 [codex/delivery](https://github.com/contraller/intelligent-comm-planning/tree/codex/delivery)。

## 使用系统

1. 从 [GitHub Releases](https://github.com/contraller/intelligent-comm-planning/releases/latest) 下载完整的 `RadioPlanning_Windows_x64_portable.zip`。
2. 解压后双击“启动系统.cmd”，通过浏览器访问系统；使用结束后运行“停止系统.cmd”。
3. 默认地址为 `http://127.0.0.1:18480/`，实际地址以包内 `app/data/runtime/访问地址.txt` 为准。

便携包自带运行环境、前后端、算法、地形和道路数据，使用时无需另装 Python 或 Node.js。GitHub 自动生成的 Source code 归档用于源码查看，不是完整便携包。

更新已有实例前先安全停止并备份、保留 `app/data/runtime`，其中包含本机账号、数据库、任务、方案和缓存。具体操作见[交付运行入口说明](docs/design/交付运行入口说明.md)。

## 文件导航

| 内容 | 位置 |
| --- | --- |
| 当前需求对照 | [无线需规v3(3).docx](<无线需规v3(3).docx>)、[原测试用例](测试用例.doc) |
| 接口与页面契约 | [接口文档](docs/design/03_接口文档.md)、[页面接口矩阵](docs/design/13_新版前端接口对照矩阵.md) |
| 实施与验证记录 | [后端接口实施进度](docs/design/12_后端接口实施进度.md) |
| 后端与算法 | [algorithm-service](algorithm-service/README.md)、`scripts/` |
| 当前前端 | [前端开发说明](front_design/radio-planning-20261022/README.integration.md) |
| 数据来源与结构 | [data](data/README.md)、[原始需求资料](docs/input/README.md) |
| 用户操作与演示 | [用户手册](docs/output/短波超短波智能规划系统用户手册_V1.0_20261028.docx)、[演示步骤](演示资料/00_演示讲稿与操作步骤.txt) |
| 便携包制作 | [Windows 打包说明](packaging/windows/README.md) |

## 开发流程

1. 对照需规和当前接口契约确定本次修改范围。
2. 在现有后端、算法和唯一维护前端中实现，接口变化同步文档与页面调用。
3. 完成相关定向测试，分别记录真实 HTTP、浏览器操作及未验证项。
4. 将确认的运行代码和公开资料同步到交付分支，再构建、校验并发布完整便携包。

源码推送、交付分支同步、便携包发布和已安装实例更新分别进行。开发实例与便携实例各自保存数据库、账号和运行记录。

当前主要使用构造联调资源及模型预测；真实设备协议、现场实测和目标麒麟平台兼容性按相应专项核验。功能实现与正式验收结果以对应记录为准。
