# 前端开发说明

本目录是唯一维护的 Vue 3、TypeScript、Vite 前端，包含 GIS 态势、资源管理、网络规划、故障诊断、知识图谱和系统管理页面。

最终用户使用完整 Windows 便携包；本文件说明源码开发。接口字段及页面流程见[接口文档](../../docs/design/03_接口文档.md)与[接口对照矩阵](../../docs/design/13_新版前端接口对照矩阵.md)。

## 环境与常用命令

Node.js 要求 `>=22.12.0`，依赖版本由 `package-lock.json` 固定。新检出目录执行 `npm ci`，已有目录复用已安装依赖。

以下命令在本目录执行：

```powershell
npm run typecheck
npm run build -- --mode integration
```

`npm test` 使用 Vitest；按本次修改选择 `tests/` 下的相关文件。前端构建已包含类型检查，正式便携包由根目录 [packaging/windows](../../packaging/windows/README.md) 统一装配和校验。

## 开发联调

先按[后端说明](../../algorithm-service/README.md)准备隔离后端、数据库和身份，再设置实际代理地址。例如：

```powershell
$env:VITE_BACKEND_PROXY_TARGET='http://127.0.0.1:8001'
npm run dev -- --mode integration --port 5184 --strictPort
```

示例端口按实际开发实例配置；本地账号模式须将前端访问地址纳入后端允许同源集合。`integration` 是 Vite 的 HTTP 构建模式名称，身份仍由后端认证配置决定。

既有内部验收通过根目录 [scripts/serve_internal_workspace.py](../../scripts/serve_internal_workspace.py) 使用已登记的运行目录、数据库和密钥。源码同源静态入口为 [scripts/serve_delivery.py](../../scripts/serve_delivery.py)，最终用户入口见[交付运行说明](../../docs/design/交付运行入口说明.md)。

## 地图与数据

- DEM 元数据及图片：`public/maps/sr4-terrain.json`、`sr4-terrain.png`。
- MVT 道路：`public/maps/demo-roads-tiles/`；来源与许可见 [ATTRIBUTION.md](public/maps/ATTRIBUTION.md)。
- 资源详情和历史方案按服务端版本读取，缺失值保留未知；读取失败不切换为演示答案。
- 页面、地图和冻结结果保持同一来源。图层显隐与浏览操作不触发规划重算。

开发数据库、账号、`node_modules/`、本机缓存和运行记录分别保管，不纳入源码交付。定向测试、真实 HTTP 和浏览器实测按实际执行情况记录。
