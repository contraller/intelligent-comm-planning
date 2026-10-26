"""通信编成层级模型（SR-4.2.1.2 的约束来源）。

本模块是**编成口径的唯一定义处**：层级、子类型、容量、允许的链路关系都在这里，
`gen_test_data.py` 与部署求解器共同引用，避免两份常量漂移。

依据：《技术参考》内嵌的 Visio 图（`word/embeddings/Microsoft_Visio_Drawing.vsdx`，
35 个形状、18 条连线），以及合作方 2026-09-18、2026-09-29 的口头答复。

── 图上是五行，不是四行 ──────────────────────────────────────────
  行1  Ⅰdb固定站 ── Ⅰdb机动站          同行有链路，互为备份
  行2  Ⅱdb/cdb固定站                    单独一行，是行3两类 Ⅱ 的上级
  行3  Ⅱdb/cdb机动站  Ⅱdb/cdb机动节点站  同行之间无链路
  行4  Ⅲdb/cdb机动站                    同行图上无链路，合作方补充可直连中继（限同组，见下）
  行5  Ⅳcdb机动站                       同行之间无链路

层级 Ⅱ 内部有主从，因此**不能只看 echelon 判定跃迁**，必须用
(echelon, node_subtype) 二元组——这是本模块所有规则以 subtype 为键的原因。

── 两条硬约束 ────────────────────────────────────────────────
  1. db 不能和 cdb 相连：链路两端必须同频段，频段转换只发生在双频节点内部。
  2. 正常工况不得跨层级直连；作战损伤工况方可降级（《技术参考》标红段）。

── Ⅲ──Ⅲ 还要过同组判据（不是站型能判的）──────────────────────────
  合作方 2026-09-29：「同一个 Ⅱ 下的 Ⅲ 之间可以直接建链，不同 Ⅱ 下的不行。」
  Ⅲ 挂哪个 Ⅱ 是规划时的选择，所以「同组」要看规划结果，不能放进按站型判断的
  RELATIONS / 可行性矩阵，由各个加链处调用 peer_link_allowed() 判定。
"""

# ── 频段 ──────────────────────────────────────────────────
HF, VUHF = "HF", "VUHF"           # db / cdb
BANDS = (HF, VUHF)

# ── 子类型 → 层级 ─────────────────────────────────────────
# 右支（a车/b车/背负式）为 Ⅰ 直属，层级记 I；它与 Ⅰ固定站/Ⅰ机动站 的区别
# 由 subtype 承担——跃迁规则以 subtype 判定，不单看 echelon。
SUBTYPE_ECHELON = {
    "I_FIXED": "I", "I_MOBILE": "I",
    "II_FIXED": "II", "II_MOBILE": "II", "II_NODE": "II",
    "III_MOBILE": "III", "IV_MOBILE": "IV",
    "VEHICLE_A": "I", "VEHICLE_B": "I", "MANPACK": "I",
}

# 图上的行深，仅用于呈现与自检（Ⅱ 级跨行2、行3）
SUBTYPE_ROW = {
    "I_FIXED": 1, "I_MOBILE": 1,
    "II_FIXED": 2,
    "II_MOBILE": 3, "II_NODE": 3,
    "III_MOBILE": 4,
    "IV_MOBILE": 5,
    "VEHICLE_A": 3, "VEHICLE_B": 3, "MANPACK": 4,   # 右支，与左支不同支
}

SUBTYPE_NAME = {
    "I_FIXED": "Ⅰ短波固定站", "I_MOBILE": "Ⅰ短波机动站", "II_FIXED": "Ⅱ双频固定站",
    "II_MOBILE": "Ⅱ双频机动站", "II_NODE": "Ⅱ双频机动节点站", "III_MOBILE": "Ⅲ双频机动站",
    "IV_MOBILE": "Ⅳ超短波机动站", "VEHICLE_A": "a机动车", "VEHICLE_B": "b机动车",
    "MANPACK": "背负式短波电台",
}

SUBTYPE_MOBILITY = {
    "I_FIXED": "FIXED", "II_FIXED": "FIXED",
    "I_MOBILE": "VEHICLE", "II_MOBILE": "VEHICLE", "II_NODE": "VEHICLE",
    "III_MOBILE": "VEHICLE", "IV_MOBILE": "VEHICLE",
    "VEHICLE_A": "VEHICLE", "VEHICLE_B": "VEHICLE", "MANPACK": "MANPACK",
}

