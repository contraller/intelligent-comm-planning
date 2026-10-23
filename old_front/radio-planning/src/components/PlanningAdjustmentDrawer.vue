<template>
  <AppDrawer
    :visible="visible"
    title="调整设备参数与路由"
    subtitle="输入完成后提交预览；任务条件和父方案保持不变。"
    @update:visible="!$event && emit('close')"
  >
    <p class="notice"
      ><strong>{{ parentLabel }}</strong
      ><br />父版本 {{ parent.id }} · 快照 {{ parent.snapshotId }}</p
    >
    <p
      v-if="status"
      class="notice"
      role="status"
      >{{ status }}</p
    >
    <div class="toolbar"
      ><button
        class="btn"
        :disabled="disabled || busy"
        @click="restore"
        >恢复原值</button
      ></div
    >
    <div
      v-if="examples?.length"
      class="examples"
      ><p>填入演示调整（仍需提交）</p
      ><button
        v-for="example in examples"
        :key="example.id"
        class="btn small"
        :disabled="disabled || busy"
        :title="example.source"
        @click="fill(example)"
        >{{ example.label }}</button
      ></div
    >
    <h3>逐设备参数</h3
    ><p class="muted"
      >空白沿用父方案；发射功率单位 dBm，天线高度单位 m。设备能力与结果是否达标由服务判断。</p
    >
    <section
      v-for="device in parent.configuration.devices"
      :key="device.deviceId"
      class="device-row"
      :data-device="device.deviceId"
    >
      <strong>{{ device.deviceId }} · {{ device.stationId }}</strong>
      <label
        >发射功率 / dBm <small>原值 {{ device.txPowerDbm }}</small
        ><input
          :value="numeric[device.deviceId]?.txPowerDbm"
          inputmode="decimal"
          :aria-label="`${device.deviceId} 发射功率`"
          :placeholder="String(device.txPowerDbm)"
          :disabled="disabled || busy"
          @input="editNumber(device.deviceId, 'txPowerDbm', $event)"
      /></label>
      <label
        >天线高度 / m <small>原值 {{ device.antennaHeightM }}</small
        ><input
          :value="numeric[device.deviceId]?.antennaHeightM"
          inputmode="decimal"
          :aria-label="`${device.deviceId} 天线高度`"
          :placeholder="String(device.antennaHeightM)"
          :disabled="disabled || busy"
          @input="editNumber(device.deviceId, 'antennaHeightM', $event)"
      /></label>
    </section>
    <h3>逐需求主路由</h3>
    <section
      v-for="demand in parent.input.demands"
      :key="demand.id"
      class="route-row"
      :data-demand="demand.id"
    >
      <strong>{{ demand.id }} · {{ demand.sourceId }} → {{ demand.targetId }}</strong>
      <p class="muted">原路径：{{ originalPath(demand.id).join(' → ') || '未提供' }}</p>
      <p
        v-if="
          !originalPath(demand.id).length &&
          !modelValue.manualPaths.some((row) => row.demandId === demand.id)
        "
        class="muted"
        >下方仅列需求两端，设置主路径或增加中间节点后才提交人工路径；可达性由服务判断。</p
      >
      <ol
        ><li
          v-for="(node, index) in path(demand.id)"
          :key="index"
        >
          <span v-if="index === 0 || index === path(demand.id).length - 1"
            >{{ node }} · {{ index === 0 ? '起点' : '终点' }}</span
          >
          <template v-else
            ><select
              :value="node"
              :aria-label="`${demand.id} 中间节点 ${index}`"
              :disabled="disabled || busy"
              @change="changeNode(demand.id, index, $event)"
              ><option
                v-for="id in parent.nodeIds"
                :key="id"
                :value="id"
                >{{ id }}</option
              ></select
            >
            <button
              class="btn small"
              :disabled="disabled || busy || index === 1"
              @click="move(demand.id, index, -1)"
              >上移</button
            ><button
              class="btn small"
              :disabled="disabled || busy || index === path(demand.id).length - 2"
              @click="move(demand.id, index, 1)"
              >下移</button
            ><button
              class="btn small"
              :disabled="disabled || busy"
              @click="remove(demand.id, index)"
              >移除</button
            ></template
          >
        </li></ol
      >
      <div class="toolbar"
        ><button
          v-if="!originalPath(demand.id).length"
          class="btn small"
          :disabled="disabled || busy"
          @click="setPath(demand.id, [demand.sourceId, demand.targetId])"
          >设置两端主路径</button
        ><button
          class="btn small"
          :disabled="disabled || busy || path(demand.id).length >= parent.nodeIds.length"
          @click="add(demand.id)"
          >增加中间节点</button
        ><button
          class="btn small"
          :disabled="disabled || busy"
          @click="restorePath(demand.id)"
          >恢复原路径</button
        ></div
      >
      <p
        v-for="backup in parent.configuration.routes.filter(
          (row) => row.demandId === demand.id && row.backup,
        )"
        :key="backup.id"
        class="muted"
        >原备份路径（只读）：{{ backup.nodeIds.join(' → ') }}</p
      >
    </section>
    <p class="muted"
      >只检查设备、需求和节点身份及输入格式。路径可达性、主备结果和覆盖变化由服务返回。</p
    >
    <p
      v-if="error || localError"
      class="notice warn"
      role="alert"
      >{{ error || localError }}</p
    >
    <ul
      v-if="fieldIssues.length"
      class="notice warn"
      role="alert"
      ><li
        v-for="(issue, index) in fieldIssues"
        :key="index"
        >{{ issue.objectId }} · {{ issue.field }}：{{ issue.message }}</li
      ></ul
    >
    <template #footer
      ><div class="toolbar"
        ><button
          class="btn"
          @click="emit('close')"
          >关闭</button
        ><button
          v-if="pending"
          class="btn primary"
          @click="emit('reconcile')"
          >核实原调整请求</button
        ><button
          v-else
          class="btn primary"
          :disabled="disabled || busy || !!fieldIssues.length"
          @click="emit('submit')"
          >提交调整并预览</button
        ></div
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import {
  bindPlanningAdjustmentExample,
  createPlanningAdjustment,
  validatePlanningAdjustment,
} from '../services/planning-adjustment';
import type {
  PlanningAdjustment,
  PlanningAdjustmentContext,
  PlanningAdjustmentExample,
} from '../types/planning-adjustment';
import type { PlanningIssue } from '../types/planning';

