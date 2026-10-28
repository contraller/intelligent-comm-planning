import { ApiError } from './types';
import { readSceneDetail } from './interference-scene-validation';
import { measureTypes } from '../types/interference-workbench';
import type { AdoptionDetail, AnalysisResult, Capability, Impact, Measure, MeasurePreview, Page, RunDetail,
  RunProgress, SourceOption, SourceState, WorkbenchContext, WriteReceipt, InterferenceParameterIssue,
  InterferenceAnalysisParameters } from '../types/interference-workbench';

export const interferenceParameterLabels: Record<string, string> = { lon: '经度', lat: '纬度', elevation_m: '高程',
  antenna_height_m: '天线高度', center_freq_khz: '中心频率', bandwidth_khz: '带宽', tx_power_dbm: '发射功率',
  antenna_gain_dbi: '天线增益', interference_type: '干扰类型', pattern_type: '天线方向图', azimuth_deg: '方位角',
  duty_cycle: '占空比', active: '生效状态' };

// 与后端冻结规则一致：只检查副本；不把空串、布尔值或非法数转换为零。
export function interferenceParameterIssues(rows: Record<string, unknown>[]): InterferenceParameterIssue[] {
  const issues: InterferenceParameterIssue[] = [];
  const missing = (value: unknown) => value == null || typeof value === 'string' && !value.trim();
  for (const row of rows) {
    const interferenceId = String(row.interference_id ?? '未知ID'), name = String(row.name || interferenceId);
    const issue = (field: string, reason: string, code: string) => issues.push({ interferenceId, name, field, code,
      message: `干扰源『${name}』的${interferenceParameterLabels[field]}${reason}（ID=${interferenceId}，字段=${field}，代码=${code}）` });
    function number(field: string, low?: number, high?: number, positive = false, exclusiveHigh = false, optional = false) {
      const value = row[field];
      if (missing(value)) { if (!optional) issue(field, '缺失，请填写后保存资源并重新保存场景', 'MISSING_PARAMETER'); return; }
      const valid = typeof value === 'number' || typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim());
      const parsed = valid ? Number(value) : NaN;
      if (!Number.isFinite(parsed)) { issue(field, '无效，须为有限数值', 'INVALID_NUMBER'); return; }
      if (positive && parsed <= 0 || low !== undefined && parsed < low || high !== undefined && (exclusiveHigh ? parsed >= high : parsed > high)) {
        const bounds = positive ? '大于 0' : high === undefined ? `不小于 ${low}` : `${low} 至 ${exclusiveHigh ? '小于 ' : ''}${high}`;
        issue(field, `超出允许范围，须为${bounds}`, 'OUT_OF_RANGE');
      }
    }
    number('lon', -180, 180); number('lat', -90, 90); number('antenna_height_m', 0);
    number('center_freq_khz', undefined, undefined, true); number('bandwidth_khz', undefined, undefined, true);
    number('tx_power_dbm'); number('antenna_gain_dbi'); number('elevation_m', undefined, undefined, false, false, true);
    const pattern = missing(row.pattern_type) ? 'OMNI' : row.pattern_type;
    if (!['OMNI', 'DIRECTIONAL'].includes(pattern as string)) issue('pattern_type', '无效，须为 OMNI 或 DIRECTIONAL', 'INVALID_CHOICE');
    if (pattern === 'DIRECTIONAL') number('azimuth_deg', 0, 360, false, true);
    if (!missing(row.duty_cycle)) number('duty_cycle', 0, 1);
    if (!['NARROWBAND', 'BROADBAND', 'SWEEP', 'PULSE', 'NOISE'].includes(row.interference_type as string)) issue('interference_type', '无效，须选择已有干扰类型', 'INVALID_CHOICE');
    if (!['true', 'false'].includes(row.active as string)) issue('active', '无效，须明确为 true 或 false', 'INVALID_CHOICE');
  }
  return issues;
}

function readAnalysisParameters(value: unknown, source: RunDetail['source']): InterferenceAnalysisParameters[] | null {
  if (value == null) return null; // 历史运行没有新字段，保留其原始来源，不追补默认值。
  const rows = list(value).map(item => {
    const row = record(item); id(row.interference_id); text(row.name);
    const parameters = record(row.parameters), sources = record(row.sources);
    const fields = Object.keys(interferenceParameterLabels);
    ensure(Object.keys(parameters).length === fields.length && Object.keys(sources).length === fields.length);
    fields.forEach(field => { ensure(Object.hasOwn(parameters, field) && Object.hasOwn(sources, field)); text(sources[field]); });
    ['lon', 'lat', 'antenna_height_m', 'center_freq_khz', 'bandwidth_khz', 'tx_power_dbm', 'antenna_gain_dbi', 'duty_cycle'].forEach(field => finite(parameters[field]));
    nullable(parameters.elevation_m, finite); nullable(parameters.azimuth_deg, finite); bool(parameters.active);
    ensure(interferenceParameterIssues([{ ...parameters, active: String(parameters.active), interference_id: row.interference_id, name: row.name }]).length === 0);
    ensure(parameters.pattern_type === 'DIRECTIONAL' || parameters.azimuth_deg === null);
    return structuredClone(row) as unknown as InterferenceAnalysisParameters;
  });
  ensure(rows.length === source.interferenceIds.length && rows.every((row, index) => row.interference_id === source.interferenceIds[index]));
  return rows;
}

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
    analysis_parameters: readAnalysisParameters(row.analysis_parameters, source),
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
