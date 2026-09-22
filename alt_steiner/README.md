# 备选实现：Steiner 森林版部署规划（已停用，仅作对照）

**这里的代码不在主线上，不被任何主线模块引用，不参与交付。**
主线实现在 [`scripts/planning/`](../scripts/planning/) 与
[`algorithm-service/app/`](../algorithm-service/app/)。

## 这是什么

2026-09-22 由 kyriezz0316 通过 GitHub 网页 "Add files via upload" 上传的
一整套 SR-4.2.1.2 移动电台部署规划实现（提交 `1964a7b`、`2f999e8`）。

上传时主线已有一套同任务的实现。上传**覆盖**了主线的 5 个文件，
其中 `algorithm-service/app/data_loader.py` 被整体替换，
原有的 `candidate_sites()` / `nodes()` / `task_scenarios()` / `to_float()`
四个函数消失，导致 `app/candidate_sites.py`（第 1 周 SR-4.2.1.1 交付）
与 `app/main.py` 一起无法导入，**服务的五个接口全部下线**。

因此把这一整套挪到本目录：主线恢复到覆盖前的状态，这套实现原样保留、
不丢失、随时可跑可比对。

## 目录里有什么

14 个 Python 文件，**与上传时（提交 `6f7d159`）逐字节一致，未作任何修改**：

| 路径 | 文件 | 性质 |
|---|---|---|
| `scripts/planning/` | `model.py` `radio_db.py` `solve.py` | 他新增 |
| `scripts/planning/` | `test_smoke.py` `test_deployment.py` `test_integration.py` | 他新增（需 pytest） |
| `scripts/planning/` | `feasibility.py` `deployment.py` `metrics.py` `viewshed.py` | 他覆盖主线的版本 |
| `algorithm-service/app/` | `server.py` `deployment_service.py` | 他新增 |
| `algorithm-service/app/` | `test_http.py` | 他新增（需 pytest） |
| `algorithm-service/app/` | `data_loader.py` | 他覆盖主线的版本 |

另有两个 `__init__.py`，是从主线复制来的，只为让副本仍是可导入的包。

目录层级刻意与仓库根一致（`alt_steiner/scripts/`、`alt_steiner/algorithm-service/`），
因为他的服务层用 `_ROOT = <文件>/../..` 推算路径，保持层级就不用改他一行代码。

## 与主线的口径差异（这是停用的根本原因）

这套实现的求解模型是**顶点权重 Steiner 森林 + 集合覆盖**：以「点对之间可达」
为目标，中继点按覆盖增益贪心选取。全套代码 grep 不到
`echelon` / `编成` / `node_subtype` / `II_NODE` / `III_MOBILE`，
`model.py` 的 `Site` 只有 `site_id / lon / lat / band / profile / kind`。

也就是说，2026-09-22 拿到的八个问题答复里，这几条在本实现中没有落点：

- 答复 2(b)：Ⅱ–Ⅱ 之间无直连，只能经 Ⅱ固定站中继；
- 答复 2(c)：编成定额即容量约束（每个节点每频段的装备数就是度数上限）；
- 答复 3：按五级编成层级规划，同一上级的下级可横向通联。

这些是数据结构层面的缺失，不是调参能补的。主线实现的编成模型见
[`scripts/planning/echelon.py`](../scripts/planning/echelon.py)，
答复与落点的逐条对应见
[`docs/design/05_移动电台部署规划算法方案.md`](../docs/design/05_移动电台部署规划算法方案.md) 第 6 章。

## 值得吸收的部分

与编成模型不冲突、将来可以直接搬进主线的：

- `scripts/planning/model.py` —— `RadioProfile` 把电台参数（频率/带宽/功率/灵敏度/
  增益/业务门限/挂高）收拢成一个数据类；`parse_height_range()` 解析
  `"2-3"` 这类挂高区间取中点。
- `scripts/planning/radio_db.py` —— 按频段取默认电台参数、按 device_model 取参数。
- `algorithm-service/app/data_loader.py` —— 候选点按间距降密度筛选
  （他记录里说是为解决 VUHF 1137 候选求解超时）。

## 怎么跑

这套代码本身能跑，只需要把真实的 `scripts/` 挂到 `PYTHONPATH` 上，
让 `terrain` / `propagation` 能被找到（`planning.*` 会优先命中本目录的副本）：

```
PYTHONPATH=<仓库根>/scripts python3 alt_steiner/algorithm-service/app/server.py
```

三个 `test_*.py` 需要 `pytest`，本项目按 CLAUDE.md 不引入第三方依赖，未安装。
