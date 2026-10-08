# Python 算法服务

本服务提供 SR-4 规划、SR-5 故障诊断、SR-6 知识支撑及资源查询接口。入口为 `app.main:app`，OpenAPI 文档由 FastAPI 在 `/docs` 提供。

## 安装与启动

```bash
python -m pip install -r algorithm-service/requirements.txt
python -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8000
```

SR-5 场景及报告默认保存在 `data/runtime/`，可通过 `SR5_STORE_PATH` 和 `SR5_REPORT_DIR` 指定位置。运行目录已加入 `.gitignore`；正式部署时应配置持久卷并备份。异步任务及 SR-4 规划方案仍沿用现有进程内存储，服务重启后任务 ID 和方案 ID 会失效。

SR-6 三类知识图谱接口位于 `/api/v1/kg/*`，包含统计、实体/设备查询、模糊检索、子图/路径查询、按症状推理、链路状态评估、变更提交/审核、版本查询与回滚。首版图谱由构造的设备台账、拓扑、链路状态及故障案例构建；`GET /api/v1/kg/stats` 返回各域规模和 `sr4_plan_validated=false`。链路状态规则使用构造记录挖掘，不能作为真实链路诊断准确率。故障推理结果有 `source_doc`，命中数仅用于排序。

SR-6 审核后的图谱、待审核变更与版本快照保存在 `data/runtime/sr6_graph.json`，可用 `SR6_STORE_PATH` 更改，正式部署需持久卷及备份。当前审核者仅是请求中的标识，不具备身份认证；正式环境必须由 Java 主服务或网关限制写入、审核和回滚接口。现有 SR-4 测试方案有频率冲突，不作为 SR-6 的正常运行态势基准。

`GET /api/v1/kg/audit` 可查询最近的变更日志。新增知识须先提交到 `/api/v1/kg/updates`，再由 `/api/v1/kg/updates/{change_id}/review` 审核发布；回滚通过 `/api/v1/kg/versions/{version}/rollback` 执行。

## SR-5 联调流程

1. `GET /api/v1/fault/scenarios` 获取五个合成示例；也可先调用 `POST /api/v1/fault/scenarios/validate`，再保存场景。
2. `POST /api/v1/fault/diagnose` 传 `scenario_id`，取回 `task_id`。
3. `GET /api/v1/fault/tasks/{task_id}` 查询诊断结果。现有案例全部为构造数据，结果标记 `TWO_WAY_DEGRADED`，ML 分项带停用原因。
4. `POST /api/v1/fault/impact` 传 `diagnose_task_id`，再查询任务结果。缺省使用仓库的合成拓扑；若诊断时指定有效的 `network_solution_id`，使用对应 SR-4 全流程方案。
5. `GET /api/v1/fault/suggestions?diagnose_task_id=...&impact_task_id=...` 获取建议；`POST /api/v1/fault/report` 生成 JSON、DOCX 或 PDF 报告，按返回的 `report_url` 下载。

`POST /api/v1/fault/scenarios/import` 支持 `multipart/form-data` 上传 CSV/XLSX，也支持 JSON 批量提交。表格至少包含 `scenario_name` 和 `faults` 两列，其中 `faults` 是 JSON 数组文本。影响结果可通过 `GET /api/v1/fault/impact/{task_id}/export?format=xlsx|png` 导出。

现有知识图谱从合成案例派生，图层返回受影响节点的坐标点，不推断未经数据支持的地理受影响面。融合得分仅用于合成场景的候选排序；出现证据不足或多个同样受支持的根因时，结果与处置建议均要求人工复核。
影响结果的 `planning_check_passed` 保留上游 SR-4 方案的校验状态；若为 `false`，该次影响分析仅用于方案诊断和演示。

## 测试

```bash
python -m pip install -r algorithm-service/requirements-dev.txt
python -m pytest tests -q
```
