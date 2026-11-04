// 仅转换显示文本；业务编码、冻结对象、回执和导出原始数据保持原值。
const labels: Record<string, string> = {
  NORMAL: '正常', FAULT: '故障', OFFLINE: '离线', UNKNOWN: '未知',
  EXCELLENT: '优秀', GOOD: '良好', WARNING: '预警',
  SEVERE: '严重', MODERATE: '一般', MINOR: '轻微',
  SAVED: '已保存', CONFIRMED: '已转正', REFERENCE: '未达标参考',
  PENDING: '等待中', RUNNING: '进行中', SUCCESS: '已完成', FAILED: '失败', CANCELLED: '已取消',
  ADD: '新增', PATCH: '修改', ENABLE: '启用', REVIEW: '审核',
  HF: '短波', VUHF: '超短波', DEVICE: '设备', NODE: '节点', LINK: '链路',
  FIXED: '固定部署', VEHICLE: '车载／移动部署', MANPACK: '背负／便携部署',
  FIXED_STATION: '已有固定站', TASK: '任务节点', RELAY: '中继站', CANDIDATE: '候选部署点',
  I_FIXED: 'I级短波固定站', I_MOBILE: 'I级短波机动站', II_FIXED: 'II级双频固定站',
  II_MOBILE: 'II级双频机动站', II_NODE: 'II级双频机动节点站', III_MOBILE: 'III级双频机动站',
  IV_MOBILE: 'IV级超短波机动站', VEHICLE_A: 'a机动车', VEHICLE_B: 'b机动车',
  NARROWBAND: '窄带', BROADBAND: '宽带', SWEEP: '扫频', PULSE: '脉冲', NOISE: '噪声',
  OMNI: '全向', DIRECTIONAL: '定向', true: '是', false: '否',
  HW_FAILURE: '硬件故障', LINK_DOWN: '链路中断', SW_CONFIG: '软件配置异常', EMI: '电磁干扰',
  RULE: '规则', KG: '知识图谱', ML: '机器学习',
  EXACT: '精确匹配', PARTIAL_MISSING_INPUT: '输入缺失下的部分匹配',
  CONSTRUCTED: '构造数据', SYNTHETIC_INTEGRATION: '构造数据（非实测）',
  SAMPLE: '构造示例', MEASURED: '实测数据', IMPORT: '导入数据', MANUAL: '人工录入',
  MIN_COUNT: '最少新增部署', FIXED_COUNT: '指定新增部署数量',
  FREQ_ADJUST: '调整频率', CHANNEL_SWITCH: '切换信道', POWER_OPT: '优化功率',
  ROUTE_REBUILD: '重建受扰路由', NODE_REDEPLOY: '迁移受扰节点',
  BEFORE: '措施前', PREVIEW: '措施预览', CURRENT: '当前来源', HISTORICAL: '历史来源',
  GENERATED: '已生成', NOT_GENERATED: '未生成', NOT_APPLICABLE: '不适用', UNAVAILABLE: '不可用', NOT_EVALUATED: '未评估',
};
const fields: Record<string, string> = {
  rule_ids: '规则编号', match_kind: '匹配方式', candidate_rankings: '候选案例排序',
  source_case_ids: '来源案例编号', source: '来源', source_docs: '资料来源',
  equally_supported_cases: '同等支持的案例', source_doc: '资料来源',
  case_id: '案例编号', fault_type: '故障类型', score: '相似度',
  matched_symptom_count: '匹配现象数', triple_ids: '知识依据编号',
  symptom_ids: '现象编号', matched_symptoms: '已匹配现象', missing_symptoms: '缺失现象',
  missing_inputs: '缺失输入', required_inputs: '所需输入', reason: '原因', reasons: '原因',
  confidence: '置信度', weight: '权重', contribution: '贡献',
  kind: '对象类型', type: '类型', state: '状态', status: '状态', level: '等级',
  id: '编号', node_id: '节点编号', link_id: '链路编号', device_id: '设备编号',
  node_ids: '节点编号', link_ids: '链路编号', device_ids: '设备编号',
  object_id: '对象编号', object_type: '对象类型', name: '名称', detail: '说明',
  action: '操作', available: '可用', unavailable_reasons: '不可用原因',
  measure_id: '措施编号', measure_type: '措施类型', title: '措施名称', priority: '优先级',
  risk: '风险与条件', parameters: '参数', before: '变更前', after: '变更后',
  power_dbm: '功率（dBm）', tx_power_dbm: '发射功率（dBm）', txPowerDbm: '发射功率（dBm）',
  antenna_height_m: '天线挂高（m）', antennaHeightM: '天线挂高（m）',
  azimuth_deg: '方位角（度）', tilt_deg: '俯仰角（度）', tiltDeg: '俯仰角（度）',
  frequency_khz: '频率（kHz）', freq_khz: '频率（kHz）', workFreqKhz: '工作频率（kHz）',
  bandwidth_khz: '带宽（kHz）', bandwidthKhz: '带宽（kHz）',
  stationId: '节点编号', deviceId: '设备编号', deviceIds: '设备编号',
  nodeIds: '路径节点', linkIds: '路径链路', frequencyKhz: '频率（kHz）',
  filters: '频率筛选', deviceClass: '频段', rangeKhz: '频率范围（kHz）',
  excludeFreqIds: '排除频点', frequencyConstraints: '频率条件', deploymentSolve: '部署求解条件',
  mode: '求解模式', fixedCount: '新增部署单元数', solutionCount: '期望备选数量',
  taskId: '任务编号', planId: '方案编号', analysisId: '分析编号', measureId: '措施编号',
  sourcePlanId: '来源方案编号', sourcePlanVersion: '来源方案版本',
  sourceSnapshotId: '来源网络快照', sources: '来源', coordinate: '坐标',
  plannedCoordinate: '规划坐标', input_version: '输入版本', request_id: '请求编号',
  deployment: '部署配置', devices: '设备配置', routes: '路由配置', frequencies: '频率配置',
  operation: '操作', value: '数值', required: '要求', passed: '通过',
  device_changes: '设备变更', node_changes: '节点变更', link_changes: '链路变更',
  nodes: '节点配置', links: '链路配置', params: '无线参数', frequency: '频率配置',
  lon: '经度', lat: '纬度', band: '频段',
  target: '作用对象', measures: '措施', restores: '预测恢复', tx_changes: '发射功率变更',
  from_dbm: '变更前功率（dBm）', to_dbm: '变更后功率（dBm）', side_effect: '相关风险',
  to_site_id: '目标位置编号', to_lon: '目标经度', to_lat: '目标纬度',
  move_distance_m: '迁移距离（m）', links_of_node: '关联链路',
  rx_sensitivity_dbm: '接收灵敏度（dBm）', tx_power_max_dbm: '最大发射功率（dBm）',
  freq_min_khz: '最低频率（kHz）', freq_max_khz: '最高频率（kHz）',
  description: '说明', bounds: '任务区域', stationIds: '参与节点', demands: '通联需求',
  resourceGroupId: '频率资源组', startTime: '开始时间', endTime: '结束时间',
  constraints: '规划约束', deploymentConstraints: '部署筛选条件',
  connectivityPercent: '连通率（%）', survivabilityPercent: '抗毁性（%）', maxRelayHops: '最大中继跳数',
};

