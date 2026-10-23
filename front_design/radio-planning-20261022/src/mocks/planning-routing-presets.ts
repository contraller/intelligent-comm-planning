import { freezeMockData as freeze } from './freeze';
import { planningPresets as originals } from './planning-presets';
import { planningCandidatesCatalog, PLANNING_CANDIDATES_ASSET_VERSION } from './planning-candidates';
import type { PlanningPreset } from '../types/planning';
import type { PlanningResultDetails } from '../types/planning-result-details';

export const ROUTING_DETAILS_VERSION = 'planning-result-details-demo-5';
export const routingAssetSources: Record<string, string> = { 'routing-balanced': 'balanced', 'routing-economical': 'economical' };
export const routingAdjustableIds = Object.keys(routingAssetSources);
// 独立固定输入及完整输出，不根据策略求路由；两个档位均已提供主备记录。
export const routingPlanningPresets: PlanningPreset[] = Object.entries(routingAssetSources).map(([id, sourceId]) => {
  const preset = structuredClone(originals.find(row => row.id === sourceId)!);
  preset.id = id; preset.label = sourceId === 'balanced' ? '路由要求 · 均衡档' : '路由要求 · 节能档';
  preset.scene = '路由请求教学'; preset.source = '独立固定结果 planning-routing-demo-1';
  preset.summary = '最高可靠性并请求备份的固定输入；其他条件可保存，无匹配时明确提示。';
  preset.input = { ...preset.input, presetId: id, demands: preset.input.demands.map(row => ({ ...row, routeStrategy: 'MAX_RELIABILITY', needBackup: true })) };
  return preset;
});
const details = planningCandidatesCatalog[PLANNING_CANDIDATES_ASSET_VERSION].presets;
export const routingDetailsCatalog = { [ROUTING_DETAILS_VERSION]: {
  presets: Object.fromEntries(Object.entries(routingAssetSources).map(([id, sourceId]) => {
    const detail: PlanningResultDetails = structuredClone(details[sourceId]);
    detail.assetVersion = ROUTING_DETAILS_VERSION;
    return [id, detail];
  })), variants: {},
} };
freeze(routingPlanningPresets); freeze(routingDetailsCatalog); freeze(routingAssetSources); freeze(routingAdjustableIds);
