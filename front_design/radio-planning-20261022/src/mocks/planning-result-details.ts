import { freezeMockData as freeze } from './freeze';
import type { PlanningFrequencyAssignment, PlanningResultDetails, PlanningRouteQuality } from '../types/planning-result-details';

export const PLANNING_RESULT_DETAILS_ASSET_VERSION = 'planning-result-details-demo-1';

// 本目录是独立教学结果；未来修订新增版本，不覆盖已发布目录，也不导入核心预设。
const nvisParameters = [
  { deviceId: 'DV-0001', tiltDeg: null, tiltEffective: false },
  { deviceId: 'DV-0002', tiltDeg: null, tiltEffective: false },
  { deviceId: 'DV-0027', tiltDeg: null, tiltEffective: false },
  { deviceId: 'DV-0028', tiltDeg: null, tiltEffective: false },
  { deviceId: 'DV-0037', tiltDeg: null, tiltEffective: false },
  { deviceId: 'DV-0038', tiltDeg: null, tiltEffective: false },
];
// 构造器只填入显式常量及未提供值，不从路径、参数或基础方案计算质量。
function quality(routeId: string, demandId: string, values: Partial<Omit<PlanningRouteQuality, 'routeId' | 'demandId'>> = {}): PlanningRouteQuality {
  return { routeId, demandId, hopCount: null, totalDistanceM: null, totalDelayMs: null,
    bottleneckMarginDb: null, reliability: null, isFeasible: null, bottleneckLinkId: null, ...values };
}
function assignment(id: string, linkId: string, frequencyKhz: number): PlanningFrequencyAssignment {
  return { id, linkId, resourceGroupId: 'hf-full', freqId: null, reuseGroup: 0, frequencyKhz, bandwidthKhz: 3 };
}
function details(routeQuality: PlanningRouteQuality[], frequencyAssignments: PlanningFrequencyAssignment[]): PlanningResultDetails {
  return { schemaVersion: 1, assetVersion: PLANNING_RESULT_DETAILS_ASSET_VERSION,
    deviceParameters: structuredClone(nvisParameters), routeQuality, frequencyAssignments,
    frequencyConflicts: [], frequencyGap: { requiredChannels: 3, availableChannels: 3, shortage: 0 },
    conflictFree: true, unreachableDemandIds: [] };
}
const presets: Record<string, PlanningResultDetails> = {
  balanced: details([
    quality('ROUTE-1', 'DEMAND-01', { hopCount: 1, totalDistanceM: 7900, totalDelayMs: 20, bottleneckMarginDb: 18, reliability: 0.99, isFeasible: true, bottleneckLinkId: 'LINK-A' }),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 1, totalDistanceM: 31200, totalDelayMs: 32, bottleneckMarginDb: 14.5, reliability: 0.98, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-3', 'DEMAND-01', { hopCount: 2, totalDistanceM: 55000, totalDelayMs: 58, bottleneckMarginDb: 11.5, reliability: 0.96, isFeasible: true, bottleneckLinkId: 'LINK-C' }),
    quality('ROUTE-4', 'DEMAND-02', { hopCount: 2, totalDistanceM: 31700, totalDelayMs: 42, bottleneckMarginDb: 12, reliability: 0.97, isFeasible: true, bottleneckLinkId: 'LINK-C' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  economical: details([
    quality('ROUTE-1', 'DEMAND-01', { hopCount: 1, totalDistanceM: 7900, totalDelayMs: 26, bottleneckMarginDb: 13, reliability: 0.98, isFeasible: true, bottleneckLinkId: 'LINK-A' }),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 2, totalDistanceM: 31700, totalDelayMs: 45, bottleneckMarginDb: 7, reliability: 0.96, isFeasible: true, bottleneckLinkId: 'LINK-C' }),
    quality('ROUTE-3', 'DEMAND-01', { hopCount: 2, totalDistanceM: 55000, totalDelayMs: 70, bottleneckMarginDb: 6.5, reliability: 0.95, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-4', 'DEMAND-02', { hopCount: 1, totalDistanceM: 31200, totalDelayMs: 48, bottleneckMarginDb: 9.5, reliability: 0.96, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  constrained: details([
    quality('ROUTE-1', 'DEMAND-01', { hopCount: 1, totalDistanceM: 7900, totalDelayMs: 28, bottleneckMarginDb: 12, reliability: 0.97, isFeasible: true, bottleneckLinkId: 'LINK-A' }),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 2, totalDistanceM: 31700, totalDelayMs: 53, bottleneckMarginDb: 6, reliability: 0.95, isFeasible: true, bottleneckLinkId: 'LINK-C' }),
    quality('ROUTE-3', 'DEMAND-01', { hopCount: 2, totalDistanceM: 55000, totalDelayMs: 75, bottleneckMarginDb: 5, reliability: 0.94, isFeasible: false, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-4', 'DEMAND-02', { hopCount: 1, totalDistanceM: 31200, totalDelayMs: 51, bottleneckMarginDb: 8, reliability: 0.95, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'device-balanced': details([
    quality('ROUTE-1', 'DEMAND-01', { hopCount: 1, totalDistanceM: 7900, totalDelayMs: 20, bottleneckMarginDb: 18, reliability: 0.99, isFeasible: true, bottleneckLinkId: 'LINK-A' }),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 1, totalDistanceM: 31200, totalDelayMs: 32, bottleneckMarginDb: 14.5, reliability: 0.98, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
};

// 每个措施单独声明质量；未明确提供的路由保持 null，不继承措施前质量。
const variants: Record<string, PlanningResultDetails> = {
  'balanced:FREQ_ADJUST': details([
    quality('ROUTE-1', 'DEMAND-01'),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 1, totalDelayMs: 32, bottleneckMarginDb: 15.1, reliability: 0.985, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-3', 'DEMAND-01'), quality('ROUTE-4', 'DEMAND-02'),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 9000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'balanced:CHANNEL_SWITCH': details([
    quality('ROUTE-1', 'DEMAND-01'),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 1, totalDelayMs: 33, bottleneckMarginDb: 14.8, reliability: 0.982, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-3', 'DEMAND-01'), quality('ROUTE-4', 'DEMAND-02'),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8300), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'balanced:POWER_OPT': details([
    quality('ROUTE-1', 'DEMAND-01'),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 1, totalDelayMs: 30, bottleneckMarginDb: 18.4, reliability: 0.991, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-3', 'DEMAND-01'), quality('ROUTE-4', 'DEMAND-02'),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'balanced:ROUTE_REBUILD': details([
    quality('ROUTE-1', 'DEMAND-01'), quality('ROUTE-3', 'DEMAND-01'),
    quality('IF-ROUTE-B', 'DEMAND-02', { hopCount: 2, totalDelayMs: 44, bottleneckMarginDb: 12.4, reliability: 0.974, isFeasible: true, bottleneckLinkId: 'LINK-C' }),
    quality('IF-ROUTE-B-BACKUP', 'DEMAND-02'),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'balanced:NODE_REDEPLOY': details([
    quality('ROUTE-1', 'DEMAND-01'),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 1, totalDistanceM: 28700, totalDelayMs: 31, bottleneckMarginDb: 15.8, reliability: 0.987, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
    quality('ROUTE-3', 'DEMAND-01'), quality('ROUTE-4', 'DEMAND-02'),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'economical:FREQ_ADJUST': details([
    quality('ROUTE-1', 'DEMAND-01'), quality('ROUTE-2', 'DEMAND-02'), quality('ROUTE-3', 'DEMAND-01'),
    quality('ROUTE-4', 'DEMAND-02', { hopCount: 1, totalDelayMs: 43, bottleneckMarginDb: 10.1, reliability: 0.967, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 9000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'economical:CHANNEL_SWITCH': details([
    quality('ROUTE-1', 'DEMAND-01'), quality('ROUTE-2', 'DEMAND-02'), quality('ROUTE-3', 'DEMAND-01'),
    quality('ROUTE-4', 'DEMAND-02', { hopCount: 1, totalDelayMs: 44, bottleneckMarginDb: 9.8, reliability: 0.964, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8300), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'economical:POWER_OPT': details([
    quality('ROUTE-1', 'DEMAND-01'), quality('ROUTE-2', 'DEMAND-02'), quality('ROUTE-3', 'DEMAND-01'),
    quality('ROUTE-4', 'DEMAND-02', { hopCount: 1, totalDelayMs: 35, bottleneckMarginDb: 18.1, reliability: 0.988, isFeasible: true, bottleneckLinkId: 'LINK-B' }),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
  'economical:NODE_REDEPLOY': details([
    quality('ROUTE-1', 'DEMAND-01'),
    quality('ROUTE-2', 'DEMAND-02', { hopCount: 2, totalDistanceM: 29300, totalDelayMs: 40, bottleneckMarginDb: 9.1, reliability: 0.973, isFeasible: true, bottleneckLinkId: 'LINK-C' }),
    quality('ROUTE-3', 'DEMAND-01'), quality('ROUTE-4', 'DEMAND-02'),
  ], [assignment('ASSIGN-A', 'LINK-A', 6000), assignment('ASSIGN-B', 'LINK-B', 8000), assignment('ASSIGN-C', 'LINK-C', 10000)]),
};

export const planningResultDetailsCatalog = freeze({
  [PLANNING_RESULT_DETAILS_ASSET_VERSION]: { presets, variants },
});
