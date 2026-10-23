import type { SpectrumOfflineCheck, SpectrumSourceDraft, SpectrumSourceOperation, SpectrumSourceReceipt, SpectrumSourceRow, SpectrumSourceVersion } from '../types/spectrum-source';
import { ApiError } from './types';

export const spectrumSourceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value);
export const spectrumSourceRevision = (value: unknown): value is string => typeof value === 'string' && /^SPV-[0-9a-f]{64}$/.test(value);
export const spectrumInteger = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value: unknown, max = 120): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const draftKeys = ['name', 'protocolHint', 'endpoint', 'intervalSeconds', 'minKhz', 'maxKhz', 'enabled', 'provenanceNote'];
const versionKeys = ['schemaVersion', 'dataOrigin', 'sourceId', 'configRevision', 'contentHash', 'draft', 'createdAt', 'actorId'];
function bad(): never { throw new ApiError('频谱来源响应损坏，已保留原结果', 'INVALID_SPECTRUM_SOURCE_RESPONSE'); }
function check(value: unknown): asserts value { if (!value) bad(); }
export function sourceRecord(value: unknown, keys: string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const result = value as Record<string, unknown>;
  check(Object.keys(result).length === keys.length && keys.every(key => Object.hasOwn(result, key)));
  return result;
}
function draftValid(value: unknown): value is SpectrumSourceDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== draftKeys.length || !draftKeys.every(key => Object.hasOwn(data, key))) return false;
  if (!text(data.name, 60) || data.name !== data.name.trim() || !text(data.provenanceNote, 500) || typeof data.enabled !== 'boolean') return false;
  if (data.protocolHint !== null && data.protocolHint !== 'HTTP_JSON' && data.protocolHint !== 'WEBSOCKET_JSON') return false;
  if (data.intervalSeconds !== null && !spectrumInteger(data.intervalSeconds, 1, 3600)) return false;
  if (!(data.minKhz === null && data.maxKhz === null) && !(finite(data.minKhz) && finite(data.maxKhz) && data.minKhz > 0 && data.maxKhz > data.minKhz)) return false;
  if (data.endpoint !== null) {
    if (!text(data.endpoint, 500) || /[\s\\\u0000-\u001f]/.test(data.endpoint) || data.endpoint.includes('#')) return false;
    try {
      const url = new URL(data.endpoint);
      const protocols = data.protocolHint === 'HTTP_JSON' ? ['http:', 'https:'] : data.protocolHint === 'WEBSOCKET_JSON' ? ['ws:', 'wss:'] : ['http:', 'https:', 'ws:', 'wss:'];
      if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.port === '0') return false;
    } catch { return false; }
  }
  return true;
}
export function assertSpectrumSourceDraft(value: unknown): asserts value is SpectrumSourceDraft {
  if (!draftValid(value)) throw new ApiError('频谱来源声明不完整或格式无效', 'INVALID_SPECTRUM_SOURCE_QUERY');
}
export function assertSpectrumSourceQuery(input: unknown, allowed: string[], required: string[] = []) {
  const invalid = () => { throw new ApiError('频谱来源查询无效', 'INVALID_SPECTRUM_SOURCE_QUERY'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => ![...allowed, 'signal'].includes(key)) || required.some(key => data[key] === undefined)) invalid();
  if (data.signal !== undefined && !(data.signal instanceof AbortSignal)) invalid();
  for (const key of ['sourceId', 'requestId']) if (data[key] !== undefined && !spectrumSourceId(data[key])) invalid();
  for (const key of ['configRevision', 'baseConfigRevision']) if (data[key] !== undefined && data[key] !== null && !spectrumSourceRevision(data[key])) invalid();
  if (data.configRevision === null || data.page !== undefined && !spectrumInteger(data.page, 1) || data.pageSize !== undefined && !spectrumInteger(data.pageSize, 1, 100)) invalid();
  if (data.search !== undefined && (typeof data.search !== 'string' || data.search.length > 120) || data.enabled !== undefined && typeof data.enabled !== 'boolean') invalid();
  if (data.operationType !== undefined && data.operationType !== 'SOURCE_SAVE' && data.operationType !== 'SOURCE_CHECK') invalid();
  if (data.draft !== undefined) assertSpectrumSourceDraft(data.draft);
}
export function decodeSourceVersion(value: unknown, expected: { sourceId?: string; configRevision?: string } = {}): SpectrumSourceVersion {
  const data = sourceRecord(value, versionKeys);
  check(data.schemaVersion === 1 && data.dataOrigin === 'SYNTHETIC_INTEGRATION' && spectrumSourceId(data.sourceId) && spectrumSourceRevision(data.configRevision));
  check(typeof data.contentHash === 'string' && data.configRevision === 'SPV-' + data.contentHash && /^[0-9a-f]{64}$/.test(data.contentHash));
  check(text(data.actorId) && time(data.createdAt) && draftValid(data.draft));
  if (expected.sourceId !== undefined) check(data.sourceId === expected.sourceId);
  if (expected.configRevision !== undefined) check(data.configRevision === expected.configRevision);
  return value as SpectrumSourceVersion;
}
export function decodeOfflineCheck(value: unknown, expected: { sourceId?: string; configRevision?: string } = {}): SpectrumOfflineCheck {
  const data = sourceRecord(value, ['checkId', 'sourceId', 'configRevision', 'checkedAt', 'validation', 'connection', 'validationMode', 'issues']);
  check(spectrumSourceId(data.checkId) && spectrumSourceId(data.sourceId) && spectrumSourceRevision(data.configRevision) && time(data.checkedAt));
  check(data.connection === 'NOT_ATTEMPTED' && data.validationMode === 'OFFLINE_ONLY' && (data.validation === 'VALID' || data.validation === 'INCOMPLETE') && Array.isArray(data.issues));
  for (const issue of data.issues) { const item = sourceRecord(issue, ['field', 'code', 'message']); check(text(item.field) && text(item.message, 500) && ['MISSING', 'INVALID'].includes(String(item.code))); }
  check((data.validation === 'VALID') === (data.issues.length === 0));
  if (expected.sourceId !== undefined) check(data.sourceId === expected.sourceId);
  if (expected.configRevision !== undefined) check(data.configRevision === expected.configRevision);
  return value as SpectrumOfflineCheck;
}
export function decodeSourceReceipt(value: unknown, expected: { requestId: string; sourceId?: string; configRevision?: string; operationType: SpectrumSourceReceipt['operationType'] }): SpectrumSourceReceipt {
  const data = sourceRecord(value, ['requestId', 'operationType', 'sourceId', 'configRevision', 'changed', 'actorId', 'committedAt', 'source', 'check']);
  check(data.requestId === expected.requestId && data.operationType === expected.operationType && spectrumSourceId(data.sourceId) && spectrumSourceRevision(data.configRevision));
  check(typeof data.changed === 'boolean' && text(data.actorId) && time(data.committedAt));
  const identity = { sourceId: data.sourceId, configRevision: data.configRevision };
  if (expected.sourceId !== undefined) check(data.sourceId === expected.sourceId);
  if (expected.configRevision !== undefined) check(data.configRevision === expected.configRevision);
  if (data.operationType === 'SOURCE_SAVE') { check(data.check === null); decodeSourceVersion(data.source, identity); }
  else { check(data.source === null && data.changed === false); decodeOfflineCheck(data.check, identity); }
  return value as SpectrumSourceReceipt;
}
export function decodeSourceOperation(value: unknown, expected: { requestId: string; operationType: SpectrumSourceReceipt['operationType'] }): SpectrumSourceOperation {
  const data = sourceRecord(value, ['schemaVersion', 'dataOrigin', 'requestId', 'operationType', 'status', 'receipt']);
  check(data.schemaVersion === 1 && data.dataOrigin === 'SYNTHETIC_INTEGRATION' && data.requestId === expected.requestId && data.operationType === expected.operationType);
  if (data.status === 'NOT_FOUND') check(data.receipt === null);
  else { check(data.status === 'COMMITTED'); decodeSourceReceipt(data.receipt, expected); }
  return value as SpectrumSourceOperation;
}
export function decodeSourcePage(value: unknown, input: { page: number; pageSize: number; sourceId?: string }, kind: 'sources' | 'versions' | 'checks') {
  const data = sourceRecord(value, ['schemaVersion', 'dataOrigin', 'items', 'page', 'pageSize', 'total', ...(kind === 'sources' ? [] : ['sourceId'])]);
  check(data.schemaVersion === 1 && data.dataOrigin === 'SYNTHETIC_INTEGRATION' && data.page === input.page && data.pageSize === input.pageSize && spectrumInteger(data.total) && Array.isArray(data.items));
  if (kind !== 'sources') check(data.sourceId === input.sourceId);
  const size = input.page > Math.ceil(data.total / input.pageSize) ? 0 : Math.min(input.pageSize, data.total - (input.page - 1) * input.pageSize);
  check(data.items.length === size);
  let previous = '';
  const ids = new Set<string>();
  for (const value of data.items) {
    if (kind === 'sources') {
      const row = sourceRecord(value, [...versionKeys, 'latestOfflineCheck']);
      const { latestOfflineCheck, ...base } = row;
      const source = decodeSourceVersion(base);
      check(source.sourceId > previous); previous = source.sourceId;
      if (latestOfflineCheck !== null) decodeOfflineCheck(latestOfflineCheck, source);
    } else if (kind === 'checks') {
      const row = decodeOfflineCheck(value, input); check(!ids.has(row.checkId)); ids.add(row.checkId);
    } else { const row = decodeSourceVersion(value, input); check(!ids.has(row.configRevision)); ids.add(row.configRevision); }
  }
  return value as { schemaVersion: 1; dataOrigin: 'SYNTHETIC_INTEGRATION'; page: number; pageSize: number; total: number; items: (SpectrumSourceRow | SpectrumSourceVersion | SpectrumOfflineCheck)[]; sourceId: string };
}
