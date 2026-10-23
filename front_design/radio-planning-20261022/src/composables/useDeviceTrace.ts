import { ref, watch, onScopeDispose } from 'vue';
import { useAuthStore } from '../stores/auth';
import type { DeviceTraceClient } from '../services/device-trace-http';
import { deviceTraceSchema, type TracePage, type TraceDetail, type TraceSummary, type RestoreProposal } from '../types/device-trace';
export interface DeviceTraceTarget { device_id: string; resource_revision: string; readable: boolean; editable: boolean }
export function useDeviceTrace(target: () => DeviceTraceTarget | null, services: () => DeviceTraceClient | undefined) {
  const auth = useAuthStore(), history = ref<TracePage | null>(null), detail = ref<TraceDetail | null>(null), selected = ref<TraceSummary | null>(null);
  const restore = ref<RestoreProposal | null>(null), busy = ref(false), error = ref('');
  let serial = 0, control: AbortController | null = null;
  function cancel() { serial++; control?.abort(); control = null; busy.value = false; }
  function clear() { cancel(); history.value = null; detail.value = null; selected.value = null; restore.value = null; error.value = ''; }
  watch([() => JSON.stringify(target()), () => auth.identity?.id, () => auth.identity?.sessionId], clear, { flush: 'sync' });
  watch(() => auth.generation, cancel, { flush: 'sync' });
  async function run(operation: (client: DeviceTraceClient, value: DeviceTraceTarget, signal: AbortSignal, current: () => boolean) => Promise<void>) {
    const value = target(), client = services();
    if (busy.value || !value?.readable || !auth.can('resources.view')) return;
    if (!client) { error.value = '资源追溯服务未接入'; return; }
    const captured = { ...value }, token = ++serial, generation = auth.generation;
    control = new AbortController(); busy.value = true; error.value = '';
    const current = () => token === serial && generation === auth.generation && JSON.stringify(target()) === JSON.stringify(captured);
    try { await operation(client, captured, control.signal, current); }
    catch (e) { if (current()) error.value = e instanceof Error ? e.message : '资源追溯读取失败'; }
    finally { if (token === serial) { busy.value = false; control = null; } }
  }
  async function query(page = 1) {
    await run(async (client, value, signal, current) => {
      const result = await client.queryHistory({ context: 'ledger', device_id: value.device_id, resource_revision: value.resource_revision, page, page_size: 20 }, { signal });
      if (current()) history.value = result;
    });
  }
  async function select(item: TraceSummary) {
    restore.value = null; detail.value = null;
    if (item.device_id !== target()?.device_id) return;
    selected.value = { ...item, changed_fields: [...item.changed_fields] };
    if (item.request_id === null) return;
    const requestId = item.request_id;
    await run(async (client, value, signal, current) => {
      const result = await client.getOperation({ context: 'ledger', device_id: value.device_id, resource_revision: value.resource_revision, request_id: requestId }, { signal });
      if (current()) detail.value = result;
    });
  }
  async function preview() {
    const source = selected.value;
    if (!source || !target()?.editable || !auth.can('resources.device.edit')) return;
    await run(async (client, value, signal, current) => {
      const result = await client.previewRestore(value.device_id, { schema_version: deviceTraceSchema, context: 'ledger', base_revision: value.resource_revision,
        source_revision: source.revision, source_request_id: source.request_id }, { signal });
      if (current()) restore.value = result;
    });
  }
  onScopeDispose(clear);
  return { history, detail, selected, restore, busy, error, query, select, preview, cancel, clear };
}
