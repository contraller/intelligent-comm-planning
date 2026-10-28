<template>
  <section class="gis-task-panel">
    <p class="muted">选择已保存任务，查看任务输入态势或其各版本方案的完整网络；任务编辑在网络规划完成。</p>
    <div class="toolbar">
      <input
        v-model="search"
        aria-label="搜索已保存任务"
        placeholder="任务名称 / 编号"
        @keyup.enter="controller.queryLibrary(1, search)"
      />
      <button
        class="btn small"
        :disabled="!controller.readable || controller.loading"
        @click="controller.queryLibrary(1, search)"
        >查询</button
      >
    </div>
    <p
      v-if="controller.loading || controller.selecting"
      role="status"
      >正在读取任务…</p
    >
    <p
      v-if="controller.error"
      class="error"
      role="alert"
      >{{ controller.error }}</p
    >
    <p
      v-if="controller.referenceNotice"
      class="muted"
      role="status"
      >{{ controller.referenceNotice }}</p
    >
    <label class="task-select">
      已保存任务
      <select
        aria-label="选择已保存任务"
        :value="controller.taskId ?? ''"
        :disabled="!controller.readable || controller.loading || controller.selecting"
        @change="selectTask(($event.target as HTMLSelectElement).value)"
      >
        <option value="">请选择任务</option>
        <option
          v-if="
            controller.selected &&
            !controller.library.some((row) => row.taskId === controller.taskId)
          "
          :value="controller.taskId!"
          >{{ controller.selected.name }} · {{ controller.taskId }}</option
        >
        <option
          v-for="row in controller.library"
          :key="row.taskId"
          :value="row.taskId"
          >{{ row.name }} · {{ row.taskId }}</option
        >
      </select>
    </label>
    <div class="toolbar">
      <button
        class="btn small"
        :disabled="controller.loading || controller.page <= 1"
        @click="controller.queryLibrary(controller.page - 1, search)"
        >上页</button
      >
      <span class="muted">{{ controller.total }} 项 · {{ controller.page }}</span>
      <button
        class="btn small"
        :disabled="controller.loading || controller.page * controller.pageSize >= controller.total"
        @click="controller.queryLibrary(controller.page + 1, search)"
        >下页</button
      >
    </div>
    <template v-if="controller.selected">
      <p class="muted">任务输入版本：{{ controller.selected.version }} · {{ controller.selected.updatedAt }}</p>
      <button
        class="btn small"
        :disabled="!controller.readable || controller.selecting"
        @click="viewTaskSituation"
        >{{ controller.selecting ? '正在载入任务态势…' : '查看任务态势' }}</button
      >
      <p v-if="viewFeedback" class="muted" role="status" aria-live="polite">{{ viewFeedback }}</p>
      <p
        v-if="controller.selected.resourceRevision"
        class="muted"
        >任务引用资源版本：{{ controller.selected.resourceRevision }}</p
      >
      <button
        class="btn small"
        :disabled="!controller.readable"
        @click="emit('editTask', controller.selected.taskId)"
        >编辑任务</button
      >
      <GisTaskPlanVersions v-if="httpMode" :key="controller.selected.taskId"
        :task-id="controller.selected.taskId" :readable="controller.readable"
        :session-generation="sessionGeneration ?? 0" :query-plans="previewService.queryPlanningPlanSummaries"
        @open-plan="emit('openPlan', $event)" />
      <p class="muted">以下为任务输入的参与节点和通联需求，通联需求不等于计算后的链路。</p>
      <h3>参与节点（{{ controller.selected.input.stationIds.length }}）</h3>
      <article
        v-for="id in controller.selected.input.stationIds"
        :key="id"
        class="task-row"
      >
        <span>{{ stationName(id) }} · {{ id }}</span>
        <button
          class="btn small"
          :disabled="!stationAvailable(id)"
          @click="emit('locateNode', id)"
          >定位节点</button
        >
        <small v-if="!stationAvailable(id)">冻结节点信息未提供，无法定位。</small>
      </article>
      <h3>通联需求（{{ controller.selected.input.demands.length }}）</h3>
      <article
        v-for="row in controller.selected.input.demands"
        :key="row.id"
        class="task-row"
        :class="{ selected: row.id === selectedDemandId }"
      >
        <strong>{{ row.id }}</strong>
        <span>{{ stationName(row.sourceId) }} → {{ stationName(row.targetId) }}</span>
        <small
          >{{ row.service || '业务未指定' }} · {{ row.mandatory ? '必要通联' : '非必要' }}</small
        >
        <button
          class="btn small"
          :disabled="!stationAvailable(row.sourceId) || !stationAvailable(row.targetId)"
          @click="emit('locateDemand', row.id)"
          >定位通联</button
        >
      </article>
    </template>
    <p
      v-else-if="!controller.loading && !controller.selecting && !controller.error"
      class="muted"
      >{{ controller.total ? '请选择任务。' : '暂无已保存任务，请前往网络规划创建并保存。' }}</p
    >
    <RouterLink
      v-if="controller.readable && !controller.total && !controller.loading && !controller.error"
      to="/planning"
      class="text-link"
      >前往网络规划创建任务</RouterLink
    >
  </section>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import GisTaskPlanVersions from './GisTaskPlanVersions.vue';
import { previewService } from '../services';
import { env } from '../config/env';
import type { GisTaskSelectionController } from '../composables/useGisTaskSelection';
import type { GisTaskSituationTarget } from '../types/gis-task';

const props = defineProps<{
  controller: GisTaskSelectionController;
  stations?: readonly { id: string; name: string }[];
  selectedDemandId?: string;
  sessionGeneration?: number;
}>();
const emit = defineEmits<{
  locateNode: [id: string];
  locateDemand: [id: string];
  editTask: [taskId: string];
  viewTask: [target: GisTaskSituationTarget];
  openPlan: [target: { taskId: string; planId: string }];
}>();
const httpMode = env.mode === 'http';
const search = ref(props.controller.search);
const viewFeedback = ref('');
watch(() => props.controller.selected, () => { viewFeedback.value = ''; });
// 面板只发定位与跳转意图，不持有或修改规划输入。
const stationAvailable = (id: string) => (props.stations ?? props.controller.nodes).some((row) => row.id === id);
const stationName = (id: string) =>
  (props.stations ?? props.controller.nodes).find((row) => row.id === id)?.name ?? `${id}（节点信息未提供）`;
function announceSituation() {
  const task = props.controller.selected;
  if (!task?.revision) return;
  viewFeedback.value = `已载入任务“${task.name}”的冻结态势：${props.controller.nodes.length} 个参与节点、${task.input.demands.length} 条通联需求。`;
  emit('viewTask', { taskId: task.taskId, revision: task.revision, snapshotId: props.controller.snapshot?.snapshotId ?? null });
}
async function viewTaskSituation() {
  if (!props.controller.readable || !props.controller.selected || props.controller.selecting) return;
  viewFeedback.value = '正在载入所选保存版本的任务态势…';
  if (await props.controller.loadReferences()) announceSituation();
  else viewFeedback.value = '任务态势未载入，请查看错误提示。';
}
async function selectTask(id: string) {
  viewFeedback.value = '';
  if (id) { if (await props.controller.select(id)) announceSituation(); }
  else props.controller.clearSelection();
}
</script>
<style scoped>
.section-back {
  margin-bottom: 14px;
}
.gis-task-panel {
  padding: 12px;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  flex: 1;
}
.task-select,
.task-row {
  display: grid;
  gap: 8px;
  margin: 12px 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.task-row {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
}
.task-row.selected {
  border-color: #8c6dbb;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.muted {
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
article {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
