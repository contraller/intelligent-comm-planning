import type { PlanVersion } from '../types/domain';
import { diagnosisPresets, diagnosisInterferenceIds } from '../mocks/diagnosis-presets';
import { interferenceDiagnosisPresets } from '../mocks/interference-diagnosis-presets';
import { planningResultPresetId } from './planning-result-identity';

// 仅汇总目录与匹配身份；原有教学文件及历史结果保持原样。
export const allDiagnosisPresets = [...diagnosisPresets, ...interferenceDiagnosisPresets];
export const diagnosisNetworkKey = (plan: PlanVersion) => plan.workflow?.interferenceOrigin
  ? 'interference:' + plan.workflow.interferenceOrigin.variantId : plan.workflow ? planningResultPresetId(plan.workflow) : undefined;
export const networkDiagnosisPresets = (plan: PlanVersion) =>
  allDiagnosisPresets.filter(preset => preset.networkPresetId === diagnosisNetworkKey(plan));
export const networkInterferenceIds = (plan: PlanVersion) => plan.workflow?.interferenceOrigin
  ? plan.workflow.interferenceOrigin.sources.map(source => source.id) : [...diagnosisInterferenceIds];
