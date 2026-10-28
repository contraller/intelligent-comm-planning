<template>
  <fieldset
    class="options-editor"
    data-validation-field="frequencyConstraints"
    tabindex="-1"
    :disabled="disabled"
    ><legend>频率范围与部署数量</legend>
    <p class="muted"
      >条件随任务保存，由服务进行分配和求解；未启用表示未设置，留空规则见各项提示。新增部署单元由位置与设备类型组成，数量不等于设备实例数量。</p
    >
    <p class="muted">HF 为短波，VUHF 为超短波。所有频率均以 kHz 填写：7 MHz 应填 7000，50 MHz 应填 50000。筛选只会缩小当前资源池，不会生成新的可用频点。</p>
    <fieldset
      v-for="kind in ['HF', 'VUHF'] as const"
      :key="kind"
      :data-validation-field="'frequencyConstraints.' + kind"
      tabindex="-1"
      ><legend>{{ kind }} 频率条件</legend>
      <label class="check"
        ><input
          type="checkbox"
          :checked="!!filter(kind)"
          v-on="{ change: checkAction(controls.enable, kind) }"
        />设置 {{ kind }} 条件</label
      >
      <small>只在需要限制该频段时启用；每类最多一组条件，启用后须填写完整频率范围或至少一个排除频点。未启用的频段不会因此被禁用。</small>
      <template v-if="filter(kind)"
        ><div
          class="range"
          :data-validation-field="'frequencyConstraints.' + kind + '.rangeKhz'"
          tabindex="-1"
          ><label
            v-for="(label, index) in ['最低频率 / kHz', '最高频率 / kHz']"
            :key="label"
            >{{ label
            }}<input
              inputmode="decimal"
              :value="numberText(kind + index, filter(kind)?.rangeKhz?.[index])"
              v-on="{ input: inputAction(controls.range, kind, index) }"
            /><small>单位 kHz；有限正数（&gt; 0，不含 0），可填小数，未设固定上限。</small></label
          ><small
            v-if="
              inlineIssues &&
              fieldIssueMessage(issues, 'frequencyConstraints.' + kind + '.rangeKhz')
            "
            class="field-error"
            role="alert"
            >{{ fieldIssueMessage(issues, 'frequencyConstraints.' + kind + '.rangeKhz') }}</small
          ></div
        >
        <small
          >按中心频率筛选闭区间 [最低频率, 最高频率]（含两端），最低频率须 ≤ 最高频率。上下界须同时填写或同时留空；同时留空表示不按范围筛选，此时须填写排除频点。仅筛选当前资源池，不新增频点。</small
        >
        <label
          >排除频点 ID（分号分隔）<input
            :data-validation-field="'frequencyConstraints.' + kind + '.excludeFreqIds'"
            :value="filter(kind)?.excludeFreqIds.join(';') ?? ''"
            v-on="{ input: inputAction(controls.excludes, kind) }"
          /><small
            >留空表示不额外排除；每个 ID 为 1–120 个字符，以英文分号 ; 分隔。ID 不可重复、含空白或控制字符，分隔项不可为空；求解时须为对应类别的现有频点。</small
          ><small
            v-if="
              inlineIssues &&
              fieldIssueMessage(issues, 'frequencyConstraints.' + kind + '.excludeFreqIds')
            "
            class="field-error"
            role="alert"
            >{{
              fieldIssueMessage(issues, 'frequencyConstraints.' + kind + '.excludeFreqIds')
            }}</small
          ></label
        ></template
      >
      <small
        v-if="
          inlineIssues &&
          issues
            .filter((issue) => issue.field === 'frequencyConstraints.' + kind)
            .map((issue) => issue.message)
            .join('；')
        "
        class="field-error"
        role="alert"
        >{{
          issues
            .filter((issue) => issue.field === 'frequencyConstraints.' + kind)
            .map((issue) => issue.message)
            .join('；')
        }}</small
      >
    </fieldset>
    <details
      ><summary>查看频点资源与选择排除项</summary
      ><label
        >搜索频点<input
          v-model="search"
          placeholder="频点 ID、类别或中心频率"
      /><small
        >按频点 ID、HF/VUHF 类别或中心频率（kHz）文本匹配；留空显示全部频点。</small
      ></label>
      <small
        >勾选表示排除该频点；取消勾选仅撤销额外排除，不改变资源可用性。复用间距（m）与邻道间隔（kHz）由资源提供，此处仅展示。</small
      >
      <p
        v-if="frequencyResources == null"
        class="muted"
        >服务尚未提供逐频点资源；已填排除 ID 原样保留。</p
      ><p v-else-if="!pool.length">没有匹配的频点。</p>
      <div class="pool"
        ><label
          v-for="row in pool"
          :key="row.freqId"
          class="check"
          ><input
            type="checkbox"
            :checked="filter(row.deviceClass)?.excludeFreqIds.includes(row.freqId) ?? false"
            v-on="{ change: checkAction(controls.exclude, row.deviceClass, row.freqId) }"
          /><span
            >{{ row.freqId }} · {{ row.deviceClass }} · {{ row.centerFreqKhz ?? '未知' }} kHz<small
              >带宽 {{ row.bandwidthKhz ?? '未知' }} kHz ·
              {{ row.isAvailable === null ? '可用性未知' : row.isAvailable ? '可用' : '不可用' }} ·
              {{ row.occupiedBy ?? '未提供占用方' }} · {{ row.note ?? '' }}</small
            ><small
              >信道 {{ row.channelNo ?? '未提供' }} · 复用间距
              {{ row.reuseMinDistanceM ?? '未提供' }} m · 邻道间隔
              {{ row.adjacentGuardKhz ?? '未提供' }} kHz</small
            ></span
          ></label
        ></div
      >
    </details>
    <p
      v-if="unknown.length"
      class="notice warn"
      >以下排除项未在当前资源列表中找到，仍保留并提交：{{ unknown.join('；') }}</p
    >
    <fieldset
      data-validation-field="deploymentSolve"
      tabindex="-1"
      ><legend>部署求解条件</legend
      ><label class="check"
        ><input
          type="checkbox"
          :checked="!!modelValue.deploymentSolve"
          v-on="{ change: checkAction(controls.solve) }"
        />设置部署数量与备选数量</label
      >
      <small>未勾选表示不设置本组求解条件；启用后期望备选数量不可留空。</small>
      <template v-if="modelValue.deploymentSolve"
        ><label
          >求解模式<select
            data-validation-field="deploymentSolve.mode"
            :value="modelValue.deploymentSolve.mode"
            v-on="{ change: inputAction(controls.mode) }"
            ><option value="MIN_COUNT">尽量少新增部署</option
            ><option value="FIXED_COUNT">指定新增部署数量</option></select
          ><small
            >“尽量少新增部署”：由系统搜索可行的新增数量，不表示已证明全局最少；“指定新增部署数量”：按你给定的数量计算位置，允许为 0，资源或条件不满足时可无解。</small
          ></label
        >
        <label v-if="modelValue.deploymentSolve.mode === 'FIXED_COUNT'"
          >新增部署单元数（允许 0）<input
            data-validation-field="deploymentSolve.fixedCount"
            inputmode="numeric"
            :value="numberText('fixedCount', modelValue.deploymentSolve.fixedCount)"
            v-on="{ input: inputAction(controls.count, 'fixedCount') }"
          /><small
            >填写本次新增的部署单元数，不是全网已有台站总数；例如 3 表示新增 3 个部署单元。单位：个；须为非负整数，上限为本次筛选后可用的不同物理位置数；超额时服务说明实际可用数量，不进入部署求解。0 表示不新增，本模式不可留空。</small
          ><small
            v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentSolve.fixedCount')"
            class="field-error"
            role="alert"
            >{{ fieldIssueMessage(issues, 'deploymentSolve.fixedCount') }}</small
          ></label
        >
        <label
          >期望备选数量<input
            data-validation-field="deploymentSolve.solutionCount"
            inputmode="numeric"
            :value="numberText('solutionCount', modelValue.deploymentSolve.solutionCount)"
            v-on="{ input: inputAction(controls.count, 'solutionCount') }"
          /><small
            >希望生成多少份部署备选，例如 2 表示请求两份用于比较，不是新增两个台站。单位：份；整数范围 1–{{ MAX_PLANNING_SOLUTIONS }}，不可留空。上限来自当前搜索的完整校验预算，不保证一定找到请求数量。</small
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
import { MAX_PLANNING_SOLUTIONS, planningOptionIssues } from '../services/planning-options';
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