# ── 容量 = 该频段的设备台数 ───────────────────────────────
# 合作方答复 2(c)：编成定额即「最多有这么多装备，可以把这个当成容量约束」。
# 战术电台为单信道设备，一台一次维持一条链路。
# 「图注」= Visio 方框内标注；「待确认」= 图中未标，取满足编成连接数的工程默认值。
ECHELON_CAP = {
    "I_FIXED":    {HF: 8,  VUHF: 0},   # 待确认：需领 4 个 Ⅱ固定站 + Ⅰ机动站
    "I_MOBILE":   {HF: 18, VUHF: 0},   # 待确认：需领 a车×2 + b车×12 + Ⅰ固定站
    "II_FIXED":   {HF: 6,  VUHF: 4},   # 待确认：需领 4 个下级 + 上行 Ⅰ
    "II_MOBILE":  {HF: 1,  VUHF: 2},   # 图注：db设备*1，cdb设备*2
    "II_NODE":    {HF: 1,  VUHF: 5},   # 图注：db设备*1，Ⅰ型和Ⅱ型cdb设备*5
    "III_MOBILE": {HF: 1,  VUHF: 4},   # 图注：db设备*1，cdb设备*4
    "IV_MOBILE":  {HF: 0,  VUHF: 1},   # 待确认：单上级（答复 4：Ⅳ 不需双上级）
    "VEHICLE_A":  {HF: 4,  VUHF: 0},   # 待确认
    "VEHICLE_B":  {HF: 4,  VUHF: 0},   # 待确认
    "MANPACK":    {HF: 2,  VUHF: 0},   # 待确认：图中背负式同时挂 a车 与 b车
}

# 发射功率 dBm，取自 Visio 方框标注：400W=56, 125W=51, 50W=47, 20W=43
SUBTYPE_POWER = {
    ("I_FIXED", HF): 56.0, ("I_MOBILE", HF): 56.0,
    ("II_FIXED", HF): 56.0, ("II_MOBILE", HF): 56.0, ("II_NODE", HF): 56.0,
    ("III_MOBILE", HF): 56.0,
    ("II_FIXED", VUHF): 47.0, ("II_MOBILE", VUHF): 47.0,
    ("II_NODE", VUHF): 47.0, ("III_MOBILE", VUHF): 47.0,
    ("IV_MOBILE", VUHF): 47.0,
    ("VEHICLE_A", HF): 56.0, ("VEHICLE_B", HF): 51.0, ("MANPACK", HF): 43.0,
}

# 能否中继转发。按编成规则推导：末端节点无空余端口可供转发。
# 真实装备是否支持自动转信待 06 任务单回收后核实。
SUBTYPE_RELAY = {
    "I_FIXED": True, "I_MOBILE": True, "II_FIXED": True,
    "II_MOBILE": True, "II_NODE": True, "III_MOBILE": True,
    "IV_MOBILE": False, "VEHICLE_A": True, "VEHICLE_B": True,
    "MANPACK": False,
}

