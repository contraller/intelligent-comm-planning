<template>
  <AppDrawer
    :visible="visible"
    title="编辑通联需求"
    subtitle="需求线表示任务要求，规划结果由服务端返回。"
    @update:visible="!$event && close()"
  >
    <div
      v-if="row"
      class="demand-fields"
      ><label
        >需求编号<input
          v-model="row.id"
          :disabled="!task.editable || !!demand"
          maxlength="120" /></label
      ><label
        >端点类型<select
          v-model="row.endpointMode"
          :disabled="!task.editable"
          ><option value="station">节点</option
          ><option value="device">设备</option></select
        ></label
      >
      <PlanningRoutingEditor
        :model-value="row"
        :owner="owner + ':' + rowEpoch"
        :disabled="!task.editable || !current"
        @update:model-value="updateRouting"
      />
      <label
        >起点节点<select
          v-model="row.sourceId"
          :disabled="!task.editable"
          @change="changeNode('source')"
          ><option
            v-for="id in task.draft?.stationIds"
            :key="id"
            :value="id"
            >{{ nodeName(id) }}</option
          ></select
        ></label
      >
      <label
        >终点节点<select
          v-model="row.targetId"
          :disabled="!task.editable"
          @change="changeNode('target')"
          ><option
            v-for="id in task.draft?.stationIds"
            :key="id"
            :value="id"
            >{{ nodeName(id) }}</option
          ></select
        ></label
      >
      <template v-if="row.endpointMode === 'device'"
        ><label
          >起点设备<select
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
          ></label
        >
        <label
          >终点设备<select
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
              (side === 'source' ? source : target)!.page <= 1
            "
            @click="loadDevices(side, (side === 'source' ? source : target)!.page - 1)"
            >上页</button
          ><button
            class="btn small"
            :disabled="
              !(side === 'source' ? source : target) ||
              (side === 'source' ? source : target)!.page * 10 >=
                (side === 'source' ? source : target)!.total
            "
            @click="loadDevices(side, (side === 'source' ? source : target)!.page + 1)"
            >下页</button
          ><span role="alert">{{ resources.errors['task-demand:' + side] }}</span></div
        >
      </template>
      <label
        >业务类型<select
          v-model="row.service"
          :disabled="!task.editable"
          ><option value="">未指定</option
          ><option>话音</option
          ><option>数据</option
          ><option>短消息</option></select
        ></label
      ><label
        >优先级<select
          v-model="row.priority"
          :disabled="!task.editable"
          ><option>P1</option
          ><option>P2</option
          ><option>P3</option></select
        ></label
      >
      <label
        >数据量 / MB<input
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
      /></label>
      <label
        >速率 / kbps<input
          v-model.number="row.requiredRateKbps"
          type="number"
          min="0"
          :disabled="!task.editable" /></label
      ><label
        >最大时延 / ms<input
          v-model.number="row.maxDelayMs"
          type="number"
          min="0"
          :disabled="!task.editable" /></label
      ><label
        >最低可靠性 / 0–1<input
          v-model.number="row.minReliability"
          type="number"
          min="0"
          max="1"
          step="0.01"
          :disabled="!task.editable"
      /></label>
      <label
        >优先类别<select
          v-model="row.preferredClass"
          :disabled="!task.editable"
          ><option :value="null">未指定</option
          ><option>HF</option
          ><option>VUHF</option></select
        ></label
      ><label class="check"
        ><input
          v-model="row.mandatory"
          type="checkbox"
          :disabled="!task.editable"
        />必要通联</label
      > </div
    ><p
      v-if="visible && !current"
      class="notice warn"
      role="alert"
      >任务输入已变化，旧需求未应用；请关闭后重新打开。</p
    ><p
      v-for="message in errors"
      :key="message"
      class="notice warn"
      >{{ message }}</p
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
// 需求编辑保留独立副本，设备端点归属由已保存节点约束。
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import PlanningRoutingEditor from './PlanningRoutingEditor.vue';
import { useAuthStore } from '../stores/auth';
import { routingIssues, type RoutingInput } from '../services/planning-routing';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import { taskInputIssues } from '../services/task-api-validation';
import type { PlanningDemand } from '../types/planning';
import type { ReadDevice, ResourcePage } from '../types/resource-read';
const props = defineProps<{ visible: boolean; demand: PlanningDemand | null }>();
const emit = defineEmits<{ 'update:visible': [value: boolean] }>();
const task = useTaskInputStore(),
  resources = useResourceReadStore();
const row = ref<PlanningDemand | null>(null),
  initial = ref(''),
  errors = ref<string[]>([]);
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
          id: crypto.randomUUID(),
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
  errors.value = routingIssues(row.value).map((issue) => issue.message);
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
  errors.value = taskInputIssues(next)
    .filter((i) => i.objectId === value.id)
    .map((i) => i.message);
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
