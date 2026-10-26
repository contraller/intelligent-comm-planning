import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import { useAuthStore } from './auth';
import type { Device } from '../types/domain';
import type { DeviceStatusDisplay, DeviceStatusRecord } from '../types/resource-status';
import type { DeviceStatusHeader, DeviceStatusImport, DeviceStatusItem, DeviceStatusReceipt, DeviceStatusProjection,
  StatusPage, StatusDevices, StatusFilter } from '../types/device-status-snapshot';
import type { DeviceStatusClient } from '../services/device-status-http';
import { validateStatusImport, readStatusHeader, readStatusDevices, readStatusList } from '../services/device-status-decode';
import { ApiError } from '../services/types';

// 已持久化快照只读投影，不生成观测，不从配置受理或上下架推断设备状态。
export const useResourceStatusStore = defineStore('resource-status', () => {
  const auth = useAuthStore(), services = shallowRef<DeviceStatusClient | null>(null);
  const revision = ref(''), allowImport = ref(false), mode = ref<'baseline' | 'observed'>('baseline');
  const snapshots = ref<StatusPage<DeviceStatusHeader> | null>(null);
  const emptySelection = () => ({ batch: null as DeviceStatusHeader | null, details: null as StatusDevices | null,
    records: {} as Record<string, DeviceStatusItem>, filter: 'ALL' as StatusFilter, appliedAt: '', complete: false });
  // 表头、明细和地图投影共用一次不可分割的替换，失败不发布半个新批次。
  const selection = shallowRef(emptySelection());
  const batch = computed({ get: () => selection.value.batch, set: (value) => { selection.value = { ...selection.value, batch: value }; } });
  const batchDetails = computed(() => selection.value.details), snapshotRecords = computed(() => selection.value.records);
  const filter = computed(() => selection.value.filter), appliedAt = computed(() => selection.value.appliedAt);
  const complete = computed(() => selection.value.complete);
  // 旧宿主的兼容占位；不伪造带 sequence/observedAt 的旧协议记录，宿主应改用 display/project。
  const records = ref<Record<string, DeviceStatusRecord>>({});
  const busy = ref(false), detailsLoading = ref(false), error = ref(''), notice = ref('');
  const pendingImport = ref<DeviceStatusImport | null>(null), importNotFound = ref(false);
  const refreshMode = ref<'fixed' | 'latest'>('fixed'), following = ref(false), followError = ref(''), checkedAt = ref('');
  const receipt = ref<DeviceStatusReceipt | null>(null);
  const snapshotId = computed(() => batch.value?.snapshot_id ?? '');
  const source = computed(() => batch.value ? { id: batch.value.snapshot_id, label: batch.value.source_label, kind: 'BACKEND' as const } : undefined);
  const readable = () => auth.can('resources.view');
  // 权限尚未并入公共 union，直接检查已认证权限集合，不能把编辑权限替代专项导入权限。
  const importable = computed(() => allowImport.value && readable() && (auth.identity?.permissions as readonly string[] | undefined)?.includes('resources.device.status.import') === true);
  let serial = 0, control: AbortController | null = null, followSerial = 0, followControl: AbortController | null = null;
  function cancelFollow() { followSerial++; followControl?.abort(); followControl = null; following.value = false; }
  function setRefreshMode(value: 'fixed' | 'latest') { cancelFollow(); refreshMode.value = value; followError.value = ''; }
  function cancel(_key?: symbol) { cancelFollow(); serial++; control?.abort(); control = null; busy.value = false; detailsLoading.value = false; }
  function clear(message = '') { cancel(); snapshots.value = null; selection.value = emptySelection(); records.value = {}; mode.value = 'baseline'; refreshMode.value = 'fixed'; followError.value = ''; checkedAt.value = ''; error.value = ''; notice.value = message; }
  watch([() => auth.identity?.id, () => auth.identity?.sessionId], () => {
    clear(); pendingImport.value = null; importNotFound.value = false; receipt.value = null;
  }, { flush: 'sync' });
  watch(() => auth.generation, () => { cancel(); refreshMode.value = 'fixed'; }, { flush: 'sync' });
  watch(() => readable(), value => { if (!value) clear(); }, { flush: 'sync' });
  function bind(client: DeviceStatusClient | null, resourceRevision: string, importAllowed = false) {
    allowImport.value = importAllowed;
    if (services.value === client && revision.value === resourceRevision) return;
    clear(revision.value && revision.value !== resourceRevision ? '资源版本已变化，请重新选择同版快照。' : '');
    services.value = client; revision.value = resourceRevision;
  }
  async function run(operation: (client: DeviceStatusClient, signal: AbortSignal, current: () => boolean) => Promise<void>) {
    if (busy.value || !readable() || !services.value || !revision.value) return;
    cancelFollow();
    const token = ++serial, generation = auth.generation;
    control = new AbortController(); busy.value = true; error.value = '';
    const current = () => token === serial && generation === auth.generation && readable();
    try { await operation(services.value, control.signal, current); }
    catch (e) { if (current()) error.value = e instanceof Error ? e.message : '状态快照读取失败'; }
    finally { if (serial === token) { busy.value = false; detailsLoading.value = false; control = null; } }
  }
  async function list(page = 1) {
    const resource = revision.value;
    await run(async (client, signal, current) => {
      const value = await client.listSnapshots({ context: 'ledger', resource_revision: resource, page, page_size: 20 }, { signal });
      if (current()) snapshots.value = value;
    });
  }
  async function readSelection(client: DeviceStatusClient, header: DeviceStatusHeader, signal: AbortSignal, current: () => boolean, all: boolean) {
    const value = readStatusHeader(await client.getSnapshot({ context: 'ledger', snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision }, { signal }), header);
    if (!current()) return null;
    if (value.resource_revision !== revision.value) throw new ApiError('快照资源身份不符', 'INVALID_DEVICE_STATUS_RESPONSE');
    const records: Record<string, DeviceStatusItem> = {};
    const size = all ? 100 : 20, pages = all ? Math.ceil(value.total / size) : 1;
    let first: StatusDevices | null = null, previous = '';
    for (let page = 1; page <= pages; page++) {
      if (!current() || signal.aborted) return null;
      const expected = { context: 'ledger' as const, snapshot_id: value.snapshot_id, snapshot_revision: value.snapshot_revision, status_filter: 'ALL' as const, page, page_size: size };
      const result = readStatusDevices(await client.queryDevices(expected, { signal }), expected);
      if (!current()) return null;
      if (result.resource_revision !== value.resource_revision || result.total !== value.total) throw new ApiError('状态明细资源或总数不符', 'INVALID_DEVICE_STATUS_RESPONSE');
      for (const item of result.items) {
        if (Object.hasOwn(records, item.device_id) || previous && item.device_id <= previous) throw new ApiError('状态分页成员重复或顺序不符', 'INVALID_DEVICE_STATUS_RESPONSE');
        records[item.device_id] = item; previous = item.device_id;
      }
      first ??= { ...result, page_size: 20, items: result.items.slice(0, 20) };
    }
    if (all || value.total <= size) {
      const counts = { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 0 };
      for (const item of Object.values(records)) counts[item.status ?? 'UNKNOWN']++;
      if (Object.keys(records).length !== value.total || Object.entries(counts).some(([key, count]) => count !== value.counts[key as keyof typeof counts])) throw new ApiError('状态全集与批次统计不符', 'INVALID_DEVICE_STATUS_RESPONSE');
    }
    return { batch: value, details: first, records, filter: 'ALL' as StatusFilter, appliedAt: new Date().toISOString(), complete: all || value.total <= size };
  }
  async function select(header: DeviceStatusHeader, options: { complete?: boolean } = {}) {
    setRefreshMode('fixed');
    if (header.resource_revision !== revision.value) { error.value = '快照与当前资源版本不符'; return; }
    await run(async (client, signal, current) => {
      detailsLoading.value = true;
      const value = await readSelection(client, header, signal, current, options.complete === true);
      if (value && current()) { selection.value = value; mode.value = 'observed'; }
    });
  }
  async function followLatest(signal?: AbortSignal, eligible: () => boolean = () => true): Promise<boolean> {
    const client = services.value, resource = revision.value, generation = auth.generation;
    if (!client || !resource || !readable() || busy.value || following.value || pendingImport.value || refreshMode.value !== 'latest' || signal?.aborted || !eligible()) return false;
    const token = ++followSerial, controller = new AbortController(); followControl = controller; following.value = true;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const current = () => token === followSerial && !controller.signal.aborted && !signal?.aborted && generation === auth.generation
      && services.value === client && revision.value === resource && readable() && !busy.value && !pendingImport.value && refreshMode.value === 'latest' && eligible();
    try {
      const query = { context: 'ledger' as const, resource_revision: resource, page: 1, page_size: 20 };
      const directory = readStatusList(await client.listSnapshots(query, { signal: controller.signal }), query);
      if (!current()) return false;
      const latest = directory.items[0];
      if (!latest) throw new ApiError('尚无同版状态快照，已保留当前状态', 'DEVICE_STATUS_NOT_FOUND');
      if (batch.value?.snapshot_id !== latest.snapshot_id || batch.value.snapshot_revision !== latest.snapshot_revision || !complete.value || mode.value !== 'observed') {
        const value = await readSelection(client, latest, controller.signal, current, true);
        if (!value || !current()) return false;
        selection.value = value; mode.value = 'observed';
      }
      checkedAt.value = new Date().toISOString(); followError.value = ''; return true;
    } catch (reason) {
      if (current()) followError.value = reason instanceof Error ? reason.message : '最新状态读取失败';
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (token === followSerial) { followControl = null; following.value = false; }
    }
  }
  async function loadBatch(page = 1, nextFilter = filter.value) {
    const selected = batch.value; if (!selected) return;
    const expected = { context: 'ledger' as const, snapshot_id: selected.snapshot_id, snapshot_revision: selected.snapshot_revision, status_filter: nextFilter, page, page_size: 20 };
    await run(async (client, signal, current) => {
      detailsLoading.value = true;
      const value = readStatusDevices(await client.queryDevices(expected, { signal }), expected);
      if (!current()) return;
      if (value.resource_revision !== selected.resource_revision) throw new ApiError('状态明细资源身份不符', 'INVALID_DEVICE_STATUS_RESPONSE');
      const next = { ...snapshotRecords.value };
      for (const item of value.items) next[item.device_id] = item;
      selection.value = { ...selection.value, details: value, records: next, filter: nextFilter };
    });
  }
  async function setFilter(value: StatusFilter) {
    if (busy.value) return;
    await loadBatch(1, value);
  }
  function setMode(value: 'baseline' | 'observed') { if (value === 'observed' && !batch.value) return; if (value === 'baseline') setRefreshMode('fixed'); mode.value = value; }
  function clearSnapshot() { clear(); }
  function project(deviceId: string, resourceRevision: string): DeviceStatusProjection | null {
    const header = batch.value, item = snapshotRecords.value[deviceId];
    if (!readable() || !header || mode.value !== 'observed' || !item || header.resource_revision !== resourceRevision) return null;
    return { ref: { snapshotId: header.snapshot_id, snapshotRevision: header.snapshot_revision, resourceRevision: header.resource_revision, deviceId },
      status: item.status, alert: item.alert, observedAt: item.observed_at, unknownReasons: [...item.unknown_reasons], dataOrigin: header.data_origin };
  }
  function display(device: Pick<Device, 'id' | 'status'> & { alert: boolean | null }): DeviceStatusDisplay {
    if (mode.value === 'baseline') return { mode: 'baseline', status: device.status, alert: device.alert, sourceLabel: '台账基线', note: '已保存台账状态', retained: false };
    const value = project(device.id, revision.value);
    return { mode: 'observed', status: value?.status ?? null, alert: value?.alert ?? null,
      sourceLabel: batch.value?.source_label ?? '未选择状态快照', observedAt: value?.observedAt ?? undefined,
      fetchedAt: appliedAt.value || undefined, retained: !!followError.value, note: value ? ['构造快照，非真实遥测', ...value.unknownReasons].join('；') : '该设备尚无已读取的同版快照记录' };
  }
  function acceptImport(value: DeviceStatusReceipt) {
    const expected = pendingImport.value;
    if (!expected || value.request_id !== expected.request_id || value.resource_revision !== expected.base_revision || value.total !== expected.records.length) throw new ApiError('原导入回执与待核实请求不符', 'INVALID_DEVICE_STATUS_RESPONSE');
    receipt.value = value; pendingImport.value = null; importNotFound.value = false; notice.value = '构造状态已持久化，未修改资源或设备。';
  }
  async function submitImport(value: DeviceStatusImport) {
    if (!importable.value) return;
    validateStatusImport(value);
    if (value.base_revision !== revision.value) { error.value = '导入来源资源已变化'; return; }
    if (pendingImport.value && JSON.stringify(value) !== JSON.stringify(pendingImport.value)) { error.value = '请先核实原导入编号'; return; }
    const captured = { ...value, records: value.records.map(item => ({ ...item, unknown_reasons: [...item.unknown_reasons] })) };
    await run(async (client, signal, current) => {
      pendingImport.value = captured; importNotFound.value = false;
      const result = await client.importSnapshot(captured, { signal });
      if (current()) acceptImport(result);
    });
    if (!pendingImport.value) await list(1);
  }
  async function verifyImport() {
    const value = pendingImport.value; if (!value) return;
    await run(async (client, signal, current) => {
      importNotFound.value = false;
      try { const result = await client.getImport({ context: 'ledger', request_id: value.request_id }, { signal }); if (current()) acceptImport(result); }
      catch (e) {
        if (current() && e instanceof ApiError && (e.code === 'DEVICE_STATUS_NOT_FOUND' || e.code === 1002)) { importNotFound.value = true; notice.value = '未查到原号，可同号重试；未确认前保留原始输入。'; return; }
        throw e;
      }
    });
  }
  function discardImportNotFound() {
    if (busy.value || !pendingImport.value || !importNotFound.value) return false;
    pendingImport.value = null; importNotFound.value = false; notice.value = '仅放弃本地未查到导入；未删除服务端快照。'; return true;
  }
  return { revision, mode, snapshots, batch, batchDetails, snapshotRecords, records, busy, detailsLoading, error, notice, filter,
    refreshMode, following, followError, checkedAt, appliedAt, complete, setRefreshMode, followLatest, cancelFollow,
    snapshotId, source, pendingImport, importNotFound, receipt, importable, readable, bind, cancel, clear, list, select, loadBatch,
    setFilter, setMode, clearSnapshot, project, display, submitImport, verifyImport, discardImportNotFound };
});
export function useResourceStatusEntry(enabled: () => boolean, resourceRevision: () => string, services: () => DeviceStatusClient | undefined = () => undefined, allowImport: () => boolean = () => false) {
  const status = useResourceStatusStore();
  const available = computed(() => enabled() && status.readable() && !!resourceRevision() && !!services());
  watch([available, resourceRevision, services, allowImport], () => {
    status.cancel(); status.bind(services() ?? null, resourceRevision(), allowImport());
    if (available.value) void status.list();
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(status.cancel);
  return { status, available, retry: () => status.list() };
}
