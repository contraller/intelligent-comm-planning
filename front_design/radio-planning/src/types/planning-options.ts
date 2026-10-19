// 资源组、逐频点身份和求解参数分别保存；不在前端判定分配可行性。
export interface PlanningFrequencyFilter {
  deviceClass: 'HF' | 'VUHF';
  rangeKhz: [number, number] | null;
  excludeFreqIds: string[];
}
export interface PlanningFrequencyConstraints { filters: PlanningFrequencyFilter[] }
export interface PlanningDeploymentSolve {
  mode: 'MIN_COUNT' | 'FIXED_COUNT';
  fixedCount: number | null;
  solutionCount: number;
}
export interface PlanningFrequencyResource {
  freqId: string;
  deviceClass: 'HF' | 'VUHF';
  centerFreqKhz: number | null;
  bandwidthKhz: number | null;
  channelNo: number | null;
  isAvailable: boolean | null;
  occupiedBy: string | null;
  reuseMinDistanceM: number | null;
  adjacentGuardKhz: number | null;
  note: string | null;
}