# ── 允许的链路关系 ────────────────────────────────────────
# 每项：(子类型A, 子类型B, 频段, 该链路能否承载上行中继流量)
# 无向——(A,B) 与 (B,A) 等价。
#
# 频段不是假设，是由 Visio「图上度数」与「框内设备台数」对照反推的：
#   Ⅳ 仅 cdb                      → Ⅲ──Ⅳ 必为 cdb
#   Ⅲ 度数 4 恰等于其 cdb 台数 4   → Ⅲ 的 4 条线全是 cdb（2 上行 2 下行）
#                                    故 Ⅱ──Ⅲ 走 cdb，不是 db
#   Ⅱ机动站 度数 3 = db×1+cdb×2    → cdb 下行两个 Ⅲ，db 上行 Ⅱ固定站
#   Ⅲ 的 db×1 在左支未被占用       → 正是标红段「与Ⅱ、Ⅲ的短波电台连接」的右支接入口
RELATIONS = [
    # ── 左支 · 编成主链 ──
    ("IV_MOBILE",  "III_MOBILE", VUHF, True),   # 图中 4 条 Ⅲ──Ⅳ
    ("III_MOBILE", "II_MOBILE",  VUHF, True),   # 图中 2 条
    ("III_MOBILE", "II_NODE",    VUHF, True),   # 图中 2 条
    ("II_MOBILE",  "II_FIXED",   HF,   True),   # 图中 1 条（跨行，父子）
    ("II_NODE",    "II_FIXED",   HF,   True),   # 图中 1 条（跨行，父子）
    ("II_FIXED",   "I_FIXED",    HF,   True),   # 图中 1 条
    ("II_FIXED",   "I_MOBILE",   HF,   True),   # 图中无；按「两个 Ⅰ 互为备份」推广，见 6.9-2
    ("I_FIXED",    "I_MOBILE",   HF,   True),   # 图中 1 条，同行互备

    # ── Ⅲ 层内直连（合作方口头补充，图上无先例；限同组，见 peer_link_allowed）──
    # 工程意义：被地形遮挡的 Ⅲ 借道邻近 Ⅲ 上行，不必新增中继电台或移位；
    # 同组 Ⅲ 之间互为备份。借道会消耗被借节点的端口容量。
    # db：Ⅲ 的 db×1 在左支未被占用，本就留给右支接入与 Ⅲ──Ⅲ。
    # cdb：合作方 2026-09-29 答复未限频段。cdb 端口要先满足 Ⅳ 接入（Ⅳ 只能接 Ⅲ 的 cdb）
    #      与 Ⅲ 自己上行，剩下的才给 Ⅲ──Ⅲ——由加链处的先后顺序保证，不在本表表达。
    ("III_MOBILE", "III_MOBILE", HF,   True),
    ("III_MOBILE", "III_MOBILE", VUHF, True),

    # ── 右支 · Ⅰ 直属短波机动力量（全为 db，不接触 Ⅳ）──
    ("I_MOBILE",   "VEHICLE_A",  HF,   True),
    ("I_MOBILE",   "VEHICLE_B",  HF,   True),
    ("VEHICLE_A",  "MANPACK",    HF,   True),
    ("VEHICLE_B",  "MANPACK",    HF,   True),

    # ── 右支接入左支的 db 侧（标红段「与Ⅱ、Ⅲ的短波电台连接」）──
    ("VEHICLE_A",  "II_FIXED",   HF,   True),
    ("VEHICLE_A",  "II_MOBILE",  HF,   True),
    ("VEHICLE_A",  "II_NODE",    HF,   True),
    ("VEHICLE_A",  "III_MOBILE", HF,   True),
    ("VEHICLE_B",  "II_FIXED",   HF,   True),
    ("VEHICLE_B",  "II_MOBILE",  HF,   True),
    ("VEHICLE_B",  "II_NODE",    HF,   True),
    ("VEHICLE_B",  "III_MOBILE", HF,   True),
    ("MANPACK",    "II_FIXED",   HF,   True),
    ("MANPACK",    "II_MOBILE",  HF,   True),
    ("MANPACK",    "II_NODE",    HF,   True),
    ("MANPACK",    "III_MOBILE", HF,   True),
]

# 图上**明确没有**的同行链路，单列出来作为自检对象，防止后续误加
FORBIDDEN_PEER = [
    ("II_MOBILE", "II_NODE"),    # 合作方「Ⅱ–Ⅱ 没有」；须经共同上级 Ⅱ固定站中继
    ("II_MOBILE", "II_MOBILE"),
    ("II_NODE",   "II_NODE"),
    ("IV_MOBILE", "IV_MOBILE"),  # 图上无线；Ⅳ 之间经共同上级 Ⅲ
]

# 根：上行到任一个 Ⅰ 即算到达（两个 Ⅰ 互为备份，见方案 6.9-2）
ROOT_SUBTYPES = frozenset({"I_FIXED", "I_MOBILE"})

# 可部署的移动电台类型。受「db 不能和 cdb 相连」限制，
# 四类里**只有 Ⅲ 机动站带超短波**，故 Ⅳ 接不上时唯一手段是增设 Ⅲ 机动站。
DEPLOYABLE_TYPES = ("III_MOBILE", "VEHICLE_A", "VEHICLE_B", "MANPACK")

# 部署代价（用于平局时择优，数量相同则优先便宜的）
DEPLOY_COST = {"MANPACK": 1.0, "VEHICLE_B": 2.0, "VEHICLE_A": 3.0, "III_MOBILE": 4.0}


