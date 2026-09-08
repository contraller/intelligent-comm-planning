# CLAUDE.md

本文件是**代码与数据线**的工作规范。文档线（SRS 章节写作）的规范见
[AGENTS.md](AGENTS.md)。两份规范同时生效，改动前先确认自己在哪条线上。

## 仓库的两条线

| 线 | 负责人 | 目录 | 规范 |
|---|---|---|---|
| 需求文档 | contraller（Codex） | `docs/input/` `docs/draft/` `docs/output/` `docs/reference/` `skills/` | AGENTS.md |
| 代码与数据 | yoii1（Claude Code） | `scripts/` `data/` `docs/design/` | 本文件 |

**不要跨线改对方的文件。** 需要对方配合的改动，先在群里说，不要直接改完推上去。

## 代码规范

- Python 3，**只用标准库**，不引入第三方依赖。项目最终要在国产化平台部署，
  依赖越少越好；确需引入时先说明理由。
- 数据生成必须可复现：随机种子固定在 `gen_test_data.py` 的 `SEED`（当前 `20260908`），
  不要改成随机值，改了要在提交信息里写明。
- 物理模型（`propagation.py` / `terrain.py`）**保持接口稳定**。第 2 周要把占位实现
  换成真实模型（ITU-R P.526/P.1812/P.533/P.368）和真实 DEM，
  替换时调用方代码不应改动。
- 改完数据生成逻辑，必须跑一遍校验，退出码为 0 才能提交：

  ```
  python3 scripts/gen_test_data.py
  python3 scripts/validate_data.py
  ```

- 注释和文档字符串用中文，与现有代码一致。

## 数据规范

- 目录结构与文件命名以 [`data/README.md`](data/README.md) 为准
  （`synthetic/nodes/nodes_v1.csv` 这种形式）。
- 字段定义以 `data/schemas/*_template.csv` 为准，`docs/design/01_数据字典.md` 应与之保持一致。
- 数量口径以 `data/README.md` 的「第一阶段数据量口径」为准，
  与 AGENTS.md 已确认的验收口径一致：短波节点 ≥ 50、超短波节点 ≥ 100、
  地图范围 ≥ 120 km × 120 km。
- 不确定的来源、协议、型号一律标注「待确认」，不得编造。

### 字段口径

`无线需规v3(3).docx` 第 3.5 节「CICI内部数据需求」原文为「本软件内部数据相关的决策
都留待软件设计时确定」，全文亦未出现任何频率、功率、距离单位。因此字段口径按以下顺序确定：

1. 需规文档有明确规定的，以文档为准；
2. 文档未涉及的（目前是绝大多数字段），以 `scripts/gen_test_data.py` 的实际输出为准。

单位约定（文档未规定，由本项目自行确定，改动需两人同意）：
频率 `kHz`、距离 `m`、功率 `dBm`、天线增益 `dBi`、时延 `ms`、速率 `kbps`。

字段的三处定义必须同步更新，改一处就要改另外两处：

- `scripts/gen_test_data.py` —— 实际写出的表头
- `data/schemas/*_template.csv` —— 表头 + 一行真实样例
- `docs/design/01_数据字典.md` —— 字段语义的权威说明

**待与 contraller 确认**：他原模板中每张表都有 `source` / `remark` 两个可追溯性字段，
当前未纳入。若要补回，需同时确定随机种子等生成参数的记录方式
（`data/README.md` 注意事项要求记录生成规则与随机种子）。