const props = defineProps<{
  visible: boolean;
  parent: PlanningAdjustmentContext;
  parentLabel: string;
  modelValue: PlanningAdjustment;
  examples?: PlanningAdjustmentExample[];
  disabled?: boolean;
  busy?: boolean;
  pending?: boolean;
  error?: string;
  issues?: PlanningIssue[];
  status?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: PlanningAdjustment];
  close: [];
  submit: [];
  reconcile: [];
}>();
// 保留输入文本，空值表示继承；非法数值交给基础校验，不能静默转成 0。
const numeric = ref<Record<string, { txPowerDbm: string; antennaHeightM: string }>>({}),
  localError = ref('');
function receive(value: PlanningAdjustment) {
  numeric.value = Object.fromEntries(
    props.parent.configuration.devices.map((device) => {
      const row = value.manualOverrides.find((item) => item.deviceId === device.deviceId);
      return [
        device.deviceId,
        {
          txPowerDbm: row?.txPowerDbm === undefined ? '' : String(row.txPowerDbm),
          antennaHeightM: row?.antennaHeightM === undefined ? '' : String(row.antennaHeightM),
        },
      ];
    }),
  );
}
watch(
  () => [props.visible, props.parent.id, props.parent.snapshotId],
  () => {
    receive(props.modelValue);
    localError.value = '';
  },
  { immediate: true },
);
const validation = computed(() => validatePlanningAdjustment(props.modelValue, props.parent));
const fieldIssues = computed(() =>
  [...validation.value, ...(props.issues ?? [])].filter(
    (item, index, rows) =>
      rows.findIndex(
        (x) => x.objectId === item.objectId && x.field === item.field && x.message === item.message,
      ) === index,
  ),
);
function publish(value: PlanningAdjustment) {
  if (!props.disabled && !props.busy) {
    localError.value = '';
    // 事件载荷解开嵌套响应式数组，保留 NaN 供校验而不是 JSON 转换成空值。
    emit('update:modelValue', {
      ...value,
      manualOverrides: value.manualOverrides.map((row) => ({ ...row })),
      manualPaths: value.manualPaths.map((row) => ({
        demandId: row.demandId,
        nodePath: [...row.nodePath],
      })),
    });
  }
}
function editNumber(id: string, key: 'txPowerDbm' | 'antennaHeightM', event: Event) {
  if (props.disabled || props.busy) return;
  numeric.value[id][key] = (event.target as HTMLInputElement).value;
  const manualOverrides = props.parent.configuration.devices.flatMap((device) => {
    const values = numeric.value[device.deviceId],
      power = values.txPowerDbm.trim(),
      height = values.antennaHeightM.trim();
    return power === '' && height === ''
      ? []
      : [
          {
            deviceId: device.deviceId,
            ...(power === '' ? {} : { txPowerDbm: Number(power) }),
            ...(height === '' ? {} : { antennaHeightM: Number(height) }),
          },
        ];
  });
  publish({ ...props.modelValue, manualOverrides });
}
function originalPath(demandId: string) {
  return (
    props.parent.configuration.routes.find((row) => row.demandId === demandId && !row.backup)
      ?.nodeIds ?? []
  );
}
function path(demandId: string) {
  const demand = props.parent.input.demands.find((row) => row.id === demandId),
    original = originalPath(demandId);
  // 原结果缺路由时只预填需求两端供编辑，须显式设置后才成为人工路径输入。
  return (
    props.modelValue.manualPaths.find((row) => row.demandId === demandId)?.nodePath ??
    (original.length ? original : demand ? [demand.sourceId, demand.targetId] : [])
  );
}
function setPath(demandId: string, nodePath: string[]) {
  publish({
    ...props.modelValue,
    manualPaths: [
      ...props.modelValue.manualPaths.filter((row) => row.demandId !== demandId),
      { demandId, nodePath },
    ],
  });
}
function changeNode(demandId: string, index: number, event: Event) {
  const nodes = [...path(demandId)];
  nodes[index] = (event.target as HTMLSelectElement).value;
  setPath(demandId, nodes);
}
function move(demandId: string, index: number, direction: number) {
  const nodes = [...path(demandId)],
    target = index + direction;
  if (target < 1 || target >= nodes.length - 1) return;
  [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
  setPath(demandId, nodes);
}
function remove(demandId: string, index: number) {
  setPath(
    demandId,
    path(demandId).filter((_node, i) => i !== index),
  );
}
function add(demandId: string) {
  const nodes = [...path(demandId)],
    candidate = props.parent.nodeIds.find((id) => !nodes.includes(id));
  if (candidate) {
    nodes.splice(nodes.length - 1, 0, candidate);
    setPath(demandId, nodes);
  }
}
function restorePath(demandId: string) {
  publish({
    ...props.modelValue,
    manualPaths: props.modelValue.manualPaths.filter((row) => row.demandId !== demandId),
  });
}
function restore() {
  const value = createPlanningAdjustment(props.parent);
  receive(value);
  publish(value);
}
function fill(example: PlanningAdjustmentExample) {
  if (props.disabled || props.busy) return;
  try {
    const value = bindPlanningAdjustmentExample(toRaw(example), props.parent);
    receive(value);
    publish(value);
  } catch (reason) {
    localError.value = reason instanceof Error ? reason.message : '此示例不适用于当前方案';
  }
}
</script>
<style scoped>
.toolbar,
.examples {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.examples {
  margin: 16px 0;
}
.examples p {
  width: 100%;
  margin: 0;
}
.device-row,
.route-row {
  display: grid;
  gap: 10px;
  margin: 14px 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 4px;
}
.device-row label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.device-row small,
.muted {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.route-row ol {
  margin: 0;
  padding-left: 22px;
}
.route-row li {
  margin: 8px 0;
}
.route-row select {
  max-width: 130px;
  margin-right: 6px;
}
.route-row .btn {
  margin-right: 4px;
}
.notice {
  overflow-wrap: anywhere;
}
.route-row p {
  margin: 0;
}
h3 {
  margin-top: 24px;
}
</style>
