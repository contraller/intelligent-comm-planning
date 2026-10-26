"""链路状态知识（SR-6.2 网络态势知识图谱的核心）。

需规 SR-6.2 a/c：以信噪比、误码率、丢包率、时延、吞吐率五项指标，
建立「指标 → 链路状态（优秀/良好/预警/故障）」的关联关系，并从历史运行数据
挖掘状态判定规则与状态演化规律。

做法（纯标准库）：
1. **判定规则挖掘**：按频段、按指标，在相邻两级状态之间搜索使分类正确率最高的门限，
   得到形如 `snr_db >= 29.7 → EXCELLENT` 的规则，附支持度与置信度；
2. **状态评估**：五项指标各自按规则判级，按各指标的历史判别正确率加权投票，
   输出状态、置信度、命中规则、主导指标与中文解释（接口文档 4 节 `link-state/evaluate`）；
3. **演化规律**：同一链路相邻两次观测的状态转移频率（一阶马尔可夫）；
4. **异常检测**：新观测相对该链路历史的信噪比 z 分数与状态跳级。

**口径说明（必须随结论传递）**：测试数据的 `link_state` 标签是生成脚本按
「信噪比 − 业务解调门限」打的（与数据字典附录的四级余量判据同源），
其余四项指标又由信噪比推出。因此挖出来的信噪比门限会精确复现生成规则，
正确率接近 100% 是**数据同源**的结果，不代表对真实网络的判别能力。
真实运行数据接入后重跑 `mine()` 即可，接口不变。
"""
import csv
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datapaths import path as dpath

STATES = ["FAULT", "WARNING", "GOOD", "EXCELLENT"]          # 由差到好
STATE_CN = {"EXCELLENT": "优秀", "GOOD": "良好", "WARNING": "预警", "FAULT": "故障"}
# 指标：(字段, 中文名, 单位, 方向)。方向 +1 表示越大越好
METRICS = [
    ("snr_db", "信噪比", "dB", +1),
    ("ber", "误码率", "", -1),
    ("packet_loss_rate", "丢包率", "", -1),
    ("delay_ms", "时延", "ms", -1),
    ("throughput_kbps", "吞吐率", "kbps", +1),
]
METRIC_CN = {m[0]: m[1] for m in METRICS}


def _val(field, v):
    """误码率跨多个数量级，取对数后再找门限。"""
    x = float(v)
    if field == "ber":
        return math.log10(max(x, 1e-12))
    return x


def _fmt(field, x):
    if field == "ber":
        return "%.1e" % (10 ** x)
    if field == "packet_loss_rate":
        return "%.1f%%" % (100 * x)
    return "%.1f" % x


def _best_cut(pairs, direction):
    """pairs: [(值, 是否属于较好一级)]。返回 (门限, 正确率)。

    较好一级应满足 值 >= 门限（direction=+1）或 值 <= 门限（direction=-1）。
    """
    if not pairs:
        return None, 0.0
    pts = sorted(pairs)
    n = len(pts)
    total_good = sum(1 for _v, g in pts if g)
    best_t, best_acc = None, -1.0
    # 扫描所有相邻取值之间的切点
    below_good = 0
    for k in range(n + 1):
        if k > 0:
            below_good += 1 if pts[k - 1][1] else 0
        if 0 < k < n and pts[k][0] == pts[k - 1][0]:
            continue
        if direction > 0:
            # 切点以上判「较好」
            correct = (k - below_good) + (total_good - below_good)
        else:
            correct = below_good + ((n - k) - (total_good - below_good))
        acc = correct / n
        if acc > best_acc:
            lo = pts[k - 1][0] if k > 0 else pts[0][0] - 1.0
            hi = pts[k][0] if k < n else pts[-1][0] + 1.0
            best_acc, best_t = acc, (lo + hi) / 2.0
    return best_t, best_acc


