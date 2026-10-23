import { computed, onScopeDispose, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { env } from '../config/env';
import { useAuthStore } from './auth';
import { usePreviewStore } from './preview';
import type { Device } from '../types/domain';
import type { DeviceStatusBatch, DeviceStatusCatalog, DeviceStatusContext, DeviceStatusRecord } from '../types/resource-status';
import { validateStatusBatch, validateStatusCatalog } from '../services/resource-status-validation';
import { deviceStatusDisplay, mergeDeviceStatuses } from '../services/resource-status-display';

// 仅当前 Pinia/标签页内存；资源和会话变更使旧观测失效，不写业务存储。
export const useResourceStatusStore = defineStore('resource-status', () => {
  const auth = useAuthStore(), preview = usePreviewStore();
  const catalog = ref<DeviceStatusCatalog | null>(null), exampleId = ref('');
  const records = ref<Record<string, DeviceStatusRecord>>({}), batch = ref<DeviceStatusBatch | null>(null);
  const mode = ref<'baseline' | 'observed'>('baseline'), busy = ref(false), error = ref(''), notice = ref('');
  let generation = 0, owner: symbol | null = null;
  const revision = computed(() => preview.data?.resourceMeta.revision ?? '');
  const source = computed(() => catalog.value?.examples?.find(e => e.id === exampleId.value)?.source ?? catalog.value?.source);
  const readable = (context: DeviceStatusContext) => env.mode === 'mock' && auth.can(context === 'gis' ? 'situation.view' : 'resources.view');
  function cancel(key?: symbol) { if (key && owner !== key) return; generation++; owner = null; busy.value = false; }
  function clear(message = '') {
    cancel(); catalog.value = null; exampleId.value = ''; records.value = {}; batch.value = null;
    mode.value = 'baseline'; error.value = ''; notice.value = message;
  }
  // 比较身份字段而非对象引用，普通会话重验不能清掉正在读取的观测。
  watch([() => auth.identity?.id, () => auth.identity?.sessionId, () => env.mode], () => clear(), { flush: 'sync' });
  watch([revision, () => preview.data?.resources.version], (_, before) => clear(before?.[0] ? '资源版本已变化，已恢复台账基线，请重新同步。' : ''), { flush: 'sync' });
  watch(() => auth.generation, () => cancel(), { flush: 'sync' });
  function setMode(value: 'baseline' | 'observed') {
    if (value === 'observed' && !batch.value) return;
    cancel(); mode.value = value;
  }
  function setExample(id: string) {
    if (id === exampleId.value || !catalog.value?.examples?.some(e => e.id === id)) return;
    cancel(); exampleId.value = id; records.value = {}; batch.value = null; mode.value = 'baseline'; error.value = '';
    notice.value = '已切换教学样例，请同步；上一样例观测已清除。';
  }
  async function load(context: DeviceStatusContext, key: symbol, valid: () => boolean) {
    if (catalog.value || busy.value || !valid() || !readable(context) || !revision.value) return;
    const request = { context, resourceRevision: revision.value }, token = ++generation, session = auth.generation;
    owner = key; busy.value = true; error.value = '';
    const current = () => token === generation && session === auth.generation && valid() && readable(context) && request.resourceRevision === revision.value;
    try {
      const result = await previewService.loadDeviceStatusContext(request);
      if (!current()) return;
      validateStatusCatalog(result, request); catalog.value = result; exampleId.value = result.examples?.[0]?.id ?? '';
    } catch (e) { if (current()) error.value = e instanceof Error ? e.message : '状态目录读取失败'; }
    finally { if (token === generation) { busy.value = false; owner = null; } }
  }
  async function sync(context: DeviceStatusContext, ids: string[], key: symbol, valid: () => boolean) {
    if (busy.value || !valid() || !readable(context) || !catalog.value || !source.value || !ids.length || !preview.data) return;
    const request = { context, resourceRevision: revision.value, deviceIds: [...ids], ...(exampleId.value ? { exampleId: exampleId.value } : {}) };
    const expectedSource = source.value, resources = preview.data.resources, token = ++generation, session = auth.generation;
    owner = key; busy.value = true; error.value = ''; notice.value = '';
    const current = () => token === generation && session === auth.generation && valid() && readable(context) && revision.value === request.resourceRevision;
    try {
      const result = await previewService.queryDeviceStatuses(request);
      if (!current()) return;
      validateStatusBatch(result, request, resources, expectedSource);
      const next = mergeDeviceStatuses(records.value, result, new Date().toISOString());
      records.value = next; batch.value = result; mode.value = 'observed';
    } catch (e) { if (current()) error.value = (e instanceof Error ? e.message : '状态同步失败') + '；本次未接收新结果，上次有效观测已保留。'; }
    finally { if (token === generation) { busy.value = false; owner = null; } }
  }
  const display = (device: Device) => deviceStatusDisplay(device, mode.value, records.value[device.id], source.value?.label);
  const displays = computed(() => Object.fromEntries((preview.data?.resources.devices ?? []).map(d => [d.id, display(d)])));
  return { catalog, exampleId, records, batch, mode, busy, error, notice, revision, source, displays, readable, display, setMode, setExample, load, sync, cancel };
});

// 每个页面入口独立代次；离开或进入编辑/快照时取消本入口迟到读取。
export function useResourceStatusEntry(context: DeviceStatusContext, enabled: () => boolean) {
  const status = useResourceStatusStore(), auth = useAuthStore(), key = Symbol('device-status-entry');
  let epoch = 0, disposed = false;
  const available = computed(() => !disposed && enabled() && status.readable(context));
  const valid = () => { const token = epoch; return () => !disposed && token === epoch && available.value; };
  watch([available, () => status.revision, () => auth.generation], () => {
    epoch++; status.cancel(key);
    if (available.value) void status.load(context, key, valid());
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(() => { disposed = true; epoch++; status.cancel(key); });
  return { status, available, retry: () => status.load(context, key, valid()),
    sync: (ids: string[]) => status.sync(context, ids, key, valid()) };
}
