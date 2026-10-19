import type { InterferenceOrigin, InterferenceWorkspace } from './interference';
import type { PlanningCoverage } from './coverage';
import type { PlanningResultDetails } from './planning-result-details';
import type { Device, MapRegion, NetworkLink, PlanVersion, Station } from './domain';
import type { PlanningAdjustment, PlanningAdjustmentExample } from './planning-adjustment';
import type { DeploymentConstraints } from './deployment-constraints';
import type { PlanningDeploymentSolve, PlanningFrequencyConstraints, PlanningFrequencyResource } from './planning-options';

// 输入、异步任务、结果快照和保存版本使用不同身份。
export type RouteStrategy = 'SHORTEST_PATH' | 'MIN_DELAY' | 'MAX_RELIABILITY';
export interface PlanningDemand {
  id: string;
  // 未指定不代选服务默认；false 是明确不请求备份，不能当作缺失。
  routeStrategy?: RouteStrategy | null;
  needBackup?: boolean | null;
  // 缺失扩展字段按旧站点级输入读取，不回写历史。
  endpointMode?: 'station' | 'device';
  sourceDeviceId?: string | null;
  targetDeviceId?: string | null;
  preferredClass?: 'HF' | 'VUHF' | null;
  sourceId: string;
  targetId: string;
  service: '' | '话音' | '数据' | '短消息';
  priority: 'P1' | 'P2' | 'P3';
  mandatory: boolean;
  dataVolumeMb: number | null;
  requiredRateKbps: number | null;
  maxDelayMs: number | null;
  minReliability: number | null;
}
export interface PlanningInput {
  // 频率组与额外过滤分别保存；缺省历史不补当前默认值。
  frequencyConstraints?: PlanningFrequencyConstraints | null;
  deploymentSolve?: PlanningDeploymentSolve | null;
  // 可选扩展随任务冻结；历史缺省不从当前默认值补齐。
  deploymentConstraints?: DeploymentConstraints | null;
  startTime?: string | null;
  durationH?: number | null;
  name: string;
  description: string;
  bbox: number[];
  stationIds: string[];
  demands: PlanningDemand[];
  presetId: string;
  frequencyId: string;
  constraints: { connectivityPercent: number; maxRelayHops: number; survivabilityPercent: number };
}
export interface ResourceDependencies {
  task?: { id:string; conditionVersion:string };
  // 旧依赖缺失时表示初始干扰配置，读取不改写快照。
  interferenceVersion?: string;
  resourceEpoch: string;
  stationVersions: Record<string, string>;
  deviceVersions: Record<string, string>;
}
export interface PlanningIssue {
  objectId: string;
  field: string;
  message: string;
}
export interface PlanningCheck {
  id: 'connectivity' | 'survivability' | 'relay' | 'frequency';
  label: string;
  passed: boolean | null;
  detail: string;
}
export interface DeviceConfiguration {
  deviceId: string;
  stationId: string;
  frequencyKhz: number;
  txPowerDbm: number;
  antennaHeightM: number;
}
export interface PlanningRoute {
  id: string;
  demandId: string;
  nodeIds: string[];
  linkIds: string[];
  backup: boolean;
}
export interface PlanningConfiguration {
  deployment: { stationId: string; deviceIds: string[]; role: string; plannedCoordinate?: import('./domain').Coordinate }[];
  devices: DeviceConfiguration[];
  routes: PlanningRoute[];
  frequencies: { id: string; minKhz: number; maxKhz: number; allocatedKhz: number[] }[];
}
export interface PlanningResult {
  // 补充明细从属于冻结结果；旧快照缺省时不回填。
  resultDetails?: PlanningResultDetails;
  // 场强元数据随结果冻结；缺失表示历史快照未提供。
  coverage?: PlanningCoverage;
  snapshotId: string;
  inputSnapshot: { stations: Station[]; devices: Device[] };
  links: NetworkLink[];
  regions: MapRegion[];
  metrics: PlanVersion['metrics'];
  deploymentCost: number | null;
  costUnit: string;
  checks: PlanningCheck[];
  configuration: PlanningConfiguration;
  notes: string[];
}
export interface PlanningPreset {
  // 隐藏结果档位只供固定结果与调整匹配，不作为输入选项。
  hidden?: boolean;
  solutionPresetIds?: string[];
  radioCount?: number | null;
  id: string;
  label: string;
  scene: string;
  summary: string;
  source: string;
  input: PlanningInput;
  baseline: { stations: Station[]; devices: Device[] };
  outcome: { code: 0 | 3001 | 3002; message: string; suggestions: string[]; gap: PlanningIssue[] };
  executionError: string | null;
  result: Omit<PlanningResult, 'snapshotId' | 'inputSnapshot'> | null;
  frequency: { id: string; label: string; minKhz: number; maxKhz: number };
}
export type PlanningJobState = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export interface PlanningSolutionOrigin {
  solutionId: string; label: string; radioCount: number | null; resultPresetId: string;
}
export interface PlanningSolutionSnapshot extends PlanningSolutionOrigin {
  result: PlanningResult;
  outcome: PlanningPreset['outcome'];
}
export interface PlanningSolutionView {
  solutionId: string; label: string; radioCount: number | null;
  result: PlanningResult | null; outcome: PlanningPreset['outcome']; savedPlanId: string | null; expired: boolean;
}
export interface PlanningJob {
  solutions?: PlanningSolutionSnapshot[];
  defaultSolutionId?: string | null;
  // 仅用于单份结果的校验投影；原持久化Job不写此字段。
  solutionOrigin?: PlanningSolutionOrigin;
  // 调整请求及服务匹配的结果身份分别冻结，不改写任务输入档位。
  adjustment?: PlanningAdjustment;
  resultPresetId?: string;
  // 新任务提交时冻结，查询只读取本任务保存的版本。
  resultDetails?: PlanningResultDetails;
  // 提交时捕获，恢复任务时不从当前预设回填。
  coverage?: PlanningCoverage;
  id: string;
  requestId: string;
  taskId: string;
  inputVersion: string;
  snapshotId: string;
  presetVersion: string;
  input: PlanningInput;
  dependencies: ResourceDependencies;
  inputSnapshot: PlanningResult['inputSnapshot'];
  parentPlanVersionId: string | null;
  startedAt: number;
  cancelledAt: number | null;
}
export interface PlanningJobView {
  solutions?: PlanningSolutionView[];
  defaultSolutionId?: string | null;
  job: PlanningJob;
  state: PlanningJobState;
  progress: number;
  phases: { name: string; state: 'waiting' | 'running' | 'done' }[];
  result: PlanningResult | null;
  outcome: PlanningPreset['outcome'] | null;
  error: string | null;
  expired: boolean;
  sourceChanged: boolean;
}
export interface PlanWorkflow {
  solutionOrigin?: PlanningSolutionOrigin;
  adjustment?: PlanningAdjustment;
  resultPresetId?: string;
  // 只在干扰采纳方案中存在，旧规划版本保持原结构。
  interferenceOrigin?: InterferenceOrigin;
  input: PlanningInput;
  inputVersion: string;
  dependencies: ResourceDependencies;
  presetVersion: string;
  saveRequestId: string;
  savedAt: string;
  parentPlanVersionId: string | null;
  changeSummary: string;
  note: string;
  checks: PlanningCheck[];
  deploymentCost: number | null;
  costUnit: string;
  configuration: PlanningConfiguration;
  outcome: PlanningPreset['outcome'];
  confirmation: {
    requestId: string;
    confirmedAt: string;
    configuration: PlanningConfiguration;
  } | null;
}
export interface PlanningWorkspace {
  interference: InterferenceWorkspace;
  schemaVersion: number;
  presetVersion: string;
  revision: string;
  jobs: PlanningJob[];
  plans: PlanVersion[];
  currentConfirmedByTask: Record<string, string>;
}
export interface PlanningLoaded {
  frequencyResources?: PlanningFrequencyResource[] | null;
  workspace: PlanningWorkspace;
  presets: PlanningPreset[];
  adjustmentExamples?: PlanningAdjustmentExample[];
}
export interface PlanningSubmit {
  adjustment?: PlanningAdjustment;
  baseRevision: string;
  requestId: string;
  taskId: string | null;
  parentPlanVersionId: string | null;
  input: PlanningInput;
}
export interface PlanningMutation {
  baseRevision: string;
}
export interface PlanningSave extends PlanningMutation {
  solutionId?: string;
  snapshotId?: string;
  jobId: string;
  requestId: string;
  name: string;
  note: string;
}
export interface PlanningConfirm extends PlanningMutation {
  planId: string;
  requestId: string;
}
export interface PlanningServices {
  exportPlanVersion(request:{planId:string;format:'json'|'xlsx'}):Promise<import('./resource-edit').ResourceFile>;
  loadPlanningWorkspace(): Promise<PlanningLoaded>;
  submitPlanning(
    request: PlanningSubmit,
  ): Promise<{ workspace: PlanningWorkspace; view: PlanningJobView }>;
  getPlanningJob(jobId: string): Promise<PlanningJobView>;
  cancelPlanningJob(
    request: PlanningMutation & { jobId: string },
  ): Promise<{ workspace: PlanningWorkspace; view: PlanningJobView }>;
  savePlanVersion(
    request: PlanningSave,
  ): Promise<{ workspace: PlanningWorkspace; plan: PlanVersion }>;
  confirmPlanVersion(
    request: PlanningConfirm,
  ): Promise<{ workspace: PlanningWorkspace; plan: PlanVersion }>;
  comparePlanVersions(planIds: string[]): Promise<PlanVersion[]>;
  resetPlanningWorkspace(baseRevision: string | null): Promise<PlanningLoaded>;
}
