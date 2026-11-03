<template>
  <fieldset
    class="fault-picker"
    :disabled="disabled"
    :aria-label="label"
  >
    <legend>{{ label }}</legend>
    <label
      v-for="item in diagnosisFaultTypes"
      :key="item.type"
      :style="{ '--fault-color': item.color }"
      :class="{ active: modelValue === item.type }"
    >
      <input
        type="radio"
        :name="name"
        :value="item.type"
        :checked="modelValue === item.type"
        :disabled="disabled"
        :aria-label="label + '：' + item.label"
        @change="select(item.type)"
      />
      <span
        class="fault-glyph"
        aria-hidden="true"
        >{{ item.glyph }}</span
      ><span>{{ item.label }}</span>
    </label>
    <small>场景注入类型，不改变设备运行状态。</small>
  </fieldset>
</template>
<script setup lang="ts">
import { useId } from 'vue';
import type { FaultType } from '../types/diagnosis';
import { diagnosisFaultTypes } from '../services/diagnosis-display';
const props = withDefaults(
  defineProps<{ modelValue: FaultType; label?: string; disabled?: boolean }>(),
  { label: '故障类型', disabled: false },
);
const emit = defineEmits<{ 'update:modelValue': [value: FaultType] }>();
const name = useId();
// 使用独立 radio 组保留键盘选择；单条和批量共用标识，不绕过原表单校验。
function select(value: FaultType) {
  if (!props.disabled) emit('update:modelValue', value);
}
</script>
<style scoped>
.fault-picker {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 10px;
  border: 1px solid #34516f;
  border-radius: 5px;
  min-width: 0;
}
.fault-picker legend {
  font-size: 12px;
  color: #adc0d8;
}
.fault-picker label {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 7px;
  border: 1px solid #30465e;
  border-radius: 4px;
  color: #bbd0e4;
  background: #112137;
  font-size: 12px;
  cursor: pointer;
}
.fault-picker label.active {
  border-color: var(--fault-color);
  background: #1b2e48;
}
.fault-picker label:focus-within {
  outline: 2px solid #d3e9fa;
  outline-offset: 1px;
}
.fault-picker input {
  width: auto;
  margin: 0;
  accent-color: var(--fault-color);
}
.fault-glyph {
  color: var(--fault-color);
  font-size: 18px;
}
.fault-picker small {
  grid-column: 1 / -1;
  color: #8ca5bf;
  font-size: 11px;
  line-height: 1.6;
}
.fault-picker:disabled label {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
