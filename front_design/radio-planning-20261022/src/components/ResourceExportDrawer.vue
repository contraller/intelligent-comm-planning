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
        >文件格式<select v-model="format" :disabled="busy"
          ><option value="xlsx">XLSX 工作簿</option
          ><option value="csv">UTF-8 CSV</option></select
        ></label
      >
      <label v-if="!candidateMode && format === 'csv'"
        >资源类型<select v-model="kind" :disabled="busy"
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
            :disabled="busy"
          />{{ { nodes: '站点', devices: '设备', interference_sources: '干扰源' }[k] }}</label
        ></div
      >
      <label
        >数据范围<select v-model="range" :disabled="busy"
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
      <p v-if="context === 'gis'" class="readonly-note">
        资源版本：{{ gisQuery?.revision || '尚未读取' }}；状态来源：台账基线。
        <template v-if="range === 'filtered' && candidateMode">候选链路仅支持搜索、设备类别和告警条件，其他条件将拒绝导出。</template>
        <template v-else-if="range === 'filtered' && gisQuery?.browse === 'stations'">站点浏览：先按站点条件筛选，再取命中站点的全部设备。</template>
        <template v-else-if="range === 'filtered'">设备浏览：全库筛选设备，节点取命中设备所属站点。</template>
        <template v-if="range === 'filtered' && !candidateMode">干扰源仅使用自身搜索条件。</template>
        <template v-if="range === 'selected'">各类仅导出对应选择，未选类别为空。</template>
      </p>
      <p
        class="notice"
        v-if="boundCounts"
        ><span
          v-for="table in boundCounts.tables"
          :key="table.kind"
          >{{ table.kind === 'topology_links' ? '候选链路' : table.kind }}：{{
            table.count
          }}
          条；</span
        ><template v-if="!candidateMode"
          ><br />补齐所属站点/上级：{{ boundCounts.added }} 个。</template
        ></p
      >
      <ul v-if="boundCounts?.warnings?.length" class="notice" role="status">
        <li v-for="(warning, index) in boundCounts.warnings" :key="index">{{ warning }}</li>
      </ul>
      <p
        v-if="!boundCounts"
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
      <button v-if="!boundCounts" class="btn" :disabled="busy || checking || !canExport" @click="preflight">{{ checking ? '预检中…' : '重试预检' }}</button>
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
          >{{ busy ? '生成中…' : '下载文件' }}</button
        ></div
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { downloadFile } from '../services/file-download';
import type {
  ResourceFormat,
  ResourceKind,
  ResourceExportRequest,
  ResourceExportPreview,
} from '../types/resource-edit';
const props = defineProps<{
  visible: boolean;
  context: 'gis' | 'ledger';
  gisQuery?: Omit<NonNullable<ResourceExportRequest['gis']>, 'range' | 'selectedIds'>;
  filteredIds?: Partial<Record<ResourceKind, string[]>>;
  selectedIds?: Partial<Record<ResourceKind, string[]>>;
  candidateFilteredIds?: string[];
  candidateSelectedIds?: string[];
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const auth = useAuthStore(),
  format = ref<ResourceFormat>('xlsx'),
  kind = ref<ResourceKind>('devices'),
  kinds = ref<ResourceKind[]>(['nodes', 'devices', 'interference_sources']),
  range = ref<'all' | 'filtered' | 'selected'>('all'),
  busy = ref(false),
  checking = ref(false),
  error = ref('');
const content = ref<'resources' | 'candidates'>('resources'),
  candidateMode = computed(() => props.context === 'gis' && content.value === 'candidates');
// GIS 的全库筛选只传查询，不把当前分页收集的 ID 当作筛选结果。
const filteredAvailable = computed(
  () =>
    props.context === 'gis' ? !!props.gisQuery : !!props.filteredIds,
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
  { immediate: true },
);
watch(
  content,
  () => {
    range.value = 'all';
  },
  { flush: 'sync' },
);
const request = computed<ResourceExportRequest>(() => {
  const selectedKinds: ResourceKind[] = candidateMode.value
    ? ['topology_links']
    : format.value === 'csv'
      ? [kind.value]
      : [...kinds.value];
  const result: ResourceExportRequest = { format: format.value, kinds: selectedKinds, context: props.context };
  if (props.context === 'gis') {
    if (props.gisQuery) {
      const scope: NonNullable<ResourceExportRequest['gis']> = {
        revision: props.gisQuery.revision, browse: props.gisQuery.browse, range: range.value,
      };
      if (range.value === 'filtered') scope.filter = JSON.parse(JSON.stringify(props.gisQuery.filter ?? {}));
      if (range.value === 'selected') {
        const selected = candidateMode.value ? { topology_links: props.candidateSelectedIds ?? [] } : props.selectedIds;
        scope.selectedIds = Object.fromEntries(selectedKinds.map(key => [key, [...(selected?.[key] ?? [])]]));
      }
      result.gis = scope;
    }
  } else if (range.value !== 'all') result.ids = range.value === 'filtered' ? props.filteredIds : props.selectedIds;
  return result;
});
// 数量预检也由共同服务返回，不能从已显示分页推算全库导出范围。
const counts = ref<ResourceExportPreview | null>(null);
const signature = computed(() => JSON.stringify(request.value));
const previewSignature = ref('');
const previewGeneration = ref(-1);
const canExport = computed(() => auth.can('resources.view') && (props.context !== 'gis' || auth.can('situation.view')));
const boundCounts = computed(() => props.visible && canExport.value && previewGeneration.value === auth.generation && previewSignature.value === signature.value ? counts.value : null);
const canDownload = computed(() => !busy.value && !checking.value && !!boundCounts.value);
let serial = 0;
let active = true;
async function preflight() {
  const token = ++serial, owner = auth.generation, started = signature.value;
  counts.value = null;
  previewSignature.value = '';
  error.value = '';
  checking.value = false;
  if (!props.visible || !canExport.value) return;
  if (props.context === 'gis' && !props.gisQuery) { error.value = '尚无已保存资源版本，不能导出或按当前页替代全库筛选'; return; }
  checking.value = true;
  try {
    const value = await previewService.previewResourceExport(JSON.parse(started));
    if (active && token === serial && owner === auth.generation && props.visible && canExport.value && started === signature.value) {
      counts.value = value;
      previewSignature.value = started;
      previewGeneration.value = owner;
    }
  } catch (e) {
    if (active && token === serial && owner === auth.generation && started === signature.value)
      error.value = e instanceof Error ? e.message : '导出预检失败';
  } finally {
    if (token === serial) checking.value = false;
  }
}
watch(
  [() => props.visible, signature, () => auth.generation, canExport],
  preflight,
  { immediate: true },
);
onBeforeUnmount(() => {
  active = false;
  serial++;
});
// 导出只读取已保存数据，下载前再次校验当前会话。
async function download() {
  if (!canDownload.value) return;
  const session = auth.generation,
    token = serial,
    context = props.context,
    signature = JSON.stringify(request.value),
    valueRequest = JSON.parse(signature);
  busy.value = true;
  error.value = '';
  try {
    const value = await previewService.exportResources(valueRequest);
    if (
      session !== auth.generation ||
      token !== serial || !active ||
      context !== props.context ||
      signature !== JSON.stringify(request.value) ||
      !props.visible ||
      !(await auth.check()) ||
      session !== auth.generation ||
      token !== serial || !active || !props.visible || signature !== JSON.stringify(request.value) ||
      !canExport.value
    )
      return;
    downloadFile(value, 1000);
  } catch (e) {
    if (active && token === serial && session === auth.generation && signature === JSON.stringify(request.value)) {
      counts.value = null;
      previewSignature.value = '';
      error.value = e instanceof Error ? e.message : '导出失败';
    }
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
