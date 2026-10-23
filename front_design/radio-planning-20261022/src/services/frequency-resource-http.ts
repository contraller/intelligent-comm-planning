import type { AuthenticatedRequest } from './auth-http';
import type { FrequencyDisableInput, FrequencyDisableValidationInput, FrequencyResourceQuery,
  FrequencyPageQuery, FrequencyHistoryQuery, FrequencyOperationQuery, FrequencyResourceServices } from '../types/frequency-resource';
import { readFrequencyDisableReceipt, readFrequencyDisableValidation, readFrequencyResources,
  readFrequencyPage, readFrequencyOperation, readFrequencyOperations } from './frequency-resource-validation';
import { ApiError } from './types';

function invalid(): never { throw new ApiError('规划频点请求不符合停用契约', 'VALIDATION_ERROR'); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 120 || /\s|[\u0000-\u001f\u007f]/u.test(value)) invalid();
}
function requestSnapshot(value: unknown, mode: 'read'): Readonly<FrequencyResourceQuery>;
function requestSnapshot(value: unknown, mode: 'validate'): Readonly<FrequencyDisableValidationInput>;
function requestSnapshot(value: unknown, mode: 'disable'): Readonly<FrequencyDisableInput>;
function requestSnapshot(value: unknown, mode: 'read' | 'validate' | 'disable') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const input = value as Record<string, unknown>;
  const versionKey = mode === 'disable' ? 'baseRevision' : 'revision';
  const keys = ['context', versionKey, ...(mode === 'read' ? [] : ['ids']), ...(mode === 'disable' ? ['requestId'] : [])];
  if (input.context !== 'ledger' || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
    || typeof input[versionKey] !== 'string' || (input[versionKey] as string).length !== 25
    || !/^resource-[0-9a-f]{16}$/.test(input[versionKey] as string)) invalid();
  let selected: string[] = [];
  if (mode !== 'read') {
    if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 50) invalid();
    for (const value of input.ids) identifier(value);
    selected = [...input.ids] as string[];
    if (new Set(selected).size !== selected.length) invalid();
    selected.sort();
  }
  // 仅冻结本次调用的副本；页面仍可编辑原对象及原 ids，响应只核对发起时的值。
  Object.freeze(selected);
  if (mode === 'disable') {
    identifier(input.requestId);
    return Object.freeze({ context: 'ledger' as const, baseRevision: input[versionKey] as string,
      requestId: input.requestId, ids: selected });
  }
  const snapshot = { context: 'ledger' as const, revision: input[versionKey] as string };
  return Object.freeze(mode === 'read' ? snapshot : { ...snapshot, ids: selected });
}

function querySnapshot<T extends FrequencyPageQuery | FrequencyHistoryQuery>(input: T, versioned: boolean): Readonly<T> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const required = ['context', 'page', 'pageSize', ...(versioned ? ['revision'] : [])];
  const keys = [...required, 'search', ...(versioned ? ['deviceClass', 'availability', 'minKhz', 'maxKhz'] : [])];
  const value = { ...input } as Record<string, unknown>;
  if (value.context !== 'ledger' || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !keys.includes(key)) || !Number.isSafeInteger(value.page) || (value.page as number) < 1
    || ![5, 10, 20, 50].includes(value.pageSize as number) || value.search !== undefined
      && (typeof value.search !== 'string' || value.search.length > 120 || /[\u0000-\u001f\u007f]/.test(value.search))) invalid();
  if (versioned) {
    requestSnapshot({ context: value.context, revision: value.revision }, 'read');
    if (value.deviceClass !== undefined && !['HF', 'VUHF'].includes(value.deviceClass as string)
      || value.availability !== undefined && !['AVAILABLE', 'DISABLED'].includes(value.availability as string)) invalid();
    for (const key of ['minKhz', 'maxKhz']) if (value[key] !== undefined
      && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || (value[key] as number) <= 0)) invalid();
    if (value.minKhz !== undefined && value.maxKhz !== undefined && (value.minKhz as number) > (value.maxKhz as number)) invalid();
  }
  return Object.freeze(value) as Readonly<T>;
}
function queryString(input: FrequencyHistoryQuery | FrequencyPageQuery): string {
  const query = new URLSearchParams();
  const fields = { context: input.context, page: input.page, page_size: input.pageSize, search: input.search,
    ...('revision' in input ? { revision: input.revision, device_class: input.deviceClass,
      availability: input.availability, min_khz: input.minKhz, max_khz: input.maxKhz } : {}) };
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) query.set(key, String(value));
  return query.toString();
}
export function createFrequencyResourceHttp(request: AuthenticatedRequest): FrequencyResourceServices {
  const path = '/resource/frequency-resources';
  return {
    async loadFrequencyResources(input: FrequencyResourceQuery, signal?: AbortSignal) {
      const snapshot = requestSnapshot(input, 'read');
      const query = new URLSearchParams({ context: snapshot.context, revision: snapshot.revision });
      return readFrequencyResources(await request(`${path}?${query}`, { signal }), snapshot.revision);
    },
    async validateFrequencyDisable(input: FrequencyDisableValidationInput, signal?: AbortSignal) {
      const snapshot = requestSnapshot(input, 'validate');
      const body = { context: snapshot.context, revision: snapshot.revision, ids: snapshot.ids };
      return readFrequencyDisableValidation(await request(`${path}/disable/validate`, {
        method: 'POST', body: JSON.stringify(body), signal,
      }), snapshot);
    },
    async disableFrequencyResources(input: FrequencyDisableInput, signal?: AbortSignal) {
      const snapshot = requestSnapshot(input, 'disable');
      const body = { context: snapshot.context, base_revision: snapshot.baseRevision,
        request_id: snapshot.requestId, ids: snapshot.ids };
      return readFrequencyDisableReceipt(await request(`${path}/disable`, {
        method: 'POST', body: JSON.stringify(body), signal,
      }), snapshot);
    },
    async queryFrequencyResources(input, signal) {
      const snapshot = querySnapshot(input, true);
      return readFrequencyPage(await request(`${path}/query?${queryString(snapshot)}`, { signal }), snapshot);
    },
    async queryFrequencyOperations(input, signal) {
      const snapshot = querySnapshot(input, false);
      return readFrequencyOperations(await request(`${path}/operations?${queryString(snapshot)}`, { signal }), snapshot);
    },
    async getFrequencyOperation(input: FrequencyOperationQuery, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || input.context !== 'ledger' || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'requestId')) invalid();
      identifier(input.requestId);
      const snapshot = Object.freeze({ ...input });
      return readFrequencyOperation(await request(`${path}/operations/${encodeURIComponent(snapshot.requestId)}?context=ledger`, { signal }), snapshot);
    },
  };
}
