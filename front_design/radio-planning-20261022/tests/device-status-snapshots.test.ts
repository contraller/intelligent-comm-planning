import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { useResourceStatusStore } from '../src/stores/resource-status';
import type { DeviceStatusClient } from '../src/services/device-status-http';
import { deviceStatusSchema as schema, type DeviceStatusHeader, type DeviceStatusItem, type StatusPage } from '../src/types/device-status-snapshot';
import { watch } from 'vue';
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
  it('cancels a generation-bound list request without treating the new number as an owner key', async () => {
    const { status, client, auth } = setup(); let done!: (value: StatusPage<DeviceStatusHeader>) => void;
    client.listSnapshots.mockImplementationOnce(() => new Promise<StatusPage<DeviceStatusHeader>>(resolve => { done = resolve; }));
    const pending = status.list(), signal = client.listSnapshots.mock.calls.at(-1)?.[1]?.signal;
    auth.generation++;
    done({ schema_version: schema, items: [header], total: 1, page: 1, page_size: 20 }); await pending;
    expect(signal?.aborted).toBe(true); expect(status.snapshots).toBeNull(); expect(status.busy).toBe(false);
  });
  it('keeps the complete old selection when a new header succeeds but its details fail', async () => {
    const { status, client } = setup(); await status.select(header);
    const old = { batch: status.batch, details: status.batchDetails, records: status.snapshotRecords, appliedAt: status.appliedAt };
    const next = { ...header, snapshot_id: 'DSS-' + 'd'.repeat(32), snapshot_revision: 'device-status-' + 'e'.repeat(64), content_hash: 'e'.repeat(64) };
    client.getSnapshot.mockResolvedValueOnce(next); client.queryDevices.mockRejectedValueOnce(new Error('details unavailable'));
    await status.select(next);
    expect(status.batch).toBe(old.batch); expect(status.batchDetails).toBe(old.details); expect(status.snapshotRecords).toBe(old.records);
    expect(status.appliedAt).toBe(old.appliedAt); expect(status.error).toBe('details unavailable');
    client.queryDevices.mockRejectedValueOnce(new Error('filter unavailable')); await status.setFilter('FAULT');
    expect(status.filter).toBe('ALL'); expect(status.batchDetails).toBe(old.details);
  });
  it('does not publish a header or partial page to synchronous consumers', async () => {
    const { status } = setup(), observed: number[] = [];
    const stop = watch(() => status.batch, value => { if (value) observed.push(Object.keys(status.snapshotRecords).length); }, { flush: 'sync' });
    await status.select(header); stop(); expect(observed).toEqual([1]);
  });
});

