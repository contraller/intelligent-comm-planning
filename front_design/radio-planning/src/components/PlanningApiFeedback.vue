<template>
  <div
    v-if="display || pending"
    class="notice warn planning-feedback"
    role="alert"
    :data-feedback-operation="feedback?.operation"
  >
    <template v-if="display"
      ><strong>{{ display.operationLabel }}失败</strong><p>{{ display.message }}</p>
      <p v-if="feedback?.operation === 'job'">查询中断，当前显示上次成功结果。</p>
      <p
        v-if="display.code !== undefined || display.requestId !== undefined"
        class="metadata"
        ><span v-if="display.code !== undefined">业务码：{{ display.code }}</span
        ><span v-if="display.requestId !== undefined">请求 ID：{{ display.requestId }}</span></p
      >
      <p v-if="display.reason !== null">不可行原因：{{ display.reason }}</p>
      <div v-if="display.suggestions.length"
        ><strong>建议</strong
        ><ul
          ><li
            v-for="(suggestion, index) in display.suggestions"
            :key="index"
            >{{ suggestion }}</li
          ></ul
        ></div
      >
      <div v-if="display.quantities.length"
        ><strong>频率缺口</strong
        ><p
          v-for="quantity in display.quantities"
          :key="quantity.label"
          >{{ quantity.label }}：{{ quantity.value }}</p
        ></div
      >
      <div v-if="display.issues.length"
        ><strong>字段问题</strong
        ><p
          v-for="(issue, index) in display.issues"
          :key="index"
          >{{ issue.objectId }} / {{ issue.field }}：{{ issue.message }}</p
        ></div
      >
      <div v-if="display.errorDetail !== null"
        ><strong>错误详情</strong><pre>{{ display.errorDetail }}</pre>
      </div>
      <details v-if="display.rawDetails !== null"
        ><summary>查看原始接口详情</summary><pre>{{ display.rawDetails }}</pre>
      </details>
    </template>
    <button
      v-if="pending"
      class="btn small"
      @click="$emit('reconcile')"
      >核实原请求</button
    >
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import {
  planningFeedbackDisplay,
  type PlanningApiFeedbackState,
} from '../services/planning-api-feedback';
const props = defineProps<{ feedback: PlanningApiFeedbackState | null; pending?: boolean }>();
defineEmits<{ reconcile: [] }>();
// 摘要和详情始终读取同一条反馈，服务文本交给 Vue 转义。
const display = computed(() => (props.feedback ? planningFeedbackDisplay(props.feedback) : null));
</script>
<style scoped>
.planning-feedback {
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.planning-feedback p {
  margin: 8px 0;
}
.metadata {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
ul {
  padding-left: 20px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  max-height: 220px;
  overflow: auto;
}
details {
  margin: 12px 0;
}
</style>
