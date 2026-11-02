# 常用技能文本备份

整理日期：2026-11-01。这里只备份本项目用到的4组个人流程技能，不导出账号配置、会话数据库、认证文件、缓存、插件账户或整套用户目录。

| 技能 | 本次读取来源 | 恢复要求 |
| --- | --- | --- |
| grilling | `C:/Users/y/.agents/skills/grilling/` | 用户显式调用时按依赖轮次提问，推荐答案后等待回答 |
| domain-modeling | `C:/Users/y/.agents/skills/domain-modeling/` | 保留SKILL、ADR/GLOSSARY格式及agents元数据 |
| grill-with-docs | `C:/Users/y/.agents/skills/grill-with-docs/` | 组合入口，必须同时存在grilling和domain-modeling |
| subagent-cleanup | `C:/Users/y/.codex/skills/subagent-cleanup/` | 保留SKILL及scripts/agent_scratch.ps1，委派前读取并按规则登记回收 |

各子目录按原相对路径逐文件复制；`技能备份清单.json`记录原位置、相对路径、大小及SHA256。备份不表示本次调用了grilling或执行了空间清理。

## 恢复方法

1. 先保留项目目录及本地交接ZIP，在新环境打开`START_HERE.md`。
2. 检查新环境已经有哪些技能。完整且相同的无需覆盖；目录缺失时由新agent按当前权限恢复到其支持的skills目录。
3. 可选择新环境的用户技能根目录，例如`~/.agents/skills/`或`~/.codex/skills/`，将对应技能目录复制进去；实际支持的发现路径以新环境为准。不要把旧用户名或绝对目录直接当新环境路径。
4. grilling、domain-modeling、grill-with-docs须一起可发现。grill-with-docs是组合说明，正文要求调用前两项，不是独立的业务算法。
5. 如果subagent-cleanup的安装位置改变，更新AGENTS中对其SKILL的本地路径。scratch根目录、owner、项目目录按实际环境设置；不要照旧owner删除历史目录。
6. 在新会话核对技能目录是否被发现，再显式使用。这里不包含一键覆盖用户配置或认证状态的脚本。

若技能暂不可用，接手文档已经保留关键开发/协作规则；不得因此复制完整项目或假报已经执行技能。涉及必须使用的显式技能时，应先完成恢复或告知缺项。
