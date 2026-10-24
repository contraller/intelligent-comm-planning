"""图谱中文目录与只读检索别名；不得回填实体或草稿。"""
from __future__ import annotations

import re


ENTITY_TYPE_NAMES = {
    "Device": "设备", "DeviceModel": "设备型号", "Component": "部件",
    "Interface": "接口", "Antenna": "天线", "Function": "功能",
    "Parameter": "参数", "Manufacturer": "厂家", "WorkMode": "工作模式",
    "Node": "节点", "Link": "链路", "Metric": "运行指标", "LinkState": "链路状态",
    "NetworkRole": "网络角色", "NetRule": "组网规则", "Fault": "故障",
    "FaultType": "故障类型", "Symptom": "现象", "Cause": "原因",
    "DiagnosisStep": "诊断步骤", "Solution": "处置方案", "Tool": "工具",
    "Spare": "备件", "Case": "故障案例", "ObjectType": "故障对象类型",
}

RELATION_TYPE_NAMES = {
    "hasComponent": "包含部件", "hasInterface": "具有接口", "hasAntenna": "配接天线",
    "hasFunction": "具有功能", "hasParameter": "具有参数", "producedBy": "生产方",
    "supportsMode": "支持模式", "constrainedBy": "受约束于", "instanceOf": "实例属于",
    "installedAt": "安装于", "connects": "连接", "measuredBy": "测量指标",
    "indicates": "指示", "evaluatedAs": "评估为", "followsRule": "遵循规则",
    "hasRole": "具有网络角色", "transitionsTo": "状态转移至", "hasSymptom": "具有现象",
    "causedBy": "原因是", "locatedAt": "定位于", "diagnosedBy": "诊断步骤",
    "resolvedBy": "处置方式", "affects": "影响", "propagatesTo": "传播至",
    "requiresTool": "所需工具", "requiresSpare": "所需备件", "occursOn": "发生于",
    "recordedIn": "记录于",
}
RELATION_NAME_ALIASES = {"hasRole": {"具有角色"}, "recordedIn": {"记录于案例"}}

# 对照 sr6 构建器的实际属性键；型号、编号、单位和来源原文不作翻译。
ATTRIBUTE_NAMES = {
    "antenna_height_m": "天线挂高", "antenna_id": "天线编号",
    "antenna_length_m": "天线长度", "antenna_name": "天线名称",
    "antenna_type_default": "默认天线类型", "azimuth_deg": "方位角",
    "band": "频段", "bandwidth_khz": "带宽", "ber": "误码率",
    "case_id": "案例编号", "category": "类别", "confidence": "置信度",
    "constraint_note": "约束说明", "data_rate_kbps": "数据速率",
    "dataset_origin": "数据来源性质", "delay_ms": "时延",
    "device_a_id": "起端设备编号", "device_b_id": "终端设备编号",
    "device_class": "设备类别", "device_id": "设备编号", "device_selftest": "设备自检",
    "diagnosis_steps": "诊断步骤", "distance_m": "距离", "echelon": "层级",
    "elevation_m": "高程", "fault_component": "故障部件", "fault_subtype": "故障子类型",
    "fault_type": "故障类型", "freq_khz": "频率", "freq_max_khz": "最高频率",
    "freq_min_khz": "最低频率", "gain_dbi": "增益", "hbeamwidth_deg": "水平波束宽度",
    "height_range_m": "挂高范围", "install_time": "安装时间", "is_available": "是否可用",
    "is_backup": "是否备用", "is_key": "是否关键节点", "lat": "纬度",
    "link_id": "链路编号", "link_margin_db": "链路余量", "link_state": "链路状态",
    "lon": "经度", "manufacturer": "厂商", "metric": "指标", "mobility": "机动性",
    "model_id": "型号编号", "model_name": "型号名称", "modulation": "调制方式",
    "node_a_id": "起端节点编号", "node_b_id": "终端节点编号", "node_id": "节点编号",
    "node_name": "节点名称", "node_role": "节点角色", "node_subtype": "节点子类型",
    "object_type": "对象类型", "op": "比较运算符", "packet_loss_rate": "丢包率",
    "parent_node_id": "上级节点编号", "path_loss_db": "路径损耗", "pattern_type": "方向图类型",
    "polarization": "极化方式", "power_consumption_w": "功耗", "region": "区域",
    "relay_capable": "中继能力", "remark": "备注", "repair_time_min": "修复时间",
    "root_cause": "根本原因", "rule_id": "规则编号", "rx_power_dbm": "接收功率",
    "rx_sensitivity_dbm": "接收灵敏度", "service_type": "业务类型", "snr_db": "信噪比",
    "solution": "处置措施", "source_doc": "来源文档", "state": "状态", "status": "状态",
    "support": "支持度", "symptom_ids": "现象编号", "symptom_text": "现象描述",
    "threshold": "门限", "threshold_text": "门限文本", "throughput_kbps": "吞吐率",
    "tilt_deg": "俯仰角", "tx_power_dbm": "发射功率", "tx_power_levels_dbm": "发射功率档位",
    "tx_power_max_dbm": "最大发射功率", "vbeamwidth_deg": "垂直波束宽度",
    "work_freq_khz": "工作频率", "work_mode": "工作模式",
}

