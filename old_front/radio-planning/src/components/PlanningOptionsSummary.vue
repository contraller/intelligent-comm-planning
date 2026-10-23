<template>
  <div class="options-summary"
    ><strong>频率与部署求解输入</strong><p v-if="!summary.frequencies">未设置频率筛选条件</p
    ><p
      v-for="row in summary.frequencies"
      :key="row.deviceClass"
      >{{ row.deviceClass }}：{{ row.range }}；排除 {{ row.excludeFreqIds.join(' / ') || '无' }}</p
    ><p>{{ summary.solve }}</p
    ><strong>逐需求路由条件</strong
    ><p
      v-for="row in input?.demands"
      :key="row.id"
      >{{ row.id }} · {{ routingSummary(row) }}</p
    ><p v-if="!input?.demands?.length">未提供通联需求</p></div
  >
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { PlanningInput } from '../types/planning';
import { planningOptionsSummary } from '../services/planning-options';
import { routingSummary } from '../services/planning-routing';
const props = defineProps<{
  input?:
    | (Pick<PlanningInput, 'frequencyConstraints' | 'deploymentSolve'> &
        Partial<Pick<PlanningInput, 'demands'>>)
    | null;
}>();
// 冻结输入独立展示，历史缺字段时不借用当前目录补值。
const summary = computed(() => planningOptionsSummary(props.input ?? {}));
</script>
<style scoped>
.options-summary {
  padding: 12px;
  border: 1px solid var(--line);
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
p {
  margin: 5px 0;
  color: var(--muted);
}
</style>
