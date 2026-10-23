import type { MapRegion, PlanVersion } from './domain';

// 场景版本、运行记录和两段异步任务身份独立，快照不追随台账变化。
export type FaultType = 'HW_FAILURE' | 'LINK_DOWN' | 'SW_CONFIG' | 'EMI';
export type FaultObjectType = 'NODE' | 'DEVICE' | 'LINK';
export type ImpactLevel = 'SEVERE' | 'MODERATE' | 'MINOR';
export type DiagnosisDemo = 'normal' | 'low-confidence' | 'diagnosis-failed' | 'impact-failed';
export interface FaultInput {
  objectType: FaultObjectType;
  objectId: string;
  faultType: FaultType;
  symptomIds: string[];
  occurTime: string | null;
  interferenceId: string | null;
}
export interface DiagnosisDraft {
  name: string;
  description: string;
  planId: string;
  faults: FaultInput[];
}
export interface DiagnosisScenarioVersion extends DiagnosisDraft {
  id: string;
  scenarioId: string;
  version: number;
  savedAt: string;
  network: PlanVersion;
}
export interface DiagnosisScenario {
  id: string;
  archived: boolean;
  versions: DiagnosisScenarioVersion[];
}
export interface DiagnosisIssue { row?: number; field: string; objectId?: string; message: string }
export interface DiagnosisBranch {
  source: 'RULE' | 'KG' | 'ML';
  conclusion: string;
  confidence: number | null;
  weight: number | null;
  contribution: number | null;
  disabledReason: string | null;
  evidence: { label: string; value: string }[];
}
export interface DiagnosisConclusion {
  fault: FaultInput | null;
  label: string;
  faultType: string;
  confidence: number;
  rootCause: string;
  component: string | null;
  needManualReview: boolean | null;
  branches: DiagnosisBranch[];
  candidates: { faultType: string; confidence: number }[];
  chain: string[];
}
export interface DiagnosisImpactNode {
  nodeId: string;
  affectType: 'DIRECT' | 'INDIRECT' | null;
  level: ImpactLevel | null;
  state: 'INTERRUPTED' | 'DEGRADED' | 'NORMAL' | null;
  reason: string;
  detourRoute: string[];
}
export interface DiagnosisImpactLink {
  linkId: string;
  level: ImpactLevel | null;
  state: 'INTERRUPTED' | 'DEGRADED' | 'NORMAL' | null;
  faultKey: string | null;
  bandwidthLossKbps: number | null;
  isBackbone: boolean | null;
  reason: string;
}
export interface DiagnosisRegion extends MapRegion { level: ImpactLevel | null; faultKey: string | null }
export interface DiagnosisSuggestion {
  priority: number;
  action: string;
  applicability: string;
  steps: string[];
  spares: string[];
  tools: string[];
  estimatedTimeMin: number | null;
  tripleIds: string[];
  // 原接口 repair_time_min 为案例修复耗时，与建议预计时长独立；旧结果可缺省。
  similarCases: { id: string; solution: string; similarity: number | null; repairTimeMin?: number | null }[];
}
export interface DiagnosisResult {
  fusionMode: 'TWO_WAY_DEGRADED' | 'THREE_WAY';
  disabledReason: string;
  conclusions: DiagnosisConclusion[];
  nodes: DiagnosisImpactNode[];
  links: DiagnosisImpactLink[];
  regions: DiagnosisRegion[];
  summary: {
    affectedNodeCount: number; directCount: number; indirectCount: number;
    interruptedNodeCount: number; degradedNodeCount: number;
    affectedLinkCount: number; totalBandwidthLossKbps: number;
    affectedDemandIds: string[];
  } | null;
  suggestions: DiagnosisSuggestion[];
  notes: string[];
}
export interface DiagnosisPreset {
  id: string;
  label: string;
  // 普通规划和抗干扰变体各有独立匹配身份。
  networkPresetId: string;
  faults: FaultInput[];
  result: DiagnosisResult;
}
export interface DiagnosisRun {
  id: string;
  diagnoseTaskId: string;
  impactTaskId: string;
  scenario: DiagnosisScenarioVersion;
  presetId: string;
  presetVersion: string;
  demo: DiagnosisDemo;
  startedAt: number;
  cancelledAt: number | null;
  result: DiagnosisResult;
}
export interface DiagnosisSourceState {
  state: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN';
  reasons: string[];
}
export interface DiagnosisRecord {
  id: string;
  legacy: boolean;
  scenarioId: string;
  scenarioVersion: string;
  name: string;
  description: string;
  faults: FaultInput[];
  network: PlanVersion;
  startedAt: string | null;
  completedAt: string | null;
  diagnoseTaskId: string | null;
  impactTaskId: string | null;
  result: DiagnosisResult;
  source: DiagnosisSourceState;
}
export type DiagnosisRunState = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export interface DiagnosisRunView {
  run: DiagnosisRun;
  state: DiagnosisRunState;
  progress: number;
  phases: { name: string; state: 'waiting' | 'running' | 'done' }[];
  diagnosisReady: boolean;
  impactReady: boolean;
  error: string | null;
  source: DiagnosisSourceState;
  report: DiagnosisRecord | null;
}
export interface DiagnosisWorkspace {
  schemaVersion: number;
  presetVersion: string;
  revision: string;
  scenarios: DiagnosisScenario[];
  runs: DiagnosisRun[];
  receipts: { requestId: string; signature: string; entityIds: string[] }[];
}
export interface DiagnosisSources { plans: PlanVersion[]; error: string | null }
export interface DiagnosisLoaded {
  workspace: DiagnosisWorkspace | null;
  error: string | null;
  presets: DiagnosisPreset[];
  legacy: DiagnosisRecord[];
  sources: DiagnosisSources;
  symptoms: { id: string; label: string }[];
  interferenceIds: string[];
}
export interface DiagnosisImportPreview {
  fileName: string;
  drafts: DiagnosisDraft[];
  issues: DiagnosisIssue[];
  matches: boolean[];
}
export interface DiagnosisFile { name: string; mime: string; bytes: Uint8Array }
export type ReportFormat = 'docx' | 'pdf' | 'json';
export interface DiagnosisMutation { baseRevision: string; requestId: string }
export interface DiagnosisServices {
  loadDiagnosisWorkspace(): Promise<DiagnosisLoaded>;
  loadDiagnosisSources(): Promise<DiagnosisSources>;
  validateDiagnosisScenario(draft: DiagnosisDraft): Promise<DiagnosisIssue[]>;
  saveDiagnosisScenario(request: DiagnosisMutation & { scenarioId: string | null; draft: DiagnosisDraft }): Promise<DiagnosisWorkspace>;
  archiveDiagnosisScenario(request: DiagnosisMutation & { scenarioId: string; archived: boolean }): Promise<DiagnosisWorkspace>;
  getDiagnosisTemplate(format: 'csv' | 'xlsx', planId?: string): Promise<DiagnosisFile>;
  previewDiagnosisImport(file: { name: string; bytes: Uint8Array }, planId: string): Promise<DiagnosisImportPreview>;
  commitDiagnosisImport(request: DiagnosisMutation & { drafts: DiagnosisDraft[] }): Promise<DiagnosisWorkspace>;
  submitDiagnosis(request: DiagnosisMutation & { scenarioVersionId: string; demo: DiagnosisDemo }): Promise<{ workspace: DiagnosisWorkspace; view: DiagnosisRunView }>;
  getDiagnosisRun(id: string): Promise<DiagnosisRunView>;
  cancelDiagnosisRun(request: DiagnosisMutation & { runId: string }): Promise<{ workspace: DiagnosisWorkspace; view: DiagnosisRunView }>;
  getDiagnosisReport(id: string): Promise<DiagnosisRecord>;
  exportDiagnosisReport(id: string, format: ReportFormat): Promise<DiagnosisFile>;
  exportDiagnosisImpact(id: string, format: 'xlsx' | 'png', filters: string): Promise<DiagnosisFile>;
  resetDiagnosisWorkspace(baseRevision: string | null): Promise<DiagnosisLoaded>;
}
