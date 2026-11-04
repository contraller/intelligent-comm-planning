<template>
  <div class="readable-data">
    <pre>{{ uiStructured(value) }}</pre>
    <details><summary>原始依据</summary><pre>{{ JSON.stringify(value, null, 2) ?? '未提供' }}</pre></details>
  </div>
</template>
<script setup lang="ts">
import { uiStructured } from '../services/ui-copy';
defineProps<{ value: unknown }>();
</script>
<style scoped>
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font: inherit; line-height: 1.7; }
summary { cursor: pointer; color: var(--muted); }
</style>
