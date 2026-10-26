<template>
  <AppDrawer
    :visible="visible"
    title="编辑通联需求"
    subtitle="需求线表示任务要求，规划结果由服务端返回。"
    @update:visible="!$event && close()"
  >
    <div
      v-if="row"
      ref="demandRoot"
      data-validation-field="demand"
      tabindex="-1"
      class="demand-fields"
      :class="{ planning: isPlanning }"
      ><label
        >需求编号<input
          data-validation-field="id"
          :aria-invalid="isPlanning && messages('id').length > 0"
          v-model="row.id"
          :disabled="!task.editable || !!demand"
          maxlength="120"
        /><small
          v-for="issue in messages('id')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      ><label
        >端点类型<select
          data-validation-field="endpointMode"
          :aria-invalid="isPlanning && messages('endpointMode').length > 0"
          v-model="row.endpointMode"
          :disabled="!task.editable"
          ><option value="station">节点</option
          ><option value="device">设备</option></select
        ><small
          v-for="issue in messages('endpointMode')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <PlanningRoutingEditor
        v-if="!isPlanning"
        :model-value="row"
        :owner="owner + ':' + rowEpoch"
        :disabled="!task.editable || !current"
        @update:model-value="updateRouting"
      />
      <label
        >{{ isPlanning ? '起点节点（必填）' : '起点节点'
        }}<select
          data-validation-field="sourceId"
          :aria-invalid="isPlanning && messages('sourceId').length > 0"
          v-model="row.sourceId"
          :disabled="!task.editable"
          @change="changeNode('source')"
          ><option
            v-for="id in task.draft?.stationIds"
            :key="id"
            :value="id"
            >{{ nodeName(id) }}</option
          ></select
        ><small
          v-for="issue in messages('sourceId')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <label
        >{{ isPlanning ? '终点节点（必填）' : '终点节点'
        }}<select
          data-validation-field="targetId"
          :aria-invalid="isPlanning && messages('targetId').length > 0"
          v-model="row.targetId"
          :disabled="!task.editable"
          @change="changeNode('target')"
          ><option
            v-for="id in task.draft?.stationIds"
            :key="id"
            :value="id"
            >{{ nodeName(id) }}</option
          ></select
        ><small
          v-for="issue in messages('targetId')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <template v-if="row.endpointMode === 'device'"
        ><label
          >{{ isPlanning ? '起点设备（必填）' : '起点设备'
          }}<select
            data-validation-field="sourceDeviceId"
            :aria-invalid="isPlanning && messages('sourceDeviceId').length > 0"
            v-model="row.sourceDeviceId"
            :disabled="!task.editable"
            ><option :value="null">请选择设备</option
            ><option
              v-if="row.sourceDeviceId && !source?.items.some((d) => d.id === row!.sourceDeviceId)"
              :value="row.sourceDeviceId"
              >{{ row.sourceDeviceId }}</option
            ><option
              v-for="d in source?.items"
              :key="d.id"
              :value="d.id"
              :disabled="d.availability === 'OFF_SHELF'"
              >{{ d.id }} · {{ d.modelName
              }}{{ d.availability === null ? ' · 上架状态未提供' : '' }}</option
            ></select
          ><small
            v-for="issue in messages('sourceDeviceId')"
            :key="issue.field + issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        >
        <label
          >{{ isPlanning ? '终点设备（必填）' : '终点设备'
          }}<select
            data-validation-field="targetDeviceId"
            :aria-invalid="isPlanning && messages('targetDeviceId').length > 0"
            v-model="row.targetDeviceId"
            :disabled="!task.editable"
            ><option :value="null">请选择设备</option
            ><option
              v-if="row.targetDeviceId && !target?.items.some((d) => d.id === row!.targetDeviceId)"
              :value="row.targetDeviceId"
              >{{ row.targetDeviceId }}</option
            ><option
              v-for="d in target?.items"
              :key="d.id"
              :value="d.id"
              :disabled="d.availability === 'OFF_SHELF'"
              >{{ d.id }} · {{ d.modelName
              }}{{ d.availability === null ? ' · 上架状态未提供' : '' }}</option
            ></select
          ><small
            v-for="issue in messages('targetDeviceId')"
            :key="issue.field + issue.message"
            class="field-error"
            role="alert"
            >{{ issue.message }}</small
          ></label
        >
        <div
          v-for="side in ['source', 'target'] as const"
          :key="side"
          class="toolbar"
          ><span>{{ side === 'source' ? '起点' : '终点' }}设备</span
          ><button
            class="btn small"
            :disabled="
              !(side === 'source' ? source : target) ||
              (side === 'source' ? source : target)!.pageNum <= 1
            "
            @click="loadDevices(side, (side === 'source' ? source : target)!.pageNum - 1)"
            >上页</button
          ><button
            class="btn small"
            :disabled="
              !(side === 'source' ? source : target) ||
              (side === 'source' ? source : target)!.pageNum * 10 >=
                (side === 'source' ? source : target)!.total
            "
            @click="loadDevices(side, (side === 'source' ? source : target)!.pageNum + 1)"
            >下页</button
          ><span role="alert">{{ resources.errors['task-demand:' + side] }}</span></div
        >
      </template>
      <label
        >{{ isPlanning ? '业务类型（选填）' : '业务类型'
        }}<select
          data-validation-field="service"
          :aria-invalid="isPlanning && messages('service').length > 0"
          v-model="row.service"
          :disabled="!task.editable"
          ><option value="">未指定</option
          ><option>话音</option
          ><option>数据</option
          ><option>短消息</option></select
        ><small
          v-for="issue in messages('service')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      ><label
        >{{ isPlanning ? '优先级（必填）' : '优先级'
        }}<select
          data-validation-field="priority"
          :aria-invalid="isPlanning && messages('priority').length > 0"
          v-model="row.priority"
          :disabled="!task.editable"
          ><option>P1</option
          ><option>P2</option
          ><option>P3</option></select
        ><small
          v-for="issue in messages('priority')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <label
        >{{ isPlanning ? '数据量 / MB（选填）' : '数据量 / MB'
        }}<input
          data-validation-field="dataVolumeMb"
          :aria-invalid="isPlanning && messages('dataVolumeMb').length > 0"
          :value="row.dataVolumeMb"
          type="number"
          min="0"
          :disabled="!task.editable"
          @input="
            row.dataVolumeMb =
              ($event.target as HTMLInputElement).value === ''
                ? null
                : Number(($event.target as HTMLInputElement).value)
          "
        /><small
          v-for="issue in messages('dataVolumeMb')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <label
        >{{ isPlanning ? '速率 / kbps（必填）' : '速率 / kbps'
        }}<input
          data-validation-field="requiredRateKbps"
          :aria-invalid="isPlanning && messages('requiredRateKbps').length > 0"
          v-model.number="row.requiredRateKbps"
          type="number"
          min="0"
          :disabled="!task.editable"
        /><small
          v-for="issue in messages('requiredRateKbps')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      ><label
        >{{ isPlanning ? '最大时延 / ms（必填）' : '最大时延 / ms'
        }}<input
          data-validation-field="maxDelayMs"
          :aria-invalid="isPlanning && messages('maxDelayMs').length > 0"
          v-model.number="row.maxDelayMs"
          type="number"
          min="0"
          :disabled="!task.editable"
        /><small
          v-for="issue in messages('maxDelayMs')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      ><label
        >{{ isPlanning ? '最低可靠性 / 0–1（必填）' : '最低可靠性 / 0–1'
        }}<input
          data-validation-field="minReliability"
          :aria-invalid="isPlanning && messages('minReliability').length > 0"
          v-model.number="row.minReliability"
          type="number"
          min="0"
          max="1"
          step="0.01"
          :disabled="!task.editable"
        /><small
          v-for="issue in messages('minReliability')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <label
        >{{ isPlanning ? '优先类别（选填）' : '优先类别'
        }}<select
          data-validation-field="preferredClass"
          :aria-invalid="isPlanning && messages('preferredClass').length > 0"
          v-model="row.preferredClass"
          :disabled="!task.editable"
          ><option :value="null">未指定</option
          ><option>HF</option
          ><option>VUHF</option></select
        ><small
          v-for="issue in messages('preferredClass')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      ><label class="check"
        ><input
          data-validation-field="mandatory"
          :aria-invalid="isPlanning && messages('mandatory').length > 0"
          v-model="row.mandatory"
          type="checkbox"
          :disabled="!task.editable"
        />必要通联<small
          v-for="issue in messages('mandatory')"
          :key="issue.field + issue.message"
          class="field-error"
          role="alert"
          >{{ issue.message }}</small
        ></label
      >
      <!-- 仅规划收起可选选路条件，编辑器始终挂载以保留未指定和非法原文。 -->
      <details
        v-if="isPlanning"
        class="routing-options"
        ><summary>路由条件（选填）</summary>
        <PlanningRoutingEditor
          :inline-issues="true"
          :model-value="row"
          :owner="owner + ':' + rowEpoch"
          :disabled="!task.editable || !current"
          @update:model-value="updateRouting"
        />
      </details> </div
    ><p
      v-if="visible && !current"
      class="notice warn"
      role="alert"
      >任务输入已变化，旧需求未应用；请关闭后重新打开。</p
    ><p
      v-for="issue in errors"
      :key="issue.field + issue.message"
      class="notice warn"
      >{{ isPlanning ? planningIssueText(issue) : issue.message }}</p
    ><div class="toolbar section-gap"
      ><button
        class="btn"
        @click="close"
        >取消</button
      ><button
        class="btn primary"
        :disabled="!task.editable || !current"
        :onClick="actions.apply"
        >应用到任务草稿</button
      ></div
    >
  </AppDrawer>
