import type { DiagnosisConclusion } from '../types/diagnosis';
import { confidenceText, reportValue } from '../reports/diagnosis-report';

// 只描述场景注入标识；配色不代表设备运行状态或影响等级。
export const diagnosisFaultTypes = [
  { type: 'HW_FAILURE', label: '硬件故障', glyph: '◆', color: '#c895ed', symbol: 'diamond', points: 4, angle: 0, radius2: undefined },
  { type: 'LINK_DOWN', label: '链路中断', glyph: '✕', color: '#f0a76c', symbol: 'path://M2,0 L10,8 L18,0 L20,2 L12,10 L20,18 L18,20 L10,12 L2,20 L0,18 L8,10 L0,2 Z', points: 4, angle: Math.PI / 4, radius2: 0 },
  { type: 'SW_CONFIG', label: '软件配置异常', glyph: '■', color: '#93aafb', symbol: 'rect', points: 4, angle: Math.PI / 4, radius2: undefined },
  { type: 'EMI', label: '电磁干扰', glyph: '✦', color: '#ed98ca', symbol: 'path://M10,0 L13,7 L20,10 L13,13 L10,20 L7,13 L0,10 L7,7 Z', points: 4, angle: 0, radius2: 4 },
] as const;
const unknownFault = { label: '未知类型', glyph: '?', color: '#b0bacb', symbol: 'circle', points: 3, angle: 0, radius2: undefined };
export function diagnosisFaultVisual(type: string) {
  return diagnosisFaultTypes.find(item => item.type === type) ?? unknownFault;
}
export interface DiagnosisSymptomLabel { id: string; label: string }
export function diagnosisRootDisplay(conclusion: DiagnosisConclusion, symptoms: readonly DiagnosisSymptomLabel[]) {
  const labels = new Map(symptoms.map(item => [item.id, item.label]));
  return {
    symptoms: (conclusion.fault?.symptomIds ?? []).map(id => ({ id, label: labels.get(id) || '名称未提供' })),
    cause: reportValue(conclusion.rootCause), component: reportValue(conclusion.component),
    // 历史链条是自由文本，保留原顺序，不把下标当作现象/原因/部件身份。
    chain: [...conclusion.chain],
  };
}
const branchSources = [{ source: 'RULE', label: '规则' }, { source: 'KG', label: '知识图谱' }, { source: 'ML', label: '机器学习' }] as const;
export function diagnosisBranchSummary(conclusion: DiagnosisConclusion) {
  return branchSources.map(item => {
    const matches = conclusion.branches.filter(branch => branch.source === item.source);
    const branch = matches.length === 1 ? matches[0] : undefined;
    return { ...item, conclusion: reportValue(branch?.conclusion), confidence: confidenceText(branch?.confidence ?? null),
      weight: reportValue(branch?.weight), contribution: reportValue(branch?.contribution),
      reason: branch?.disabledReason || (matches.length > 1 ? '分路资料重复，请查看详细依据' : branch ? '' : '分路资料未提供') };
  });
}
