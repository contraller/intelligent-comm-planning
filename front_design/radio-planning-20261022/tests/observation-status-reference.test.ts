import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ref, ssrContextKey, type App } from 'vue';
import Drawer from '../src/components/ObservationStatusReferenceDrawer.vue';
import { readObservationStatusReference, captureObservationStatusReference,
  type ObservationStatusReferenceServices, type ObservationStatusReferenceTarget } from '../src/services/observation-status-reference';
import type { DeviceStatusHeader, DeviceStatusItem } from '../src/types/device-status-snapshot';
import type { ObservationDeviceStatusRefResult } from '../src/types/observation';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'], setup: (props, { slots }) => () => props.visible
    ? h('aside', { 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null }) };
});
await clientTemplate(Drawer, 'src/components/ObservationStatusReferenceDrawer.vue', 'observation-status-reference-render.ts');

const resourceRevision = 'resource-' + '1'.repeat(16), currentResourceRevision = 'resource-' + '2'.repeat(16);
const snapshotId = 'DSS-' + 'a'.repeat(32), contentHash = 'b'.repeat(64);
const snapshotRevision = 'device-status-' + contentHash;
const deviceId = (index: number) => 'D' + String(index).padStart(4, '0');

function fixture(count = 2) {
  const target: ObservationStatusReferenceTarget = { datasetId: 'OBS-TEST', datasetRevision: 'observation-' + 'd'.repeat(64),
    ref: { snapshotId, snapshotRevision, resourceRevision, deviceIds: Array.from({ length: count }, (_, i) => deviceId(i)) } };
  const binding: ObservationDeviceStatusRefResult = { schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION',
    datasetId: target.datasetId, datasetRevision: target.datasetRevision, resourceRevision,
    deviceStatusRef: { ...structuredClone(target.ref), contentHash: 'c'.repeat(64), refRevision: 'OSR-' + 'c'.repeat(64) } };
  const header: DeviceStatusHeader = { schema_version: 'device-status-snapshot-a1', snapshot_id: snapshotId,
    snapshot_revision: snapshotRevision, content_hash: contentHash, resource_revision: resourceRevision,
    resource_content_hash: 'e'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION', source_label: 'Frozen historical source',
    provenance_note: 'Declared construction, not telemetry', imported_at: '2026-10-24T00:00:00Z', actor_id: 'actor-1',
    total: count + 3, counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: count + 3, total: count + 3 },
    first_observed_at: null, last_observed_at: null };
  const rows = new Map(target.ref.deviceIds.map(id => [id, { device_id: id, node_id: 'N-' + id, model_id: 'M1',
    observed_at: null, status: null, alert: null, unknown_reasons: ['Constructed source did not provide status'],
    availability: 'ACTIVE' } satisfies DeviceStatusItem]));
  const observations = { getObservationDeviceStatusRef: vi.fn<ObservationStatusReferenceServices['observations']['getObservationDeviceStatusRef']>(async () => structuredClone(binding)),
    importObservation: vi.fn(() => { throw new Error('write forbidden'); }), exportObservationDataset: vi.fn() };
  const statuses = {
    getSnapshot: vi.fn<ObservationStatusReferenceServices['deviceStatuses']['getSnapshot']>(async () => structuredClone(header)),
    queryDevices: vi.fn<ObservationStatusReferenceServices['deviceStatuses']['queryDevices']>(async query => {
      const row = rows.get(query.device_id!);
      return { schema_version: 'device-status-snapshot-a1', snapshot_id: snapshotId, snapshot_revision: snapshotRevision,
        resource_revision: resourceRevision, total: row ? 1 : 0, page: query.page ?? 1, page_size: query.page_size ?? 20,
        items: row ? [structuredClone(row)] : [] };
    }),
    importSnapshot: vi.fn(() => { throw new Error('write forbidden'); }),
  };
  const services: ObservationStatusReferenceServices = { observations, deviceStatuses: statuses };
  return { target, binding, header, rows, observations, statuses, services };
}
const read = (f: ReturnType<typeof fixture>, page = 1, signal = new AbortController().signal) =>
  readObservationStatusReference(f.services, f.target, page, signal);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('isolated observation status reference reads', () => {
  it('rechecks the dataset binding before the exact snapshot and only declared members, preserving unknowns', async () => {
    const f = fixture(), before = structuredClone(f.target), value = await read(f);
    expect(f.observations.getObservationDeviceStatusRef).toHaveBeenCalledExactlyOnceWith({ datasetId: f.target.datasetId,
      datasetRevision: f.target.datasetRevision, signal: expect.any(AbortSignal) });
    expect(f.statuses.getSnapshot).toHaveBeenCalledExactlyOnceWith({ context: 'ledger', snapshot_id: snapshotId,
      snapshot_revision: snapshotRevision }, { signal: expect.any(AbortSignal) });
    expect(value).toMatchObject({ target: before, header: f.header, total: 2, page: 1, pageSize: 20 });
    expect(value!.items.map(item => item.device_id)).toEqual(before.ref.deviceIds);
    expect(value!.items[0]).toMatchObject({ status: null, alert: null, observed_at: null });
    expect(f.target).toEqual(before); expect(f.observations.importObservation).not.toHaveBeenCalled();
    expect(f.statuses.importSnapshot).not.toHaveBeenCalled(); expect(f.observations.exportObservationDataset).not.toHaveBeenCalled();
  });
  it('uses member pagination, never snapshot totals or current resource IDs as the member list', async () => {
    const f = fixture(23);
    expect((await read(f))!.items).toHaveLength(20);
    f.statuses.queryDevices.mockClear();
    const value = await read(f, 2);
    expect(value!.items.map(row => row.device_id)).toEqual(['D0020', 'D0021', 'D0022']);
    expect(value!.total).toBe(23); expect(value!.header.total).toBe(26);
    expect(f.statuses.queryDevices).toHaveBeenCalledTimes(3);
    expect(f.observations.getObservationDeviceStatusRef).toHaveBeenCalledTimes(2);
  });
  it('sorts a copy of declared IDs without mutating the clicked reference', async () => {
    const f = fixture(); f.target.ref.deviceIds.reverse();
    expect((await read(f))!.items.map(row => row.device_id)).toEqual(['D0000', 'D0001']);
    expect(f.target.ref.deviceIds).toEqual(['D0001', 'D0000']);
  });
  it.each(['dataset', 'datasetRevision', 'resource', 'snapshot', 'snapshotRevision', 'member', 'extraMember', 'duplicate', 'wireHash', 'unbound'])(
    'fails closed for changed or damaged dataset binding: %s', async kind => {
      const f = fixture();
      if (kind === 'dataset') f.binding.datasetId = 'OTHER';
      if (kind === 'datasetRevision') f.binding.datasetRevision = 'observation-' + 'f'.repeat(64);
      if (kind === 'resource') f.binding.resourceRevision = currentResourceRevision;
      if (kind === 'snapshot') f.binding.deviceStatusRef!.snapshotId = 'DSS-' + 'f'.repeat(32);
      if (kind === 'snapshotRevision') f.binding.deviceStatusRef!.snapshotRevision = 'device-status-' + 'f'.repeat(64);
      if (kind === 'member') f.binding.deviceStatusRef!.deviceIds = ['D0000'];
      if (kind === 'extraMember') f.binding.deviceStatusRef!.deviceIds.push('D0002');
      if (kind === 'duplicate') f.binding.deviceStatusRef!.deviceIds = ['D0000', 'D0000'];
      if (kind === 'wireHash') f.binding.deviceStatusRef!.contentHash = 'invalid';
      if (kind === 'unbound') f.binding.deviceStatusRef = null;
      await expect(read(f)).rejects.toBeInstanceOf(Error);
      expect(f.statuses.getSnapshot).not.toHaveBeenCalled(); expect(f.statuses.queryDevices).not.toHaveBeenCalled();
    },
  );
  it.each(['snapshot', 'snapshotRevision', 'resource', 'contentHash', 'tooFewRecords'])(
    'rejects a changed snapshot header: %s', async kind => {
      const f = fixture();
      if (kind === 'snapshot') f.header.snapshot_id = 'DSS-' + 'f'.repeat(32);
      if (kind === 'snapshotRevision') f.header.snapshot_revision = 'device-status-' + 'f'.repeat(64);
      if (kind === 'resource') f.header.resource_revision = currentResourceRevision;
      if (kind === 'contentHash') f.header.content_hash = 'f'.repeat(64);
      if (kind === 'tooFewRecords') { f.header.total = 1; f.header.counts = { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 1, total: 1 }; }
      await expect(read(f)).rejects.toBeInstanceOf(Error); expect(f.statuses.queryDevices).not.toHaveBeenCalled();
    },
  );
  it.each(['missing', 'device', 'snapshot', 'snapshotRevision', 'resource', 'total', 'page', 'unknownWithoutReason'])(
    'rejects damaged member data rather than substituting unknown rows: %s', async kind => {
      const f = fixture(), query = f.statuses.queryDevices.getMockImplementation()!;
      f.statuses.queryDevices.mockImplementation(async (input, options) => {
        const value = await query(input, options);
        if (kind === 'missing') { value.total = 0; value.items = []; }
        if (kind === 'device') value.items[0]!.device_id = 'OTHER';
        if (kind === 'snapshot') value.snapshot_id = 'DSS-' + 'f'.repeat(32);
        if (kind === 'snapshotRevision') value.snapshot_revision = 'device-status-' + 'f'.repeat(64);
        if (kind === 'resource') value.resource_revision = currentResourceRevision;
        if (kind === 'total') value.total = 2;
        if (kind === 'page') value.page = 2;
        if (kind === 'unknownWithoutReason') value.items[0]!.unknown_reasons = [];
        return value;
      });
      await expect(read(f)).rejects.toBeInstanceOf(Error);
    },
  );
  it.each([0, -1, 1.5, 2, NaN])('rejects invalid member page %s without requests', async page => {
    const f = fixture(); await expect(read(f, page)).rejects.toBeInstanceOf(Error);
    expect(f.observations.getObservationDeviceStatusRef).not.toHaveBeenCalled();
  });
  it('rejects malformed targets instead of accepting extra fields or duplicate IDs', () => {
    const f = fixture();
    expect(() => captureObservationStatusReference({ ...f.target, extra: true } as ObservationStatusReferenceTarget)).toThrow();
    f.target.ref.deviceIds.push('D0000'); expect(() => captureObservationStatusReference(f.target)).toThrow();
  });
  it('freezes target fields before awaiting and returns detached result records', async () => {
    const f = fixture(), pending = deferred<ObservationDeviceStatusRefResult>(), original = structuredClone(f.target);
    f.observations.getObservationDeviceStatusRef.mockReturnValueOnce(pending.promise);
    const request = read(f); f.target.ref.deviceIds.push('OTHER'); f.target.ref.resourceRevision = currentResourceRevision;
    pending.resolve(structuredClone(f.binding));
    const result = (await request)!; expect(result.target).toEqual(original);
    result.items[0]!.unknown_reasons.push('local'); result.reference.deviceIds.push('local');
    expect(f.rows.get('D0000')!.unknown_reasons).not.toContain('local');
    expect(f.binding.deviceStatusRef!.deviceIds).not.toContain('local');
  });
  it('limits parallel member queries to four', async () => {
    const f = fixture(20), original = f.statuses.queryDevices.getMockImplementation()!;
    let running = 0, maximum = 0;
    f.statuses.queryDevices.mockImplementation(async (query, options) => {
      running++; maximum = Math.max(maximum, running);
      await Promise.resolve(); const result = await original(query, options); running--; return result;
    });
    expect((await read(f))!.items).toHaveLength(20); expect(maximum).toBe(4);
  });
  it.each(['before', 'binding', 'header', 'members'])('stops after cancellation during %s', async phase => {
    const f = fixture(), control = new AbortController();
    if (phase === 'before') control.abort();
    if (phase === 'binding') f.observations.getObservationDeviceStatusRef.mockImplementation(async () => { control.abort(); return structuredClone(f.binding); });
    if (phase === 'header') f.statuses.getSnapshot.mockImplementation(async () => { control.abort(); return structuredClone(f.header); });
    if (phase === 'members') {
      const original = f.statuses.queryDevices.getMockImplementation()!;
      f.statuses.queryDevices.mockImplementation(async (query, options) => { control.abort(); return original(query, options); });
    }
    expect(await read(f, 1, control.signal)).toBeNull();
    if (phase === 'before') expect(f.observations.getObservationDeviceStatusRef).not.toHaveBeenCalled();
    if (phase === 'binding' || phase === 'before') expect(f.statuses.getSnapshot).not.toHaveBeenCalled();
    if (phase !== 'members') expect(f.statuses.queryDevices).not.toHaveBeenCalled();
  });
  it('aborts peer member reads on failure, with no partially successful page', async () => {
    const f = fixture(20), original = f.statuses.queryDevices.getMockImplementation()!;
    f.statuses.queryDevices.mockImplementation(async (query, options) => {
      if (query.device_id === 'D0000') throw new Error('member forbidden');
      return original(query, options);
    });
    await expect(read(f)).rejects.toThrow('member forbidden');
    expect(f.statuses.queryDevices.mock.calls.every(([, options]) => options!.signal!.aborted)).toBe(true);
  });
  it('keeps backend failures as failures, without fallback to current status', async () => {
    const f = fixture(); f.observations.getObservationDeviceStatusRef.mockRejectedValue(new Error('FORBIDDEN'));
    await expect(read(f)).rejects.toThrow('FORBIDDEN'); expect(f.statuses.getSnapshot).not.toHaveBeenCalled();
  });
});