</template>
<script setup lang="ts">
// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
// 需求编辑保留独立副本，设备端点归属由已保存节点约束。
import { computed, nextTick, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import PlanningRoutingEditor from './PlanningRoutingEditor.vue';
import { useAuthStore } from '../stores/auth';
import { routingIssues, type RoutingInput } from '../services/planning-routing';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import { taskInputIssues } from '../services/task-api-validation';
import type { PlanningDemand, PlanningIssue } from '../types/planning';
import { focusPlanningField, planningIssueText } from '../services/planning-issue-display';
import type { ReadDevice, ResourcePage } from '../types/resource-read';
const props = defineProps<{ visible: boolean; demand: PlanningDemand | null }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const task = useTaskInputStore(),
  resources = useResourceReadStore();
const isPlanning = computed(() => task.context === 'planning');
const row = ref<PlanningDemand | null>(null),
  initial = ref(''),
  errors = ref<PlanningIssue[]>([]);
const attempted = ref(false),
  demandRoot = ref<HTMLElement | null>(null);
const messages = (field: string) =>
  isPlanning.value
    ? errors.value.filter(
        (issue) =>
          issue.field === field ||
          (field === 'targetId' && issue.field === 'sourceId') ||
          (field === 'targetDeviceId' && issue.field === 'sourceDeviceId') ||
          (['priority', 'mandatory'].includes(field) && issue.field === 'service'),
      )
    : [];
// 只核对当前副本，不为显示错误而应用或关闭需求。
function currentIssues(): PlanningIssue[] {
  if (!row.value || !task.draft) return [];
  const routing = routingIssues(row.value);
  if (routing.length) return routing;
  const next = structuredClone(toRaw(task.draft)),
    value = JSON.parse(JSON.stringify(row.value)) as PlanningDemand;
  const index = next.demands.findIndex((item) => item.id === props.demand?.id);
  if (index < 0) next.demands.push(value);
  else next.demands[index] = value;
  return taskInputIssues(next).filter((issue) => issue.objectId === value.id);
}
watch(
  row,
  () => {
    if (isPlanning.value && attempted.value) errors.value = currentIssues();
  },
  { deep: true },
);
async function focusField(field: string): Promise<boolean> {
  if (!props.visible || !current.value) return false;
  if (field) {
    attempted.value = true;
    errors.value = currentIssues();
  }
  await nextTick();
  return focusPlanningField(demandRoot.value, field || 'demand');
}
defineExpose({ focusField });
const auth = useAuthStore(),
  epoch = ref(0),
  rowEpoch = ref(0),
  rowOwner = ref('');
const owner = computed(() => `${task.taskId}:${auth.generation}:${epoch.value}`);
let alive = true;
// 只允许打开抽屉时对应的任务输入接受应用，替换草稿不能借用旧需求。
watch(
  () => task.draft,
  () => {
    epoch.value++;
  },
  { deep: true, flush: 'sync' },
);
const current = computed(() => props.visible && rowOwner.value === owner.value);
const actions = computed(() => {
  const generation = rowEpoch.value,
    opened = owner.value;
  return {
    apply: () => {
      if (alive && generation === rowEpoch.value && opened === owner.value) apply();
    },
  };
});
function updateRouting(value: RoutingInput) {
  if (current.value && task.editable && row.value) Object.assign(row.value, value);
}
const source = ref<ResourcePage<ReadDevice> | null>(null),
  target = ref<ResourcePage<ReadDevice> | null>(null);
const nodeName = (id: string) => task.nodes.find((n) => n.id === id)?.name ?? id;
const changed = computed(() => !!row.value && JSON.stringify(row.value) !== initial.value);
watch(
  [() => props.visible, () => props.demand],
  ([visible]) => {
    rowEpoch.value++;
    if (!visible) {
      delete task.auxiliary.demand;
      return;
    }
    rowOwner.value = owner.value;
    row.value = props.demand
      ? structuredClone(toRaw(props.demand))
      : {
          id: randomUuid(),
          endpointMode: 'station',
          sourceId: task.draft?.stationIds[0] ?? '',
          targetId: task.draft?.stationIds[1] ?? '',
          sourceDeviceId: null,
          targetDeviceId: null,
          preferredClass: null,
          service: '',
          priority: 'P1',
          mandatory: true,
          dataVolumeMb: null,
          requiredRateKbps: null,
          maxDelayMs: null,
          minReliability: null,
        };
    initial.value = JSON.stringify(row.value);
    attempted.value = false;
    errors.value = [];
    source.value = null;
    target.value = null;
    void loadDevices('source', 1);
    void loadDevices('target', 1);
  },
  { immediate: true },
);
watch(changed, (value) => {
  task.auxiliary.demand = props.visible && value;
});
async function loadDevices(side: 'source' | 'target', page: number) {
  const nodeId = side === 'source' ? row.value?.sourceId : row.value?.targetId;
  if (!nodeId) return;
  const data = await resources.fetchDevices(nodeId, page, 'task-demand:' + side);
  if (
    props.visible &&
    data &&
    nodeId === (side === 'source' ? row.value?.sourceId : row.value?.targetId)
  ) {
    if (side === 'source') source.value = data;
    else target.value = data;
  }
}
function changeNode(side: 'source' | 'target') {
  if (!row.value) return;
  if (side === 'source') row.value.sourceDeviceId = null;
  else row.value.targetDeviceId = null;
  void loadDevices(side, 1);
}
async function close() {
  const generation = rowEpoch.value,
    opened = owner.value;
  if (
    changed.value &&
    (await task.ask({
      title: '放弃需求编辑',
      message: '本条需求尚未应用到任务草稿。',
      discardLabel: '放弃本条修改',
    })) !== 'discard'
  )
    return;
  if (!alive || generation !== rowEpoch.value || opened !== owner.value) return;
  delete task.auxiliary.demand;
  emit('update:visible', false);
}
function apply() {
  if (!current.value || !row.value || !task.draft || !task.editable) return;
  // 在原 JSON 复制前校验路由值，非法数字不能被转换为合法空值。
  attempted.value = true;
  errors.value = routingIssues(row.value);
  if (errors.value.length) return;
  // 保留部署条件中的未完成数值，不能把 NaN 复制成“未指定”。
  const next = structuredClone(toRaw(task.draft)),
    value = JSON.parse(JSON.stringify(row.value)) as PlanningDemand;
  if (value.endpointMode !== 'device') {
    value.sourceDeviceId = null;
    value.targetDeviceId = null;
  }
  const index = next.demands.findIndex((d: PlanningDemand) => d.id === props.demand?.id);
  if (index < 0) next.demands.push(value);
  else next.demands[index] = value;
  errors.value = taskInputIssues(next).filter((i) => i.objectId === value.id);
  if (errors.value.length) return;
  task.updateInput(next);
  delete task.auxiliary.demand;
  emit('update:visible', false);
  void task.refreshReferences(false);
}
onBeforeUnmount(() => {
  alive = false;
  rowEpoch.value++;
  resources.cancelGroup('task-demand');
  delete task.auxiliary.demand;
});
</script>
<style scoped>
.demand-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.demand-fields.planning {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.demand-fields.planning label {
  min-width: 0;
}
/* 仅规划上下文显示字段级错误；原抽屉汇总保留。 */
.demand-fields .field-error {
  color: #ffca8d;
  font-size: 12px;
}
.demand-fields [aria-invalid='true'] {
  border-color: #ffca8d;
}
.routing-options {
  grid-column: 1 / -1;
  min-width: 0;
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.routing-options summary {
  cursor: pointer;
  font-size: 12px;
  line-height: 1.8;
}
.demand-fields label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.demand-fields input,
.demand-fields select {
  width: 100%;
}
.demand-fields .check {
  flex-direction: row;
  align-items: center;
}
.check input {
  width: auto;
}
.toolbar {
  flex-wrap: wrap;
  font-size: 11px;
}
</style>