# 与中文展示词表对齐；旧标签继续作为搜索别名，不引入前端运行依赖。
ATTRIBUTE_DISPLAY_NAMES = {
    **ATTRIBUTE_NAMES,
    "category": "分类", "antenna_height_m": "天线挂高（m）", "antenna_length_m": "天线长度（m）",
    "antenna_name": "天线型号名称", "azimuth_deg": "方位角（度）", "bandwidth_khz": "带宽（kHz）",
    "data_rate_kbps": "数据速率（kbps）", "dataset_origin": "数据来源标记", "delay_ms": "时延（ms）",
    "device_a_id": "A端设备编号", "device_b_id": "B端设备编号", "device_class": "设备频段",
    "device_selftest": "设备自检结果", "distance_m": "距离（m）", "echelon": "编成层级",
    "elevation_m": "高程（m）", "fault_subtype": "故障子类", "freq_khz": "工作频率（kHz）",
    "freq_max_khz": "最高工作频率（kHz）", "freq_min_khz": "最低工作频率（kHz）",
    "gain_dbi": "天线增益（dBi）", "hbeamwidth_deg": "水平波束宽度（度）",
    "height_range_m": "挂高范围（m）", "link_margin_db": "链路余量（dB）",
    "manufacturer": "生产厂家", "mobility": "机动方式", "model_id": "设备型号编号",
    "model_name": "设备型号名称", "node_a_id": "A端节点编号", "node_b_id": "B端节点编号",
    "object_type": "故障对象类型", "op": "比较运算", "path_loss_db": "路径损耗（dB）",
    "power_consumption_w": "功耗（W）", "relay_capable": "是否支持中继",
    "repair_time_min": "修复时间（分钟）", "rx_power_dbm": "接收功率（dBm）",
    "rx_sensitivity_dbm": "接收灵敏度（dBm）", "snr_db": "信噪比（dB）", "solution": "处置方案",
    "status": "设备状态", "threshold": "判定门限", "threshold_text": "门限说明",
    "throughput_kbps": "吞吐率（kbps）", "tilt_deg": "俯仰角（度）", "tx_power_dbm": "发射功率（dBm）",
    "tx_power_levels_dbm": "发射功率档位（dBm）", "tx_power_max_dbm": "最大发射功率（dBm）",
    "vbeamwidth_deg": "垂直波束宽度（度）", "work_freq_khz": "工作频率（kHz）",
}

LINK_STATES = {"EXCELLENT": "优秀", "GOOD": "良好", "WARNING": "预警", "FAULT": "故障"}
FAULT_TYPES = {"HW_FAILURE": "设备硬件故障", "LINK_DOWN": "链路中断",
               "SW_CONFIG": "软件配置异常", "EMI": "电磁干扰"}
