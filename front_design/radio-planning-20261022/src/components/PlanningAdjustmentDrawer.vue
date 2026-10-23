<template>
  <section class="inline-editor">
    <!-- 现有页面只使用内联调整，保留同一份草稿与事件，移除旧抽屉外壳。 -->
    <h3>修改参数</h3>
    <p class="muted">选择设备参数或主路由进行修改，有效输入会自动预览。</p>
    <p class="notice"
      ><strong>{{ parentLabel }}</strong></p
    >
    <details class="parent-details"
      ><summary>父方案详情</summary
      ><p>父版本 {{ parent.id }} · 快照 {{ parent.snapshotId }}</p></details
    >
    <div class="toolbar"
      ><button
        class="btn"
        :disabled="disabled || busy"
        @click="restore"
        >恢复原值</button
      ></div
    >
    <details v-if="examples?.length"
      ><summary>演示调整预设</summary
      ><div class="examples"
        ><p>填入演示调整（自动预览）</p
        ><button
          v-for="example in examples"
          :key="example.id"
          class="btn small"
          :disabled="disabled || busy"
          :title="example.source"
          @click="fill(example)"
          >{{ example.label }}</button
        ></div
      ></details
    >
    <div
      class="tabs editor-tabs"
      role="tablist"
      aria-label="调整类型"
      @keydown="switchEditorTab"
      ><button
        :id="`${editorId}-devices-tab`"
        type="button"
        role="tab"
        data-section="devices"
        :aria-controls="`${editorId}-devices-panel`"
        :aria-selected="editSection === 'devices'"
        :tabindex="editSection === 'devices' ? 0 : -1"
        :class="{ active: editSection === 'devices' }"
        @click="editSection = 'devices'"
        >设备参数</button
      ><button
        :id="`${editorId}-routes-tab`"
        type="button"
        role="tab"
        data-section="routes"
        :aria-controls="`${editorId}-routes-panel`"
        :aria-selected="editSection === 'routes'"
        :tabindex="editSection === 'routes' ? 0 : -1"
        :class="{ active: editSection === 'routes' }"
        @click="editSection = 'routes'"
        >主路由</button
      ></div
    >
    <p
      v-if="fieldIssues.length"
      class="notice warn"
      role="alert"
      >有 {{ fieldIssues.length }} 项输入待完善，请根据下方问题选择对应对象修改。</p
    >
    <div
      v-show="editSection === 'devices'"
      :id="`${editorId}-devices-panel`"
      role="tabpanel"
      :aria-labelledby="`${editorId}-devices-tab`"
      ><h3>逐设备参数</h3
      ><p class="muted">选择设备后修改参数；空白沿用原值，有效输入会自动预览。</p>
      <label class="object-choice"
        >选择设备<select
          v-model="selectedDevice"
          aria-label="选择调整设备"
          ><option
            v-for="device in parent.configuration.devices"
            :key="device.deviceId"
            :value="device.deviceId"
            >{{ device.deviceId }} · {{ device.stationId }}</option
          ></select
        ></label
      >
      <section
        v-for="device in parent.configuration.devices"
        :key="device.deviceId"
        v-show="device.deviceId === selectedDevice"
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
      </section> </div
    ><div
      v-show="editSection === 'routes'"
      :id="`${editorId}-routes-panel`"
      role="tabpanel"
      :aria-labelledby="`${editorId}-routes-tab`"
      ><h3>逐需求主路由</h3>
      <label class="object-choice"
        >选择通联需求<select
          v-model="selectedDemand"
          aria-label="选择调整需求"
          ><option
            v-for="demand in parent.input.demands"
            :key="demand.id"
            :value="demand.id"
            >{{ demand.id }} · {{ demand.sourceId }} → {{ demand.targetId }}</option
          ></select
        ></label
      >
      <section
        v-for="demand in parent.input.demands"
        :key="demand.id"
        v-show="demand.id === selectedDemand"
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
        <details
          ><summary>原备份路径</summary
          ><p
            v-for="backup in parent.configuration.routes.filter(
              (row) => row.demandId === demand.id && row.backup,
            )"
            :key="backup.id"
            class="muted"
            >原备份路径（只读）：{{ backup.nodeIds.join(' → ') }}</p
          ></details
        >
      </section>
    </div>
    <details class="adjustment-help"
      ><summary>调整说明</summary
      ><p class="muted"
        >只检查设备、需求和节点身份及输入格式。路径可达性、主备结果和覆盖变化由服务返回。</p
      ></details
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
    <div class="toolbar inline-actions"
      ><button
        class="btn"
        :disabled="disabled || busy || !!fieldIssues.length || pending"
        @click="emit('submit')"
        >重试预览</button
      ><button
        v-if="pending"
        class="btn primary"
        @click="emit('reconcile')"
        >核实原调整请求</button
      ><button
        class="text-link"
        @click="emit('close')"
        >收起调整</button
      ></div
    >
  </section>
</template>
<script setup lang="ts">
import { computed, ref, toRaw, useId, watch } from 'vue';
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
}>();
const editSection = ref<'devices' | 'routes'>('devices');
const editorId = useId();
// 键盘切换与点击共用显示状态，隐藏面板保持挂载以保留输入原文。
function switchEditorTab(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  editSection.value =
    event.key === 'Home'
      ? 'devices'
      : event.key === 'End'
        ? 'routes'
        : editSection.value === 'devices'
          ? 'routes'
          : 'devices';
  (event.currentTarget as HTMLElement)
    .querySelector<HTMLButtonElement>(`[data-section="${editSection.value}"]`)
    ?.focus();
}
const selectedDevice = ref(''),
  selectedDemand = ref('');
// 只切换可见对象，不卸载其他输入，非法原文和已填草稿仍保留。
watch(
  () => [props.parent.id, props.parent.snapshotId],
  () => {
    editSection.value = 'devices';
    selectedDevice.value = props.parent.configuration.devices[0]?.deviceId ?? '';
    selectedDemand.value = props.parent.input.demands[0]?.id ?? '';
  },
  { immediate: true },
);
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
.editor-tabs {
  gap: 0;
  padding: 0;
  margin: 12px 0;
}
.editor-tabs button {
  flex: 1;
  padding: 12px 8px;
}
.editor-tabs button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}
.object-choice {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.object-choice select {
  min-width: 0;
  width: 100%;
}
.inline-editor > details {
  margin: 12px 0;
  font-size: 12px;
}
.inline-editor summary {
  cursor: pointer;
  color: var(--muted);
}
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
.inline-actions {
  padding: 12px 0;
  position: sticky;
  bottom: 0;
  background: #102035;
}
.route-row p {
  margin: 0;
}
h3 {
  margin-top: 24px;
}
.inline-editor .device-row {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.inline-editor .device-row > strong {
  grid-column: 1 / -1;
}
.inline-editor .notice {
  margin: 8px 0;
}
.parent-details {
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
  margin: 8px 0;
}
.parent-details summary {
  cursor: pointer;
}
</style>
