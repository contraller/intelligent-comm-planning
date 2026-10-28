<template>
  <AppDrawer :visible="visible && canView" title="观测冻结状态引用" width="900px" @update:visible="!$event && close()">
    <p v-if="busy" role="status">正在核验观测绑定和冻结状态…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="error && !busy" class="btn" @click="load(page)"><i class="pi pi-refresh" aria-hidden="true" />重新核验</button>
    <template v-if="result">
      <p class="origin">观测与设备状态的冻结关联</p>
      <p v-if="currentResourceRevision && currentResourceRevision !== result.header.resource_revision" class="origin">历史资源快照 · 只读</p>
      <dl class="identity">
        <dt>观测集</dt><dd>{{ result.target.datasetId }}</dd>
        <dt>观测版本</dt><dd>{{ result.target.datasetRevision }}</dd>
        <dt>资源来源版本</dt><dd>{{ result.header.resource_revision }}</dd>
        <dt>状态快照</dt><dd>{{ result.header.snapshot_id }}</dd>
        <dt>快照版本</dt><dd>{{ result.header.snapshot_revision }}</dd>
        <dt>冻结绑定版本</dt><dd>{{ result.reference.refRevision }}</dd>
        <dt>状态来源</dt><dd>{{ result.header.source_label }}</dd>
        <dt>来源说明</dt><dd>{{ result.header.provenance_note }}</dd>
        <dt>采集范围</dt><dd>{{ result.header.first_observed_at ?? '未知' }} 至 {{ result.header.last_observed_at ?? '未知' }}</dd>
        <dt>导入时间</dt><dd>{{ result.header.imported_at }}</dd>
      </dl>
      <p>声明成员 {{ result.total }} 台 · 完整快照 {{ result.header.total }} 台</p>
      <div class="table-scroll">
        <table aria-label="冻结引用成员">
          <thead><tr><th>设备</th><th>所属节点</th><th>型号</th><th>状态</th><th>告警</th><th>采集时间</th><th>未知原因</th></tr></thead>
          <tbody><tr v-for="item in result.items" :key="item.device_id">
            <td>{{ item.device_id }}</td><td>{{ item.node_id }}</td><td>{{ item.model_id }}</td>
            <td>{{ item.status === null ? '未知' : statusLabels[item.status] }}</td>
            <td>{{ item.alert === null ? '未知' : item.alert ? '告警' : '无告警' }}</td>
            <td>{{ item.observed_at ?? '未知' }}</td><td>{{ item.unknown_reasons.join('；') || '无' }}</td>
          </tr></tbody>
        </table>
      </div>
      <div class="pager">
        <button class="btn" :disabled="busy || result.page <= 1" aria-label="上一页引用成员" title="上一页引用成员" @click="load(result.page - 1)"><i class="pi pi-chevron-left" aria-hidden="true" /></button>
        <span role="status">第 {{ result.page }} / {{ Math.ceil(result.total / result.pageSize) }} 页</span>
        <button class="btn" :disabled="busy || result.page * result.pageSize >= result.total" aria-label="下一页引用成员" title="下一页引用成员" @click="load(result.page + 1)"><i class="pi pi-chevron-right" aria-hidden="true" /></button>
      </div>
    </template>
    <template #footer><button class="btn" @click="close">关闭</button></template>
  </AppDrawer>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { readObservationStatusReference, type ObservationStatusReferencePage,
  type ObservationStatusReferenceServices, type ObservationStatusReferenceTarget } from '../services/observation-status-reference';

const props = defineProps<{
  visible: boolean;
  target: ObservationStatusReferenceTarget | null;
  services: ObservationStatusReferenceServices;
  canView: boolean;
  sessionGeneration: string;
  currentResourceRevision?: string;
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean]; 'busy-change': [value: boolean] }>();
const result = shallowRef<ObservationStatusReferencePage | null>(null), busy = ref(false), error = ref(''), page = ref(1);
const statusLabels = { NORMAL: '正常', FAULT: '故障', OFFLINE: '离线' };
let serial = 0, control: AbortController | null = null;
function clear() {
  serial++; control?.abort(); control = null;
  result.value = null; error.value = ''; busy.value = false; page.value = 1;
}
function close() { clear(); emit('update:visible', false); }
async function load(nextPage: number) {
  if (!props.visible || !props.canView || !props.target) return;
  clear(); page.value = nextPage;
  const token = serial, owner = props.sessionGeneration, controller = new AbortController();
  control = controller; busy.value = true;
  const current = () => token === serial && !controller.signal.aborted && props.visible && props.canView && owner === props.sessionGeneration;
  try {
    const value = await readObservationStatusReference(props.services, props.target, nextPage, controller.signal);
    if (current() && value) result.value = value;
  } catch (reason) {
    if (current()) error.value = reason instanceof Error ? reason.message : '冻结状态引用读取失败';
  } finally {
    if (token === serial) { busy.value = false; control = null; }
  }
}
watch(busy, value => emit('busy-change', value), { immediate: true, flush: 'sync' });
watch(() => props.sessionGeneration, close, { flush: 'sync' });
watch(() => props.canView, value => { if (!value) close(); }, { flush: 'sync' });
watch([() => props.visible, () => JSON.stringify(props.target), () => props.services.observations, () => props.services.deviceStatuses], () => {
  clear();
  if (props.visible && props.canView) {
    if (props.target) void load(1);
    else error.value = '尚未选择观测冻结引用';
  }
}, { immediate: true, flush: 'sync' });
function requestLeave() { close(); return Promise.resolve(true); }
defineExpose({ requestLeave, clearForSession: close });
onBeforeUnmount(clear);
</script>

<style scoped>
.identity { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 8px; font-size: 12px; }
.identity dd { margin: 0; overflow-wrap: anywhere; }
.origin { font-size: 12px; }
.error { color: var(--danger, #c52442); overflow-wrap: anywhere; }
.table-scroll { max-width: 100%; overflow: auto; }
table { width: 100%; min-width: 700px; border-collapse: collapse; font-size: 12px; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid var(--line, #d5d9de); overflow-wrap: anywhere; max-width: 200px; }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.pager button { width: 36px; height: 36px; padding: 0; }
@media (max-width: 500px) { .identity { grid-template-columns: minmax(0, 1fr); } .identity dd { margin-bottom: 6px; } }
</style>
