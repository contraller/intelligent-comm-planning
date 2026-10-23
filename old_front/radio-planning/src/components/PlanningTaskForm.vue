<template>
  <section
    ref="taskRoot"
    tabindex="-1"
    class="panel task-form"
  >
    <div class="panel-head">
      <h3>任务与通联需求</h3>
      <span class="chip">当前任务草稿</span>
    </div>
    <fieldset
      :disabled="!auth.can('planning.execute') || locked"
      class="task-fields"
    >
      <label
        >任务名称<input
          data-validation-field="name"
          :value="modelValue.name"
          maxlength="60"
          @input="update('name', ($event.target as HTMLInputElement).value)"
      /></label>
      <label
        >规划说明<textarea
          data-validation-field="description"
          :value="modelValue.description"
          rows="2"
          maxlength="500"
          @input="update('description', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
      <label
        >演示场景与档位<select
          data-validation-field="presetId"
          :value="modelValue.presetId"
          @change="emit('preset', ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="p in presets"
            :key="p.id"
            :value="p.id"
            >{{ p.label }}</option
          >
        </select></label
      >
      <p class="muted"
        >切换档位将替换区域、时间、节点、需求和频率输入；名称与说明保留。{{
          selectedPreset?.source
        }}</p
      >
      <label
        >频率资源组<select
          data-validation-field="frequencyId"
          :value="modelValue.frequencyId"
          @change="update('frequencyId', ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="f in frequencies"
            :key="f.id"
            :value="f.id"
          >
            {{ f.label }} · {{ f.minKhz }}–{{ f.maxKhz }} kHz
          </option>
        </select></label
      >
      <label
        >开始时间（可空，ISO 8601 含时区）<input
          data-validation-field="startTime"
          :value="modelValue.startTime ?? ''"
          placeholder="2026-10-05T09:00:00+08:00"
          @input="update('startTime', ($event.target as HTMLInputElement).value.trim() || null)"
      /></label>
      <label
        >持续时长 / 小时（可空）<input
          data-validation-field="durationH"
          :value="modelValue.durationH ?? ''"
          inputmode="decimal"
          @input="
            update(
              'durationH',
              ($event.target as HTMLInputElement).value.trim() === ''
                ? null
                : Number(($event.target as HTMLInputElement).value),
            )
          "
      /></label>
      <div
        class="bbox-fields"
        data-validation-field="bbox"
        tabindex="-1"
      >
        <label
          v-for="(label, index) in ['最小经度', '最小纬度', '最大经度', '最大纬度']"
          :key="label"
        >
          {{ label
          }}<input
            :value="Number.isFinite(modelValue.bbox[index]) ? modelValue.bbox[index] : ''"
            inputmode="decimal"
            @input="updateBbox(index, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
      <DeploymentConstraintsEditor
        :key="planning.taskId + ':' + auth.generation"
        :owner="planning.taskId + ':' + auth.generation"
        :model-value="modelValue.deploymentConstraints"
        :nodes="resources.stations"
        :disabled="locked || !auth.can('planning.execute')"
        @update:model-value="update('deploymentConstraints', $event)"
        @pending="deploymentPending = $event"
      />
      <PlanningOptionsEditor
        :key="'options:' + planning.taskId + ':' + auth.generation"
        :owner="planning.taskId + ':' + auth.generation"
        :model-value="modelValue"
        :frequency-resources="planning.frequencyResources"
        :disabled="locked || !auth.can('planning.execute')"
        @update:model-value="updateOptions"
        @pending="optionsPending = $event"
      />
      <div
        class="readonly-box"
        data-validation-field="constraints"
        tabindex="-1"
      >
        <strong>固定约束</strong>
        <p>必要通联连通率 100% · 中继 ≤2 跳 · 抗毁性 ≥90%</p>
        <small>WGS84 区域：{{ modelValue.bbox.join(' / ') }}</small>
      </div>
      <label
        >参与节点（{{ modelValue.stationIds.length }}）<input
          data-validation-field="stationIds"
          v-model="search"
          placeholder="搜索节点名称或 ID"
      /></label>
      <div class="nodes">
        <label
          v-for="node in available"
          :key="node.id"
          ><input
            type="checkbox"
            :checked="modelValue.stationIds.includes(node.id)"
            :disabled="!modelValue.stationIds.includes(node.id) && nodeUnavailable(node.id)"
            @change="toggleNode(node.id, ($event.target as HTMLInputElement).checked)"
          /><span
            >{{ node.id }} · {{ node.name
            }}{{
              stationEquipmentLabel(resources, node.id)
                ? ' · ' +
                  stationEquipmentLabel(resources, node.id) +
                  (nodeUnavailable(node.id) ? '，请调整参与节点' : '')
                : ''
            }}</span
          ></label
        >
      </div>
      <div class="toolbar">
        <h3>通联需求（{{ modelValue.demands.length }}）</h3>
        <button
          class="btn small"
          data-validation-field="demands"
          @click="edit()"
          >新增需求</button
        >
      </div>
      <article
        v-for="row in modelValue.demands"
        :key="row.id"
        class="demand-row"
      >
        <small>{{ routingSummary(row) }}</small>
        <strong
          >{{ row.sourceId }}{{ row.sourceDeviceId ? ' / ' + row.sourceDeviceId : '' }} →
          {{ row.targetId }}{{ row.targetDeviceId ? ' / ' + row.targetDeviceId : '' }}</strong
        ><small
          >{{ row.service }} · {{ row.priority }} ·
          {{ row.mandatory ? '必要通联' : '非必要' }}</small
        >
        <small
          >{{ row.requiredRateKbps ?? '未填' }} kbps / {{ row.maxDelayMs ?? '未填' }} ms / 可靠性
          {{ row.minReliability === null ? '未填' : `${row.minReliability * 100}%` }}</small
        >
        <div class="toolbar">
          <button
            class="text-link"
            @click="edit(row)"
            >编辑</button
          ><button
            class="text-link"
            @click="emit('remove', row.id)"
            >移除</button
          >
        </div>
      </article>
      <button
        v-if="showSubmit"
        class="btn primary submit"
        :disabled="submitDisabled"
        @click="emit('submit')"
      >
        <i class="pi pi-play" />开始规划 · Mock 任务
      </button>
    </fieldset>
    <ul
      v-if="issues.length"
      class="issues"
      role="alert"
    >
      <li
        v-for="(issue, index) in issues"
        :key="index"
      >
        {{ issue.objectId }} / {{ issue.field }}：{{ issue.message }}
        <button
          v-if="gisValidation"
          type="button"
          class="text-link"
          :disabled="locked || !auth.can('planning.execute')"
          @click="emit('locateIssue', issue)"
          >定位问题</button
        >
      </li>
    </ul>
    <p
      v-if="gisValidation && validationNotice"
      role="status"
      >{{ validationNotice }}</p
    >
    <AppDrawer
      @after-show="focusDemandField"
      v-model:visible="drawer"
      :title="'通联需求 · ' + (demand?.id ?? '')"
      subtitle="编辑需求只修改未提交输入；超出有限预设会明确提示暂无结果。"
    >
      <fieldset
        v-if="demand"
        ref="demandRoot"
        tabindex="-1"
        class="demand-fields"
        :disabled="!auth.can('planning.execute') || locked"
      >
        <PlanningRoutingEditor
          :model-value="demand"
          :owner="taskOwner + ':' + demandEpoch"
          :disabled="locked || !auth.can('planning.execute') || !demandCurrent"
          @update:model-value="updateRouting"
        />
        <label
          >端点类型<select
            data-validation-field="endpointMode"
            :value="demand.endpointMode ?? 'station'"
            @change="
              demand.endpointMode = ($event.target as HTMLSelectElement).value as
                | 'station'
                | 'device';
              demand.sourceDeviceId = null;
              demand.targetDeviceId = null;
            "
            ><option value="station">站点间</option
            ><option value="device">指定设备间</option></select
          ></label
        >
        <label
          >起点节点<select
            data-validation-field="sourceId"
            v-model="demand.sourceId"
          >
            <option
              v-for="id in modelValue.stationIds"
              :key="id"
              >{{ id }}</option
            >
          </select></label
        >
        <label
          >终点节点<select
            data-validation-field="targetId"
            v-model="demand.targetId"
          >
            <option
              v-for="id in modelValue.stationIds"
              :key="id"
              >{{ id }}</option
            >
          </select></label
        >
        <template v-if="demand.endpointMode === 'device'">
          <label
            >起点设备<select
              data-validation-field="sourceDeviceId"
              v-model="demand.sourceDeviceId"
            >
              <option :value="null">请选择在架设备</option>
              <option
                v-for="device in endpointDevices(demand.sourceId)"
                :key="device.id"
                :value="device.id"
                >{{ device.id }} · {{ device.modelId }}</option
              >
            </select></label
          >
          <label
            >终点设备<select
              data-validation-field="targetDeviceId"
              v-model="demand.targetDeviceId"
            >
              <option :value="null">请选择在架设备</option>
              <option
                v-for="device in endpointDevices(demand.targetId)"
                :key="device.id"
                :value="device.id"
                >{{ device.id }} · {{ device.modelId }}</option
              >
            </select></label
          >
        </template>
        <label
          >设备类别偏好<select
            data-validation-field="preferredClass"
            v-model="demand.preferredClass"
          >
            <option :value="null">未指定</option
            ><option value="HF">HF</option
            ><option value="VUHF">VUHF</option>
          </select></label
        >
        <label
          >业务类型<select
            data-validation-field="service"
            v-model="demand.service"
          >
            <option value="">未指定</option
            ><option>话音</option>
            <option>数据</option>
            <option>短消息</option>
          </select></label
        >
        <label
          >优先级<select
            data-validation-field="priority"
            v-model="demand.priority"
          >
            <option>P1</option>
            <option>P2</option>
            <option>P3</option>
          </select></label
        >
        <label class="check-label"
          ><input
            data-validation-field="mandatory"
            v-model="demand.mandatory"
            type="checkbox"
          />必要通联</label
        >
        <label
          >数据量 / MB（可空）<input
            data-validation-field="dataVolumeMb"
            v-model="numeric.dataVolumeMb"
            inputmode="decimal"
        /></label>
        <label
          >速率需求 / kbps<input
            data-validation-field="requiredRateKbps"
            v-model="numeric.requiredRateKbps"
            inputmode="decimal"
        /></label>
        <label
          >最大时延 / ms<input
            data-validation-field="maxDelayMs"
            v-model="numeric.maxDelayMs"
            inputmode="decimal"
        /></label>
        <label
          >最低可靠性 / 0–1<input
            data-validation-field="minReliability"
            v-model="numeric.minReliability"
            inputmode="decimal"
        /></label>
      </fieldset>
      <p
        v-if="gisValidation && validationNotice"
        role="status"
        >{{ validationNotice }}</p
      >
      <p
        v-if="drawerError"
        class="issues"
        role="alert"
        >{{ drawerError }}</p
      >
      <p
        v-if="drawer && !demandCurrent"
        class="issues"
        role="alert"
        >任务输入已变化，旧需求未应用；请关闭后重新打开。</p
      >
      <template #footer
        ><div class="toolbar">
          <button
            class="btn"
            @click="drawer = false"
            >取消</button
          ><button
            class="btn primary"
            :disabled="!auth.can('planning.execute') || locked || !demandCurrent"
            :onClick="demandActions.apply"
            >应用到输入</button
          >
        </div></template
      >
    </AppDrawer>
  </section>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, ref, toRaw, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { usePlanningStore } from '../stores/planning';
