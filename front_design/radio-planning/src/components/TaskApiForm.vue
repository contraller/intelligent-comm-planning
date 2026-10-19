<template>
  <div
    v-if="task.draft"
    class="task-form"
    ><div class="fields"
      ><label
        >任务名称<input
          v-model="task.draft.name"
          maxlength="60"
          :disabled="!task.editable" /></label
      ><label
        >任务说明<textarea
          v-model="task.draft.description"
          maxlength="500"
          :disabled="!task.editable"
        />
      </label>
      <label
        >参数预设<select
          :value="task.draft.presetId"
          :disabled="!task.editable"
          @change="task.applyPreset(($event.target as HTMLSelectElement).value)"
          ><option
            v-for="p in task.catalog?.presets"
            :key="p.id"
            :value="p.id"
            >{{ p.label }}</option
          ></select
        ><small>用作参数默认值，可继续修改任务条件。</small></label
      >
      <label
        >频率资源组<select
          v-model="task.draft.frequencyId"
          :disabled="!task.editable"
          ><option
            v-for="f in task.catalog?.frequencies"
            :key="f.id"
            :value="f.id"
            >{{ f.label }} · {{ f.minKhz }}–{{ f.maxKhz }} kHz</option
          ></select
        ></label
      >
      <label
        >开始时间（含时区）<input
          v-model="task.draft.startTime"
          :disabled="!task.editable"
          placeholder="2026-10-05T09:00:00+08:00" /></label
      ><label
        >持续时长 / h<input
          :value="task.draft.durationH"
          type="number"
          min="0"
          :disabled="!task.editable"
          @input="
            task.draft.durationH =
              ($event.target as HTMLInputElement).value === ''
                ? null
                : Number(($event.target as HTMLInputElement).value)
          "
      /></label>
      <fieldset
        ><legend>任务区域 / WGS84</legend
        ><label
          v-for="(name, i) in ['最小经度', '最小纬度', '最大经度', '最大纬度']"
          :key="name"
          >{{ name
          }}<input
            v-model.number="task.draft.bbox[i]"
            type="number"
            step="0.01"
            :disabled="!task.editable" /></label
      ></fieldset>
      <p class="notice"
        >必要通联连通率 100% · 中继最多 2 跳 · 抗毁性 ≥90%。总辐射功率以接口返回结果展示。</p
      > </div
    ><div class="section-gap"
      ><h3>参与节点 · {{ task.draft.stationIds.length }}</h3
      ><div class="toolbar"
        ><input
          v-model="search"
          placeholder="节点编号或名称"
          @keyup.enter="loadNodes()"
        /><button
          class="btn small"
          :disabled="resources.frozen"
          @click="loadNodes()"
          >查询</button
        ></div
      >
      <p
        v-if="resources.errors['task-selector']"
        class="notice warn"
        >{{ resources.errors['task-selector'] }}</p
      ><div class="node-options"
        ><label
          v-for="node in candidates?.items"
          :key="node.id"
          ><input
            type="checkbox"
            :checked="task.draft.stationIds.includes(node.id)"
            :disabled="!task.editable || resources.frozen"
            @change="toggle(node.id, ($event.target as HTMLInputElement).checked)"
          /><span
            >{{ node.name }}<small>{{ node.id }}</small></span
          ></label
        ></div
      >
      <div class="toolbar"
        ><button
          class="btn small"
          :disabled="!candidates || candidates.page <= 1 || resources.frozen"
          @click="loadNodes(page - 1)"
          >上页</button
        ><span>{{ candidates?.total ?? 0 }} 项 · {{ candidates?.page ?? 1 }}</span
        ><button
          class="btn small"
          :disabled="
            !candidates ||
            candidates.page * candidates.pageSize >= candidates.total ||
            resources.frozen
          "
          @click="loadNodes(page + 1)"
          >下页</button
        ></div
      >
      <div class="selected-nodes"
        ><span
          v-for="id in task.draft.stationIds"
          :key="id"
          >{{ task.nodes.find((n) => n.id === id)?.name ?? id }}
          <button
            class="text-link"
            :disabled="!task.editable"
            @click="toggle(id, false)"
            >移除</button
          ></span
        ></div
      ></div
    >
    <div class="section-gap"
      ><div class="toolbar"
        ><h3>通联需求 · {{ task.draft.demands.length }}</h3
        ><button
          class="btn small"
          :disabled="!task.editable"
          @click="edit(null)"
          >新增需求</button
        ></div
      ><div
        v-for="d in task.draft.demands"
        :key="d.id"
        class="demand-row"
        ><span
          >{{ d.sourceId }} → {{ d.targetId }}<small>{{ routingSummary(d) }}</small
          ><small
            >{{ d.service || '未指定业务' }} · {{ d.priority }} ·
            {{ d.endpointMode === 'device' ? '设备端点' : '节点端点' }}</small
          ></span
        ><button
          class="text-link"
          :disabled="!task.editable"
          @click="edit(d)"
          >编辑</button
        ><button
          class="text-link"
          :disabled="!task.editable"
          @click="remove(d.id)"
          >移除</button
        ></div
      ></div
    >
    <p class="notice">上方节点查询同时更新通视节点可选列表。</p>
    <DeploymentConstraintsEditor
      :key="task.taskId + ':' + auth.generation"
      :owner="task.taskId + ':' + auth.generation"
      :model-value="task.draft.deploymentConstraints"
      :nodes="losOptions"
      :disabled="!task.editable"
      @update:model-value="updateDeployment"
      @pending="task.auxiliary.deployment = $event"
    />
    <PlanningOptionsEditor
      :key="'options:' + task.taskId + ':' + auth.generation"
      :owner="task.taskId + ':' + auth.generation"
      :model-value="task.draft"
      :frequency-resources="task.catalog?.frequencyResources"
      :disabled="!task.editable"
      @update:model-value="updateOptions"
      @pending="task.auxiliary.options = $event"
    />
    <TaskDemandEditor
      v-model:visible="demandVisible"
      :demand="demand"
    />
  </div>
