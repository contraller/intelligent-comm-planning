import type { PlanningCandidateScreening } from './planning-candidates';

// 优化结论直接读取服务；曲线点不是完整可保存的方案。
export interface PlanningOptimization {
  sourceLabel: string;
  tradeoff: { id: string; survivabilityPercent: number | null; totalRadiatedPowerW: number | null; meetsConstraints: boolean | null; description: string | null }[] | null;
  criticalBridges: { linkId: string; affectedDemandIds: string[]; survivabilityAfterFailurePercent: number | null; explanation: string | null }[] | null;
}

// 可选补充明细独立于核心配置；null 表示未提供，空数组表示明确没有记录。
export interface PlanningDeviceParameters {
  deviceId: string;
  tiltDeg: number | null;
  tiltEffective: boolean | null;
}
export interface PlanningRouteQuality {
  routeId: string;
  demandId: string;
  hopCount: number | null;
  totalDistanceM: number | null;
  totalDelayMs: number | null;
  bottleneckMarginDb: number | null;
  reliability: number | null;
  isFeasible: boolean | null;
  bottleneckLinkId: string | null;
}
export interface PlanningFrequencyAssignment {
  id: string;
  linkId: string;
  resourceGroupId: string | null;
  freqId: string | null;
  reuseGroup: number | null;
  frequencyKhz: number;
  bandwidthKhz: number | null;
}
export interface PlanningFrequencyConflict {
  id: string;
  type: string;
  linkIds: string[];
  frequencyKhz: number | null;
  distanceM: number | null;
  requiredDistanceM: number | null;
  severity: string | null;
}
export interface PlanningResultDetails {
  optimization?: PlanningOptimization | null;
  // 老版本缺省不回填；候选只属于当前冻结结果，不写入资源台账。
  candidateScreening?: PlanningCandidateScreening | null;
  schemaVersion: 1;
  assetVersion: string;
  deviceParameters: PlanningDeviceParameters[] | null;
  routeQuality: PlanningRouteQuality[] | null;
  frequencyAssignments: PlanningFrequencyAssignment[] | null;
  frequencyConflicts: PlanningFrequencyConflict[] | null;
  frequencyGap: { requiredChannels: number | null; availableChannels: number | null; shortage: number | null } | null;
  conflictFree: boolean | null;
  unreachableDemandIds: string[] | null;
}

// 只接受冻结身份及声明关系，HTTP 无需转换成 Mock 的完整站点或设备对象。
export interface PlanningResultDetailsContext {
  nodes: readonly { id: string }[];
  devices: readonly { id: string; stationId: string }[];
  links: readonly { id: string; a: string; b: string; deviceA: string; deviceB: string; frequencyKhz: number }[];
  configuration: {
    devices: readonly { deviceId: string; stationId: string }[];
    routes: readonly { id: string; demandId: string; linkIds: readonly string[] }[];
    frequencies: readonly { id: string; allocatedKhz: readonly number[] }[];
  };
  demandIds: readonly string[];
}