import { gisTaskTarget, focusGisField, type GisFieldFocus } from '../services/gis-validation';
import AppDrawer from './AppDrawer.vue';
import DeploymentConstraintsEditor from './DeploymentConstraintsEditor.vue';
import PlanningOptionsEditor from './PlanningOptionsEditor.vue';
import PlanningRoutingEditor from './PlanningRoutingEditor.vue';
import { routingIssues, routingSummary, type RoutingInput } from '../services/planning-routing';
import { stationEquipmentLabel, onShelf } from '../mocks/resource-presets';
import type { ResourcesData } from '../types/domain';
import type {
  PlanningDemand,
  PlanningInput,
  PlanningIssue,
  PlanningPreset,
} from '../types/planning';

const props = defineProps<{
  modelValue: PlanningInput;
  resources: ResourcesData;
  presets: PlanningPreset[];
  locked: boolean;
  issues: PlanningIssue[];
  gisValidation?: boolean;
  showSubmit?: boolean;
  submitDisabled?: boolean;
  selectedDemandId?: string;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: PlanningInput];
  preset: [id: string];
  remove: [id: string];
  submit: [];
  pending: [dirty: boolean];
  locateIssue: [issue: PlanningIssue];
}>();
const planning = usePlanningStore();
const drawer = ref(false);
// 无效的部署输入也属于未完成编辑，不能绕过原离开保护。
const deploymentPending = ref(false),
  optionsPending = ref(false);
