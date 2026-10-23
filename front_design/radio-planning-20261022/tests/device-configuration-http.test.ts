import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createAuthHttp } from '../src/services/auth-http';
import { createDeviceConfigurationHttp } from '../src/services/device-configuration-http';
import {
  acceptanceMessage, deviceConfigurationSchema, type ConfigurationSubmissionInput,
  type ConfigurationSystemAcceptance, type ConfigurationAcceptanceContext,
} from '../src/services/device-configuration-decode';
import { ApiError } from '../src/services/types';

const revision = 'resource-1111111111111111';
const input = (): ConfigurationSubmissionInput => ({ schema_version: deviceConfigurationSchema, context: 'ledger',
  base_revision: revision, device_id: 'DV-1', model_id: 'DM-1', request_id: 'request-1',
  values: { tx_power_dbm: 30, work_freq_khz: 3000 } });
function context(): ConfigurationAcceptanceContext {
  return { schema_version: deviceConfigurationSchema, context: 'ledger', resource_revision: revision, resource_content_hash: '1'.repeat(64),
    device: { device_id: 'DV-1', node_id: 'ND-1', model_id: 'DM-1', availability: 'ACTIVE', source_values: { tx_power_dbm: null, work_freq_khz: null } },
    model: { model_id: 'DM-1', freq_min_khz: 2000, freq_max_khz: 30000, tx_power_max_dbm: 50 },
    provenance: { data_origin: 'SYNTHETIC_INTEGRATION', resource_source: '构造联调测试 fixture', source_files: { 'device.csv': { path: 'data/synthetic/devices.csv', sha256: '2'.repeat(64) } } },
    protocol: { port_options: null, mode_options: null, confirmation: '待确认' } };
}
function acceptance(): ConfigurationSystemAcceptance {
  const c = context();
  return { schema_version: deviceConfigurationSchema, configuration_id: 'DC-' + 'a'.repeat(32), request_id: 'request-1', request_digest: '3'.repeat(64),
    context: 'ledger', device_id: 'DV-1', model_id: 'DM-1', base_revision: revision, resource_content_hash: c.resource_content_hash,
    requested_values: input().values, device_snapshot: c.device, model_constraints: c.model, provenance: c.provenance,
    actor: { account_id: 'integration-editor', display_name: '联调编辑者', role_id: 'integration-editor', identity_revision: 'integration-workflow-v1', integration_mode: true },
    accepted_at: '2026-10-23T10:00:00.123456Z', status: 'ACCEPTED', receipt_scope: 'SYSTEM_ACCEPTANCE', dispatch_status: 'NOT_DISPATCHED',
    device_execution_status: 'UNKNOWN', applied_values: null, online: null, effective: null, device_reported_at: null, message: acceptanceMessage };
}
function history() {
  const a = acceptance();
  return { schema_version: deviceConfigurationSchema, context: 'ledger', total: 1, page: 1, page_size: 20,
    items: [{ configuration_id: a.configuration_id, request_id: a.request_id, device_id: a.device_id, model_id: a.model_id, base_revision: revision,
      requested_values: a.requested_values, accepted_at: a.accepted_at, status: a.status, receipt_scope: a.receipt_scope,
      dispatch_status: a.dispatch_status, data_origin: 'SYNTHETIC_INTEGRATION' }] };
}
function service(value: unknown) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value);
  return { request, api: createDeviceConfigurationHttp(request) };
}

