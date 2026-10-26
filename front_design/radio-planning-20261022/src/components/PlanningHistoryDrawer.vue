<template>
  <AppDrawer
    :visible="visible"
    title="规划历史"
    width="960px"
    subtitle="作业记录与已保存方案"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="toolbar">
      <button
        v-for="item in tabs"
        :key="item.id"
        class="btn"
        :class="{ primary: tab === item.id }"
        :disabled="loading || disabled"
        @click="changeTab(item.id)"
        >{{ item.label }}</button
      >
    </div>
    <form
      class="toolbar section-gap"
      @submit.prevent="query(1)"
    >
      <input
        v-model="search"
        maxlength="120"
        aria-label="搜索规划历史"
        placeholder="名称、方案、任务或作业编号"
        :disabled="disabled"
      />
      <select v-if="tab === 'saved'" v-model="planState" aria-label="方案状态" :disabled="loading || disabled">
        <option value="">全部状态</option>
        <option value="SAVED">待确认</option>
        <option value="REFERENCE">未达标参考</option>
        <option value="CONFIRMED">已确认</option>
      </select>
      <button
        class="btn"
        :disabled="loading || disabled"
        >查询</button
      >
    </form>
    <p
      v-if="error || openError"
      class="notice warn"
      role="alert"
      >{{ error || openError }}</p
    >
    <p
      v-if="loading"
      role="status"
      >正在读取…</p
    >
    <AppTable
      :sortable="false"
      compact
      v-if="tab === 'jobs'"
      :rows="jobs?.items ?? []"
      :columns="jobSummaryColumns"
      :detail-columns="jobColumns"
      :paginator="false"
      :page-size="10"
    >
      <template #name="{ row }"
        ><strong>{{ row.name }}</strong
        ><small class="cell-secondary">{{ row.taskId }}</small></template
      >
      <template #state="{ row }">{{ states[row.state as keyof typeof states] }}</template>
      <template #detail-state="{ row }">{{ states[row.state as keyof typeof states] }}</template>
      <template #actions="{ row }"
        ><button
          class="text-link"
          :disabled="loading || disabled"
          @click="emit('open-job', row)"
          >打开作业</button
        ></template
      >
    </AppTable>
    <AppTable v-else
        :sortable="false"
        compact
        :rows="savedPlans?.items ?? []"
        :columns="planColumns"
        :paginator="false"
        :page-size="10"
      >
        <template #name="{ row }"><strong>{{ row.name }}</strong><small class="cell-secondary">{{ row.taskId }} · {{ row.id }}</small></template>
        <template #state="{ row }">{{ planStates[row.state as keyof typeof planStates] }}{{ row.current ? ' · 当前方案' : '' }}</template>
        <template #sourceChanged="{ row }">{{ row.sourceChanged ? '来源已变化' : '来源未变化' }}</template>
        <template #actions="{ row }"
          ><button
            class="text-link"
            :disabled="loading || disabled"
            @click="emit('open-plan', row)"
            >打开方案</button
          ></template
        >
      </AppTable>
    <div class="toolbar section-gap">
      <button
        class="btn small"
        :disabled="loading || disabled || page <= 1"
        @click="query(page - 1)"
        >上页</button
      >
      <span>{{ total }} 条 · 第 {{ page }} 页</span>
      <button
        class="btn small"
        :disabled="loading || disabled || page * 10 >= total"
        @click="query(page + 1)"
        >下页</button
      >
    </div>
  </AppDrawer>
</template>
<script setup lang="ts">
// 目录只展示已保存摘要，打开后仍由完整方案页读取冻结结果。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { previewService } from '../services';
import { useAuthStore } from '../stores/auth';
import type { ApiPage } from '../types/task-api';
import type { ApiPlan, PlanningJobSummary, PlanningPlanSummary } from '../types/planning-api';
import AppDrawer from './AppDrawer.vue';
import AppTable from './AppTable.vue';
const props = defineProps<{
  visible: boolean;
  disabled: boolean;
  openError?: string;
  initialTab?: 'jobs' | 'saved' | 'references';
}>();
const emit = defineEmits<{
  'update:visible': [value: boolean];
  'open-job': [value: PlanningJobSummary];
  'open-plan': [value: PlanningPlanSummary];
}>();
const auth = useAuthStore();
const tabs = [
  { id: 'jobs', label: '作业记录' },
  { id: 'saved', label: '已保存方案' },
] as const;
const tab = ref<'jobs' | 'saved'>('jobs'),
  search = ref(''),
  loading = ref(false),
  error = ref(''),
  page = ref(1);