// 整体保存可应用尚未关闭的通联表单，错误时保持抽屉。
onMounted(() => {
  planning.registerPendingApply(() => {
    saveDemand();
    return !drawer.value && !deploymentPending.value && !optionsPending.value;
  });
  const row = props.modelValue.demands.find((d) => d.id === props.selectedDemandId);
  if (row) edit(row);
});
onBeforeUnmount(() => planning.registerPendingApply(null));
watch(
  () => props.selectedDemandId,
  (id) => {
    const row = props.modelValue.demands.find((d) => d.id === id);
    if (row && !drawer.value) edit(row);
  },
);
const demand = ref<PlanningDemand | null>(null);
const numeric = ref({ dataVolumeMb: '', requiredRateKbps: '', maxDelayMs: '', minReliability: '' });
const original = ref('');
const drawerError = ref('');
// 草稿替换后保留未应用内容供查看，但原抽屉不能覆盖新的任务输入。
const inputEpoch = ref(0),
  demandEpoch = ref(0),
  demandOwner = ref('');
const taskOwner = computed(() => `${planning.taskId}:${auth.generation}:${inputEpoch.value}`);
watch(
  () => props.modelValue,
  () => {
    inputEpoch.value++;
  },
  { deep: true, flush: 'sync' },
);
watch(
  () => planning.taskId,
  () => {
    demandEpoch.value++;
    drawer.value = false;
  },
  { flush: 'sync' },
);
// 失权使旧事件失效，但保留未应用内容，不擅自丢弃草稿。
watch(
  () => auth.generation,
  () => {
    demandEpoch.value++;
  },
  { flush: 'sync' },
);
onBeforeUnmount(() => {
  demandEpoch.value++;
});
const demandCurrent = computed(() => drawer.value && demandOwner.value === taskOwner.value);
const demandActions = computed(() => {
  const generation = demandEpoch.value,
    owner = taskOwner.value,
    row = demand.value;
  return {
    apply: () => {
      if (generation === demandEpoch.value && owner === taskOwner.value && row === demand.value)
        saveDemand();
    },
  };
});
function updateRouting(value: RoutingInput) {
  if (demandCurrent.value && demand.value && !props.locked && auth.can('planning.execute'))
    Object.assign(demand.value, value);
}
const search = ref('');
const taskRoot = ref<HTMLElement | null>(null),
  demandRoot = ref<HTMLElement | null>(null);