# ── Ⅲ 同组（合作方 2026-09-29 答复，用户同日确认口径）────────────
# - 同组 = 规划结果中两个 Ⅲ 直接相连的 Ⅱ 有交集。Ⅲ 挂哪个 Ⅱ 是规划时的选择，
#   可改挂、可双归属；nodes 表的 parent_node_id（编成上级）不作约束。
# - 借道的 Ⅲ（够不到任何 Ⅱ、经邻近 Ⅲ 上行）算借出方那一组，借道链路本身始终允许。
# - 作战损伤工况放宽，与损伤工况不查编成规则的口径一致——合作方未说，待确认。
PEER_SUBTYPE = "III_MOBILE"
PEER_GROUP_HEADS = frozenset({"II_MOBILE", "II_NODE"})   # Ⅲ 只上行到这两类 Ⅱ


def is_peer_pair(sub_a, sub_b):
    """两端都是 Ⅲ：除站型规则外还要过同组判据。"""
    return sub_a == PEER_SUBTYPE and sub_b == PEER_SUBTYPE


def peer_groups(subtype_of, links, uplink_of=None):
    """规划结果中每个 Ⅲ 所属的组，返回 {Ⅲ: frozenset(Ⅱ)}。

    subtype_of  节点 -> 子类型（dict 或可调用）
    links       可迭代的 (a, b, ...)；其中每条 Ⅲ──Ⅱ 链路都计入归属，多条即双归属
    uplink_of   节点 -> 主上行对端；对端是 Ⅲ 的即借道，借道者并入借出方的组（可链式）
    """
    sub = subtype_of if callable(subtype_of) else subtype_of.get
    up = uplink_of or {}
    direct, peers = {}, set()
    for l in links:
        a, b = l[0], l[1]
        for x, y in ((a, b), (b, a)):
            if sub(x) == PEER_SUBTYPE:
                peers.add(x)
                if sub(y) in PEER_GROUP_HEADS:
                    direct.setdefault(x, set()).add(y)
    peers.update(x for x in up if sub(x) == PEER_SUBTYPE)
    out = {}
    for x in peers:
        g, cur, seen = set(), x, set()
        while cur is not None and cur not in seen and sub(cur) == PEER_SUBTYPE:
            seen.add(cur)
            g |= direct.get(cur, set())
            cur = up.get(cur)
        out[x] = frozenset(g)
    return out


def peer_link_allowed(a, b, groups, uplink_of=None, damaged=False):
    """两个 Ⅲ 之间能否直接建链：借道链路本身、或两端同组。"""
    if damaged:
        return True
    up = uplink_of or {}
    if up.get(a) == b or up.get(b) == a:
        return True
    return bool(groups.get(a, frozenset()) & groups.get(b, frozenset()))


# ── 查询接口 ──────────────────────────────────────────────
def _key(a, b):
    return (a, b) if a <= b else (b, a)


_REL = {}
for _a, _b, _band, _relay in RELATIONS:
    _REL.setdefault(_key(_a, _b), {})[_band] = _relay


def allowed_bands(sub_a, sub_b):
    """两个子类型之间允许建链的频段集合；空集表示编成不允许。"""
    return frozenset(_REL.get(_key(sub_a, sub_b), {}).keys())


def relation_allowed(sub_a, sub_b, band):
    """正常工况下 (sub_a, sub_b) 能否在 band 上建链。"""
    return band in _REL.get(_key(sub_a, sub_b), {})


def can_relay(sub_a, sub_b, band):
    """该链路能否承载上行中继流量（区别于仅能直连）。"""
    return _REL.get(_key(sub_a, sub_b), {}).get(band, False)


def capacity(subtype, band):
    """该子类型在该频段的端口容量 = 编成定额的设备台数。"""
    return ECHELON_CAP[subtype][band]


def bands_of(subtype):
    """该子类型实际装备的频段。"""
    return tuple(b for b in BANDS if ECHELON_CAP[subtype][b] > 0)


def is_dual_band(subtype):
    """双频节点才能做频段转换（合作方称「转了一层」）。"""
    return len(bands_of(subtype)) > 1


def is_root(subtype):
    return subtype in ROOT_SUBTYPES


