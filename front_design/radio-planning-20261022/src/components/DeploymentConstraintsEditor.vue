<template>
  <fieldset
    class="deployment-editor"
    :disabled="disabled"
    data-validation-field="deploymentConstraints"
    tabindex="-1"
  >
    <legend>部署筛选条件</legend>
    <label class="check"
      ><input
        type="checkbox"
        :checked="!!modelValue"
        v-on="{ change: checkAction(controls.enable) }"
      />设置部署筛选条件</label
    >
    <p
      v-if="!modelValue"
      class="muted"
      >未设置额外筛选。首次试用可保留未勾选；有选址限制时再启用，不会自动补填旧任务。</p
    >
    <template v-else>
      <p class="muted">用于筛选候选位置和新增部署，已有台站不会被自动搬移。各条件需要同时满足；留空表示不额外指定该项，改动需保存任务后提交规划。</p>
      <label
        v-for="key in scalarKeys"
        :key="key"
        >{{ deploymentLabels[key]
        }}<input
          :data-validation-field="'deploymentConstraints.' + key"
          :aria-invalid="
            inlineIssues && fieldIssues(issues, 'deploymentConstraints.' + key).length > 0
          "
          inputmode="decimal"
          :value="numberText(key, modelValue[key])"
          v-on="{ input: inputAction(controls.scalar, key) }"
        /><small class="muted">{{ scalarHints[key] }}</small
        ><small
          v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.' + key)"
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.' + key) }}</small
        ></label
      >
      <fieldset
        data-validation-field="deploymentConstraints.elevationRangeM"
        tabindex="-1"
        ><legend>海拔范围 / m</legend
        ><p class="muted"
          >限制候选位置的地面海拔，不是天线挂高。单位 m；例如下界 200、上界 1500 表示保留海拔 200–1500 m 的位置。上下界须同时填写且下界≤上界；可填有限数值，无固定上下限，均留空表示未指定。</p
        ><label
          v-for="(label, index) in ['下界', '上界']"
          :key="label"
          >{{ label
          }}<input
            inputmode="decimal"
            :value="numberText('elevation' + index, modelValue.elevationRangeM?.[index])"
            v-on="{ input: inputAction(controls.elevation, index) }" /></label
        ><small
          v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.elevationRangeM')"
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.…11217 tokens truncated… 2 表示请求两份用于比较，不是新增两个台站。单位：份；整数闭区间 [1, 9007199254740991]；不可留空。</small
          ><small
            v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentSolve.solutionCount')"
            class="field-error"
            role="alert"
            >{{ fieldIssueMessage(issues, 'deploymentSolve.solutionCount') }}</small
          ></label
        ><small>实际完整结果数量以服务返回为准，受可行方案和既有搜索预算限制。</small></template
      >
      <small
        v-if="
          inlineIssues &&
          issues
            .filter((issue) => issue.field === 'deploymentSolve')
            .map((issue) => issue.message)
            .join('；')
        "
        class="field-error"
        role="alert"
        >{{
          issues
            .filter((issue) => issue.field === 'deploymentSolve')
            .map((issue) => issue.message)
            .join('；')
        }}</small
      >
    </fieldset>
    <p
      v-if="inlineIssues && issues.some((issue) => issue.field === 'frequencyConstraints')"
      class="field-error"
      role="alert"
      >{{
        issues
          .filter((issue) => issue.field === 'frequencyConstraints')
          .map((issue) => issue.message)
          .join('；')
      }}</p
    >
    <ul
      v-if="issues.length && !inlineIssues"
      role="alert"
      class="notice warn"
      ><li
        v-for="(issue, index) in issues"
        :key="index"
        >{{ issue.message }}</li
      ></ul
    >
  </fieldset>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import type { PlanningInput } from '../types/planning';
import type { PlanningFrequencyResource } from '../types/planning-options';
import { planningOptionIssues } from '../services/planning-options';
import { fieldIssueMessage } from '../services/planning-issue-display';
type Options = Pick<PlanningInput, 'frequencyConstraints' | 'deploymentSolve'>;
const props = defineProps<{
  modelValue: Options;
  frequencyResources?: PlanningFrequencyResource[] | null;
  owner: string;
  disabled?: boolean;
  inlineIssues?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: Options]; pending: [value: boolean] }>();
const raw = ref<Record<string, string>>({}),
  search = ref(''),
  epoch = ref(0);
let alive = true,
  lastInput = '';
const serial = (value: Options) =>
  JSON.stringify([value.frequencyConstraints, value.deploymentSolve], (_key, item) =>
    typeof item === 'number' && !Number.isFinite(item) ? '无效数值' : item,
  );
watch(
  () => props.owner,
  () => {
    epoch.value++;
    raw.value = {};
    search.value = '';
  },
  { flush: 'sync' },
);
watch(
  () => props.disabled,
  () => {
    epoch.value++;
  },
  { flush: 'sync' },
);
watch(
  () => serial(props.modelValue),
  (value) => {
    if (value !== lastInput) raw.value = {};
  },
  { flush: 'sync' },
);
const issues = computed(() => planningOptionIssues(props.modelValue));
watch(issues, (value) => emit('pending', !!value.length), { immediate: true });
onBeforeUnmount(() => {
  alive = false;
  epoch.value++;
  emit('pending', false);
});
const filter = (kind: 'HF' | 'VUHF') =>
  props.modelValue.frequencyConstraints?.filters.find((row) => row.deviceClass === kind);
const numberText = (key: string, value: number | null | undefined) =>
  raw.value[key] ?? (value == null || !Number.isFinite(value) ? '' : String(value));