const validationFocus = ref<GisFieldFocus | null>(null),
  validationNotice = ref('');
let focusSerial = 0;
watch([() => planning.taskId, () => auth.generation, () => props.gisValidation], () => {
  validationFocus.value = null;
  focusSerial++;
});
watch(
  () => props.modelValue,
  () => {
    validationFocus.value = null;
    focusSerial++;
  },
  { deep: true, flush: 'sync' },
);
onBeforeUnmount(() => {
  validationFocus.value = null;
  focusSerial++;
});
// 错误定位不能用另一条需求重建尚未应用的抽屉输入。
function validationReason(issue: PlanningIssue) {
  if (!props.gisValidation || props.locked || !auth.can('planning.execute'))
    return '当前不可编辑任务输入';
  const target = gisTaskTarget(issue, props.modelValue);
  if (!target) return '任务或通联需求已不存在，无法定位';
  const pending = drawer.value && JSON.stringify([demand.value, numeric.value]) !== original.value;
  return pending && (target.kind !== 'demand' || target.id !== demand.value?.id)
    ? '当前通联需求有未应用输入，请先应用或取消后再定位。'
    : '';
}
async function focusDemandField() {
  const request = validationFocus.value;
  await nextTick();
  if (
    request &&
    request === validationFocus.value &&
    drawer.value &&
    request.id === demand.value?.id &&
    !props.locked &&
    auth.can('planning.execute')
  )
    validationNotice.value = focusGisField(demandRoot.value, request.field)
      ? ''
      : '已定位通联需求，此字段没有可编辑控件。';
}
async function focusValidationIssue(issue: PlanningIssue) {
  validationNotice.value = validationReason(issue);
  if (validationNotice.value) return false;
  const target = gisTaskTarget(issue, props.modelValue)!;
  const request = {
    id: target.kind === 'demand' ? target.id : 'TASK',
    field: target.field,
    serial: ++focusSerial,
  };
  validationFocus.value = request;
  if (target.kind === 'demand') {
    if (!drawer.value || demand.value?.id !== target.id)
      edit(props.modelValue.demands.find((row) => row.id === target.id)!);
    await focusDemandField();
  } else {
    drawer.value = false;
    await nextTick();
    if (
      validationFocus.value?.serial !== request.serial ||
      props.locked ||
      !auth.can('planning.execute')
    )
      return false;
    validationNotice.value = focusGisField(taskRoot.value, target.field)
      ? ''
      : '已定位任务输入，此字段没有可编辑控件。';
  }
  return validationFocus.value?.serial === request.serial;
}
defineExpose({ validationReason, focusValidationIssue });

