# 短波/超短波智能规划系统

提供 GIS 态势、设备资源管理、无线网络规划、故障诊断、知识图谱和系统管理。当前维护前端为 `front_design/radio-planning-20261022/`，后端采用 Python、FastAPI、SQLAlchemy 和 Alembic。

本目录维护系统源码、必要设计说明和导入例程。系统在本机离线运行，完整便携程序与配套文档按受控清单交付。

## 使用系统

1. 通过项目指定的受控介质取得完整的 `RadioPlanning_Windows_x64_portable.zip`，在本地核对交付清单和校验文件。
2. 解压后双击“启动系统.cmd”，通过浏览器访问系统；使用结束后运行“停止系统.cmd”。
3. 默认地址为 `http://127.0.0.1:18480/`，实际地址以包内 `app/data/runtime/访问地址.txt` 为准。

便携包自带运行环境、前后端、算法、地形和道路数据，使用时无需另装 Python 或 Node.js。源程序目录及打包脚本不能直接作为可运行便携实例。

更新已有实例前先安全停止并备份、保留 `app/data/runtime`，其中包含本机账号、数据库、任务、方案和缓存。具体操作见[Windows 便携包说明](packaging/windows/README.md)。

## 文件导航

| 内容 | 位置 |
| --- | --- |
| 文档导航 | [docs](docs/README.md) |
| 维护约定 | [PROJECT_RULES.md](PROJECT_RULES.md) |
| 接口与页面契约 | [接口文档](docs/design/03_接口文档.md)、[页面接口矩阵](docs/design/13_新版前端接口对照矩阵.md) |
| 后端与算法 | [algorithm-service](algorithm-service/README.md)、`scripts/` |
| 当前前端 | [前端开发说明](front_design/radio-planning-20261022/README.integration.md) |
| 数据来源与结构 | [data](data/README.md)、[原始需求资料](docs/input/README.md) |
| 导入例程 | [系统例程导入指南](演示资料/系统例程导入数据/导入使用指南.html) |
| 便携包制作 | [Windows 打包说明](packaging/windows/README.md) |

## 开发流程

1. 对照需规和当前接口契约确定本次修改范围。
2. 在现有后端、算法和唯一维护前端中实现，接口变化同步文档与页面调用。
3. 完成相关定向测试，分别记录真实 HTTP、浏览器操作及未验证项。
4. 核对运行代码与交付资料，构建并校验完整便携包，按受控清单通过指定介质移交。

程序版本、资料更新、便携包制作及已安装实例更新分别管理。开发实例与便携实例各自保存数据库、账号和运行记录。

当前主要使用构造联调资源及模型预测；真实设备协议、现场实测和目标麒麟平台兼容性按相应专项核验。功能实现与正式验收结果以对应记录为准。用户手册、研制总结及验收材料以完整本地交付清单为准。
