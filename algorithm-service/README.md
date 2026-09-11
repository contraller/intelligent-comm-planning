# 算法服务骨架

本目录保存课题组侧 Python 算法服务。第一版先实现候选部署点筛选接口，后续逐步补充路由规划、频率分配和故障诊断。

## 本地验证

```powershell
python -m pytest tests
```

## 启动服务

安装依赖后启动：

```powershell
pip install -r algorithm-service/requirements.txt
python -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8000
```

当前接口：

- `GET /health`
- `POST /api/v1/plan/candidate-sites`

接口样例见 `docs/api/sample_requests/` 和 `docs/api/sample_responses/`。
