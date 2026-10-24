import type { KnowledgeEntity, KnowledgeEntitySummary, KnowledgeRelation } from '../types/knowledge';
import { describeKnowledgePrinciple } from './knowledge-principle';
import { describeNetworkRule } from './knowledge-network-rule';

// 中文仅用于展示；实体身份、检索编码及草稿中的原始值不在此处改写。
export const knowledgeTypeLabels: Record<string, string> = {
  Device: '设备', DeviceModel: '设备型号', Component: '部件', Interface: '接口',
  Antenna: '天线', Function: '功能', Parameter: '参数', Manufacturer: '厂家', WorkMode: '工作模式',
  Node: '节点', Link: '链路', Metric: '运行指标', LinkState: '链路状态', NetworkRole: '网络角色', NetRule: '组网规则',
  Fault: '故障', FaultType: '故障类型', Symptom: '现象', Cause: '原因', DiagnosisStep: '诊断步骤',
  Solution: '处置方案', Tool: '工具', Spare: '备件', Case: '故障案例', ObjectType: '故障对象类型',
};
export const knowledgeRelationLabels: Record<string, string> = {
  hasComponent: '包含部件', hasInterface: '具有接口', hasAntenna: '配接天线', hasFunction: '具有功能',
  hasParameter: '具有参数', producedBy: '生产方', supportsMode: '支持模式', constrainedBy: '受约束于',
  instanceOf: '实例属于', installedAt: '安装于', connects: '连接', measuredBy: '测量指标', indicates: '指示',
  evaluatedAs: '评估为', followsRule: '遵循规则', hasRole: '具有网络角色', transitionsTo: '状态转移至',
  hasSymptom: '具有现象', causedBy: '原因是', locatedAt: '定位于', diagnosedBy: '诊断步骤',
  resolvedBy: '处置方式', affects: '影响', propagatesTo: '传播至', requiresTool: '所需工具',
  requiresSpare: '所需备件', occursOn: '发生于', recordedIn: '记录于', definesState: '定义状态等级',
};
const fields: Record<string, string> = {
  id: '编号', eid: '实体编号', tid: '关系编号', name: '名称', type: '类型', category: '分类',
  graph: '所属图谱', description: '知识说明', keywords: '关键词', source: '来源', attributes: '属性',
  attrs: '属性', value: '内容', unit: '单位', modelIds: '适用型号', head: '头实体', tail: '尾实体',
  relation: '关系类型', weight: '权重', display_weight: '展示权重', principleFlow: '工作原理', steps: '步骤',
  title: '标题', networkRule: '组网规则说明', scope: '适用范围', criteria: '判级条件', condition: '条件',
  meaning: '含义', transitions: '状态变化', from: '原状态', to: '目标状态',
  antenna_height_m: '天线挂高（m）', antenna_id: '天线编号', antenna_length_m: '天线长度（m）',
  antenna_name: '天线型号名称', antenna_type_default: '默认天线类型', azimuth_deg: '方位角（度）',
  band: '频段', bandwidth_khz: '带宽（kHz）', ber: '误码率', case_id: '案例编号', confidence: '置信度',
  constraint_note: '约束说明', data_rate_kbps: '数据速率（kbps）', dataset_origin: '数据来源标记',
  delay_ms: '时延（ms）', device_a_id: 'A端设备编号', device_b_id: 'B端设备编号',
  device_class: '设备频段', device_id: '设备编号', device_selftest: '设备自检结果',
  diagnosis_steps: '诊断步骤', distance_m: '距离（m）', echelon: '编成层级', elevation_m: '高程（m）',
  fault_component: '故障部件', fault_subtype: '故障子类', fault_type: '故障类型',
  freq_khz: '工作频率（kHz）', freq_max_khz: '最高工作频率（kHz）', freq_min_khz: '最低工作频率（kHz）',
  gain_dbi: '天线增益（dBi）', hbeamwidth_deg: '水平波束宽度（度）', height_range_m: '挂高范围（m）',
  install_time: '安装时间', is_available: '是否可用', is_backup: '是否备用', is_key: '是否关键节点',
  lat: '纬度', lon: '经度', link_id: '链路编号', link_margin_db: '链路余量（dB）', link_state: '链路状态',
  manufacturer: '生产厂家', metric: '指标', mobility: '机动方式', model_id: '设备型号编号', model_name: '设备型号名称',
  modulation: '调制方式', node_a_id: 'A端节点编号', node_b_id: 'B端节点编号', node_id: '节点编号',
  node_name: '节点名称', node_role: '节点角色', node_subtype: '节点子类型', object_type: '故障对象类型',
  op: '比较运算', packet_loss_rate: '丢包率', parent_node_id: '上级节点编号', path_loss_db: '路径损耗（dB）',
  pattern_type: '方向图类型', polarization: '极化方式', power_consumption_w: '功耗（W）', region: '区域',
  relay_capable: '是否支持中继', remark: '备注', repair_time_min: '修复时间（分钟）', root_cause: '根本原因',
  rule_id: '规则编号', rx_power_dbm: '接收功率（dBm）', rx_sensitivity_dbm: '接收灵敏度（dBm）',
  service_type: '业务类型', snr_db: '信噪比（dB）', solution: '处置方案', source_doc: '来源文档',
  state: '状态', status: '设备状态', support: '支持度', symptom_ids: '现象编号', symptom_text: '现象描述',
  threshold: '判定门限', threshold_text: '门限说明', throughput_kbps: '吞吐率（kbps）', tilt_deg: '俯仰角（度）',
  tx_power_dbm: '发射功率（dBm）', tx_power_levels_dbm: '发射功率档位（dBm）', tx_power_max_dbm: '最大发射功率（dBm）',
  vbeamwidth_deg: '垂直波束宽度（度）', work_freq_khz: '工作频率（kHz）', work_mode: '工作模式',
  summary: '摘要', baseVersionId: '基线版本', versionId: '发布版本', number: '版本序号',
  action: '操作', request_id: '请求编号', change_id: '变更编号',
};
const terms: Record<string, string> = {
  ...knowledgeTypeLabels, ...knowledgeRelationLabels, ...fields,
  EXCELLENT: '优秀', GOOD: '良好', WARNING: '预警', FAULT: '故障', NORMAL: '正常', UNKNOWN: '未知',
  HW_FAILURE: '硬件故障', LINK_DOWN: '链路中断', SW_CONFIG: '软件配置异常', EMI: '电磁干扰',
  CONSTRUCTED: '构造数据', DERIVED: '派生资料', SAMPLE: '构造联调数据', MEASURED: '实测数据', IMPORT: '导入数据', MANUAL: '人工录入',
  DEVICE: '设备', LINK: '链路', NODE: '节点', HF: '短波', VUHF: '超短波', VHF: '甚高频', UHF: '特高频',
  I_FIXED: 'I级短波固定站', I_MOBILE: 'I级短波机动站', II_FIXED: 'II级双频固定站',
  II_MOBILE: 'II级双频机动站', II_NODE: 'II级双频机动节点站', III_MOBILE: 'III级双频机动站',
  IV_MOBILE: 'IV级超短波机动站', VEHICLE_A: 'a机动车', VEHICLE_B: 'b机动车', MANPACK: '背负电台',
  FIXED: '固定', VEHICLE: '车载机动', TASK: '任务节点', FIXED_STATION: '固定台站',
  voice: '话音', data: '数据', true: '是', false: '否', True: '是', False: '否', None: '未提供',
  ALARM_PA: '功放告警', ALARM_PWR: '电源告警', ALARM_VSWR: '驻波比告警',
  CFG_MISMATCH: '配置不匹配', FAULT_RF: '射频故障', LINK_LOSS: '链路丢失',
  DRAFT: '草稿', PENDING: '待审核', APPROVED: '审核通过', REJECTED: '已驳回', WITHDRAWN: '已撤回',
  PUBLISHED: '已发布', SAVE: '保存草稿', SUBMIT: '送审', WITHDRAW: '撤回', APPROVE: '审核通过',
  REJECT: '驳回', PUBLISH: '发布', ROLLBACK: '回滚', RESET: '重置', BASELINE: '初始基线',
  baseline: '初始基线', seed: '初始知识资料', legacy: '历史账号',
  FREEZE: '冻结版本',
  'Constructed device, network and fault knowledge; not field-validated': '构造设备、网络和故障知识；未经外场验证',
  'Migrate ordered diagnostic steps and fault taxonomy': '迁移顺序诊断步骤和故障分类',
  OMNI: '全向', NVIS: '近垂直入射天波',
  ALE: '自动链路建立（ALE）', AM: '调幅（AM）', FM: '调频（FM）', CW: '等幅电报（CW）',
  SSB: '单边带（SSB）', LSB: '下边带（LSB）', USB: '上边带（USB）', AME: '兼容调幅（AME）',
  FH: '跳频（FH）', ECCM: '电子反对抗（ECCM）', SDR: '软件定义无线电（SDR）',
  Analog: '模拟', Digital: '数字', 'Analog FM': '模拟调频', 'frequency hopping': '跳频',
  Conventional: '常规通信', Trunking: '集群通信', DMO: '直通模式（DMO）', Selcall: '选择性呼叫',
  DMR: '数字移动无线电（DMR）', P25: '数字集群标准（P25）', IDAS: '数字通信系统（IDAS）',
  C4FM: '四电平数字调频（C4FM）', LTR: '逻辑集群系统（LTR）',
  'IP Site Connect': '多基站互联系统（IP Site Connect）', 'Capacity Plus': '增强集群系统（Capacity Plus）',
  'Capacity Max': '扩展集群系统（Capacity Max）',
  'TX/RX bands': '收发频段', Bands: '频段',
  'OE-505 10-foot whip': 'OE-505 十英尺鞭状天线', 'OE-505 3m whip': 'OE-505 三米鞭状天线',
};
const manufacturers: Record<string, string> = {
  'Harris Corporation': '哈里斯公司', 'Barrett Communications': '巴雷特通信公司',
  Codan: '科丹', Hytera: '海能达', Icom: '艾可慕', Kenwood: '建伍',
  'Motorola Solutions': '摩托罗拉解决方案', Yaesu: '八重洲', 'MOBAT USA': '美国厂商（MOBAT USA）',
};
const sourceFiles: Record<string, string> = {
  'devices_v1.csv': '设备资料', 'device_models_v1.csv': '设备型号资料', 'antennas_v1.csv': '天线资料',
  'nodes_v1.csv': '节点资料', 'links_v1.csv': '链路资料', 'link_metrics_v1.csv': '链路指标资料',
  'topology_links_v1.csv': '拓扑链路资料', 'link_status_v1.csv': '链路状态资料',
  'fault_cases_v1.csv': '故障案例资料', 'fault_triples_v1.csv': '故障三元组资料',
  'link_state_rules_v1.csv': '链路状态规则资料', 'node.csv': '节点台账', 'device.csv': '设备台账',
};
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 只匹配完整受控词，避免把编号、文件名、型号中的片段当作业务术语替换。
const tokens = new RegExp('(?<![A-Za-z0-9_./-])(' + Object.keys(terms).sort((a, b) => b.length - a.length).map(escaped).join('|') + ')(?![A-Za-z0-9_./-])', 'g');

