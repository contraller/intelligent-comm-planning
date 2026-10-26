"""故障资料的实体抽取与归一（SR-6.3 知识抽取）。

《技术参考》(1) 建议 BiLSTM-CRF + BERT 做实体识别、远程监督做关系抽取。
本项目只用标准库、且资料只有 240 条结构化案例（师弟从 FM24-19、ARRL、
无线电操作员培训手册整理），深度模型既无依赖也无训练量。这里用
**领域词典 + 关键词规则** 做同样的两件事：

1. 把英文原文里的部件归一到中文标准部件名（与设备知识图谱的部件实体同名，
   两张图谱借此连通）；
2. 把英文现象描述映射到现象字典的 `SY-xxxx` 编码（三路推理共用同一套编码，
   数据字典 3.2 的要求）。

设计意图：规则抽取的结果一律带来源标记 `AUTO_EXTRACT`、权重打折，并按《技术参考》
「人工校验比例初期 ≥30%」抽样出校验清单交人工核对。这会改变任务单 07 的分工
（由人工构造三元组改为人工校验自动抽取结果），**是否这样分工尚未定，见待办 #29**。
本模块目前只有抽取与归一函数，打标、打折、抽样尚未实现。
抽不出的不硬凑：部件抽不到就记「未归一」，现象抽不到就只保留原文。
"""
import re

# ─────────────────────── 部件归一：关键词 → 标准部件名 ───────────────────────
# 顺序即优先级：先匹配更具体的（天线调谐器先于天线）。
COMPONENT_RULES = [
    (r"tuner|tune|tuning|coupler|cplr|matching|ant_load", "天线调谐器"),
    (r"coax|feedline|feed line|jumper|connector|water_in_coax|balun", "天线馈线"),
    (r"antenna|element", "天线系统"),
    (r"final_amplifier|amplifier|\bpa\b|pa_|driver|grid_drive|bias|filament", "功率放大模块"),
    (r"oscillator|synthes", "频率合成模块"),
    (r"relay|rf_switch|bandswitch", "射频开关组件"),
    (r"fuse|breaker|power_supply|power_source|dc_|ac_|voltage|battery|inverter|"
     r"generator|main_power|external_power|no_power|power_distribution|receptacle|"
     r"shelter_power|ripple", "电源模块"),
    (r"overheat|thermal|air_flow", "散热系统"),
    (r"ground", "接地系统"),
    (r"audio|speaker|handset|microphone|sidetone|squelch|af_chain|distortion", "音频组件"),
    (r"modem|tty|teletype|loop_current", "调制解调器"),
    (r"crypto|encrypt|key_load|secure", "加密模块配置"),
    (r"hopset|hopping", "跳频配置"),
    (r"frequency|channel|offset|preset|band_", "配置参数"),
    (r"protocol|data_rate|mode|sideband|emission|voice_tty|switch_setting|radio_setting|"
     r"bandwidth", "协议栈配置"),
    (r"address|network_id|net_access", "网络配置"),
    (r"time_reference", "时间同步配置"),
    (r"receiver|sensitivity|agc|reception", "接收机模块"),
    (r"transmit|modulat|keying|key_clicks|ptt|xmit|harmonic|spurious", "发射机模块"),
    (r"cable|wiring|interconnection|connection", "连接电缆"),
    (r"control_box|remote|control", "控制单元"),
    (r"meter|indicator|lamp", "指示与仪表"),
    (r"shielding|ferrite|filter|common_mode", "屏蔽与滤波组件"),
]
EXTERNAL_EMI = "无(外部干扰)"
LINK_PATH = "无(链路)"

