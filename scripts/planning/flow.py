"""最小费用最大流，以及基于它的「带容量的上级指派」（方案 4.4 内层）。

合作方明确「不可以用求解器，我们自己写求解」，本模块即自研求解核心，纯标准库。

── 为什么内层是 b-匹配而不是单源单汇流 ──────────────────────
方案第三版 4.3 曾写「整个上行问题 = 单源单汇有容量流，最大流饱和 ⟺ 全连通」。
**该说法不成立**，反例：

    R(容量1) ── A(容量2) ── B(容量1)，可行链路 A─R、B─A

  按端口口径：A─R 占 R 一个端口、A 一个端口；B─A 占 A 一个端口、B 一个端口。
             R 用 1/1、A 用 2/2、B 用 1/1，全不超容量 → 可行。
  按单位流：A、B 各出 1 个单位都要到汇点，两个单位都得过 A→R（容量 1）
             → 最大流 1 < 2 → 判为不可行。

矛盾的根源：合作方说的容量是**装备台数，即端口数（度数）**，
而单位流把「经过某节点的流量」当成端口占用。中继节点转发时，
一条链路可以承载它整个子树的流量，却只占 1 个端口。

因此正确模型是**带度数约束的支撑树（arborescence）**：
    每个非根节点恰有 1 个上级；
    节点 u 在频段 b 的端口占用 = (u 自己的上行占 1) + (挂在 u 下面的下级数) <= cap(u,b)

按层自底向上求解时，每一层的「谁挂谁」就是一个**带容量的二部图匹配**，
而 b-匹配正是最大流的标准形式——流在这里是用对地方的。
"""
import heapq

INF = float("inf")


class MinCostMaxFlow:
    """SPFA + 连续最短路增广（SSP）。

    图规模在本问题里很小（一层至多数百个节点、数千条边），
    SPFA 足够，不必上 Dijkstra + 势函数。
    """

    def __init__(self, n):
        self.n = n
        self.head = [[] for _ in range(n)]   # 每个点的出边索引
        self.to = []
        self.cap = []
        self.cost = []

    def add_edge(self, u, v, cap, cost=0.0):
        eid = len(self.to)
        self.head[u].append(eid)
        self.to.append(v); self.cap.append(cap); self.cost.append(cost)
        self.head[v].append(eid + 1)
        self.to.append(u); self.cap.append(0); self.cost.append(-cost)
        return eid

    def flow_on(self, eid):
        """该边已通过的流量 = 反向边的剩余容量。"""
        return self.cap[eid ^ 1]

    def solve(self, s, t, max_flow=None):
        total_flow, total_cost = 0, 0.0
        limit = INF if max_flow is None else max_flow
        while total_flow < limit:
            dist = [INF] * self.n
            inq = [False] * self.n
            prev_edge = [-1] * self.n
            dist[s] = 0.0
            queue = [s]
            inq[s] = True
            while queue:                       # SPFA
                u = queue.pop(0)
                inq[u] = False
                du = dist[u]
                for eid in self.head[u]:
                    if self.cap[eid] <= 0:
                        continue
                    v = self.to[eid]
                    nd = du + self.cost[eid]
                    if nd < dist[v] - 1e-12:
                        dist[v] = nd
                        prev_edge[v] = eid
                        if not inq[v]:
                            inq[v] = True
                            queue.append(v)
            if dist[t] == INF:
                break                          # 无增广路
            # 沿最短路找瓶颈
            push = limit - total_flow
            v = t
            while v != s:
                eid = prev_edge[v]
                push = min(push, self.cap[eid])
                v = self.to[eid ^ 1]
            v = t
            while v != s:
                eid = prev_edge[v]
                self.cap[eid] -= push
                self.cap[eid ^ 1] += push
                v = self.to[eid ^ 1]
            total_flow += push
            total_cost += push * dist[t]
        return total_flow, total_cost


def assign_parents(children, parents, candidates, ports_left, prefer=None):
    """带容量的上级指派 —— 一层的核心运算。

    children    需要找上级的节点 id 列表（每个至多配一个）
    parents     可作上级的节点 id 列表
    candidates  {child: [可作其上级的 parent, ...]}，由可行性矩阵 + 编成规则给出
    ports_left  {parent: 该频段剩余端口数}，即还能再挂几个下级
    prefer      可选 {(child, parent): 代价}，代价小者优先（如取负的链路余量）

    返回 (assignment, unassigned)：
        assignment  {child: parent}
        unassigned  没配上上级的 child 列表 —— 这就是需要新增电台去救的节点
    """
    ci = {c: i for i, c in enumerate(children)}
    pi = {p: len(children) + i for i, p in enumerate(parents)}
    S = len(children) + len(parents)
    T = S + 1
    g = MinCostMaxFlow(T + 1)

    for c in children:
        g.add_edge(S, ci[c], 1, 0.0)
    edge_of = {}
    for c in children:
        for p in candidates.get(c, ()):
            if p not in pi or ports_left.get(p, 0) <= 0:
                continue
            cost = prefer.get((c, p), 0.0) if prefer else 0.0
            edge_of[(c, p)] = g.add_edge(ci[c], pi[p], 1, cost)
    for p in parents:
        room = ports_left.get(p, 0)
        if room > 0:
            g.add_edge(pi[p], T, room, 0.0)

    g.solve(S, T)

    assignment = {}
    for (c, p), eid in edge_of.items():
        if g.flow_on(eid) > 0:
            assignment[c] = p
    unassigned = [c for c in children if c not in assignment]
    return assignment, unassigned


if __name__ == "__main__":
    # 反例自检：确认 b-匹配口径判为可行，而单位流口径判为不可行
    print("反例  R(cap1) ── A(cap2) ── B(cap1)，可行链路 A─R、B─A\n")

    # 第 1 层：A 找上级 R
    asg1, un1 = assign_parents(["A"], ["R"], {"A": ["R"]}, {"R": 1})
    print("  第1层 A 找上级 →", asg1, " 未配上:", un1)
    # A 上行占掉自己 1 个端口，剩 1 个可挂下级
    asg2, un2 = assign_parents(["B"], ["A"], {"B": ["A"]}, {"A": 2 - 1})
    print("  第2层 B 找上级 →", asg2, " 未配上:", un2)
    ok = not un1 and not un2
    print("\n  b-匹配口径: %s —— 与端口口径一致" % ("可行 ✅" if ok else "不可行 ❌"))

    # 对照：单源单汇单位流
    g = MinCostMaxFlow(6)
    S, T = 4, 5
    A_out, R_in, B_out = 0, 1, 2
    g.add_edge(S, A_out, 1); g.add_edge(S, B_out, 1)
    g.add_edge(B_out, A_out, 1)      # B─A，容量 1
    g.add_edge(A_out, R_in, 1)       # A─R，容量 1
    g.add_edge(R_in, T, 1)           # R 端口容量 1
    f, _ = g.solve(S, T)
    print("  单位流口径: 最大流 %d / 需求 2 → %s —— 与端口口径矛盾"
          % (f, "可行" if f == 2 else "不可行 ❌"))