export function uiCode(value: unknown, empty = '未提供'): string {
  if (value === null || value === undefined || value === '') return empty;
  const text = String(value);
  return labels[text] ?? text;
}
export const uiField = (field: string): string => fields[field] ?? labels[field] ?? field;
export const uiSource = (value: string): string => value.trim() === '来源未提供' ? '未提供' : value;

function parsed(value: unknown): unknown {
  if (typeof value !== 'string' || !/^[\[{]/.test(value.trim())) return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function uiText(value: string): string {
  return value
    .replace('型号原字段保持缺失；parameter_substitutions明确列出既有SpecFiller用于计算的推定及依据', '型号资料中的缺失值保持不变；“计算参数推定与依据”列出计算采用的推定值及依据')
    .replace(/(?<![A-Za-z0-9_./-])(CONSTRUCTED|SYNTHETIC_INTEGRATION|SAMPLE|LINK_DOWN|HW_FAILURE|SW_CONFIG|EMI|PARTIAL_MISSING_INPUT|ML)(?![A-Za-z0-9_./-])/g, code => uiCode(code));
}
export function uiStructured(value: unknown, field = ''): string {
  const data = parsed(value);
  if (data === null || data === undefined || data === '') return '未提供';
  if (Array.isArray(data)) return data.length
    ? data.map((item, index) => typeof item === 'object' && item !== null
      ? `${index + 1}. ${uiStructured(item, field).replace(/\n/g, '；')}` : uiStructured(item, field)).join('\n')
    : '无';
  if (typeof data === 'object') return Object.entries(data)
    .map(([key, item]) => `${uiField(key)}：${uiStructured(item, key)}`).join('\n') || '无';
  if (field === 'id' || /(?:_ids?|Ids?)$/.test(field) || ['name', 'modelName', 'model_name'].includes(field)) return String(data);
  return uiText(typeof data === 'string' && fields[data] ? fields[data] : uiCode(data));
}
export function uiEvidence(evidence: { label: string; value: string }): { label: string; value: string } {
  return { label: uiField(evidence.label), value: uiStructured(evidence.value, evidence.label) };
}
