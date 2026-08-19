# Draft Plan

`docs/draft/` 用于存放《短波/超短波智能规划系统软件需求规格说明书》七个目标章节的 Markdown 初稿。

## 计划章节

后续建议按以下文件拆分起草：

- `docs/draft/3.1-state-and-modes.md`
- `docs/draft/3.2-csci-capability-requirements.md`
- `docs/draft/3.3-software-external-interface-requirements.md`
- `docs/draft/3.4-software-internal-interface-requirements.md`
- `docs/draft/3.5-csci-internal-data-requirements.md`
- `docs/draft/3.11-computer-resource-requirements.md`
- `docs/draft/3.12-design-and-implementation-constraints.md`

## 写作顺序建议

1. 先起草 `3.1`，确定系统运行状态与方式边界。
2. 再起草 `3.2`，把能力需求收敛为可验收条目。
3. 之后起草 `3.3`、`3.4`、`3.5`，分别固定外部接口、内部接口和内部数据边界。
4. 最后起草 `3.11`、`3.12`，统一整理资源需求与设计实现约束。

## 写作注意事项

- 每条需求使用唯一编号。
- 每条需求带上合格性方法和追踪来源。
- 未确认事项必须显式写为“待确认”。
- 不在本目录中撰写技术方案、数据库设计说明或算法原理说明。
