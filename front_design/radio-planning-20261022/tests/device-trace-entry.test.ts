import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref, shallowRef } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { useDeviceTrace } from '../src/composables/useDeviceTrace';
import type { DeviceTraceClient } from '../src/services/device-trace-http';
import { deviceTraceSchema as schema, type TraceSummary, type TraceDetail, type RestoreProposal, type TracePage } from '../src/types/device-trace';
let pinia: ReturnType<typeof createPinia>;
afterEach(() => { if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
it('target changes cancel old history, never substitute a current revision', async () => {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const target = ref({ device_id: 'D1', resource_revision: 'resource-1111111111111111', readable: true, editable: false });
  let done!: (value: unknown) => void;
  const client = { queryHistory: vi.fn().mockReturnValue(new Promise(resolve => { done = resolve; })), getOperation: vi.fn(), previewRestore: vi.fn() } satisfies DeviceTraceClient;
  const scope = effectScope(), trace = scope.run(() => useDeviceTrace(() => target.value, () => client))!;
  const pending = trace.query(); const signal = client.queryHistory.mock.calls[0]?.[1]?.signal;
  target.value = { ...target.value, device_id: 'D2' }; done({ items: [], total: 0, page: 1, page_size: 20 }); await pending;
  expect(signal?.aborted).toBe(true); expect(trace.history.value).toBeNull(); expect(client.previewRestore).not.toHaveBeenCalled(); scope.stop();
});
const revision = 'resource-1111111111111111';
function baseline(sourceRevision: string): TraceSummary {
  return { device_id: 'D1', revision: sourceRevision, request_id: null, kind: 'RETAINED_BASELINE', base_revision: null,
    created_at: '2026-10-23T10:00:00Z', actor_id: null, changed: false, changed_fields: [], data_origin: 'SYNTHETIC_INTEGRATION' };
}
it('a new baseline selection invalidates a late detail for the previous operation', async () => {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const operation: TraceSummary = { ...baseline('resource-2222222222222222'), request_id: 'trace-op-1', kind: 'RESOURCE_CHANGE',
    base_revision: 'resource-3333333333333333', actor_id: 'editor', changed: true, changed_fields: ['tx_power_dbm'] };
  let done!: (value: TraceDetail) => void;
  const client = { queryHistory: vi.fn(), getOperation: vi.fn().mockImplementation(() => new Promise<TraceDetail>(resolve => { done = resolve; })), previewRestore: vi.fn() } satisfies DeviceTraceClient;
  const scope = effectScope(), trace = scope.run(() => useDeviceTrace(() => ({ device_id: 'D1', resource_revision: revision, readable: true, editable: true }), () => client))!;
  const reading = trace.select(operation), signal = client.getOperation.mock.calls[0]?.[1]?.signal;
  const next = baseline('resource-4444444444444444'); await trace.select(next);
  done({ ...operation, schema_version: schema, before: { tx_power_dbm: '20' }, after: { tx_power_dbm: '21' },
    diffs: [{ field: 'tx_power_dbm', before: '20', after: '21', known: true }], source_files: { 'device.csv': { path: 'data/device.csv', sha256: 'a'.repeat(64) } } });
  await reading;
  expect(signal?.aborted).toBe(true); expect(trace.selected.value).toEqual(next); expect(trace.detail.value).toBeNull(); expect(trace.restore.value).toBeNull(); scope.stop();
});
it('a new historical selection rejects a late restore proposal for the old source', async () => {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore(); let done!: (value: RestoreProposal) => void;
  const client = { queryHistory: vi.fn(), getOperation: vi.fn(), previewRestore: vi.fn().mockImplementation(() => new Promise<RestoreProposal>(resolve => { done = resolve; })) } satisfies DeviceTraceClient;
  const scope = effectScope(), trace = scope.run(() => useDeviceTrace(() => ({ device_id: 'D1', resource_revision: revision, readable: true, editable: true }), () => client))!;
  const first = baseline('resource-2222222222222222'); await trace.select(first);
  const previewing = trace.preview(), signal = client.previewRestore.mock.calls[0]?.[2]?.signal;
  const next = baseline('resource-3333333333333333'); await trace.select(next);
  done({ schema_version: schema, device_id: 'D1', base_revision: revision, source_revision: first.revision, source_request_id: null, model_id: 'M1', compatible: true,
    changes: [{ field: 'tx_power_dbm', before: 20, after: 21, known: true }], patch: { tx_power_dbm: 21 }, blocked_fields: [], warnings: [] });
  await previewing;
  expect(signal?.aborted).toBe(true); expect(trace.selected.value).toEqual(next); expect(trace.restore.value).toBeNull(); scope.stop();
});
it('service replacement cancels reads and clears the previous source', async () => {
  pinia = createPinia(); setActivePinia(pinia); authorizeStore(); let done!: (value: TracePage) => void;
  const first = { queryHistory: vi.fn().mockImplementation(() => new Promise<TracePage>(resolve => { done = resolve; })), getOperation: vi.fn(), previewRestore: vi.fn() } satisfies DeviceTraceClient;
  const second = { queryHistory: vi.fn(), getOperation: vi.fn(), previewRestore: vi.fn() } satisfies DeviceTraceClient;
  const services = shallowRef<DeviceTraceClient>(first), scope = effectScope();
  const trace = scope.run(() => useDeviceTrace(() => ({ device_id: 'D1', resource_revision: revision, readable: true, editable: true }), () => services.value))!;
  const reading = trace.query(), signal = first.queryHistory.mock.calls[0]?.[1]?.signal;
  services.value = second; done({ schema_version: schema, items: [baseline(revision)], total: 1, page: 1, page_size: 20 }); await reading;
  expect(signal?.aborted).toBe(true); expect(trace.history.value).toBeNull(); expect(trace.selected.value).toBeNull(); expect(trace.busy.value).toBe(false); scope.stop();
});
