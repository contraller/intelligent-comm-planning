import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import { validateTraceQuery, validateRestoreInput, readTraceHistory, readTraceDetail, readRestoreProposal } from './device-trace-decode';
import type { TraceQuery, TraceDetailQuery, RestoreInput } from '../types/device-trace';
export function createDeviceTraceHttp(request: AuthenticatedRequest) {
  async function call(path: string, init: RequestInit) {
    try { return await request('/device-traces/' + path, init); }
    catch (e) {
      if (!(e instanceof ApiError)) throw e;
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'DEVICE_TRACE_NOT_FOUND', 1203: 'DEVICE_TRACE_SOURCE_CHANGED', 1205: 'RESOURCE_VERSION_CHANGED' };
      const code = typeof e.code === 'number' ? codes[e.code] : undefined;
      if (!code) throw e; throw new ApiError(e.message, code, e.data, e.requestId, e.status);
    }
  }
  return {
    async queryHistory(input: TraceQuery, options: { signal?: AbortSignal } = {}) {
      validateTraceQuery(input); const captured = { ...input };
      const query = new URLSearchParams({ context: captured.context, resource_revision: captured.resource_revision, page: String(captured.page ?? 1), page_size: String(captured.page_size ?? 20) });
      return readTraceHistory(await call(encodeURIComponent(captured.device_id) + '/history?' + query, { signal: options.signal }), captured);
    },
    async getOperation(input: TraceDetailQuery, options: { signal?: AbortSignal } = {}) {
      validateTraceQuery(input, true); const captured = { ...input };
      return readTraceDetail(await call(encodeURIComponent(captured.device_id) + '/operations/' + encodeURIComponent(captured.request_id) + '?' + new URLSearchParams({ context: 'ledger', resource_revision: captured.resource_revision }), { signal: options.signal }), captured);
    },
    async previewRestore(deviceId: string, input: RestoreInput, options: { signal?: AbortSignal } = {}) {
      validateRestoreInput(deviceId, input); const captured = { ...input }, id = deviceId;
      return readRestoreProposal(await call(encodeURIComponent(id) + '/restore-preview', { method: 'POST', body: JSON.stringify(captured), signal: options.signal }), id, captured);
    },
  };
}
export type DeviceTraceClient = ReturnType<typeof createDeviceTraceHttp>;
