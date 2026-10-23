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
      <p
        v-if="loading"
        role="status"
        >正在核对导出范围…</p
      >
      <p
        v-if="preview"
        role="status"
        >{{ preview.tables.map((t) => names[t.kind] + ' ' + t.count).join('；')
        }}<span v-if="preview.added">；补齐关联节点 {{ preview.added }} 个</span></p
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
          :disabled="busy || loading || !preview || !auth.can('resources.view')"
          @click="download"
          >{{ busy ? '正在导出…' : '导出' }}</button
        ></div
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
const props = defineProps<{
  visible: boolean;
  revision: string;
  filter: ResourceReadFilter;
  selectedIds: string[];
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const resourceKinds: ResourceKind[] = ['nodes', 'devices', 'interference_sources'];
const auth = useAuthStore(),
  format = ref<ResourceFormat>('xlsx'),
  kind = ref<ResourceKind>('devices'),
  kinds = ref<ResourceKind[]>([...resourceKinds]),
  range = ref<'all' | 'filtered' | 'selected'>('all');
const preview = ref<ResourceExportPreview | null>(null),
  error = ref(''),
  loading = ref(false),
  busy = ref(false);
const names: Record<ResourceKind, string> = {
  devices: '设备',
  nodes: '站点',
  interference_sources: '干扰源',
  topology_links: '候选链路',
};
let serial = 0;
const request = computed<ResourceExportRequest>(() => ({
  context: 'ledger',
  format: format.value,
  kinds: format.value === 'xlsx' ? [...kinds.value] : [kind.value],
  ledger: {
    revision: props.revision,
    range: range.value,
    ...(range.value === 'filtered' ? { filter: props.filter } : {}),
    ...(range.value === 'selected' ? { selectedIds: [...props.selectedIds] } : {}),
  },
}));
watch(
  () => [props.visible, request.value, auth.generation],
  () => {
    if (props.visible) void inspect();
    else {
      serial++;
      preview.value = null;
    }
  },
  { deep: true },
);
async function inspect() {
  const token = ++serial,
    session = auth.generation;
  preview.value = null;
  error.value = '';
  loading.value = true;
  try {
    const result = await previewService.previewResourceExport(request.value);
    if (token === serial && session === auth.generation && props.visible) preview.value = result;
  } catch (reason) {
    if (token === serial && session === auth.generation)
      error.value = reason instanceof Error ? reason.message : '导出预检失败';
  } finally {
    if (token === serial) loading.value = false;
  }
}
async function download() {
  if (busy.value || !preview.value || loading.value || !auth.can('resources.view')) return;
  const session = auth.generation,
    token = serial,
    signature = JSON.stringify(request.value);
  busy.value = true;
  error.value = '';
  try {
    const file = await previewService.exportResources(request.value);
    if (
      !(await auth.check()) ||
      session !== auth.generation ||
      token !== serial ||
      signature !== JSON.stringify(request.value) ||
      !props.visible
    )
      return;
    downloadFile(file, 0);
  } catch (reason) {
    if (session === auth.generation && token === serial)
      error.value = reason instanceof Error ? reason.message : '导出失败';
  } finally {
    busy.value = false;
  }
}
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
</style>
