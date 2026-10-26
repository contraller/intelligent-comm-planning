<template>
  <AppDrawer
    :visible="visible"
    title="导出资源"
    subtitle="导出最后成功保存的数据，不包含未保存输入。"
    @update:visible="!$event && emit('update:visible', false)"
  >
    <div class="fields">
      <label
        >格式<select
          v-model="format"
          :disabled="busy"
          ><option value="xlsx">XLSX</option
          ><option value="csv">CSV</option></select
        ></label
      >
      <label v-if="format === 'csv'"
        >资源类型<select
          v-model="kind"
          :disabled="busy"
          ><option value="devices">设备</option
          ><option value="nodes">站点</option
          ><option value="interference_sources">干扰源</option></select
        ></label
      >
      <fieldset
        v-else
        :disabled="busy"
        ><legend>资源类型</legend
        ><label
          v-for="item in resourceKinds"
          :key="item"
          class="kind-check"
          ><input
            v-model="kinds"
            type="checkbox"
            :value="item"
          />{{ names[item] }}</label
        ></fieldset
      >
      <label
        >导出范围<select
          v-model="range"
          :disabled="busy"
          ><option value="all">全部已保存资源</option
          ><option value="filtered">全部筛选结果</option
          ><option
            value="selected"
            :disabled="!selectedIds.length"
            >当前页勾选设备</option
          ></select
        ></label
      >
      <p class="source-binding" role="status">
        已应用状态来源：{{ !queryReady ? '未就绪' : observedSource ? '观测快照 ' + (filter.observationSnapshotId ?? '未绑定') : '台账基线' }}
      </p>
      <dl v-if="boundPreview?.observation" class="source-details">
        <dt>快照版本</dt><dd>{{ boundPreview.observation.snapshotRevision }}</dd>
        <dt>资源版本</dt><dd>{{ boundPreview.observation.resourceRevision }}</dd>
        <dt>来源</dt><dd>{{ boundPreview.observation.sourceLabel }}</dd>
        <dt>数据性质</dt><dd>{{ boundPreview.observation.dataOrigin }}</dd>
        <dt>节点状态口径</dt><dd>台账基线</dd>
      </dl>
      <p
        v-if="loading"
        role="status"
        >正在核对导出范围…</p
      >
      <p
        v-if="boundPreview"
        role="status"
        >{{ boundPreview.tables.map((t) => names[t.kind] + ' ' + t.count).join('；')
        }}<span v-if="boundPreview.added">；补齐关联节点 {{ boundPreview.added }} 个</span></p
      >
      <p
        v-if="error"
        class="error"
        role="alert"
        >{{ error }}</p
      >
      <button
        v-if="error"
        class="btn small"
        :disabled="busy"
        @click="inspect"
        >重试预检</button
      >
    </div>
    <template #footer
      ><div class="toolbar"
        ><button
          class="btn"
          :disabled="busy"
          @click="emit('update:visible', false)"
          >关闭</button
        ><button
          class="btn primary"
          :disabled="!canDownload"
          @click="download"
          >{{ busy ? '正在导出…' : '导出' }}</button
        ></div
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { previewService } from '../services';
import { downloadFile } from '../services/file-download';
import { useAuthStore } from '../stores/auth';
import type {
  ResourceExportPreview,
  ResourceExportRequest,
  ResourceFormat,
  ResourceKind,
} from '../types/resource-edit';
import type { ResourceReadFilter } from '../types/resource-read';
const props = withDefaults(defineProps<{
  visible: boolean;
  revision: string;
  filter: ResourceReadFilter;
  selectedIds: string[];
  queryReady?: boolean;
}>(), { queryReady: true });
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const resourceKinds: ResourceKind[] = ['nodes', 'devices', 'interference_sources'];
const auth = useAuthStore(),
  format = ref<ResourceFormat>('xlsx'),
  kind = ref<ResourceKind>('devices'),
  kinds = ref<ResourceKind[]>([...resourceKinds]),
  range = ref<'all' | 'filtered' | 'selected'>('all');
const preview = ref<ResourceExportPreview | null>(null),
  previewSignature = ref(''),
  error = ref(''),
  loading = ref(false),
  busy = ref(false);
