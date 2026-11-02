# 短波/超短波智能规划系统

本分支为正式交付源码，包含当前前后端、算法、运行数据资源及公开使用说明。程序版本以便携包内 `package-manifest.json` 为准。

## 使用系统

1. 从 [GitHub Releases](https://github.com/contraller/intelligent-comm-planning/releases/latest) 下载完整的 `RadioPlanning_Windows_x64_portable.zip`。
2. 解压后双击“启动系统.cmd”，就绪后通过浏览器使用；“停止系统.cmd”安全关闭本目录服务。
3. 默认地址为 `http://127.0.0.1:18480/`，实际地址以 `app/data/runtime/访问地址.txt` 为准。

便携包自带 Python 运行环境、构建后的前端、后端、算法、地形和道路数据，无需另装 Python 或 Node.js。Source code 归档和 `packaging/windows/` 脚本目录用于源码开发，不是完整便携包。

更新已有实例前先安全停止并备份、保留完整 `app/data/runtime`。本机账号、任务、方案及缓存独立保存，源码推送不会自动更新已安装程序或同步数据库。

## 文件导航

| 内容 | 位置 |
| --- | --- |
| 运行与升级 | [交付运行入口说明](docs/design/交付运行入口说明.md) |
| 用户操作 | [用户手册](docs/output/短波超短波智能规划系统用户手册_V1.0_20261028.docx) |
| 近期专项验证 | [设备详情面板实测记录](docs/review/设备详情面板实测记录_20261102.md) |
| 演示与导入 | [演示讲稿和操作步骤](演示资料/00_演示讲稿与操作步骤.txt) |
| 接口契约 | [接口文档](docs/design/03_接口文档.md)、[页面接口矩阵](docs/design/13_新版前端接口对照矩阵.md) |
| 后端与前端开发 | [后端说明](algorithm-service/README.md)、[前端说明](front_design/radio-planning-20261022/README.integration.md) |
| 完整便携包制作 | [Windows 打包说明](packaging/windows/README.md) |

## 源码开发

后端使用 Python、FastAPI、SQLAlchemy、Alembic；前端使用 Vue 3、TypeScript、Vite，Node.js 要求不低于 22.12.0。

在已配置数据库和身份的开发环境中完成联调、定向测试及前端构建后，再制作完整便携包。交付分支不携带开发电脑的账号、密钥、业务数据库或个人日志。

当前资源主要用于构造联调，规划、覆盖和诊断结果保留各自来源与版本。真实设备协议、现场实测和麒麟目标平台兼容性按相应专项核验；具体测试结果以实际记录为准。