class LinkStateKnowledge:
    """挖掘结果 + 评估器。"""

    def __init__(self):
        self.rules = []            # dict(rule_id, band, metric, op, threshold, state, support, confidence)
        self.metric_acc = {}       # (band, metric) -> 单指标判级正确率
        self.transitions = {}      # band -> {from: {to: p}}
        self.history = {}          # link_id -> dict(mean, std, n, typical_state)
        self.band_of = {}          # link_id -> band
        self.n_records = 0

    # ─────────────────────────── 挖掘 ───────────────────────────
    def mine(self, metric_rows, link_rows):
        self.band_of = {l["link_id"]: l["device_class"] for l in link_rows}
        by_band = {}
        for r in metric_rows:
            b = self.band_of.get(r["link_id"])
            if b and r.get("link_state") in STATES:
                by_band.setdefault(b, []).append(r)
        self.n_records = sum(len(v) for v in by_band.values())
        self.rules, self.metric_acc = [], {}
        rid = 0
        for band in sorted(by_band):
            rows = by_band[band]
            for field, _cn, _u, direction in METRICS:
                cuts = []
                for k in range(1, len(STATES)):
                    worse, better = STATES[k - 1], STATES[k]
                    pairs = [(_val(field, r[field]), r["link_state"] == better)
                             for r in rows if r["link_state"] in (worse, better)]
                    t, acc = _best_cut(pairs, direction)
                    if t is None:
                        continue
                    support = len(pairs)
                    cuts.append((better, t, acc, support))
                # 单指标判级的整体正确率
                correct = 0
                for r in rows:
                    if self._grade_one(field, _val(field, r[field]), cuts, direction) == r["link_state"]:
                        correct += 1
                self.metric_acc[(band, field)] = correct / max(1, len(rows))
                for better, t, acc, support in cuts:
                    rid += 1
                    self.rules.append(dict(
                        rule_id="LR-%04d" % rid, band=band, metric=field,
                        op=">=" if direction > 0 else "<=", threshold=t,
                        threshold_text=_fmt(field, t), state=better,
                        support=support, confidence=round(acc, 4)))
        self._mine_transitions(metric_rows)
        self._mine_history(metric_rows)
        return self

    @staticmethod
    def _grade_one(field, x, cuts, direction):
        """按一个指标的逐级门限判级：满足更好一级门限就往上升。"""
        state = STATES[0]
        for better, t, _acc, _s in cuts:
            ok = x >= t if direction > 0 else x <= t
            if ok:
                state = better
            else:
                break
        return state

    def _mine_transitions(self, metric_rows):
        seq = {}
        for r in metric_rows:
            seq.setdefault(r["link_id"], []).append(r)
        cnt = {}
        for lid, rs in seq.items():
            b = self.band_of.get(lid)
            rs.sort(key=lambda r: r["timestamp"])
            for a, c in zip(rs, rs[1:]):
                cnt.setdefault(b, {}).setdefault(a["link_state"], {})
                cnt[b][a["link_state"]][c["link_state"]] = \
                    cnt[b][a["link_state"]].get(c["link_state"], 0) + 1
        self.transitions = {}
        for b, m in cnt.items():
            self.transitions[b] = {}
            for s, row in m.items():
                tot = sum(row.values())
                self.transitions[b][s] = {t: round(v / tot, 4) for t, v in sorted(row.items())}

    def _mine_history(self, metric_rows):
        acc = {}
        for r in metric_rows:
            acc.setdefault(r["link_id"], []).append(r)
        self.history = {}
        for lid, rs in acc.items():
            xs = [float(r["snr_db"]) for r in rs]
            m = sum(xs) / len(xs)
            sd = math.sqrt(sum((x - m) ** 2 for x in xs) / max(1, len(xs) - 1))
            states = [r["link_state"] for r in rs]
            typical = max(set(states), key=states.count)
            thr = [float(r["throughput_kbps"]) for r in rs]
            self.history[lid] = dict(snr_mean=m, snr_std=max(sd, 0.5), n=len(xs),
                                     typical_state=typical,
                                     throughput_mean=sum(thr) / len(thr))

    # ─────────────────────────── 评估 ───────────────────────────
    def _cuts(self, band, field):
        return [(r["state"], r["threshold"], r["confidence"], r["support"])
                for r in self.rules if r["band"] == band and r["metric"] == field]

    def evaluate(self, rec, band=None):
        """评估一条链路观测（接口 `POST /kg/link-state/evaluate`）。

        rec: {link_id?, snr_db?, ber?, packet_loss_rate?, delay_ms?, throughput_kbps?}
        缺哪项指标就不用哪项，至少要有一项。
        """
        band = band or self.band_of.get(rec.get("link_id")) or "VUHF"
        votes, detail = {}, []
        for field, cn, unit, direction in METRICS:
            if rec.get(field) in (None, ""):
                continue
            x = _val(field, rec[field])
            cuts = self._cuts(band, field)
            if not cuts:
                continue
            st = self._grade_one(field, x, cuts, direction)
            w = self.metric_acc.get((band, field), 0.5)
            votes[st] = votes.get(st, 0.0) + w
            # 找出决定这一级的规则：本级门限（已满足）与上一级门限（未满足）
            hit = [r for r in self.rules if r["band"] == band and r["metric"] == field
                   and r["state"] == st]
            nxt = [r for r in self.rules if r["band"] == band and r["metric"] == field
                   and STATES.index(r["state"]) == STATES.index(st) + 1]
            detail.append(dict(metric=field, value=rec[field], state=st, weight=round(w, 3),
                               rule_ids=[r["rule_id"] for r in hit],
                               next_level_rule=(nxt[0]["rule_id"] if nxt else None),
                               next_level_threshold=(nxt[0]["threshold_text"] if nxt else None)))
        if not votes:
            return None
        tot = sum(votes.values())
        state = max(votes, key=lambda s: (votes[s], -STATES.index(s)))
        conf = votes[state] / tot
        # 主导指标：与结论一致的指标里历史判别正确率最高者
        agree = [d for d in detail if d["state"] == state]
        dom = max(agree, key=lambda d: d["weight"]) if agree else detail[0]
        return dict(link_id=rec.get("link_id"), band=band, link_state=state,
                    link_state_cn=STATE_CN[state], confidence=round(conf, 3),
                    matched_rules=sorted({x for d in agree for x in d["rule_ids"]}),
                    dominant_metric=dom["metric"],
                    explanation=self._explain(state, detail),
                    per_metric=detail,
                    anomaly=self.anomaly(rec, state))

    def _explain(self, state, detail):
        parts = []
        for d in detail:
            cn = METRIC_CN[d["metric"]]
            v = d["value"]
            vs = ("%.1f%%" % (100 * float(v))) if d["metric"] == "packet_loss_rate" else str(v)
            if d["next_level_threshold"] and d["state"] != "EXCELLENT":
                parts.append("%s %s 未达%s门限 %s" % (
                    cn, vs, STATE_CN[STATES[STATES.index(d["state"]) + 1]],
                    d["next_level_threshold"]))
            else:
                parts.append("%s %s 判为%s" % (cn, vs, STATE_CN[d["state"]]))
        return "综合判为%s：" % STATE_CN[state] + "；".join(parts)

    def anomaly(self, rec, state=None):
        """相对该链路历史的异常：信噪比 z 分数 < -3，或状态比常态低两级及以上。"""
        h = self.history.get(rec.get("link_id"))
        if not h or rec.get("snr_db") in (None, ""):
            return None
        z = (float(rec["snr_db"]) - h["snr_mean"]) / h["snr_std"]
        drop = (STATES.index(h["typical_state"]) - STATES.index(state)) if state else 0
        return dict(snr_zscore=round(z, 2), typical_state=h["typical_state"],
                    level_drop=drop, is_anomaly=bool(z < -3.0 or drop >= 2))

    def predict_next(self, band, state):
        """一步状态演化预测（SR-6.2 c 状态演化规律）。"""
        return self.transitions.get(band, {}).get(state, {})

    def summary(self):
        by_band = {}
        for (band, field), acc in self.metric_acc.items():
            by_band.setdefault(band, {})[field] = round(acc, 4)
        return dict(records=self.n_records, rules=len(self.rules),
                    metric_accuracy=by_band, transitions=self.transitions)


