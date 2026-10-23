<template>
  <div
    v-if="task.draft"
    ref="formRoot"
    class="task-form"
    :class="{ planning: isPlanning }"
    ><details
      class="input-group"
      open
      ><summary
        >基础信息 <small>{{ task.draft.name || '未命名任务' }}</small></summary
      ><div class="fields"
        ><label
          >{{ isPlanning ? '任务名称（必填）' : '任务名称'
          }}<input
            data-validation-field="name"
            :aria-invalid="isPlanning && messages('name').length > 0"
            v-model="task.draft.name"
            maxlength="60"
            :disabled="!task.editable"
          /><small
            v-for="issue in messages('name')"
            :key="issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        ><details
          v-if="!isPlanning"
          class="description-details"
          ><summary
            >任务说明 <small>{{ task.draft.description ? '已填写' : '选填' }}</small></summary
          ><label
            >任务说明<textarea
              v-model="task.draft.description"
              maxlength="500"
              :disabled="!task.editable"
            /></label
        ></details>
        <label v-if="!isPlanning"
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
        <label v-if="!isPlanning"
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
          v-if="!isPlanning"
          class="time-field"
          >开始时间（含时区）<input
            v-model="task.draft.startTime"
            :disabled="!task.editable"
            placeholder="2026-10-05T09:00:00+08:00" /></label
        ><label
          v-if="!isPlanning"
          class="time-field"
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
        <details class="area-details"
          ><summary
            >任务区域
            <small>{{
              isPlanning
                ? boundsValid
                  ? 'WGS84 · 范围有效'
                  : 'WGS84 · 范围待完善'
                : 'WGS84 · 已设置范围'
            }}</small></summary
          ><fieldset
            class="task-bounds"
            data-validation-field="bbox"
            tabindex="-1"
            ><legend>任务区域 / WGS84{{ isPlanning ? '（必填）' : '' }}</legend
            ><label
              v-for="(name, i) in ['最小经度', '最小纬度', '最大经度', '最大纬度']"
              :key="name"
              >{{ name
              }}<input
                v-model.number="task.draft.bbox[i]"
                type="number"
                step="0.01"
                :disabled="!task.editable" /></label
            ><small
              v-for="issue in messages('bbox')"
              :key="issue.message"
              class="field-error"
              role="alert"
              >{{ issue.message }}</small
            ></fieldset
          ></details
        >
        <p
          class="notice"
          data-validation-field="constraints"
          tabindex="-1"
          >必要通联连通率 100% · 中继最多 2 跳 · 抗毁性 ≥90%。总辐射功率以接口返回结果展示。</p
        >
      </div></details
    ><section
      class="input-group node-summary"
      data-validation-field="stationIds"
      tabindex="-1"
      ><div class="toolbar"
        ><h3>参与节点 · {{ task.draft.stationIds.length }}</h3
        ><button
          class="btn small"
          @click="nodesVisible = true"
          >管理参与节点</button
        ></div
      >
      <p
        v-for="issue in messages('stationIds')"
        :key="issue.message"
        class="field-error"
        role="alert"
        >{{ issue.message }}</p
      >
      <div class="selected-nodes"
        ><span
          v-for="id in task.draft.stationIds.slice(0, 3)"
          :key="id"
          >{{ task.nodes.find((n) => n.id === id)?.name ?? id }}</span
        ><span v-if="task.draft.stationIds.length > 3"
          >另 {{ task.draft.stationIds.length - 3 }} 个</span
        ><p
          v-if="!task.draft.stationIds.length"
          class="muted"
          >从节点管理或地图加入任务节点。</p
        ></div
      >
      <AppDrawer
        v-model:visible="nodesVisible"
        title="管理参与节点"
        subtitle="选择立即应用到任务草稿；关闭后保留选择，保存任务后才持久化。"
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
            :disabled="!candidates || candidates.pageNum <= 1 || resources.frozen"
            @click="loadNodes(page - 1)"
            >上页</button
          ><span>{{ candidates?.total ?? 0 }} 项 · {{ candidates?.pageNum ?? 1 }}</span
          ><button
            class="btn small"
            :disabled="
              !candidates ||
              candidates.pageNum * candidates.pageSize >= candidates.total ||
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
        ></AppDrawer
      ></section
    >
    <section
      class="input-group"
      data-validation-field="demands"
      tabindex="-1"
      ><div class="toolbar"
        ><h3>通联需求 · {{ task.draft.demands.length }}</h3
        ><button
          class="btn small"
          :disabled="!task.editable"
          @click="edit(null)"
          >新增需求</button
        ></div
      ><p
        v-for="issue in messages('demands')"
        :key="issue.message"
        class="field-error"
        role="alert"
        >{{ issue.message }}</p
      ><div
        v-for="d in task.draft.demands"
        :key="d.id"
        class="demand-row"
        ><span
          >{{ d.sourceId }} → {{ d.targetId
          }}<small v-if="!isPlanning">{{ routingSummary(d) }}</small
          ><small
            >{{ d.service || '未指定业务' }} · {{ d.priority }} ·
            {{ d.endpointMode === 'device' ? '设备端点' : '节点端点'
            }}{{ isPlanning ? (d.mandatory ? ' · 必要通联' : ' · 非必要通联') : '' }}</small
          ><small
            v-if="isPlanning"
            class="demand-metrics"
            >{{ d.dataVolumeMb == null ? '数据量未设' : d.dataVolumeMb + ' MB' }} ·
            {{ d.requiredRateKbps ?? '未填' }} kbps<br />
            时延 ≤{{ d.maxDelayMs ?? '未填' }} ms · 可靠性 ≥{{ d.minReliability ?? '未填' }}</small
          ><small
            v-for="issue in demandIssues(d.id)"
            :key="issue.field + issue.message"
            class="field-error"
            role="alert"
            >{{ planningIssueText(issue) }}</small
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
      ></section
    >
    <!-- 规划默认展示必要任务内容，可选补充和预设入口不挤占主表单。 -->
    <section
      v-if="isPlanning"
      class="input-group"
    >
      <h3>可用频率资源</h3>
      <div class="fields"
        ><label
          >频率资源组（必填）<select
            data-validation-field="frequencyId"
            :aria-invalid="messages('frequencyId').length > 0 || messages('presetId').length > 0"
            v-model="task.draft.frequencyId"
            :disabled="!task.editable"
          >
            <option
              v-for="f in task.catalog?.frequencies"
              :key="f.id"
              :value="f.id"
              >{{ f.label }} · {{ f.minKhz }}–{{ f.maxKhz }} kHz</option
            > </select
          ><small
            v-for="issue in [...messages('frequencyId'), ...messages('presetId')]"
            :key="issue.field + issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        ></div
      >
    </section>
    <details
      v-if="isPlanning"
      class="input-group"
    >
      <summary>时间与说明 <small>选填</small></summary>
      <div class="fields">
        <label class="time-field"
          >开始时间（含时区）<input
            data-validation-field="startTime"
            :aria-invalid="messages('startTime').length > 0"
            v-model="task.draft.startTime"
            :disabled="!task.editable"
            placeholder="2026-10-05T09:00:00+08:00"
          /><small
            v-for="issue in messages('startTime')"
            :key="issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        >
        <label class="time-field"
          >持续时长 / h<input
            data-validation-field="durationH"
            :aria-invalid="messages('durationH').length > 0"
            :value="task.draft.durationH"
            type="number"
            min="0"
            step="any"
            placeholder="填写时大于 0"
            :disabled="!task.editable"
            @input="
              task.draft.durationH =
                ($event.target as HTMLInputElement).value === ''
                  ? null
                  : Number(($event.target as HTMLInputElement).value)
            "
          /><small
            v-for="issue in messages('durationH')"
            :key="issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        >
        <label
          >任务说明<textarea
            data-validation-field="description"
            :aria-invalid="messages('description').length > 0"
            v-model="task.draft.description"
            maxlength="500"
            :disabled="!task.editable"
          /><small
            v-for="issue in messages('description')"
            :key="issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          >
        </label>
      </div>
    </details>
    <details
      v-if="isPlanning"
      class="input-group"
    >
      <summary
        >参数预设
        <small>{{
          task.catalog?.presets.find((p) => p.id === task.draft!.presetId)?.label
        }}</small></summary
      >
      <div class="fields"
        ><label
          >参数预设<select
            data-validation-field="presetId"
            :aria-invalid="messages('presetId').length > 0"
            :value="task.draft.presetId"
            :disabled="!task.editable"
            @change="task.applyPreset(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="p in task.catalog?.presets"
              :key="p.id"
              :value="p.id"
              >{{ p.label }}</option
            > </select
          ><small>切换将替换频率、部署及求解条件。</small
          ><small
            v-for="issue in messages('presetId')"
            :key="issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        ></div
      >
    </details>
    <!-- 折叠保留编辑器，避免丢失非法文本及未应用输入标记。 -->
    <details class="input-group"
      ><summary
        >部署约束
        <small
          >{{ task.draft.deploymentConstraints ? '已设置 · 展开查看' : '未设置'
          }}{{ task.auxiliary.deployment ? ' · 输入待完善' : '' }}</small
        ></summary
      >
      <p class="muted">节点管理中的查询同时更新通视节点可选列表。</p>
      <DeploymentConstraintsEditor
        :key="task.taskId + ':' + auth.generation"
        :owner="task.taskId + ':' + auth.generation"
        :model-value="task.draft.deploymentConstraints"
        :nodes="losOptions"
        :disabled="!task.editable"
        :inline-issues="isPlanning"
        @update:model-value="updateDeployment"
        @pending="task.auxiliary.deployment = $event"
    /></details>
    <details class="input-group"
      ><summary
        >频率与求解条件
        <small
          >{{
            task.draft.frequencyConstraints || task.draft.deploymentSolve
              ? '已设置 · 展开查看'
              : '沿用频率资源组'
          }}{{ task.auxiliary.options ? ' · 输入待完善' : '' }}</small
        ></summary
      >
      <PlanningOptionsEditor
        :key="'options:' + task.taskId + ':' + auth.generation"
        :owner="task.taskId + ':' + auth.generation"
        :model-value="task.draft"
        :frequency-resources="task.catalog?.frequencyResources"
        :disabled="!task.editable"
        :inline-issues="isPlanning"
        @update:model-value="updateOptions"
        @pending="task.auxiliary.options = $event"
    /></details>
    <TaskDemandEditor
      ref="demandEditor"
      v-model:visible="demandVisible"
      :demand="demand"
    />
  </div>
