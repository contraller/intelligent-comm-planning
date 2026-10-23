import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { useDeviceTrace } from '../src/composables/useDeviceTrace';
import type { DeviceTraceClient } from '../src/services/device-trace-http';
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
