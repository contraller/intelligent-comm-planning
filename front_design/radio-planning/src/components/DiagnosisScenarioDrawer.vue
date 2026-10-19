<template>
  <AppDrawer
    :visible="visible"
    title="故障场景配置"
    :subtitle="network.name + ' / ' + network.id"
    @update:visible="!$event && emit('close')"
  >
    <fieldset
      class="scenario-form"
      :disabled="!auth.can('diagnosis.scenario')"
    >
      <label
        >场景名称<input
          v-model="local.name"
          maxlength="80"
      /></label>
      <label
        >备注<textarea
          v-model="local.description"
          maxlength="500"
          rows="2"
        />
      </label>
      <details class="batch"
        ><summary>批量配置已勾选对象（{{ selectedKeys.length }}）</summary>
        <!-- 只替换类型选择外观，批量应用仍走原整体验证。 -->
        <DiagnosisFaultTypePicker
          v-model="batchType"
          label="批量故障类型"
          :disabled="!auth.can('diagnosis.scenario')"
        />
        <label
          v-for="symptom in symptoms"
          :key="symptom.id"
          class="check"
          ><input
            v-model="batchSymptoms"
            type="checkbox"
            :value="symptom.id"
          />{{ symptom.label }}</label
        >
        <button
          class="btn small"
          :disabled="!selectedKeys.length"
          @click="applyBatch"
          >校验并批量应用</button
        >
      </details>
      <fieldset
        v-for="(fault, index) in local.faults"
        :key="index"
      >
        <legend
          ><input
            v-model="selectedKeys"
            type="checkbox"
            :value="key(fault)"
          />
          故障 {{ index + 1 }}</legend
        >
        <label
          >故障对象<select
            :value="key(fault)"
            @change="chooseObject(index, ($event.target as HTMLSelectElement).value)"
            ><option
              v-for="object in objects"
              :key="object.key"
              :value="object.key"
              >{{ object.label }}</option
            ><option
              v-if="!objects.some((o) => o.key === key(fault))"
              :value="key(fault)"
              >{{ key(fault) }} · 不在当前网络</option
            ></select
          ></label
        >
        <DiagnosisFaultTypePicker
          :model-value="fault.faultType"
          :label="'故障 ' + (index + 1) + ' 类型'"
          :disabled="!auth.can('diagnosis.scenario')"
          @update:model-value="
            (value) => {
              fault.faultType = value;
              if (value !== 'EMI') fault.interferenceId = null;
            }
          "
        />
        <details
          ><summary>现象（{{ fault.symptomIds.length }}）</summary
          ><label
            v-for="symptom in symptoms"
            :key="symptom.id"
            class="check"
            ><input
              v-model="fault.symptomIds"
              type="checkbox"
              :value="symptom.id"
            />{{ symptom.label }}</label
          ></details
        >
        <label
          >发生时间（可空，需带时区）<input
            :value="fault.occurTime ?? ''"
            placeholder="2026-10-03T09:00:00+08:00"
            @input="fault.occurTime = ($event.target as HTMLInputElement).value || null"
        /></label>
        <!-- 诊断只引用固定教学预设，不自动吸纳 GIS 新登记资源。 -->
        <p
          v-if="fault.faultType === 'EMI'"
          class="muted"
          >以下为固定诊断预设；新增 GIS 干扰源尚无对应诊断结果。</p
        >
        <label v-if="fault.faultType === 'EMI'"
          >干扰源<select v-model="fault.interferenceId"
            ><option :value="null">未指定</option
            ><option
              v-for="id in interferenceIds"
              :key="id"
              >{{ id }}</option
            ></select
          ></label
        >
        <button
          class="text-link"
          @click="remove(index)"
          >移除此标记</button
        >
      </fieldset>
      <button
        class="btn"
        :disabled="local.faults.length >= 20"
        @click="add"
        >添加故障对象</button
      >
      <p
        v-for="(issue, index) in errors"
        :key="index"
        class="error"
        >{{ issue.row ? '第 ' + issue.row + ' 条 · ' : '' }}{{ issue.field }}：{{
          issue.message
        }}</p
      >
    </fieldset>
    <template #footer
      ><button
        class="btn"
        @click="emit('close')"
        >关闭</button
      ><button
        class="btn primary"
        :disabled="!auth.can('diagnosis.scenario') || validating"
        @click="apply"
        >{{ validating ? '校验中' : '应用到场景草稿' }}</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import DiagnosisFaultTypePicker from './DiagnosisFaultTypePicker.vue';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisDraft, DiagnosisIssue, FaultInput, FaultType } from '../types/diagnosis';
import { previewService } from '../services';
import { useDiagnosisStore } from '../stores/diagnosis';
const props = defineProps<{
  visible: boolean;
  draft: DiagnosisDraft;
  network: PlanVersion;
  symptoms: { id: string; label: string }[];
  interferenceIds: string[];
  selected: { objectType: FaultInput['objectType']; objectId: string }[];
}>();
const emit = defineEmits<{ close: []; apply: [draft: DiagnosisDraft]; dirty: [value: boolean] }>();
const diagnosis = useDiagnosisStore();
const local = ref<DiagnosisDraft>(JSON.parse(JSON.stringify(props.draft)));
const selectedKeys = ref<string[]>([]),
  errors = ref<DiagnosisIssue[]>([]),
  validating = ref(false);
