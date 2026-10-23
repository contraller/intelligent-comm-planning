import type { DiagnosisDemo, DiagnosisPreset, DiagnosisPropagationPath, DiagnosisResult } from '../types/diagnosis';
import { diagnosisDemoResult } from './diagnosis-presets';
import { ApiError } from '../services/types';
import { DIAGNOSIS_PRESET_VERSION } from '../config/demo';

// 这些顺序和原因是独立教学常量，不从拓扑搜索或备份路由生成。
const steps = (rows: [string, string][]): DiagnosisPropagationPath['steps'] => rows.map(([key, reason]) => {
  const [objectType, objectId] = key.split(':');
  return { objectType: objectType as 'NODE' | 'DEVICE' | 'LINK', objectId, reason };
});
const ordinary = {
  hardware: steps([['DEVICE:DV-0027', '功放自检异常'], ['NODE:ND-0003', '节点 3 发射能力下降'], ['LINK:LINK-A', '链路 A 通联中断'], ['NODE:ND-0001', '节点 1 相关业务间接受影响']]),
  software: steps([['DEVICE:DV-0027', '频率配置不一致'], ['NODE:ND-0003', '节点 3 无法按确认配置通联'], ['LINK:LINK-A', '链路 A 建链受阻'], ['NODE:ND-0001', '节点 1 相关业务降级']]),
  link: steps([['LINK:LINK-A', '链路 A 中断'], ['NODE:ND-0003', '节点 3 直连业务中断'], ['NODE:ND-0001', '节点 1 相关业务间接受影响']]),
  emi: steps([['LINK:LINK-B', '链路 B 接收受扰'], ['NODE:ND-0004', '节点 4 接收业务受影响'], ['NODE:ND-0001', '节点 1 相关业务降级']]),
};
const adjusted = {
  hardware: steps([['DEVICE:DV-0037', '调整后功放自检异常'], ['NODE:ND-0004', '节点 4 发射能力受影响'], ['LINK:LINK-B', '链路 B 通联受阻'], ['NODE:ND-0001', '节点 1 相关业务降级']]),
  software: steps([['DEVICE:DV-0037', '运行配置偏离确认配置'], ['NODE:ND-0004', '节点 4 通联配置异常'], ['LINK:LINK-B', '链路 B 建链受阻'], ['NODE:ND-0001', '节点 1 相关业务降级']]),
  link: steps([['LINK:LINK-B', '链路 B 中断'], ['NODE:ND-0004', '节点 4 直连通联受影响'], ['NODE:ND-0001', '节点 1 相关业务降级']]),
  emi: steps([['LINK:LINK-B', '链路 B 再次受扰'], ['NODE:ND-0004', '节点 4 接收业务受影响'], ['NODE:ND-0001', '节点 1 相关业务降级']]),
};
export const supportsThreeWay = (presetId: string) => presetId === 'balanced:hardware';

export function diagnosisPresetResult(preset: DiagnosisPreset, version: string, demo: DiagnosisDemo): DiagnosisResult {
  if (version !== DIAGNOSIS_PRESET_VERSION) throw new ApiError('诊断结果版本不支持', 'DIAGNOSIS_INCOMPATIBLE');
  if (demo === 'three-way' && !supportsThreeWay(preset.id))
    throw new ApiError('三路教学演示仅支持均衡网络的功放故障模板，当前输入暂无该分支预生成结果', 'NO_PRESET');
  const result = diagnosisDemoResult(preset.result, demo === 'low-confidence');
  const kind = preset.id.split(':').at(-1)!;
  const paths = preset.networkPresetId.startsWith('interference:') ? adjusted : ordinary;
  const kinds = kind === 'multiple' ? ['hardware', 'emi'] as const : [kind as keyof typeof ordinary];
  result.propagationPaths = kinds.map((item, index) => ({ id: `${preset.id}:path:${index + 1}`,
    faultKey: `${preset.faults[index].objectType}:${preset.faults[index].objectId}`,
    level: index ? 'MODERATE' : 'SEVERE', reason: preset.result.conclusions[index].rootCause,
    steps: structuredClone(paths[item]),
  }));
  if (demo === 'three-way') {
    // 置信度、权重与贡献分别读取固定值；这里不实现融合算法。
    result.fusionMode = 'THREE_WAY'; result.disabledReason = '';
    const conclusion = result.conclusions[0];
    conclusion.confidence = 0.895; conclusion.candidates = [{ faultType: 'HW_FAILURE', confidence: 0.895 }];
    conclusion.branches[0].weight = 0.4; conclusion.branches[0].contribution = 0.36;
    conclusion.branches[1].weight = 0.35; conclusion.branches[1].contribution = 0.301;
    conclusion.branches[2] = { source: 'ML', conclusion: '教学模型判定功放模块故障', confidence: 0.936,
      weight: 0.25, contribution: 0.234, disabledReason: null,
      evidence: [{ label: '教学模型', value: 'DG-ML-HW-1（固定预生成输出）' }, { label: '特征说明', value: '功放自检及发射异常的预生成教学特征；未调用在线模型' }] };
    result.notes = ['三路正常态独立教学预生成结果；不代表真实模型已接入', '权重与贡献为分别提供的服务字段，不由前端推算'];
  }
  return result;
}
