import type { InterferenceSceneVersion, SceneJsonObject } from './interference-scene';

export const measureTypes = ['FREQ_ADJUST', 'CHANNEL_SWITCH', 'POWER_OPT', 'ROUTE_REBUILD', 'NODE_REDEPLOY'] as const;
export type MeasureType = typeof measureTypes[number];
export type WorkbenchState = 'PENDING' | 'RUNNING' | 'CANCEL_REQUESTED' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type Operation = 'SUBMIT_ANALYSIS' | 'CANCEL_ANALYSIS' | 'ADOPT_MEASURE' | 'CANCEL_ADOPTION';
export interface TaskContext { taskId: string; planId: string; planVersion: string }
export interface Capability { enabled: boolean; reasons: string[] }
export interface SourceState { state: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN'; reasons: string[] }
export interface InterferenceParameterIssue {
  interferenceId: string; name: string; field: string; code: string; message: string;
}
export interface InterferenceAnalysisParameters {
  interference_id: string; name: string;
  parameters: Record<string, number | string | boolean | null>;
  sources: Record<string, string>;
}
export interface SourceOption {
  task_id: string; plan_id: string; plan_version: string; input_version: string; condition_version: string;
  resource_revision: string; source: string; data_origin: string | null; name: string;
  plan_snapshot_id: string | null; current: boolean; eligible: boolean; unavailable_reasons: string[];
}
export interface WorkbenchContext {
  task_id: string | null; resource_revision: string | null; source_options: SourceOption[];
  scene_count: number; run_count: number; active_run_ids: string[]; data_origin: string | null;
  interference_sources: Record<string, string>[];
  capabilities: Record<'scene_save' | 'analyze' | 'cancel' | 'preview' | 'adopt_replan', Capability>;
}
export interface Page<T> { items: T[]; total: number; page: number; page_size: number }
export interface TaskQuery { task_id: string }
export interface PageQuery { task_id?: string; page?: number; page_size?: number; search?: string }
export interface RunSubmit {
  request_id: string; task_id: string; plan_id: string; plan_version: string; resource_revision: string;
  scene_id: string; scene_version_id: string; snapshot_hash: string;
}
export interface RunCancel extends TaskQuery { request_id: string; expected_run_version: number }
export interface AdoptionSubmit extends Omit<RunSubmit, 'scene_id'> {
  run_id: string; measure_id: string; expected_run_version: number;
}
export interface AdoptionCancel extends TaskQuery { request_id: string; expected_adoption_version: number }
export interface WriteReceipt {
  request_id: string; operation: Operation; actor_id: string; task_id: string; object_type: 'RUN' | 'ADOPTION';
  object_id: string; accepted_version: number; changed: boolean; status: 'ACCEPTED'; source_hash: string;
  data_origin: string; accepted_at: string; object_state?: WorkbenchState; adoption_id?: string;
  planning_request_id?: string; planning_job_id?: string | null; plan_id?: string | null;
}
export interface RunProgress {
  run_id: string; task_id: string; scene_id: string; scene_version_id: string; plan_id: string; plan_version: string;
  resource_revision: string; run_version: number; state: WorkbenchState; progress: number; phase: string;
  cancel_requested: boolean; error: string | null; source_hash: string; source_state: SourceState;
  data_origin: string; started_at: string; updated_at: string;
}
export interface ImpactObject extends SceneJsonObject {
  level: 'SEVERE' | 'MODERATE' | 'MINOR'; snr_before_db: number; sinr_after_db: number;
}
export interface Impact {
  affected_nodes: ImpactObject[]; affected_links: ImpactObject[];
  affected_area: SceneJsonObject;
  summary: { links: number; jammers: number; affected_nodes: number; affected_links: number;
    by_level: Record<'SEVERE' | 'MODERATE' | 'MINOR', number> };
}
export interface Measure {
  measure_id: string; type: MeasureType; target_node_id: string | null; target_link_id: string | null;
  priority: number; title: string; detail: string; risk: string; available: boolean; unavailable_reasons: string[];
  change_set: SceneJsonObject; preview_hash: string; pre_eval: SceneJsonObject | null; restores: boolean;
}
export interface AnalysisResult extends Impact {
  analysis_id: string; measures: Measure[]; unresolved: SceneJsonObject[]; measure_review: SceneJsonObject[];
  parameter_substitutions: (string | number | null)[][]; notes: string[];
}
export interface AdoptionDetail {
  adoption_id: string; task_id: string; run_id: string; measure_id: string; adoption_version: number;
  state: WorkbenchState; source_hash: string; source_state: SourceState; planning_request_id: string;
  planning_job_id: string | null; planning_state: string | null; planning_progress: number | null;
  result_plan_id: string | null; result_plan_state: 'SAVED' | 'REFERENCE' | 'CONFIRMED' | null; error: string | null;
  data_origin: string; created_at: string; updated_at: string;
}
export interface RunDetail extends RunProgress {
  source: InterferenceSceneVersion; result: AnalysisResult | null; result_hash: string | null;
  analysis_parameters?: InterferenceAnalysisParameters[] | null;
  adoptions: AdoptionDetail[]; adoption_capabilities: Record<MeasureType, Capability>;
}
export interface MeasurePreview {
  run_id: string; measure_id: string; run_version: number; source_hash: string; preview_hash: string;
  before_configuration: SceneJsonObject; proposed_changes: SceneJsonObject; impact_after: Impact | null;
  metrics: SceneJsonObject | null; available: boolean; unavailable_reasons: string[];
}
export interface MapProjection {
  taskId: string; planId: string; sceneVersionId: string; runId: string; sourceHash: string;
  phase: 'BEFORE' | 'PREVIEW'; nodes: SceneJsonObject[]; links: SceneJsonObject[];
  sources: Record<string, string>[]; impact: Impact;
}
export interface InterferenceWorkbenchServices {
  getContext(input: { task_id?: string }, signal?: AbortSignal): Promise<WorkbenchContext>;
  listSources(input: PageQuery, signal?: AbortSignal): Promise<Page<SourceOption>>;
  submitRun(input: RunSubmit): Promise<WriteReceipt>;
  listRuns(input: PageQuery & TaskQuery & { state?: WorkbenchState }, signal?: AbortSignal): Promise<Page<RunProgress & { adoption_count: number }>>;
  getProgress(input: TaskQuery & { run_id: string }, signal?: AbortSignal): Promise<RunProgress>;
  getRun(input: TaskQuery & { run_id: string }, signal?: AbortSignal): Promise<RunDetail>;
  getPreview(input: TaskQuery & { run_id: string; measure_id: string; expected_run_version: number }, signal?: AbortSignal): Promise<MeasurePreview>;
  cancelRun(input: RunCancel & { run_id: string }): Promise<WriteReceipt>;
  adoptMeasure(input: AdoptionSubmit): Promise<WriteReceipt>;
  getAdoption(input: TaskQuery & { adoption_id: string }, signal?: AbortSignal): Promise<AdoptionDetail>;
  cancelAdoption(input: AdoptionCancel & { adoption_id: string }): Promise<WriteReceipt>;
  getOperation(input: TaskQuery & { request_id: string; operation: Operation }, signal?: AbortSignal): Promise<WriteReceipt>;
}
