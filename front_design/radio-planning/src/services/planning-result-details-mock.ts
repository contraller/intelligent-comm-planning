import { planningResultDetailsCatalog } from '../mocks/planning-result-details';
import { planningCandidatesCatalog, PLANNING_CANDIDATES_ASSET_VERSION } from '../mocks/planning-candidates';
import { planningPresets } from './planning-preset-catalog';
import { deploymentAssetSources, deploymentDetailsCatalog, DEPLOYMENT_DETAILS_ASSET_VERSION } from '../mocks/deployment-constraint-presets';
import { interferenceVariants } from '../mocks/interference-presets';
import type { PlanningDemand, PlanningInput } from '../types/planning';
import type { PlanningResultDetails, PlanningResultDetailsContext } from '../types/planning-result-details';
import { assertPlanningResultDetails } from './planning-result-details-validation';
import { optionsAssetSources, optionsDetailsCatalog, OPTIONS_DETAILS_VERSION } from '../mocks/planning-options-presets';
import { routingAssetSources, routingDetailsCatalog, ROUTING_DETAILS_VERSION } from '../mocks/planning-routing-presets';

type CatalogVersion = { presets: Record<string, PlanningResultDetails>; variants: Record<string, PlanningResultDetails> };
function catalog(assetVersion: string): CatalogVersion {
  // 按记录原版本查目录，旧作业不会被最新候选结果回填。
  const versions: Record<string, CatalogVersion> = { ...planningResultDetailsCatalog, ...planningCandidatesCatalog, ...deploymentDetailsCatalog, ...optionsDetailsCatalog, ...routingDetailsCatalog };
  if (!Object.hasOwn(versions, assetVersion)) throw new Error('未知的规划明细教学资产版本');
  return versions[assetVersion];
}
function sameDemand(a: PlanningDemand, b: PlanningDemand) {
  return a.sourceId === b.sourceId && a.targetId === b.targetId && a.service === b.service &&
    (a.endpointMode ?? 'station') === (b.endpointMode ?? 'station') &&
    (a.sourceDeviceId ?? null) === (b.sourceDeviceId ?? null) && (a.targetDeviceId ?? null) === (b.targetDeviceId ?? null);
}
function bind(asset: PlanningResultDetails, input: PlanningInput, template: PlanningInput) {
  const copy = structuredClone(asset);
  const demandId = (id: string) => {
    const original = template.demands.find(row => row.id === id);
    const matches = original ? input.demands.filter(row => sameDemand(row, original)) : [];
    if (matches.length !== 1) throw new Error('规划补充明细无法唯一关联冻结需求');
    return matches[0].id;
  };
  // 映射只依据已匹配端点及业务身份，不依赖需求数组位置。
  copy.routeQuality?.forEach(row => { row.demandId = demandId(row.demandId); });
  if (copy.unreachableDemandIds) copy.unreachableDemandIds = copy.unreachableDemandIds.map(demandId);
  copy.optimization?.criticalBridges?.forEach(row => { row.affectedDemandIds = row.affectedDemandIds.map(demandId); });
  return copy;
}

export function getPresetResultDetails(presetId: string, input: PlanningInput,
  // 新预设只用自己发布的资产版本；显式传入的历史版本不被覆盖。
  assetVersion = Object.hasOwn(routingAssetSources, presetId) ? ROUTING_DETAILS_VERSION : Object.hasOwn(optionsAssetSources, presetId) ? OPTIONS_DETAILS_VERSION : Object.hasOwn(deploymentAssetSources, presetId) ? DEPLOYMENT_DETAILS_ASSET_VERSION : PLANNING_CANDIDATES_ASSET_VERSION): PlanningResultDetails | undefined {
  const version = catalog(assetVersion);
  const preset = planningPresets.find(row => row.id === presetId);
  if (!preset) throw new Error('规划明细预设身份不存在');
  if (!preset.result) return undefined;
  const asset = Object.hasOwn(version.presets, presetId) ? version.presets[presetId] : undefined;
  if (!asset) throw new Error('规划明细预设资产缺失');
  return bind(asset, input, preset.input);
}

export function getVariantResultDetails(variantId: string, input: PlanningInput,
  assetVersion = PLANNING_CANDIDATES_ASSET_VERSION): PlanningResultDetails {
  const version = catalog(assetVersion);
  const variant = interferenceVariants.find(row => row.id === variantId);
  const template = variant && planningPresets.find(row => row.id === variant.networkPresetId);
  const asset = Object.hasOwn(version.variants, variantId) ? version.variants[variantId] : undefined;
  if (!template || !asset) throw new Error('规划明细措施变体身份不存在');
  return bind(asset, input, template.input);
}

// 独立比较避免引入 planning-validation 的调用环；只比较冻结数据，不更新资产。
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) &&
    sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
export function assertMockResultDetails(value: unknown, options: {
  presetId?: string; variantId?: string; input: PlanningInput; context: PlanningResultDetailsContext;
}): void {
  assertPlanningResultDetails(value, options.context);
  if ((options.presetId === undefined) === (options.variantId === undefined)) throw new Error('规划明细来源身份不唯一');
  // 使用记录自己的版本；旧字段缺省由调用方跳过，禁止在读取时补最新目录。
  const expected = options.variantId !== undefined
    ? getVariantResultDetails(options.variantId, options.input, value.assetVersion)
    : getPresetResultDetails(options.presetId!, options.input, value.assetVersion);
  if (!sameValue(value, expected)) throw new Error('规划补充明细与冻结教学资产不一致');
}
