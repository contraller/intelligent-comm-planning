import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import { validateStatusImport, validateStatusQuery, readStatusReceipt, readStatusHeader, readStatusList, readStatusDevices } from './device-status-decode';
import type { DeviceStatusImport, StatusSnapshotQuery, StatusListQuery, StatusDeviceQuery } from '../types/device-status-snapshot';

export function createDeviceStatusHttp(request: AuthenticatedRequest) {
  async function call(path: string, init: RequestInit) {
    try { return await request('/device-status' + path, init); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'DEVICE_STATUS_NOT_FOUND', 1203: 'DEVICE_STATUS_SOURCE_CHANGED', 1205: 'RESOURCE_VERSION_CHANGED', 1206: 'REQUEST_CONFLICT' };
      const code = typeof error.code === 'number' ? codes[error.code] : undefined;
      if (!code) throw error;
      throw new ApiError(error.message, code, error.data, error.requestId, error.status);
    }
  }
  function query(input: object, omit: string[] = []) {
    return new URLSearchParams(Object.entries(input).filter(([key]) => !omit.includes(key)).map(([key, value]) => [key, String(value)]));
  }
  return {
    async importSnapshot(input: DeviceStatusImport, options: { signal?: AbortSignal } = {}) {
      validateStatusImport(input);
      const captured = { ...input, records: input.records.map(item => ({ ...item, unknown_reasons: [...item.unknown_reasons] })) };
      return readStatusReceipt(await call('/imports', { method: 'POST', body: JSON.stringify(captured), signal: options.signal }), captured);
    },
    async getImport(input: { context: 'ledger'; request_id: string }, options: { signal?: AbortSignal } = {}) {
      validateStatusQuery(input, 'operation'); const captured = { ...input };
      return readStatusReceipt(await call('/imports/' + encodeURIComponent(captured.request_id) + '?context=ledger', { signal: options.signal }), captured);
    },
    async listSnapshots(input: StatusListQuery, options: { signal?: AbortSignal } = {}) {
      validateStatusQuery(input, 'list'); const captured = { ...input };
      return readStatusList(await call('/snapshots?' + query(captured), { signal: options.signal }), captured);
    },
    async getSnapshot(input: StatusSnapshotQuery, options: { signal?: AbortSignal } = {}) {
      validateStatusQuery(input, 'snapshot'); const captured = { ...input };
      return readStatusHeader(await call('/snapshots/' + encodeURIComponent(captured.snapshot_id) + '?' + query(captured, ['snapshot_id']), { signal: options.signal }), captured);
    },
    async queryDevices(input: StatusDeviceQuery, options: { signal?: AbortSignal } = {}) {
      validateStatusQuery(input, 'devices'); const captured = { ...input };
      return readStatusDevices(await call('/snapshots/' + encodeURIComponent(captured.snapshot_id) + '/devices?' + query(captured, ['snapshot_id']), { signal: options.signal }), captured);
    },
  };
}
export type DeviceStatusClient = ReturnType<typeof createDeviceStatusHttp>;