NETWORK_ROLES = {
    "I_FIXED": "Ⅰ短波固定站", "I_MOBILE": "Ⅰ短波机动站", "II_FIXED": "Ⅱ双频固定站",
    "II_MOBILE": "Ⅱ双频机动站", "II_NODE": "Ⅱ双频机动节点站", "III_MOBILE": "Ⅲ双频机动站",
    "IV_MOBILE": "Ⅳ超短波机动站", "VEHICLE_A": "a机动车", "VEHICLE_B": "b机动车",
    "MANPACK": "背负式短波电台",
}
FUNCTIONS = {"voice": "语音", "data": "数据"}
WORK_MODES = {"frequency hopping": "跳频", "Conventional": "常规", "Trunking": "集群",
              "Analog": "模拟", "Analog FM": "模拟调频"}
WORK_MODE_DISPLAY_NAMES = {
    "ALE": "自动链路建立（ALE）", "AM": "调幅（AM）", "FM": "调频（FM）", "CW": "等幅电报（CW）",
    "SSB": "单边带（SSB）", "FH": "跳频（FH）", "ECCM": "电子反对抗（ECCM）",
    "SDR": "软件定义无线电（SDR）", "frequency hopping": "跳频", "Selcall": "选择性呼叫",
    "P25": "数字集群标准（P25）", "Conventional": "常规通信", "Trunking": "集群通信",
    "DMR": "数字移动无线电（DMR）", "Analog": "模拟", "DMO": "直通模式（DMO）",
    "IDAS": "数字通信系统（IDAS）", "LTR": "逻辑集群系统（LTR）", "Analog FM": "模拟调频",
    "C4FM": "四电平数字调频（C4FM）", "IP Site Connect": "多基站互联系统（IP Site Connect）",
    "Capacity Plus": "增强集群系统（Capacity Plus）", "Capacity Max": "扩展集群系统（Capacity Max）",
}
MANUFACTURER_NAMES = {
    "Harris Corporation": "哈里斯公司", "Barrett Communications": "巴雷特通信公司",
    "Codan": "科丹", "Hytera": "海能达", "Icom": "艾可慕", "Kenwood": "建伍",
    "Motorola Solutions": "摩托罗拉解决方案", "Yaesu": "八重洲", "MOBAT USA": "美国厂商（MOBAT USA）",
}
NETWORK_ROLE_DISPLAY_NAMES = {
    "I_FIXED": "I级短波固定站", "I_MOBILE": "I级短波机动站", "II_FIXED": "II级双频固定站",
    "II_MOBILE": "II级双频机动站", "II_NODE": "II级双频机动节点站",
    "III_MOBILE": "III级双频机动站", "IV_MOBILE": "IV级超短波机动站",
    "VEHICLE_A": "a机动车", "VEHICLE_B": "b机动车", "MANPACK": "背负电台",
}
SOURCE_FILES = {
    "devices_v1.csv": "设备资料", "device_models_v1.csv": "设备型号资料", "antennas_v1.csv": "天线资料",
    "nodes_v1.csv": "节点资料", "links_v1.csv": "链路资料", "link_metrics_v1.csv": "链路指标资料",
    "fault_cases_v1.csv": "故障案例资料", "fault_triples_v1.csv": "故障三元组资料",
    "link_state_rules_v1.csv": "链路状态规则资料", "node.csv": "节点台账", "device.csv": "设备台账",
    "topology_links_v1.csv": "拓扑链路资料", "link_status_v1.csv": "链路状态资料",
}
OBJECT_TYPES = {"DEVICE": "设备", "LINK": "链路"}
BANDS = {"HF": "短波", "VUHF": "超短波"}
NUMBERED_ENTITY_PREFIXES = {
    "Device": "DV", "DeviceModel": "DM", "Antenna": "AM", "Fault": "FC",
    "Case": "FC", "Node": "ND", "Link": "LK",
}

# 按类型和属性解释枚举，不对自由文本执行替换；协议缩写保留原文。
ENTITY_NAME_ALIASES = {
    "Function": FUNCTIONS, "WorkMode": WORK_MODES, "FaultType": FAULT_TYPES,
    "LinkState": LINK_STATES, "NetworkRole": NETWORK_ROLES, "ObjectType": OBJECT_TYPES,
    "Manufacturer": MANUFACTURER_NAMES,
}