</template>
<script setup lang="ts">
// 节点选择立即更新草稿；通联需求仍在编辑抽屉确认后应用。
import { computed, nextTick, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import DeploymentConstraintsEditor from './DeploymentConstraintsEditor.vue';
import PlanningOptionsEditor from './PlanningOptionsEditor.vue';
import type { DeploymentConstraints } from '../types/deployment-constraints';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import type { PlanningDemand, PlanningInput, PlanningIssue } from '../types/planning';
import {
  fieldIssues,
  focusPlanningField,
  planningIssueText,
} from '../services/planning-issue-display';
import type { ReadNode, ResourcePage } from '../types/resource-read';
import TaskDemandEditor from './TaskDemandEditor.vue';
import AppDrawer from './AppDrawer.vue';
import { routingSummary } from '../services/planning-routing';
import { validTaskBounds } from '../services/task-api-validation';
const task = useTaskInputStore(),
  resources = useResourceReadStore(),
  search = ref(''),
  page = ref(1),
  candidates = ref<ResourcePage<ReadNode> | null>(null);
const nodesVisible = ref(false),
  demandVisible = ref(false),
  demand = ref<PlanningDemand | null>(null);
const isPlanning = computed(() => task.context === 'planning');
const formRoot = ref<HTMLElement | null>(null),
  demandEditor = ref<InstanceType<typeof TaskDemandEditor> | null>(null);
const messages = (field: string) =>
  isPlanning.value
    ? fieldIssues(
        task.displayIssues.filter(
          (issue) => !issue.objectId || issue.objectId === 'TASK' || issue.objectId === task.taskId,
        ),
        field,
      )
    : [];
const demandIssues = (id: string) =>
  isPlanning.value ? task.displayIssues.filter((issue) => issue.objectId === id) : [];
// 汇总定位不替换未应用需求；资源字段和未知身份只保留在汇总中。
async function focusIssue(issue: PlanningIssue): Promise<boolean> {
  if (!isPlanning.value) return false;
  if (issue.field === 'auxiliary.demand') return demandEditor.value?.focusField('') ?? false;
  if (issue.objectId && issue.objectId !== 'TASK' && issue.objectId !== task.taskId) {
    const rows = task.draft?.demands.filter((row) => row.id === issue.objectId) ?? [];
    if (
      rows.length !== 1 ||
      (demandVisible.value && task.auxiliary.demand && demand.value?.id !== issue.objectId)
    )
      return false;
    if (!demandVisible.value || demand.value?.id !== issue.objectId) edit(rows[0]);
    await nextTick();
    return demandEditor.value?.focusField(issue.field) ?? false;
  }
  const target =
    issue.field === 'auxiliary.deployment'
      ? 'deploymentConstraints'
      : issue.field === 'auxiliary.options'
        ? 'frequencyConstraints'
        : issue.field;
  if (target === 'stationIds') nodesVisible.value = true;
  await nextTick();
  return focusPlanningField(formRoot.value, target);
}
defineExpose({ focusIssue });
const boundsValid = computed(() => !!task.draft && validTaskBounds(task.draft.bbox));
// 切换任务关闭旧抽屉；失权时保留输入，由需求编辑器冻结旧身份的应用动作。
const auth = useAuthStore();
watch(
  () => task.taskId,
  () => {
    demandVisible.value = false;
    nodesVisible.value = false;
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
    { search: search.value, pageNum: nextPage, pageSize: 10, sort: 'id' },
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
/* 错误色仅作用于当前表单，不覆盖原帮助文字。 */
.task-form .field-error {
  color: #ffca8d;
  font-size: 12px;
}
.task-form [aria-invalid='true'] {
  border-color: #ffca8d;
}
.fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
.fields > * {
  grid-column: 1 / -1;
  min-width: 0;
}
.fields > .time-field {
  grid-column: auto;
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
.task-bounds {
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
  flex-direction: row;
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
.planning .demand-row > span {
  min-width: 0;
}
.planning .demand-row > button {
  flex: none;
  white-space: nowrap;
}
.planning .demand-metrics {
  line-height: 1.6;
}
.planning .input-group > h3 {
  margin: 0;
  font-size: 13px;
}
/* 局部紧凑排版，不改变其他页面的统一表单样式。 */
.input-group {
  border-bottom: 1px solid var(--line);
  padding: 14px 0;
}
.input-group:first-child {
  padding-top: 0;
}
summary {
  cursor: pointer;
  font-weight: 600;
  line-height: 1.8;
}
summary small,
.muted {
  font-weight: 400;
  color: var(--muted);
  font-size: 11px;
}
.fields {
  margin-top: 12px;
}
.toolbar h3 {
  flex: 1;
  margin: 0;
  font-size: 13px;
}
.node-options {
  max-height: 420px;
  overflow: auto;
}
.node-options label {
  padding: 9px 4px;
  border-bottom: 1px solid var(--line);
}
.node-options small {
  margin-top: 2px;
}
.selected-nodes span {
  border-radius: 4px;
  color: var(--muted);
}
.area-details {
  margin-top: 2px;
}
/* 摘要内的提示保持同行，避免继承字段帮助文本的块级排版。 */
.fields summary small {
  display: inline;
  margin: 0 0 0 4px;
}
.node-summary .selected-nodes span {
  max-width: calc(33.333% - 6px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