</template>
<script setup lang="ts">
// 节点候选按服务端分页读取，抽屉输入确认后才写入共享草稿。
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import DeploymentConstraintsEditor from './DeploymentConstraintsEditor.vue';
import PlanningOptionsEditor from './PlanningOptionsEditor.vue';
import type { DeploymentConstraints } from '../types/deployment-constraints';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import type { PlanningDemand, PlanningInput } from '../types/planning';
import type { ReadNode, ResourcePage } from '../types/resource-read';
import TaskDemandEditor from './TaskDemandEditor.vue';
import { routingSummary } from '../services/planning-routing';
const task = useTaskInputStore(),
  resources = useResourceReadStore(),
  search = ref(''),
  page = ref(1),
  candidates = ref<ResourcePage<ReadNode> | null>(null);
const demandVisible = ref(false),
  demand = ref<PlanningDemand | null>(null);
// 切换任务关闭旧抽屉；失权时保留输入，由需求编辑器冻结旧身份的应用动作。
const auth = useAuthStore();
watch(
  () => task.taskId,
  () => {
    demandVisible.value = false;
    demand.value = null;
  },
  { flush: 'sync' },
);
// 共用节点查询结果与独立通视引用，额外节点不进入参与节点清单。
const losOptions = computed(() => [
  ...new Map(
    [...task.losNodes, ...(candidates.value?.items ?? [])].map((node) => [node.id, node]),
  ).values(),
]);
function updateDeployment(value: DeploymentConstraints | null) {
  if (!task.draft || !task.editable) return;
  const previousLos = JSON.stringify(task.draft.deploymentConstraints?.losRequiredNodeIds ?? []);
  task.updateInput({ ...structuredClone(toRaw(task.draft)), deploymentConstraints: value });
  // 普通数值/坐标编辑不触发引用读取，更不会发起规划。
  if (previousLos !== JSON.stringify(value?.losRequiredNodeIds ?? []))
    void task.refreshReferences(false);
}
let ticket = 0;
// 仅更新共享输入，不在条件编辑时启动求解。
function updateOptions(value: Pick<PlanningInput, 'frequencyConstraints' | 'deploymentSolve'>) {
  if (task.draft && task.editable)
    task.updateInput({ ...structuredClone(toRaw(task.draft)), ...value });
}
async function loadNodes(nextPage = 1) {
  page.value = nextPage;
  const token = ++ticket;
  const value = await resources.fetchNodes(
    { search: search.value, page: nextPage, pageSize: 10, sort: 'id' },
    'task-selector',
  );
  if (value && token === ticket) candidates.value = value;
}
watch(
  () => [resources.workspace?.revision, resources.context],
  () => void loadNodes(),
  { immediate: true },
);
function toggle(id: string, selected: boolean) {
  if (!task.draft || !task.editable) return;
  const input = structuredClone(toRaw(task.draft));
  input.stationIds = selected
    ? [...new Set([...input.stationIds, id])]
    : input.stationIds.filter((x: string) => x !== id);
  task.updateInput(input);
  void task.refreshReferences(false);
}
async function remove(id: string) {
  if (
    !task.draft ||
    !task.editable ||
    (await task.ask({
      title: '移除通联需求',
      message: '仅从当前任务草稿移除此需求。',
      saveLabel: '移除需求',
    })) !== 'save'
  )
    return;
  const next = structuredClone(toRaw(task.draft));
  next.demands = next.demands.filter((d: PlanningDemand) => d.id !== id);
  task.updateInput(next);
}
function edit(value: PlanningDemand | null) {
  demand.value = value ? JSON.parse(JSON.stringify(value)) : null;
  demandVisible.value = true;
}
onBeforeUnmount(() => {
  ticket++;
  resources.cancelGroup('task-selector');
  delete task.auxiliary.deployment;
  delete task.auxiliary.options;
});
</script>
<style scoped>
.task-form {
  font-size: 12px;
}
.fields {
  display: grid;
  gap: 12px;
}
.fields label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fields small,
.node-options small,
.demand-row small {
  color: var(--muted);
  display: block;
  margin-top: 5px;
}
.fields input,
.fields textarea,
.fields select {
  width: 100%;
}
fieldset {
  border: 1px solid var(--line);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.toolbar input {
  min-width: 100px;
  flex: 1;
}
.node-options {
  display: grid;
  gap: 5px;
  margin: 12px 0;
}
.node-options label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.node-options input {
  width: auto;
}
.selected-nodes {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.selected-nodes span {
  border: 1px solid var(--line);
  padding: 5px;
}
.demand-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.demand-row > span {
  flex: 1;
  overflow-wrap: anywhere;
}
</style>
