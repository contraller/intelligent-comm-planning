# SR4 联调页

该页用于验证一条真实的 SR4 纵向链路：保存任务需求与干扰源快照、提交计算、轮询进度、查看方案地图及表格、修改输入后重算。它不替代正式的任务/资源台账和身份认证。

## 本机启动（PowerShell）

在仓库根目录运行：

```powershell
$env:SR4_INTEGRATION_DEMO='1'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8000
```

在另一个终端进入 `front_design/radio-planning`：

```powershell
$env:VITE_SR4_LIVE='1'
npm run dev -- --port 5173
```

打开 `http://127.0.0.1:5173/#/sr4-live`。Vite 开发代理将 `/api/v1` 转发至本机 8000 端口。两个开关默认关闭；联调接口没有正式登录鉴权，不能以此配置对外网开放 Python 服务。

## 数据语义

- 任务场景和台站/设备/DEM 等基础数据取自后端当前数据集；页面可改该任务的通信需求优先级、必达性、速率与最低可靠性。
- 干扰源可改位置、频率、功率与启用状态；其余字段沿用当前数据集。保存时服务端校验并写入 `data/runtime/sr4_snapshots/`，生成新的 `snapshot_id`。
- 提交计算必须携带最新 `snapshot_id`。首次运行或输入/基础数据变更时，“保存并运行 SR4”会先保存资源版本，再提交返回的 `snapshot_id`；也可单独点击“保存资源版本”。后端比对数据集哈希，拒绝过期快照；任务需求和干扰源从保存的快照进入 `sr4_flow.run`，不会修改原始 CSV。
- `GET /api/v1/plan/tasks/{job_id}` 提供实际计算阶段，完成后通过 `GET /api/v1/plans/{solution_id}` 读取节点、链路、冲突和干扰结果。修改输入后，旧方案明确标记为过期，点击“保存并运行 SR4”即可生成新版本并重算。
- 地图使用 `data/results/current_dem/demo_data.json` 中当前 DEM 的彩色晕渲成果，由 `npm run prepare:sr4-terrain` 导出为 `public/maps/sr4-terrain.png` 和地理范围元数据。OpenLayers 将 EPSG:4326 地形重投影到地图视图 EPSG:3857，再叠加台站、链路和干扰源；它不是在线瓦片服务。
- 导出时会核对算法正在读取的 `data/raw/dem/dem_current.json` 来源哈希；页面也会对比服务端当前 DEM 哈希。更换 DEM 后须重新生成地形图，并重新保存任务/资源快照。

## 尚未覆盖

当前是独立联调页，并未接入外包前端的正式 HTTP 工作区、统一身份/权限、完整资源 CRUD 或跨端版本数据库。计划结果没有自动回写外包前端的原有 Mock 方案库。正式联调需要由同源业务网关实现鉴权与资源主数据，再把这些端点的版本契约接入正式规划页。
