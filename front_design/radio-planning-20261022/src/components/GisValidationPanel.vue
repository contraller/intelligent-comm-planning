<template>
  <section
    v-if="message || issues.length"
    class="validation-panel"
    aria-label="GIS 上次校验结果"
  >
    <p
      v-if="message"
      role="alert"
      >{{ message }}</p
    >
    <template v-if="issues.length"
      ><strong>上次校验结果</strong><small>修改后请重新应用或保存；定位不代表问题已修复。</small>
      <ul
        ><li
          v-for="(issue, index) in issues"
          :key="index"
        >
          <span
            >{{ issue.source === 'resource' ? '资源' : '任务' }} ·
            {{ issue.objectId || '未知对象' }} / {{ issue.field || '未知字段' }}：{{
              issue.message
            }}</span
          >
          <button
            class="text-link"
            :disabled="disabled || !!reason(issue)"
            @click="!disabled && !reason(issue) && $emit('locate', issue)"
            >定位问题</button
          >
          <small v-if="reason(issue)">{{ reason(issue) }}</small>
        </li></ul
      >
    </template>
    <p
      v-if="notice"
      role="status"
      >{{ notice }}</p
    >
  </section>
</template>
<script setup lang="ts">
import type { GisValidationIssue } from '../services/gis-validation';
// 定位能力由当前 GIS 上下文提供，清单不直接操作表单或地图。
defineProps<{
  issues: GisValidationIssue[];
  message: string;
  notice: string;
  disabled: boolean;
  reason: (issue: GisValidationIssue) => string;
}>();
defineEmits<{ locate: [issue: GisValidationIssue] }>();
</script>
<style scoped>
.validation-panel {
  padding: 10px 16px;
  background: #351f2b;
  color: #ffb4b4;
  font-size: 12px;
  max-height: 180px;
  overflow: auto;
}
.validation-panel p {
  margin: 4px 0;
}
.validation-panel small {
  display: block;
  color: #d4bcc8;
  margin-top: 4px;
}
.validation-panel ul {
  margin: 8px 0;
  padding-left: 18px;
}
.validation-panel li {
  margin: 7px 0;
  overflow-wrap: anywhere;
}
.validation-panel button {
  margin-left: 10px;
}
</style>