const pool = computed(
  () =>
    props.frequencyResources?.filter((row) =>
      `${row.freqId} ${row.centerFreqKhz} ${row.deviceClass}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    ) ?? [],
);
const unknown = computed(
  () =>
    props.modelValue.frequencyConstraints?.filters.flatMap((row) =>
      row.excludeFreqIds
        .filter((id) => !props.frequencyResources?.some((f) => f.freqId === id))
        .map((id) => `${row.deviceClass} / ${id}`),
    ) ?? [],
);
// 每个事件捕获所属任务及权限代次，旧控件不能改写后来打开的草稿。
const controls = computed(() => {
  const owner = props.owner,
    generation = epoch.value,
    disabled = props.disabled;
  const valid = () =>
    alive && !disabled && !props.disabled && owner === props.owner && generation === epoch.value;
  const change = (fn: (value: Options) => void) => {
    if (!valid()) return;
    const value: Options = {};
    for (const key of ['frequencyConstraints', 'deploymentSolve'] as const)
      if (Object.hasOwn(props.modelValue, key))
        Object.assign(value, { [key]: structuredClone(toRaw(props.modelValue[key])) });
    fn(value);
    lastInput = serial(value);
    emit('update:modelValue', value);
  };
  const numeric = (key: string, text: string) => {
    raw.value[key] = text;
    return text.trim() === '' ? NaN : Number(text);
  };
  return {
    // 未填写范围时保持空值，允许仅排除频点；半填或非法输入仍由 range 和校验器拦截。
    enable: (kind: 'HF' | 'VUHF', enabled: boolean) =>
      change((value) => {
        const rows = value.frequencyConstraints?.filters ?? [];
        value.frequencyConstraints = enabled
          ? { filters: [...rows, { deviceClass: kind, rangeKhz: null, excludeFreqIds: [] }] }
          : rows.length === 1
            ? null
            : { filters: rows.filter((row) => row.deviceClass !== kind) };
      }),
    range: (kind: 'HF' | 'VUHF', index: number, text: string) => {
      if (!valid()) return;
      change((value) => {
        const row = value.frequencyConstraints?.filters.find((item) => item.deviceClass === kind);
        if (!row) return;
        const pair = row.rangeKhz ? [...row.rangeKhz] : [NaN, NaN];
        pair[index] = numeric(kind + index, text);
        row.rangeKhz =
          text.trim() === '' &&
          !Number.isFinite(pair[1 - index]) &&
          !(raw.value[kind + (1 - index)] ?? '').trim()
            ? null
            : (pair as [number, number]);
      });
    },
    excludes: (kind: 'HF' | 'VUHF', text: string) =>
      change((value) => {
        const row = value.frequencyConstraints?.filters.find((item) => item.deviceClass === kind);
        if (row) row.excludeFreqIds = text.trim() ? text.split(';').map((item) => item.trim()) : [];
      }),
    exclude: (kind: 'HF' | 'VUHF', id: string, enabled: boolean) =>
      change((value) => {
        value.frequencyConstraints ??= { filters: [] };
        let row = value.frequencyConstraints.filters.find((item) => item.deviceClass === kind);
        if (!row) {
          row = { deviceClass: kind, rangeKhz: null, excludeFreqIds: [] };
          value.frequencyConstraints.filters.push(row);
        }
        row.excludeFreqIds = enabled
          ? [...new Set([...row.excludeFreqIds, id])]
          : row.excludeFreqIds.filter((item) => item !== id);
      }),
    solve: (enabled: boolean) =>
      change((value) => {
        value.deploymentSolve = enabled
          ? { mode: 'MIN_COUNT', fixedCount: null, solutionCount: 1 }
          : null;
      }),
    mode: (mode: string) =>
      change((value) => {
        if (value.deploymentSolve) {
          value.deploymentSolve.mode = mode as 'MIN_COUNT' | 'FIXED_COUNT';
          value.deploymentSolve.fixedCount = mode === 'MIN_COUNT' ? null : NaN;
          delete raw.value.fixedCount;
        }
      }),
    count: (key: 'fixedCount' | 'solutionCount', text: string) => {
      if (valid())
        change((value) => {
          if (value.deploymentSolve) value.deploymentSolve[key] = numeric(key, text);
        });
    },
  };
});
const inputAction =
  <T extends unknown[]>(action: (...args: [...T, string]) => void, ...args: T) =>
  (event: Event) =>
    action(...args, (event.target as HTMLInputElement).value);
const checkAction =
  <T extends unknown[]>(action: (...args: [...T, boolean]) => void, ...args: T) =>
  (event: Event) =>
    action(...args, (event.target as HTMLInputElement).checked);
</script>
<style scoped>
.options-editor,
fieldset {
  display: grid;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--line);
  padding: 12px;
}
.options-editor {
  margin-top: 12px;
  grid-template-columns: minmax(0, 1fr);
}
label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.check input {
  width: auto;
}
input,
select {
  min-width: 0;
  width: 100%;
}
.range {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.pool {
  max-height: 240px;
  overflow: auto;
  display: grid;
  gap: 10px;
  margin-top: 10px;
}
small {
  display: block;
  color: var(--muted);
  line-height: 1.7;
}
.muted,
.notice {
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
/* 规划字段级反馈沿用统一警示色，不影响其他调用的默认呈现。 */
.field-error {
  display: block;
  color: #ffca8d;
  font-size: 12px;
  grid-column: 1 / -1;
}
[aria-invalid='true'] {
  border-color: #ffca8d;
}
</style>
