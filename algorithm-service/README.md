# Python 算法服务

本服务提供 SR-4 规划、SR-5 故障诊断、SR-6 知识支撑及资源查询接口。入口为 `app.main:app`，OpenAPI 文档由 FastAPI 在 `/docs` 提供。

## 安装与启动

```bash
python -m pip install -r algorithm-service/requirements.txt
python -m uvicorn app.main:app --app-dir algorithm-service --host 127.0.0.1 --port 8000
```

SR-5 场景及报告默认保存在 `data/runtime/`，可通过 `SR5_STORE_PATH` 和 `SR5_REPORT_DIR` 指定位置。SR-4 方案保存在 `data/runtime/plans/`（`SR4_PLAN_DIR`）；已完成的异步任务保存在 `data/runtime/tasks/`（`ALGORITHM_TASK_DIR`）；覆盖结果和覆盖任务分别保存在 `data/runtime/coverage/`（`COVERAGE_CACHE_DIR`）和 `data/runtime/coverage_tasks/`（`COVERAGE_TASK_DIR`）。运行中的任务在服务重启后不能恢复计算，须重新提交。运行目录已加入 `.gitignore`；正式部署时应配置持久卷并备份。当前持久化仅适用于单进程服务，多进程或多实例部署需另行设计共享存储。

SR-6 三类知识图谱接口位于 `/api/v1/kg/*`，包含统计、实体/设备查询、模糊检索、子图/路径查询、按症状推理、链路状态评估、变更提交/审核、版本查询与回滚。`GET /api/v1/kg/triples` 可按 `graph`、`relation`、`source`、`entity` 追溯三元组；`GET /api/v1/kg/quality` 检查悬空实体、重复关系、缺失来源、关系类型约束和故障案例知识完整性。首版图谱由构造的设备台账、拓扑、链路状态及故障案例构建；`GET /api/v1/kg/stats` 返回各域规模和 `sr4_plan_validated=false`。链路状态规则使用构造记录挖掘，不能作为真实链路诊断准确率。故障推理结果有 `source_doc`，命中数仅用于排序。

SR-6 审核后的图谱、待审核变更与版本快照保存在 `data/runtime/sr6_graph.json`，可用 `SR6_STORE_PATH` 更改，正式部署需持久卷及备份。当前审核者仅是请求中的标识，不具备身份认证；正式环境必须由 Java 主服务或网关限制写入、审核和回滚接口。现有 SR-4 测试方案有频率冲突，不作为 SR-6 的正常运行态势基准。

`GET /api/v1/kg/audit` 可查询最近的变更日志。新增知识须先提交到 `/api/v1/kg/updates`，再由 `/api/v1/kg/updates/{change_id}/review` 审核发布；回滚通过 `/api/v1/kg/versions/{version}/rollback` 执行。

故障图谱的已审核变更会用于后续 SR-5 图谱分支诊断与处置建议，回滚后恢复旧知识。240 条构造案例的原始 CSV 有 2022 条故障关系，其中 960 条是有序诊断步骤；运行图谱另补 240 条案例关联、240 条故障类型和 240 条对象类型关系，故障域合计 2742 条。旧版已保存图谱首次加载时会迁移并生成新版本。链路状态数值门限可通过 `set_link_rule` 变更操作审核发布，字段为 `rule_id`、`threshold_value`（原始物理单位）和 `source`，重启及回滚均会同步评估器；普通三元组变更不修改数值门限。所有变更仍基于合成数据，未经过真实设备校准。

## SR-5 联调流程

1. `GET /api/v1/fault/scenarios` 获取五个合成示例；也可先调用 `POST /api/v1/fault/scenarios/validate`，再保存场景。
2. `POST /api/v1/fault/diagnose` 传 `scenario_id`，取回 `task_id`。
   无预设故障类型的观测可调用 `POST /api/v1/fault/diagnose/observations`，请求体传 `faults[]`（每项含 `object_type`、`object_id`、`symptom_ids`，可选 `params`；不得含 `fault_type`）。该入口只用于诊断，不生成可供影响分析引用的场景。
3. `GET /api/v1/fault/tasks/{task_id}` 查询诊断结果。现有案例全部为构造数据，结果标记 `TWO_WAY_DEGRADED`，ML 分项带停用原因。
4. `POST /api/v1/fault/impact` 传 `diagnose_task_id`，再查询任务结果。缺省使用仓库的合成拓扑；若诊断时指定有效的 `network_solution_id`，使用对应 SR-4 全流程方案。
   `GET /api/v1/fault/impact/{task_id}/nodes?node_role=...&region=...` 可按节点角色和区域筛选受影响节点；等级为 `SEVERE`、`MODERATE`、`MINOR`。图层仍只表示节点位置，不表示覆盖边界。
5. `GET /api/v1/fault/suggestions?diagnose_task_id=...&impact_task_id=...` 获取建议；`POST /api/v1/fault/report` 生成 JSON、DOCX 或 PDF 报告，按返回的 `report_url` 下载。
6. 人工研判后调用 `POST /api/v1/fault/diagnoses/{task_id}/feedback`，传 `reviewer`、`result_index`，可选修正 `confirmed_fault_type`、`root_cause`、`fault_component`、`solution`、`diagnosis_steps`。反馈只进入 SR-6 待审核队列；知识管理员通过 `/api/v1/kg/updates/{change_id}/review` 审核发布后，新案例才参与后续图谱诊断。当前 `reviewer` 尚未接统一鉴权，因此来源标记为 `UNAUTHENTICATED_REVIEW`，不能等同真实案例验证。

`POST /api/v1/fault/scenarios/import` 支持 `multipart/form-data` 上传 CSV/XLSX，也支持 JSON 批量提交。表格至少包含 `scenario_name` 和 `faults` 两列，其中 `faults` 是 JSON 数组文本。影响结果可通过 `GET /api/v1/fault/impact/{task_id}/export?format=xlsx|png` 导出。

现有知识图谱从合成案例派生，图层返回受影响节点的坐标点，不推断未经数据支持的地理受影响面。融合得分仅用于合成场景的候选排序；出现证据不足或多个同样受支持的根因时，结果与处置建议均要求人工复核。
影响结果的 `planning_check_passed` 保留上游 SR-4 方案的校验状态；若为 `false`，该次影响分析仅用于方案诊断和演示。
`POST /api/v1/plans/{solution_id}/confirm` 仅接受通过全流程校验的 SR4_FLOW 方案或标记为可行的 NETWORK_OPTIMIZE 方案；当前含频率冲突的实跑方案不能确认。
方案导出支持 JSON、CSV 和 XLSX。异步任务目前只支持轮询，非空 `callback_url` 会返回 `1001`；回调地址、签名与重试协议仍需联调确认。

## 测试

```bash
python -m pip install -r algorithm-service/requirements-dev.txt
python -m pytest tests -q
```
