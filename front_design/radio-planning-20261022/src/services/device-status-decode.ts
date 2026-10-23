import { ApiError } from './types';
import { deviceStatusSchema as schema, type DeviceStatusHeader, type DeviceStatusImport, type DeviceStatusReceipt,
  type StatusDevices, type StatusListQuery, type StatusDeviceQuery, type StatusPage } from '../types/device-status-snapshot';

type Row = Record<string, unknown>;
const bad = (): never => { throw new ApiError('状态快照响应不符合契约', 'INVALID_DEVICE_STATUS_RESPONSE'); };
const invalid = (): never => { throw new ApiError('状态快照请求无效', 'VALIDATION_ERROR'); };
export const statusId = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 120 && !/\s|[\u0000-\u001f\u007f]/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const revision = (v: unknown) => typeof v === 'string' && /^resource-[a-f0-9]{16}$/.test(v);
const snapshotId = (v: unknown) => typeof v === 'string' && /^DSS-[a-f0-9]{32}$/.test(v);
const snapshotRevision = (v: unknown) => typeof v === 'string' && /^device-status-[a-f0-9]{64}$/.test(v);
const requestId = (v: unknown) => statusId(v) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v) && !['context', 'validate', 'history'].includes(v);
const status = (v: unknown) => v === null || ['NORMAL', 'FAULT', 'OFFLINE'].includes(v as string);
export function statusObject(value: unknown, keys: string[], fail = bad): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Row;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return fail();
  return row;
}
function optionalObject(value: unknown, required: string[], optional: string[], fail = invalid): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Row;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => ![...required, ...optional].includes(key))) fail();
  return row;
}
export function statusTime(v: unknown, utc = true): v is string {
  if (typeof v !== 'string' || !(utc ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/).test(v)) return false;
  const date = Date.parse(v);
  if (!Number.isFinite(date)) return false;
  // 原始日期也要验证，Date.parse 会把 2 月 31 日归一化到 3 月。
  const day = new Date(v.slice(0, 10) + 'T00:00:00Z');
  return day.toISOString().slice(0, 10) === v.slice(0, 10) && Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60 && Number(v.slice(17, 19)) < 60;
}
function record(value: unknown, output = true, fail = bad) {
  const row = statusObject(value, ['device_id', 'node_id', 'model_id', 'observed_at', 'status', 'alert', 'unknown_reasons', ...(output ? ['availability'] : [])], fail);
  if (![row.device_id, row.node_id, row.model_id].every(statusId) || !status(row.status) || row.alert !== null && typeof row.alert !== 'boolean'
    || row.observed_at !== null && !statusTime(row.observed_at, output)
    || !Array.isArray(row.unknown_reasons) || row.unknown_reasons.length > 16 || row.unknown_reasons.some(v => !text(v, 500))
    || new Set(row.unknown_reasons).size !== row.unknown_reasons.length
    || [row.status, row.alert, row.observed_at].includes(null) && !row.unknown_reasons.length
    || output && !['ACTIVE', 'OFF_SHELF'].includes(row.availability as string)) fail();
  return row;
}
export function validateStatusImport(value: unknown): asserts value is DeviceStatusImport {
  const row = statusObject(value, ['schema_version', 'context', 'request_id', 'base_revision', 'data_origin', 'source_label', 'provenance_note', 'records'], invalid);
  if (row.schema_version !== schema || row.context !== 'ledger' || !requestId(row.request_id) || !statusId(row.base_revision)
    || row.data_origin !== 'SYNTHETIC_INTEGRATION' || !text(row.source_label, 120) || !text(row.provenance_note, 1000)
    || !Array.isArray(row.records) || !integer(row.records.length, 1, 1000)) invalid();
  const seen = new Set();
  for (const value of row.records as unknown[]) {
    const item = record(value, false, invalid);
    if (seen.has(item.device_id)) invalid();
    seen.add(item.device_id);
  }
}
export function validateStatusQuery(value: unknown, kind: 'list' | 'snapshot' | 'devices' | 'operation') {
  const required = kind === 'operation' ? ['context', 'request_id'] : kind === 'list' ? ['context'] : ['context', 'snapshot_id', 'snapshot_revision'];
  const optional = kind === 'list' ? ['resource_revision', 'page', 'page_size'] : kind === 'devices' ? ['device_id', 'status_filter', 'page', 'page_size'] : [];
  const row = optionalObject(value, required, optional);
  if (row.context !== 'ledger') invalid();
  for (const key of ['snapshot_id', 'snapshot_revision', 'resource_revision', 'device_id']) if (key in row && !statusId(row[key])) invalid();
  if (kind === 'operation' && !requestId(row.request_id)) invalid();
  if ('page' in row && !integer(row.page, 1, 9999999999) || 'page_size' in row && !integer(row.page_size, 1, 100)) invalid();
  if ('status_filter' in row && !['ALL', 'UNKNOWN', 'NORMAL', 'FAULT', 'OFFLINE'].includes(row.status_filter as string)) invalid();
}
function header(value: unknown): DeviceStatusHeader {
  const row = statusObject(value, ['schema_version', 'snapshot_id', 'snapshot_revision', 'content_hash', 'resource_revision', 'resource_content_hash',
    'data_origin', 'source_label', 'provenance_note', 'imported_at', 'actor_id', 'total', 'counts', 'first_observed_at', 'last_observed_at']);
  const counts = statusObject(row.counts, ['NORMAL', 'FAULT', 'OFFLINE', 'UNKNOWN', 'total']);
  if (row.schema_version !== schema || !snapshotId(row.snapshot_id) || !hash(row.content_hash) || row.snapshot_revision !== 'device-status-' + row.content_hash
    || !revision(row.resource_revision) || !hash(row.resource_content_hash) || row.data_origin !== 'SYNTHETIC_INTEGRATION'
    || !text(row.source_label, 120) || !text(row.provenance_note, 1000) || !statusTime(row.imported_at) || !statusId(row.actor_id)
    || !integer(row.total, 1, 1000) || Object.values(counts).some(v => !integer(v, 0, 1000)) || counts.total !== row.total
    || (counts.NORMAL as number) + (counts.FAULT as number) + (counts.OFFLINE as number) + (counts.UNKNOWN as number) !== row.total
    || row.first_observed_at !== null && !statusTime(row.first_observed_at) || row.last_observed_at !== null && !statusTime(row.last_observed_at)
    || (row.first_observed_at === null) !== (row.last_observed_at === null)
    || row.first_observed_at !== null && (row.first_observed_at as string) > (row.last_observed_at as string)) bad();
  return structuredClone(row) as unknown as DeviceStatusHeader;
}
export function readStatusHeader(value: unknown, expected: { snapshot_id: string; snapshot_revision: string }) {
  const result = header(value);
  if (result.snapshot_id !== expected.snapshot_id || result.snapshot_revision !== expected.snapshot_revision) bad();
  return result;
}
export function readStatusReceipt(value: unknown, expected: { request_id: string; base_revision?: string; records?: unknown[] }) {
  const row = statusObject(value, ['schema_version', 'request_id', 'snapshot_id', 'snapshot_revision', 'resource_revision', 'imported_at', 'total', 'content_hash', 'data_origin']);
  if (row.schema_version !== schema || !requestId(row.request_id) || row.request_id !== expected.request_id || !snapshotId(row.snapshot_id)
    || !hash(row.content_hash) || row.snapshot_revision !== 'device-status-' + row.content_hash || !revision(row.resource_revision)
    || !statusTime(row.imported_at) || !integer(row.total, 1, 1000) || row.data_origin !== 'SYNTHETIC_INTEGRATION'
    || expected.base_revision !== undefined && row.resource_revision !== expected.base_revision
    || expected.records !== undefined && row.total !== expected.records.length) bad();
  return structuredClone(row) as unknown as DeviceStatusReceipt;
}
function page(value: unknown, expected: { page?: number; page_size?: number }, extra: string[] = []) {
  const row = statusObject(value, ['schema_version', 'items', 'total', 'page', 'page_size', ...extra]);
  if (row.schema_version !== schema || row.page !== (expected.page ?? 1) || row.page_size !== (expected.page_size ?? 20)
    || !integer(row.total) || !Array.isArray(row.items)
    || row.items.length !== Math.min(row.page_size as number, Math.max(0, (row.total as number) - ((row.page as number) - 1) * (row.page_size as number)))) bad();
  return row;
}
export function readStatusList(value: unknown, expected: StatusListQuery): StatusPage<DeviceStatusHeader> {
  const row = page(value, expected), items = (row.items as unknown[]).map(header), ids = new Set();
  let previous = '';
  for (const item of items) {
    const key = item.imported_at + item.snapshot_id;
    if (ids.has(item.snapshot_id) || previous && key > previous || expected.resource_revision !== undefined && item.resource_revision !== expected.resource_revision) bad();
    ids.add(item.snapshot_id); previous = key;
  }
  return { ...row, items } as unknown as StatusPage<DeviceStatusHeader>;
}
export function readStatusDevices(value: unknown, expected: StatusDeviceQuery): StatusDevices {
  const row = page(value, expected, ['snapshot_id', 'snapshot_revision', 'resource_revision']);
  if (!snapshotId(row.snapshot_id) || !snapshotRevision(row.snapshot_revision) || !revision(row.resource_revision)
    || row.snapshot_id !== expected.snapshot_id || row.snapshot_revision !== expected.snapshot_revision) bad();
  let previous = '';
  for (const value of row.items as unknown[]) {
    const item = record(value), id = item.device_id as string;
    if (previous && id <= previous || expected.device_id !== undefined && id !== expected.device_id
      || expected.status_filter === 'UNKNOWN' && item.status !== null
      || expected.status_filter && !['ALL', 'UNKNOWN'].includes(expected.status_filter) && item.status !== expected.status_filter) bad();
    previous = id;
  }
  return structuredClone(row) as unknown as StatusDevices;
}
