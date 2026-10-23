import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import type { InterferenceWorkbenchServices } from '../types/interference-workbench';
import { id, readAdoption, readContext, readPage, readPreview, readProgress, readReceipt, readRun, readSource, record, state } from './interference-workbench-validation';

const BASE = '/interference/workbench';
function invalid(): never { throw new ApiError('干扰工作流请求不符合契约', 'VALIDATION_ERROR'); }
const common = ['request_id', 'task_id', 'plan_id', 'plan_version', 'resource_revision', 'scene_id', 'scene_version_id', 'snapshot_hash'];
// 在第一次await前复制并验证，body/query和响应核验只使用发起时的同一副本。
function capture<T extends object>(input: T, allowed: string[], required: string[]): T {
  try {
    const value = record(input);
    if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) { if (required.includes(key)) invalid(); continue; }
      if (['page', 'page_size', 'expected_run_version', 'expected_adoption_version'].includes(key)) {
        if (!Number.isSafeInteger(item) || (item as number) < 1 || key === 'page_size' && (item as number) > 100) invalid();
      } else if (key === 'search') { if (typeof item !== 'string' || item.length > 120) invalid(); }
      else if (key === 'state') state(item);
      else if (key === 'plan_version') { if (typeof item !== 'string' || !/^V[1-9][0-9]*$/.test(item)) invalid(); }
      else if (key === 'snapshot_hash') { if (typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)) invalid(); }
      else if (key === 'operation') { if (!['SUBMIT_ANALYSIS', 'CANCEL_ANALYSIS', 'ADOPT_MEASURE', 'CANCEL_ADOPTION'].includes(item as string)) invalid(); }
      else {
        id(item);
        if (['request_id', 'run_id', 'adoption_id', 'measure_id', 'scene_id'].includes(key) && /[/\\]/.test(item)) invalid();
      }
    }
    return structuredClone(input);
  } catch { return invalid(); }
}
function query(input: object, omit: string[] = []) { const params = new URLSearchParams(); Object.entries(input).forEach(([key, value]) => { if (!omit.includes(key) && value !== undefined) params.set(key, String(value)); }); return params; }
export function createInterferenceWorkbenchHttp(request: AuthenticatedRequest): InterferenceWorkbenchServices {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    try { return await request(BASE + path, init); }
    catch (error) {
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 2001: 'NOT_FOUND', 1203: 'VERSION_CONFLICT', 1205: 'RESOURCE_VERSION_CHANGED', 1206: 'REQUEST_CONFLICT', 2002: 'STATE_CONFLICT' };
      if (error instanceof ApiError && typeof error.code === 'number' && codes[error.code]) throw new ApiError(error.message, codes[error.code], error.data, error.requestId, error.status);
      throw error;
    }
  }
  const post = (path: string, body: object) => call(path, { method: 'POST', body: JSON.stringify(body) });
  return {
    async getContext(input, signal) { const copy = capture(input, ['task_id'], []); return readContext(await call('?' + query(copy), { signal }), copy.task_id); },
    async listSources(input, signal) { const copy = capture(input, ['task_id', 'page', 'page_size', 'search'], []); return readPage(await call('/sources?' + query(copy), { signal }), copy, value => { const row = readSource(value); if (copy.task_id && row.task_id !== copy.task_id) invalid(); return row; }); },
    async submitRun(input) { const copy = capture(input, common, common); return readReceipt(await post('/runs', copy), { ...copy, operation: 'SUBMIT_ANALYSIS' }); },
    async listRuns(input, signal) { const copy = capture(input, ['task_id', 'page', 'page_size', 'search', 'state'], ['task_id']); return readPage(await call('/runs?' + query(copy), { signal }), copy, value => { const row = readProgress(value, copy), count = record(value).adoption_count; if (!Number.isSafeInteger(count) || (count as number) < 0 || copy.state && row.state !== copy.state) invalid(); return { ...row, adoption_count: count as number }; }); },
    async getProgress(input, signal) { const copy = capture(input, ['task_id', 'run_id'], ['task_id', 'run_id']); return readProgress(await call('/runs/' + encodeURIComponent(copy.run_id) + '/progress?' + query(copy, ['run_id']), { signal }), copy); },
    async getRun(input, signal) { const copy = capture(input, ['task_id', 'run_id'], ['task_id', 'run_id']); return readRun(await call('/runs/' + encodeURIComponent(copy.run_id) + '?' + query(copy, ['run_id']), { signal }), copy); },
    async getPreview(input, signal) { const keys = ['task_id', 'run_id', 'measure_id', 'expected_run_version'], copy = capture(input, keys, keys); return readPreview(await call('/runs/' + encodeURIComponent(copy.run_id) + '/measures/' + encodeURIComponent(copy.measure_id) + '/preview?' + query(copy, ['run_id', 'measure_id']), { signal }), copy); },
    async cancelRun(input) { const keys = ['request_id', 'task_id', 'run_id', 'expected_run_version'], copy = capture(input, keys, keys), { run_id, ...body } = copy; return readReceipt(await post('/runs/' + encodeURIComponent(run_id) + '/cancel', body), { ...copy, operation: 'CANCEL_ANALYSIS', object_id: run_id }); },
    async adoptMeasure(input) { const keys = [...common.filter(key => key !== 'scene_id'), 'run_id', 'measure_id', 'expected_run_version'], copy = capture(input, keys, keys); return readReceipt(await post('/adoptions', copy), { ...copy, operation: 'ADOPT_MEASURE' }); },
    async getAdoption(input, signal) { const keys = ['task_id', 'adoption_id'], copy = capture(input, keys, keys); return readAdoption(await call('/adoptions/' + encodeURIComponent(copy.adoption_id) + '?' + query(copy, ['adoption_id']), { signal }), copy); },
    async cancelAdoption(input) { const keys = ['request_id', 'task_id', 'adoption_id', 'expected_adoption_version'], copy = capture(input, keys, keys), { adoption_id, ...body } = copy; return readReceipt(await post('/adoptions/' + encodeURIComponent(adoption_id) + '/cancel', body), { ...copy, operation: 'CANCEL_ADOPTION', object_id: adoption_id }); },
    async getOperation(input, signal) { const keys = ['request_id', 'task_id', 'operation'], copy = capture(input, keys, keys); return readReceipt(await call('/operations/' + encodeURIComponent(copy.request_id) + '?' + query(copy, ['request_id']), { signal }), copy); },
  };
}
