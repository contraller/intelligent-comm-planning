<template>
  <AppDrawer
    :visible="visible"
    title="导出已保存资源"
    subtitle="不包含当前未保存草稿、方案、诊断或账号。"
    @update:visible="!$event && !busy && emit('update:visible', false)"
  >
    <!-- 导出仍取原已保存 DTO，不把内存观测混入状态列。 -->
    <p class="readonly-note">设备状态导出使用台账基线，不包含临时同步观测。</p>
    <div class="fields">
      <label v-if="context === 'gis'"
        >导出内容<select
          v-model="content"
          :disabled="busy"
          ><option value="resources">站点、设备、干扰源</option
          ><option value="candidates">候选链路（专用文件）</option></select
        ></label
      >
      <label
        >文件格式<select v-model="format"
          ><option value="xlsx">XLSX 工作簿</option
          ><option value="csv">UTF-8 CSV</option></select
        ></label
      >
      <label v-if="!candidateMode && format === 'csv'"
        >资源类型<select v-model="kind"
          ><option value="nodes">站点</option
          ><option value="devices">设备</option
          ><option value="interference_sources">干扰源</option></select
        ></label
      >
      <div
        v-else-if="!candidateMode"
        class="toolbar"
        ><label
          v-for="k in ['nodes', 'devices', 'interference_sources'] as const"
          :key="k"
          ><input
            v-model="kinds"
            type="checkbox"
            :value="k"
          />{{ { nodes: '站点', devices: '设备', interference_sources: '干扰源' }[k] }}</label
        ></div
      >
      <label
        >数据范围<select v-model="range"
          ><option value="all">全部已保存记录</option
          ><option
            v-if="filteredAvailable"
            value="filtered"
            >当前筛选范围（全部分页）</option
          ><option
            v-if="selectedAvailable"
            value="selected"
            >当前勾选/选中范围</option
          ></select
        ></label
      >
      <p
        class="notice"
        v-if="counts"
        ><span
          v-for="table in counts.tables"
          :key="table.kind"
          >{{ table.kind === 'topology_links' ? '候选链路' : table.kind }}：{{
            table.rows.length
          }}
          条；</span
        ><template v-if="!candidateMode"
          ><br />补齐所属站点/上级：{{ counts.added }} 个。</template
        ></p
      >
      <p
        v-else
        class="error"
        >请选择至少一类资源及有效范围。</p
      >
      <p
        v-if="candidateMode"
        class="readonly-note"
        >仅导出已保存的候选配置及外部参考结果，待评估字段留空。接收端需已有两端节点和设备；旧来源参考在详情查看，本文件不包含完整历史。</p
      >
      <p
        v-else
        class="readonly-note"
        >设备 CSV 不携带节点与型号字典，接收端必须已有引用对象。XLSX
        勾选节点表时补齐设备所属站点与上级。availability 为只读列。</p
      >
      <p class="readonly-note"
        >CSV 可能被表格软件当作公式的文本以 ~rp~ 加 JSON 字符串导出，本项目导入时恢复原文。</p
      >
      <p
        v-if="error"
        class="error"
        role="alert"
        >{{ error }}</p
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
          :disabled="busy || !counts || !auth.can('resources.view')"
          @click="download"
          >{{ busy ? '生成中…' : '下载文件' }}</button
        ></div
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { usePreviewStore } from '../stores/preview';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { selectResourceExport } from '../services/resource-files';
import type { ResourceFormat, ResourceKind, ResourceExportRequest } from '../types/resource-edit';
const props = defineProps<{
  visible: boolean;
  context: 'gis' | 'ledger';
  filteredIds?: Partial<Record<ResourceKind, string[]>>;
  selectedIds?: Partial<Record<ResourceKind, string[]>>;
  candidateFilteredIds?: string[];
  candidateSelectedIds?: string[];
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const preview = usePreviewStore(),
  auth = useAuthStore(),
  format = ref<ResourceFormat>('xlsx'),
  kind = ref<ResourceKind>('devices'),
  kinds = ref<ResourceKind[]>(['nodes', 'devices', 'interference_sources']),
  range = ref('all'),
  busy = ref(false),
  error = ref('');
const content = ref<'resources' | 'candidates'>('resources'),
  candidateMode = computed(() => props.context === 'gis' && content.value === 'candidates');
// 候选使用独立范围，原三类资源的 ID 对象和默认请求保持不变。
const filteredAvailable = computed(() =>
  candidateMode.value ? !!props.candidateFilteredIds : !!props.filteredIds,
);
const selectedAvailable = computed(() =>
  candidateMode.value ? !!props.candidateSelectedIds : !!props.selectedIds,
);
watch(
  () => props.context,
  () => {
    content.value = 'resources';
    range.value = 'all';
  },
);
watch(
  () => props.visible,
  (visible) => {
    if (visible && props.context === 'gis' && props.candidateSelectedIds?.length) {
      content.value = 'candidates';
      range.value = 'selected';
    }
  },
);
watch(
  content,
  () => {
    range.value = 'all';
  },
  { flush: 'sync' },
);
const request = computed<ResourceExportRequest>(() => ({
  format: format.value,
  kinds: candidateMode.value
    ? ['topology_links']
    : format.value === 'csv'
      ? [kind.value]
      : kinds.value,
  context: props.context,
  ...(range.value === 'filtered'
    ? {
        ids: candidateMode.value
          ? { topology_links: props.candidateFilteredIds ?? [] }
          : props.filteredIds,
      }
    : range.value === 'selected'
      ? {
          ids: candidateMode.value
            ? { topology_links: props.candidateSelectedIds ?? [] }
            : props.selectedIds,
        }
      : {}),
}));
const counts = computed(() => {
  if (!preview.data) return null;
  try {
    return selectResourceExport(preview.data.resources, request.value);
  } catch {
    return null;
  }
});
// 导出只读取已保存数据，下载前再次校验当前会话。
async function download() {
  if (
    busy.value ||
    !auth.can('resources.view') ||
    (props.context === 'gis' && !auth.can('situation.view'))
  )
    return;
  const session = auth.generation,
    context = props.context;
  busy.value = true;
  error.value = '';
  try {
    const value = await previewService.exportResources(request.value);
    if (
      session !== auth.generation ||
      context !== props.context ||
      !(await auth.check()) ||
      session !== auth.generation ||
      !auth.can('resources.view') ||
      (context === 'gis' && !auth.can('situation.view'))
    )
      return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(value.bytes)], { type: value.mime })),
      a = document.createElement('a');
    a.href = url;
    a.download = value.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    if (session === auth.generation) error.value = e instanceof Error ? e.message : '导出失败';
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
.fields > label {
  display: grid;
  gap: 8px;
}
.error {
  color: #ffb4b4;
}
</style>
