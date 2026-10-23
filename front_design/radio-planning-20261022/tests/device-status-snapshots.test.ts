import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { useResourceStatusStore } from '../src/stores/resource-status';
import type { DeviceStatusClient } from '../src/services/device-status-http';
import { deviceStatusSchema as schema, type DeviceStatusHeader } from '../src/types/device-status-snapshot';
const revision = 'resource-1111111111111111';
const header: DeviceStatusHeader = { schema_version: schema, snapshot_id: 'DSS-' + 'a'.repeat(32), snapshot_revision: 'device-status-' + 'b'.repeat(64),
  content_hash: 'b'.repeat(64), resource_revision: revision, resource_content_hash: 'c'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION',
  source_label: '来源明确的构造批次', provenance_note: '非真实上报', imported_at: '2026-10-23T10:00:00.000000Z', actor_id: 'editor', total: 1,
  counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 1, total: 1 }, first_observed_at: null, last_observed_at: null };
const item = { device_id: 'D1', node_id: 'N1', model_id: 'M1', status: null, alert: null, observed_at: null,
  unknown_reasons: ['来源未提供状态和采集时间'], availability: 'OFF_SHELF' as const };
let pinia: ReturnType<typeof createPinia>;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
function setup() {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const client = { listSnapshots: vi.fn().mockResolvedValue({ schema_version: schema, items: [header], total: 1, page: 1, page_size: 20 }),
    getSnapshot: vi.fn().mockResolvedValue(header), queryDevices: vi.fn().mockResolvedValue({ schema_version: schema, snapshot_id: header.snapshot_id,
      snapshot_revision: header.snapshot_revision, resource_revision: revision, items: [item], total: 1, page: 1, page_size: 20 }),
    importSnapshot: vi.fn(), getImport: vi.fn() } satisfies DeviceStatusClient;
  const status = useResourceStatusStore(); status.bind(client, revision); return { status, client, auth };
}
describe('immutable status snapshot selection', () => {
  it('projects only actually read same-version records and preserves all unknowns', async () => {
    const { status } = setup(); await status.list(); expect(status.project('D1', revision)).toBeNull();
    await status.select(header);
    expect(status.project('D1', revision)).toMatchObject({ ref: { snapshotId: header.snapshot_id, resourceRevision: revision, deviceId: 'D1' }, status: null, alert: null, observedAt: null });
    expect(status.project('missing', revision)).toBeNull(); expect(status.project('D1', 'other')).toBeNull();
    const display = status.display({ id: 'D1', status: 'NORMAL', alert: false }); expect(display.status).toBeNull(); expect(display.observedAt).toBeUndefined();
    expect(display.note).toContain('非真实遥测'); expect(status.records).toEqual({});
  });
  it('filters and pages on the server, not the currently visible resources', async () => {
    const { status, client } = setup(); await status.select(header); await status.setFilter('UNKNOWN');
    expect(client.queryDevices).toHaveBeenLastCalledWith(expect.objectContaining({ snapshot_id: header.snapshot_id, status_filter: 'UNKNOWN', page: 1 }), expect.anything());
  });
  it('historical revision stays frozen and imports are disabled unless explicitly allowed', async () => {
    const { status, client, auth } = setup(); (auth.identity!.permissions as string[]).push('resources.device.status.import');
    expect(status.importable).toBe(false); await status.list(); expect(client.listSnapshots).toHaveBeenCalledWith(expect.objectContaining({ resource_revision: revision }), expect.anything());
    status.bind(client, revision, true); expect(status.importable).toBe(true);
    status.bind(client, 'resource-2222222222222222'); expect(status.importable).toBe(false); expect(status.batch).toBeNull();
  });
  it('ignores canceled late batches after account change', async () => {
    const { status, client, auth } = setup(); let done!: (value: unknown) => void;
    client.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = status.select(header); auth.identity = { ...auth.identity!, id: 'other', sessionId: 'other' };
    done(header); await pending; expect(status.batch).toBeNull(); expect(client.queryDevices).not.toHaveBeenCalled();
  });
});