describe('P06 system acceptance HTTP contract', () => {
  it('loads version-bound context and preserves unknown source and protocol fields', async () => {
    const s = service(context());
    expect(await s.api.loadContext({ context: 'ledger', device_id: 'DV-1', revision })).toEqual(context());
    expect(s.request.mock.calls[0]![0]).toBe('/device-configurations/context?context=ledger&device_id=DV-1&revision=' + revision);
  });
  it('validates without a request id and posts exactly the two requested values', async () => {
    const { request_id: _, ...request } = input();
    const s = service({ valid: true, context: context(), requested_values: input().values });
    expect((await s.api.validateRequest(request)).valid).toBe(true);
    expect(s.request.mock.calls[0]![0]).toBe('/device-configurations/validate');
    expect(JSON.parse(s.request.mock.calls[0]![1]!.body as string)).toEqual(request);
  });
  it('submits a system receipt without promoting it to device success', async () => {
    const s = service(acceptance());
    expect(await s.api.submitRequest(input())).toEqual(acceptance());
    expect(s.request.mock.calls[0]![0]).toBe('/device-configurations');
    expect(s.request.mock.calls[0]![1]!.method).toBe('POST');
    expect(JSON.parse(s.request.mock.calls[0]![1]!.body as string)).toEqual(input());
    expect(await s.api.getRequest({ context: 'ledger', request_id: 'request-1' })).toEqual(acceptance());
    expect(s.request.mock.calls[1]![0]).toBe('/device-configurations/request-1?context=ledger');
  });
  it('queries lightweight history with explicit default pagination', async () => {
    const s = service(history());
    const result = await s.api.queryHistory({ context: 'ledger', device_id: 'DV-1' });
    expect(result.items).toHaveLength(1);
    expect(s.request.mock.calls[0]![0]).toBe('/device-configurations/history?context=ledger&page=1&page_size=20&device_id=DV-1');
  });
  it.each([
    { ports: [] }, { mode: 'FM' }, { currentWorkMode: 'AM' }, { scenario: 'success' }, { retryOf: 'other' },
    { schema_version: 'old' }, { request_id: 'history' }, { request_id: 'a/b' }, { request_id: 'bad\n' }, { context: 'gis' },
    { values: { tx_power_dbm: NaN, work_freq_khz: 3000 } }, { values: { tx_power_dbm: true, work_freq_khz: 3000 } },
    { values: { tx_power_dbm: '30', work_freq_khz: 3000 } }, { values: { tx_power_dbm: 30, work_freq_khz: null } },
    { values: { tx_power_dbm: 30, work_freq_khz: 0 } }, { values: { tx_power_dbm: 30, work_freq_khz: 3000, ports: [] } },
  ])('rejects unagreed or malformed input before sending: %j', async patch => {
    const s = service(acceptance());
    await expect(s.api.submitRequest({ ...input(), ...patch } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'SUCCEEDED' }, { status: 'RUNNING' }, { dispatch_status: 'DISPATCHED' }, { device_execution_status: 'SUCCESS' },
    { online: true }, { effective: false }, { applied_values: input().values }, { device_reported_at: '2026-10-23T10:00:00Z' },
    { request_id: 'other' }, { schema_version: 'other' }, { base_revision: 'resource-2222222222222222' },
    { requested_values: { tx_power_dbm: 31, work_freq_khz: 3000 } }, { model_id: 'other' }, { extra: true },
  ])('rejects a contaminated acceptance response: %j', async patch => {
    await expect(service({ ...acceptance(), ...patch }).api.submitRequest(input())).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION_RESPONSE' });
  });
  it('rejects false provenance, broken linkage and unconfirmed protocol options', async () => {
    for (const patch of [{ provenance: { ...context().provenance, data_origin: 'MEASURED' } },
      { device: { ...context().device, model_id: 'other' } }, { model: { ...context().model, freq_min_khz: 40000 } },
      { protocol: { port_options: [], mode_options: ['FM'], confirmation: 'confirmed' } }]) {
      await expect(service({ ...context(), ...patch }).api.loadContext({ context: 'ledger', device_id: 'DV-1', revision })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION_RESPONSE' });
    }
  });
  it('rejects duplicate, mismatched and invalid history rows', async () => {
    const h = history();
    for (const data of [{ ...h, total: 2, items: [h.items[0], h.items[0]] }, { ...h, page: 2 }, { ...h, total: -1 },
      { ...h, items: [{ ...h.items[0], device_id: 'other' }] }, { ...h, items: [{ ...h.items[0], data_origin: 'REAL' }] }]) {
      await expect(service(data).api.queryHistory({ context: 'ledger', device_id: 'DV-1' })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION_RESPONSE' });
    }
    const s = service(h);
    await expect(s.api.queryHistory({ context: 'ledger', page_size: 101 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).not.toHaveBeenCalled();
  });
  it('preserves microsecond ordering when adjacent rows share a JavaScript millisecond', async () => {
    const row = history().items[0]!;
    const first = { ...row, configuration_id: 'DC-' + '1'.repeat(32), request_id: 'newer', accepted_at: '2026-10-23T10:00:00.123456Z' };
    const second = { ...row, configuration_id: 'DC-' + 'f'.repeat(32), request_id: 'older', accepted_at: '2026-10-23T10:00:00.123455Z' };
    const h = { ...history(), total: 2, items: [first, second] };
    expect((await service(h).api.queryHistory({ context: 'ledger' })).items).toHaveLength(2);
    await expect(service({ ...h, items: [second, first] }).api.queryHistory({ context: 'ledger' })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION_RESPONSE' });
  });
  it.each([[1001, 'VALIDATION_ERROR'], [1002, 'CONFIGURATION_NOT_FOUND'], [1203, 'CONFIGURATION_SOURCE_CHANGED'],
    [1205, 'RESOURCE_VERSION_CHANGED'], [1206, 'REQUEST_CONFLICT']] as const)('maps code %s without retry or Mock fallback', async (code, mapped) => {
    const s = service(null);
    s.request.mockRejectedValue(new ApiError('rejected', code, null, 'trace-1', 409));
    await expect(s.api.submitRequest(input())).rejects.toMatchObject({ code: mapped, requestId: 'trace-1', status: 409 });
    expect(s.request).toHaveBeenCalledTimes(1);
  });
});

const realBase = process.env.P06_DEVICE_CONFIGURATION_BASE_URL;
describe.skipIf(!realBase)('P06 isolated real HTTP', () => {
  it('accepts and replays through the actual cookie session without request stubs', async () => {
    const base = new URL(realBase!);
    if (base.hostname !== '127.0.0.16' || !['8116', '5316'].includes(base.port)) throw new Error('P06 isolated address required');
    const cookies = new Map<string, string>();
    const fetcher: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      if (cookies.size) headers.set('Cookie', [...cookies].map(([k, v]) => k + '=' + v).join('; '));
      const response = await fetch(url, { ...init, headers });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]!, at = pair.indexOf('=');
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return response;
    };
    const auth = createAuthHttp({ baseUrl: () => realBase!, origin: () => base.origin, fetcher });
    await auth.switchIntegrationIdentity('integration-editor');
    const deviceId = process.env.P06_DEVICE_CONFIGURATION_DEVICE_ID;
    const resourceRevision = process.env.P06_DEVICE_CONFIGURATION_REVISION;
    if (!deviceId || !resourceRevision) throw new Error('Set P06_DEVICE_CONFIGURATION_DEVICE_ID and P06_DEVICE_CONFIGURATION_REVISION from the isolated resource snapshot');
    const api = createDeviceConfigurationHttp(auth.authenticatedRequest);
    const context = await api.loadContext({ context: 'ledger', device_id: deviceId, revision: resourceRevision });
    const request: ConfigurationSubmissionInput = { schema_version: deviceConfigurationSchema, context: 'ledger', base_revision: resourceRevision,
      device_id: deviceId, model_id: context.model.model_id, request_id: 'p06-http-' + crypto.randomUUID(),
      values: { tx_power_dbm: context.model.tx_power_max_dbm, work_freq_khz: context.model.freq_min_khz } };
    const receipt = await api.submitRequest(request);
    expect(receipt.status).toBe('ACCEPTED'); expect(receipt.online).toBeNull();
    expect(await api.submitRequest(request)).toEqual(receipt);
    expect(await api.getRequest({ context: 'ledger', request_id: request.request_id })).toEqual(receipt);
    expect((await api.queryHistory({ context: 'ledger', device_id: deviceId })).items.some(item => item.request_id === request.request_id)).toBe(true);
  });
});
