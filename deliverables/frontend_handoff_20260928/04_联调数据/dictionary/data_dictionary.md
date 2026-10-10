# 第一周数据字典草案

本文件记录第一周数据生成所需的枚举值和待确认事项。

**字段语义的权威说明见 [`docs/design/01_数据字典.md`](../../docs/design/01_数据字典.md)**，
字段表头以 [`data/schemas/*_template.csv`](../schemas/) 为准，
实际写出的表头以 `scripts/gen_test_data.py` 为准。三处必须保持一致。

## 通用枚举

枚举一律传英文码值，中文仅用于界面展示。以下为第一周数据涉及的枚举，
完整清单（含路由策略、抗干扰措施、推理来源等）见 `docs/design/01_数据字典.md` 第 0.6 节。

- `device_class`：`HF` 短波，`VUHF` 超短波。
  取 `VUHF` 而非 `VHF`，因为软需覆盖 30–400 MHz，含 UHF 频段（如中继台 225–400 MHz）。
- `node_role`：`TASK` 任务节点，`FIXED_STATION` 已有固定站，`RELAY` 中继站，`CANDIDATE` 候选部署点。
- `mobility`：`FIXED` 固定站，`VEHICLE` 车载/移动站，`MANPACK` 便携站。
  节点角色与机动性是两个正交维度，分列两个字段：一个 `RELAY` 既可能是固定站也可能是车载。
- `status`：`NORMAL` 正常，`FAULT` 故障，`OFFLINE` 离线。用于节点与设备。
- `link_state`：`EXCELLENT` 优秀，`GOOD` 良好，`WARNING` 预警，`FAULT` 故障。
  四级取值对应软需 SR-6.2 的要求，不增设第五级。
- `affect_state`：`INTERRUPTED` 业务中断，`DEGRADED` 降级运行，`NORMAL` 未受影响。
  「降级」是故障影响分析（SR-5.3）中受影响对象的状态，不是设备自身状态，故不并入 `status`。
- `impact_level`：`SEVERE` 严重，`MODERATE` 一般，`MINOR` 轻微。
- `fault_type`：`HW_FAILURE` 设备硬件故障，`LINK_DOWN` 链路中断，
  `SW_CONFIG` 软件配置异常，`EMI` 电磁干扰。
  四类对应甲方指定的典型故障场景（SR-5.1），不可增删，细分只能走 `fault_subtype` 自由文本。
- `interference_type`：`NARROWBAND` 窄带，`BROADBAND` 宽带，`SWEEP` 扫频，
  `PULSE` 脉冲，`NOISE` 噪声。
- `task_priority`：`P1` 高，`P2` 中，`P3` 低。

布尔值一律写 `true` / `false`，不写 `1` / `0` / `是` / `否`。
缺失值 CSV 中留空，不填 `0` / `-1` / `N/A` / `未知`。

## 单位约定

文档未规定，由本项目确定，改动需两人同意：
频率 `kHz`、距离 `m`、功率 `dBm`、天线增益 `dBi`、时延 `ms`、速率 `kbps`。

## 待确认事项

- `source` / `remark` 可追溯性字段是否纳入各表。当前仅 `nodes` 表有 `remark`，
  各表无 `source`；若要补回，需同时确定随机种子等生成参数的记录方式。
- 设备状态上报协议及接口文档待确认。
- Python 与 Java 的接口字段规范待确认。
- DEM 地形数据来源、授权状态和覆盖范围待确认。
- 设备型号、设备说明书来源和可公开使用范围待确认。
- 故障知识图谱训练语料来源与规模待确认。
- ML 层故障诊断是否纳入本次验收范围待确认。