function fullSnapshot(total = 414) {
  const next: DeviceStatusHeader = { ...header, snapshot_id: 'DSS-' + 'd'.repeat(32), snapshot_revision: 'device-status-' + 'e'.repeat(64), content_hash: 'e'.repeat(64),
    imported_at: '2026-10-24T10:00:00.000000Z', total, counts: { NORMAL: total - 1, FAULT: 1, OFFLINE: 0, UNKNOWN: 0, total } };
  const items: DeviceStatusItem[] = Array.from({ length: total }, (_, i) => ({ ...item, device_id: 'D' + String(i + 1).padStart(4, '0'), status: i ? 'NORMAL' : 'FAULT', alert: false }));
  return { next, items };
}
function serveFull(client: ReturnType<typeof setup>['client'], total = 414) {
  const f = fullSnapshot(total);
  client.listSnapshots.mockResolvedValue({ schema_version: schema, items: [f.next, header], total: 2, page: 1, page_size: 20 });
  client.getSnapshot.mockResolvedValue(f.next);
  client.queryDevices.mockImplementation(async query => ({ schema_version: schema, snapshot_id: f.next.snapshot_id, snapshot_revision: f.next.snapshot_revision, resource_revision: revision,
    total, page: query.page ?? 1, page_size: query.page_size ?? 20, items: f.items.slice(((query.page ?? 1) - 1) * (query.page_size ?? 20), (query.page ?? 1) * (query.page_size ?? 20)) }));
  return f;
}
describe('explicit same-resource latest following', () => {
  it('defaults to fixed and never reads latest until explicitly enabled', async () => {
    const { status, client } = setup(); expect(status.refreshMode).toBe('fixed');
    expect(await status.followLatest()).toBe(false); expect(client.listSnapshots).not.toHaveBeenCalled();
  });
  it('reads page one and all 414 records before publishing, using at most 100 rows per page', async () => {
    const { status, client } = setup(); const f = serveFull(client); status.snapshots = { schema_version: schema, items: [header], total: 21, page: 2, page_size: 20 };
    status.setRefreshMode('latest'); const observed: number[] = [];
    const stop = watch(() => status.batch, value => { if (value) observed.push(Object.keys(status.snapshotRecords).length); }, { flush: 'sync' });
    expect(await status.followLatest()).toBe(true); stop();
    expect(client.listSnapshots).toHaveBeenCalledWith({ context: 'ledger', resource_revision: revision, page: 1, page_size: 20 }, expect.anything());
    expect(client.queryDevices).toHaveBeenCalledTimes(5); expect(client.queryDevices.mock.calls.map(([q]) => [q.page, q.page_size])).toEqual([[1,100],[2,100],[3,100],[4,100],[5,100]]);
    expect(observed).toEqual([414]); expect(status.complete).toBe(true); expect(status.project('D0414', revision)?.status).toBe('NORMAL');
    expect(status.batch?.snapshot_revision).toBe(f.next.snapshot_revision); expect(status.batchDetails?.items).toHaveLength(20);
    expect(status.checkedAt).toBeTruthy(); expect(status.appliedAt).toBeTruthy(); expect(status.snapshots.page).toBe(2);
    const appliedAt = status.appliedAt; expect(await status.followLatest()).toBe(true); expect(status.appliedAt).toBe(appliedAt); expect(client.queryDevices).toHaveBeenCalledTimes(5);
  });
  it('also loads a fixed GIS selection in full and keeps it fixed', async () => {
    const { status, client } = setup(), f = serveFull(client);
    await status.select(f.next, { complete: true }); expect(Object.keys(status.snapshotRecords)).toHaveLength(414); expect(status.refreshMode).toBe('fixed');
    expect(await status.followLatest()).toBe(false);
  });
  it.each(['page-failure', 'duplicate', 'revision', 'total', 'statistics'] as const)('retains all old data and reports a %s failure', async failure => {
    const { status, client } = setup(); await status.select(header); const before = { batch: status.batch, records: status.snapshotRecords, appliedAt: status.appliedAt };
    const f = serveFull(client);
    if (failure === 'statistics') client.getSnapshot.mockResolvedValue({ ...f.next, counts: { ...f.next.counts, NORMAL: 414, FAULT: 0 } });
    const original = client.queryDevices.getMockImplementation()!;
    client.queryDevices.mockImplementation(async query => {
      if (query.page === 2 && failure === 'page-failure') throw new Error('second page failed');
      const page = await original(query);
      if (query.page === 2 && failure === 'duplicate') page.items = f.items.slice(0, 100);
      if (query.page === 2 && failure === 'revision') page.resource_revision = 'resource-2222222222222222';
      if (failure === 'total') page.total = 415;
      return page;
    });
    status.setRefreshMode('latest'); expect(await status.followLatest()).toBe(false);
    expect(status.batch).toBe(before.batch); expect(status.snapshotRecords).toBe(before.records); expect(status.appliedAt).toBe(before.appliedAt);
    expect(status.followError).toBeTruthy(); expect(status.checkedAt).toBe('');
  });
  it('bounds a maximal 1000-record batch to ten pages and rejects an oversized header', async () => {
    const { status, client } = setup(); serveFull(client, 1000); status.setRefreshMode('latest');
    expect(await status.followLatest()).toBe(true); expect(client.queryDevices).toHaveBeenCalledTimes(10);
    client.listSnapshots.mockResolvedValueOnce({ schema_version: schema, items: [{ ...header, total: 1001, counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 1001, total: 1001 } }], total: 1, page: 1, page_size: 20 });
    expect(await status.followLatest()).toBe(false); expect(client.queryDevices).toHaveBeenCalledTimes(10);
  });
  it.each(['signal', 'permission', 'revision', 'generation', 'fixed', 'gate', 'pending'] as const)('discards late full data after %s changes', async change => {
    const { status, client, auth } = setup(); await status.select(header); serveFull(client);
    let done!: (value: DeviceStatusHeader) => void; const latest = fullSnapshot().next;
    client.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    let eligible = true; const controller = new AbortController(); status.setRefreshMode('latest');
    const pending = status.followLatest(controller.signal, () => eligible);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const beforeCalls = client.queryDevices.mock.calls.length;
    if (change === 'signal') controller.abort();
    if (change === 'permission') auth.identity = { ...auth.identity!, permissions: [] };
    if (change === 'revision') status.bind(client, 'resource-2222222222222222');
    if (change === 'generation') auth.generation++;
    if (change === 'fixed') status.setRefreshMode('fixed');
    if (change === 'gate') eligible = false;
    if (change === 'pending') status.pendingImport = {} as never;
    done(latest); expect(await pending).toBe(false); expect(status.batch?.snapshot_id).not.toBe(latest.snapshot_id);
    expect(client.queryDevices).toHaveBeenCalledTimes(beforeCalls);
  });
  it('merges no overlapping latest reads and permits a retry after failure', async () => {
    const { status, client } = setup(); serveFull(client); status.setRefreshMode('latest');
    const first = status.followLatest(); expect(await status.followLatest()).toBe(false); expect(await first).toBe(true);
    client.listSnapshots.mockRejectedValueOnce(new Error('offline')); expect(await status.followLatest()).toBe(false);
    expect(status.followError).toBe('offline'); expect(await status.followLatest()).toBe(true); expect(status.followError).toBe('');
  });
});