const selectedPreset = computed(() =>
  props.presets.find((p) => p.id === props.modelValue.presetId),
);
const available = computed(() =>
  props.resources.stations.filter((row) => `${row.id} ${row.name}`.includes(search.value)),
);
const frequencies = computed(() =>
  props.presets
    .filter(
      (p, index, list) =>
        list.findIndex((other) => other.frequency.id === p.frequency.id) === index,
    )
    .map((p) => p.frequency),
);
function update<K extends keyof PlanningInput>(field: K, value: PlanningInput[K]) {
  emit('update:modelValue', { ...structuredClone(toRaw(props.modelValue)), [field]: value });
}
// 共享表单同时服务规划页和 GIS，保留无效数值直到用户完成输入。
function updateOptions(value: Pick<PlanningInput, 'frequencyConstraints' | 'deploymentSolve'>) {
  emit('update:modelValue', { ...structuredClone(toRaw(props.modelValue)), ...value });
}
// 范围和时长的空值保留为无效输入，由统一校验提示，避免被转成 0。
function updateBbox(index: number, text: string) {
  const bbox = [...props.modelValue.bbox];
  bbox[index] = text.trim() === '' ? Number.NaN : Number(text);
  update('bbox', bbox);
}
const endpointDevices = (stationId: string) =>
  props.resources.devices.filter((device) => device.stationId === stationId && onShelf(device));
// 已选不可用节点允许取消，但不允许新选无在架设备的节点。
const nodeUnavailable = (id: string) =>
  !props.resources.devices.some((d) => d.stationId === id && onShelf(d));
