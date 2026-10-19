# 短波/超短波智能规划前端

## 首个任务保存接口联调

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

本次联调使用受 `FRONTEND_INTEGRATION_DEMO=1` 控制的固定身份。正式登录、任务列表、“打开任务”、导入、保存回执和运行 SR4 尚未纳入该按钮闭环。