const batchType = ref<FaultType>('HW_FAILURE'),
  batchSymptoms = ref<string[]>([]);
const key = (f: Pick<FaultInput, 'objectType' | 'objectId'>) => `${f.objectType}:${f.objectId}`;
const objects = computed(() => [
  ...props.network.inputSnapshot.stations.map((n) => ({
    key: `NODE:${n.id}`,
    label: `节点 · ${n.name} (${n.id})`,
  })),
  ...props.network.inputSnapshot.devices.map((d) => ({
    key: `DEVICE:${d.id}`,
    label: `设备 · ${d.id} / ${d.stationId}`,
  })),
  ...props.network.links.map((l) => ({
    key: `LINK:${l.id}`,
    label: `链路 · ${l.id} / ${l.a} → ${l.b}`,
  })),
]);
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    local.value = JSON.parse(JSON.stringify(props.draft));
    errors.value = [];
    selectedKeys.value = props.selected.map(key);
    for (const target of props.selected)
      if (!local.value.faults.some((f) => key(f) === key(target)))
        local.value.faults.push({
          ...target,
          faultType: target.objectType === 'LINK' ? 'LINK_DOWN' : 'HW_FAILURE',
          symptomIds: [],
          occurTime: null,
          interferenceId: null,
        });
  },
  { immediate: true },
);
watch(local, () => emit('dirty', JSON.stringify(local.value) !== JSON.stringify(props.draft)), {
  deep: true,
});
function chooseObject(index: number, value: string) {
  const [objectType, objectId] = value.split(':');
  const f = local.value.faults[index];
  f.objectType = objectType as FaultInput['objectType'];
  f.objectId = objectId;
}
function add() {
  const unused = objects.value.find((o) => !local.value.faults.some((f) => key(f) === o.key));
  if (!unused) return;
  const [objectType, objectId] = unused.key.split(':');
  local.value.faults.push({
    objectType: objectType as 'NODE',
    objectId,
    faultType: objectType === 'LINK' ? 'LINK_DOWN' : 'HW_FAILURE',
    symptomIds: [],
    occurTime: null,
    interferenceId: null,
  });
}
async function remove(index: number) {
  if (
    (await diagnosis.ask({
      title: '移除故障标记',
      message: '应用后可通过场景撤销恢复本次修改。',
      saveLabel: '移除标记',
    })) === 'save'
  )
    local.value.faults.splice(index, 1);
}
async function applyBatch() {
  if (!auth.can('diagnosis.scenario')) return;
  const session = auth.generation;
  const candidate: DiagnosisDraft = JSON.parse(JSON.stringify(local.value));
  for (const f of candidate.faults)
    if (selectedKeys.value.includes(key(f))) {
      f.faultType = batchType.value;
      f.symptomIds = [...batchSymptoms.value];
      if (f.faultType !== 'EMI') f.interferenceId = null;
    }
  try {
    errors.value = await previewService.validateDiagnosisScenario(candidate);
    if (!errors.value.length && session === auth.generation && auth.can('diagnosis.scenario'))
      local.value = candidate;
  } catch (e) {
    errors.value = [{ field: 'batch', message: e instanceof Error ? e.message : '校验失败' }];
  }
}
async function apply() {
  if (!auth.can('diagnosis.scenario')) return;
  const session = auth.generation;
  validating.value = true;
  try {
    errors.value = await previewService.validateDiagnosisScenario(local.value);
    if (!errors.value.length && session === auth.generation && auth.can('diagnosis.scenario'))
      emit('apply', JSON.parse(JSON.stringify(local.value)));
  } catch (e) {
    errors.value = [{ field: 'scenario', message: e instanceof Error ? e.message : '校验失败' }];
  } finally {
    validating.value = false;
  }
}
</script>
<style scoped>
.scenario-form {
  display: grid;
  gap: 16px;
}
.scenario-form label {
  display: grid;
  gap: 7px;
  color: #adc0d8;
  font-size: 12px;
}
input,
select,
textarea {
  width: 100%;
  padding: 9px;
  background: #0d1a2d;
  color: #d5e6f7;
  border: 1px solid #34516f;
  border-radius: 4px;
}
input[type='checkbox'] {
  width: auto;
}
.scenario-form .check {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 8px 0;
}
fieldset {
  border: 1px solid #34516f;
  display: grid;
  gap: 12px;
  padding: 12px;
  border-radius: 5px;
}
legend,
summary {
  color: #7fc6eb;
  font-size: 13px;
  cursor: pointer;
}
.batch {
  background: #162c46;
  padding: 12px;
}
.error {
  color: #ffb1b9;
  font-size: 12px;
}
</style>
