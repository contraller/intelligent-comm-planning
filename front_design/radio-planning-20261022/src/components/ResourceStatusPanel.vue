<template>
  <section class="resource-status-panel" aria-label="设备状态快照">
    <div class="toolbar">
      <strong>设备状态快照</strong>
      <label>显示来源
        <select aria-label="状态显示来源" :value="status.mode" :disabled="!entry.available.value || status.busy" @change="status.setMode(($event.target as HTMLSelectElement).value as 'baseline' | 'observed')">
          <option value="baseline">台账基线</option><option value="observed" :disabled="!status.batch">构造状态快照</option>
        </select>
      </label>
      <button class="btn small" :disabled="!entry.available.value || status.busy" @click="entry.retry">读取批次</button>
      <button class="btn small" :disabled="!status.batch || status.busy" @click="clear">清除选择</button>
      <span>当前资源设备 {{ total ?? '未知' }} 台</span>
    </div>
    <p v-if="!services" role="status">状态服务未接入。</p>
    <p v-if="pausedReason" role="status">{{ pausedReason }}</p>
    <p v-if="status.busy" role="status">正在读取或核验快照…</p>
    <p v-if="status.error || parseError" role="alert">{{ parseError || status.error }}</p>
    <p v-if="status.notice" role="status">{{ status.notice }}</p>
    <p v-if="leaveNotice" role="status">{{ leaveNotice }}</p>
    <button v-if="dirtyInput" class="btn small" :disabled="localBusy || !!status.pendingImport" @click="discardInput">放弃未提交导入输入</button>
    <details>
      <summary>已导入批次 · {{ status.snapshots?.total ?? '未知' }}</summary>
      <p v-if="status.snapshots?.total === 0">尚无同版状态快照</p>
      <ul>
        <li v-for="item in status.snapshots?.items ?? []" :key="item.snapshot_id">
          <button class="btn small" :disabled="!entry.available.value || status.busy" @click="status.select(item)">{{ item.source_label }}</button>
          <span>{{ item.snapshot_id }} · 导入 {{ item.imported_at }} · {{ item.total }} 台</span>
        </li>
      </ul>
      <div v-if="status.snapshots" class="toolbar">
        <button class="btn small" :disabled="status.busy || status.snapshots.page <= 1" @click="status.list(status.snapshots.page - 1)">上一批次页</button>
        <span>{{ status.snapshots.page }}</span>
        <button class="btn small" :disabled="status.busy || status.snapshots.page * status.snapshots.page_size >= status.snapshots.total" @click="status.list(status.snapshots.page + 1)">下一批次页</button>
      </div>
    </details>
    <section v-if="status.batch" aria-label="快照明细">
      <h3>{{ status.batch.source_label }} · 构造数据／非真实遥测</h3>
      <p>{{ status.batch.provenance_note }}</p>
      <p>采集范围 {{ status.batch.first_observed_at ?? '未知' }} 至 {{ status.batch.last_observed_at ?? '未知' }}；导入 {{ status.batch.imported_at }}</p>
      <p>正常 {{ status.batch.counts.NORMAL }} · 故障 {{ status.batch.counts.FAULT }} · 离线 {{ status.batch.counts.OFFLINE }} · 未知 {{ status.batch.counts.UNKNOWN }}</p>
      <label>快照状态
        <select aria-label="快照状态筛选" :value="status.filter" :disabled="status.busy || !entry.available.value" @change="status.setFilter(($event.target as HTMLSelectElement).value as StatusFilter)">
          <option value="ALL">全部</option><option value="NORMAL">正常</option><option value="FAULT">故障</option><option value="OFFLINE">离线</option><option value="UNKNOWN">未知</option>
        </select>
      </label>
      <div class="table-scroll"><table>
        <thead><tr><th>设备</th><th>状态</th><th>告警</th><th>采集时间</th><th>未知原因</th></tr></thead>
        <tbody><tr v-for="item in status.batchDetails?.items ?? []" :key="item.device_id">
          <td>{{ item.device_id }}</td><td>{{ item.status === null ? '未知' : names[item.status] }}</td>
          <td>{{ item.alert === null ? '未知' : item.alert ? '有' : '无' }}</td>
          <td>{{ item.observed_at ?? '未知' }}</td><td>{{ item.unknown_reasons.join('；') || '无' }}</td>
        </tr></tbody>
      </table></div>
      <p v-if="status.batchDetails?.total === 0">该筛选下无记录</p>
      <div v-if="status.batchDetails" class="toolbar">
        <button class="btn small" :disabled="status.busy || status.batchDetails.page <= 1" @click="status.loadBatch(status.batchDetails.page - 1)">上一明细页</button>
        <span>{{ status.batchDetails.page }} · 共 {{ status.batchDetails.total }} 条</span>
        <button class="btn small" :disabled="status.busy || status.batchDetails.page * status.batchDetails.page_size >= status.batchDetails.total" @click="status.loadBatch(status.batchDetails.page + 1)">下一明细页</button>
      </div>
    </section>
    <details v-if="status.importable">
      <summary>显式导入构造状态</summary>
      <label>构造状态 JSON 文件<input ref="fileInput" type="file" accept=".json,application/json" :disabled="localBusy || !!status.pendingImport" @change="readFile" /></label>
      <label>原始导入请求<textarea v-model="raw" aria-label="状态导入 JSON" rows="8" :disabled="localBusy || !!status.pendingImport" /></label>
      <div class="toolbar">
        <button class="btn" :disabled="!entry.available.value || localBusy || !!status.pendingImport" @click="submit">校验并导入</button>
        <button v-if="status.pendingImport" class="btn" :disabled="status.busy" @click="status.verifyImport">核实原导入编号</button>
        <button v-if="status.importNotFound && status.pendingImport" class="btn" :disabled="status.busy" @click="status.submitImport(status.pendingImport)">原号重试导入</button>
        <button v-if="status.importNotFound" class="btn" :disabled="localBusy" @click="status.discardImportNotFound">放弃未查到导入（仅本地）</button>
      </div>
      <p v-if="status.pendingImport">待核实编号 {{ status.pendingImport.request_id }}</p>
      <p v-if="status.receipt">持久化回执 {{ status.receipt.request_id }} · {{ status.receipt.snapshot_id }}</p>
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useResourceStatusEntry } from '../stores/resource-status';
import type { DeviceStatusClient } from '../services/device-status-http';
import { validateStatusImport } from '../services/device-status-decode';
import type { DeviceStatusReceipt, StatusFilter } from '../types/device-status-snapshot';
const props = withDefaults(defineProps<{
  enabled?: boolean; selectedIds?: string[]; hiddenCount?: number; pausedReason?: string;
  resourceRevision: string | undefined; total: number | null; queryBusy?: boolean; services?: DeviceStatusClient; allowImport?: boolean;
}>(), { enabled: true, hiddenCount: 0, allowImport: false });
const emit = defineEmits<{
  'snapshot-selected': [value: { snapshot_id: string; snapshot_revision: string; resource_revision: string }];
  imported: [value: DeviceStatusReceipt]; 'clear-snapshot': [];
  dirty: [value: boolean]; busy: [value: boolean];
}>();
const entry = useResourceStatusEntry(() => props.enabled && !props.queryBusy, () => props.resourceRevision ?? '', () => props.services, () => props.allowImport);
const status = entry.status, raw = ref(''), parseError = ref('');
const fileInput = ref<HTMLInputElement | null>(null), fileName = ref(''), fileBusy = ref(false), leaveNotice = ref('');
const acceptedInput = ref({ raw: '', fileName: '' });
let submittedInput: { requestId: string; raw: string; fileName: string } | null = null;
const dirtyInput = computed(() => raw.value !== acceptedInput.value.raw || fileName.value !== acceptedInput.value.fileName);
const localBusy = computed(() => status.busy || fileBusy.value);
let fileSerial = 0;
const names = { NORMAL: '正常', FAULT: '故障', OFFLINE: '离线' };
watch(() => status.batch, value => { if (value) emit('snapshot-selected', { snapshot_id: value.snapshot_id, snapshot_revision: value.snapshot_revision, resource_revision: value.resource_revision }); });
watch(() => status.receipt, value => {
  if (value) {
    if (submittedInput?.requestId === value.request_id) acceptedInput.value = { raw: submittedInput.raw, fileName: submittedInput.fileName };
    emit('imported', value);
  }
});
watch(() => dirtyInput.value || !!status.pendingImport, value => emit('dirty', value), { immediate: true });
watch(localBusy, value => emit('busy', value), { immediate: true });
function clear() { status.clearSnapshot(); emit('clear-snapshot'); }
async function readFile(event: Event) {
  if (status.busy || status.pendingImport) return;
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  // 换文件即废弃旧原文；新文件失败时不能提交上一份内容。
  raw.value = ''; fileName.value = file.name; parseError.value = ''; submittedInput = null;
  const serial = ++fileSerial; fileBusy.value = false;
  if (file.size > 2 * 1024 * 1024) { parseError.value = '导入文件不能超过 2 MiB'; return; }
  fileBusy.value = true;
  try { const content = await file.text(); if (serial === fileSerial) { raw.value = content; parseError.value = ''; } }
  catch { if (serial === fileSerial) parseError.value = '文件读取失败'; }
  finally { if (serial === fileSerial) fileBusy.value = false; }
}
async function submit() {
  if (!entry.available.value || localBusy.value) return;
  try {
    const value: unknown = JSON.parse(raw.value); validateStatusImport(value); parseError.value = '';
    submittedInput = { requestId: value.request_id, raw: raw.value, fileName: fileName.value };
    await status.submitImport(value);
  }
  catch (e) { parseError.value = e instanceof Error ? e.message : '导入 JSON 无效'; }
}
function discardInput() {
  if (localBusy.value || status.pendingImport) return false;
  raw.value = ''; fileName.value = ''; parseError.value = ''; acceptedInput.value = { raw: '', fileName: '' }; leaveNotice.value = '';
  submittedInput = null;
  if (fileInput.value) fileInput.value.value = '';
  return true;
}
async function requestLeave(): Promise<boolean> {
  if (localBusy.value || status.pendingImport || dirtyInput.value) {
    leaveNotice.value = '尚有文件读取、待核实原号或未提交导入输入，请先核实或明确放弃本地输入。'; return false;
  }
  return true;
}
defineExpose({ requestLeave });
onScopeDispose(() => { fileSerial++; });
</script>
<style scoped>
.resource-status-panel { padding: 12px 0; font-size: 12px; border-top: 1px solid var(--line, #d5d9de); }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 8px 0; }
label { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
textarea { width: 100%; min-width: 0; resize: vertical; }
summary { cursor: pointer; margin: 10px 0; }
h3 { font-size: 14px; }
ul { list-style: none; padding: 0; max-height: 240px; overflow: auto; }
li { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
p, td, li { overflow-wrap: anywhere; }
.table-scroll { overflow: auto; }
table { width: 100%; min-width: 580px; border-collapse: collapse; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--line, #d5d9de); }
[role='alert'] { color: var(--danger, #c52442); }
</style>