export function knowledgeTypeName(id: string, catalogName?: string): string {
  return knowledgeTypeLabels[id] ?? catalogName ?? id;
}
export function knowledgeRelationName(id: string, catalogName?: string): string {
  return knowledgeRelationLabels[id] ?? catalogName ?? id;
}
export function knowledgeText(value: string): string {
  return manufacturers[value] ?? value.replace(tokens, (token) => terms[token] ?? token);
}
export function knowledgeAttributeName(name: string): string {
  return fields[name] ?? knowledgeText(name);
}
export function knowledgeSource(value: string): string {
  // 文件名可能含空格与英文缩写；仅翻译文件名之后的来源性质标记。
  const filename = value.match(/^.*?\.(?:csv|pdf|docx?|xlsx?|json|tiff?|txt)(?=$|[#\s])/i)?.[0];
  const translated = filename ? filename + knowledgeText(value.slice(filename.length)) : knowledgeText(value);
  const file = Object.keys(sourceFiles).find((name) => value.startsWith(name));
  return file ? sourceFiles[file] + ' · ' + translated : translated;
}
const originalFields = new Set(['id', 'eid', 'tid', 'name', 'head', 'tail', 'model_name', 'antenna_name',
  'modelIds', 'source_doc', 'install_time', 'symptom_ids', 'request_id', 'change_id']);
function displayValue(value: unknown, field = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => displayValue(item, field));
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [knowledgeAttributeName(key), displayValue(item, key)]),
  );
  if (value === null) return '未提供';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value !== 'string') return value;
  if (field === 'polarization') return ({ C: '圆极化', H: '水平极化', V: '垂直极化' } as Record<string, string>)[value] ?? value;
  if (field === 'echelon') return ({ I: 'I级', II: 'II级', III: 'III级', IV: 'IV级' } as Record<string, string>)[value] ?? value;
  if (field === 'source_doc') return knowledgeSource(value);
  if (originalFields.has(field) || field.endsWith('_id')) return value;
  return knowledgeText(value);
}
export function knowledgeAttributeValue(value: string, field = ''): string {
  if (field === 'source_doc') return knowledgeSource(value);
  if (originalFields.has(field) || field.endsWith('_id')) return value;
  if (/^[\[{]/.test(value.trim())) {
    try { return JSON.stringify(displayValue(JSON.parse(value)), null, 2); } catch { /* 非JSON原文不执行、不猜补结构。 */ }
  }
  return String(displayValue(value, field));
}
export function knowledgeEntityName(entity?: Pick<KnowledgeEntitySummary, 'type' | 'name'>): string {
  if (!entity) return '名称未提供';
  const { name, type } = entity;
  if (/^(DV|DM|AM|ND|LK|FC)-\d+$/.test(name)) {
    return (type === 'Fault' ? '故障实例' : knowledgeTypeName(type)) + ' ' + name;
  }
  if (type === 'DeviceModel' || type === 'Device' || type === 'Antenna') return name;
  if (type === 'Manufacturer') return manufacturers[name] ?? name;
  if (type === 'Parameter' && name.includes('=')) {
    const offset = name.indexOf('='), field = name.slice(0, offset), value = name.slice(offset + 1);
    return knowledgeAttributeName(field) + '：' + (knowledgeAttributeValue(value, field) || '未提供');
  }
  return knowledgeText(name);
}
export function describeKnowledge(row: KnowledgeEntity | KnowledgeRelation | null): string {
  if (!row) return '无';
  if (!('name' in row)) return [
    row.head + ' → ' + knowledgeRelationName(row.type) + ' → ' + row.tail,
    '权重：' + (row.weight ?? '未提供'), '来源：' + knowledgeSource(row.source),
  ].join('\n');
  return [knowledgeEntityName(row), row.category + ' / ' + knowledgeTypeName(row.type),
    knowledgeText(row.description), '来源：' + knowledgeSource(row.source),
    '关键词：' + row.keywords.map(knowledgeText).join('、'), '型号：' + row.modelIds.join('、'),
    ...row.attributes.map((a) => knowledgeAttributeName(a.name) + '：' + knowledgeAttributeValue(a.value, a.name) + (a.unit ? ' ' + a.unit : '')),
    knowledgeText(describeKnowledgePrinciple(row)), knowledgeText(describeNetworkRule(row)),
  ].filter(Boolean).join('\n');
}
