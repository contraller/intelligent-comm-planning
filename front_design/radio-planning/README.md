# 短波/超短波智能规划前端

## SR4 HTTP 联调

开发配置 `.env.development` 已启用 HTTP 数据模式，并将 `/api/v1` 代理到 `http://127.0.0.1:8001`。先按 `algorithm-service/README.md` 启动后端，再启动前端：

```powershell
cd front_design\radio-planning
npm run dev
```

打开终端显示的本地地址，进入“网络规划”。页面完成资源和参数读取后，在“任务输入”面板点击“保存任务”。成功反馈包括：

- 状态由“新任务”变为“已保存任务”；
- “输入版本”显示后端返回的版本号；
- 页面提示“任务输入已保存；规划需单独提交。”；
- 浏览器网络面板中的 `PUT /api/v1/task-inputs/{task_id}` 返回 HTTP 200。

保存后可继续提交 SR4、轮询作业、查看地图与表格、保存方案、打开历史方案、对比及导出。不可行结果仍可保存为 `REFERENCE`，但不能确认；页面应显示服务返回的 `3001` 缺口，不把它当成规划成功。父方案的设备级调整由“方案调整与对比”步骤提交，结果仍绑定原任务和冻结来源。

正式规划页的底图使用 `public/maps/sr4-terrain.png`，进入页面时会将同目录元数据与后端资源上下文返回的当前 DEM 哈希和范围核对。若 DEM 更新，先运行 `npm run prepare:sr4-terrain` 重新生成静态资源；不一致或图片加载失败时页面提示错误并保留站点、链路及本地道路。地形底图不等于无线覆盖图，当前后端尚未提供覆盖栅格。

后端须先设置项目目录下的 `DATABASE_URL`、启用仅供本地联调的 `FRONTEND_INTEGRATION_DEMO=1`，并执行 Alembic `upgrade head`；启动命令见 `algorithm-service/README.md`。当前固定身份不是正式登录。现有数据实跑会产生频率冲突，返回 `3001`；这份数据不能用于验证“确认正式方案成功”分支。

需要重复验证真实 HTTP 契约时，先启动本地后端，再执行：

```powershell
cd front_design\radio-planning
$env:SR4_LIVE_BASE_URL='http://127.0.0.1:8001'
npm run test -- tests/planning-api-http.test.ts
```

此可选测试只允许本地服务，会在联调数据库创建任务并运行两次 SR4，检查保存、轮询、方案回读、导出、对比及确认分流；不设置 `SR4_LIVE_BASE_URL` 时仍只运行隔离测试。2026-10-21 已通过真实 HTTP 契约测试；真实浏览器按钮点击和地图视觉验收仍需执行。
