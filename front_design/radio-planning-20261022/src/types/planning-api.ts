import type { NetworkLink, Coordinate, PlanVersion, Device, DeviceClass, Availability } from './domain';
import type { InterferenceOrigin } from './interference';
import type { PlanningInput, PlanningCheck, PlanningConfiguration, PlanningIssue, PlanningJobState } from './planning';
import type { PlanningCoverage, CoverageRaster } from './coverage';
import type { ApiPage, ApiPageQuery, TaskApiOptions } from './task-api';
import type { ResourceFile } from './resource-edit';
import type { PlanningResultDetails } from './planning-result-details';
import type { PlanningAdjustment, PlanningAdjustmentExample } from './planning-adjustment';
import type { PlanningFrequencyResource } from './planning-options';

// 结果保留冻结输入；可空展示字段不静默补成正常、在架或零。
export interface ApiPlanningNode { id: string; name: string; coordinate: Coordinate; status: string | null; alert: boolean | null }
// 冻结设备复用同义身份和枚举，数值缺省仍按快照契约显式可空。
export interface ApiPlanningDevice extends Pick<Device, 'id' | 'stationId' | 'modelId'> {
  modelName: string; deviceClass: DeviceClass;
  availability: Availability | null; workFreqKhz: number | null; txPowerDbm: number | null;
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
  // 旧记录未冻结统一版本时明确为 null，不能把资源 epoch 或作业快照 ID 冒充它。
  id: string; taskId: string; revision: string; inputVersion: string | null; conditionVersion: string; resourceRevision: string | null;
  input: PlanningInput; parentPlanId: string | null; state: PlanningJobState; progress: number;
  phases: { name: string; state: 'waiting' | 'running' | 'done' }[];
  result: ApiPlanningResult | null; outcome: { code: number; message: string; suggestions: string[]; gap: PlanningIssue[] } | null;
  error: string | null; expired: boolean; sourceChanged: boolean; savedPlanId: string | null;
  // 独立方案调整不改写任务条件；档位身份仅供 Mock 使用。
  adjustment?: PlanningAdjustment; resultPresetId?: string;
}
// 转正产物由服务返回；旧响应缺省时不以规划结果补造正式配置。
export interface PlanningConfirmedConfiguration {
  sourcePlanId: string; sourcePlanVersion: string; sourceSnapshotId: string;
  confirmedAt: string; configuration: PlanningConfiguration;
}
export interface ApiPlan {
  confirmedConfiguration?: PlanningConfirmedConfiguration | null;
  solutionId?: string;
  solutionLabel?: string;
  radioCount?: number | null;
  // 干扰采纳没有规划作业，保留真实来源而不制造 jobId。
  interferenceOrigin?: InterferenceOrigin;
  id: string; taskId: string; jobId: string | null; revision: string; version: string; name: string; note: string;
  inputVersion: string | null; conditionVersion: string; resourceRevision: string | null; input: PlanningInput;
  parentPlanId: string | null; state: 'SAVED' | 'REFERENCE' | 'CONFIRMED'; sourceChanged: boolean;
  current: boolean; savedAt: string; confirmedAt: string | null; source: string;
  result: ApiPlanningResult; outcome: NonNullable<ApiPlanningJob['outcome']>;
  adjustment?: PlanningAdjustment; resultPresetId?: string;
}
export interface PlanningCatalog {
  workspaceRevision?: string;
  frequencyResources?: PlanningFrequencyResource[] | null;
  revision: string;
  presets: { id: string; label: string; description: string; defaults: PlanningInput }[];
  frequencies: { id: string; label: string; minKhz: number; maxKhz: number }[];
  adjustmentExamples?: PlanningAdjustmentExample[];
}
export interface PlanningApiMutation extends TaskApiOptions { requestId: string; taskId: string; revision: string }
export interface PlanningApiServices {
  loadPlanningOptions(input: TaskApiOptions): Promise<PlanningOptions>;
  loadPlanningReadContext(input: TaskApiOptions): Promise<{ revision: string }>;
  getPlanningPreset(input: TaskApiOptions & { presetId: string }): Promise<PlanningCatalog['presets'][number]>;
  getPlanningAdjustmentExamples(input: TaskApiOptions): Promise<PlanningAdjustmentExample[]>;
  getPlanningTaskProgress(input: TaskApiOptions & { jobId: string; taskId: string }): Promise<PlanningProgress>;
  queryPlanningPlanSummaries(input: ApiPageQuery & { taskId: string }): Promise<ApiPage<PlanningPlanSummary>>;
  queryPlanningReferenceSummaries(input: ApiPageQuery): Promise<ApiPage<PlanningReferenceSummary>>;
  submitPlanningReceipt(input: Parameters<PlanningApiServices['submitPlanningTask']>[0]): Promise<PlanningMutationReceipt>;
  cancelPlanningReceipt(input: Parameters<PlanningApiServices['cancelPlanningTask']>[0]): Promise<PlanningMutationReceipt>;
  savePlanningReceipt(input: Parameters<PlanningApiServices['savePlanningPlan']>[0]): Promise<PlanningMutationReceipt>;
  confirmPlanningReceipt(input: Parameters<PlanningApiServices['confirmPlanningPlan']>[0]): Promise<PlanningMutationReceipt>;
  resetPlanningReceipt(input: Parameters<PlanningApiServices['resetPlanningData']>[0]): Promise<{ revision: string; objectId: string; changed: boolean }>;
  queryPlanningJobs(input: ApiPageQuery): Promise<ApiPage<PlanningJobSummary>>;
  querySavedPlanningPlans(input: SavedPlanningPlansQuery): Promise<ApiPage<PlanningPlanSummary>>;
  queryPlanningReferences(input: ApiPageQuery): Promise<ApiPage<PlanVersion>>;
  getPlanningReference(input: TaskApiOptions & { planId: string; taskId: string }): Promise<PlanVersion>;
  comparePlanningReferences(input: TaskApiOptions & { planIds: string[] }): Promise<PlanVersion[]>;
  exportPlanningReference(input: TaskApiOptions & { planId: string; taskId: string; format: 'json' | 'xlsx' }): Promise<ResourceFile>;
  resetPlanningData(input: TaskApiOptions & { revision: string | null }): Promise<PlanningCatalog>;
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
// 目录、进度与单次完整快照分开；内部旧契约保留给持久化组合使用。
export interface PlanningOptions extends Omit<PlanningCatalog,'presets'|'adjustmentExamples'> { presets: Omit<PlanningCatalog['presets'][number],'defaults'>[] }
export type PlanningPlanSummary = Pick<ApiPlan,'id'|'taskId'|'name'|'version'|'state'|'current'|'sourceChanged'|'savedAt'>;
// 全局历史只读摘要，任务内完整方案接口仍保持原契约。
export type SavedPlanningPlansQuery = ApiPageQuery & { state?: ApiPlan['state'] };
export type PlanningReferenceSummary = Pick<PlanVersion,'id'|'taskId'|'name'|'version'|'state'|'sourceChanged'> & { originLabel: string };
export type PlanningProgress = Pick<ApiPlanningJob,'id'|'taskId'|'revision'|'state'|'progress'|'phases'|'error'|'expired'|'sourceChanged'|'savedPlanId'> & { resultKey: string; adjustmentKey: string | null };
export interface PlanningMutationReceipt {
  objectId: string; taskId: string; revision: string; changed: boolean;
  // 非成功业务码携带的有效参考结果必须保留，不能因拆回执丢失建议与缺口。
  referenceJob?: ApiPlanningJob;
}
// 历史列表只返回目录摘要，打开时再读该作业冻结快照。
export interface PlanningJobSummary {
  id: string; taskId: string; name: string; startedAt: string; state: PlanningJobState;
}
// 每项拥有完整快照与独立保存状态；过期未保存项不提供可用结果。
export interface ApiPlanningSolution {
  solutionId: string; label: string; radioCount: number | null;
  result: ApiPlanningResult | null; outcome: NonNullable<ApiPlanningJob['outcome']>; savedPlanId: string | null; expired: boolean;
}
