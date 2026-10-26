import { ApiError } from './types';
import { readSceneDetail } from './interference-scene-validation';
import { measureTypes } from '../types/interference-workbench';
import type { AdoptionDetail, AnalysisResult, Capability, Impact, Measure, MeasurePreview, Page, RunDetail,
  RunProgress, SourceOption, SourceState, WorkbenchContext, WriteReceipt } from '../types/interference-workbench';

export function ensure(value: unknown): asserts value { if (!value) throw new ApiError('干扰工作流响应不符合冻结契约', 'INVALID_RESPONSE'); }
export function record(value: unknown): Record<string, unknown> { ensure(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; }
function text(value: unknown): asserts value is string { ensure(typeof value === 'string'); }
export function id(value: unknown): asserts value is string { text(value); ensure(value.length > 0 && value.length <= 120 && !/\s|[\u0000-\u001f\u007f]/u.test(value)); }
function hash(value: unknown) { text(value); ensure(/^[a-f0-9]{64}$/.test(value)); }
function integer(value: unknown, min = 0) { ensure(Number.isSafeInteger(value) && (value as number) >= min); }
function finite(value: unknown) { ensure(typeof value === 'number' && Number.isFinite(value)); }
function bool(value: unknown) { ensure(typeof value === 'boolean'); }
function list(value: unknown): unknown[] { ensure(Array.isArray(value)); return value; }
function strings(value: unknown) { list(value).forEach(text); }
function nullable(value: unknown, validate: (value: unknown) => void) { if (value !== null) validate(value); }
function timestamp(value: unknown) { text(value); ensure(/Z$/.test(value) && Number.isFinite(Date.parse(value))); }
export function state(value: unknown) { ensure(['PENDING', 'RUNNING', 'CANCEL_REQUESTED', 'SUCCESS', 'FAILED', 'CANCELLED'].includes(value as string)); }
function sourceState(value: unknown): SourceState { const row = record(value); ensure(['CURRENT', 'HISTORICAL', 'UNKNOWN'].includes(row.state as string)); strings(row.reasons); return structuredClone(row) as unknown as SourceState; }
function capability(value: unknown): Capability { const row = record(value); bool(row.enabled); strings(row.reasons); ensure(row.enabled || (row.reasons as unknown[]).length > 0); return row as unknown as Capability; }
function json(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { finite(value); return; }
  if (Array.isArray(value)) { value.forEach(json); return; }
  Object.values(record(value)).forEach(json);
}
function unique<T>(items: T[], key: (item: T) => unknown) { ensure(new Set(items.map(key)).size === items.length); }
export function readSource(value: unknown): SourceOption {
  const row = record(value);
  ['task_id', 'plan_id', 'input_version', 'condition_version', 'resource_revision', 'source'].forEach(key => id(row[key]));
  text(row.plan_version); ensure(/^V[1-9][0-9]*$/.test(row.plan_version)); text(row.name);
  nullable(row.plan_snapshot_id, id); nullable(row.data_origin, text); bool(row.current); bool(row.eligible); strings(row.unavailable_reasons);
  return structuredClone(row) as unknown as SourceOption;
}
export function readContext(value: unknown, taskId?: string): WorkbenchContext {
  const row = record(value); ensure(row.task_id === (taskId ?? null)); nullable(row.resource_revision, id); nullable(row.data_origin, text);
  list(row.source_options).forEach(item => { const source = readSource(item); if (taskId) ensure(source.task_id === taskId); });
  integer(row.scene_count); integer(row.run_count); list(row.active_run_ids).forEach(id);
  const capabilities = record(row.capabilities); ['scene_save', 'analyze', 'cancel', 'preview', 'adopt_replan'].forEach(key => capability(capabilities[key]));
  list(row.interference_sources).forEach(item => { const source = record(item); id(source.interference_id); Object.values(source).forEach(text); });
  unique(row.interference_sources as Record<string, unknown>[], item => item.interference_id);
  return structuredClone(row) as unknown as WorkbenchContext;
}
export function readProgress(value: unknown, expected: { task_id: string; run_id?: string }): RunProgress {
  const row = record(value);
  ['run_id', 'task_id', 'scene_id', 'scene_version_id', 'plan_id', 'resource_revision', 'data_origin'].forEach(key => id(row[key]));
  ensure(row.task_id === expected.task_id && (!expected.run_id || row.run_id === expected.run_id));
  text(row.plan_version); ensure(/^V[1-9][0-9]*$/.test(row.plan_version)); integer(row.run_version, 1); state(row.state);
  integer(row.progress); ensure((row.progress as number) <= 100 && (row.state !== 'SUCCESS' || row.progress === 100));
  text(row.phase); bool(row.cancel_requested); ensure(row.cancel_requested === (row.state === 'CANCEL_REQUESTED'));
  nullable(row.error, text); hash(row.source_hash); sourceState(row.source_state); timestamp(row.started_at); timestamp(row.updated_at);
  return structuredClone(row) as unknown as RunProgress;
}
function impact(value: unknown): Impact {
  const row = record(value); json(row); const summary = record(row.summary);
  ['links', 'jammers', 'affected_nodes', 'affected_links'].forEach(key => integer(summary[key]));
  const levels = record(summary.by_level); ['SEVERE', 'MODERATE', 'MINOR'].forEach(key => integer(levels[key]));
  ensure((levels.SEVERE as number) + (levels.MODERATE as number) + (levels.MINOR as number) === summary.affected_links);
  const area = record(row.affected_area); ensure(area.type === 'FeatureCollection'); list(area.features).forEach(json);
  for (const [key, identity] of [['affected_nodes', 'node_id'], ['affected_links', 'link_id']] as const) {
    list(row[key]).forEach(value => { const item = record(value); id(item[identity]); ensure(['SEVERE', 'MODERATE', 'MINOR'].includes(item.level as string)); finite(item.snr_before_db); finite(item.sinr_after_db); });
    unique(row[key] as Record<string, unknown>[], item => item[identity]);
  }
  ensure(summary.affected_nodes === (row.affected_nodes as unknown[]).length && summary.affected_links === (row.affected_links as unknown[]).length);
  return structuredClone(row) as unknown as Impact;
}
function measure(value: unknown): Measure {
  const row = record(value); id(row.measure_id); ensure(measureTypes.includes(row.type as typeof measureTypes[number]));
  nullable(row.target_node_id, id); nullable(row.target_link_id, id); integer(row.priority, 1);
  ['title', 'detail', 'risk'].forEach(key => text(row[key])); bool(row.available); strings(row.unavailable_reasons);
  const change = record(row.change_set); json(change); ensure(change.type === row.type); record(change.target); record(change.detail);
  hash(row.preview_hash); nullable(row.pre_eval, value => json(record(value))); bool(row.restores);
  return row as unknown as Measure;
}
export function readAdoption(value: unknown, expected: { task_id: string; adoption_id?: string }): AdoptionDetail {
  const row = record(value); ['adoption_id', 'task_id', 'run_id', 'measure_id', 'planning_request_id', 'data_origin'].forEach(key => id(row[key]));
  ensure(row.task_id === expected.task_id && (!expected.adoption_id || row.adoption_id === expected.adoption_id));
  integer(row.adoption_version, 1); state(row.state); hash(row.source_hash); sourceState(row.source_state);
  nullable(row.planning_job_id, id); nullable(row.planning_state, state); nullable(row.planning_progress, finite);
  ensure(row.planning_progress === null || (row.planning_progress as number) >= 0 && (row.planning_progress as number) <= 100);
  nullable(row.result_plan_id, id); ensure([null, 'SAVED', 'REFERENCE', 'CONFIRMED'].includes(row.result_plan_state as string | null));
  ensure((row.result_plan_id === null) === (row.result_plan_state === null));
  ensure(row.state !== 'SUCCESS' || row.result_plan_id !== null && row.planning_job_id !== null && row.planning_state === 'SUCCESS');
  nullable(row.error, text); timestamp(row.created_at); timestamp(row.updated_at);
  return structuredClone(row) as unknown as AdoptionDetail;
}
export function readRun(value: unknown, expected: { task_id: string; run_id: string }): RunDetail {
  const row = record(value), progress = readProgress(row, expected);
  const source = readSceneDetail({ version: row.source, source_state: row.source_state }, {
    taskId: expected.task_id, sceneId: progress.scene_id, versionId: progress.scene_version_id,
  }).version;
  ensure(source.planId === progress.plan_id && source.planVersion === progress.plan_version && source.resourceRevision === progress.resource_revision);
  nullable(row.result_hash, hash); let result: AnalysisResult | null = null;
  if (row.result !== null) {
    const output = record(row.result); impact(output); ensure(output.analysis_id === progress.run_id && progress.state === 'SUCCESS');
    list(output.measures).forEach(measure); unique(output.measures as Measure[], item => item.measure_id);
    list(output.unresolved).forEach(json); list(output.measure_review).forEach(json); strings(output.notes); list(output.parameter_substitutions).forEach(item => list(item).forEach(json));
    const detail = record(source.planSnapshot.rawSnapshot.detail), nodes = list(detail.nodes).map(item => record(item).node_id), links = list(detail.links).map(item => record(item).link_id);
    (output.affected_nodes as Record<string, unknown>[]).forEach(item => ensure(nodes.includes(item.node_id)));
    (output.affected_links as Record<string, unknown>[]).forEach(item => ensure(links.includes(item.link_id)));
    (output.measures as Measure[]).forEach(item => { if (item.target_node_id) ensure(nodes.includes(item.target_node_id)); if (item.target_link_id) ensure(links.includes(item.target_link_id)); });
    result = structuredClone(output) as unknown as AnalysisResult;
  }
  ensure((progress.state === 'SUCCESS') === (result !== null) && (result !== null) === (row.result_hash !== null));
  const adoptions = list(row.adoptions).map(item => readAdoption(item, expected));
  adoptions.forEach(item => ensure(item.run_id === progress.run_id && item.source_hash === progress.source_hash && result?.measures.some(m => m.measure_id === item.measure_id)));
  const caps = record(row.adoption_capabilities); measureTypes.forEach(key => capability(caps[key]));
  return { ...progress, source, result, result_hash: row.result_hash as string | null, adoptions,
    adoption_capabilities: structuredClone(caps) as RunDetail['adoption_capabilities'] };
}
export function readPreview(value: unknown, expected: { run_id: string; measure_id: string; expected_run_version: number }): MeasurePreview {
  const row = record(value); ensure(row.run_id === expected.run_id && row.measure_id === expected.measure_id && row.run_version === expected.expected_run_version);
  hash(row.source_hash); hash(row.preview_hash); json(record(row.before_configuration)); json(record(row.proposed_changes));
  nullable(row.impact_after, impact); nullable(row.metrics, value => json(record(value))); bool(row.available); strings(row.unavailable_reasons);
  return structuredClone(row) as unknown as MeasurePreview;
}
export function readReceipt(value: unknown, expected: { request_id: string; task_id: string; operation: string; object_id?: string }): WriteReceipt {
  const row = record(value); ensure(row.request_id === expected.request_id && row.task_id === expected.task_id && row.operation === expected.operation);
  id(row.actor_id); id(row.object_id); ensure(!expected.object_id || row.object_id === expected.object_id); integer(row.accepted_version, 1);
  ensure(row.object_type === (['SUBMIT_ANALYSIS', 'CANCEL_ANALYSIS'].includes(expected.operation) ? 'RUN' : 'ADOPTION'));
  bool(row.changed); ensure(row.status === 'ACCEPTED'); hash(row.source_hash); id(row.data_origin); timestamp(row.accepted_at);
  if (expected.operation === 'ADOPT_MEASURE') { ensure(row.adoption_id === row.object_id); id(row.planning_request_id); nullable(row.planning_job_id, id); nullable(row.plan_id, id); }
  if (expected.operation.startsWith('CANCEL')) state(row.object_state);
  return structuredClone(row) as unknown as WriteReceipt;
}
export function readPage<T>(value: unknown, expected: { page?: number; page_size?: number }, read: (value: unknown) => T): Page<T> {
  const row = record(value); integer(row.total); integer(row.page, 1); integer(row.page_size, 1);
  ensure(row.page === (expected.page ?? 1) && row.page_size === (expected.page_size ?? 20));
  const items = list(row.items).map(read), total = row.total as number, page = row.page as number, size = row.page_size as number;
  const identities = items.map(item => { const value = record(item); return value.run_id ?? value.plan_id; });
  ensure(identities.every(value => typeof value === 'string') && new Set(identities).size === identities.length);
  ensure(items.length === Math.min(size, Math.max(0, total - (page - 1) * size)));
  return { items, total, page, page_size: size };
}
