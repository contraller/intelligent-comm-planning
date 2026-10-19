import type { NetworkLink, Coordinate } from './domain';
import type { PlanningInput, PlanningCheck, PlanningConfiguration, PlanningIssue, PlanningJobState } from './planning';
import type { PlanningCoverage, CoverageRaster } from './coverage';
import type { ApiPage, ApiPageQuery, TaskApiOptions } from './task-api';
import type { ResourceFile } from './resource-edit';
import type { PlanningResultDetails } from './planning-result-details';
import type { PlanningAdjustment, PlanningAdjustmentExample } from './planning-adjustment';
import type { PlanningFrequencyResource } from './planning-options';

// 结果保留冻结输入；可空展示字段不静默补成正常、在架或零。
export interface ApiPlanningNode { id: string; name: string; coordinate: Coordinate; status: string | null; alert: boolean | null }
export interface ApiPlanningDevice {
  id: string; stationId: string; modelId: string; modelName: string; deviceClass: 'HF' | 'VUHF';
  availability: 'ACTIVE' | 'OFF_SHELF' | null; workFreqKhz: number | null; txPowerDbm: number | null;
  antennaHeightM: number | null; tiltDeg: number | null; azimuthDeg: number | null;
}
export interface ApiPlanningResult {
  snapshotId: string; nodes: ApiPlanningNode[]; devices: ApiPlanningDevice[]; links: NetworkLink[];
  coverage: PlanningCoverage; configuration: PlanningConfiguration;
  metrics: { connectivityPercent: number | null; totalRadiatedPowerW: number | null; survivabilityPercent: number | null; coveragePercent: number | null; delayMs: number | null };
  deploymentCost: number | null; costUnit: string; checks: PlanningCheck[]; notes: string[];
  // 补充明细属于当前冻结结果；旧响应可以完全省略。
  resultDetails?: PlanningResultDetails;
}
export interface ApiPlanningJob {
  solutions?: ApiPlanningSolution[];
  defaultSolutionId?: string | null;
  id: string; taskId: string; revision: string; inputVersion: string; conditionVersion: string; resourceRevision: string;
  input: PlanningInput; parentPlanId: string | null; state: PlanningJobState; progress: number;
  phases: { name: string; state: 'waiting' | 'running' | 'done' }[];
  result: ApiPlanningResult | null; outcome: { code: number; message: string; suggestions: string[]; gap: PlanningIssue[] } | null;
  error: string | null; expired: boolean; sourceChanged: boolean; savedPlanId: string | null;
  // 独立方案调整不改写任务条件；档位身份仅供 Mock 使用。
  adjustment?: PlanningAdjustment; resultPresetId?: string;
}
export interface ApiPlan {
  solutionId?: string;
  solutionLabel?: string;
  radioCount?: number | null;
  id: string; taskId: string; jobId: string; revision: string; version: string; name: string; note: string;
  inputVersion: string; conditionVersion: string; resourceRevision: string; input: PlanningInput;
  parentPlanId: string | null; state: 'SAVED' | 'REFERENCE' | 'CONFIRMED'; sourceChanged: boolean;
  current: boolean; savedAt: string; confirmedAt: string | null; source: string;
  result: ApiPlanningResult; outcome: NonNullable<ApiPlanningJob['outcome']>;
  adjustment?: PlanningAdjustment; resultPresetId?: string;
}
export interface PlanningCatalog {
  frequencyResources?: PlanningFrequencyResource[] | null;
  revision: string;
  presets: { id: string; label: string; description: string; defaults: PlanningInput }[];
  frequencies: { id: string; label: string; minKhz: number; maxKhz: number }[];
  adjustmentExamples?: PlanningAdjustmentExample[];
}
export interface PlanningApiMutation extends TaskApiOptions { requestId: string; taskId: string; revision: string }
export interface PlanningApiServices {
  loadPlanningCatalog(input: TaskApiOptions): Promise<PlanningCatalog>;
  submitPlanningTask(input: PlanningApiMutation & { inputVersion: string; conditionVersion: string; resourceRevision: string; parentPlanId: string | null; adjustment?: PlanningAdjustment }): Promise<ApiPlanningJob>;
  getPlanningTask(input: TaskApiOptions & { jobId: string; taskId: string }): Promise<ApiPlanningJob>;
  cancelPlanningTask(input: PlanningApiMutation & { jobId: string }): Promise<ApiPlanningJob>;
  queryPlanningPlans(input: ApiPageQuery & { taskId: string }): Promise<ApiPage<ApiPlan>>;
  getPlanningPlan(input: TaskApiOptions & { planId: string; taskId: string }): Promise<ApiPlan>;
  savePlanningPlan(input: PlanningApiMutation & { jobId: string; name: string; note: string; solutionId?: string; snapshotId?: string }): Promise<ApiPlan>;
  confirmPlanningPlan(input: PlanningApiMutation & { planId: string }): Promise<ApiPlan>;
  comparePlanningPlans(input: TaskApiOptions & { taskId: string; planIds: string[] }): Promise<ApiPlan[]>;
  exportPlanningPlan(input: TaskApiOptions & { planId: string; taskId: string; format: 'json' | 'xlsx' }): Promise<ResourceFile>;
  getPlanningCoverageImage(input: TaskApiOptions & { snapshotId: string; raster: CoverageRaster }): Promise<Blob>;
}
// 每项拥有完整快照与独立保存状态；过期未保存项不提供可用结果。
export interface ApiPlanningSolution {
  solutionId: string; label: string; radioCount: number | null;
  result: ApiPlanningResult | null; outcome: NonNullable<ApiPlanningJob['outcome']>; savedPlanId: string | null; expired: boolean;
}
