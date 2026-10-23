import type { AuthenticatedRequest } from './auth-http';
import type { FrequencyDisableInput, FrequencyDisableValidationInput, FrequencyResourceQuery } from '../types/frequency-resource';
import { readFrequencyDisableReceipt, readFrequencyDisableValidation, readFrequencyResources } from './frequency-resource-validation';
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

export function createFrequencyResourceHttp(request: AuthenticatedRequest) {
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
  };
}
