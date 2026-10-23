import { ApiError } from './types';
import { statusObject, statusId, statusTime } from './device-status-decode';
import { deviceTraceSchema as schema, type TraceSummary, type TracePage, type TraceDetail, type TraceQuery, type TraceDetailQuery, type RestoreInput, type RestoreProposal } from '../types/device-trace';
const bad = (): never => { throw new ApiError('设备追溯响应不符合契约', 'INVALID_DEVICE_TRACE_RESPONSE'); };
const invalid = (): never => { throw new ApiError('设备追溯请求无效', 'VALIDATION_ERROR'); };
const summaryKeys = ['request_id', 'device_id', 'kind', 'base_revision', 'revision', 'created_at', 'actor_id', 'changed', 'changed_fields', 'data_origin'];
const fields = ['tx_power_dbm', 'work_freq_khz', 'antenna_height_m'];
const revision = (value: unknown) => typeof value === 'string' && /^resource-[0-9a-f]{16}$/.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const requestId = (v: unknown) => statusId(v) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v) && !['context', 'validate', 'history'].includes(v);
function strings(v: unknown): v is string[] { return Array.isArray(v) && v.every(s => typeof s === 'string' && !!s.trim()) && new Set(v).size === v.length; }
export function validateTraceQuery(value: unknown, detail = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>, required = ['context', 'device_id', 'resource_revision', ...(detail ? ['request_id'] : [])];
  if (required.some(k => !Object.hasOwn(row, k)) || Object.keys(row).some(k => ![...required, ...(detail ? [] : ['page', 'page_size'])].includes(k))
    || row.context !== 'ledger' || !statusId(row.device_id) || !statusId(row.resource_revision) || detail && !requestId(row.request_id)) invalid();
  for (const key of ['page', 'page_size']) if (key in row && (!Number.isSafeInteger(row[key]) || (row[key] as number) < 1 || (row[key] as number) > (key === 'page' ? 9999999999 : 100))) invalid();
}
export function validateRestoreInput(deviceId: string, value: unknown): asserts value is RestoreInput {
  const row = statusObject(value, ['schema_version', 'context', 'base_revision', 'source_revision', 'source_request_id'], invalid);
  if (!statusId(deviceId) || row.schema_version !== schema || row.context !== 'ledger' || !statusId(row.base_revision) || !statusId(row.source_revision)
    || row.source_request_id !== null && !requestId(row.source_request_id)) invalid();
}
function summary(value: unknown, device: string): TraceSummary {
  const row = statusObject(value, summaryKeys, bad);
  if (row.device_id !== device || !revision(row.revision) || !statusTime(row.created_at) || row.data_origin !== 'SYNTHETIC_INTEGRATION' || !strings(row.changed_fields)) bad();
  if (row.kind === 'RETAINED_BASELINE') {
    if (row.request_id !== null || row.actor_id !== null || row.base_revision !== null || row.changed !== false || row.changed_fields.length) bad();
  } else if (row.kind !== 'RESOURCE_CHANGE' || !requestId(row.request_id) || !statusId(row.actor_id) || !revision(row.base_revision) || row.changed !== true || !row.changed_fields.length) bad();
  return structuredClone(row) as unknown as TraceSummary;
}
export function readTraceHistory(value: unknown, expected: TraceQuery): TracePage {
  const row = statusObject(value, ['schema_version', 'items', 'total', 'page', 'page_size'], bad);
  if (row.schema_version !== schema || row.page !== (expected.page ?? 1) || row.page_size !== (expected.page_size ?? 20) || !Number.isSafeInteger(row.total) || (row.total as number) < 0
    || !Array.isArray(row.items) || row.items.length !== Math.min(row.page_size as number, Math.max(0, (row.total as number) - ((row.page as number) - 1) * (row.page_size as number)))) bad();
  const items = (row.items as unknown[]).map(item => summary(item, expected.device_id)), ids = new Set();
  for (const item of items) { const key = item.request_id ?? 'baseline'; if (ids.has(key)) bad(); ids.add(key); }
  return { ...row, items } as unknown as TracePage;
}
function device(value: unknown, expected: string) {
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).device_id !== expected || Object.values(value).some(v => typeof v !== 'string')) bad();
}
export function readTraceDetail(value: unknown, expected: TraceDetailQuery): TraceDetail {
  const row = statusObject(value, ['schema_version', ...summaryKeys, 'before', 'after', 'diffs', 'source_files'], bad);
  if (row.schema_version !== schema || row.request_id !== expected.request_id || row.kind !== 'RESOURCE_CHANGE') bad();
  const s = Object.fromEntries(summaryKeys.map(k => [k, row[k]])); summary(s, expected.device_id);
  device(row.before, expected.device_id); device(row.after, expected.device_id);
  if (!Array.isArray(row.diffs) || !row.source_files || typeof row.source_files !== 'object' || Array.isArray(row.source_files)) bad();
  const left = row.before as Record<string, string> | null, right = row.after as Record<string, string> | null;
  const changed = [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].filter(k => left?.[k] !== right?.[k]).sort();
  if (JSON.stringify(changed) !== JSON.stringify(row.changed_fields) || row.diffs.length !== changed.length) bad();
  row.diffs.forEach((value: unknown, i: number) => {
    const diff = statusObject(value, ['field', 'before', 'after', 'known'], bad), field = changed[i]!;
    if (diff.field !== field || diff.before !== (left?.[field] ?? null) || diff.after !== (right?.[field] ?? null)
      || diff.known !== (![null, undefined, ''].includes(left?.[field]) && ![null, undefined, ''].includes(right?.[field]))) bad();
  });
  for (const value of Object.values(row.source_files)) {
    const file = statusObject(value, ['path', 'sha256'], bad);
    if (typeof file.path !== 'string' || !file.path.startsWith('data/') || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) bad();
  }
  return structuredClone(row) as unknown as TraceDetail;
}
export function readRestoreProposal(value: unknown, deviceId: string, expected: RestoreInput): RestoreProposal {
  const row = statusObject(value, ['schema_version', 'device_id', 'base_revision', 'source_revision', 'source_request_id', 'model_id', 'compatible', 'changes', 'patch', 'blocked_fields', 'warnings'], bad);
  if (row.schema_version !== schema || row.device_id !== deviceId || row.base_revision !== expected.base_revision || row.source_revision !== expected.source_revision || row.source_request_id !== expected.source_request_id
    || !revision(row.base_revision) || !revision(row.source_revision) || !statusId(row.model_id) || typeof row.compatible !== 'boolean' || !strings(row.blocked_fields) || !strings(row.warnings)
    || !row.patch || typeof row.patch !== 'object' || Array.isArray(row.patch) || !Array.isArray(row.changes)) bad();
  const patch = row.patch as Record<string, unknown>, keys = Object.keys(patch);
  if (keys.some(k => !fields.includes(k) || !finite(patch[k])) || row.compatible !== !!keys.length || row.changes.length !== keys.length) bad();
  const seen = new Set();
  for (const value of row.changes) {
    const diff = statusObject(value, ['field', 'before', 'after', 'known'], bad);
    if (!fields.includes(diff.field as string) || seen.has(diff.field) || !Object.hasOwn(patch, diff.field as string) || diff.after !== patch[diff.field as string]
      || diff.before !== null && !finite(diff.before) || diff.known !== true || diff.before === diff.after) bad();
    seen.add(diff.field);
  }
  return structuredClone(row) as unknown as RestoreProposal;
}
