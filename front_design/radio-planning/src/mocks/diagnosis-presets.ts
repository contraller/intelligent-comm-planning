import type { DiagnosisPreset, DiagnosisResult, FaultInput, FaultType } from '../types/diagnosis';

// 现象名称取自附件字典；规则、影响和建议均为独立教学常量，不执行诊断计算。
export const diagnosisSymptoms = [
  '发射时驻波比告警', '功率表读数接近零', '设备自检报功放故障码', '电源指示灯熄灭',
  '对端完全失联', '误码率突增至不可用', '握手超时', '吞吐率跌至零',
  '收信底噪明显抬升', '特定频点不可用其余正常', '信噪比骤降但发射自检正常',
  '频率配置与对端不一致', '加密参数不匹配无法建链', '跳频图案不同步', '协议版本不一致',
].map((label, index) => ({ id: `SY-${String(index + 1).padStart(4, '0')}`, label }));
export const diagnosisInterferenceIds = ['IF-DG-01', 'IF-DG-02'];
export const diagnosisPhases = ['排队校验', '规则与图谱诊断', '融合与根因定位', '影响范围分析', '修复建议整理', '报告就绪'];
export const faultLabels: Record<FaultType, string> = { HW_FAILURE: '硬件故障', LINK_DOWN: '链路中断', SW_CONFIG: '软件配置异常', EMI: '电磁干扰' };
const fault = (objectType: FaultInput['objectType'], objectId: string, faultType: FaultType, symptomIds: string[], interferenceId: string | null = null): FaultInput =>
  ({ objectType, objectId, faultType, symptomIds, occurTime: null, interferenceId });
