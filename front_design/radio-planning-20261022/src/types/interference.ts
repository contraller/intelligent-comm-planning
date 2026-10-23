import type { Coordinate, InterferenceSource, NetworkLink, PlanVersion } from './domain';
import type { PlanningResult, PlanningWorkspace, ResourceDependencies } from './planning';
import type { PlanningResultDetails } from './planning-result-details';
import type { PageQuery, PageResult, ReadRequest, SearchQuery } from './data-access';

export type InterferenceLevel = 'SEVERE' | 'MODERATE' | 'MINOR';
export type CountermeasureType = 'FREQ_ADJUST' | 'CHANNEL_SWITCH' | 'POWER_OPT' | 'ROUTE_REBUILD' | 'NODE_REDEPLOY';
export type InterferenceScenarioId = 'single' | 'multiple' | 'enhanced' | 'unaffected' | 'unavailable' | 'failed';
// 一个区域可含多个面，每个面的首环为外轮廓，其余为孔洞。
export interface InterferenceRegion {
  id: string;
  label: string;
  level: InterferenceLevel;
  interferenceIds: string[];
  polygons: Coordinate[][][];
}
export interface InterferenceImpact {
  nodes: { nodeId: string; level: InterferenceLevel; snrBeforeDb: number; snrAfterDb: number; deltaDb: number }[];
  links: { linkId: string; level: InterferenceLevel; snrBeforeDb: number; snrAfterDb: number; stateBefore: NetworkLink['state']; stateAfter: NetworkLink['state']; interferenceIds: string[] }[];
  regions: InterferenceRegion[];
  summary: { affectedNodeCount: number; affectedLinkCount: number; severeLinkCount: number };
}
export interface Countermeasure {
  id: string;
  type: CountermeasureType;
  targetNodeId: string | null;
  targetLinkId: string | null;
  priority: number;
  title: string;
  detail: string;
  risk: string;
  unavailableReason: string | null;
  variantId: string | null;
  snrAfterDb: number | null;
  after: InterferenceImpact | null;
}
export interface InterferenceResult {
  impact: InterferenceImpact;
  measures: Countermeasure[];
  notes: string[];
}
export interface InterferenceScenario {
  id: InterferenceScenarioId;
  label: string;
  sources: InterferenceSource[];
  instruction: string;
}
export interface InterferenceVariant {
  id: string;
  networkPresetId: string;
  type: CountermeasureType;
  label: string;
  result: Omit<PlanningResult, 'snapshotId' | 'inputSnapshot'>;
}
// 采纳来源与规划作业身份分开，诊断历史不依赖源分析记录仍存在。
export interface InterferenceOrigin {
  analysisId: string;
  measureId: string;
  sourcePlanId: string;
  scenarioId: InterferenceScenarioId;
  variantId: string;
  presetVersion: string;
  sources: InterferenceSource[];
}
export interface InterferenceRun {
  // 只冻结各有效措施的补充明细，完整预览仍在查询时组装。
  measureResultDetails?: { measureId: string; resultDetails: PlanningResultDetails }[];
  jobId: string;
  analysisId: string;
  requestId: string;
  presetVersion: string;
  scenarioId: InterferenceScenarioId;
  network: PlanVersion;
  sources: InterferenceSource[];
  dependencies: ResourceDependencies;
  startedAt: number;
  cancelledAt: number | null;
  result: InterferenceResult;
}
export interface InterferenceReceipt {
  requestId: string;
  analysisId: string;
  measureId: string;
  planId: string;
}
export interface InterferenceWorkspace {
  runs: InterferenceRun[];
  receipts: InterferenceReceipt[];
}
export interface InterferenceSourceState {
  state: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN';
  reasons: string[];
}
// 完整预览只随查询视图返回，不进入分析持久化或伪造规划快照身份。
export interface InterferenceMeasurePreview {
  readonly measureId: string;
  readonly result: Omit<PlanningResult, 'snapshotId'> | null;
  readonly unavailableReason: string | null;
}
export interface InterferenceRunView {
  run: InterferenceRun;
  state: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  progress: number;
  phase: string;
  result: InterferenceResult | null;
  readonly measurePreviews?: readonly InterferenceMeasurePreview[];
  error: string | null;
  source: InterferenceSourceState;
  adoptions: { measureId: string; planId: string }[];
}
export interface InterferenceSources {
  plans: { plan: PlanVersion; eligible: boolean; reason: string; interferenceOnly: boolean }[];
  sources: InterferenceSource[];
  resourceRevision: string | null;
  error: string | null;
}
export interface InterferenceLoaded {
  workspace: PlanningWorkspace;
  sources: InterferenceSources;
  scenarios: InterferenceScenario[];
  views: InterferenceRunView[];
}
export interface InterferenceSubmit {
  baseRevision: string;
  baseResourceRevision: string;
  requestId: string;
  planId: string;
  scenarioId: InterferenceScenarioId;
  interferenceIds: string[];
}
export interface InterferenceAdopt {
  baseRevision: string;
  requestId: string;
  analysisId: string;
  measureId: string;
}
export interface InterferenceServices {
  loadInterferenceContext(input?: ReadRequest): Promise<InterferenceReadContext>;
  queryInterferenceHistory(input: PageQuery & ReadRequest & SearchQuery): Promise<PageResult<InterferenceHistoryItem>>;
  getInterferenceProgress(input: ReadRequest & { analysisId: string }): Promise<InterferenceProgress>;
  getInterferenceDetail(input: ReadRequest & { analysisId: string }): Promise<InterferenceReadView>;
  getInterferenceMeasurePreview(input: ReadRequest & { analysisId: string; measureId: string }): Promise<InterferenceMeasurePreview & { impact: InterferenceImpact | null }>;
  submitInterferenceReceipt(request: InterferenceSubmit): Promise<InterferenceMutationReceipt>;
  cancelInterferenceReceipt(request: { baseRevision: string; analysisId: string }): Promise<InterferenceMutationReceipt>;
  adoptInterferenceReceipt(request: InterferenceAdopt): Promise<InterferenceMutationReceipt & { planId: string; taskId: string; version: string }>;
  loadInterferenceWorkspace(): Promise<InterferenceLoaded>;
  loadInterferenceSources(): Promise<InterferenceSources>;
  submitInterferenceAnalysis(request: InterferenceSubmit): Promise<{ workspace: PlanningWorkspace; view: InterferenceRunView }>;
  getInterferenceAnalysis(analysisId: string): Promise<InterferenceRunView>;
  cancelInterferenceAnalysis(request: { baseRevision: string; analysisId: string }): Promise<{ workspace: PlanningWorkspace; view: InterferenceRunView }>;
  adoptInterferenceMeasure(request: InterferenceAdopt): Promise<{ workspace: PlanningWorkspace; plan: PlanVersion; changed: boolean }>;
}
export interface InterferenceReadSources extends Omit<InterferenceSources,'plans'> {
  plans: { plan: Pick<PlanVersion,'id'|'taskId'|'name'|'version'|'state'|'sourceChanged'>; eligible:boolean; reason:string; interferenceOnly:boolean }[];
}
export interface InterferenceReadContext { revision:string; sources:InterferenceReadSources; scenarios:Omit<InterferenceScenario,'sources'>[]; latestId:string|null; activeIds:string[]; total:number }
export type InterferenceProgress=Pick<InterferenceRunView,'state'|'progress'|'phase'|'error'|'source'|'adoptions'> & { analysisId:string; revision:string };
export interface InterferenceReadView extends Omit<InterferenceRunView,'run'> { run:Omit<InterferenceRun,'result'|'measureResultDetails'> }
export interface InterferenceHistoryItem { id:string; taskId:string; name:string; version:string; startedAt:number; state:InterferenceRunView['state']; source:InterferenceSourceState; sourceIds:string[]; adoptionCount:number }
export interface InterferenceMutationReceipt { objectId:string; revision:string; changed:boolean }
