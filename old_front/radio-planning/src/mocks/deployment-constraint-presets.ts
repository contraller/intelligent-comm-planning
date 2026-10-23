import { planningPresets as originals } from './planning-presets';
import { planningCandidatesCatalog, PLANNING_CANDIDATES_ASSET_VERSION } from './planning-candidates';
import type { DeploymentConstraints } from '../types/deployment-constraints';
import type { PlanningPreset } from '../types/planning';
import type { PlanningResultDetails } from '../types/planning-result-details';

export const DEPLOYMENT_DETAILS_ASSET_VERSION = 'planning-result-details-demo-3';
// 固定教学输入；通视节点使用三站场景的ND-0001/ND-0003，不冒充原请求样例。
const constraints: DeploymentConstraints = { maxSlopeDeg: 18, elevationRangeM: [20, 1800],
  allowedLandcover: ['草地', '耕地', '林地', '建成区'], roadMaxDistanceM: 3500, minSiteSpacingM: 3000,
  losRequiredNodeIds: ['ND-0001', 'ND-0003'], gridStepM: 500, forcedInclude: [], forcedExcludePolygons: [] };
export const deploymentAssetSources: Record<string, string> = {
  'deployment-balanced': 'balanced', 'deployment-economical': 'economical',
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
// 明确发布两份完整输入/结果常量，复制已有教学输出，不按用户约束计算结果。
export const deploymentPlanningPresets = freeze(Object.entries(deploymentAssetSources).map(([id, sourceId]): PlanningPreset => {
  const base = structuredClone(originals.find(preset => preset.id === sourceId)!);
  return { ...base, id, label: sourceId === 'balanced' ? '部署约束 · 均衡教学' : '部署约束 · 节能教学',
    scene: '三站部署筛选条件教学', source: '独立教学预生成结果 · 部署条件演示',
    summary: '固定坡度/海拔/地物/道路/间距/通视/网格条件；其他组合可保存，计算无匹配时明确提示。',
    input: { ...base.input, presetId: id, name: '部署筛选条件教学任务', startTime: null, durationH: null,
      demands: base.input.demands.map(row => ({ ...row, endpointMode: 'station', sourceDeviceId: null, targetDeviceId: null, preferredClass: null })),
      deploymentConstraints: structuredClone(constraints) } };
}));
const details = planningCandidatesCatalog[PLANNING_CANDIDATES_ASSET_VERSION];
const presets = Object.fromEntries(Object.entries(deploymentAssetSources).map(([id, sourceId]) => {
  const detail: PlanningResultDetails = structuredClone(details.presets[sourceId]);
  detail.assetVersion = DEPLOYMENT_DETAILS_ASSET_VERSION;
  if (detail.candidateScreening) detail.candidateScreening.sourceLabel = '独立部署约束教学候选结果 · 三站场景';
  return [id, detail];
}));
export const deploymentDetailsCatalog = freeze({ [DEPLOYMENT_DETAILS_ASSET_VERSION]: { presets, variants: {} } });
freeze(deploymentAssetSources);
