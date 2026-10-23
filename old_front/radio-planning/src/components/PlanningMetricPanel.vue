<template>
  <aside
    class="plan-metrics"
    aria-label="规划三项目标"
  >
    <article
      v-for="item in cards"
      :key="item.id"
      class="metric"
      :class="item.state"
      :data-metric="item.id"
    >
      <div class="metric-title"
        ><span>{{ item.label }}</span
        ><i
          class="pi"
          :class="item.icon"
      /></div>
      <strong
        >{{ item.value ?? '未提供' }}<em v-if="item.value !== null">{{ item.unit }}</em></strong
      >
      <span class="metric-status">{{ item.status }}</span>
      <small>{{ item.note }}</small>
    </article>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { planningMetricCards } from '../services/planning-result-display';
import type { PlanningResultSnapshot } from '../services/planning-result-display';
import type { PlanningCheck } from '../types/planning';

const props = defineProps<{
  metrics: PlanningResultSnapshot['metrics'];
  checks: PlanningCheck[];
}>();
// 状态与数值独立读取，旧快照缺结论时保持中性展示。
const cards = computed(() => planningMetricCards(props.metrics, props.checks));
</script>

<style scoped>
.plan-metrics {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.metric {
  --metric-status: #9aafc9;
  padding: 16px 20px;
  background: linear-gradient(120deg, #122540, #101b2e);
  border: 1px solid #29425e;
  border-left: 3px solid var(--metric-status);
  border-radius: 6px;
  flex: 1;
  overflow-wrap: anywhere;
}
.metric.passed {
  --metric-status: #8ed66b;
}
.metric.failed {
  --metric-status: #ef5f64;
}
.metric-title {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #9ab1cb;
}
.metric .pi {
  color: #539dce;
  font-size: 15px;
}
.metric strong {
  display: block;
  font:
    500 31px 'Bahnschrift',
    sans-serif;
  letter-spacing: 1px;
  margin: 8px 0;
}
.metric em {
  font-style: normal;
  font-size: 13px;
  color: #7199b9;
  margin-left: 8px;
}
.metric-status {
  display: block;
  color: var(--metric-status);
  font-size: 12px;
}
.metric small {
  display: block;
  margin-top: 5px;
  font-size: 10px;
  line-height: 1.7;
  color: #9ab1cb;
}
</style>
