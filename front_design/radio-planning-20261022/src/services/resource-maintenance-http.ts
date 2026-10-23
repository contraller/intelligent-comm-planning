import type { AuthenticatedRequest } from './auth-http';
import type { ResourceCommit, ResourceServices } from '../types/resource-edit';
import { readAvailabilityContext, readAvailabilityReceipt, readMaintenanceContext, readMaintenanceReceipt } from './resource-maintenance-validation';
import { ApiError } from './types';

function invalid(): never { throw new ApiError('设备维护请求不符合台账参数或上下架契约', 'VALIDATION_ERROR'); }
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 120 || /\s|[\u0000-\u001f\u007f]/.test(value)) invalid();
}
function body(input: ResourceCommit) {
  if (!input || input.context !== 'ledger' || Object.keys(input).some(k => !['context', 'baseRevision', 'requestId', 'stations', 'devices'].includes(k))
    || !Array.isArray(input.stations) || input.stations.length || !Array.isArray(input.devices) || input.devices.length !== 1) invalid();
  identifier(input.baseRevision); identifier(input.requestId);
  const row = input.devices[0]!;
  if (!row || Object.keys(row).some(k => !['id', 'antennaHeightM', 'txPowerDbm', 'workFreqKhz'].includes(k)) || Object.keys(row).length < 2) invalid();
  identifier(row.id);
  const device: Record<string, string | number | null> = { id: row.id };
  for (const [key, field] of [['antennaHeightM', 'antenna_height_m'], ['txPowerDbm', 'tx_power_dbm'], ['workFreqKhz', 'work_freq_khz']] as const) {
    if (!Object.hasOwn(row, key)) continue;
    const value = row[key];
    if (!(key === 'workFreqKhz' && value === null) && (typeof value !== 'number' || !Number.isFinite(value)
      || key === 'antennaHeightM' && value < 0 || key === 'workFreqKhz' && value <= 0)) invalid();
    device[field] = value!;
  }
  return { context: input.context, base_revision: input.baseRevision, request_id: input.requestId, stations: [], devices: [device] };
}
function selection(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50 || new Set(value).size !== value.length) invalid();
  value.forEach(identifier);
}
export function createResourceMaintenanceHttp(request: AuthenticatedRequest): Pick<ResourceServices, 'loadResourceMaintenanceContext' | 'saveResourceChanges' | 'updateDeviceAvailability'> {
  async function call(path: string, init?: RequestInit) {
    try { return await request(path, init); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'RESOURCE_NOT_FOUND', 1205: 'RESOURCE_VERSION_CHANGED', 1206: 'REQUEST_CONFLICT' };
      const code = typeof error.code === 'number' ? codes[error.code] : undefined;
      if (!code) throw error;
      throw new ApiError(error.message, code, error.data, error.requestId, error.status);
    }
  }
  return {
    async loadResourceMaintenanceContext(input) {
      if (!input || input.context !== 'ledger' || Object.keys(input).some(k => !['context', 'revision', 'deviceId', 'ids'].includes(k))) invalid();
      identifier(input.revision);
      if (input.ids !== undefined) {
        if (input.deviceId !== undefined) invalid();
        selection(input.ids);
        const data = await call('/resource/device-availability/preview',{method:'POST',body:JSON.stringify({context:'ledger',revision:input.revision,ids:input.ids})});
        return readAvailabilityContext(data,input.revision,input.ids);
      }
      identifier(input.deviceId);
      const query = new URLSearchParams({ context: input.context, revision: input.revision, device_id: input.deviceId });
      return readMaintenanceContext(await call('/resource/maintenance-context?' + query), input.revision, input.deviceId);
    },
    async saveResourceChanges(input) {
      return readMaintenanceReceipt(await call('/resource/changes', { method: 'POST', body: JSON.stringify(body(input)) }), input);
    },
    async updateDeviceAvailability(input) {
      if (!input || Object.keys(input).some(k => !['baseRevision','requestId','ids','availability'].includes(k)) || !['ACTIVE','OFF_SHELF'].includes(input.availability)) invalid();
      identifier(input.baseRevision);identifier(input.requestId);selection(input.ids);
      const data = await call('/resource/device-availability',{method:'POST',body:JSON.stringify({context:'ledger',base_revision:input.baseRevision,request_id:input.requestId,ids:input.ids,availability:input.availability})});
      return readAvailabilityReceipt(data,input.baseRevision,input.ids);
    },
  };
}