function toggleNode(id: string, selected: boolean) {
  if (selected && nodeUnavailable(id)) return;
  update(
    'stationIds',
    selected
      ? [...props.modelValue.stationIds, id]
      : props.modelValue.stationIds.filter((value) => value !== id),
  );
}
function edit(row?: PlanningDemand) {
  demandEpoch.value++;
  demandOwner.value = taskOwner.value;
  demand.value = row
    ? structuredClone(toRaw(row))
    : {
        id: crypto.randomUUID(),
        endpointMode: 'station',
        sourceDeviceId: null,
        targetDeviceId: null,
        preferredClass: null,
        sourceId: props.modelValue.stationIds[0] ?? '',
        targetId: props.modelValue.stationIds[1] ?? '',
        service: '话音',
        priority: 'P1',
        mandatory: true,
        dataVolumeMb: null,
        requiredRateKbps: null,
        maxDelayMs: null,
        minReliability: null,
      };
  for (const key of Object.keys(numeric.value) as (keyof typeof numeric.value)[])
    numeric.value[key] = demand.value[key] === null ? '' : String(demand.value[key]);
  original.value = JSON.stringify([demand.value, numeric.value]);
  drawerError.value = '';
  drawer.value = true;
}
watch(
  [drawer, demand, numeric, deploymentPending, optionsPending],
  () =>
    emit(
      'pending',
      deploymentPending.value ||
        optionsPending.value ||
        (drawer.value && JSON.stringify([demand.value, numeric.value]) !== original.value),
    ),
  { deep: true },
);
function saveDemand() {
  if (!auth.can('planning.execute') || !demand.value || props.locked) return;
  if (!demandCurrent.value) {
    if (drawer.value) drawerError.value = '任务输入已变化，请关闭后重新打开需求。';
    return;
  }
  const row = structuredClone(toRaw(demand.value));
  const routingErrors = routingIssues(row);
  if (routingErrors.length) {
    drawerError.value = routingErrors.map((issue) => issue.message).join('；');
    return;
  }
  // 空字符串明确保留为 null，不能被 Number('') 变成 0。
  for (const key of Object.keys(numeric.value) as (keyof typeof numeric.value)[])
    row[key] = numeric.value[key].trim() === '' ? null : Number(numeric.value[key]);
  if (
    (row.dataVolumeMb !== null && (!Number.isFinite(row.dataVolumeMb) || row.dataVolumeMb < 0)) ||
    [row.requiredRateKbps, row.maxDelayMs].some(
      (v) => v === null || !Number.isFinite(v) || v <= 0,
    ) ||
    row.minReliability === null ||
    !Number.isFinite(row.minReliability) ||
    row.minReliability < 0 ||
    row.minReliability > 1
  ) {
    drawerError.value = '请填写有效数值：速率和时延 >0，可靠性 0–1，数据量可空或 ≥0。';
    return;
  }
  if (
    row.sourceId === row.targetId ||
    !props.modelValue.stationIds.includes(row.sourceId) ||
    !props.modelValue.stationIds.includes(row.targetId)
  ) {
    drawerError.value = '起终点必须是两个不同的参与节点。';
    return;
  }
  if (
    props.modelValue.demands.some(
      (d) =>
        d.id !== row.id &&
        d.sourceId === row.sourceId &&
        d.targetId === row.targetId &&
        d.service === row.service &&
        (d.endpointMode ?? 'station') === (row.endpointMode ?? 'station') &&
        (d.sourceDeviceId ?? null) === (row.sourceDeviceId ?? null) &&
        (d.targetDeviceId ?? null) === (row.targetDeviceId ?? null),
    )
  ) {
    drawerError.value = '同方向、同业务类型的需求已经存在。';
    return;
  }
  if (demand.value.endpointMode === 'device') {
    if (
      !props.resources.devices.some(
        (d) => d.id === row.sourceDeviceId && d.stationId === row.sourceId && onShelf(d),
      ) ||
      !props.resources.devices.some(
        (d) => d.id === row.targetDeviceId && d.stationId === row.targetId && onShelf(d),
      )
    ) {
      drawerError.value = '设备必须在架且属于对应站点';
      return;
    }
  } else {
    row.sourceDeviceId = null;
    row.targetDeviceId = null;
  }
  const rows = structuredClone(toRaw(props.modelValue.demands));
  const index = rows.findIndex((d) => d.id === row.id);
  if (index < 0) rows.push(row);
  else rows[index] = row;
  update('demands', rows);
  drawer.value = false;
  emit('pending', deploymentPending.value || optionsPending.value);
}
</script>
<style scoped>
.bbox-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.task-fields {
  border: 0;
  padding: 20px;
  display: grid;
  gap: 14px;
  min-width: 0;
}
label {
  display: grid;
  gap: 7px;
  color: #9eb8d5;
  font-size: 12px;
}
input:not([type='checkbox']),
select,
textarea {
  width: 100%;
}
.muted,
.readonly-box {
  font-size: 11px;
  line-height: 1.8;
}
.readonly-box {
  padding: 12px;
  background: #101f34;
  border: 1px solid #293e59;
  border-radius: 5px;
}
.nodes {
  max-height: 150px;
  overflow: auto;
  display: grid;
  gap: 8px;
}
.nodes label,
.check-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
input[type='checkbox'] {
  width: auto;
  accent-color: #459ee2;
}
.demand-row {
  padding: 12px;
  border: 1px solid #2d415c;
  border-radius: 5px;
  display: grid;
  gap: 7px;
}
.demand-row strong {
  font-size: 12px;
}
.demand-row small {
  color: #8ea7c2;
}
.submit {
  justify-content: center;
}
.issues {
  color: #f2b28c;
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.demand-fields {
  display: grid;
  gap: 16px;
}
fieldset:disabled {
  opacity: 0.7;
}
</style>
