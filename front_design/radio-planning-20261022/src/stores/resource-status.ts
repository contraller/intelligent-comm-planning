import { computed, onScopeDispose, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { useAuthStore } from './auth';
import { usePreviewStore } from './preview';
import type { Device } from '../types/domain';
import type { DeviceStatusSummary, DeviceStatusItem, DeviceStatusCatalog, DeviceStatusRecord } from '../types/resource-status';
import type { PageResult } from '../types/data-access';
import { validateStatusSummary, validateStatusCatalog } from '../services/resource-status-validation';
import { deviceStatusDisplay } from '../services/resource-status-display';

// 仅当前 Pinia/标签页内存；资源和会话变更使旧观测失效，不写业务存储。
export const useResourceStatusStore = defineStore('resource-status', () => {
  const auth = useAuthStore(), preview = usePreviewStore();
  const catalog = ref<DeviceStatusCatalog | null>(null), exampleId = ref('');
  const records = ref<Record<string, DeviceStatusRecord>>({}), batch = ref<DeviceStatusSummary | null>(null);
  const batchDetails=ref<PageResult<DeviceStatusItem>|null>(null),detailsLoading=ref(false);
  const mode = ref<'baseline' | 'observed'>('baseline'), busy = ref(false), error = ref(''), notice = ref(''), snapshotId = ref('');
  let generation = 0, detailSerial=0, owner: symbol | null = null;
  const revision = computed(() => preview.data?.resourceMeta.revision ?? '');
  const source = computed(() => catalog.value?.examples?.find(e => e.id === exampleId.value)?.source ?? catalog.value?.source);
  const readable = () => auth.can('resources.view');
  function cancel(key?: symbol) { if (key && owner !== key) return; generation++;detailSerial++;detailsLoading.value=false; owner = null; busy.value = false; }
  function clear(message = '') {
    cancel(); catalog.value = null; exampleId.value = ''; records.value = {}; batch.value = null;
    batchDetails.value=null;
    mode.value = 'baseline'; snapshotId.value = ''; error.value = ''; notice.value = message;
  }
  // 比较身份字段而非对象引用，普通会话重验不能清掉正在读取的观测。
  watch([() => auth.identity?.id, () => auth.identity?.sessionId], () => clear(), { flush: 'sync' });
  watch([revision, () => preview.data?.resources.version], (_, before) => clear(before?.[0] ? '资源版本已变化，已恢复台账基线，请重新同步。' : ''), { flush: 'sync' });
  watch(() => auth.generation, () => cancel(), { flush: 'sync' });
  function setMode(value: 'baseline' | 'observed') {
    if (value === 'observed' && !batch.value) return;
    cancel(); mode.value = value;
  }
  function setExample(id: string) {
    if (id === exampleId.value || !catalog.value?.examples?.some(e => e.id === id)) return;
    cancel(); exampleId.value = id; records.value = {}; batch.value = null; snapshotId.value = ''; mode.value = 'baseline'; error.value = '';
    notice.value = '已切换教学样例，请同步；上一样例观测已清除。';
  }
  async function load(key: symbol, valid: () => boolean, resourceRevision: string) {
    if (catalog.value?.resourceRevision === resourceRevision || busy.value || !valid() || !readable() || !resourceRevision) return;
    if (catalog.value) clear('资源版本已变化，请重新同步。');
    const request = { context: 'ledger' as const, resourceRevision }, token = ++generation, session = auth.generation;
    owner = key; busy.value = true; error.value = '';
    const current = () => token === generation && session === auth.generation && valid() && readable();
    try {
      // 台账只读取轻量选项，完整目标与观测合并由服务负责。
      const result = await previewService.loadDeviceStatusOptions(request);
      if (!current()) return;
      validateStatusCatalog(result, request); catalog.value = result; exampleId.value = result.examples?.[0]?.id ?? '';
    } catch (e) { if (current()) error.value = e instanceof Error ? e.message : '状态目录读取失败'; }
    finally { if (token === generation) { busy.value = false; owner = null; } }
  }
  async function sync(ids: string[], key: symbol, valid: () => boolean, resourceRevision: string, scope: 'ALL' | 'IDS' = 'IDS') {
    if (busy.value || !valid() || !readable() || !catalog.value || catalog.value.resourceRevision !== resourceRevision || !source.value || scope === 'IDS' && !ids.length) return;
    const request = { context: 'ledger' as const, resourceRevision, deviceIds: [...ids], scope, ...(exampleId.value ? { exampleId: exampleId.value } : {}), ...(snapshotId.value ? { previousSnapshotId: snapshotId.value } : {}) };
    const expectedSource = source.value, token = ++generation, session = auth.generation;
    owner = key; busy.value = true; error.value = ''; notice.value = '';
    const current = () => token === generation && session === auth.generation && valid() && readable() && catalog.value?.resourceRevision === request.resourceRevision;
    try {
      const result = await previewService.synchronizeDeviceStatuses(request);
      if (!current()) return;
      validateStatusSummary(result, request, expectedSource);
      batch.value = result; batchDetails.value=null;snapshotId.value = result.snapshotId; mode.value = 'observed';
    } catch (e) { if (current()) error.value = (e instanceof Error ? e.message : '状态同步失败') + '；本次未接收新结果，上次有效观测已保留。'; }
    finally { if (token === generation) { busy.value = false; owner = null; } }
  }
  async function loadBatch(page=1){
    const currentBatch=batch.value;if(!currentBatch||!readable())return;
    const token=generation,session=auth.generation,serial=++detailSerial;detailsLoading.value=true;
    try{const value=await previewService.queryDeviceStatusBatch({context:'ledger',resourceRevision:currentBatch.resourceRevision,batchId:currentBatch.batchId,pageNum:page,pageSize:20});
      if(serial===detailSerial&&token===generation&&session===auth.generation&&batch.value?.batchId===currentBatch.batchId){batchDetails.value=value;records.value={...records.value,...value.records};}
    }catch(e){if(serial===detailSerial&&token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'批次明细读取失败';}
    finally{if(serial===detailSerial&&token===generation)detailsLoading.value=false;}
  }
  const display = (device: Device) => deviceStatusDisplay(device, mode.value, records.value[device.id], source.value?.label);
  return { catalog, exampleId, records, batch, batchDetails,detailsLoading,loadBatch,snapshotId, mode, busy, error, notice, revision, source, readable, display, setMode, setExample, load, sync, cancel, clear };
});

// 台账入口显式绑定读取版本；暂停或离开后取消本入口迟到读取。
export function useResourceStatusEntry(enabled: () => boolean, resourceRevision: () => string) {
  const status = useResourceStatusStore(), auth = useAuthStore(), key = Symbol('device-status-entry');
  let epoch = 0, disposed = false;
  const available = computed(() => !disposed && enabled() && status.readable());
  const valid = () => { const token = epoch; return () => !disposed && token === epoch && available.value; };
  const revision = resourceRevision;
  watch([available, revision, () => auth.generation], () => {
    epoch++; status.cancel(key);
    if (available.value) void status.load(key, valid(), revision());
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(() => { disposed = true; epoch++; status.cancel(key); });
  return { status, available, retry: () => status.load(key, valid(), revision()),
    sync: (ids: string[]) => status.sync(ids, key, valid(), revision()),
    syncAll: () => status.sync([], key, valid(), revision(), 'ALL') };
}
