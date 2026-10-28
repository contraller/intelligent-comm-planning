<template>
  <section class="task-plan-versions" aria-label="任务的已保存方案版本">
    <h3>已保存方案版本</h3>
    <p class="muted">方案版本独立于任务输入版本；打开后查看该方案全部节点与主备链路。</p>
    <p v-if="loading" role="status">正在读取方案版本…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label>
      选择方案版本
      <select aria-label="选择任务方案版本" :value="selectedId" :disabled="!readable || loading"
        @change="selectedId = ($event.target as HTMLSelectElement).value">
        <option value="">请选择方案版本</option>
        <option v-for="row in rows" :key="row.id" :value="row.id">
          {{ row.name }} · {{ row.version }} · {{ labels[row.state] }}{{ row.current ? '（当前方案）' : '' }}
        </option>
      </select>
    </label>
    <template v-if="selected">
      <p class="muted">保存时间：{{ selected.savedAt }}<br />方案编号：{{ selected.id }}</p>
      <p v-if="selected.sourceChanged" class="muted">来源已变化，仍查看所选版本保存时的网络。</p>
    </template>
    <div class="toolbar">
      <button class="btn small" :disabled="!readable || loading || !selected" @click="openSelected">查看方案完整网络</button>
      <button class="btn small" :disabled="!readable || loading" @click="load(1)">刷新版本</button>
    </div>
    <p v-if="!loading && !error && total === 0" class="muted">该任务尚未保存规划方案，可先查看任务输入态势。</p>
    <div v-if="total !== null && total > pageSize" class="toolbar">
      <button class="btn small" :disabled="loading || !readable || page <= 1" @click="load(page - 1)">上一页方案</button>
      <span class="muted">{{ total }} 个版本 · 第 {{ page }} 页</span>
      <button class="btn small" :disabled="loading || !readable || page * pageSize >= total" @click="load(page + 1)">下一页方案</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { PlanningApiServices, PlanningPlanSummary } from '../types/planning-api';

const props = defineProps<{
  taskId: string;
  readable: boolean;
  sessionGeneration: number;
  queryPlans: (input: Parameters<PlanningApiServices['queryPlanningPlanSummaries']>[0]) => ReturnType<PlanningApiServices['queryPlanningPlanSummaries']>;
}>();
const emit = defineEmits<{ openPlan: [target: { taskId: string; planId: string }] }>();
const labels = { SAVED: '已保存', REFERENCE: '参考方案', CONFIRMED: '已确认' };
const pageSize = 10;
const rows = ref<PlanningPlanSummary[]>([]), selectedId = ref('');
const page = ref(1), total = ref<number | null>(null), loading = ref(false), error = ref('');
const selected = computed(() => rows.value.find(row => row.id === selectedId.value && row.taskId === props.taskId));
let serial = 0, request: AbortController | undefined;

function cancel() { serial++; request?.abort(); request = undefined; }
async function load(nextPage: number) {
  cancel(); rows.value = []; selectedId.value = ''; total.value = null; error.value = ''; loading.value = false;
  if (!props.readable) { error.value = '没有方案查看权限'; return; }
  const token = serial, taskId = props.taskId, owner = props.sessionGeneration;
  const controller = new AbortController(); request = controller; loading.value = true;
  const current = () => token === serial && !controller.signal.aborted && props.readable
    && owner === props.sessionGeneration && taskId === props.taskId;
  try {
    // 按任务分页读取，保留服务端版本号；不合并同名方案，也不自动选择当前版本。
    const result = await props.queryPlans({ context: 'planning', taskId, pageNum: nextPage, pageSize, signal: controller.signal });
    if (!current()) return;
    if (result.pageNum !== nextPage || result.pageSize !== pageSize || result.items.some(row => row.taskId !== taskId)
      || new Set(result.items.map(row => row.id)).size !== result.items.length)
      throw new Error('方案目录的任务身份或分页不一致，未显示其他任务的方案。');
    rows.value = result.items; page.value = result.pageNum; total.value = result.total;
  } catch (reason) {
    if (current()) error.value = reason instanceof Error ? reason.message : '方案版本读取失败，请重试。';
  } finally { if (current()) loading.value = false; }
}
function openSelected() {
  if (props.readable && !loading.value && selected.value)
    emit('openPlan', { taskId: selected.value.taskId, planId: selected.value.id });
}
// 切换任务、身份或权限立即清理目录；迟到响应不能串入另一个任务。
watch(() => [props.taskId, props.sessionGeneration, props.readable], () => { page.value = 1; void load(1); }, { immediate: true });
onBeforeUnmount(cancel);
</script>

<style scoped>
.task-plan-versions { display: grid; gap: 8px; margin: 16px 0; padding: 12px 0; border-block: 1px solid var(--line); min-width: 0; }
h3, p { margin: 0; }
label { display: grid; gap: 6px; }
select { width: 100%; min-width: 0; }
.toolbar { display: flex; flex-wrap: wrap; gap: 7px; }
.muted { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
</style>
