import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createDeviceStatusHttp } from '../src/services/device-status-http';
import { deviceStatusSchema as schema, type DeviceStatusHeader, type DeviceStatusImport } from '../src/types/device-status-snapshot';
const revision = 'resource-1111111111111111', snapshot_id = 'DSS-' + 'a'.repeat(32), snapshot_revision = 'device-status-' + 'b'.repeat(64);
function input(): DeviceStatusImport { return { schema_version: schema, context: 'ledger', request_id: 'status-one', base_revision: revision,
  data_origin: 'SYNTHETIC_INTEGRATION', source_label: '构造来源', provenance_note: '没有真实上报',
  records: [{ device_id: 'D1', node_id: 'N1', model_id: 'M1', status: null, alert: null, observed_at: null, unknown_reasons: ['原始来源未提供'] }] }; }
const receipt = () => ({ schema_version: schema, request_id: 'status-one', snapshot_id, snapshot_revision, resource_revision: revision,
  imported_at: '2026-10-23T10:00:00.000000Z', total: 1, content_hash: 'b'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION' });
const header = (): DeviceStatusHeader => ({ ...receipt(), resource_content_hash: 'c'.repeat(64), source_label: '构造来源', provenance_note: '没有真实上报',
  actor_id: 'editor', counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 1, total: 1 }, first_observed_at: null, last_observed_at: null,
  // request_id 不属于 Header，下面的测试使用精确挑选的对象。
} as DeviceStatusHeader);
function cleanHeader() { const { request_id: _, ...row } = header() as DeviceStatusHeader & { request_id: string }; return row; }
function setup(value: unknown) { const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value); return { request, api: createDeviceStatusHttp(request as AuthenticatedRequest) }; }
describe('persisted device status HTTP', () => {
  it('posts only explicit original input and binds to the captured copy across await', async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn<AuthenticatedRequest>().mockReturnValue(new Promise(done => { resolve = done; }));
    const api = createDeviceStatusHttp(request as AuthenticatedRequest), value = input(), control = new AbortController();
    const pending = api.importSnapshot(value, { signal: control.signal }); value.base_revision = 'other'; value.records.push({ ...value.records[0]!, device_id: 'D2' });
    resolve(receipt()); expect(await pending).toEqual(receipt());
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string)).toEqual(input()); expect(request.mock.calls[0]![1]?.signal).toBe(control.signal);
  });
  it('keeps unknown values and never replaces missing capture time with import time', async () => {
    const row = { schema_version: schema, snapshot_id, snapshot_revision, resource_revision: revision,
      items: [{ ...input().records[0], availability: 'ACTIVE' }], total: 1, page: 1, page_size: 20 };
    const s = setup(row), result = await s.api.queryDevices({ context: 'ledger', snapshot_id, snapshot_revision, status_filter: 'UNKNOWN' });
    expect(result.items[0]?.observed_at).toBeNull(); expect(result.items[0]?.status).toBeNull();
  });
  it.each([{ data_origin: 'REAL' }, { records: [] }, { source_label: ' ' }, { request_id: 'bad/id' },
    { records: [{ ...input().records[0], observed_at: '2026-02-31T00:00:00Z' }] },
    { records: [{ ...input().records[0], unknown_reasons: [] }] }])('rejects unagreed input before network %j', async patch => {
    const s = setup(receipt()); await expect(s.api.importSnapshot({ ...input(), ...patch } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(s.request).not.toHaveBeenCalled();
  });
  it('validates header identity/counts and query pagination', async () => {
    const good = cleanHeader(); expect(await setup(good).api.getSnapshot({ context: 'ledger', snapshot_id, snapshot_revision })).toEqual(good);
    await expect(setup({ ...good, counts: { ...good.counts, NORMAL: 1 } }).api.getSnapshot({ context: 'ledger', snapshot_id, snapshot_revision })).rejects.toThrow();
    await expect(setup({ schema_version: schema, items: [good], total: 2, page: 1, page_size: 20 }).api.listSnapshots({ context: 'ledger' })).rejects.toThrow();
    await expect(setup(receipt()).api.getImport({ context: 'ledger', request_id: 'other' })).rejects.toThrow();
  });
});