const names: Record<ResourceKind, string> = {
  devices: '设备',
  nodes: '站点',
  interference_sources: '干扰源',
  topology_links: '候选链路',
};
let serial = 0, alive = true;
const observedSource = computed(() => props.filter.statusMode === 'observed');
const sourceFilter = computed<ResourceReadFilter | undefined>(() => observedSource.value
  ? { statusMode: 'observed', observationSnapshotId: props.filter.observationSnapshotId }
  : undefined);
const request = computed<ResourceExportRequest>(() => ({
  context: 'ledger',
  format: format.value,
  kinds: format.value === 'xlsx' ? [...kinds.value] : [kind.value],
  ledger: {
    revision: props.revision,
    range: range.value,
    ...(range.value === 'filtered' ? { filter: { ...props.filter,
      ...(props.filter.frequency ? { frequency: { ...props.filter.frequency } } : {}) } }
      : sourceFilter.value ? { filter: { ...sourceFilter.value } } : {}),
    ...(range.value === 'selected' ? { selectedIds: [...props.selectedIds] } : {}),
  },
}));
const requestSignature = computed(() => JSON.stringify(request.value));
const boundPreview = computed(() => previewSignature.value === requestSignature.value && props.queryReady ? preview.value : null);
const canDownload = computed(() => props.visible && props.queryReady && !!boundPreview.value && !busy.value && !loading.value
  && auth.can('resources.view') && !auth.blocked);
function current(token: number, session: number, signature: string) {
  return alive && token === serial && session === auth.generation && signature === requestSignature.value
    && props.visible && props.queryReady && auth.can('resources.view') && !auth.blocked;
}
watch(
  () => [props.visible, requestSignature.value, props.queryReady, auth.generation],
  () => {
    if (props.visible) void inspect();
    else {
      serial++;
      preview.value = null;
      previewSignature.value = '';
      loading.value = false;
    }
  },
  { immediate: true },
);
async function inspect() {
  const token = ++serial,
    session = auth.generation, input = request.value, signature = requestSignature.value;
  preview.value = null;
  previewSignature.value = '';
  error.value = '';
  loading.value = false;
  if (!props.queryReady) { error.value = '尚无当前资源版本的已应用查询，暂不能导出。'; return; }
  if (!props.visible || !auth.can('resources.view') || auth.blocked) return;
  if (observedSource.value && !input.kinds.includes('devices')) {
    error.value = '观测导出必须包含设备表；节点状态仍为台账基线。'; return;
  }
  loading.value = true;
  try {
    const result = await previewService.previewResourceExport(input);
    if (!current(token, session, signature)) return;
    const source = input.ledger?.filter;
    if (source?.statusMode === 'observed'
      ? result.statusMode !== 'observed' || result.nodeStatusMode !== 'baseline' || !result.observation
        || result.observation.snapshotId !== source.observationSnapshotId || result.observation.resourceRevision !== input.ledger?.revision
      : result.statusMode !== undefined || result.observation !== undefined) throw new Error('导出预检与已应用来源不符。');
    preview.value = result;
    previewSignature.value = signature;
  } catch (reason) {
    if (token === serial && session === auth.generation)
      error.value = reason instanceof Error ? reason.message : '导出预检失败';
  } finally {
    if (token === serial) loading.value = false;
  }
}
async function download() {
  if (!canDownload.value) return;
  const session = auth.generation,
    token = serial,
    signature = requestSignature.value, input = request.value;
  busy.value = true;
  error.value = '';
  try {
    const file = await previewService.exportResources(input);
    if (!current(token, session, signature) || !(await auth.check()) || !current(token, session, signature)) return;
    downloadFile(file, 0);
  } catch (reason) {
    if (session === auth.generation && token === serial) {
      preview.value = null;
      previewSignature.value = '';
      error.value = reason instanceof Error ? reason.message : '导出失败';
    }
  } finally {
    busy.value = false;
  }
}
onBeforeUnmount(() => { alive = false; serial++; });
</script>
<style scoped>
.fields {
  display: grid;
  gap: 18px;
}
label {
  display: grid;
  gap: 8px;
}
.kind-check {
  display: inline-flex;
  align-items: center;
  margin: 8px 16px 0 0;
}
.kind-check input {
  width: auto;
}
.error {
  color: #f5a6b2;
}
.source-binding { margin: 0; overflow-wrap: anywhere; }
.source-details { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 6px 12px; margin: 0; }
.source-details dd { margin: 0; overflow-wrap: anywhere; }
</style>
