<template>
  <AppDrawer
    :visible="visible"
    title="采纳详情"
    :subtitle="adoptionId"
    @update:visible="!$event && close()"
  >
    <div class="toolbar">
      <button
        type="button"
        class="icon-button"
        title="重新读取采纳详情"
        aria-label="重新读取采纳详情"
        :disabled="loading || !readable || !taskId || !adoptionId"
        @click="load"
      ><i class="pi pi-refresh" aria-hidden="true" /></button>
      <p v-if="loading" role="status">正在读取采纳详情…</p>
    </div>
    <p v-if="!readable" role="status">需要 GIS 态势和网络规划查看权限。</p>
    <p v-else-if="!taskId || !adoptionId" role="status">请选择采纳记录。</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <dl v-if="detail" class="adoption-fields">
      <template v-for="field in fields" :key="field.label">
        <dt>{{ field.label }}</dt><dd>{{ field.value }}</dd>
      </template>
    </dl>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useAuthStore } from '../stores/auth';
import type {
  AdoptionDetail, InterferenceWorkbenchServices, RunDetail, WorkbenchState,
} from '../types/interference-workbench';

const props = defineProps<{
  visible: boolean;
  taskId: string;
  adoptionId: string;
  services: Pick<InterferenceWorkbenchServices, 'getAdoption' | 'getRun'>;
}>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const auth = useAuthStore();
const readable = computed(() => !auth.blocked && auth.can('situation.view') && auth.can('planning.view'));
const detail = shallowRef<AdoptionDetail | null>(null), run = shallowRef<RunDetail | null>(null);
const loading = ref(false), error = ref('');
let controller: AbortController | undefined, sequence = 0;
const labels: Record<WorkbenchState, string> = {
  PENDING: '等待重算', RUNNING: '规划重算中', CANCEL_REQUESTED: '取消请求中',
  SUCCESS: '重算结果已保存', FAILED: '重算失败', CANCELLED: '重算已取消',
};
const display = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? '未提供' : String(value);
const fields = computed(() => {
  const row = detail.value;
  if (!row) return [];
  const analysis = run.value;
  const measure = analysis?.result?.measures.find(value => value.measure_id === row.measure_id);
  const source = row.source_state;
  // The persisted DTO exposes only the planning request ID, not the adoption write request ID.
  return [
    ['采纳编号', row.adoption_id], ['任务编号', row.task_id],
    ['采纳请求号', null], ['规划请求号', row.planning_request_id],
    ['原分析编号', row.run_id], ['措施编号', row.measure_id], ['措施名称', measure?.title],
    ['父方案编号', analysis?.plan_id], ['父方案版本', analysis?.plan_version],
    ['子规划作业编号', row.planning_job_id], ['子规划状态', row.planning_state],
    ['子规划进度', row.planning_progress == null ? null : `${row.planning_progress}%`],
    ['子方案编号', row.result_plan_id], ['子方案状态', row.result_plan_state],
    ['结论', `${labels[row.state]} · ${row.state}`], ['失败信息', row.error],
    ['来源状态', source.state], ['来源说明', source.reasons.join('；')],
    ['来源摘要', row.source_hash], ['数据来源', row.data_origin],
    ['采纳版本', row.adoption_version], ['创建时间', row.created_at], ['更新时间', row.updated_at],
  ].map(([label, value]) => ({ label: String(label), value: display(value) }));
});

function invalidate() {
  sequence++;
  controller?.abort(); controller = undefined;
  detail.value = null; run.value = null; error.value = ''; loading.value = false;
}
async function load() {
  invalidate();
  if (!props.visible || !readable.value || !props.taskId || !props.adoptionId) return;
  const taskId = props.taskId, adoptionId = props.adoptionId, services = props.services;
  const token = sequence, generation = auth.generation, request = new AbortController();
  controller = request; loading.value = true;
  const current = () => token === sequence && !request.signal.aborted && props.visible
    && readable.value && auth.generation === generation && props.taskId === taskId
    && props.adoptionId === adoptionId && props.services === services;
  try {
    const value = await services.getAdoption({ task_id: taskId, adoption_id: adoptionId }, request.signal);
    if (!current()) return;
    if (value.task_id !== taskId || value.adoption_id !== adoptionId)
      throw new Error('采纳详情与请求任务或编号不一致。');
    detail.value = value;
    try {
      const analysis = await services.getRun({ task_id: taskId, run_id: value.run_id }, request.signal);
      if (!current()) return;
      if (analysis.task_id !== taskId || analysis.run_id !== value.run_id || analysis.source_hash !== value.source_hash)
        throw new Error('原分析的任务、编号或来源摘要与采纳记录不一致。');
      run.value = analysis;
    } catch (reason) {
      if (current()) error.value = '原分析详情读取失败：' + (reason instanceof Error ? reason.message : String(reason));
    }
  } catch (reason) {
    if (current()) error.value = '采纳详情读取失败：' + (reason instanceof Error ? reason.message : String(reason));
  } finally {
    if (current()) { loading.value = false; controller = undefined; }
  }
}
function close() { invalidate(); emit('update:visible', false); }
watch(
  [() => props.visible, () => props.taskId, () => props.adoptionId, () => props.services,
    () => auth.generation, readable],
  () => { void load(); },
  { immediate: true },
);
onBeforeUnmount(invalidate);
</script>
<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.icon-button { width: 32px; height: 32px; flex: 0 0 32px; }
.adoption-fields { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr); gap: 10px 12px; }
dt { color: var(--muted); }
dd { margin: 0; }
dt, dd, p { font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; min-width: 0; }
.error { color: #ffb4b4; }
@media (max-width: 420px) {
  .adoption-fields { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  dd { margin-bottom: 8px; }
}
</style>
