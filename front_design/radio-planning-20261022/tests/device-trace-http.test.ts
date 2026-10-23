import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createDeviceTraceHttp } from '../src/services/device-trace-http';
import { deviceTraceSchema as schema, type RestoreInput, type TraceDetail } from '../src/types/device-trace';
const revision = 'resource-1111111111111111', source = 'resource-2222222222222222';
const input = (): RestoreInput => ({ schema_version: schema, context: 'ledger', base_revision: revision, source_revision: source, source_request_id: null });
const proposal = () => ({ schema_version: schema, device_id: 'D1', base_revision: revision, source_revision: source, source_request_id: null, model_id: 'M1',
  compatible: true, changes: [{ field: 'tx_power_dbm', before: 20, after: 21, known: true }], patch: { tx_power_dbm: 21 },
  blocked_fields: ['status', 'alert', 'ports', 'current_work_mode', 'availability', 'observed_at'], warnings: ['候选尚未保存'] });
function setup(value: unknown) { const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value); return { request, api: createDeviceTraceHttp(request as AuthenticatedRequest) }; }
function detail(): TraceDetail {
  return { schema_version: schema, request_id: 'maintain-one', device_id: 'D1', kind: 'RESOURCE_CHANGE', base_revision: source,
    revision, created_at: '2026-10-23T10:00:00.000000Z', actor_id: 'editor', changed: true, changed_fields: ['tx_power_dbm'], data_origin: 'SYNTHETIC_INTEGRATION',
    before: { device_id: 'D1', tx_power_dbm: '20' }, after: { device_id: 'D1', tx_power_dbm: '21' },
    diffs: [{ field: 'tx_power_dbm', before: '20', after: '21', known: true }],
    source_files: { 'device.csv': { path: 'data/unit-test/device.csv', sha256: 'a'.repeat(64) } } };
}
describe('resource trace read-only HTTP', () => {
  it('reads a verified resource-change detail without changing frozen field values', async () => {
    const value = detail();
    expect(await setup(value).api.getOperation({ context: 'ledger', device_id: 'D1', resource_revision: revision, request_id: 'maintain-one' })).toEqual(value);
  });
  it.each([
    { changed_fields: null }, { changed_fields: [1] }, { changed_fields: ['other_field'] },
    { diffs: null }, { diffs: {} }, { diffs: [{ field: 'tx_power_dbm', before: '20', after: '21', known: 'true' }] },
    { source_files: null }, { source_files: [] }, { source_files: { 'device.csv': { path: 'http://untrusted', sha256: 'a'.repeat(64) } } },
  ])('rejects malformed unknown collections in a detail: %j', async patch => {
    await expect(setup({ ...detail(), ...patch }).api.getOperation({ context: 'ledger', device_id: 'D1', resource_revision: revision, request_id: 'maintain-one' }))
      .rejects.toMatchObject({ code: 'INVALID_DEVICE_TRACE_RESPONSE' });
  });
  it('accepts real retained baseline with null operation/actor, not fabricated history', async () => {
    const value = { schema_version: schema, items: [{ request_id: null, device_id: 'D1', kind: 'RETAINED_BASELINE', base_revision: null,
      revision: source, created_at: '2026-10-23T10:00:00.000000Z', actor_id: null, changed: false, changed_fields: [], data_origin: 'SYNTHETIC_INTEGRATION' }], total: 1, page: 1, page_size: 20 };
    expect(await setup(value).api.queryHistory({ context: 'ledger', device_id: 'D1', resource_revision: revision })).toEqual(value);
  });
  it('captures preview source before await and forwards abort without writing resource changes', async () => {
    let done!: (value: unknown) => void;
    const request = vi.fn<AuthenticatedRequest>().mockReturnValue(new Promise(resolve => { done = resolve; }));
    const api = createDeviceTraceHttp(request as AuthenticatedRequest), value = input(), control = new AbortController();
    const pending = api.previewRestore('D1', value, { signal: control.signal }); value.source_revision = revision;
    done(proposal()); expect(await pending).toEqual(proposal()); expect(request.mock.calls[0]?.[0]).toBe('/device-traces/D1/restore-preview');
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body as string)).toEqual(input()); expect(request.mock.calls[0]?.[1]?.signal).toBe(control.signal);
  });
  it.each([{ patch: { status: 'NORMAL' } }, { device_id: 'other' }, { base_revision: source }, { compatible: false }, { changes: null }, { changes: {} },
    { changes: [{ field: 'tx_power_dbm', before: 20, after: 22, known: true }] }])('rejects contaminated candidate %j', async patch => {
    await expect(setup({ ...proposal(), ...patch }).api.previewRestore('D1', input())).rejects.toMatchObject({ code: 'INVALID_DEVICE_TRACE_RESPONSE' });
  });
  it('rejects body/query extras before sending', async () => {
    const s = setup(proposal());
    await expect(s.api.previewRestore('D1', { ...input(), ports: [] } as never)).rejects.toThrow();
    await expect(s.api.queryHistory({ context: 'ledger', device_id: 'D1', resource_revision: revision, page: 0 })).rejects.toThrow();
    expect(s.request).not.toHaveBeenCalled();
  });
});
