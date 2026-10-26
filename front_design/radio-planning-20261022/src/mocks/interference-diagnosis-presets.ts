import type { DiagnosisPreset, DiagnosisResult, FaultInput, FaultType } from '../types/diagnosis';
import { interferenceVariants } from './interference-presets';

// 抗干扰网络专用诊断常量；不从旧网络诊断结果拷贝，也不执行推理。
const fault = (objectType: FaultInput['objectType'], objectId: string, faultType: FaultType,
  symptomIds: string[], interferenceId: string | null = null): FaultInput =>
  ({ objectType, objectId, faultType, symptomIds, occurTime: null, interferenceId });
const hardware = fault('DEVICE', 'DV-0037', 'HW_FAILURE', ['SY-0001', 'SY-0003']);
const emi = fault('LINK', 'LINK-B', 'EMI', ['SY-0009', 'SY-0011'], 'IF-0008');
const fixtures = [
  { id: 'hardware', label: '调整后节点 4 功放故障', faults: [hardware], root: '调整后节点 4 发射模块自检异常', component: 'DV-0037 功放模块' },
  { id: 'link', label: '调整后链路 B 中断', faults: [fault('LINK', 'LINK-B', 'LINK_DOWN', ['SY-0005', 'SY-0008'])], root: '调整后链路 B 建链超时', component: 'LINK-B' },
  { id: 'software', label: '调整后节点 4 配置偏离', faults: [fault('DEVICE', 'DV-0037', 'SW_CONFIG', ['SY-0012'])], root: '运行配置偏离本次确认的抗干扰配置', component: 'DV-0037 配置' },
  { id: 'emi', label: '调整后链路 B 再次受扰', faults: [emi], root: '新增教学故障中链路 B 接收底噪抬升', component: 'LINK-B 接收端' },
  { id: 'multiple', label: '调整后功放与干扰复合故障', faults: [hardware, emi], root: '调整后功放异常与再次受扰并存', component: 'DV-0037 / LINK-B' },
];
export const interferenceDiagnosisPresets: DiagnosisPreset[] = interferenceVariants.flatMap(variant =>
  fixtures.map(fixture => {
    const rerouted = variant.type === 'ROUTE_REBUILD';
    const key = (f: FaultInput) => f.objectType + ':' + f.objectId;
    const evidence = JSON.stringify(variant.result.configuration.devices.find(row => row.deviceId === 'DV-0037'));
    const result: DiagnosisResult = {
      fusionMode: 'TWO_WAY_DEGRADED', disabledReason: '该变体提供规则与图谱两路教学结论，未提供 ML 结果',
      conclusions: fixture.faults.map(f => ({
        fault: structuredClone(f), label: f.objectId, faultType: f.faultType, confidence: rerouted ? 0.89 : 0.87,
        rootCause: fixture.root, component: fixture.component, needManualReview: false,
        branches: [
          { source: 'RULE', conclusion: fixture.root, confidence: 0.9, weight: 0.5, contribution: null, disabledReason: null,
            evidence: [{ label: '变体规则', value: 'IF-DG-RULE:' + variant.id + ':' + fixture.id }, { label: '确认配置基线', value: evidence }] },
          { source: 'KG', conclusion: fixture.root, confidence: 0.84, weight: 0.5, contribution: null, disabledReason: null,
            evidence: [{ label: '变体依据', value: variant.label + ' → ' + fixture.component }, { label: '现象', value: f.symptomIds.join(' / ') }] },
          { source: 'ML', conclusion: '未提供', confidence: null, weight: 0, contribution: null, disabledReason: '无对应模型输出', evidence: [] },
        ],
        candidates: [{ faultType: f.faultType, confidence: rerouted ? 0.89 : 0.87 }],
        chain: [variant.label, f.symptomIds.join(' / '), fixture.root, fixture.component],
      })),
      nodes: [
        { nodeId: 'ND-0004', affectType: 'DIRECT', level: rerouted ? 'MODERATE' : 'SEVERE', state: rerouted ? 'DEGRADED' : 'INTERRUPTED',
          reason: fixture.root, detourRoute: rerouted ? ['ND-0001', 'ND-0003', 'ND-0004'] : [] },
        { nodeId: 'ND-0001', affectType: 'INDIRECT', level: 'MINOR', state: 'DEGRADED', reason: '固定教学业务影响', detourRoute: [] },
      ],
      links: [{ linkId: 'LINK-B', level: 'SEVERE', state: 'INTERRUPTED', faultKey: key(fixture.faults[0]),
        bandwidthLossKbps: rerouted ? 16 : 48, isBackbone: !rerouted, reason: fixture.root }],
      regions: [{
        id: 'IF-DG-AREA:' + variant.id + ':' + fixture.id, label: '抗干扰网络故障影响', kind: 'impact', level: 'MODERATE',
        faultKey: key(fixture.faults[0]), rings: variant.type === 'NODE_REDEPLOY'
          ? [[[114.27,37.23],[114.34,37.23],[114.34,37.29],[114.27,37.29],[114.27,37.23]]]
          : [[[114.24,37.2],[114.38,37.2],[114.38,37.38],[114.24,37.38],[114.24,37.2]]],
      }],
      summary: { affectedNodeCount: 2, directCount: 1, indirectCount: 1, interruptedNodeCount: rerouted ? 0 : 1,
        degradedNodeCount: rerouted ? 2 : 1, affectedLinkCount: 1, totalBandwidthLossKbps: rerouted ? 16 : 48, affectedDemandIds: ['DEMAND-02'] },
      suggestions: [{
        priority: 1, action: '按本次抗干扰确认配置排查', applicability: fixture.root,
        steps: ['核对变体 ' + variant.id + ' 的冻结配置', '由维护人员检查故障对象及备份路径', '修复后另行确认业务恢复'],
        spares: fixture.id === 'hardware' || fixture.id === 'multiple' ? ['节点 4 功放备件'] : [],
        tools: ['维护终端'], estimatedTimeMin: 25, tripleIds: ['IF-DG-KG:' + variant.id + ':' + fixture.id],
        similarCases: [{ id: 'IF-DG-CASE:' + variant.id + ':' + fixture.id, solution: '核对抗干扰配置后逐项排障', similarity: 0.83 }],
      }],
      notes: ['抗干扰变体专用教学结果：' + variant.id, '故障为确认后的独立注入场景，不表示措施采纳失败', '指标均为预生成常量'],
    };
    return { id: 'interference:' + variant.id + ':' + fixture.id, label: fixture.label,
      networkPresetId: 'interference:' + variant.id, faults: structuredClone(fixture.faults), result };
  }));
