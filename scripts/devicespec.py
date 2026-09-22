"""真实设备型号的缺失字段处理。

任务单 `06_设备参数补全任务单.md` 明确要求「手册里查不到 → **留空**，不要编造」，
因此真实型号库里必然有空字段。但链路预算算不了空值，需要一套**可追溯的缺省规则**。

三条原则（对应 CLAUDE.md「不确定的一律标注待确认，不得编造」）：

1. **同频段其他型号有值 → 取它们的中位数**，并记为「同类推定」。
   这是从已有实测值推出来的，不是凭空造的。
2. **同频段全缺 → 取标准信道带宽**，并记为「标准值代入」。
   短波 3 kHz（SSB 单边带话路）、超短波 25 kHz（FM 信道间隔）是通用制式常数，
   不是某型号的参数，因此代入不构成编造。
3. **每一次代入都记录**，生成结束时打印汇总，写入数据时在 remark 标注。

不满足以上任一条时**不代入**，让调用方显式处理——宁可报错也不要静默出假数。
"""

# 标准信道带宽（kHz）。来源：短波 SSB 话路 3 kHz、超短波 FM 信道间隔 25 kHz，
# 属通用制式常数而非型号参数。
STANDARD_BANDWIDTH_KHZ = {"HF": 3.0, "VUHF": 25.0}


class SpecFiller:
    """按频段统计已有值，为缺失字段提供可追溯的缺省。"""

    def __init__(self, models):
        self.models = list(models)
        self._median = {}
        self.substitutions = []          # (model_id, field, value, 依据)

    def _median_of(self, band, field):
        key = (band, field)
        if key not in self._median:
            vals = []
            for m in self.models:
                if m.get("device_class") != band:
                    continue
                v = (m.get(field) or "").strip()
                if v:
                    try:
                        vals.append(float(str(v).split(";")[0]))
                    except ValueError:
                        pass
            vals.sort()
            self._median[key] = vals[len(vals) // 2] if vals else None
        return self._median[key]

    def number(self, model, field, standard=None):
        """取字段的数值；缺失时按三条原则代入并留痕。"""
        raw = (model.get(field) or "").strip()
        if raw:
            try:
                return float(str(raw).split(";")[0])
            except ValueError:
                pass
        band = model.get("device_class", "")
        med = self._median_of(band, field)
        if med is not None:
            self.substitutions.append(
                (model.get("model_id", "?"), field, med, "同类推定（%s 频段中位数）" % band))
            return med
        if standard is not None:
            val = standard.get(band) if isinstance(standard, dict) else standard
            if val is not None:
                self.substitutions.append(
                    (model.get("model_id", "?"), field, val, "标准值代入"))
                return float(val)
        return None

    def bandwidth(self, model):
        return self.number(model, "bandwidth_khz", STANDARD_BANDWIDTH_KHZ)

    def sensitivity(self, model):
        return self.number(model, "rx_sensitivity_dbm")

    def report(self):
        if not self.substitutions:
            return "  设备参数：无缺失字段，全部取自真实型号库"
        by_field = {}
        for mid, field, val, why in self.substitutions:
            by_field.setdefault((field, why), []).append((mid, val))
        distinct = {(m, f) for m, f, _v, _w in self.substitutions}
        lines = ["  设备参数缺失代入：%d 个(型号,字段)缺口，影响 %d 台设备实例"
                 "（真实型号库按任务单要求「查不到留空」）"
                 % (len(distinct), len(self.substitutions))]
        for (field, why), items in sorted(by_field.items()):
            ids = ", ".join(sorted({m for m, _ in items}))
            vals = sorted({v for _, v in items})
            lines.append("    %-20s %-24s 取值 %s  型号 %s（%d 台实例）"
                         % (field, why,
                            "/".join("%g" % v for v in vals), ids, len(items)))
        return "\n".join(lines)