let app: App<HostNode> | undefined;
beforeEach(() => {
  class TestDocument { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => { app?.unmount(); app = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(f = fixture(), overrides: Partial<{ visible: boolean; canView: boolean; target: ObservationStatusReferenceTarget | null }> = {}) {
  const props = reactive({ visible: true, target: f.target as ObservationStatusReferenceTarget | null, services: f.services,
    canView: true, sessionGeneration: 'session-1', currentResourceRevision, ...overrides });
  const panel = ref<InstanceType<typeof Drawer> | null>(null), busy = vi.fn(), closed = vi.fn(), root = node('root');
  app = renderer.createApp({ render: () => h(Drawer, { ...props, ref: panel, 'onBusy-change': busy,
    'onUpdate:visible': (value: boolean) => { closed(value); props.visible = value; } }) });
  app.provide(ssrContextKey, {}); app.mount(root);
  return { f, props, panel, busy, closed, root };
}
const ready = async (root: HostNode) => { await vi.waitFor(() => expect(find(root, n => n.tag === 'table')).toBeDefined()); await nextTick(); };
const button = (root: HostNode, label: string) => find(root, n => n.tag === 'button' && (n.props['aria-label'] === label || textOf(n) === label))!;

describe('actual isolated reference drawer template and lifecycle', () => {
  it('renders historical provenance, only declared members and real null values without any write controls', async () => {
    const s = mount(); await ready(s.root);
    const text = textOf(s.root);
    expect(text).toContain('历史资源快照 · 只读'); expect(text).toContain(resourceRevision); expect(text).not.toContain(currentResourceRevision);
    expect(text).toContain('声明成员 2 台 · 完整快照 5 台'); expect(text).toContain('非真实遥测');
    expect(text).toContain('未知'); expect(text).toContain('N-D0000');
    expect(text).not.toContain('保存'); expect(text).not.toContain('导入状态');
    expect(s.f.observations.importObservation).not.toHaveBeenCalled(); expect(s.f.statuses.importSnapshot).not.toHaveBeenCalled();
  });
  it.each([{ visible: false }, { canView: false }, { target: null }])('does not query without a visible authorized target: %j', async overrides => {
    const s = mount(fixture(), overrides); await nextTick();
    expect(s.f.observations.getObservationDeviceStatusRef).not.toHaveBeenCalled();
    expect(find(s.root, n => n.tag === 'table')).toBeUndefined();
  });
  it('reads a new binding for the next member page and never includes undeclared snapshot members', async () => {
    const s = mount(fixture(23)); await ready(s.root);
    (button(s.root, '下一页引用成员').props.onClick as () => void)();
    await vi.waitFor(() => expect(textOf(s.root)).toContain('D0022'));
    const table = find(s.root, n => n.tag === 'table')!;
    expect(textOf(table)).not.toContain('D0000'); expect(textOf(table)).toContain('D0020');
    expect(s.f.observations.getObservationDeviceStatusRef).toHaveBeenCalledTimes(2);
  });
  it.each(['session', 'permission', 'close', 'leave', 'unmount'])('aborts %s and rejects late responses', async phase => {
    const f = fixture(), pending = deferred<ObservationDeviceStatusRefResult>();
    f.observations.getObservationDeviceStatusRef.mockReturnValueOnce(pending.promise);
    const s = mount(f), signal = f.observations.getObservationDeviceStatusRef.mock.calls[0]![0].signal!;
    if (phase === 'session') s.props.sessionGeneration = 'session-2';
    if (phase === 'permission') s.props.canView = false;
    if (phase === 'close') s.props.visible = false;
    if (phase === 'leave') expect(await s.panel.value!.requestLeave()).toBe(true);
    if (phase === 'unmount') { app!.unmount(); app = undefined; }
    await nextTick(); expect(signal.aborted).toBe(true);
    pending.resolve(structuredClone(f.binding)); await nextTick(); await nextTick();
    expect(f.statuses.getSnapshot).not.toHaveBeenCalled(); expect(textOf(s.root)).not.toContain('Frozen historical source');
    expect(s.busy).toHaveBeenLastCalledWith(false);
  });
  it('only renders the latest target when the previous dataset responds late', async () => {
    const f = fixture(), pending = deferred<ObservationDeviceStatusRefResult>();
    f.observations.getObservationDeviceStatusRef.mockReturnValueOnce(pending.promise);
    const s = mount(f), oldSignal = f.observations.getObservationDeviceStatusRef.mock.calls[0]![0].signal!;
    const next = structuredClone(f.target); next.datasetId = 'OBS-NEXT';
    f.observations.getObservationDeviceStatusRef.mockImplementation(async () => ({ ...structuredClone(f.binding), datasetId: 'OBS-NEXT' }));
    s.props.target = next; await ready(s.root);
    pending.resolve(structuredClone(f.binding)); await nextTick(); await nextTick();
    expect(oldSignal.aborted).toBe(true); expect(textOf(s.root)).toContain('OBS-NEXT'); expect(textOf(s.root)).not.toContain('OBS-TEST');
  });
  it('changing service identity aborts the old request instead of accepting its data', async () => {
    const f = fixture(), pending = deferred<ObservationDeviceStatusRefResult>();
    f.observations.getObservationDeviceStatusRef.mockReturnValueOnce(pending.promise);
    const s = mount(f), signal = f.observations.getObservationDeviceStatusRef.mock.calls[0]![0].signal!, next = fixture();
    next.header.source_label = 'Replacement source'; s.props.services = next.services;
    await ready(s.root); pending.resolve(structuredClone(f.binding)); await nextTick();
    expect(signal.aborted).toBe(true); expect(textOf(s.root)).toContain('Replacement source');
  });
  it('same-value target reconstruction does not restart a verified read', async () => {
    const s = mount(); await ready(s.root);
    s.props.target = structuredClone(s.f.target); await nextTick();
    expect(s.f.observations.getObservationDeviceStatusRef).toHaveBeenCalledTimes(1);
  });
  it('a current resource label change cannot rebind the frozen snapshot', async () => {
    const s = mount(); await ready(s.root);
    s.props.currentResourceRevision = resourceRevision; await nextTick();
    expect(textOf(s.root)).not.toContain('历史资源快照'); expect(s.f.observations.getObservationDeviceStatusRef).toHaveBeenCalledTimes(1);
    expect(s.f.statuses.getSnapshot.mock.calls[0]![0].snapshot_id).toBe(snapshotId);
  });
  it('a failed read is not rendered as unbound or an empty successful page, and can be explicitly retried', async () => {
    const f = fixture(); f.observations.getObservationDeviceStatusRef.mockRejectedValueOnce(new Error('FORBIDDEN'));
    const s = mount(f); await vi.waitFor(() => expect(textOf(s.root)).toContain('FORBIDDEN'));
    expect(all(s.root, n => n.tag === 'table')).toHaveLength(0);
    (button(s.root, '重新核验').props.onClick as () => void)(); await ready(s.root);
    expect(textOf(s.root)).not.toContain('FORBIDDEN');
  });
});
