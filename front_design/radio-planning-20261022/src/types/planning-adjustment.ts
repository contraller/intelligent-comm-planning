import type { PlanningConfiguration, PlanningInput } from './planning';

// 人工覆盖独立于任务条件；缺省字段沿用父方案配置，0 是有效输入。
export interface PlanningDeviceOverride {
  deviceId: string;
  txPowerDbm?: number;
  antennaHeightM?: number;
}
export interface PlanningManualPath {
  demandId: string;
  nodePath: string[];
}
export interface PlanningAdjustment {
  schemaVersion: 1;
  sourcePlanId: string;
  sourceSnapshotId: string;
  manualOverrides: PlanningDeviceOverride[];
  manualPaths: PlanningManualPath[];
}
// 示例由服务提供，模板输入只用于把需求身份映射至父方案。
export interface PlanningAdjustmentExample {
  id: string;
  label: string;
  source: string;
  input: PlanningInput;
  manualOverrides: PlanningDeviceOverride[];
  manualPaths: PlanningManualPath[];
}
// 两种页面只需提供相同冻结身份，无须互相转换整个方案模型。
export interface PlanningAdjustmentContext {
  id: string;
  snapshotId: string;
  input: PlanningInput;
  configuration: PlanningConfiguration;
  nodeIds: string[];
}
