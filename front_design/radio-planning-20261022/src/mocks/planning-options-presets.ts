import { freezeMockData as freeze } from './freeze';
import { planningPresets as originals } from './planning-presets';
import { deploymentPlanningPresets, deploymentDetailsCatalog, DEPLOYMENT_DETAILS_ASSET_VERSION } from './deployment-constraint-presets';
import type { PlanningPreset } from '../types/planning';
import type { PlanningOptimization, PlanningResultDetails } from '../types/planning-result-details';

export const OPTIONS_DETAILS_VERSION = 'planning-result-details-demo-4';
export const optionsAssetSources: Record<string, string> = { 'options-min': 'balanced', 'options-min-economical': 'economical',
  'options-fixed': 'balanced', 'options-fixed-economical': 'economical', 'options-gap': 'shortage', 'options-bridge': 'economical' };
export const optionsAdjustableIds = ['options-min', 'options-min-economical', 'options-fixed', 'options-fixed-economical'];
const optimization: PlanningOptimization = { sourceLabel: '独立教学优化结果，非实时计算', tradeoff: [
  { id: 'POINT-REFERENCE', survivabilityPercent: 82, totalRadiatedPowerW: 55, meetsConstraints: false, description: '仅供权衡参考，无完整可保存网络' },
  { id: 'POINT-ECONOMICAL', survivabilityPercent: 91, totalRadiatedPowerW: 60, meetsConstraints: true, description: '教学节能档' },
  { id: 'POINT-BALANCED', survivabilityPercent: 96, totalRadiatedPowerW: 190, meetsConstraints: true, description: '教学均衡档' },
], criticalBridges: [] };
// 发布常量复制已有输出；不根据用户范围、数量或拓扑计算任何结果。
export const optionsPlanningPresets: PlanningPreset[] = Object.entries(optionsAssetSources).map(([id, sourceId]) => {
  const source = originals.find(p => p.id === sourceId)!, preset = structuredClone(source);
  const fixed = id.startsWith('options-fixed'), gap = id === 'options-gap';
  const labels: Record<string, string> = { 'options-min': '最少新增部署 · 两份备选', 'options-fixed': '指定0新增部署 · 期望3份返回1份',
    'options-gap': '频率受限 · 缺口反馈', 'options-bridge': '关键链路 · 未达标参考', 'options-min-economical': '节能备选', 'options-fixed-economical': '指定数量 · 节能调整' };
  preset.id = id; preset.label = labels[id]; preset.scene = '频率与多方案教学'; preset.source = '独立教学固定结果 planning-options-demo-1';
  preset.summary = '固定输入与固定结果；其他条件可保存，没有对应结果时明确提示。';
  preset.input = { ...structuredClone(deploymentPlanningPresets[0].input), presetId: id, name: labels[id],
    frequencyId: gap ? 'hf-limited' : 'hf-full',
    frequencyConstraints: { filters: [{ deviceClass: 'HF', rangeKhz: gap ? [6000, 6000] : [6000, 10000], excludeFreqIds: ['FQ-DEMO-HF-9000'] }] },
    deploymentSolve: { mode: fixed ? 'FIXED_COUNT' : 'MIN_COUNT', fixedCount: fixed ? 0 : null, solutionCount: fixed ? 3 : 2 } };
  preset.radioCount = 0;
  preset.hidden = id.endsWith('-economical');
  if (!preset.hidden) preset.solutionPresetIds = gap ? [] : id === 'options-min' ? ['options-min', 'options-min-economical'] : [id];
  if (id === 'options-fixed') preset.outcome.message = '已完成；期望3份，实际提供1份完整结果';
  if (id === 'options-bridge') {
    const r = preset.result!;
    r.links = r.links.filter(l => l.id !== 'LINK-B'); r.links.forEach(l => { l.backup = false; });
    r.configuration.routes = [
      { id: 'ROUTE-1', demandId: 'DEMAND-01', nodeIds: ['ND-0001', 'ND-0003'], linkIds: ['LINK-A'], backup: false },
      { id: 'ROUTE-2', demandId: 'DEMAND-02', nodeIds: ['ND-0001', 'ND-0003', 'ND-0004'], linkIds: ['LINK-A', 'LINK-C'], backup: false },
    ];
    r.metrics = { connectivityPercent: 100, survivabilityPercent: 0, totalRadiatedPowerW: 60, coveragePercent: 90, delayMs: 45 };
    r.checks = r.checks.map(c => c.id === 'survivability' ? { ...c, passed: false, detail: '固定教学结论：关键链路断开后必要通联可能全部中断' } : c);
    r.notes.push('独立主路径网络，无备份；关键桥和影响清单为教学常量。');
    preset.outcome = { code: 3001, message: '已完成，抗毁性未达标', suggestions: ['查看关键桥及受影响需求；可保存参考，不可确认配置'], gap: [{ objectId: 'NETWORK', field: 'survivability', message: '教学结果0%，未满足90%目标' }] };
  }
  return preset;
});
const baseDetails = deploymentDetailsCatalog[DEPLOYMENT_DETAILS_ASSET_VERSION].presets;
export const optionsDetailsCatalog = { [OPTIONS_DETAILS_VERSION]: { presets: Object.fromEntries(optionsPlanningPresets.filter(p => p.result).map(p => {
  const sourceId = optionsAssetSources[p.id];
  const detail: PlanningResultDetails = structuredClone(baseDetails[sourceId === 'balanced' ? 'deployment-balanced' : 'deployment-economical']);
  detail.assetVersion = OPTIONS_DETAILS_VERSION; detail.optimization = structuredClone(optimization);
  if (p.id === 'options-fixed') detail.optimization.criticalBridges = null;
  if (p.id === 'options-bridge') {
    detail.routeQuality = [
      { routeId: 'ROUTE-1', demandId: 'DEMAND-01', hopCount: 1, totalDistanceM: null, totalDelayMs: 30, bottleneckMarginDb: null, reliability: 0.95, isFeasible: true, bottleneckLinkId: 'LINK-A' },
      { routeId: 'ROUTE-2', demandId: 'DEMAND-02', hopCount: 2, totalDistanceM: null, totalDelayMs: 45, bottleneckMarginDb: null, reliability: 0.95, isFeasible: true, bottleneckLinkId: 'LINK-C' },
    ];
    detail.frequencyAssignments = detail.frequencyAssignments?.filter(a => a.linkId !== 'LINK-B') ?? null;
    detail.optimization = { sourceLabel: '独立无备份路径教学结果', tradeoff: null, criticalBridges: [
      { linkId: 'LINK-A', affectedDemandIds: ['DEMAND-01', 'DEMAND-02'], survivabilityAfterFailurePercent: 0, explanation: '教学固定影响：两条必要通联都引用此主路径链路' },
      { linkId: 'LINK-C', affectedDemandIds: ['DEMAND-02'], survivabilityAfterFailurePercent: 50, explanation: '教学固定影响：第二条必要通联中断' },
    ] };
  }
  // 身份映射显式发布，不用数值寻找原附件FQ编号。
  const freqIds: Record<number, string> = { 6000: 'FQ-DEMO-HF-6000', 8000: 'FQ-DEMO-HF-8000', 10000: 'FQ-DEMO-HF-10000' };
  detail.frequencyAssignments?.forEach(a => { a.freqId = freqIds[a.frequencyKhz] ?? null; });
  return [p.id, detail];
})), variants: {} } };
freeze(optionsPlanningPresets); freeze(optionsDetailsCatalog); freeze(optionsAssetSources);
