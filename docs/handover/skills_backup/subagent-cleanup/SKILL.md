---
name: subagent-cleanup
description: "管理子 agent 的临时项目副本，在每次委派结束、成果回收后释放 clone、copy、worktree 与临时依赖占用。用于短波规划项目的并行开发和子 agent 空间清理；也适用于其他项目的同类需求。"
---

# 子 Agent 空间回收

主 agent 负责从委派前登记到任务结束清理的闭环。技能是工作指引，不是运行时钩子；不得声称安装后能拦截所有 agent 调用。项目的 `AGENTS.md` 应引用本技能，使新会话在委派前加载。当前会话仍需主动遵循。

## 委派前：先避免副本

- 默认共享现有 checkout，按文件或职责分工，给子 agent 明确禁止自行 clone、递归复制项目或安装另一份完整环境。只读审查直接读原项目。
- 如果工具已经共享文件系统，不要为 `spawn_agent` 再复制一次。确需隔离时，复用本任务已拥有且无其他使用者的隔离目录；再考虑新建。
- 用当前主会话 ID 作为 owner，为每次调用记录 agent ID、实际工作目录、资源类型和所有权。共享目录登记为 shared，结束时无需删除。隔离目录必须在创建时登记，不能结束后凭目录名推断所有权。
- 检查当前 agent 列表、项目相关会话及 attached artifacts，辨认仍在使用的目录。其他会话的目录、用户指定长期保留的目录、当前服务目录不是本次清理对象。
- 避免复制 `.venv`、`node_modules`、DEM/地形数据、数据库、交付包和历史运行输出；从必要源文件构建隔离环境。不要把 scratch 放在源项目内再递归复制源项目。

## 每个子 agent 结束后

1. 等待它完成并确认不再写入。中断调用只停止当前 turn，不能据此假定后台测试或服务已经退出；核对由本任务启动的进程，按精确 PID 停止临时进程，保留用户正在使用的服务。
2. 回收成果：合入所需修改并验证；把最终文档、补丁、测试证据或交付物放到临时目录之外。检查未提交、未跟踪和 ignored 文件，特别是 ignored 的运行数据或交付文件。失败或取消时也检查有无独有成果；无法确认则保留并说明具体原因。
3. 依据下方资源类型清理。主 agent 执行，不依赖子 agent 自删工作目录；每个已完成 agent 都收尾，不必等全部 agent 结束。共享资源须等最后一个使用者结束。嵌套 agent 的资源也要逐项回收。
4. 验证目录实际移除、Git worktree 登记已更新；记录估算移除字节数、仍保留的路径和原因，再结束主任务。没有创建副本时记录“共用目录，无新增副本需要清理”。不能在失败时报告已释放空间。

取消、报错和用户要求停止时同样处理能确认安全的资源。若会话已中断且无法执行，下一次恢复时检查本 owner 的遗留记录，先核实活动状态再继续；不得按时间长短自动删除。

## 按资源类型清理

### 普通 scratch / copy / clone

使用 [scripts/agent_scratch.ps1](scripts/agent_scratch.ps1)。它只清理由自己新建并登记的目录，拒绝将已有任意路径登记成垃圾。PowerShell 参数均传绝对路径。

```powershell
$helper = 'C:\Users\y\.codex\skills\subagent-cleanup\scripts\agent_scratch.ps1'
$scratchRoot = 'F:\work\codex\agent-scratch\shortwave-planning'
$ownerId = '<当前主会话ID>'
$projectRoot = 'F:\work\project2026-1'

# 在复制或 clone 前分配；使用返回的 id 和 slot。
& $helper -Action New -ScratchRoot $scratchRoot -Owner $ownerId -ProjectRoot $projectRoot
# 把必要源文件复制/clone 到 slot 下新建的 workspace 子目录，保留 slot 标记。
# 拿到子 agent ID 后在主任务轻量记录中关联 id，不得改登记文件伪造释放条件。

# 收回成果、确认所有写入者退出后：
& $helper -Action Release -ScratchRoot $scratchRoot -Owner $ownerId -Id '<返回的id>' `
  -WritersStopped -ResultsPreserved -Evidence '<已合入的提交/成果绝对路径，或无成果的具体理由>'
& $helper -Action Inspect -ScratchRoot $scratchRoot -Owner $ownerId -Id '<返回的id>'
& $helper -Action Clean -ScratchRoot $scratchRoot -Owner $ownerId -Id '<返回的id>'
```

`Inspect` 只读，`Release` 记录主 agent 已核实的事实；两个开关不是进程检测或代码合并工具。成功清理可重复执行。记录保存在 scratch root 的 `records` 下，不在被删的 slot 内；保留这些轻量记录以便核查。无权访问时走环境正常权限流程，不用切换 shell 绕过限制。

### Codex 托管 worktree

创建后立即把返回的 workspace、artifact identityKey、owner 和 agent ID 记到临时目录外的轻量记录。清理前用 `list_artifacts` 核对确属本任务且不再使用，再调用 `archive_worktree`；不要手动递归删除。归档会保留可恢复快照，因此只能报告实际移除的 checkout 占用，不能保证所有额外存储归零。先回收必要的 ignored 文件。工具因共享、固定或嵌套仓库而拒绝时，保留并报告，不强删。

### 普通 Git worktree

同样在创建时登记原仓库、worktree 绝对路径、owner 和 agent ID。操作前后用 `git worktree list --porcelain` 验证。

- 确认它是登记中的非主 worktree，不是任何活跃会话、当前服务或用户保留的交付 checkout。
- 运行 `git status --porcelain=v1 --untracked-files=all` 以及 `git ls-files --others --ignored --exclude-standard`，回收所有独有成果。验证该 HEAD 的成果已进入目标仓库/分支，例如检查 commit 可达性；clean status 本身不能证明独有 commit 已回收。
- 从原仓库执行 `git -C '<原仓库>' worktree remove -- '<worktree绝对路径>'`。不得加 `--force` 或直接 `Remove-Item -Recurse`；若因 ignored 临时依赖而拒绝，只移除已确认的临时依赖后重试。不得删除分支、执行 Git GC、清理对象库或改动其他 worktree。
- 如已是 missing 状态，只在确认对应登记和成果后做有针对性的修复；不要全局 `prune` 清理其他任务的登记。

## 删除边界与旧副本

只删本任务已登记、已停止使用、成果已回收的临时资源。递归删除前重新检查规范化绝对路径与精确边界，拒绝项目本体、磁盘根、scratch root 本体、其父目录、其他 owner 的目录；不能用字符串前缀代替目录边界。拒绝路径、祖先或目录树中的 symlink / junction / reparse point。扫描遇到错误须停止该项，不可假定为空。Windows 中检查和删除用同一 PowerShell 流程及 `-LiteralPath`，不得跨 shell 拼接删除指令。

未经登记的历史副本只能做只读盘点，列出大小、Git 状态、提交是否回收、活跃会话及可清理证据。不能凭 `wt`、`copy`、`tmp`、目录年龄或体积删除。若用户随后授权历史清理，逐个建立有证据的处置清单并使用相应的 Git/应用工具，不得通过篡改本助手记录来接管旧目录。

保护主项目的依赖、数据、数据库、原始资料、交付包和正在运行的服务；它们只有在已登记的临时副本内部且无需保留时才随副本删除。不清理系统/全局缓存、回收站或其他会话资源，不为记录清理过程再制作完整备份。文件长度总和是逻辑大小估计，压缩、硬链接或归档快照可能使实际可用空间变化不同。
