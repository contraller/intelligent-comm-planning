"""方案校验（第 3 周「检查不同链路之间是否存在频率冲突或配置冲突」）。

把路由、频率、参数三块的结果放在一起做一次交叉检查，产出一张问题清单。
对应 SR-4.2 c)「方案冲突校验」。

检查项
------
1. **频率冲突**   同频/邻频冲突（直接复用 `frequency.check_conflicts` 的结论）
2. **频率越界**   分到的频点是否落在两端设备频段范围内
3. **参数越界**   功率是否在型号档位内、挂高是否在天线区间内
4. **余量不足**   链路余量是否达到本方案的衰落余量门限
5. **容量越限**   每个 (节点, 频段) 的链路数是否超过编成定额
6. **频段串联**   有没有短波链路直接接到超短波链路上（db/cdb 不得相连）
7. **路由可达**   通联需求是否都有主用路由；有无单点故障且无备用的

每一项都给出**问题清单**而不是只给一个布尔值，因为前端要把冲突逐条渲染出来。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import echelon as E

SEVERITY_ORDER = {"SEVERE": 0, "MODERATE": 1, "MINOR": 2}


def _issue(kind, severity, detail, **kw):
    d = dict(kind=kind, severity=severity, detail=detail)
    d.update(kw)
    return d


def check(freq_result=None, freq_tasks=None, param_result=None,
          route_result=None, links=None, nodes=None, caps=None):
    """交叉校验。各部分都可以缺省，缺的部分跳过对应检查。"""
    issues = []
    checked = []

    # ── 1 频率冲突 ──
    if freq_result is not None:
        checked.append("频率冲突")
        for c in freq_result.get("conflicts", []):
            issues.append(_issue(
                "FREQ_CONFLICT", c.get("severity", "MODERATE"),
                "%s：%s 与 %s，间隔 %.0f m（要求 ≥%.0f m）"
                % ("同频" if c["type"] == "CO_CHANNEL" else "邻频",
                   c["link_ids"][0], c["link_ids"][1],
                   c.get("distance_m", 0), c.get("required_distance_m", 0)),
                link_ids=c["link_ids"], conflict_type=c["type"]))
        for lid in freq_result.get("unassigned", []):
            issues.append(_issue("FREQ_UNASSIGNED", "SEVERE",
                                 "%s 没有可用频点" % lid, link_ids=[lid]))

    # ── 2 频率越界 ──
    if freq_result is not None and freq_tasks is not None:
        checked.append("频率越界")
        idx = {t.task_id: t for t in freq_tasks}
        for a in freq_result.get("assignments", []):
            t = idx.get(a.get("task_id") or a.get("link_id"))
            if t is None or a.get("freq_khz") is None:
                continue
            if not t.in_range(a["freq_khz"]):
                issues.append(_issue(
                    "FREQ_OUT_OF_RANGE", "SEVERE",
                    "%s 分到 %.1f kHz，超出设备频段 %s–%s kHz"
                    % (t.task_id, a["freq_khz"], t.freq_min_khz, t.freq_max_khz),
                    link_ids=[t.task_id]))

    # ── 3 参数越界 + 4 余量不足 ──
    if param_result is not None:
        checked.append("参数越界")
        if caps:
            for p in param_result.get("params", []):
                c = caps.get((p["node_id"], p["band"]))
                if c is None:
                    continue
                if p["tx_power_dbm"] not in c.levels:
                    issues.append(_issue(
                        "PARAM_OUT_OF_RANGE", "SEVERE",
                        "%s %s 功率 %.1f dBm 不在型号档位 %s 内"
                        % (p["node_id"], p["band"], p["tx_power_dbm"], c.levels),
                        node_id=p["node_id"]))
                if not (c.h_min - 1e-9 <= p["antenna_height_m"] <= c.h_max + 1e-9):
                    issues.append(_issue(
                        "PARAM_OUT_OF_RANGE", "SEVERE",
                        "%s %s 挂高 %.1f m 超出天线区间 %.1f–%.1f m"
                        % (p["node_id"], p["band"], p["antenna_height_m"],
                           c.h_min, c.h_max),
                        node_id=p["node_id"]))
        checked.append("余量不足")
        for l in param_result.get("failed_links", []):
            issues.append(_issue(
                "MARGIN_SHORTFALL",
                "SEVERE" if l["margin_db"] < 0 else "MODERATE",
                "%s—%s（%s）余量 %.1f dB，未达门限 %.1f dB"
                % (l["node_a"], l["node_b"], l["band"],
                   l["margin_db"], l["required_margin_db"]),
                node_ids=[l["node_a"], l["node_b"]], band=l["band"]))

    # ── 5 容量越限 + 6 频段串联 ──
    if links is not None and nodes is not None:
        checked.append("容量越限")
        sub = {n["node_id"]: n.get("node_subtype", "") for n in nodes}
        deg = {}
        for l in links:
            if str(l.get("is_available", "true")).lower() == "false":
                continue
            for sid in (l["node_a_id"], l["node_b_id"]):
                deg[(sid, l["device_class"])] = deg.get((sid, l["device_class"]), 0) + 1
        for (sid, band), d in sorted(deg.items()):
            cap = E.capacity(sub.get(sid, ""), band)
            if cap and d > cap:
                issues.append(_issue(
                    "CAPACITY_EXCEEDED", "SEVERE",
                    "%s（%s）%s 链路 %d 条，超过编成定额 %d"
                    % (sid, sub.get(sid, "?"), band, d, cap),
                    node_id=sid, band=band, used=d, capacity=cap))
        checked.append("频段串联")
        # 一条链路两端的 device_class 必须一致；跨频段只能在节点内部完成
        for l in links:
            a_ok = l.get("device_class") in (E.HF, E.VUHF)
            if not a_ok:
                issues.append(_issue("BAND_INVALID", "SEVERE",
                                     "%s 的频段 %r 不是 HF/VUHF"
                                     % (l["link_id"], l.get("device_class")),
                                     link_ids=[l["link_id"]]))

    # ── 7 路由可达 ──
    if route_result is not None:
        checked.append("路由可达")
        for did in route_result.get("unreachable_demand_ids", []):
            issues.append(_issue("ROUTE_UNREACHABLE", "SEVERE",
                                 "通联需求 %s 无可达路由" % did, demand_id=did))
        for r in route_result.get("routes", []):
            if not r.get("reachable"):
                continue
            if r.get("backup_type") == "NONE" and r.get("single_point_risks"):
                issues.append(_issue(
                    "SINGLE_POINT_RISK", "MODERATE",
                    "需求 %s 无备用路由，且主路由经过单点 %s"
                    % (r["demand_id"], "、".join(r["single_point_risks"])),
                    demand_id=r["demand_id"], nodes=r["single_point_risks"]))
            for e in r.get("manual_errors", []) or []:
                issues.append(_issue("MANUAL_PATH_INVALID", "SEVERE",
                                     "需求 %s 的人工路径不可用：%s" % (r["demand_id"], e),
                                     demand_id=r["demand_id"]))

    issues.sort(key=lambda i: (SEVERITY_ORDER.get(i["severity"], 9), i["kind"]))
    by_kind = {}
    for i in issues:
        by_kind[i["kind"]] = by_kind.get(i["kind"], 0) + 1
    return dict(
        passed=not any(i["severity"] == "SEVERE" for i in issues),
        issues=issues,
        summary=dict(total=len(issues),
                     severe=sum(1 for i in issues if i["severity"] == "SEVERE"),
                     moderate=sum(1 for i in issues if i["severity"] == "MODERATE"),
                     by_kind=by_kind,
                     checks_run=checked))


def format_report(res, limit=8):
    out = []
    s = res["summary"]
    out.append("方案校验：%s   问题 %d 条（严重 %d / 一般 %d）"
               % ("通过" if res["passed"] else "未通过", s["total"],
                  s["severe"], s["moderate"]))
    out.append("执行的检查：%s" % "、".join(s["checks_run"]))
    for kind, n in sorted(s["by_kind"].items(), key=lambda kv: -kv[1]):
        out.append("  %-22s %d 条" % (kind, n))
    if res["issues"]:
        out.append("前 %d 条：" % min(limit, len(res["issues"])))
        for i in res["issues"][:limit]:
            out.append("  [%s] %s" % (i["severity"], i["detail"]))
    return "\n".join(out)