const jobs = ref<ApiPage<PlanningJobSummary> | null>(null),
  savedPlans = ref<ApiPage<PlanningPlanSummary> | null>(null);
const planState = ref<'' | ApiPlan['state']>('');
const total = computed(() => (tab.value === 'jobs' ? jobs.value : savedPlans.value)?.total ?? 0);
let ticket = 0,
  controller: AbortController | undefined;
function stop() {
  ticket++;
  controller?.abort();
  loading.value = false;
}
async function read<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (!props.visible || props.disabled || !auth.can('planning.view')) return;
  stop();
  const token = ticket,
    session = auth.generation;
  controller = new AbortController();
  const current = controller;
  loading.value = true;
  error.value = '';
  try {
    const value = await action(current.signal);
    if (
      token === ticket &&
      session === auth.generation &&
      props.visible &&
      !props.disabled &&
      !current.signal.aborted &&
      auth.can('planning.view')
    )
      return value;
  } catch (reason) {
    if (token === ticket && session === auth.generation && !current.signal.aborted)
      error.value = reason instanceof Error ? reason.message : '规划历史读取失败';
  } finally {
    if (token === ticket) loading.value = false;
  }
}
async function query(nextPage = 1) {
  const selected = tab.value,
    input = {
      context: 'planning' as const,
      pageNum: nextPage,
      pageSize: 10,
      search: search.value || undefined,
    };
  if (selected === 'jobs') {
    const value = await read((signal) => previewService.queryPlanningJobs({ ...input, signal }));
    if (value) {
      jobs.value = value;
      page.value = value.pageNum;
    }
  } else {
    const value = await read((signal) =>
      previewService.querySavedPlanningPlans({ ...input, state: planState.value || undefined, signal }),
    );
    if (value) {
      savedPlans.value = value;
      page.value = value.pageNum;
    }
  }
}
function changeTab(value: typeof tab.value) {
  tab.value = value;
  page.value = 1;
  search.value = '';
  planState.value = '';
  void query();
}
watch(
  () => props.visible,
  (value) => {
    // 明确的外部入口指定页签，普通历史按钮保留原有选择。
    if (value) {
      const initial = props.initialTab === 'references' ? 'saved' : props.initialTab;
      if (initial && tab.value !== initial) {
        changeTab(initial);
      } else void query();
    } else {
      stop();
    }
  },
  { immediate: true },
);
watch(
  () => auth.generation,
  () => {
    stop();
    jobs.value = null;
    savedPlans.value = null;
  },
);
onBeforeUnmount(stop);
watch(() => props.disabled, value => { if (value) stop(); });
const states = {
  PENDING: '等待中',
  RUNNING: '进行中',
  SUCCESS: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
const jobColumns = [
  { field: 'name', header: '任务名称' },
  { field: 'taskId', header: '任务编号' },
  { field: 'id', header: '作业编号' },
  { field: 'startedAt', header: '提交时间' },
  { field: 'state', header: '状态' },
];
const planColumns = [
  { field: 'name', header: '方案' },
  { field: 'taskId', header: '任务' },
  { field: 'version', header: '版本' },
  { field: 'state', header: '状态' },
  { field: 'sourceChanged', header: '来源' },
  { field: 'savedAt', header: '保存时间' },
];
const planStates = { SAVED: '待确认', REFERENCE: '未达标参考', CONFIRMED: '已确认' };
// 长身份与快照辅助字段移入详情，目录和快照只突出常用信息。
const jobSummaryColumns = jobColumns.filter((column) =>
  ['name', 'startedAt', 'state'].includes(column.field),
);
</script>
<style scoped>
.cell-secondary {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.toolbar input {
  flex: 1;
  min-width: 180px;
}
.notice {
  margin: 12px 0;
}
.reference-map {
  height: 300px;
  margin: 12px 0;
}
.reference h4 {
  margin: 16px 0 8px;
}
.muted {
  margin: 10px 0;
  font-size: 12px;
}
</style>