ATTRIBUTE_VALUE_ALIASES = {
    "service_type": FUNCTIONS, "work_mode": WORK_MODES, "fault_type": FAULT_TYPES,
    "link_state": LINK_STATES, "state": LINK_STATES, "node_subtype": NETWORK_ROLES,
    "object_type": OBJECT_TYPES, "device_class": BANDS, "band": BANDS,
    "metric": {key: ATTRIBUTE_NAMES[key] for key in
               ("snr_db", "ber", "packet_loss_rate", "delay_ms", "throughput_kbps")},
    "echelon": {"I": "Ⅰ级", "II": "Ⅱ级", "III": "Ⅲ级", "IV": "Ⅳ级"},
    "mobility": {"FIXED": "固定站", "VEHICLE": "车载移动站", "MANPACK": "便携站"},
    "node_role": {"TASK": "任务节点", "FIXED_STATION": "已有固定站"},
    "status": {"NORMAL": "正常"},
    "device_selftest": {"ALARM_PA": "功放告警", "ALARM_PWR": "电源告警",
                        "ALARM_VSWR": "驻波比告警", "CFG_MISMATCH": "配置不匹配",
                        "FAULT_RF": "射频故障", "LINK_LOSS": "链路丢失", "NORMAL": "正常"},
    "dataset_origin": {"CONSTRUCTED": "构造数据"},
    **{key: {"true": "是", "false": "否"} for key in
       ("is_available", "is_backup", "is_key", "relay_capable")},
}

DISPLAY_TERMS = {
    **ENTITY_TYPE_NAMES, **RELATION_TYPE_NAMES, **ATTRIBUTE_DISPLAY_NAMES,
    **LINK_STATES, **FAULT_TYPES, **OBJECT_TYPES, **BANDS, **FUNCTIONS,
    **WORK_MODE_DISPLAY_NAMES, **NETWORK_ROLE_DISPLAY_NAMES,
    **ATTRIBUTE_VALUE_ALIASES["device_selftest"],
    "voice": "话音", "HW_FAILURE": "硬件故障", "NODE": "节点", "VHF": "甚高频", "UHF": "特高频",
    "FIXED": "固定", "VEHICLE": "车载机动", "TASK": "任务节点", "FIXED_STATION": "固定台站",
    "CONSTRUCTED": "构造数据", "DERIVED": "派生资料", "SAMPLE": "构造联调数据", "MEASURED": "实测数据",
    "IMPORT": "导入数据", "MANUAL": "人工录入", "UNKNOWN": "未知",
    "OMNI": "全向", "NVIS": "近垂直入射天波", "Digital": "数字",
    "LSB": "下边带（LSB）", "USB": "上边带（USB）", "AME": "兼容调幅（AME）",
    "true": "是", "false": "否", "True": "是", "False": "否", "None": "未提供",
    "TX/RX bands": "收发频段", "Bands": "频段",
    "OE-505 10-foot whip": "OE-505 十英尺鞭状天线", "OE-505 3m whip": "OE-505 三米鞭状天线",
}
DISPLAY_TOKENS = re.compile(r"(?<![A-Za-z0-9_./-])(?:" + "|".join(
    re.escape(key) for key in sorted(DISPLAY_TERMS, key=len, reverse=True)) + r")(?![A-Za-z0-9_./-])")
ORIGINAL_ATTRIBUTE_VALUES = {
    "id", "eid", "tid", "name", "head", "tail", "model_name", "antenna_name", "modelIds",
    "source_doc", "install_time", "symptom_ids", "request_id", "change_id",
}


def type_name(type_id: str) -> str:
    return ENTITY_TYPE_NAMES.get(type_id, f"未配置中文名称（原文：{type_id}）")


def relation_name(relation_id: str) -> str:
    return RELATION_TYPE_NAMES.get(relation_id, f"未配置中文名称（原文：{relation_id}）")