def self_check():
    """自检编成表的内部一致性，返回问题列表（空表示通过）。"""
    problems = []
    subs = set(SUBTYPE_ECHELON)
    for d in (SUBTYPE_ROW, SUBTYPE_NAME, SUBTYPE_MOBILITY, ECHELON_CAP, SUBTYPE_RELAY):
        miss = subs - set(d)
        if miss:
            problems.append("子类型表缺项: %s" % sorted(miss))

    for a, b, band, _ in RELATIONS:
        for s in (a, b):
            if s not in subs:
                problems.append("关系表引用了未知子类型 %s" % s)
        # 两端都必须实际装备该频段，否则「db 不能和 cdb 相连」被违反
        if ECHELON_CAP.get(a, {}).get(band, 0) == 0:
            problems.append("%s 无 %s 设备，却允许 %s──%s 走 %s" % (a, band, a, b, band))
        if ECHELON_CAP.get(b, {}).get(band, 0) == 0:
            problems.append("%s 无 %s 设备，却允许 %s──%s 走 %s" % (b, band, a, b, band))

    for a, b in FORBIDDEN_PEER:
        if allowed_bands(a, b):
            problems.append("%s──%s 应为禁止，却出现在关系表中" % (a, b))

    # Ⅳ 的上级只能是 Ⅲ（合作方答复 2a：不允许降级挂 Ⅱ）
    for s in subs:
        if s == "IV_MOBILE":
            continue
        if allowed_bands("IV_MOBILE", s) and s != "III_MOBILE":
            problems.append("Ⅳ 不得与 %s 建链（上级只能是 Ⅲ）" % s)

    # 只有 Ⅲ 机动站带超短波，才可能接 Ⅳ
    for t in DEPLOYABLE_TYPES:
        if t != "III_MOBILE" and VUHF in bands_of(t):
            problems.append("%s 不应带超短波" % t)

    problems.extend(_peer_group_cases())
    return problems


def _peer_group_cases():
    """Ⅲ 同组判据的用例。A/B 是 Ⅱ，x/y/z/w 是 Ⅲ，c、d 借道。"""
    bad = []
    for band in (HF, VUHF):
        if not relation_allowed(PEER_SUBTYPE, PEER_SUBTYPE, band):
            bad.append("Ⅲ──Ⅲ 应允许走 %s（同组判据另判）" % band)
    sub = {"A": "II_MOBILE", "B": "II_NODE", "F": "II_FIXED", "V": "VEHICLE_B",
           "x": PEER_SUBTYPE, "y": PEER_SUBTYPE, "z": PEER_SUBTYPE, "w": PEER_SUBTYPE,
           "c": PEER_SUBTYPE, "d": PEER_SUBTYPE, "o": PEER_SUBTYPE}
    links = [("x", "A"), ("y", "A"), ("z", "B"), ("w", "A"), ("w", "B"),
             ("c", "x"), ("d", "c"), ("A", "F"), ("o", "V")]
    up = {"x": "A", "y": "A", "z": "B", "w": "A", "c": "x", "d": "c", "A": "F", "o": "V"}
    g = peer_groups(sub, links, up)
    cases = [("x", "y", False, True, "同一个 Ⅱ 下"),
             ("x", "z", False, False, "不同 Ⅱ 下"),
             ("w", "z", False, True, "双归属的 Ⅲ 与另一个 Ⅱ 下的 Ⅲ"),
             ("c", "x", False, True, "借道链路本身"),
             ("c", "y", False, True, "借道者与借出方同组的 Ⅲ"),
             ("c", "z", False, False, "借道者与借出方不同组的 Ⅲ"),
             ("d", "y", False, True, "链式借道继承到底"),
             ("o", "x", False, False, "没挂 Ⅱ 也没借道的 Ⅲ"),
             ("x", "z", True, True, "损伤工况放宽")]
    for a, b, dmg, want, what in cases:
        got = peer_link_allowed(a, b, g, up, damaged=dmg)
        if got != want:
            bad.append("同组判据错误：%s（%s──%s 应为 %s，得 %s）" % (what, a, b, want, got))
    if g.get("w") != frozenset({"A", "B"}):
        bad.append("双归属应同属两组，得 %s" % sorted(g.get("w", ())))
    return bad


if __name__ == "__main__":
    bad = self_check()
    if bad:
        print("编成模型自检未通过:")
        for x in bad:
            print("  ✗", x)
        raise SystemExit(1)
    print("编成模型自检通过")
    print("\n子类型 %d 类，允许的链路关系 %d 条：" % (len(SUBTYPE_ECHELON), len(RELATIONS)))
    for (a, b), bands in sorted(_REL.items()):
        print("  %-12s ── %-12s  %s" % (a, b, "/".join(sorted(bands))))
    print("\n禁止的同行链路：")
    for a, b in FORBIDDEN_PEER:
        print("  %-12s ── %-12s  （图上无连线）" % (a, b))
    print("\nⅢ──Ⅲ 另须同组（共享一个 Ⅱ；借道者算借出方那一组），同组判据用例全部通过")