const fixtures = [
  { id: 'hardware', label: '节点 3 功放故障', faults: [fault('DEVICE', 'DV-0027', 'HW_FAILURE', ['SY-0001', 'SY-0003'])], root: '节点 3 功放模块自检异常', component: '功率放大模块', steps: ['核对自检记录及供电', '由维护人员检查并更换故障模块', '复核恢复后的链路状态'] },
  { id: 'link', label: '链路 A 中断', faults: [fault('LINK', 'LINK-A', 'LINK_DOWN', ['SY-0005', 'SY-0008'])], root: '链路 A 两端建链失败', component: '链路 A', steps: ['核对两端供电与天馈', '检查备份路径配置', '修复后复核建链状态'] },
  { id: 'software', label: '节点 3 频率配置异常', faults: [fault('DEVICE', 'DV-0027', 'SW_CONFIG', ['SY-0012'])], root: '节点 3 与对端工作频率配置不一致', component: '设备配置', steps: ['核对已确认方案的两端参数', '由维护人员修正不一致项', '复核频率与建链记录'] },
  { id: 'emi', label: '链路 B 电磁干扰', faults: [fault('LINK', 'LINK-B', 'EMI', ['SY-0009', 'SY-0011'], 'IF-DG-01')], root: '预设宽带干扰造成链路 B 信噪比下降', component: '链路 B 接收端', steps: ['核对频谱采样记录', '按预案检查备用频率与路由', '干扰解除后复核业务质量'] },
  { id: 'multiple', label: '功放故障与干扰叠加', faults: [fault('DEVICE', 'DV-0027', 'HW_FAILURE', ['SY-0001', 'SY-0003']), fault('LINK', 'LINK-B', 'EMI', ['SY-0009', 'SY-0011'], 'IF-DG-01')], root: '节点 3 功放故障与链路 B 干扰并存', component: '功放模块 / 链路 B', steps: ['优先核对受影响业务与备用路径', '分别排查功放与干扰源', '逐项恢复后复核全部业务'] },
];
const networkOutcomes = {
  balanced: { confidence: 0.88, nodes: 2, direct: 1, indirect: 1, interrupted: 1, degraded: 1, loss: 64, detail: '均衡档预设：经备份链路维持部分业务', detour: ['ND-0001', 'ND-0004', 'ND-0003'] },
  economical: { confidence: 0.84, nodes: 3, direct: 1, indirect: 2, interrupted: 2, degraded: 1, loss: 128, detail: '节能档预设：中继主路径受影响，备用能力有限', detour: ['ND-0001', 'ND-0004'] },
} as const;
export const diagnosisPresets: DiagnosisPreset[] = Object.entries(networkOutcomes).flatMap(([networkId, outcome]) => fixtures.map((fixture) => {
  const emi = fixture.id === 'emi';
  const multiple = fixture.id === 'multiple';
  const nodeId = emi ? 'ND-0004' : 'ND-0003';
  const linkId = emi ? 'LINK-B' : 'LINK-A';
  const key = (f: FaultInput) => `${f.objectType}:${f.objectId}`;
  const result: DiagnosisResult = {
    fusionMode: 'TWO_WAY_DEGRADED', disabledReason: '本批未提供机器学习结果，采用规则与图谱两路预生成结论',
    conclusions: fixture.faults.map((f, index) => ({
      fault: structuredClone(f), label: f.objectId, faultType: f.faultType, confidence: outcome.confidence,
      rootCause: fixture.root, component: fixture.component, needManualReview: false,
      branches: [
        { source: 'RULE', conclusion: faultLabels[f.faultType], confidence: networkId === 'balanced' ? 0.9 : 0.86, weight: 0.5, contribution: null, disabledReason: null,
          evidence: [{ label: '教学规则', value: `DG-RULE-${fixture.id}-${index + 1}` }, { label: '匹配现象（仅展示）', value: f.symptomIds.join(' AND ') }] },
        { source: 'KG', conclusion: fixture.root, confidence: networkId === 'balanced' ? 0.86 : 0.82, weight: 0.5, contribution: null, disabledReason: null,
          evidence: [{ label: '教学三元组', value: `DG-KG-${fixture.id}-${index + 1}` }, { label: '路径', value: `现象 → ${faultLabels[f.faultType]} → ${fixture.component}` }] },
        { source: 'ML', conclusion: '未提供', confidence: null, weight: 0, contribution: null, disabledReason: '本批没有机器学习分支结果', evidence: [] },
      ],
      candidates: [{ faultType: f.faultType, confidence: outcome.confidence }],
      chain: [f.symptomIds.join(' / '), fixture.root, fixture.component],
    })),
    nodes: [
      { nodeId, affectType: 'DIRECT', level: 'SEVERE', state: 'INTERRUPTED', reason: fixture.root, detourRoute: [...outcome.detour] },
      { nodeId: 'ND-0001', affectType: 'INDIRECT', level: 'MODERATE', state: 'DEGRADED', reason: outcome.detail, detourRoute: [] },
      ...(multiple ? [{ nodeId: 'ND-0004', affectType: 'DIRECT' as const, level: 'MODERATE' as const, state: 'INTERRUPTED' as const, reason: '链路 B 干扰直接影响节点 4', detourRoute: [] }]
        : networkId === 'economical' ? [{ nodeId: emi ? 'ND-0003' : 'ND-0004', affectType: 'INDIRECT' as const, level: 'MINOR' as const, state: 'INTERRUPTED' as const, reason: '节能档静态演示中继影响', detourRoute: [] }] : []),
    ],
    links: [
      { linkId, level: 'SEVERE', state: 'INTERRUPTED', faultKey: key(fixture.faults[0]), bandwidthLossKbps: outcome.loss, isBackbone: true, reason: fixture.root },
      ...(multiple ? [{ linkId: 'LINK-B', level: 'MODERATE' as const, state: 'DEGRADED' as const, faultKey: key(fixture.faults[1]), bandwidthLossKbps: 32, isBackbone: false, reason: '独立预设的干扰影响' }] : []),
    ],
    regions: fixture.faults.map((f, index) => ({
      id: `DG-AREA-${fixture.id}-${index}`, label: `${f.objectId} 预设影响`, kind: 'impact', level: index === 0 ? 'SEVERE' : 'MODERATE', faultKey: key(f),
      rings: index === 0 && !emi ? [[[114.1,37.49],[114.14,37.56],[114.23,37.52],[114.29,37.36],[114.21,37.32],[114.12,37.43],[114.1,37.49]]] : [[[114.2,37.36],[114.28,37.39],[114.37,37.28],[114.35,37.2],[114.27,37.2],[114.2,37.36]]],
    })),
    summary: { affectedNodeCount: multiple ? 3 : outcome.nodes, directCount: multiple ? 2 : outcome.direct, indirectCount: multiple ? 1 : outcome.indirect, interruptedNodeCount: multiple ? 2 : outcome.interrupted,
      degradedNodeCount: outcome.degraded, affectedLinkCount: multiple ? 2 : 1, totalBandwidthLossKbps: multiple ? (networkId === 'balanced' ? 96 : 160) : outcome.loss,
      affectedDemandIds: multiple ? ['DEMAND-01', 'DEMAND-02'] : [emi ? 'DEMAND-02' : 'DEMAND-01'] },
    suggestions: [{ priority: 1, action: fixture.steps[0], applicability: fixture.root, steps: fixture.steps, spares: fixture.id === 'hardware' || multiple ? ['教学功放备件'] : [], tools: ['维护终端'], estimatedTimeMin: 30,
      tripleIds: [`DG-KG-${fixture.id}-1`], similarCases: [{ id: `DG-CASE-${fixture.id}`, similarity: 0.82, solution: fixture.steps.join('；') }] }],
    notes: ['独立教学预设 diagnosis-demo-1；不是在线诊断结果', outcome.detail, '分路贡献未提供；不由前端重新计算融合结果'],
  };
  return { id: `${networkId}:${fixture.id}`, label: fixture.label, networkPresetId: networkId as DiagnosisPreset['networkPresetId'], faults: structuredClone(fixture.faults), result };
}));

// 低置信度分支也是固定预生成数据，不根据界面阈值重算。
export function diagnosisDemoResult(result: DiagnosisResult, lowConfidence: boolean): DiagnosisResult {
  const copy = structuredClone(result);
  if (lowConfidence) for (const conclusion of copy.conclusions) {
    conclusion.confidence = 0.52;
    conclusion.needManualReview = true;
    conclusion.candidates = [{ faultType: conclusion.faultType, confidence: 0.52 }, { faultType: conclusion.faultType === 'SW_CONFIG' ? 'HW_FAILURE' : 'SW_CONFIG', confidence: 0.46 }];
    conclusion.branches[0].confidence = 0.58;
    conclusion.branches[1].confidence = 0.46;
    conclusion.branches[1].conclusion = '配置异常亦可能解释现象，需人工研判';
  }
  return copy;
}
