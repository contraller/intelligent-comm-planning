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

### ⚠️ 待解决：字段口径不一致

`scripts/gen_test_data.py` 当前的输出字段与 `data/schemas/*_template.csv` 不一致，
包括单位和量纲差异（示例：频率 `khz` / `mhz`，距离 `m` / `km`，功率 `dbm` / `w`），
且脚本输出目录仍是 `data/generated/`，不符合 `data/README.md`。

**在两边未确认统一口径之前，不要自行改字段名或做单位换算。** 确认后应在同一次改动中
完成：改字段 → 改输出路径与文件名 → 重新生成 → 跑校验。

## 提交规范

- 开工前先 `git pull`，收工前 `git push`，不要攒着不推。
- 提交信息说明改了什么，中英文均可，与现有历史保持一致。
- 不提交：`__pycache__/`、`.DS_Store`、Office 临时文件（见 `.gitignore`）。
- **不提交大文件。** DEM、地物、道路等栅格/矢量原始数据不入库
  （GitHub 单文件上限 100 MB），走网盘共享，只在 `data/raw/` 下留说明文件记录
  来源、下载时间、覆盖范围和授权状态。
