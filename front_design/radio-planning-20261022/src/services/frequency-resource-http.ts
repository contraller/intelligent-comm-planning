import type { AuthenticatedRequest } from './auth-http';
import type { FrequencyDisableInput, FrequencyDisableValidationInput, FrequencyResourceQuery } from '../types/frequency-resource';
import { readFrequencyDisableReceipt, readFrequencyDisableValidation, readFrequencyResources } from './frequency-resource-validation';
import { ApiError } from './types';

function invalid(): never { throw new ApiError('规划频点请求不符合停用契约', 'VALIDATION_ERROR'); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 120 || /\s|[\u0000-\u001f\u007f]/u.test(value)) invalid();
}
function requestBody(value: unknown, mode: 'read' | 'validate' | 'disable') {
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
  if (mode === 'disable') identifier(input.requestId);
  return { context: 'ledger' as const,
    [mode === 'disable' ? 'base_revision' : 'revision']: input[versionKey] as string,
    ...(mode === 'read' ? {} : { ids: selected }),
    ...(mode === 'disable' ? { request_id: input.requestId as string } : {}) };
}

export function createFrequencyResourceHttp(request: AuthenticatedRequest) {
  const path = '/resource/frequency-resources';
  return {
    async loadFrequencyResources(input: FrequencyResourceQuery, signal?: AbortSignal) {
      requestBody(input, 'read');
      const query = new URLSearchParams({ context: input.context, revision: input.revision });
      return readFrequencyResources(await request(`${path}?${query}`, { signal }), input.revision);
    },
    async validateFrequencyDisable(input: FrequencyDisableValidationInput, signal?: AbortSignal) {
      const body = requestBody(input, 'validate');
      return readFrequencyDisableValidation(await request(`${path}/disable/validate`, {
        method: 'POST', body: JSON.stringify(body), signal,
      }), input);
    },
    async disableFrequencyResources(input: FrequencyDisableInput, signal?: AbortSignal) {
      const body = requestBody(input, 'disable');
      return readFrequencyDisableReceipt(await request(`${path}/disable`, {
        method: 'POST', body: JSON.stringify(body), signal,
      }), input);
    },
  };
}