class ThroughputMap:
    """按频段的「信噪比 → 吞吐率」经验映射（影响分析估带宽损失用）。

    取同频段历史记录中信噪比最接近的 k 条的吞吐率中位数——
    经验映射，不假设任何解析公式。
    """

    def __init__(self, metric_rows, band_of, k=20):
        self.k = k
        self.pts = {}
        for r in metric_rows:
            b = band_of.get(r["link_id"])
            if b:
                self.pts.setdefault(b, []).append((float(r["snr_db"]), float(r["throughput_kbps"])))
        for b in self.pts:
            self.pts[b].sort()

    def at(self, band, snr):
        pts = self.pts.get(band)
        if not pts:
            return None
        # 二分找位置，再向两边取 k 个近邻
        lo, hi = 0, len(pts)
        while lo < hi:
            mid = (lo + hi) // 2
            if pts[mid][0] < snr:
                lo = mid + 1
            else:
                hi = mid
        a, b = max(0, lo - self.k // 2), min(len(pts), lo + self.k // 2)
        vals = sorted(p[1] for p in pts[a:b]) or [pts[min(lo, len(pts) - 1)][1]]
        return vals[len(vals) // 2]


def load(rel):
    with open(dpath(rel), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def build_default():
    metrics, links = load("link_metric.csv"), load("link.csv")
    k = LinkStateKnowledge().mine(metrics, links)
    return k, ThroughputMap(metrics, k.band_of)


def _self_test():
    import time
    t0 = time.time()
    k, tm = build_default()
    print("=" * 76)
    print("SR-6.2 链路状态知识挖掘  记录 %d 条  规则 %d 条  (%.2f s)"
          % (k.n_records, len(k.rules), time.time() - t0))
    print("=" * 76)
    for band, accs in sorted(k.summary()["metric_accuracy"].items()):
        print("  %-5s 单指标判级正确率  " % band
              + "  ".join("%s %.3f" % (METRIC_CN[f], a) for f, a in accs.items()))
    print("\n  挖出的门限（信噪比）：")
    for r in k.rules:
        if r["metric"] == "snr_db":
            print("    %s %-5s snr_db %s %6s dB → %-9s 置信度 %.3f 支持 %d"
                  % (r["rule_id"], r["band"], r["op"], r["threshold_text"], r["state"],
                     r["confidence"], r["support"]))
    print("\n  状态演化（VUHF 一步转移概率）：")
    for s, row in sorted(k.transitions.get("VUHF", {}).items(), key=lambda x: STATES.index(x[0])):
        print("    %-9s → %s" % (s, "  ".join("%s %.2f" % (t, p) for t, p in row.items())))
    ex = dict(link_id="LK-0398", snr_db=8.4, ber=2.1e-4, packet_loss_rate=0.06,
              delay_ms=95, throughput_kbps=38)
    r = k.evaluate(ex)
    print("\n  接口文档样例评估：%s %s 置信度 %.2f 主导 %s"
          % (r["link_id"], r["link_state"], r["confidence"], r["dominant_metric"]))
    print("    %s" % r["explanation"])
    print("    异常：%s" % r["anomaly"])
    print("  吞吐率经验映射 VUHF：snr 10 → %.1f kbps，snr 30 → %.1f kbps"
          % (tm.at("VUHF", 10), tm.at("VUHF", 30)))
    print("=" * 76)


if __name__ == "__main__":
    _self_test()
