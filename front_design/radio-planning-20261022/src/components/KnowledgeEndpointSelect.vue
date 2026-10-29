<template>
  <select
    :value="modelValue"
    :disabled="disabled"
    @change="!disabled && emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option value="">请选择</option>
    <option v-for="item in options" :key="item.id" :value="item.id">
      {{ item.label || '未命名实体' }} · {{ item.id.startsWith('new:') ? '本单新增' : item.id }}
    </option>
  </select>
</template>
<script setup lang="ts">
// 每个关系端点独立更新，其他字段输入不重绘整套知识实体选项。
defineProps<{ modelValue: string; disabled: boolean; options: { id: string; label: string }[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>