def _display_text(value: str) -> str:
    return MANUFACTURER_NAMES.get(value) or DISPLAY_TOKENS.sub(lambda match: DISPLAY_TERMS[match[0]], value)


def _attribute_value(name: str, value: str) -> str:
    if name in ORIGINAL_ATTRIBUTE_VALUES or name.endswith("_id"):
        return value
    if name == "echelon":
        return {"I": "I级", "II": "II级", "III": "III级", "IV": "IV级"}.get(value, value)
    if name == "polarization":
        return {"C": "圆极化", "H": "水平极化", "V": "垂直极化"}.get(value, value)
    return _display_text(value)


def _attribute_aliases(name: str, value: str) -> set[str]:
    aliases = set()
    if name in ATTRIBUTE_NAMES:
        aliases.add(ATTRIBUTE_NAMES[name])
        aliases.add(f"{ATTRIBUTE_NAMES[name]}={value}")
    values = ATTRIBUTE_VALUE_ALIASES.get(name, {})
    aliases.update(values[item.strip()] for item in value.split(";") if item.strip() in values)
    if name in ATTRIBUTE_DISPLAY_NAMES:
        label, translated = ATTRIBUTE_DISPLAY_NAMES[name], _attribute_value(name, value)
        aliases.update((label, f"{label}：{translated or '未提供'}"))
        if translated != value:
            aliases.add(translated)
    return aliases


def _source_aliases(source: str) -> set[str]:
    aliases = set()
    if re.search(r"(?<![A-Za-z0-9_])CONSTRUCTED(?![A-Za-z0-9_])", source, re.IGNORECASE):
        aliases.add("构造数据")
    translated = _display_text(source)
    if translated != source:
        aliases.add(translated)
    for file, label in SOURCE_FILES.items():
        if source.startswith(file):
            aliases.update((label, f"{label} · {translated}"))
            # 标签细化后仍兼容旧中文检索词，不改写可追溯来源。
            old_label = {"topology_links_v1.csv": "链路资料", "link_status_v1.csv": "链路指标资料"}.get(file)
            if old_label:
                aliases.update((old_label, f"{old_label} · {translated}"))
            break
    return aliases


def search_aliases(entity: dict, relations=()) -> set[str]:
    """仅生成搜索词，不改动或向返回实体添加任何展示字段。"""
    etype, name = entity["type"], entity["name"]
    aliases = {type_name(etype)}
    if etype in NUMBERED_ENTITY_PREFIXES and re.fullmatch(NUMBERED_ENTITY_PREFIXES[etype] + r"-\d+", name):
        aliases.update((f"{type_name(etype)} {name}", f"{type_name(etype)}{name}"))
        if etype == "Fault":
            aliases.add(f"故障实例 {name}")
    names = ENTITY_NAME_ALIASES.get(etype, {})
    if name in names:
        aliases.add(names[name])
    if etype not in {"Manufacturer", "DeviceModel", "Device", "Antenna"}:
        translated = _display_text(name)
        if translated != name:
            aliases.add(translated)
    if etype == "Parameter" and "=" in name:
        key, value = name.split("=", 1)
        aliases.update(_attribute_aliases(key, value))
    if etype == "Metric":
        parts = name.split(":")
        if len(parts) == 3 and parts[0] in BANDS and parts[1] in ATTRIBUTE_VALUE_ALIASES["metric"]:
            aliases.update((BANDS[parts[0]], ATTRIBUTE_NAMES[parts[1]]))
            aliases.add(f"{BANDS[parts[0]]} {ATTRIBUTE_NAMES[parts[1]]} {parts[2]}")
    aliases.update(_source_aliases(entity.get("source", "")))
    for attribute in entity.get("attributes", []):
        aliases.update(_attribute_aliases(attribute["name"], attribute["value"]))
        if attribute["name"] == "source_doc":
            aliases.update(_source_aliases(attribute["value"]))
    for relation in relations:
        aliases.update((relation["type"], relation_name(relation["type"]), relation["source"]))
        aliases.update(RELATION_NAME_ALIASES.get(relation["type"], ()))
        aliases.update(_source_aliases(relation["source"]))
    return aliases