# ─────────────────────── 现象映射：英文描述 → SY 编码 ───────────────────────
SYMPTOM_RULES = [
    ("SY-0001", r"\bswr\b|vswr"),
    ("SY-0002", r"no (rf )?output|low (rf )?(power )?output|output power|no power output|"
                r"low rf|no transmit output|meter (does not|doesn't) (move|deflect)|no deflection"),
    ("SY-0003", r"pa fault|pa current|fault tone|amplifier fault|fault indicat"),
    ("SY-0004", r"power lamp|power light|does not light|doesn't light|no power|will not turn on|"
                r"won't turn on|dead|no dc voltage|no ac voltage"),
    ("SY-0005", r"no contact|cannot contact|can't contact|unable to contact|no communication|"
                r"no reception|no received signal|unreachable|no radio contact|no signal"),
    ("SY-0006", r"bit error|garbled|errors"),
    ("SY-0007", r"handshake|time ?out|no ack|acknowledg"),
    ("SY-0008", r"data link fails|no data|no net traffic|data connection|link fails"),
    ("SY-0009", r"noise|hiss|interference|rfi|\bhum\b|buzz"),
    ("SY-0010", r"certain frequenc|specific frequenc|one frequency|some frequencies|particular band"),
    ("SY-0011", r"weak signal|poor reception|fading|breakup|break up|intermittent"),
    ("SY-0012", r"wrong frequency|frequency mismatch|different frequenc|frequency (setting|error)|"
                r"wrong channel|channel"),
    ("SY-0013", r"crypto|encrypt|\bkey\b|secure|comsec"),
    ("SY-0014", r"hop|hopping|hopset|sync"),
    ("SY-0015", r"protocol|data rate|mode mismatch|sideband|emission mode"),
]

# ─────────────────────── 工具与备件 ───────────────────────
TOOL_RULES = [
    (r"multimeter|voltmeter|ohmmeter|meter reading", "万用表"),
    (r"swr meter|wattmeter|power meter|\bswr\b", "驻波比/功率计"),
    (r"dummy load", "假负载"),
    (r"spectrum|scan", "频谱仪"),
    (r"signal generator", "信号发生器"),
]
SPARE_RULES = [
    (r"ferrite|choke", "铁氧体磁环"),
    (r"\bfuse\b", "保险丝"),
    (r"coax|cable", "同轴电缆/连接电缆"),
    (r"battery", "电池"),
    (r"handset|microphone|speaker", "音频附件"),
    (r"amplifier", "功放模块"),
    (r"connector", "射频接头"),
]
# 中文方案「更换 X」直接抽出备件 X
CN_SPARE = re.compile(r"更换([一-龥A-Za-z0-9]+?)(?:并|及|，|,|$)")


def canonical_component(fault_type, subtype, root_cause="", symptom_text=""):
    """返回 (标准部件名, 是否命中规则)。"""
    key = " ".join([subtype or "", root_cause or ""]).lower()
    if fault_type == "EMI":
        for pat, name in COMPONENT_RULES:
            if name in ("屏蔽与滤波组件", "发射机模块") and re.search(pat, key):
                return name, True
        return EXTERNAL_EMI, True
    for pat, name in COMPONENT_RULES:
        if re.search(pat, key):
            return name, True
    if fault_type == "LINK_DOWN":
        return LINK_PATH, True
    return "未归一(%s)" % (subtype or "?"), False


def map_symptoms(text):
    """英文现象描述 → [SY 编码]（去重、保序）。"""
    t = (text or "").lower()
    out = []
    for code, pat in SYMPTOM_RULES:
        if re.search(pat, t) and code not in out:
            out.append(code)
    return out


def tools_and_spares(*texts):
    t = " ".join(x or "" for x in texts)
    low = t.lower()
    tools = [n for p, n in TOOL_RULES if re.search(p, low)]
    spares = [n for p, n in SPARE_RULES if re.search(p, low)]
    for m in CN_SPARE.finditer(t):
        s = m.group(1).strip()
        if s and s not in spares:
            spares.append(s)
    return sorted(set(tools)), spares


def split_steps(text):
    """诊断步骤拆分：中文用「;」，英文原文用「;」或句号。"""
    parts = re.split(r"[;；]|\.\s+", text or "")
    return [p.strip().rstrip(".") for p in parts if p.strip()]
