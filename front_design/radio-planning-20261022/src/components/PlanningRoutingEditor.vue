<template>
  <fieldset
    class="routing-editor"
    :disabled="disabled"
    aria-label="逐需求路由条件"
  >
    <legend>路由条件</legend>
    <label
      >路由策略<select
        aria-label="路由策略"
        data-validation-field="routeStrategy"
        :value="strategy"
        :onChange="controls.strategy"
      >
        <option value="">未指定</option
        ><option
          v-if="invalidStrategy"
          :value="strategy"
          >无效策略（{{ String(modelValue.routeStrategy) }}）</option
        >
        <option
          v-for="item in routingStrategies"
          :key="item.value"
          :value="item.value"
          >{{ item.label }}</option
        > </select
      ><small
        v-if="inlineIssues"
        role="alert"
        >{{
          routingIssues(modelValue)
            .filter((issue) => issue.field === 'routeStrategy')
            .map((issue) => issue.message)
            .join('；')
        }}</small
      ></label
    >
    <label
      >请求备份路由<select
        aria-label="请求备份路由"
        data-validation-field="needBackup"
        :value="backup"
        :onChange="controls.backup"
      >
        <option value="">未指定</option
        ><option value="true">请求备份</option
        ><option value="false">不请求备份</option>
        <option
          v-if="invalidBackup"
          :value="backup"
          >无效请求（{{ String(modelValue.needBackup) }}）</option
        > </select
      ><small
        v-if="inlineIssues"
        role="alert"
        >{{
          routingIssues(modelValue)
            .filter((issue) => issue.field === 'needBackup')
            .map((issue) => issue.message)
            .join('；')
        }}</small
      ></label
    >
    <p>未指定时不代选默认要求；主备路径及是否可行以规划结果为准。</p>
    <p
      v-for="issue in inlineIssues ? [] : routingIssues(modelValue)"
      :key="issue.field"
      role="alert"
      >{{ issue.message }}</p
    >
  </fieldset>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { routingStrategies, routingIssues, type RoutingInput } from '../services/planning-routing';
// 字段级提示由规划页显式开启，其他调用保留原呈现。
const props = defineProps<{
  modelValue: RoutingInput;
  owner: string;
  disabled?: boolean;
  inlineIssues?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: RoutingInput] }>();
const epoch = ref(0);
let alive = true;
// 替换输入、失权或换对象后，旧 DOM 闭包不得写入新的草稿。
watch(
  [() => props.modelValue, () => props.owner, () => props.disabled],
  () => {
    epoch.value++;
  },
  { deep: true, flush: 'sync' },
);
onBeforeUnmount(() => {
  alive = false;
  epoch.value++;
});
const invalidStrategy = computed(
  () =>
    props.modelValue.routeStrategy != null &&
    !routingStrategies.some((s) => s.value === props.modelValue.routeStrategy),
);
const invalidBackup = computed(
  () => props.modelValue.needBackup != null && typeof props.modelValue.needBackup !== 'boolean',
);
const strategy = computed(() =>
  invalidStrategy.value ? '__invalid__' : (props.modelValue.routeStrategy ?? ''),
);
const backup = computed(() =>
  invalidBackup.value
    ? '__invalid__'
    : props.modelValue.needBackup == null
      ? ''
      : String(props.modelValue.needBackup),
);
const controls = computed(() => {
  const generation = epoch.value,
    owner = props.owner,
    disabled = props.disabled;
  const change = (key: keyof RoutingInput) => (event: Event) => {
    if (!alive || disabled || props.disabled || generation !== epoch.value || owner !== props.owner)
      return;
    const text = (event.target as HTMLSelectElement).value;
    const field = {
      [key]:
        text === ''
          ? null
          : key === 'needBackup'
            ? text === 'true'
              ? true
              : text === 'false'
                ? false
                : text
            : text,
    };
    const value = {
      ...(Object.hasOwn(props.modelValue, 'routeStrategy')
        ? { routeStrategy: props.modelValue.routeStrategy }
        : {}),
      ...(Object.hasOwn(props.modelValue, 'needBackup')
        ? { needBackup: props.modelValue.needBackup }
        : {}),
      ...field,
    };
    // 非法事件不转换为默认值，父级仍可展示原无效输入及错误。
    if (!routingIssues(field as RoutingInput).length)
      emit('update:modelValue', value as RoutingInput);
  };
  return { strategy: change('routeStrategy'), backup: change('needBackup') };
});
</script>
<style scoped>
.routing-editor {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  grid-column: 1/-1;
  border: 1px solid var(--line);
  padding: 12px;
  min-width: 0;
}
.routing-editor label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.routing-editor select {
  width: 100%;
}
.routing-editor p {
  grid-column: 1/-1;
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}
.routing-editor [role='alert'] {
  color: #ffca8d;
}
</style>
