<template>
  <section
    class="solutions-panel"
    aria-label="完整规划结果"
    ><h3>完整规划结果 · {{ solutions.length }} 份</h3
    ><p class="muted"
      >期望
      {{ requested ?? '未指定' }}
      份，实际以本次返回为准。选择结果后，地图、指标和保存对象同步切换。</p
    ><p v-if="!solutions.length">本次尚无完整规划结果可供选择。</p>
    <div class="solutions"
      ><article
        v-for="row in solutions"
        :key="row.solutionId"
        :class="{ selected: row.solutionId === selected }"
        ><button
          class="text-link"
          :disabled="disabled"
          v-on="{ click: choose.bind(null, row.solutionId) }"
          >{{ row.label }}</button
        ><small>{{ row.solutionId }}</small
        ><p
          >新增部署单元 {{ row.radioCount ?? '未提供' }} ·
          {{ row.savedPlanId ? '已保存' : row.expired ? '未保存 · 已过期' : '未保存' }}</p
        ><p>{{ row.outcome.message }} · {{ row.outcome.code }} · {{ conclusion(row) }}</p
        ><p v-if="row.result"
          >部署成本 {{ row.result.deploymentCost ?? '未提供' }} {{ row.result.costUnit }}</p
        ><p v-if="row.result"
          >连通率 {{ row.result.metrics.connectivityPercent ?? '未知' }}% · 抗毁性
          {{ row.result.metrics.survivabilityPercent ?? '未知' }}% · 总功率
          {{ row.result.metrics.totalRadiatedPowerW ?? '未知' }} W</p
        ><p v-else>结果快照不可用</p></article
      ></div
    >
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
interface Solution {
  solutionId: string;
  label: string;
  radioCount: number | null;
  savedPlanId: string | null;
  expired: boolean;
  outcome: { code: number; message: string };
  result: {
    snapshotId: string;
    deploymentCost: number | null;
    costUnit: string;
    checks: { id: string; passed: boolean | null }[];
    metrics: {
      connectivityPercent: number | null;
      survivabilityPercent: number | null;
      totalRadiatedPowerW: number | null;
    };
  } | null;
}
const props = defineProps<{
  solutions: Solution[];
  selected: string;
  requested?: number | null;
  owner: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ select: [id: string] }>();
// 只汇总服务显式校验标记，不根据三指标反推业务达标。
const conclusion = (row: Solution) =>
  !row.result
    ? '快照不可用'
    : row.result.checks.some((c) => c.passed === false) || row.outcome.code !== 0
      ? '参考结果 · 未全部达标'
      : ['connectivity', 'survivability', 'relay', 'frequency'].every((id) =>
            row.result!.checks.some((c) => c.id === id && c.passed === true),
          )
        ? '服务校验通过'
        : '校验结论未完整提供';
let alive = true;
const epoch = ref(0);
watch(
  () => [props.owner, props.disabled],
  () => epoch.value++,
  { flush: 'sync' },
);
onBeforeUnmount(() => {
  alive = false;
  epoch.value++;
});
// 选择事件只接受当次完整结果清单中的身份，旧作业的按钮不继续生效。
const choose = computed(() => {
  const owner = props.owner,
    token = epoch.value,
    disabled = props.disabled,
    ids = props.solutions.map((row) => row.solutionId);
  return (id: string) => {
    if (
      alive &&
      !disabled &&
      !props.disabled &&
      owner === props.owner &&
      token === epoch.value &&
      ids.includes(id) &&
      props.solutions.some((row) => row.solutionId === id)
    )
      emit('select', id);
  };
});
</script>
<style scoped>
.solutions-panel {
  padding: 16px;
  border: 1px solid var(--line);
  font-size: 12px;
  margin: 12px 0;
}
.solutions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}
.solutions article {
  border: 1px solid var(--line);
  padding: 12px;
}
.solutions .selected {
  border-color: #62bce6;
  background: #152d40;
}
small {
  display: block;
  overflow-wrap: anywhere;
  color: var(--muted);
  margin-top: 6px;
}
p {
  line-height: 1.7;
}
</style>
